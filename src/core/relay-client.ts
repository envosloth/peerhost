import type { TLSSocket } from 'node:tls';
import { connectPeer, readFrame, writeFrame, type PeerIdentity } from './peer-transport.js';
import type { TransferPeer } from './transfers.js';
import { decodeInvite, type CreatedInvite } from './invites.js';
import { friendName } from './relay-friends-store.js';

/** Relay connections start with one of these frames; `park` and `claim` then run the ordinary transfer protocol. */
export const RELAY_PROTOCOL_VERSION = 1;
export type RelayOperation = 'status' | 'park' | 'claim' | 'join' | 'invite' | 'friends' | 'gateway-status' | 'game-tunnel' | 'public-status' | 'public-enable' | 'public-disable' | 'remove-friend' | 'invite-for';
export const relayRequest = (op: RelayOperation) => ({ type: 'relay', version: RELAY_PROTOCOL_VERSION, op });

export interface RelayCustody {
  /** Fingerprint of the current authority: the relay itself while parked, otherwise the PC that claimed it. */
  owner: string;
  state: 'owned' | 'offered' | 'transferred';
  generation: number;
  snapshotId: string;
  /** Set while a claim is waiting for that PC's acknowledgment. Only that PC can complete (retry) it. */
  pendingTarget: string | null;
}
export interface RelayStatus extends RelayCustody { ownerName: string | null; pendingName: string | null }
export type RelayFriendsCustody = 'unknown' | 'parked' | 'pending' | 'held';
export interface RelayFriends {
  canManage: boolean;
  owner: string | null;
  members: { name: string; fingerprint: string; you: boolean }[];
  /** Relay ledger knowledge, not a claim about servers it has never seen. */
  custody: RelayFriendsCustody;
  /** A device name only when custody is held; otherwise null. */
  holder: string | null;
}
type RelayPeer = TransferPeer & { name?: string };

async function friendRequest(identity: PeerIdentity, relay: RelayPeer, request: unknown): Promise<Record<string, unknown>> {
  const socket = await connectPeer(identity, relay.fingerprint, relay.host, relay.port);
  try {
    await writeFrame(socket, request);
    const frame: unknown = await readFrame(socket, 262144);
    if (!frame || typeof frame !== 'object' || Array.isArray(frame)) throw new Error('Invalid relay reply');
    const reply = frame as Record<string, unknown>;
    if (reply.type === 'error') throw new Error(`Relay refused: ${String(reply.message).slice(0, 512)}`);
    return reply;
  } finally { socket.destroy(); }
}

/** Redeem only against the code's pinned relay. Caller persists its local peer/config only after success. */
export async function joinRelayInvite(identity: PeerIdentity, code: string, name: string): Promise<{ relayName: string }> {
  const invite = decodeInvite(code);
  const memberName = friendName(name);
  if (invite.relayFingerprint === identity.fingerprint) throw new Error('Cannot join your own relay identity');
  let reply: Record<string, unknown>;
  try {
    reply = await friendRequest(identity, { fingerprint: invite.relayFingerprint, host: invite.host, port: invite.port },
      { ...relayRequest('join'), token: invite.token.toString('hex'), name: memberName });
  } catch (error) {
    if (/disconnected before client acceptance/.test((error as Error).message)) throw new Error('Invite may be expired or already used; relay disconnected before accepting it');
    throw error;
  }
  if (reply.type !== 'relay-joined' || typeof reply.relayName !== 'string') throw new Error('Invalid relay join reply');
  return { relayName: friendName(reply.relayName, 100) };
}

/** Member-generated invites default to 24 hours and the relay's configured advertised endpoint. */
export async function relayInvite(identity: PeerIdentity, relay: RelayPeer): Promise<CreatedInvite> {
  return parseInvitation(await friendRequest(identity, relay, relayRequest('invite')), relay);
}

export async function relayInviteFor(identity: PeerIdentity, relay: RelayPeer, fingerprint: string): Promise<CreatedInvite> {
  if (!hex(fingerprint)) throw new Error('Invalid friend');
  return parseInvitation(await friendRequest(identity, relay, { ...relayRequest('invite-for'), fingerprint }), relay);
}

function parseInvitation(reply: Record<string, unknown>, relay: RelayPeer): CreatedInvite {
  if (reply.type !== 'relay-invite' || typeof reply.code !== 'string' || !Number.isSafeInteger(reply.expiresAt)) throw new Error('Invalid relay invite reply');
  const invite = decodeInvite(reply.code);
  if (invite.relayFingerprint !== relay.fingerprint || invite.expiresAt * 1000 !== reply.expiresAt) throw new Error('Invalid relay invite pin or expiry');
  return { code: reply.code, expiresAt: reply.expiresAt as number };
}

export async function relayFriends(identity: PeerIdentity, relay: RelayPeer): Promise<RelayFriends> {
  const reply = await friendRequest(identity, relay, relayRequest('friends'));
  if (reply.type !== 'relay-friends' || !Array.isArray(reply.members) || reply.members.length > 200 ||
      !['unknown', 'parked', 'pending', 'held'].includes(reply.custody as string) ||
      (reply.custody === 'held' ? typeof reply.holder !== 'string' : reply.holder !== null)) throw new Error('Invalid relay friends reply');
  const members = reply.members.map((value: unknown) => {
    const member = value as Record<string, unknown>;
    if (!member || !hex(member.fingerprint) || typeof member.you !== 'boolean' || member.you !== (member.fingerprint === identity.fingerprint)) throw new Error('Invalid relay member');
    return { name: friendName(member.name, 100), fingerprint: member.fingerprint, you: member.you };
  });
  if (new Set(members.map((member) => member.fingerprint)).size !== members.length || !members.some((member) => member.you)) throw new Error('Invalid relay membership');
  if (reply.canManage !== undefined && typeof reply.canManage !== 'boolean') throw new Error('Invalid group permissions');
  const owner = reply.owner ?? null;
  if (owner !== null && (!hex(owner) || !members.some(m => m.fingerprint === owner))) throw new Error('Invalid group owner');
  if (reply.canManage === true && owner !== identity.fingerprint) throw new Error('Invalid group permissions');
  return { members, canManage: reply.canManage === true, owner: owner as string | null, custody: reply.custody as RelayFriendsCustody, holder: reply.holder === null ? null : friendName(reply.holder, 100) };
}

export async function relayRemoveFriend(identity: PeerIdentity, relay: RelayPeer, fingerprint: string): Promise<void> {
  if (!hex(fingerprint)) throw new Error('Invalid friend');
  const reply = await friendRequest(identity, relay, { ...relayRequest('remove-friend'), fingerprint });
  if (reply.type !== 'relay-removed' || reply.fingerprint !== fingerprint) throw new Error('Invalid removal reply');
  if ((await relayFriends(identity, relay)).members.some(m => m.fingerprint === fingerprint)) throw new Error('Member removal could not be verified');
}

const hex = (value: unknown): value is string => typeof value === 'string' && /^[a-f0-9]{64}$/.test(value);
const name = (value: unknown): string | null => typeof value === 'string' ? value.slice(0, 100) : null;

function parseStatus(frame: unknown): RelayStatus | null {
  if (!frame || typeof frame !== 'object') throw new Error('Invalid relay status reply');
  const reply = frame as Record<string, unknown>;
  if (reply.type === 'error') throw new Error(`Relay refused: ${String(reply.message).slice(0, 512)}`);
  if (reply.type !== 'relay-status') throw new Error('Invalid relay status reply');
  if (reply.custody === null) return null;
  const custody = reply.custody as Record<string, unknown>;
  if (!custody || !hex(custody.owner) || !hex(custody.snapshotId) || !['owned', 'offered', 'transferred'].includes(custody.state as string) ||
      !Number.isSafeInteger(custody.generation) || (custody.pendingTarget !== null && !hex(custody.pendingTarget))) {
    throw new Error('Invalid relay status reply');
  }
  return { owner: custody.owner, state: custody.state as RelayCustody['state'], generation: custody.generation as number,
    snapshotId: custody.snapshotId, pendingTarget: custody.pendingTarget as string | null,
    ownerName: name(reply.ownerName), pendingName: name(reply.pendingName) };
}

/** Ask the relay what it holds. Read-only; also serves as the reachability check before any offer is prepared. */
export async function relayStatus(identity: PeerIdentity, relay: RelayPeer): Promise<RelayStatus | null> {
  const socket = await connectPeer(identity, relay.fingerprint, relay.host, relay.port);
  try {
    await writeFrame(socket, relayRequest('status'));
    return parseStatus(await readFrame(socket));
  } finally { socket.destroy(); }
}

/** Open a pinned relay connection that has already selected an operation. */
export async function openRelayOperation(identity: PeerIdentity, relay: TransferPeer, op: 'park' | 'claim'): Promise<TLSSocket> {
  const socket = await connectPeer(identity, relay.fingerprint, relay.host, relay.port);
  try { await writeFrame(socket, relayRequest(op)); return socket; }
  catch (error) { socket.destroy(); throw error; }
}

export interface RelayPublicStatus { state: string; address: string | null; detail: string; approveUrl: string | null }
const PUBLIC_STATES = new Set(['off', 'unsupported', 'downloading', 'approve', 'starting', 'creating', 'pending', 'reserved', 'reachable', 'error']);
/** The always-on PC's public address, controlled from a member PC. Reply fields are validated, never trusted. */
export async function relayPublic(identity: PeerIdentity, relay: RelayPeer, op: 'public-status' | 'public-enable' | 'public-disable'): Promise<RelayPublicStatus> {
  const reply = await friendRequest(identity, relay, relayRequest(op));
  if (reply.type !== 'relay-public' || !PUBLIC_STATES.has(reply.state as string) || typeof reply.detail !== 'string') throw new Error('Invalid public address reply');
  const address = typeof reply.address === 'string' && /^[a-z0-9][a-z0-9-]{0,62}\.(?:tun\.ply\.gg|joinmc\.link)$/.test(reply.address) ? reply.address : null;
  const approveUrl = typeof reply.approveUrl === 'string' && /^https:\/\/playit\.gg\/claim\/[a-f0-9]{10}$/.test(reply.approveUrl) ? reply.approveUrl : null;
  return { state: reply.state as string, address, detail: reply.detail.slice(0, 300), approveUrl };
}

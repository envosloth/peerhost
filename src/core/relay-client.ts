import type { TLSSocket } from 'node:tls';
import { connectPeer, readFrame, writeFrame, type PeerIdentity } from './peer-transport.js';
import type { TransferPeer } from './transfers.js';

/** Relay connections start with one of these frames; `park` and `claim` then run the ordinary transfer protocol. */
export const RELAY_PROTOCOL_VERSION = 1;
export type RelayOperation = 'status' | 'park' | 'claim';
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
export async function relayStatus(identity: PeerIdentity, relay: TransferPeer): Promise<RelayStatus | null> {
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

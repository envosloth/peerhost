import { createHash, timingSafeEqual } from 'node:crypto';
import { isValidEndpointHost } from './endpoints.js';

export interface Invite {
  relayFingerprint: string;
  host: string;
  port: number;
  token: Buffer;
  /** Unix seconds in the pasteable code; relay records and API replies use milliseconds. */
  expiresAt: number;
  relayName: string;
}
export interface CreatedInvite { code: string; expiresAt: number }
const PREFIX = 'SEEDHOST-';
const CHECKSUM_BYTES = 6;
const HEADER_BYTES = 57;

function validate(invite: Invite): void {
  if (!/^[a-f0-9]{64}$/.test(invite.relayFingerprint)) throw new Error('Invalid relay fingerprint');
  if (!isValidEndpointHost(invite.host) || invite.host === '0.0.0.0') throw new Error('Invite needs a reachable relay address');
  if (!Number.isInteger(invite.port) || invite.port < 1 || invite.port > 65535) throw new Error('Invalid invite port');
  if (!Buffer.isBuffer(invite.token) || invite.token.length !== 16) throw new Error('Invalid invite token');
  if (!Number.isInteger(invite.expiresAt) || invite.expiresAt < 0 || invite.expiresAt > 0xffffffff) throw new Error('Invalid invite expiry');
  if (typeof invite.relayName !== 'string' || !invite.relayName.trim() || Buffer.byteLength(invite.relayName) > 100 || /\p{Cc}/u.test(invite.relayName)) throw new Error('Invalid relay name');
}
const checksum = (data: Buffer): Buffer => createHash('sha256').update(data).digest().subarray(0, CHECKSUM_BYTES);

/** Compact versioned binary envelope. Checksum detects copy damage, not authenticity: TLS pins authenticate. */
export function encodeInvite(invite: Invite): string {
  validate(invite);
  const host = Buffer.from(invite.host), name = Buffer.from(invite.relayName);
  const body = Buffer.alloc(HEADER_BYTES + host.length + name.length);
  body[0] = 1;
  Buffer.from(invite.relayFingerprint, 'hex').copy(body, 1);
  invite.token.copy(body, 33);
  body.writeUInt32BE(invite.expiresAt, 49);
  body.writeUInt16BE(invite.port, 53);
  body[55] = host.length; body[56] = name.length;
  host.copy(body, HEADER_BYTES); name.copy(body, HEADER_BYTES + host.length);
  return PREFIX + Buffer.concat([body, checksum(body)]).toString('base64url');
}

export function decodeInvite(code: string): Invite {
  if (typeof code !== 'string' || !code.trim().startsWith(PREFIX)) throw new Error('Not a SeedHost invite');
  const payload = code.trim().slice(PREFIX.length);
  const damaged = () => new Error('SeedHost invite is damaged or incomplete');
  if (!/^[A-Za-z0-9_-]+$/.test(payload) || payload.length > 600) throw damaged();
  const data = Buffer.from(payload, 'base64url');
  if (data.toString('base64url') !== payload || data.length < HEADER_BYTES + CHECKSUM_BYTES) throw damaged();
  const body = data.subarray(0, -CHECKSUM_BYTES);
  if (!timingSafeEqual(checksum(body), data.subarray(-CHECKSUM_BYTES)) || body[0] !== 1 || body.length !== HEADER_BYTES + body[55]! + body[56]!) throw damaged();
  let invite: Invite;
  try {
    const utf8 = new TextDecoder('utf-8', { fatal: true });
    invite = { relayFingerprint: body.subarray(1, 33).toString('hex'), token: Buffer.from(body.subarray(33, 49)),
      expiresAt: body.readUInt32BE(49), port: body.readUInt16BE(53),
      host: utf8.decode(body.subarray(HEADER_BYTES, HEADER_BYTES + body[55]!)),
      relayName: utf8.decode(body.subarray(HEADER_BYTES + body[55]!)) };
    validate(invite);
  } catch { throw damaged(); }
  if (invite.expiresAt <= Math.floor(Date.now() / 1000)) throw new Error('SeedHost invite has expired');
  return invite;
}

/** Local parsing only: does not authenticate/reach the relay or redeem the invitation. Never exposes its token. */
export function previewInvite(code: string): { relayName: string; host: string; port: number; relayFingerprint: string; expiresAt: number } {
  const invite = decodeInvite(code);
  return { relayName: invite.relayName, host: invite.host, port: invite.port,
    relayFingerprint: invite.relayFingerprint, expiresAt: invite.expiresAt * 1000 };
}

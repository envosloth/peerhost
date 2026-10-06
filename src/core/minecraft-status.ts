import net from 'node:net';

export interface MinecraftStatusSampleEntry {
  name: string;
  id?: string;
}

export interface MinecraftStatusResult {
  online: number | null;
  max: number | null;
  sample: MinecraftStatusSampleEntry[];
  error: string | null;
}

// Bounds chosen to be generous for a real status reply (typically < 64 KiB) while
// guaranteeing hostile or broken loopback peers cannot exhaust memory.
const MAX_RESPONSE_BYTES = 1 << 20; // 1 MiB of raw socket bytes
const MAX_FRAME_BYTES = 1 << 19; // 512 KiB declared in the frame length VarInt
const MAX_SAMPLE_ENTRIES = 100;
const MAX_NAME_LENGTH = 64;
const MAX_COUNT = 100_000;
const DEFAULT_TIMEOUT_MS = 1_500;
const MAX_TIMEOUT_MS = 5_000;
const HANDSHAKE_PROTOCOL = 770;

/**
 * Server List Ping against a Minecraft server on 127.0.0.1 only: no host parameter,
 * no DNS, no remote sockets. Always releases its socket and never throws.
 */
export function queryLocalMinecraft(port: number, timeoutMs = DEFAULT_TIMEOUT_MS): Promise<MinecraftStatusResult> {
  if (!Number.isSafeInteger(port) || port < 1 || port > 65_535) {
    return Promise.resolve({ online: null, max: null, sample: [], error: 'Invalid Minecraft server port' });
  }
  const budget = Number.isFinite(timeoutMs) ? Math.min(Math.max(Math.floor(timeoutMs), 100), MAX_TIMEOUT_MS) : DEFAULT_TIMEOUT_MS;
  return run(port, budget);
}

function run(port: number, timeoutMs: number): Promise<MinecraftStatusResult> {
  return new Promise(resolve => {
    const socket = net.connect({ host: '127.0.0.1', port });
    let receivedBytes = 0;
    let settled = false;
    const chunks: Buffer[] = [];
    const finish = (result: MinecraftStatusResult, destroy: boolean): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      socket.removeAllListeners();
      if (destroy) socket.destroy();
      resolve(result);
    };
    const timer = setTimeout(() => finish(unavailable(), true), timeoutMs);
    socket.on('connect', () => {
      socket.end(Buffer.concat([
        frame(Buffer.concat([varInt(0), varInt(HANDSHAKE_PROTOCOL), string('127.0.0.1'), portBytes(port), varInt(1)])),
        frame(varInt(0)),
      ]));
    });
    socket.on('data', (chunk: Buffer) => {
      receivedBytes += chunk.length;
      if (receivedBytes > MAX_RESPONSE_BYTES) { finish(unavailable(), true); return; }
      chunks.push(chunk);
      // Fail as soon as the declared frame length proves the peer will overrun its budget.
      const declared = declaredFrameLength(Buffer.concat(chunks));
      if (declared !== null && declared > MAX_FRAME_BYTES) finish(unavailable(), true);
    });
    socket.on('close', () => finish(parseReply(Buffer.concat(chunks)), false));
    socket.on('error', error => {
      // Refused loopback means the server is stopped; other socket errors are reported as unavailable.
      finish((error as NodeJS.ErrnoException).code === 'ECONNREFUSED' ? stopped() : unavailable(), false);
    });
  });
}

function parseReply(buffer: Buffer): MinecraftStatusResult {
  try {
    const payload = completeFrame(buffer);
    const cursor = { at: 0 };
    if (readVarInt(payload, cursor) !== 0) throw new Error('Unexpected packet id');
    const parsed = JSON.parse(readString(payload, cursor)) as { players?: unknown };
    const players = parsed.players as { online?: unknown; max?: unknown; sample?: unknown } | undefined;
    if (!players || typeof players !== 'object') throw new Error('Missing players');
    const online = count(players.online);
    const max = count(players.max);
    return { online, max, sample: sampleEntries(players.sample), error: null };
  } catch {
    return unavailable();
  }
}

function count(value: unknown): number {
  if (!Number.isSafeInteger(value) || (value as number) < 0 || (value as number) > MAX_COUNT) throw new Error('Invalid player count');
  return value as number;
}

function sampleEntries(value: unknown): MinecraftStatusSampleEntry[] {
  if (value === undefined) return [];
  if (!Array.isArray(value)) throw new Error('Invalid player sample');
  return value.slice(0, MAX_SAMPLE_ENTRIES).map(entry => {
    if (!entry || typeof entry !== 'object') throw new Error('Invalid player sample entry');
    const { name, id } = entry as { name?: unknown; id?: unknown };
    if (typeof name !== 'string' || name.length < 1 || name.length > MAX_NAME_LENGTH) throw new Error('Invalid player name');
    return { name, ...(typeof id === 'string' && id.length <= 64 ? { id } : {}) };
  });
}

function unavailable(): MinecraftStatusResult {
  return { online: null, max: null, sample: [], error: 'Minecraft server status unavailable' };
}

function stopped(): MinecraftStatusResult {
  return { online: 0, max: null, sample: [], error: null };
}

function varInt(value: number): Buffer {
  const bytes: number[] = [];
  let remaining = value >>> 0;
  for (;;) {
    if (remaining <= 0x7f) { bytes.push(remaining); return Buffer.from(bytes); }
    bytes.push((remaining & 0x7f) | 0x80);
    remaining >>>= 7;
  }
}

function string(value: string): Buffer {
  const encoded = Buffer.from(value, 'utf8');
  return Buffer.concat([varInt(encoded.length), encoded]);
}

function portBytes(port: number): Buffer {
  return Buffer.from([(port >> 8) & 0xff, port & 0xff]);
}

function frame(payload: Buffer): Buffer {
  return Buffer.concat([varInt(payload.length), payload]);
}

function readVarInt(buffer: Buffer, cursor: { at: number }): number {
  let value = 0, shift = 0;
  for (let index = 0; index < 5; index++) {
    const byte = buffer[cursor.at++];
    if (byte === undefined) throw new Error('Truncated VarInt');
    value |= (byte & 0x7f) << shift;
    if ((byte & 0x80) === 0) return value;
    shift += 7;
  }
  throw new Error('VarInt too long');
}

function readString(buffer: Buffer, cursor: { at: number }): string {
  const length = readVarInt(buffer, cursor);
  if (length < 0 || cursor.at + length > buffer.length) throw new Error('Truncated string');
  const value = buffer.subarray(cursor.at, cursor.at + length).toString('utf8');
  cursor.at += length;
  return value;
}

/** Returns the declared frame length when the VarInt prefix is complete, else null. */
function declaredFrameLength(buffer: Buffer): number | null {
  try { return readVarInt(buffer, { at: 0 }); } catch { return null; }
}

/** Requires exactly one complete frame and returns its payload. */
function completeFrame(buffer: Buffer): Buffer {
  const cursor = { at: 0 };
  const length = readVarInt(buffer, cursor);
  if (length < 0 || length > MAX_FRAME_BYTES) throw new Error('Frame exceeds budget');
  if (cursor.at + length !== buffer.length) throw new Error('Incomplete or trailing frame bytes');
  return buffer.subarray(cursor.at);
}

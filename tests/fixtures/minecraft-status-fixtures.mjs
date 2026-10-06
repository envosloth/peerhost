import net from 'node:net';

// Hand-written VarInt writers/readers independent of the module under test, so a shared bug
// cannot let malformed frames pass the parser.
export function varInt(value) {
  const bytes = [];
  let remaining = value >>> 0;
  for (let index = 0; index < 5; index++) {
    if (remaining <= 0x7f) { bytes.push(remaining); return Buffer.from(bytes); }
    bytes.push((remaining & 0x7f) | 0x80);
    remaining >>>= 7;
  }
  throw new Error('VarInt too large for fixture');
}

export function packet(payload) {
  const length = varInt(payload.length);
  return Buffer.concat([length, payload]);
}

export function string(value) {
  const bytes = Buffer.from(value, 'utf8');
  return Buffer.concat([varInt(bytes.length), bytes]);
}

export function statusResponse(json) {
  const body = Buffer.concat([varInt(0), string(json)]);
  return packet(body);
}

/** Frames a raw payload with a VarInt length prefix. */
export function frameOf(payload) {
  return Buffer.concat([varInt(payload.length), payload]);
}

/** Wraps an already-framed reply with a different packet id in its payload. */
export function withPacketId(framed, packetId) {
  const { frames, complete } = decodeFrames(framed);
  if (!complete || frames.length !== 1) throw new Error('fixture frame expected');
  const payload = frames[0].subarray(1); // drop the original id byte
  return frameOf(Buffer.concat([Buffer.from([packetId]), payload]));
}

export function decodeFrames(buffer) {
  const frames = [];
  let offset = 0;
  while (offset < buffer.length) {
    let value = 0, shift = 0, length;
    do {
      const byte = buffer[offset++];
      if (byte === undefined) return { frames, complete: false };
      value |= (byte & 0x7f) << shift;
      shift += 7;
      length = value;
    } while (buffer[offset - 1] & 0x80);
    if (buffer.length < offset + length) return { frames, complete: false };
    frames.push(buffer.subarray(offset, offset + length));
    offset += length;
  }
  return { frames, complete: true };
}

/** Reads the server-bound packet stream: one handshake frame followed by one request frame. */
export function readHandshake(buffer) {
  const { frames, complete } = decodeFrames(buffer);
  if (!complete || frames.length < 2) return null;
  const handshake = frames[0];
  const cursor = { at: 0 };
  const packetId = readVarInt(handshake, cursor);
  const protocol = readVarInt(handshake, cursor);
  const host = readString(handshake, cursor);
  const port = (handshake[cursor.at] << 8) | handshake[cursor.at + 1];
  cursor.at += 2;
  const nextState = readVarInt(handshake, cursor);
  const requested = {
    packetId, protocol, host, port, nextState,
    trailing: handshake.length - cursor.at,
    requestId: readVarInt(frames[1], { at: 0 }),
    requestTrailing: frames[1].length - 1,
  };
  return requested;
}

export function readVarInt(buffer, cursor) {
  let value = 0, shift = 0;
  for (let index = 0; index < 5; index++) {
    const byte = buffer[cursor.at++];
    value |= (byte & 0x7f) << shift;
    if ((byte & 0x80) === 0) return value;
    shift += 7;
  }
  throw new Error('VarInt too long');
}

export function readString(buffer, cursor) {
  const length = readVarInt(buffer, cursor);
  const text = buffer.subarray(cursor.at, cursor.at + length).toString('utf8');
  cursor.at += length;
  return text;
}

/** Starts a loopback TCP fixture. The handler receives the socket and records raw bytes. */
export async function serverFixture(t, handler, options = {}) {
  const received = [];
  const sockets = new Set();
  // allowHalfOpen keeps a fixture writable after the client's handshake half-close,
  // which Node's default (false) would otherwise answer with an immediate FIN.
  const server = net.createServer({ allowHalfOpen: options.allowHalfOpen ?? false }, socket => {
    sockets.add(socket);
    const chunks = [];
    socket.on('data', chunk => { chunks.push(chunk); received.push(chunk); handler(socket, Buffer.concat(chunks)); });
    socket.on('close', () => sockets.delete(socket));
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(async () => {
    for (const socket of sockets) socket.destroy();
    await new Promise(resolve => server.close(resolve));
  });
  return {
    port: server.address().port,
    received,
    server,
    connectedBuffer: () => Buffer.concat(received),
    openSockets: () => sockets.size,
    destroyAll: () => { for (const socket of sockets) socket.destroy(); },
  };
}

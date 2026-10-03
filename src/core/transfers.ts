import { createHash } from 'node:crypto';
import { constants } from 'node:fs';
import { link, lstat, mkdir, mkdtemp, open, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import type { TLSSocket } from 'node:tls';
import { connectPeer, readFrame, writeFrame, type PeerIdentity } from './peer-transport.js';
import { readSnapshot, type SnapshotManifest } from './snapshots.js';
import type { TransferOffer } from './ownership.js';
export type { TransferOffer } from './ownership.js';

export interface TransferPeer { fingerprint: string; host: string; port: number }
const CHUNK_BYTES = 65536;
const MAX_METADATA_BYTES = 1048576;
const MAX_ANCESTRY = 128;
const MAX_FILE_ENTRIES = 4096;
const MAX_OBJECT_BYTES = 16 * 1024 ** 3;
const MAX_TOTAL_BYTES = 128 * 1024 ** 3;
const FINAL_ACK_TIMEOUT_MS = 120000;

function hex(value: unknown): asserts value is string {
  if (typeof value !== 'string' || !/^[a-f0-9]{64}$/.test(value)) throw new Error('Invalid lowercase SHA256 id/hash/fingerprint');
}
function fields(value: unknown, keys: string[]): asserts value is Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value) ||
      Object.keys(value).sort().join(',') !== [...keys].sort().join(',')) throw new Error('Invalid transfer fields');
}
function validateOffer(value: unknown, snapshotId: string): TransferOffer | undefined {
  if (value === null) return undefined;
  fields(value, ['id', 'source', 'target', 'generation', 'snapshotId']);
  for (const key of ['id', 'source', 'target']) {
    const item = value[key];
    if (typeof item !== 'string' || !item.length || item.length > 128 || /[\u0000-\u001f\u007f]/u.test(item)) throw new Error('Invalid ownership offer identifier');
  }
  hex(value.snapshotId);
  if (value.snapshotId !== snapshotId || typeof value.generation !== 'number' || !Number.isSafeInteger(value.generation) || value.generation < 1) {
    throw new Error('Invalid ownership offer revision/generation');
  }
  return { id: value.id as string, source: value.source as string, target: value.target as string,
    generation: value.generation, snapshotId: value.snapshotId };
}
async function frame(socket: TLSSocket, timeoutMs?: number): Promise<Record<string, unknown>> {
  const value: unknown = await readFrame(socket, undefined, timeoutMs);
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Invalid transfer frame');
  const message = value as Record<string, unknown>;
  if (message.type === 'error') throw new Error(`Peer transfer rejected: ${String(message.message).slice(0, 512)}`);
  return message;
}
async function safeStore(store: string): Promise<void> {
  // Reuse the snapshot module's root/link/reparse checks, including nonexistent roots.
  try {
    await lstat(path.join(store, 'snapshots', `${'0'.repeat(64)}.json`));
    throw new Error('Reserved safety-probe manifest exists; refusing store');
  } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
  try { await readSnapshot(store, '0'.repeat(64)); }
  catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
}
async function readBoundedSnapshot(store: string, id: string): Promise<SnapshotManifest> {
  hex(id);
  const stat = await lstat(path.join(store, 'snapshots', `${id}.json`));
  if (!stat.isFile() || stat.isSymbolicLink()) throw new Error('Unsafe manifest file/link');
  if (stat.size > MAX_METADATA_BYTES) throw new Error('Snapshot metadata one-MiB byte limit exceeded');
  return readSnapshot(store, id);
}
function metadataLimit(value: unknown): void {
  if (Buffer.byteLength(JSON.stringify(value), 'utf8') > MAX_METADATA_BYTES) throw new Error('Snapshot metadata one-MiB byte limit exceeded');
}
async function safeOpen(filename: string) {
  const before = await lstat(filename);
  if (before.isSymbolicLink() || !before.isFile()) throw new Error('Unsafe object link or file type');
  const handle = await open(filename, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
  const actual = await handle.stat();
  if (!actual.isFile() || actual.ino !== before.ino || actual.dev !== before.dev) {
    await handle.close();
    throw new Error('Object changed while opening');
  }
  return handle;
}
async function verifyFile(filename: string, expected: { hash: string; size: number }): Promise<void> {
  const handle = await safeOpen(filename);
  try {
    const hash = createHash('sha256');
    let size = 0;
    for await (const chunk of handle.createReadStream({ highWaterMark: CHUNK_BYTES, autoClose: false })) {
      size += chunk.length;
      if (size > expected.size) throw new Error('Object integrity length mismatch');
      hash.update(chunk);
    }
    if (size !== expected.size || hash.digest('hex') !== expected.hash) throw new Error('Object integrity hash/length mismatch');
  } finally { await handle.close(); }
}
async function publishObject(temporary: string, target: string, expected: { hash: string; size: number }) {
  await verifyFile(temporary, expected);
  try { await link(temporary, target); }
  catch (error) { if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error; }
  await verifyFile(target, expected);
}
function objectsOf(manifests: SnapshotManifest[]) {
  const objects = new Map<string, { hash: string; size: number }>();
  let entries = 0, total = 0;
  for (const manifest of manifests) for (const file of manifest.files) {
    if (++entries > MAX_FILE_ENTRIES) throw new Error('Manifest file count limit exceeded');
    if (file.size > MAX_OBJECT_BYTES) throw new Error('Object byte limit exceeded');
    const prior = objects.get(file.hash);
    if (prior && prior.size !== file.size) throw new Error('Conflicting object lengths');
    if (!prior) {
      total += file.size;
      if (total > MAX_TOTAL_BYTES) throw new Error('Total object byte limit exceeded');
    }
    objects.set(file.hash, { hash: file.hash, size: file.size });
  }
  return objects;
}

export async function sendSnapshotToPeer(identity: PeerIdentity, peer: TransferPeer, storeDir: string,
  snapshotId: string, offer?: TransferOffer): Promise<{ snapshot: SnapshotManifest; filesSent: number; bytesSent: number; ownershipAccepted: boolean }> {
  hex(snapshotId);
  await safeStore(storeDir);
  const snapshot = await readBoundedSnapshot(storeDir, snapshotId);
  offer = validateOffer(offer ?? null, snapshotId);
  const manifests = [snapshot];
  const hello = { type: 'snapshot', version: 1, snapshotId, manifests, offer: offer ?? null };
  metadataLimit(hello);
  while (manifests[manifests.length - 1]!.parentId !== null) {
    if (manifests.length >= MAX_ANCESTRY) throw new Error('Snapshot ancestry limit exceeded');
    const parentId = manifests[manifests.length - 1]!.parentId!;
    if (manifests.some((manifest) => manifest.id === parentId)) throw new Error('Cyclic snapshot ancestry');
    manifests.push(await readBoundedSnapshot(storeDir, parentId));
    metadataLimit(hello);
  }
  const objects = objectsOf(manifests);
  const socket = await connectPeer(identity, peer.fingerprint, peer.host, peer.port);
  try {
    await writeFrame(socket, hello);
    const request = await frame(socket);
    fields(request, ['type', 'hashes']);
    if (request.type !== 'need' || !Array.isArray(request.hashes)) throw new Error('Invalid missing-object request');
    const requested = new Set<string>();
    if (request.hashes.length > objects.size) throw new Error('Missing-object request count exceeds advertised objects');
    for (const hash of request.hashes) {
      hex(hash);
      if (!objects.has(hash) || requested.has(hash)) throw new Error('Unadvertised or duplicate requested object');
      requested.add(hash);
    }
    let filesSent = 0, bytesSent = 0;
    for (const hash of requested) {
      const object = objects.get(hash)!;
      const handle = await safeOpen(path.join(storeDir, 'objects', hash));
      try {
        await writeFrame(socket, { type: 'object', hash, size: object.size });
        const digest = createHash('sha256');
        let size = 0;
        for await (const chunk of handle.createReadStream({ highWaterMark: CHUNK_BYTES, autoClose: false })) {
          size += chunk.length;
          if (size > object.size) throw new Error('Source object integrity length mismatch');
          digest.update(chunk);
          await writeFrame(socket, { type: 'chunk', data: chunk.toString('base64') });
        }
        if (size !== object.size || digest.digest('hex') !== hash) throw new Error('Source object integrity hash/length mismatch');
        await writeFrame(socket, { type: 'object-end', hash });
        filesSent++;
        bytesSent += size;
      } finally { await handle.close(); }
    }
    await writeFrame(socket, { type: 'complete', snapshotId, filesSent, bytesSent });
    const ack = await frame(socket, FINAL_ACK_TIMEOUT_MS);
    fields(ack, ['type', 'snapshotId', 'filesSent', 'bytesSent', 'ownershipAccepted']);
    if (ack.type !== 'ack' || ack.snapshotId !== snapshotId || ack.filesSent !== filesSent || ack.bytesSent !== bytesSent ||
        typeof ack.ownershipAccepted !== 'boolean') throw new Error('Snapshot acknowledgment id/counters mismatch');
    if (ack.ownershipAccepted && !offer) throw new Error('Ownership acknowledgment without a transfer offer');
    return { snapshot, filesSent, bytesSent, ownershipAccepted: ack.ownershipAccepted };
  } finally { socket.destroy(); }
}

export async function receiveSnapshot(socket: TLSSocket, authenticatedFingerprint: string, storeDir: string,
  onSnapshot?: (snapshot: SnapshotManifest, source: string, offer?: TransferOffer) => Promise<boolean | void>): Promise<void> {
  let staging: string | undefined;
  try {
    hex(authenticatedFingerprint);
    const raw = socket.getPeerCertificate().raw;
    if (!raw || createHash('sha256').update(raw).digest('hex') !== authenticatedFingerprint) throw new Error('Authenticated source fingerprint mismatch');
    const hello = await frame(socket); // Transport gate refuses unpinned TLS before any filesystem writes.
    fields(hello, ['type', 'version', 'snapshotId', 'manifests', 'offer']);
    hex(hello.snapshotId);
    if (hello.type !== 'snapshot' || hello.version !== 1 || !Array.isArray(hello.manifests) || !hello.manifests.length) {
      throw new Error('Invalid snapshot transfer metadata');
    }
    if (hello.manifests.length > MAX_ANCESTRY) throw new Error('Snapshot ancestry limit exceeded');
    const offer = validateOffer(hello.offer, hello.snapshotId);
    await safeStore(storeDir);
    await mkdir(storeDir, { recursive: true });
    staging = await mkdtemp(path.join(storeDir, '.transfer-'));
    const manifestStore = path.join(staging, 'metadata');
    await mkdir(path.join(manifestStore, 'snapshots'), { recursive: true });
    await mkdir(path.join(staging, 'objects'));
    const manifests: SnapshotManifest[] = [];
    let expectedId: string | null = hello.snapshotId;
    for (const value of hello.manifests) {
      if (expectedId === null) throw new Error('Unrelated snapshot ancestry');
      fields(value, ['version', 'id', 'parentId', 'files']);
      hex(value.id);
      if (value.id !== expectedId || manifests.some((manifest) => manifest.id === value.id)) throw new Error('Invalid snapshot ancestry');
      await writeFile(path.join(manifestStore, 'snapshots', `${value.id}.json`), JSON.stringify(value), { flag: 'wx' });
      const manifest = await readSnapshot(manifestStore, value.id);
      manifests.push(manifest);
      expectedId = manifest.parentId;
    }
    if (expectedId !== null) throw new Error('Incomplete snapshot ancestry');
    const snapshot = manifests[0]!;
    const objects = objectsOf(manifests);
    const hashes: string[] = [];
    for (const object of objects.values()) {
      try { await verifyFile(path.join(storeDir, 'objects', object.hash), object); }
      catch (error) {
        // A corrupt published object is not silently trusted or overwritten. Quarantine is a separate local operation.
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
        hashes.push(object.hash);
      }
    }
    await writeFrame(socket, { type: 'need', hashes });
    let filesSent = 0, bytesSent = 0;
    for (const hash of hashes) {
      const object = objects.get(hash)!;
      const start = await frame(socket);
      fields(start, ['type', 'hash', 'size']);
      if (start.type !== 'object' || start.hash !== hash || start.size !== object.size) throw new Error('Unexpected object header');
      const temporary = path.join(staging, 'objects', hash);
      const handle = await open(temporary, 'wx');
      let size = 0;
      const digest = createHash('sha256');
      try {
        for (;;) {
          const part = await frame(socket);
          if (part.type === 'object-end') {
            fields(part, ['type', 'hash']);
            if (part.hash !== hash || size !== object.size || digest.digest('hex') !== hash) throw new Error('Incoming object integrity hash/length mismatch');
            break;
          }
          fields(part, ['type', 'data']);
          if (part.type !== 'chunk' || typeof part.data !== 'string' || !part.data.length || part.data.length > 87384) throw new Error('Invalid object chunk');
          const chunk = Buffer.from(part.data, 'base64');
          if (chunk.length > CHUNK_BYTES || chunk.toString('base64') !== part.data || !chunk.length) throw new Error('Invalid canonical base64 chunk');
          size += chunk.length;
          if (size > object.size) throw new Error('Incoming object integrity length exceeds manifest');
          digest.update(chunk);
          let offset = 0;
          while (offset < chunk.length) {
            const written = await handle.write(chunk, offset, chunk.length - offset);
            if (!written.bytesWritten) throw new Error('Failed to write incoming object');
            offset += written.bytesWritten;
          }
        }
        await handle.sync();
      } finally { await handle.close(); }
      filesSent++;
      bytesSent += size;
    }
    const complete = await frame(socket);
    fields(complete, ['type', 'snapshotId', 'filesSent', 'bytesSent']);
    if (complete.type !== 'complete' || complete.snapshotId !== snapshot.id || complete.filesSent !== filesSent || complete.bytesSent !== bytesSent) {
      throw new Error('Transfer completion id/counters mismatch');
    }
    await mkdir(path.join(storeDir, 'objects'), { recursive: true });
    await mkdir(path.join(storeDir, 'snapshots'), { recursive: true });
    for (const hash of hashes) {
      await publishObject(path.join(staging, 'objects', hash), path.join(storeDir, 'objects', hash), objects.get(hash)!);
    }
    for (const object of objects.values()) await verifyFile(path.join(storeDir, 'objects', object.hash), object);
    // Ancestors first; the offered/current revision becomes visible only after every required object is verified.
    for (const manifest of [...manifests].reverse()) {
      try { await link(path.join(manifestStore, 'snapshots', `${manifest.id}.json`), path.join(storeDir, 'snapshots', `${manifest.id}.json`)); }
      catch (error) { if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error; }
      if (JSON.stringify(await readBoundedSnapshot(storeDir, manifest.id)) !== JSON.stringify(manifest)) throw new Error('Published manifest integrity mismatch');
    }
    let decision: boolean | void = undefined;
    if (onSnapshot) {
      let approvalTimer: ReturnType<typeof setTimeout> | undefined;
      try {
        // Bound the wait, not the callback's side effects: durable authority cannot be rolled back here.
        decision = await Promise.race([
          onSnapshot(snapshot, authenticatedFingerprint, offer),
          new Promise<never>((_, reject) => {
            approvalTimer = setTimeout(() => reject(new Error(
              'Snapshot approval timed out after 120000ms; callback may still complete; ownership requires explicit reconciliation',
            )), FINAL_ACK_TIMEOUT_MS);
          }),
        ]);
      } finally { clearTimeout(approvalTimer); }
    }
    const ownershipAccepted = offer !== undefined && decision === true;
    await writeFrame(socket, { type: 'ack', snapshotId: snapshot.id, filesSent, bytesSent, ownershipAccepted });
    socket.end();
  } catch (error) {
    if (!socket.destroyed) await writeFrame(socket, { type: 'error', message: error instanceof Error ? error.message.slice(0, 512) : 'Snapshot transfer failed' }).catch(() => {});
    socket.destroy();
    throw error;
  } finally {
    if (staging) await rm(staging, { recursive: true, force: true });
  }
}

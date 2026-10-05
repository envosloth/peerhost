# Authenticated snapshot transfer (alpha)

`src/core/transfers.ts` implements direct peer-to-peer snapshot replication over the existing mutually certificate-pinned TLS transport. There is no relay, discovery service, automatic host grant, listener creation, private-key persistence, or live-server materialization in this module.

## Public API

```ts
interface TransferPeer { fingerprint: string; host: string; port: number }

sendSnapshotToPeer(
  identity: PeerIdentity,
  peer: TransferPeer,
  storeDir: string,
  snapshotId: string,
  offer?: TransferOffer,
): Promise<{
  snapshot: SnapshotManifest;
  filesSent: number;
  bytesSent: number;
  ownershipAccepted: boolean;
}>;

receiveSnapshot(
  socket: TLSSocket,
  authenticatedFingerprint: string,
  storeDir: string,
  onSnapshot?: (
    snapshot: SnapshotManifest,
    source: string,
    offer?: TransferOffer,
  ) => Promise<boolean | void>,
  options?: { reserveBytes?: number }, // free space to leave on the volume; default 1 GiB
): Promise<void>;
```

`PeerIdentity` comes from `peer-transport.ts`. `SnapshotManifest` comes from `snapshots.ts`. `TransferOffer` is the existing ownership-ledger type, also re-exported by this module. No key material is written to disk.

Use `listenPeer(identity, trustedPins, (socket, fingerprint) => { void receiveSnapshot(socket, fingerprint, storeDir, callback).catch(reportError); })`. The listener must supply its **authenticated certificate fingerprint**, not a claimed source field from the network. `receiveSnapshot` also checks that fingerprint against the socket's certificate; frame helpers reject sockets that have not passed the transport pin gate. The sender connects with `connectPeer` and sends no application fields until both pins and the client's acceptance preface have been verified.

`filesSent` counts unique content-addressed objects transmitted, not manifest file paths. Duplicate files sharing a hash cost one object. `bytesSent` counts raw object bytes, excluding JSON, base64 overhead, manifests, and TLS overhead. Empty objects count as one object and zero bytes. The sender requires an acknowledgment with the exact snapshot id and counters it actually sent.

## Ownership is separate from replication

A missing offer is replication only and always yields `ownershipAccepted: false`. An offer is carried as callback data, not authority. Its exact field set (`id`, `lineage`, `source`, `target`, `generation`, `snapshotId`), bounded identifiers, positive safe-integer generation, and matching snapshot id are validated. Source/target identity, current owner, target device, generation freshness, conflicts and durable ownership transitions remain the callback/`OwnershipLedger`'s responsibility.

After all required objects and manifests have been verified and published, the callback receives the current snapshot, the authenticated source fingerprint, and the optional offer. Only an offer plus the callback's literal boolean `true` produces an ownership acceptance acknowledgment; `false`, `undefined`, absence of a callback, or a merely truthy value does not. Because the acknowledgment is sent only after the callback *returns*, `ownershipAccepted: false` is a definitive answer that nothing was committed. The application relies on this to cancel a declined offer (`OwnershipLedger.cancelTransfer`); a thrown callback, timeout or lost acknowledgment never produces it. The receiver never starts Minecraft, changes a current-revision pointer, or materializes a server directory.

A callback failure rejects the transfer acknowledgment but leaves the verified replica available. An acknowledgment lost after publication is not evidence of failure to store the snapshot or failure to accept ownership: the application's durable ownership protocol must handle uncertainty. Do not resume hosting simply because the network promise rejected.

The sender allows **two minutes (120,000 ms)** for the final acknowledgment, starting after it writes `complete`. This is an absolute deadline, not an inactivity timer; it includes receiver publication, human approval, callback materialization and durable acceptance. It does not grant two additional minutes for each phase. Only this final read gets the longer deadline: the handshake, missing-object request, object/chunk/completion reads and all frame writes retain their strict **five-second** deadlines.

The receiver also bounds its `onSnapshot` callback wait at **120,000 ms** from invocation. A timeout rejects the transfer, attempts an error response and closes the socket; it **never grants automatic permission** or sends a late acceptance acknowledgment. This bounds waiting, not the callback's execution or side effects: the existing callback API has no cancellation signal, a human prompt may remain open, and the callback can still finish or durably accept ownership later. Verified replicas and already durable target authority are not rolled back or erased by timeout. Slow publication can cause the sender's final deadline to expire before the receiver's callback deadline.

**Retry, not rollback, after a failed, missing or late acknowledgment.** Keep the source durably fenced in its offered state, even if the recipient reports a timeout or error; neither error nor socket closure proves that target authority was never committed. The application resends the same offer on retry. A recipient whose ledger already records that offer id (`acceptedOfferId`) re-acknowledges it without another approval or a second commit. Inspect both durable ownership ledgers and the exact offered revision, confirm any target process and pending/late callback have stopped, and reconcile authority explicitly before authorizing hosting. Do not automatically restore source ownership, treat generic stopped-process recovery as permission to bypass a pending offer, or claim callback cancellation safely reverted an already durable grant.

## Wire protocol v1

All messages are length-prefixed UTF-8 JSON through `writeFrame`/`readFrame`. Exact field sets are enforced; no peer-provided filesystem target path is used.

The backwards-compatible transport API is `readFrame(socket, maxBytes?, timeoutMs = 5000)`. `timeoutMs` must be finite, positive and at most `120000`; invalid values reject before consuming a frame or poisoning the verified connection. The one-MiB/default `maxBytes` validation is unchanged. Each active read has one absolute deadline, including fragmented/trickled frames; queued reads retain their own configured deadline when they become active.

1. Sender: `{type:"snapshot", version:2, snapshotId, parentId, fileCount, offer}`, then `{type:"files", files:[...]}` batches (each ≤ 1 MiB, never empty) until exactly `fileCount` entries have been sent. Only the **head revision** is sent; parents are referenced by id but never transferred, so history length cannot grow a transfer. A version-1 hello is rejected with an explicit "both peers must run the same SeedHost alpha" error.
2. Receiver reassembles the manifest in memory and validates it with the snapshot module's parser (exact schema, canonical sorted unique paths, collisions, sizes, hashes and content id) before touching the filesystem.
3. Receiver: `{type:"need", hashes:[...]}`. Good existing objects are SHA256- and length-verified and omitted. A missing object is requested once. A corrupt existing published object causes an explicit integrity error, **not** silent trust, retransmission, or overwrite. Before answering, the receiver checks that the missing bytes plus its free-space reserve fit on the volume. The sender validates the **entire** requested set against advertised hashes before sending any object header or bytes. The sender waits up to two minutes for this answer, since re-verifying held objects can take a while.
4. For each requested hash, in request order: `{type:"object", hash, size}`, zero or more `{type:"chunk", data}` frames containing canonical base64, then `{type:"object-end", hash}`. Raw chunks are at most 64 KiB. Empty objects have no chunk frames. Headers must match the validated manifest's hash and size. The receiver hashes and writes each chunk incrementally, flushes the file, and checks the complete length and SHA256 before considering the object verified. The sender independently verifies its streamed source object.
5. Sender: `{type:"complete", snapshotId, filesSent, bytesSent}`. Receiver rejects mismatched ids or counters before publication.
6. Receiver publishes objects and flushes the objects directory, confirms every referenced object is still in place, then writes, flushes, links and re-reads the manifest and flushes the snapshots directory. It then runs the callback and sends `{type:"ack", snapshotId, filesSent, bytesSent, ownershipAccepted}`. Errors reject the promise and attempt a bounded `{type:"error", message}` response if the socket remains usable.

A receiver already holding the previous revision transmits only missing changed/new objects; deletions are represented by the new manifest, never destructive edits to old objects. Retrying a fully received snapshot is idempotent and sends zero objects when the local objects remain valid. A received revision can be materialized on its own; its parent revisions are not available on the receiver unless they were sent separately.

## Bounds and filesystem invariants

- Every frame is limited to **1 MiB of UTF-8 JSON**; manifests are split across `files` frames, and a single entry that cannot fit a frame fails before dialing. The reassembled file list is limited to **64 MiB**. Nothing is truncated.
- At most **65,536 file entries** in the transferred revision. History is not transferred and has no limit.
- Each object is at most **16 GiB**; all unique objects of the revision total at most **128 GiB**, including objects already held by the receiver. These are policy limits, not a memory allocation budget.
- The receiver refuses a transfer whose missing bytes would leave less than the free-space reserve (default **1 GiB**) on its volume, before any object bytes are requested.
- Each raw chunk is at most **65,536 bytes** and encoded base64 data at most **87,384 characters**. Noncanonical base64, zero-length chunk frames, oversized chunks, excess bytes, wrong hashes, unexpected message order and malformed fields fail closed.
- The transport's default active frame read deadline, all frame writes and handshakes remain **five seconds**. Only the sender's missing-object request and final acknowledgment reads use **two minutes**; the receiver's callback wait is independently bounded at two minutes as described above. Large local validation/hashing work can still cause explicit peer timeouts in this alpha; advertised caps do not guarantee completion at every storage speed.
- Streams read one 64-KiB chunk at a time; writes await transport backpressure. No file/world content is assembled in RAM. Metadata alone is buffered within the stated cap.
- Each session uses a fresh `.transfer-*` directory in the destination store (created only after metadata validation and the disk-space check), with an `objects` staging directory. Staging files use exclusive creation. Staging is removed on success and rejected operations; another transfer's staging is never reused or removed. Process termination/crash recovery is not promised.
- Wire identifiers must be exactly 64 lowercase hex SHA256 characters. Only validated hashes/ids become object or manifest filenames. Manifest path strings are validated metadata, never receive targets.
- Existing store roots are checked through `readSnapshot`'s root/alias/symlink/Windows-reparse protections before staging. Ordinary-file and no-follow checks guard object opens. A reserved all-zero safety-probe manifest causes an explicit refusal. Stores should be application-controlled, not writable by hostile concurrent local processes. Concurrent transfers each use a fresh `.transfer-*` staging directory inside the same store, so safety walks skip only an enumerated entry that plain-ENOENT proves vanished mid-walk; the walk root itself, a junction present at check time, and every other error still fail closed.
- Verified objects and manifests are published by atomic hard-link creation on the same filesystem, never overwrite/rename-over-existing. Existing publication collisions are revalidated. Hard-link-unsupported filesystems fail explicitly. Existing valid snapshots and current-pointer/live data are never rewritten.
- Interrupted or tampered transfers before a valid completion do not publish the new manifest. Failures during later publication can leave verified immutable objects available, but do not erase previous revisions. Objects and the manifest are flushed, with their directories, before the callback can grant authority; this is configured durability, not tested power-loss proof.

## Verification

```sh
npm run build
node --test dist/tests/transfers.test.js
npm test
```

Tests use real mutually pinned TLS sockets bound only to `127.0.0.1` and disposable `.test-data/transfers-*` fixtures. They exercise byte-exact binary/empty copies, multi-chunk files, changed-only deltas and deletion, head-only transfer, a 5,001-file server after four stop snapshots, a 130-revision history, the free-space reserve, idempotent retries, explicit ownership acknowledgment, a real **5,500-ms approval delay followed by materialization and durable acceptance**, two-minute callback expiration with no automatic grant or rollback of durable authority, source fencing after failed/late acknowledgment, wrong/unknown pins, whole-request validation, forged acknowledgments, interruption/tamper/completion mismatch, metadata/count/byte bounds, invalid manifests, corrupt existing objects, Windows junction refusal, concurrent immutable publication, chunk/base64 bounds and socket closure. Two-minute boundary tests virtualize timers while retaining real loopback TLS and durable ledgers; the 5,500-ms regression uses real elapsed time. Transport tests cover invalid/configured read deadlines and retain real five-second handshake/read/write regressions. These are storage/network fixtures, **not proof of a real Minecraft server handoff**, internet reachability, NAT traversal, or relay functionality.

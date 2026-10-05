# Immutable directory snapshots and copy-only import

## Public API

`src/core/paths.ts` exports:

```ts
validateRelativePath(path: string): string
```

`src/core/snapshots.ts` exports the type and four asynchronous functions:

```ts
interface SnapshotManifest {
  version: 1;
  id: string;
  parentId: string | null;
  files: Array<{ path: string; size: number; hash: string }>;
}

createSnapshot(
  sourceDir: string,
  storeDir: string,
  parentId: string | null = null,
): Promise<SnapshotManifest>

readSnapshot(storeDir: string, id: string): Promise<SnapshotManifest>

materializeSnapshot(
  storeDir: string,
  id: string,
  destinationDir: string,
): Promise<void>

importServer(sourceDir: string, managedRoot: string): Promise<{
  serverDir: string;
  storeDir: string;
  snapshot: SnapshotManifest;
}>
```

The modules have no Electron dependency, network calls, cloud storage, gateway, or server-launch behavior. Snapshotting does not parse or execute modded Java server files; all regular-file content is opaque bytes.

## Layout and identity

```text
<storeDir>/objects/<64-character lowercase SHA256>
<storeDir>/snapshots/<snapshot ID>.json
<storeDir>/.staging-<UUID>/                         # transient

<managedRoot>/store/                            # import's shared storeDir
<managedRoot>/servers/<UUID>/                    # import's unique serverDir
```

An object's SHA256 hashes the raw file bytes, including binary content and original line endings. Paths use forward slashes; entries are sorted with JavaScript ordinal string comparison, not locale-dependent ordering. Sizes are nonnegative safe-integer byte counts.

The snapshot ID is SHA256 of UTF-8 bytes produced by exactly:

```ts
JSON.stringify({ version: 1, parentId, files })
```

Each file entry's property order is `path`, `size`, `hash`. `id` is excluded from its own digest. There are no timestamps or source-root strings in the identity. Equal files and equal ancestry produce equal IDs independent of source location. A changed parent changes the ID even if file content is unchanged. Creation requires an explicitly supplied parent to be an existing valid manifest; reading does not recursively require its ancestry or check every content object.

`readSnapshot` runs the store safety walk and then validates the manifest schema. Within one operation, run `assertSafeStore` once and use `loadManifest` for further reads, so the walk (and the Windows PowerShell reparse probe) is not repeated per revision. `parseManifest` applies the same validation to untrusted in-memory data. `readSnapshot` validates the manifest schema, requested ID, ancestry ID syntax, canonical ordering, paths, sizes, hashes, and path collisions. It returns metadata, not a guarantee that every referenced object is present. `materializeSnapshot` verifies the actual objects before promotion.

## Path and filesystem safety

- Relative Windows separators normalize to `/`. Absolute, rooted, drive-relative, UNC, traversal, empty/repeated segments, ADS/colon, control characters, Windows-invalid punctuation, reserved device names, and trailing dots/spaces are rejected rather than repaired.
- Unicode filenames must already be NFC. Manifest paths must already use forward slashes; source names that would need separator repair are rejected.
- Collision registration includes implied directories, not just complete file paths. `World/a` versus `world/b`, duplicate files, and file/directory prefix conflicts fail closed. Uppercase-then-lowercase Unicode folding also rejects aliases such as long-s/S, conservatively rejecting some additional names.
- Source/store, import source/managed root, and materialization store/destination must be disjoint. Checks cover both lexical paths and canonical existing ancestors, including roots not created yet. Ambiguous trailing-dot/space roots and Windows device namespace roots are rejected.
- Symlinks and junctions are rejected in roots, their ancestors, and their trees. Only ordinary directories and regular files are accepted. On Windows, a noninteractive `powershell.exe` native `FileAttributes.ReparsePoint` probe additionally rejects reparse tags not represented as symlinks by Node. The native check refuses to recurse into a reparse directory. Probe failure or absence fails closed, rather than silently skipping safety checks.
- The recursive walk skips only an enumerated child entry that plain-ENOENT proves vanished between enumeration and inspection (concurrent `createSnapshot`/receive staging directories such as `.staging-*` and `.transfer-*` legitimately appear and disappear inside a store). The walk root itself, any junction/reparse point present at check time, and every other error still fail the check; non-ENOENT errors are never swallowed.
- POSIX input opens use `O_NOFOLLOW` where available. File identity/size/mtime/ctime checks surround streaming reads. A before/after tree metadata inventory detects observed source additions, removals, replacements, and mutations before committing a manifest.

## Immutable publishing and promotion

File data is streamed through SHA256 transforms to exclusive staging files; atomic, same-store hard-link publication never overwrites an existing artifact. Each published target is read back and verified once, including deduplicated targets. A corrupt existing object or manifest causes an error, not an overwrite or silent repair.

**Durability order.** New objects are flushed before linking, then the objects directory is flushed; only then is the manifest written, flushed, linked and its directory flushed. `createSnapshot` returns after all of that, so the application never records a revision in the ownership ledger before its files are on disk. (Windows cannot flush directories through Node; there, directory flushes are skipped.)

**Stat cache.** Each store keeps `stat-cache/<source-hash>.json`, mapping a relative path to its device, inode, mode, size, nanosecond mtime and ctime plus the object hash. A file is reused without being read only when all of those match, the object is present with the expected size, and the file was last modified more than two seconds before the snapshot began (closing the same-timestamp race). Restoring an old mtime with `utimes` still changes ctime, so it is detected. The cache is advisory: an unreadable or malformed cache simply means every file is read.

**Cleanup.** `pruneStore(store, { keep, ancestors })` validates every manifest first and refuses unexpected entries, keeps each kept revision plus `ancestors` parents, deletes other manifests first and only then objects no surviving revision references. The application's **Clean up storage** keeps the current revision, the ledger's revision, any pending offer's revision, and two parents of each; it also removes earlier execution directories and interrupted staging. Callers must hold the store exclusively.

Materialization copies verified objects into an adjacent private staging directory. It verifies both streamed input and written output against each manifest hash and size. It never hard-links a writable managed server to either the original source or store objects. Missing objects, truncation, same-size tampering, incomplete manifests, and write failures before promotion cannot replace the existing destination.

Only after the entire staging tree is verified is an existing ordinary destination directory renamed to a retained sibling:

```text
<destination parent>/.seedhost-previous-<destination basename>-<UUID>/
```

Staging is then renamed into place. An ordinary promotion error attempts to restore the backup. Existing files are not replaced with directories. Successful replacements deliberately retain the backup, including files not present in the incoming snapshot. Each import gets a distinct server UUID, so reimporting does not replace a previously imported, modified server.

## Preconditions and limitations

1. **Stop the Java server and all source writers before snapshot/import.** A successful file read does not prove the server is stopped. Portable Node filesystem APIs do not reliably identify every shared/exclusive Windows lock or Minecraft's running state. A persistent `session.lock` file is not treated as proof of an active process. OS read/lock errors propagate, and observed changes abort, but the metadata checks are not a transactional live-world backup.
2. **Use trusted, quiescent roots and a single writer for promotion.** Do not allow concurrent filesystem mutation, hostile junction/reparse swaps, or multiple processes replacing the same destination. These APIs do not implement directory-handle confinement, a cross-process promotion lock, or a defense against an administrator racing every check. Content digests provide integrity, not peer authentication/signatures.
3. **Immutability is enforced by these APIs**, not by an OS read-only ACL. External modifications are detected on verification/reuse, never repaired in place. Metadata returned to callers is ordinary mutable JavaScript data and does not mutate the retained disk artifact.
4. The manifest represents regular files only. Empty directories, timestamps, permissions, ACLs, extended attributes, alternate streams, and hard-link relationships are not preserved. Original source bytes are not written, renamed, or deleted, although filesystem access-time metadata may change through reads.
5. File content uses bounded stream buffers, not all-world RAM. Manifest and tree-inventory metadata remain in RAM proportional to entry count. There is no disk-space preallocation; a filesystem supporting same-volume hard links (such as NTFS) is required for atomic store publication.
6. This is not a crash-consistent journal or fsync/power-loss guarantee. A crash between the two destination renames can leave the prior directory at its backup path; recover that backup before retrying. Rollback can itself fail because of OS locks or external interference; backup bytes remain retained. Aborted creation can leave verified unreferenced objects; a crash or cleanup error can leave staging folders. Automatic backup deletion and orphan collection are deliberately absent.
7. Standalone materialization's input root is the store. The deterministic manifest intentionally contains no original source-root provenance. Callers must not explicitly request the original imported source as a later materialization target. `importServer` itself enforces copy-only, disjoint roots and returns a new managed target.

## Real RED/GREEN verification

All fixtures are disposable folders beneath the project's `.test-data`, cleaned by test hooks. No pre-existing hosted-server files, worlds, credentials, or state were accessed. Filesystem tests use actual files, Windows junctions, streamed content (including a 16 MiB fixture), and real filesystem watcher faults; there are no mocked snapshot/object responses.

Vertical RED/GREEN cycles covered the missing path validator, unsafe aliases, missing create/read/materialize/import APIs, integrity/schema/parent validation, directory nesting, junctions, observed source mutation, and publication corruption. Before implementation, actual tests reported assertions including `relative-path validator must exist`, `snapshot creation API must exist`, and `Missing expected rejection: tampered-object`. The final publication-corruption regression was first run alone and reported **1 test, 0 pass, 1 fail**, because creation incorrectly accepted an object modified at publication; verification was then bound to the original source digest.

Final verification on Windows with Node v26.7.0:

```text
npm run build
> tsc -p tsconfig.json
(exit 0)

node --test dist/tests/snapshots.test.js dist/tests/paths.test.js
ℹ tests 17
ℹ suites 0
ℹ pass 17
ℹ fail 0
ℹ cancelled 0
ℹ skipped 0
ℹ todo 0
(exit 0)
```

Early shared-workspace builds briefly reported unrelated launcher/peer-transport compilation errors while other agents were editing. Those files were not modified here; final project compilation passed. This verification is the scoped snapshot/path suite, not a claim about Minecraft gameplay or the rest of the application.

### Race hardening: transient staging churn (concurrent transfers)

A flake in the concurrent-transfer regression (`.transfer-*` staging directories created and removed by one receiver while validation walked the same store root) was reproduced with an aggressive churn harness: on the unfixed build, 65 of 90 `readSnapshot` attempts rejected — 60 with `ENOENT lstat/scandir` for a staging entry that vanished between enumeration and inspection, and 5 with `Windows reparse-point safety check failed` when the PowerShell probe enumerated a directory that had just disappeared (an unhandled `DirectoryNotFoundException`). The new regression `skips only transient entries that vanish during recursive safety validation` failed **5/5** RED runs on the unfixed build.

The fix (in `assertSafeRoots` and its PowerShell probe) skips only a plain-ENOENT enumerated child at stat/enumeration time. A junction observed at check time, the walk root itself, and every non-ENOENT error still fail. GREEN evidence on the fixed build: 30/30 regression runs, 30/30 runs of `concurrent transfers use fresh staging and atomically publish the same immutable objects`, two aggregate `transfers + snapshots + paths` runs (47/47 tests each) and the full `node tools/run-tests.mjs` suite (189/189, exit 0); the churn harness rejected 0/92 attempts with 0 abandoned `.transfer-*` directories.

## Owned paths

- `src/core/paths.ts`
- `src/core/snapshots.ts`
- `tests/paths.test.ts`
- `tests/snapshots.test.ts`
- `docs/snapshot-implementation.md`

No package configuration changes or commits were made for this task.

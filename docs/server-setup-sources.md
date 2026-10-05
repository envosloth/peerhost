# Server preparation: contract, sources and verification

## Public API

`src/core/server-setup.ts` exports:

```ts
interface CreateServerInput {
  name: string;
  loader: 'vanilla' | 'fabric';
  gameVersion: string;
  javaExecutable: string;
  memoryMiB: number;
  eulaAccepted: boolean;
}
class ServerSetupClient {
  listVersions(): Promise<{ latest: string; versions: Array<{ id: string }> }>;
  prepare(stagingParent: string, input: CreateServerInput): Promise<{
    sourceDir: string;
    profile: LaunchProfile;
    loader: 'vanilla' | 'fabric';
    gameVersion: string;
  }>;
}
probeJava(executable: string): Promise<{ executable: string; major: number; version: string }>;
discoverJava(): Promise<Array<{ executable: string; major: number; version: string }>>;
```

Instantiate production with `new ServerSetupClient()`; URLs and allowlists cannot be supplied as general options. `LaunchProfile` is the existing saved-state type, including 600/180-second start/stop defaults. The caller owns successful `sourceDir` adoption and cleanup, normal managed storage, ownership checks, profile persistence and the initial revision. Preparation does **not** persist application state, start Minecraft, install/run a Fabric installer, install Java, or change system settings.

`stagingParent` must already exist, be absolute and not itself a symlink; it must be a parent/native-owned private managed directory, not a renderer-provided path or a directory another process may replace. Each successful call produces a unique `seedhost-setup-*` child, never a name-derived path or an existing world. Failure removes only that call's private child; sibling files are retained. Names, release identifiers, executable paths, loader, whole-number RAM (256–1048576 MiB) and exact boolean consent are validated before network traffic. Inputs are copied before asynchronous work, so a caller cannot mutate consent mid-download. False consent means **no `eula.txt`**; true writes exactly `eula=true\n`, after verified preparation. The parent must explain and collect consent using the actual [Minecraft EULA](https://www.minecraft.net/en-us/eula).

## Official sources and executable trust

### Vanilla

- Official release manifest: <https://piston-meta.mojang.com/mc/game/version_manifest_v2.json>. `latest.release`, release entries and their `url`/`sha1` are consumed directly; snapshots are not offered.
- Each selected version's raw JSON is SHA-1 checked against its manifest entry before parsing. Its `id` must match the requested release. `javaVersion.majorVersion` is required, not guessed from a version-number cutoff. Older releases lacking this field fail closed with an Import recommendation rather than assuming Java 8.
- `downloads.server.url`, `size` and `sha1` define the actual server artifact. Exact size and the upstream SHA-1 are checked before writing it. Version metadata hosts are `piston-meta.mojang.com` / `launchermeta.mojang.com`; executable hosts are `piston-data.mojang.com` / `launcher.mojang.com`.
- This follows Mojang's actual live metadata, not third-party server listings. SHA-1 is Mojang's published checksum, not a claim of a detached publisher signature. HTTPS authenticates the source.

### Fabric: verified executable dependencies, data-only bootstrap

- Official API routes: <https://meta.fabricmc.net/>.
- Loader metadata: <https://meta.fabricmc.net/v2/versions/loader/1.21.1>.
- Server profile: <https://meta.fabricmc.net/v2/versions/loader/1.21.1/0.19.5/server/json>.
- Official Maven repository: <https://maven.fabricmc.net/>. The profile's library URLs must be this exact root; safe three-part Maven coordinates determine jar URLs. Libraries with `sha256` and `size` use those fields. Libraries without an inline SHA-256 (notably loader and intermediary) require the official `.jar.sha256` sidecar. Missing, malformed or mismatching checksums fail; there is no unverified executable-code fallback.
- Preparation currently pins **Fabric Loader 0.19.5**, an inspected modern launcher layout. It must appear in the official game-specific loader response. The profile ID, inherited game, KnotServer entry point, launcher metadata version 2, Java minimum, loader/intermediary presence, unique coordinates and library limits are checked. An unsupported upstream layout is an error, not a speculative compatibility label. No Fabric API mod is added implicitly.
- Fabric's generated `/server/jar` response has no published artifact checksum and is **not** downloaded. Its upstream implementation edits an installer-server jar to insert `install.properties`: [ServerBootstrap.java, inspected source](https://github.com/FabricMC/fabric-meta/blob/b40c08d703827ed09a54006a48a90c4320f6d05d/src/main/java/net/fabricmc/meta/web/ServerBootstrap.java).
- Instead, the checked dependencies are written to generated safe `libraries/lib-N.jar` names. A local `fabric-server-launch.jar` contains **only** a manifest and `fabric-server-launch.properties`, reproducing Fabric's modern non-shaded installer bootstrap. It contains no generated or downloaded executable classes. The executable launcher class comes from the SHA-256-verified loader jar.
- Authoritative bootstrap recipe: [ServerInstaller.java, inspected source](https://github.com/FabricMC/fabric-installer/blob/6e7d1acd6a951a19a323060ac955f5e7bc51e3ce/src/main/java/net/fabricmc/installer/server/ServerInstaller.java). Authoritative launcher: [FabricServerLauncher.java, inspected source](https://github.com/FabricMC/fabric-loader/blob/c75cac153757b1a75e63e901bed5bc97eff630d3/src/main/java/net/fabricmc/loader/impl/launch/server/FabricServerLauncher.java). The inspected 0.19.5 jar manifest also declares that launcher class.
- Manifest attributes, relative Class-Path and 72-byte continuation lines follow the [Oracle JAR specification](https://docs.oracle.com/en/java/javase/21/docs/specs/jar/jar.html#jar-manifest). The existing dependency-free ZIP writer builds this data-only archive.

All production URLs require HTTPS, exact allowed hosts, no credentials, query or fragment; redirects are rejected, never automatically followed. Streaming body accounting enforces 8 MiB per metadata response, 256-byte checksum sidecars, and a combined 256 MiB executable budget for Minecraft plus all Fabric libraries. There are at most 64 Fabric libraries, 1024 loader entries and 10000 manifest entries. Every request has a 30-second full-body deadline; a preparation has a 10-minute overall network deadline. Bodies/readers are cancelled on errors. Artifacts are buffered within these bounds, then verified before writing.

## Java scope

Only `execFile(executable, ['-version'], { shell: false, ... })` is used, with a three-second timeout, forceful kill and 16 KiB limit per output stream. See the [Node execFile documentation](https://nodejs.org/api/child_process.html#child_processexecfilefile-args-options-callback). Native-selected absolute paths are required; `.cmd`, `.bat`, NUL/newline paths and shell commands are rejected. JVM environment-injected options/agents (`JAVA_TOOL_OPTIONS`, `JDK_JAVA_OPTIONS`, `_JAVA_OPTIONS`) are removed during the probe. stderr/stdout, modern quoted/unquoted versions and legacy `1.8` are supported; malformed versions or failed probes fail clearly.

Discovery checks JAVA_HOME/bin and absolute PATH directories only: at most 32 directories, 16 deduplicated real executables, batches of four probes. It does not scan the entire disk, run `which`/`where`, use a shell, query a registry, or silently install anything. An empty result is not proof Java is absent everywhere; the parent can offer a native picker for an unlisted runtime. Probing intentionally executes the selected/local Java binary; it is not a sandbox or an authenticity check of that binary. The reported Java major is compared with Mojang's requirement and Fabric's launcher requirement; this is not a guarantee of compatibility for arbitrary imported modpacks.

## Fixtures versus real verification

The only injection option is explicit `testOnly: { origin: 'http://127.0.0.1:PORT' }` (or numeric IPv6 loopback). It accepts neither DNS hostnames nor non-loopback origins. Fixture traffic is restricted to that exact origin. Optional test-only time/byte limits may only **lower** production limits. Never pass this object through IPC, renderer payloads, settings or production configuration. Fixture server/library bytes and Java scripts are explicitly labelled fixtures, not Minecraft runtime proof. All generated test files live in TMPDIR and are removed.

### Actual vertical RED → GREEN evidence

Commands used at each production slice:

```sh
node --test tests/server-setup.test.mjs
npm run build && node --test tests/server-setup.test.mjs
```

Actual complete logs are in `$TMPDIR/server-setup-red-NN.log` and `$TMPDIR/server-setup-green-NN.log`. Every slice was observed failing before its implementation; GREEN always included a real TypeScript build. Existing edge-case regression assertions were added alongside slice 12 without claiming those already-working cases were separate RED cycles.

| Slice | RED pass/fail | GREEN pass/fail | Behavior |
|---|---:|---:|---|
| 01 | 0/1 | 1/0 | Native Java probe |
| 02 | 1/1 | 2/0 | Legacy/unquoted versions |
| 03 | 2/1 | 3/0 | Probe output/time/path bounds |
| 04 | 3/1 | 4/0 | Deduplicated discovery |
| 05 | 4/1 | 5/0 | Release listing |
| 06 | 5/1 | 6/0 | Endpoint and manifest trust |
| 07 | 6/1 | 7/0 | Streaming metadata bounds/deadline |
| 08 | 7/1 | 8/0 | Verified unique stopped Vanilla source |
| 09 | 8/1 | 9/0 | Validation before effects |
| 10 | 9/1 | 10/0 | Explicit EULA and low-RAM arguments |
| 11 | 10/1 | 11/0 | Verified Fabric dependencies/bootstrap |
| 12 | 13/1 | 14/0 | Missing official Java requirement clarity |
| 13 | 14/1 | 15/0 | Immutable consent across awaits |
| 14 | 15/1 | 16/0 | Aggregate executable budget |
| 15 | 16/1 | 17/0 | Whole-operation deadline |

Slice 15 initially failed because the test-only deadline option did not exist. After introducing the option, `server-setup-red-15b.log` showed the behavioral RED: “Missing expected rejection” after all individually timely requests. The final GREEN enforced the overall deadline and rollback. Other actual RED examples: slice 02 `1 !== 8`; slice 08 `prepare is implemented` (undefined); slice 11 “Verified Fabric preparation is not supported yet”; slice 13 unexpected `eula.txt`.

### Live upstream exercise

```sh
npm run build
SEEDHOST_SETUP_LIVE_JAVA=/absolute/already-present/java \
  node --test tests/server-setup.test.mjs tests/server-setup-live.test.mjs
```

The live test is opt-in and otherwise skipped. A real already-present parent-owned scratch Java runtime was selected:
`<scratch>/seedhost-java25-runtime/jdk-25.0.4.1+1-jre/bin/java`.
It reported Java major 25, version `25.0.4.1`. No runtime was installed by this module or exercise.

Observed official metadata: latest release `26.3`, 103 release entries. Actual Vanilla and Fabric preparation for **1.21.1** succeeded, without EULA acceptance or Minecraft launch:

- Minecraft server: **51627615 bytes**, upstream SHA-1 `59353fb40c36d304f2035d51e7d6e6baa98dc05c`.
- Fabric Loader **0.19.5**, eight actual upstream libraries checked. Loader SHA-256 `93044e4dd46de5d8136701292f05e868da096d2c9fddb4793e4fdbcc63efc695`; intermediary SHA-256 `6059157dfb4a536ec151697004f74f6004b7d346b289c2f89849e0e585aa36fa`.
- Real jar ZIP headers/manifests and the actual launcher class in the verified loader were checked. No world or EULA file appeared. Temporary prepared sources were deleted by the live test.
- The full live diagnostic (all library byte counts/hashes and both launch profiles) is `$TMPDIR/server-setup-live.log`.
- Final combined verification rebuilt TypeScript and ran both focused test files with the real runtime: **18 tests, 18 pass, 0 fail, 0 skipped**. Actual combined output is `$TMPDIR/server-setup-final-green.log`. `git diff --check` also completed successfully; no commits were made.

This verifies official metadata/download preparation on Linux, **not** a running Minecraft server, network reachability, Windows/macOS execution, installed Java discovery on other machines, or parent application integration. A real server start/stop/world-save test remains parent-owned and requires explicit EULA consent. Paths in a launch profile belong to the current machine; re-probe/select Java on another host.

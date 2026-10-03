# Structured local process launcher

## API

`src/core/launcher.ts` exports `ServerProcess extends EventEmitter`, `ServerProcessProfile`, and `ServerProcessState`.

```ts
interface ServerProcessProfile {
  executable: string;
  args: string[];
  cwd: string;
  readyPattern?: string;
  startTimeoutMs?: number;
  stopTimeoutMs?: number;
}

class ServerProcess extends EventEmitter {
  constructor(profile: ServerProcessProfile);
  get state(): 'offline' | 'starting' | 'running' | 'stopping' | 'failed';
  get pid(): number | undefined;
  start(): Promise<void>;
  stop(): Promise<void>;
  sendCommand(command: string): void;
  forceStop(): Promise<void>;
}
```

- The constructor copies the profile and its argument array. Later caller mutations cannot change the executable, arguments, or readiness rule.
- `start()` immediately enters `starting`. It spawns exactly the supplied executable/argument vector with `shell: false`, piped stdio, the supplied working directory, and `windowsHide: true`. Do not prequote individual arguments, including paths containing spaces.
- `readyPattern` is a **case-sensitive literal substring**, never a regular expression. It is checked only against individual stdout lines. The default is `Done (`. For example, `Done.*` literally requires those characters; it does not match `Done (fixture)!`. An explicitly empty pattern is rejected by the constructor.
- `start()` resolves after matching stdout readiness and entering `running`. Stderr is logged but cannot prove readiness. The default startup budget is 60,000 ms.
- Duplicate `start()` calls reject while an owned child or active transition exists. After completed cleanup or a graceful stop, the same object can start again.
- `sendCommand()` requires a running child and writable stdin. Input must be one string with no CR or LF, and at most **1,024 UTF-8 bytes before the appended newline**. It writes the exact command followed by `\n`; this is not acknowledgement that the server executed it. Asynchronous console errors move the state to `failed` without an unhandled `error` event.
- `stop()` enters `stopping`, writes `stop\n`, and waits for the child's `close` event, which follows actual process exit and stdio completion. It does not resolve merely because the child acknowledged `stop`. The class default stop budget is 30,000 ms; the application passes each server's configured stop timeout (default 180 s) instead. A retained asynchronous stdin-write error rejects **after close even when exit code is zero**, with the original error as `Error.cause` and save completion explicitly unconfirmed. A nonzero exit or signal also rejects with save completion unconfirmed. The first console error is retained in that launch's context; an accepted new `start()` receives an independent context without clearing the old stop's error or cause.
- A graceful stop timeout rejects with: `Graceful stop timed out; child is still owned. Explicit force-stop via forceStop() risks data loss.` It **does not kill** the child. The state remains `stopping`, the live PID stays owned, and another start remains blocked. A later natural child exit can still move it offline.
- `forceStop()` is a separate, explicit destructive action. It sends `SIGKILL` only through this instance's retained `ChildProcess` object and waits for `close`. It must not be an automatic fallback for a stop timeout. The UI should obtain explicit informed consent; forced termination can lose world data.
- `stop()` and `forceStop()` are harmless when no child remains. They do not clear a retained `failed` state by themselves.
- Child spawn `error`, synchronous spawn exceptions, and `exit` before readiness reject startup and leave `failed`. The original asynchronous spawn error is retained as `Error.cause` (including `ENOENT`). Readiness timeout terminates only the owned child and rejects **after cleanup**. A nonzero unexpected exit after readiness also leaves `failed`.
- Force-stopping a not-yet-ready launch rejects its pending `start()` and leaves `failed`; it must never later announce readiness. The `starting` state is published only after the child and its close/error/exit/stdin-error handlers exist, so a listener reacting synchronously to `starting` can deliver `stop()` or `forceStop()` to the real child. Either request moves the launch to `stopping` synchronously, so a later readiness line can never report `running` for a cancelled launch.
- Events are `line(string)` for stdout/stderr text without line terminators, and `state(ServerProcessState)` for changed states. The readiness line is emitted before `running`. Stdout/stderr arrival order relative to each other is not guaranteed.

**Launch lifetime:** Each accepted launch has its own child, closure promise, force-stop flag, and first console error. Both stop operations capture that context before any wait. Context identity gates every state transition, startup termination, and stdout/stderr readiness/log callback (including a recheck after emitting a stdout line). An old graceful stop still rejects its original failure after real closure even when a replacement has already been accepted, but it cannot fail or terminate the replacement. The old startup promise and closure promise settle only their own launch.

**Ownership:** There is no process discovery, PID adoption, process-tree search, `taskkill`, `pkill`, or Java-name matching. Each instance can terminate only the child it created. `failed` does not always mean stopped: a live runtime console failure still retains the child. Callers must await the appropriate lifecycle promise and check PID/ownership before revision transfer or handoff.

## Fixture and scope

`tools/fake-java-server.mjs` is a Node process-protocol fixture. Tests launch it with `process.execPath` plus an absolute fixture-path argument, never a shell command. It logs a JSON argument/cwd/PID observation, a stderr diagnostic, `Done (fixture)!` readiness, and `console:<command>` replies.

Options used by tests:

| Option | Behavior |
| --- | --- |
| `--lifetime-ms=N` | Safety exit after N ms; default 5,000 |
| `--exit-code=N` | Exit code for the safety timer; default 0 |
| `--no-ready` | Do not emit stdout readiness |
| `--stderr-ready` | Emit readiness only to stderr |
| `--stop-delay-ms=N` | Delay actual exit after acknowledging stop |
| `--ignore-stop` | Log stop but keep the process alive |
| `--exit-on-command` | Exit with code 7 on the first console command |

Every temporary working directory is under the project's `.test-data/launcher with spaces-*`. Tests clean up their own child and directory; the fixture lifetime is a second safety net. An ownership test runs two independent fixture children and proves force-stopping one leaves the other's PID and running state intact.

**This is not Minecraft proof.** No Java runtime, Minecraft JAR, EULA acceptance, real world loading, networking/gameplay, world-save durability, or mod compatibility was verified. No real server data was opened or changed. This class does not download Java/JARs, invoke batch launchers, adopt an already-running server, or supervise grandchildren. Operating-system denial of child termination has not been exercised; force-stop/failed-start cleanup waits for OS-confirmed closure, not a fabricated stopped state.

## RED/GREEN evidence

Implementation proceeded in vertical test-first slices. Each added production behavior was preceded by an executed failing launcher test, then an executed passing suite. Representative observed RED failures:

| Slice | Actual RED observation |
| --- | --- |
| Public API and initial state | `ServerProcess must be exported` |
| Launch, argv/cwd, stdout readiness, and log events | `server.start is not a function` |
| Explicit owned force-stop | `first.server.forceStop is not a function` |
| Real graceful stop | `server.stop is not a function` |
| Bounded single-line console input | `server.sendCommand is not a function` |
| Duplicate launch guard | `Missing expected rejection` |
| No silent stop-timeout kill | `Missing expected rejection` |
| Startup deadline/cleanup | Received `Server exited before stdout readiness` instead of a deadline error |
| Spawn error provenance | Expected `ENOENT` cause, received `undefined` |
| Runtime nonzero exit | Received `offline` instead of `failed` |
| Synchronous spawn failure | Received `starting` instead of `failed` |
| Queued writes during child exit | Unhandled `Error: write EPIPE` |
| Timeout and readiness configuration validation | `Missing expected exception` |
| Immutable launch profile | Mutated executable was attempted and raised `ENOENT` |
| Abnormal graceful exit | `Missing expected rejection` |

Additional regression tests cover early exit code reporting, literal-pattern semantics, repeat start/stop, no-op idle stop, and force-stop while starting. Tests exercise real spawned Node processes; no mocked spawn results or simulated Minecraft results are used.

Verification commands on this Windows host (Git Bash):

```sh
npm run build
command node --test dist/tests/launcher.test.js
```

Observed targeted result: **19 tests, 19 passed, 0 failed**, approximately three seconds on Node v26.7.0. Five additional consecutive targeted runs each reported 19 passed and zero failed. A subsequent read-only Windows process query reported `fixture_process_count=0`.

A full `npm test` run also exercised the launcher: all 19 launcher tests passed. At that workspace snapshot the complete suite reported **107 tests, 96 passed, 11 failed**; the failures were the concurrently developed `ipc-policy` peer DNS/IP endpoint-validation test and its invalid-host subtests, outside launcher ownership. No unrelated files were changed to conceal those failures.

A transient full-project compilation failure in the concurrently edited `tests/snapshots.test.ts` was bypassed only to observe the startup-deadline RED using an isolated compilation of these owned files; later ordinary `npm run build` succeeded. The isolated command, if parallel work temporarily blocks compilation again, is:

```sh
command node node_modules/typescript/bin/tsc --ignoreConfig --types node \
  --target ES2022 --module NodeNext --moduleResolution NodeNext \
  --rootDir . --outDir dist --strict --esModuleInterop --skipLibCheck \
  --noUncheckedIndexedAccess --sourceMap src/core/launcher.ts tests/launcher.test.ts
command node --test dist/tests/launcher.test.js
```

## Console-write false-success regression

Two additional vertical RED/GREEN slices use a real Node child supplied with `-e` directly (no shell and no fixture-tool changes). It prints stdout readiness but never reads stdin. A file inside its disposable fixture working directory gates a zero exit, ensuring it cannot close its pipe until the parent has queued 1,024 maximum-length commands and requested stop. A six-second abnormal-exit safety timer bounds the fixture. This is process-protocol evidence only, not Minecraft save verification.

1. **RED:** The console-failure test reported `Missing expected rejection`. Before that assertion it proved an actual asynchronous `write EOF` after the stop request, child exit code 0, ordered events `stdin-error,close,stop-settled`, destroyed stdio streams, no retained launcher PID, and `process.kill(pid, 0)` rejecting with `ESRCH` (observed PID 15668).
2. **GREEN:** Store the first stdin error and, after awaiting close, reject graceful stop with `save completion is unconfirmed` and the original error as `cause`. The regression passed and the then-20-test launcher suite passed.
3. **RED:** A separate new-launch test failed with the previous launch's `write EOF` after a later clean zero exit.
4. **GREEN:** Clear the stored console error at the beginning of an accepted new launch. The restart regression passed and all **21 launcher tests passed**. The existing alive-process stop-timeout/explicit-force-stop test remained green.

Exact executed RED commands (each exited 1 after a successful build):

```sh
npm run build && command node --test --test-name-pattern='graceful stop rejects asynchronous console failure' dist/tests/launcher.test.js
npm run build && command node --test --test-name-pattern='a new launch clears the previous console failure' dist/tests/launcher.test.js
```

The initial regression test draft had TypeScript callback-observation narrowing errors; these were corrected before observing the behavioral RED, without changing production code.

Final GREEN, repetition, and broader verification commands:

```sh
npm run build && command node --test --test-name-pattern='a new launch clears the previous console failure' dist/tests/launcher.test.js && command node --test dist/tests/launcher.test.js
for run in $(seq 1 20); do printf '\nRegression repeat %s/20\n' "$run"; command node --test --test-name-pattern='graceful stop rejects asynchronous console failure|a new launch clears the previous console failure' dist/tests/launcher.test.js || exit "$?"; done
command node tools/run-tests.mjs
```

All 20 repeated runs reported both regressions passed, zero failed; every console-failure run observed `write EOF`, exit 0, and the same required close-before-settlement event order. The broader freshly compiled workspace suite reported **174 tests, 174 passed, 0 failed** (including concurrent agents' tests). No unhandled stream or promise errors appeared.

Read-only cleanup checks, executed after those runs:

```sh
powershell.exe -NoProfile -Command '$fixtures = @(Get-CimInstance Win32_Process | Where-Object { $_.Name -eq "node.exe" -and ($_.CommandLine -like "*fake-java-server.mjs*" -or $_.CommandLine -like "*exit-requested*") }); Write-Output ("launcher_fixture_process_count=" + $fixtures.Count); if ($fixtures.Count -ne 0) { $fixtures | Select-Object ProcessId,CommandLine | ConvertTo-Json -Compress; exit 1 }'
command node --input-type=module -e 'import { readdir } from "node:fs/promises"; const entries = await readdir(".test-data"); const leftovers = entries.filter(name => name.startsWith("launcher with spaces-")); console.log(`launcher_fixture_directory_count=${leftovers.length}`); if (leftovers.length) {console.log(leftovers); process.exitCode=1;}'
```

Observed `launcher_fixture_process_count=0` and `launcher_fixture_directory_count=0`. Only launcher source, its tests, and this document were edited for the fix; no staging, commits, real-server operations, or public networking were performed.

## Per-launch overlapping lifecycle regressions

Two subsequent vertical RED/GREEN slices reproduce the reviewer's overlapping real-child sequences. No spawn, stream errors, process events, or closure promises are mocked. Restart order is controlled by registering `forceStop().then(start)` before the overlapping `stop()`, and the tests assert that the old real `close` precedes accepted restart, which precedes old-stop settlement.

1. **Console cause isolation — RED:** On a real asynchronous stdin failure, the `failed` state listener requests force-stop, schedules restart in its promise continuation, then requests graceful stop. The first child never reads stdin and exits zero through a disposable file gate; the replacement reads stdin and stops cleanly. The test failed with `Missing expected rejection`, after observing `write EOF`, exit 0, and `stdin-error,old-close,restart-accepted,old-stop-resolved`. The old PID was confirmed absent with `ESRCH` and its stdio destroyed.
2. **Console cause isolation — GREEN:** Store child/closure/force-stop/error in a per-launch context. The old stop checks that context after closure and rejects with the same actual stdin error object as `cause`; a replacement does not clear it or inherit it. The targeted regression and then-22-test launcher suite passed.
3. **Replacement readiness isolation — RED:** Request force-stop of a running real child, schedule restart in its promise continuation, then overlap graceful stop. The original stop correctly rejected the old `SIGKILL` exit, but its post-await state write poisoned the replacement. Observed `old-close,restart-accepted,old-stop-rejected`, replacement state `failed`, followed by `Server stdout readiness timed out after 2000 ms`.
4. **Replacement readiness isolation — GREEN:** Require launch identity on every state write and guard startup termination and readiness/log callbacks. The original stop still rejects the abnormal exit with save completion unconfirmed; the replacement transitions only `starting,running` and subsequently stops with a zero exit. The targeted regression and all **23 launcher tests passed** after a fresh ordinary project build.

Exact executed RED commands (each successfully built, then exited 1 for the behavioral regression):

```sh
npm run build && command node --test --test-name-pattern='overlapping stop retains the old console cause' dist/tests/launcher.test.js
npm run build && command node --test --test-name-pattern='overlapping stop rejects the killed launch' dist/tests/launcher.test.js
```

Final GREEN command and repeat command (the latter run ten consecutive times):

```sh
npm run build && command node --test --test-name-pattern='overlapping stop rejects the killed launch' dist/tests/launcher.test.js && command node --test dist/tests/launcher.test.js
command node --test dist/tests/launcher.test.js
```

All **ten full-suite repeats** reported 23 tests passed, zero failed, zero cancelled, exit code 0. Every repeat observed the actual console error `write EOF`, old zero exit, and `stdin-error,old-close,restart-accepted,old-stop-rejected`; the signal regression observed old `SIGKILL`, replacement state `starting` after the old rejection, and `old-close,restart-accepted,old-stop-rejected`. Both regressions also await replacement readiness and a clean replacement graceful stop, so original failures are not masked by early success or force-killing the replacement.

The existing default literal readiness and timeout policy, alive-child graceful-stop timeout, explicit destructive force-stop ownership, and PID/stdio closure tests remain unchanged and passing. This cycle edits only `src/core/launcher.ts`, `tests/launcher.test.ts`, and this document. No application/main/config/package/transport/path edits, staging, commits, public networking, or real-server resources were used. These remain Windows Node process-protocol tests, not Minecraft save proof; denied OS termination and process descendants remain untested.

## Synchronous starting-listener cancellation

A third vertical RED/GREEN slice covers a termination request issued synchronously from a `state` listener while the launch is still in `starting`. The state was previously published before the spawned child was attached to the launch context, so `stop()`/`forceStop()` returned immediately and the pending launch went on to announce readiness.

1. **RED:** Both new regressions failed against the real fixture child. The force-stop test observed the listener-issued `forceStop()` resolve while the child was still alive (assertion `force-stop must await actual child closure`, actual PID 24096), and the stop test failed with `Missing expected rejection` because `start()` resolved even though the listener had requested a graceful stop.
2. **GREEN:** Publish `starting` only after the child and its close/error/exit/stdin-error handlers are initialized. Both regressions passed; listener-issued stop/force-stop now deliver `stop\n` to the real child (`console:stop` observed), reject their pending `start()` with `before stdout readiness`, never emit `running`, and report their original rejection without poisoning later launches. Full launcher suite: **25 tests, 25 passed, 0 failed**.

Exact executed RED/GREEN commands:

```sh
npm run build && command node --test --test-name-pattern='synchronous starting listener' dist/tests/launcher.test.js
npm run build && command node --test dist/tests/launcher.test.js
```

An independent read-only falsification review confirmed the fix: the pre-spawn window is not listener-observable, the synchronous spawn-throw and post-close no-op paths are correct because no child remains, the asynchronous spawn-error window takes the bounded await path, cross-launch isolation guards are unchanged, and both listener regressions passed 10/10 repeats with zero leaked processes or test directories.

# Disposable real Minecraft verification

## Observed result

The parent directly executed `tools/real-minecraft-check.mjs` after the delegated runner failed at its provider usage limit. The runner exited **0** with actual Vanilla **1.21.1** and Fabric **1.21.1**, each downloaded through the production checked official-download implementation and run with disposable Temurin **25.0.4.1**. The user explicitly accepted the Minecraft EULA for these disposable servers. No system Java installation or PATH/config changes were made.

For each loader the runner observed:

- Real JVM stdout readiness and a decoded Minecraft status response identifying version 1.21.1/protocol 767, first directly and then through the opt-in gateway core.
- A console-created `peerhostSmoke` scoreboard objective, graceful Stop, a saved `world/data/scoreboard.dat`, and an actual captured snapshot.
- Park/Claim custody with pinned TLS, then host A serving Minecraft through the relay player listener.
- Closing A's tunnel and stopping its server removes readiness and refuses a new player/status connection.
- Park fences A against a new Start. A's application profile closes before B claims the verified saved world.
- The transferred scoreboard file's SHA256 matches the saved file. B holds generation 4 and serves a real Minecraft status response at the **same** relay player port.
- B stops gracefully and captures a new revision.

Final integrated run: Vanilla's player port was `41869`; Fabric's was `42045`. These are ephemeral loopback test ports, not usable deployed addresses. A post-run process inspection returned `DISPOSABLE_JAVA_PROCESSES=[]`.

## Evidence

Scratch log: `<scratch>/peerhost-final-minecraft.log`

Parent-read result: `<scratch>/peerhost-real-minecraft-WpDetk/result.json`

Artifact root contains separate stopped Vanilla/Fabric sources, two managed host profiles each, and relay stores. Scratch artifacts are temporary and can be pruned; the runner recreates them.

## Repeat

After a clean build, set an absolute, explicitly approved disposable Java executable in `PEERHOST_SMOKE_JAVA`, explicitly set `PEERHOST_SMOKE_ACCEPT_EULA=true`, and run `npm run check:minecraft`. `TMPDIR` must point to the approved scratch directory. Official network downloads and several real JVM starts are required. The runner only binds loopback and does not change firewall/router/startup services.

## Boundaries and remaining work

This is **not** authenticated player login, interactive gameplay, Internet/LAN reachability, or a test on two physical PCs. The final runner exercises application opt-in and automatic gateway start/stop, not manually opened host tunnels. The visible onboarding check separately saves the opt-in, observes not-ready/verified-route states, forwards a real echo fixture and stops the route. The development profiles simulate hosts on one computer, sequentially.

The preliminary core-only run occurred before application integration and had a blocked desktop build. It is superseded by the final integrated run above: clean TypeScript build, **375/375 automated tests with zero skips**, and **8/8 real visible Electron checks**. This does not certify packaging, authenticated gameplay, or physical/public networking. Independent review was blocked by provider usage limits; parent review and targeted security regressions are documented in [onboarding verification](onboarding-verification.md). Nothing was committed, released, deployed, or published.

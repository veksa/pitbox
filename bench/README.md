# bench — P0 measurements

Scripts that measure what pitbox is meant to improve. They run with Node 22+ directly (`node bench/x.ts`,
type stripping), with no dependencies.

| Script | Measures |
|---|---|
| `devserver.ts` | dev server: time to ready, first bundle, repeat request, edit-to-bundle; cold or warm cache in an isolated temp dir |
| `metro-raw.mjs` | starts Metro through its API with the project's config, to compare against the CLI that wraps it |
| `cpuprofile.ts` | summarizes a V8 `.cpuprofile` by package and function |
| `sessions.ts` | token baseline from Claude Code transcripts: context re-read per turn, device calls, images |

## Results

Host: Windows 11, x64, 16 threads. App: a large React Native app (Expo SDK 57, RN 0.86, Metro 0.84),
~4,000 modules in the main bundle, ~29,700 directories under the app root (~25,000 of them in
`node_modules`).

### Dev server (Metro through the Expo CLI)

| Run | Ready | First bundle | Repeat | Edit → bundle |
|---|---|---|---|---|
| cold cache | 47.8 s | 13.4 s | 3.7 s | 0.8 s |
| warm cache | 38.8 s | 2.6 s | 0.15 s | 1.7–1.9 s |
| warm, offline / no dependency validation | 39.7 s | 3.1 s | 0.15 s | — |
| bare Metro via API, warm | 1.1 s (HTTP) | 43.7 s | 0.2 s | 0.8 s |
| **warm, native recursive watcher** | **3.9 s** | **2.6 s** | **0.13 s** | **1.5–1.7 s** |

Dev bundle: 15.6 MB raw, 2.6 MB gzipped, downloaded in full on every cold start of the app.

**Finding: on Windows ~37 s of every Metro start is the file watcher.** A CPU profile of the start shows 85%
of the time inside the file map's fallback watcher: it walks every directory under the root and opens one
`fs.watch` handle per directory (29 s in `FSWatcher` alone), recompiling ignore patterns for each (4.4 s in
`picomatch`). The native watcher — one recursive `fs.watch` — is enabled only on macOS
(`isSupported() → platform() === 'darwin'`, both in `metro-file-map` and in Expo's fork
`@expo/metro-file-map`), although Node's recursive `fs.watch` is native on Windows as well. Allowing it on
`win32` cuts a warm start from 38.8 s to 3.9 s, and edits are still picked up. Neither the network
dependency check nor the transform cache matters at this scale; the bare Metro start only moves the same
wait from "ready" to "first bundle".

Implications for pitbox:

- the Metro adapter must run with a native recursive watcher on every platform (a watcher patch, or a file
  map of its own) — the single biggest dev-server win measured;
- "ready" is not a useful health signal: a server can answer HTTP while the file map is still being built.
  Health means a bundle request that completes;
- a 15.6 MB dev bundle on every cold start is worth the host-side bytecode and on-device cache.

### Device side of a cold start (Android emulator, x86_64, API 36)

Milestones from `logcat -v epoch`: the activity manager's `START`, React Native's bridgeless host
(`loadJSBundleFromMetro`, `Creating BundleLoader`, `Loading JS Bundle`) and the first `Running "main"`. Times
are from the launch intent.

| Build | Activity shown | Bundle in hand | JS starts running | JS evaluation |
|---|---|---|---|---|
| dev client, Metro just started | 1.9 s | 12.3 s (Metro building: 10.2 s) | 15.5 s | 3.0 s |
| dev client, Metro warm (2 runs) | 1.6–2.5 s | 2.4–2.9 s | **5.4–6.5 s** | 2.6–3.3 s |
| release build, bytecode embedded (3 runs) | — | 0.3–0.5 s | **0.59–0.76 s** | 0.2–0.34 s |

With a warm server the transfer itself is small (~0.5–0.9 s for 15.6 MB over a forwarded port); the
device-side cost of a dev start is **evaluating source instead of bytecode — about 10× slower** — plus the
dev client's own launcher. A start against a server that was just launched adds the whole graph build.

Implications for pitbox:

- verification passes should run on an embedded-bytecode build: ~0.7 s to running JS instead of
  5–6 s, on every relaunch of every pass;
- for the iteration loop, host-compiled bytecode cached on the device removes the 2.6–3.3 s evaluation;
- a dev server that was not kept warm costs another ~10 s per first launch.

The release build measured was an older build with R8 and no dev tooling, so it is an
upper bound on the gain rather than an exact one.

### Token baseline

33 Claude Code sessions that drove devices through an MCP automation server:

| Metric | Value |
|---|---|
| turns | 18,896 (median 277 per session) |
| device tool calls | 3,683 |
| images in results | 1,072 |
| context re-read per turn (average) | **405K tokens** |
| device tool response (average) | **141 tokens** |
| median peak context | 268K tokens |
| sessions that reached ~900K+ context | 6 |

A device action's response is ~0.03% of what the turn costs; the rest is the context it re-reads. Shrinking
responses is noise — removing turns (flows run by the daemon, macro tools, one-call expectations) and keeping
device work in small contexts is what moves the number.

## Still to measure in P0

- Rspack (Re.Pack) against Metro on the same app.

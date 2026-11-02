# bench — P0 measurements

Scripts that measure what pitbox is meant to improve. They run with Node 22+ directly (`node bench/x.ts`,
type stripping), with no dependencies.

| Script | Measures |
|---|---|
| `devserver.ts` | dev server: time to ready, first bundle, repeat request, edit-to-bundle; cold or warm cache in an isolated temp dir |
| `metro-raw.mjs` | starts Metro through its API with the project's config, to compare against the CLI that wraps it |
| `cpuprofile.ts` | summarizes a V8 `.cpuprofile` by package and function |
| `sessions.ts` | token baseline from Claude Code transcripts: context re-read per turn, device calls, images |
| `editloop.mjs` | edit → relaunch → time to running JS on an Android device, checking the new code ran |

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

### Rspack (Re.Pack 5.4, Rspack 2.3) against Metro

Same app and host, Re.Pack with `babel-swc-loader`, the Expo modules plugin and SVGR; the bundle built
without errors and inlined the same public environment values. It was not run on a device, so runtime
parity is not proven.

| Server | Cold: ready + first bundle | Warm: ready + first bundle | Edit → bundle | Bundle (raw / gzip) |
|---|---|---|---|---|
| Metro, stock watcher | 47.8 + 13.4 s | 38.8 + 2.6 s | 1.7–1.9 s | 15.6 / 2.6 MB |
| **Metro, native watcher** | **4.3 + 9.2 s** | **3.9 + 2.6 s** | 0.85–1.7 s | 15.6 / 2.6 MB |
| Rspack, memory cache only | 3.4 + 9.5 s | same as cold | 1.0 s | 16.8 / 2.4 MB |
| Rspack, persistent cache | 3.4 + 10.2 s | 3.4 + 3.0–3.3 s | 0.95 s | 16.8 / 2.4 MB |

**Finding: once the watcher is fixed, Metro and Rspack are even on this app** — ~13.5 s cold and ~6.5 s
warm for both, edits within a second or two. Rspack's speed on paper comes from transforms, and a warm
transform cache already makes them a minor part of the start. What remains is fixed cost in both: ~3.5 s of
server start and ~3 s of serializing a 4,000-module graph.

Implications for pitbox:

- the default React Native adapter is `metro` with a native watcher; `rspack` stays optional for projects
  that already use it — switching bundlers buys nothing measurable here and costs compatibility;
- the remaining ~6.5 s per server start is avoided by never restarting it: the daemon keeps it warm;
- serializing the whole graph on every first request (~2.6–3 s) is the next host-side target: keep the
  serialized bundle and its bytecode ready before the device asks.

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

### P2: pitbox's dev server against stock Metro

Same app, same emulator. pitbox runs the project's own `yarn start` on an internal port with the native
watcher enabled at runtime, its proxy on the device port, prewarming, and host-compiled Hermes bytecode for
the main bundle (`hermesc -O0`, ~5 s for 16 MB; lazily split bundles folded into the main one, since bytecode
cannot be `eval`-ed). `editloop.mjs` appends a marker log line to a startup module, relaunches the app and
times intent → `Running "main"`, checking that the marker (the new code) ran.

| | Stock Metro | pitbox |
|---|---|---|
| dev server ready, warm | 38.8 s | **5.4–6.0 s** |
| main bundle on the device's first request | built on request (2.6 s warm, ~10 s after a start) | prewarmed: **8–12 ms** from cache |
| JS evaluation on the device | 2.6–3.3 s (source) | **0.7–1.2 s** (bytecode) |
| relaunch, quiet host | 5.4–6.5 s | **3.1–3.7 s** |
| relaunch, loaded host, back to back | 16.6–16.9 s | **6.2–11.2 s** |
| relaunch right after an edit | 14.7–18.8 s ¹ | **6.6 s** (source served, bytecode compiling) |
| relaunch 8 s after an edit | 17.1–21.8 s ¹ | **3.8–4.6 s** (bytecode from cache) |

¹ measured after the pitbox runs, while another application loaded the host (~44% CPU); the stock server also
took 126 s to become ready then. The quiet-host rows are the cleaner comparison.

Rules that came out of it:

- **never slower than the bundler alone**: when the bytecode for the current code is not ready, the device gets
  the source at once and the compile finishes in the background for the next start;
- **only the native loader's request is converted** (`Accept: multipart/mixed`, no `modulesOnly`); a lazily
  loaded bundle evaluated with `eval` must stay source;
- **Expo writes absolute bundle URLs into its manifest**, so behind a proxy it needs
  `EXPO_PACKAGER_PROXY_URL` pointing at the proxy;
- **services must not depend on the daemon's console or pipes**: started attached, they died when the daemon
  restarted (Windows console close; EPIPE on the next log write) — now detached with logs written straight to
  files, covered by a test that runs a real daemon exit.

### P3: pitbox's own Android runner

An instrumentation APK (650 KB, no AndroidX) on `UiAutomation`, reached over `adb forward`, one persistent
connection. Same app, same emulator.

| | Value |
|---|---|
| tree on the device | ~50–150 ms (`uiautomator dump`: 1–3 s) |
| ping | 9 ms |
| press → settled → diff | 0.7–1.5 s, including waiting for late effects (a sheet that animates on the next frame) |
| home screen snapshot | 40 lines, ~1.5 KB (~430 tokens): buttons folded with their labels, children a control's description already carries dropped |
| a 14-step flow (cold start, search, typing, deep link route, a database check, back navigation) | **26.5 s, one call, a one-line verdict** |
| a recorded flow replayed (4 steps) | 5.5 s, selectors by id and text, no coordinates |

Done by hand by an agent, the same 14 steps are 14+ turns, each re-reading the whole context (~400K tokens
on average in the baseline below); in a flow they are one turn. A failing step comes back with its line, the
error, a screenshot path and the screen as text, so the next turn can act without another snapshot.

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

## Summary of P0

| Where the time goes | Today | With pitbox's approach |
|---|---|---|
| dev server start (Windows) | ~39 s warm, ~61 s cold | ~6.5 s once, then kept warm by the daemon |
| app cold start on a dev build | 5.4–6.5 s (15.5 s after a server restart) | ~0.7 s on an embedded-bytecode build for verification |
| agent turn during a device pass | ~405K tokens of context per action | turns removed by flows run in the daemon |

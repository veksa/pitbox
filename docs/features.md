# Features

What pitbox does, by area. Each tool is also described by the MCP server itself; the CLI prints the same
compact text.

## The stand

- **Services from a config.** Services start in dependency order and are health-checked; anything already
  answering its probe is adopted instead of started twice; logs go to files; services outlive agent sessions
  and daemon restarts, and only `down` stops them.
- **Actors** (extra users of the app), **project tools** (a protocol call, an SQL query) and an
  **OpenAI-compatible LLM mock** with forced replies, errors and delays.
- **Named states** — an emulator snapshot or a simulator app's data, plus the project's backend dump, restored
  in seconds.
- **Trace ids** — a `traceparent` on every request an action causes, and `trace` to read what the services
  logged for it.
- **Forwards that really work** — stand ports are forwarded to every device and re-forwarded when a device
  reconnects; when `adb reverse` lists its forwards but carries no data, emulators switch to a relay inside the
  runner through the emulator's host alias.

## Devices

- **Android** — phones, foldables, tablets, desktops, TV, XR headsets, AI glasses, watches and cars, emulators
  and hardware (a phone on Wi-Fi pairs from a QR code): boot, install, open apps and deep links, logs,
  settings, network conditions, screenshots, keys.
- **Apple simulators** — iPhone, foldable iPhone, iPad, Apple TV, Apple Watch and Vision Pro, through `simctl`
  and an XCUITest runner built on the Mac on first use. A Mac can serve its simulators to pitbox on another
  machine (`pitbox serve-devices`).
- **Web apps** — a browser through Playwright as one more device (`web:<name>`): the same snapshots,
  selectors, actions, checks and flows as on a phone, page errors reported with the action that caused them.
  One flow can switch between a web app and a phone.
- **What only some devices have** — fold and unfold a foldable (`posture`), rotate, run the app in a freeform
  window and resize it, a mouse (right click, hover, wheel) and keyboard shortcuts for tablets and desktops; a
  watch's crown, buttons, tiles, watch face and ambient state; an XR headset's view (turn, move, recenter) and
  panel controls; the temple touchpad of AI glasses; a car's day-night mode, driving restrictions and rotary
  controller; TV remote and media keys.

## UI automation

- **The screen as short lines with refs** (`@e3 button "Sign in"`), not a dump of the accessibility tree.
- **Actions that wait for the UI to settle** and answer with what changed. Exact gestures (double tap, swipe
  velocity), D-pad keys and focus for TV, a finger held across calls (inspect a scrubber mid-drag).
- **Taps that land** — the visible part of a covered target is tapped and what covers its centre is named; a
  keyboard over the target is closed first; system sheets that cover the app (permission requests, the save
  password offer) are named in snapshots and failed waits.
- **Fast on busy screens** — taps on a screen with a playing video take milliseconds (the platform's
  wait-for-animations is skipped).

## Checks instead of screenshots

- `media` — is the video playing, or black.
- `visual` — the screen against a baseline, changed regions in pixels, with masks.
- `focus_map` — D-pad reachability, traps and irreversible moves.
- `perf` — janky frames, frame-time percentiles, memory; the JS thread's profile (the functions that took the
  time, mapped to source lines); React's commits (which components rendered, their own time and why); the JS
  heap; and on Android the platform's trace (time per thread, the long slices and what took the time).
  Budgets in flows: `expect perf janky<5 js<300 renders:Row<=40`.
- `app_tree` — the React tree from inside the app.
- Crashes, ANRs and JS errors come back with the step they happened in; JS stacks are mapped to source files
  and lines by the bundler, bytecode included.

## Dev server

- **Your bundler behind pitbox's proxy** (`yarn start` as it is): a native file watcher on every platform
  (Metro crawls every directory on Windows otherwise), the main bundle built before the device asks, and, with
  `bytecode: true`, Hermes bytecode compiled on the host so the app skips parsing megabytes of source. Never
  slower than the bundler alone: while bytecode compiles, the device gets source.
- **Cold start, measured** — `open!` reports the activity, when the JS bundle started running and what it was
  served (bytecode or source, cached or not); a flow adds the time to its first check.
- **An embedded build** with the bundle inside, for a pass with no dev server.
- **No dev launcher needed** — the connect libraries point a debug build at the dev server from a link
  (`pitbox qr` puts it in a QR code for a phone, `open` uses it on emulators). On iOS and tvOS simulators no
  library is needed: `open` saves the dev server in the app's defaults (`RCT_jsLocation`) and passes it as
  launch arguments. See [install.md](install.md#connect-libraries).

## Inside the app, with no app code

For React Native dev bundles served through pitbox:

- `fresh` — whether the app runs the newest code (a new bundle or hot updates) or a stale bundle, and the
  compile error of an edit that broke the build. Hot updates keep working when the app runs host bytecode.
- **Network** — the app's request log; rules applied inside the app (fail, mock, delay, a WebSocket frozen
  open, offline); in-flight requests count toward "the UI has settled".
- **Console** — the app's console from its start, warnings and errors with the source line that logged them.
- **The JS runtime as tools**, through the bundler's debugger channel next to a person's DevTools: `js eval`
  runs an expression in the app (statements and promises fine, values as compact text); `js log <file:line>
  [expr…]` is a logpoint — the values each time the line runs, locals included, without stopping the app or
  editing code.

## Flows

A line-per-step script the daemon runs on its own (`open`, `goto <route>`, `as <user>`, `press`, `fill`,
`scroll … until`, `wait`, `expect`, `tool … contains`, …): one call, one verdict, and on failure the line, the
error and the screen. A flow can switch devices; `matrix` runs it over devices × font scales × themes ×
locales with full-size screenshots per variant (store screenshots). Sessions can be recorded into flows.
Reference: [flows.md](flows.md).

## Doctor and docs

- `doctor` — known failures with remedies (`doctor --fix`): a wedged adb, forwards that carry no data, a
  system dialog over the screen, a release build where a debug one is expected, settings left by an
  interrupted run. Projects add their own rules.
- `docs` — the lines of a long checklist or knowledge base that a step needs, not the whole file.

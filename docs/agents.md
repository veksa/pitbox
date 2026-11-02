# Using pitbox from an agent

pitbox is built so that an agent spends its tokens on decisions, not on driving taps. A turn costs the whole
context it re-reads, so the rules below are about doing fewer turns, not about shorter answers.

## Start of a session

1. `status` — what runs: services, the dev server, devices, forwarded ports.
2. `doctor` (and `doctor fix=true`) — known failures with remedies: a wedged adb, forwards that carry no data,
   a system dialog over the screen, a release build where a debug one is expected, settings left by an
   interrupted run. Run it before debugging anything odd.
3. `up`, then `boot` if no device is online. Forwards are applied (and repaired) by the daemon.

## Driving the app

- **A known path is a flow, not a sequence of turns.** `run` executes a `.flow` (or inline `steps`) in the
  daemon and answers with one verdict. On failure it gives the line, the error, crashes or ANRs that happened,
  a screenshot path and the screen as text — enough to act without another snapshot.
- **New screen → `snapshot` once; after that, actions answer with the diff.** Every action waits for the UI
  to settle (and for the app's network, when the dev server injects the in-app channel).
- **Selectors:** `@e12` from the last snapshot, `id=…` (testID), `text=…`, `label=…`, plain words, or `x,y`.
  Prefer ids: they survive copy changes and locales.
- **Jump, do not walk:** `goto <route>` opens a screen by deep link; `as <user>` signs in; `state restore`
  brings back a saved device + backend state in seconds.
- **Gestures:** `touch down/move/up` holds a finger across calls (inspect a scrubber while it is held);
  `swipe` takes a duration for velocity; `doubletap` is a real double tap.
- **TV:** `key up|down|left|right|center|back`, `focus`, and `focus_map` to audit D-pad reachability.

## Checking instead of looking

- `media` — is a video playing (motion between frames, not black), compared on the device.
- `visual <name>` — the screen against a stored baseline; changed regions in pixels, no image sent.
- `expect` in flows — presence, absence, focus, playing, paused.
- `fresh` — does the app run the newest code? Ask before debugging a fix that seems not to work.
- `app_network`, `app_tree` — the app's requests and its React tree from inside.
- `perf reset` → interact → `perf` — janky frames, frame-time percentiles, memory.
- Screenshots last: `ui_screenshot` (downscaled) only when text and checks are not enough.

## Network and backend

- `net fail|mock|delay|freeze|offline|clear` — rules applied inside the app (a WebSocket can be frozen open).
- Project tools from the config appear as `tool_<name>` (an SQL query, a protocol call, a seed script).
- `logs <service>` — the tail of a stand service's log, with `grep`.

## Variants

`matrix <flow>` runs a flow over the config's devices, font scales, themes and locales; screenshots
(`screenshot <name> full`) and visual baselines are kept per variant.

# Using pitbox from an agent

pitbox is built so that an agent spends its tokens on decisions, not on driving taps. A turn costs the whole
context it re-reads, so the rules below are about doing fewer turns, not about shorter answers. The MCP
server keeps its own footprint small: frequent actions have a tool each, rarer ones share a tool with an
`action`.

## Start of a session

1. `status` — services, the dev server, devices, forwarded ports.
2. `doctor` (`fix: true` applies remedies) — a wedged adb, forwards that carry no data, a system dialog over
   the screen, a release build where a debug one is expected, settings left by an interrupted run. Run it
   before debugging anything odd.
3. `stand action=up`, then `device action=boot avd=…` if no device is online. The daemon applies and repairs
   forwards on its own.

## Driving the app

- **A known path is a flow, not a sequence of turns.** `run flow=<name>` (or `steps`) executes in the daemon
  and answers with one verdict. On failure: the line, the error, crashes or ANRs, a screenshot path and the
  screen as text — enough to act without another snapshot.
- **New screen → `snapshot` once; after that, actions answer with the diff.** Every action waits for the UI to
  settle (and for the app's network, when the dev server injects the in-app channel).
- **Selectors:** `@e12` from the last snapshot, `id=…` (testID), `text=…`, `label=…`, plain words, or `x,y`.
  Prefer ids: they survive copy changes and locales.
- **Jump, do not walk:** `goto route=…` opens a screen by deep link; `as user=…` signs in;
  `state action=restore name=…` brings back a saved device + backend state in seconds.
- **Gestures:** `touch` holds a finger across calls (inspect a scrubber while it is held); `swipe` takes a
  duration for velocity, and with `until` scrolls to a target; `press kind=doubletap` is a real double tap.
- **Apple simulators:** the same tools. `device` takes a simulator name or udid, `install` a `.app` from a
  simulator build. The first UI call builds and starts the XCUITest runner (about 15 s once, then cached).
  XCUITest cannot hold a finger between calls (`touch`), and `network`, `perf`, display size and animations
  are reported as unsupported. Apple TV has no touch: drive it with `key`. On iPhone and iPad simulators
  `rotate` turns the device (an error when the app stays as it was), and iPad takes `press kind=right|hover`,
  `swipe via=wheel` and `key keys=["meta+k"]`; the watch takes `swipe via=rotary`. A foldable iPhone reports
  which screen is lit in `device action=info` (`fold: folded: cover screen …`) and screenshots that screen; it
  cannot be folded from outside Xcode, so `posture` and `window` stay Android-only.
- **TV:** `key` with up/down/left/right/center/back and remote keys (play, next, channel_up, guide…);
  `inspect what=focus`; `inspect what=focus_map` audits D-pad reachability.
- **Foldables, tablets, desktops:** `device action=posture value=closed|half|open|reset`, `device action=rotate
  value=90|auto`, `device action=window value="freeform 0,0,900,1300"`; a mouse through `press kind=right|hover`
  and `swipe via=wheel`; shortcuts as `key keys=["ctrl+c"]`.
- **Watches:** `swipe via=rotary direction=down steps=5` turns the crown; `swipe direction=right` is the
  system back gesture.

## Checking instead of looking

- `inspect what=media target=…` — is a video playing (motion between frames, not black).
- `inspect what=visual name=…` — the screen against a stored baseline; changed regions in pixels.
- `expect` in flows — presence, absence, focus, playing, paused, `visual`.
- `dev action=fresh` — does the app run the newest code? Ask before debugging a fix that seems not to work.
- `inspect what=network`, `inspect what=tree` — the app's requests and its React tree, from inside.
- `inspect what=errors` — recent JS errors with source stacks (`src/file.ts:31:39` and the line itself), also
  the ones thrown at startup before any action. Errors during an action or a flow come back with it anyway.
- `inspect what=perf reset=true` → interact → `inspect what=perf` — janky frames, frame times, memory.
- `app action=open relaunch=true` answers with the cold start: activity, when the JS started running, and the
  bundle it got (bytecode or source, size, cached). In a flow, `open!` adds the time to the first check.
- Screenshots last: `inspect what=screenshot` (downscaled) only when text and checks are not enough.

## Network and backend

- `net action=fail|mock|delay|freeze|offline|clear` — rules applied inside the app (a WebSocket can be frozen
  open).
- Project tools from the config appear as `tool_<name>` (an SQL query, a protocol call, a seed script).
- `stand action=logs name=<service>` — the tail of a stand service's log, with `grep`.

## Variants

`run flow=<name> matrix=true` runs a flow over the config's devices, font scales, themes and locales;
screenshots (`screenshot <name> full`) and visual baselines are kept per variant.

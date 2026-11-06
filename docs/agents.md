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
3. `stand action=up`, then `device action=boot avd=…` if no device is online. A phone on Wi-Fi (Android 11+):
   `device action=pair` answers a QR (an image path) for the person to scan in Developer options → Wireless
   debugging → Pair device with QR code, then `device action=pair value=wait` connects it; or
   `value="<ip:port> <code>"` from its Pair device with pairing code screen. The daemon applies and repairs
   forwards on its own.

## Driving the app

- **A known path is a flow, not a sequence of turns.** `run flow=<name>` (or `steps`) executes in the daemon
  and answers with one verdict. On failure: the line, the error, crashes or ANRs, a screenshot path and the
  screen as text — enough to act without another snapshot.
- **New screen → `snapshot` once; after that, actions answer with the diff.** Every action waits for the UI to
  settle (and for the app's network, when the dev server injects the in-app channel). A press whose target has
  something painted over its centre (a floating button, an overlay) taps an uncovered part of it and says so in a
  `note`; a permission request over the app is named in the error of a selector that finds nothing.
- **Selectors:** `@e12` from the last snapshot, `id=…` (testID), `text=…` (the string a line quotes), `label=…`,
  plain words, or `x,y`.
  Prefer ids: they survive copy changes and locales.
- **Jump, do not walk:** `goto route=…` opens a screen by deep link; `as user=…` signs in;
  `state action=restore name=…` brings back a saved device + backend state in seconds.
- **Gestures:** `touch` holds a finger across calls (inspect a scrubber while it is held); `swipe` takes a
  duration for velocity, and with `until` scrolls to a target; `press kind=doubletap` is a real double tap.
- **Apple simulators:** the same tools. `device` takes a simulator name or udid, `install` a `.app` from a
  simulator build. The first UI call builds and starts the XCUITest runner (about 15 s once, then cached).
  XCUITest cannot hold a finger between calls (`touch`), and `network`, `perf`, display size and animations
  are reported as unsupported. iOS has no back key: `key back` does what a person does instead — presses the
  navigation bar's back button, or swipes in from the left edge when there is none — and its note says which.
  Apple TV has no touch: drive it with `key`. On iPhone and iPad simulators
  `rotate` turns the device (an error when the app stays as it was), and iPad takes `press kind=right|hover`,
  `swipe via=wheel` and `key keys=["meta+k"]`; the watch takes `swipe via=rotary`. A foldable iPhone poses
  as in Xcode's device window: `device action=posture value=closed|half|open|<degrees> [fast|medium|slow]`
  swings the hinge and the app moves between the screens, `value=swap` changes the lit screen at once (motion
  then waits about ten seconds), `rotate` turns the whole phone, 180 upside down. `device action=info` names the
  lit screen (`fold: folded: cover screen …`) and screenshots are of it; `window` stays Android-only.
- **TV:** `key` with up/down/left/right/center/back and remote keys (play, next, channel_up, guide…);
  `inspect what=focus`; `inspect what=focus_map` audits D-pad reachability.
- **Foldables, tablets, desktops:** `device action=posture value=closed|half|open|reset`, `device action=rotate
  value=90|auto`, `device action=window value="freeform 0,0,900,1300"`; a mouse through `press kind=right|hover`
  and `swipe via=wheel`; shortcuts as `key keys=["ctrl+c"]`.
- **Watches:** `swipe via=rotary direction=down steps=5` turns the crown; `swipe direction=right` is the
  system back gesture; `device action=wear value="tile show <component>"`, `value="face <package>"`,
  `value="ambient on"`, `value=home`.
- **XR headsets:** `device action=xr value="look 30"` turns the view (emulator), `value=recenter` brings it back,
  `value="panel minimize"` (or close, menu, tidy, info, spatial-audio, close-app) uses the panel's own controls.
- **Glasses:** `touchpad gesture=down|up|forward|back|tap` — the temple touchpad moves focus and presses.
- **Cars:** `device action=car value=night`, `value="drive 20"` (apps not made for driving get blocked),
  `value=park`, `value="rotary cw"`.

## Writing and fixing flows

- **Write a flow while walking the path.** An action given a ref or plain words answers with the step a flow
  would use (`step: press id=sign-in`); copy those lines into the flow file. An action given a selector that is
  already a step prints none.
- **A selector that misses names what is there instead:** `nothing matches "id=apply" — closest: @e31 button
  "Apply code" #apply-code → id=apply-code`. On a Compose screen with no ids at all it says that Compose hides its
  test tags until a root sets `testTagsAsResourceId`.
- **A broken flow comes back with `fix?`** — the failed line with the closest control's selector, when one stands
  out. Check it on the screen the flow stopped at (its refs are live), patch the file, and go on with
  `run flow=… from=<line>` instead of running the flow from the start. Never take a fix without looking: a
  renamed control and a missing feature fail the same way.
- **`no change on screen` in a passing run's notes** marks a press that did nothing visible. Follow each press
  that matters with an `expect` of its outcome.

## Checking instead of looking

- `inspect what=media target=…` — is a video playing (motion between frames, not black).
- `inspect what=visual name=…` — the screen against a stored baseline; changed regions in pixels.
- `expect` in flows — presence, absence, focus, playing, paused, `visual`.
- `dev action=embed` — a verification build with no dev server in the loop: the bundle from the running bundler
  into the app's sources (bytecode when possible), then the configured build. Install it, stop the dev server
  (`stand action=down services=["devserver"]`), and the app runs its own bundle against the stand.
- `dev action=fresh` — does the app run the newest code? Ask before debugging a fix that seems not to work.
  It waits for edits to settle, counts edits that reached the app as hot updates (no reload needed), and when
  the last edit did not compile it says so with the bundler's error and code frame — the app still runs the
  code before it.
- `inspect what=network`, `inspect what=tree` — the app's requests and its React tree, from inside.
- `inspect what=errors` — recent JS errors with source stacks (`src/file.ts:31:39` and the line itself), also
  the ones thrown at startup before any action. Errors during an action or a flow come back with it anyway.
- `inspect what=console level=warn` — the app's console since it started (the newest 300 entries), filtered
  by level and `grep`; each warning and error points at the line that logged it (`← greet  App.tsx:20:35`).
- `inspect what=perf reset=true` → interact → `inspect what=perf` — janky frames, frame times, memory, and
  with a dev server the JS thread over the same window: how busy it was, the functions that took the time
  themselves, and the app's own functions with what they called (`workHard  App.tsx:14`); and React's commits:
  which components rendered how often, their own time, and why (`Button — props onPress ×4`: a new function
  each render; `parent rendered, same props`: a `memo` would skip it); and the JS heap: live bytes before and
  after, bytes allocated, collections. Live bytes depend on when the collector last ran, so a leak shows as a
  trend over repeats of a step, not in one window. About 25 lines. `trace=true` on the reset adds the
  platform's trace (Android, atrace): time per app thread and the long slices grouped by kind, with what took
  the time inside (`Choreographer#doFrame > traversal > draw`), about 8 more lines. It slows the device a
  little while it runs, so it is opt-in.
  Sampling is ~10 ms, so measure an interaction that takes longer than a few samples.
- `app action=open relaunch=true` answers with the cold start: activity, when the JS started running, and the
  bundle it got (bytecode or source, size, cached). In a flow, `open!` adds the time to the first check.
- `js action=eval expr=…` — read the app's state from inside (a store, a module's export, a feature flag);
  promises are awaited, and `await` works at the top. `js action=log at=src/Home.tsx:42 exprs=["user.id","items.length"]` → interact →
  `js action=hits` — what the line saw each time it ran, without editing code or a rebuild; one failing
  expression does not hide the others. `js action=clear` when done. The first logpoint reloads an app that runs
  bytecode (the runtime needs source to read locals), so set it before reaching the screen you care about.
- Screenshots last: `inspect what=screenshot` (downscaled) only when text and checks are not enough.

## Web apps

`device: "web:<name>"` (from `web` in the config) drives a web app in a browser with the same tools: `snapshot`,
`press`, `fill`, `wait`, `swipe` (scrolls), `key` (`back` is the history), `inspect what=visual|screenshot`,
`run` with flows. Give the page `data-testid`s the way an app gets `testID`s: they become `id=` selectors. A flow
can mix devices — `device web:admin` … `device Pixel_8` — to act in a panel and check the phone.

## Mac apps

`device: "mac:<name>"` (from `mac` in the config; `mac` alone with one app) drives a native app on this Mac with the
same tools: `snapshot`, `press`, `fill`, `type`, `key` (`meta+k` is ⌘K), `swipe` and `scroll … until` (they scroll
what is under the pointer), `mouse right|hover|wheel`, `wait`, `inspect what=screenshot|visual|media`, `app
action=open|stop|logs`, and `run` with flows; a crash comes back with its step. Web views (WKWebView) come in the same
tree as native controls, with the page's `id`s as `id=` selectors.

- **One window at a time.** A snapshot covers the app's window in front, with its sheets; points are from that
  window's top left, and screenshots are of it alone. An open menu comes first (`— menu`), the app's items in the
  menu bar after (`— menu bar`: press one to open its menu, then its item), and the app's other windows last, one
  line each (`— other windows`): pressing one brings it to the front. `device action=window value="Settings"` (a
  title, part of one, or `#2`) keeps snapshots and input on that window whatever is in front; `value=front` goes
  back to following the front one, and no value lists the windows. In a flow: `window "Settings"`.
- **Input goes to the app only.** Before each action the app is brought to the front; if it does not come (a modal
  panel of another app, a full-screen app), the action fails and nothing is sent — a person's terminal in front never
  gets the keys. Keys and text are posted to the app's process; a click lands only where the window under the point
  is the app's. Text goes in as characters whatever the keyboard layout, and through the pasteboard when a field
  does not take it that way; keys go by their place on the keyboard, so shortcuts work on a Cyrillic layout too.
- **Permissions** belong to the app that started pitbox: Accessibility (everything) and Screen Recording (images).
  `doctor` names that app and where to turn each on; a call without them fails at once with the same hint.
- Not on a Mac: `install`, `app action=clear` (the app keeps its data where it chooses), `settings`, `network`,
  `touch`, rotation.

## Network and backend

- `net action=fail|mock|delay|freeze|offline|clear` — rules applied inside the app (a WebSocket can be frozen
  open).
- Project tools from the config appear as `tool_<name>` (an SQL query, a protocol call, a seed script).
- `stand action=logs name=<service>` — the tail of a stand service's log, with `grep`.
- `llm` (with `mocks.llm` in the config) — the LLM mock: `action=log` shows each request's prompt and where its
  reply came from; `reply text=…`, `fail status=429`, `delay ms=…` force an answer, a provider error or a slow
  answer for prompts matching `match` (or all; `once=true` for one request); `clear` drops the rules. Tests the
  paths around a model without editing fixtures.
- `trace` — what the backend did for the last action (or `id=`, an action's `trace` in its JSON answer): every action stamps
  one W3C trace id on the app's requests, and this finds it in all stand services' and actors' logs. The
  backend has to log the trace id of the `traceparent` header for it to be found.

## Variants

`run flow=<name> matrix=true` runs a flow over the config's devices, font scales, themes and locales;
screenshots (`screenshot <name> full`) and visual baselines are kept per variant.

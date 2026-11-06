# Flows

A flow is a plain text file, one step per line, that the pitbox daemon runs on its own. The caller makes one
call and gets one verdict: `✓ flow passed: N steps in T`, or the failing line with the error, any crashes,
ANRs or JS errors (with source stacks), a screenshot path and the screen as text. A flow that passes still
lists the JS errors the app threw on the way.

```
# Cold start, search, a card by deep link, a database check.
open!
wait id=home-screen 40
press id=search
fill id=search-input "lamp"
wait text~=lamp 10
key back
goto product id=4
wait id=product-screen 15
tool sql query="select title from products where id = 4" contains "Desk lamp"
```

Files live in the `flows` directory of the project (`flows` in the config) and are run by name:

```sh
pitbox run smoke                     # flows/smoke.flow
pitbox run checkout user=buyer       # with parameters: ${user} in the steps
pitbox run --steps "open
wait id=home"                        # inline, no file
pitbox run smoke --device Pixel_8    # on a given device
```

Over MCP: `run` with `flow`, `steps`, `params`, `device`, `from`; `matrix: true` runs it once per variant (see
[config](config.md#matrix)).

## When a flow breaks

A step whose selector matches nothing fails with the controls on screen that look most like what it asked for,
and, when one of them stands out, the step rewritten for it:

```
✗ flow failed at line 7: press id=apply
  nothing matches "id=apply" — closest: @e31 button "Apply code" #apply-code → id=apply-code
  fix? line 7: press id=apply-code
```

The fix is offered only when its selector finds that control on the failed screen, and it is a suggestion, never
applied: a step only ever acts on the control it names. The failed screen stays
as it was and its refs are live, so the step can be tried there (`press @e31`), the file patched, and the rest of
the flow run from the broken line with `pitbox run checkout --from 7` (MCP: `from: 7`). A `press` that passed but
changed nothing on screen is named in the notes of the run: it may have passed the wrong way.

## Syntax

- One step per line; blank lines and lines starting with `#` are ignored.
- Tokens are separated by spaces. Quotes keep spaces together: `fill id=email "a b@example.test"`. A quote
  inside a selector stays part of it: `press text="Get started"`.
- `${name}` anywhere is replaced by a run parameter; a missing parameter fails before the first step.
- The whole file is checked before it runs: an unknown step or a missing argument fails with its line number,
  not half-way through.

## Selectors

Steps that act on the screen take a selector:

| Selector | Matches |
|---|---|
| `id=start` | the node with this id (a React Native `testID`, an Android resource id) |
| `text=Get started` · `text~=Get` | exact text (case-insensitive) · text containing; the quoted string of a line, so a control with no text matches by its label |
| `label=Close` · `label~=Clo` | accessibility label (content description), exact · containing |
| `Get started` | plain words: id, text or label, exact first, then containing |
| `540,1200` | a point in screen pixels |
| `@e12` | a ref from the last snapshot (interactive use; flows should not rely on refs) |

When several nodes match, a node of an alert or a sheet on top wins (whatever matches behind it cannot be tapped),
then interactive ones, then reading order. Prefer `id=`: ids survive copy changes and
locales.

## Steps

### App and navigation

| Step | Does |
|---|---|
| `open` | launches the app — through its connect link when there is one (`app.connect` in the config), so it always talks to this dev server |
| `open!` | the same after force-stopping the app (a cold start). The verdict gets a note: `cold start: activity 640 ms · JS running at 2.9s · wait id=home at 4.1s` — the activity, the moment the dev bundle started running, and the first `wait`/`expect` after it |
| `open <url\|package>` · `open! <url\|package>` | opens a deep link or another package |
| `goto <route> key=value…` | opens a route from the config (`routes`), parameters URL-encoded: `goto item id=42` |
| `as <user>` | runs the config's `signIn` flow with `${user}` |
| `device <serial\|avd\|web:app>` | runs the following steps on another device — a web app from the config included, so one flow can act in an admin panel and check the phone |
| `state <name>` | restores a named stand state (emulator snapshot + backend dump) |
| `run <flow> key=value…` | runs another flow file with parameters (nesting up to 5 deep) |
| `posture closed|half|open|rear|reset` | folds or unfolds a foldable through the platform's device state service (real devices too); `reset` hands it back to the hinge. The keyguard Android puts up on the outer screen when it folds ("swipe up to continue") is dismissed, so the app stays in front. A foldable iPhone simulator takes `closed|half|open|<degrees> [fast|medium|slow]`, swinging the hinge as Xcode's device window does, and `swap`, which changes the lit screen at once and holds motion for about ten seconds |
| `rotate 0|90|180|270|auto` | locks the screen's rotation; `auto` gives it back to the sensor. On iPhone and iPad simulators it turns the device, and fails when the app stays as it was (a portrait-only app); a foldable iPhone turns as a whole, Xcode's device window too |
| `wear tile show|add|remove <component>` · `wear face <package|component>` · `wear ambient on|off` · `wear home` | a watch: a tile in the carousel (shown, added, removed), the current watch face (a Watch Face Format package; faces with code no longer run on current Wear OS), the ambient state (always-on display enabled), the watch face itself (the home key toggles face and app list) |
| `xr look yaw[,pitch[,roll]]` · `xr move dx,dy,dz` · `xr recenter` | an XR emulator's view: turns the head by degrees (turns add up), moves it by metres, recenters — through the emulator's control channel. Input reaches the app's panel whatever the pose: taps go to the panel, not along the gaze |
| `xr panel minimize|close|menu|info|spatial-audio|tidy|close-app` | an XR headset: the controls of the app's panel — its caption and the caption's menu |
| `xr spin yaw,pitch,roll[,ms]` · `xr drift dx,dy,dz[,ms]` | an XR emulator's head in motion: turning at degrees a second or moving at metres a second for `ms` (default 1000), then still — what the app sees during a turn or a step |
| `xr env day|night` · `xr passthrough 0…1` · `xr options` | an XR emulator's surroundings: the living room by day or by night, how much of it shows through, the current setting |
| `car day|night|auto` · `car drive [m/s]` · `car park` · `car rotary cw|ccw [n]` | a car: the cabin's day-night mode, driving (the system blocks apps not made for it, as in a moving car), parking, the rotary controller |
| `window freeform [x,y,w,h]` · `window resize x,y,w,h` · `window fullscreen` | the app as a desktop-style window, resized, or fullscreen again (switching mode relaunches the app; freeform windows stay enabled in the device's settings) |

### Acting

Every action waits for the UI to settle before the next step.

| Step | Does |
|---|---|
| `press <selector>` | taps the centre of the target |
| `longpress <selector>` | holds for 800 ms |
| `doubletap <selector>` | two taps 90 ms apart (a real double tap) |
| `fill <selector> "text"` | taps the field and replaces its text |
| `type "text"` | appends text to the focused field |
| `key <key>…` | presses keys in order (`back` on iOS, which has no back key: the navigation bar's back button, or a swipe in from the left edge): `back home up down left right center enter del menu search`, keyboard keys (`tab space escape page_up page_down`), media and TV remote keys (`play pause playpause next previous rewind fast_forward volume_up volume_down mute channel_up channel_down guide info captions settings`), watch buttons (`stem_primary stem_1 stem_2`), combinations (`ctrl+c`, `ctrl+shift+tab`, `alt+f4`), or a keycode number |
| `swipe up\|down\|left\|right [ms]` | swipes across the screen; the duration (default 300 ms) sets the velocity |
| `swipe x1,y1,x2,y2 [ms]` | swipes between two points |
| `scroll <direction> until <selector>` | swipes until the target is on screen (stops when the content stops moving, at most 25 swipes) |
| `touch down <selector>` · `touch move <selector>` · `touch up` | a finger held across steps — check what exists only while touching |
| `mouse right <selector>` · `mouse hover <selector>` | a mouse: right click (context menus), pointer over the target (hover states) — tablets, desktops, headsets |
| `mouse wheel up|down [steps] [selector]` | turns the wheel `steps` notches (default 3) over the target or the app's scroller |
| `touchpad forward|back|up|down|tap` | the temple touchpad of AI glasses: swipes move the focus as D-pad keys would, a tap presses the focused control |
| `rotary up|down [steps]` | a watch crown or bezel; the events go to the focused view, so a scroller that never takes focus does not move (the answer says so) |
| `sleep <ms>` | waits; prefer `wait` |

### Checking

| Step | Passes when |
|---|---|
| `wait <selector> [seconds]` | the target appears (default 10 s) |
| `press? <selector> [seconds]` | presses the target if it shows within the seconds (default 3), goes on otherwise: a sheet that comes only sometimes (a permission prompt, a one-time tip). iOS's "Save Password?" after a sign-in needs no step: pitbox declines it with Not Now and says so in the press's note. Neither does React Native's warnings toast in a debug build: when it covers the target (a tab bar), pitbox closes it first |
| `wait gone <selector> [seconds]` | the target disappears |
| `expect <selector>` | the target is there now or within 5 s |
| `expect gone <selector>` | the target is gone now or within 5 s |
| `expect focus <selector>` | the target has input focus (TV, keyboard) |
| `expect playing [selector]` | the region (or screen) moves between frames and is not black; tried a few times while a player starts |
| `expect paused [selector]` | nothing moves in the region |
| `visual <name> [mask <selector>]…` | the screen matches the stored baseline `<name>`; the first run stores it. Masked targets (a video, a clock) are blanked on both sides |
| `perf [trace]` | always passes; starts measuring frames, the JS thread, React commits and the JS heap; `trace` adds the platform's trace (Android) |
| `expect perf <budget>…` | every budget holds over the window since `perf`, like `janky<5 p90<=20ms js<300 commits<=3 rendering<16 heap<2 allocated<20 renders:Row<=40`, and with `perf trace` `slice<16` (the longest slice on the app's main thread). Units: `%` (janky), ms (`s` converts), MB (memory, heap growth, allocated). A metric this device or app cannot measure fails the step. On failure the step shows the broken budgets and the whole perf report |
| `tool <name> key=value… [contains "text"]` | the project tool exits with 0 (and its output contains the text) |
| `screenshot [name] [full]` | always passes; saves a downscaled JPEG, or a full-resolution PNG with `full` (store screenshots). Under `matrix` the file goes into the variant's folder |

## Recording

```sh
pitbox record start
# … press, fill, swipe, key, goto as usual …
pitbox record stop checkout          # saves flows/checkout.flow
```

Recorded steps use `id=`, then unique `text=`, then `label=`; coordinates only when nothing else identifies the
node. Each press is followed by the check that proves it worked: a control that appeared (`expect id=receipt`),
or, when nothing appeared, one that went away (`expect gone text="Enter a code"`) — ids first, never a text with
digits in it (a count or a time differs next run), never the keyboard. So a replayed press that no longer has its
effect fails at once instead of at a later step. Without recording, an action given a ref, plain words or a point
answers with the step that repeats it and that check (`step: press id=sign-in` / `expect id=home`), so a flow can
be written from the actions that just worked.

## Examples

A player that must play, and a scrubber that shows the time while held:

```
goto item id=1
expect playing id=player
press id=player
touch down 200,2200
touch move 1000,2200
expect id=player-time
touch up
expect gone id=player-time
```

Two devices in one flow — an author publishes, a viewer sees it:

```
device author_phone
as author
goto new-post
fill id=title "Draft"
press id=publish
device tv_1080p
as viewer
wait text=Draft 30
```

Starting from a known state instead of building it:

```
state signed-in-with-order
goto item id=7
expect gone id=paywall
```

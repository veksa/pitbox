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

Over MCP: `run` with `flow`, `steps`, `params`, `device`; `matrix: true` runs it once per variant (see
[config](config.md#matrix)).

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
| `text=Get started` · `text~=Get` | exact text (case-insensitive) · text containing |
| `label=Close` · `label~=Clo` | accessibility label (content description), exact · containing |
| `Get started` | plain words: id, text or label, exact first, then containing |
| `540,1200` | a point in screen pixels |
| `@e12` | a ref from the last snapshot (interactive use; flows should not rely on refs) |

When several nodes match, interactive ones win, then reading order. Prefer `id=`: ids survive copy changes and
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
| `device <serial\|avd>` | runs the following steps on another device |
| `state <name>` | restores a named stand state (emulator snapshot + backend dump) |
| `run <flow> key=value…` | runs another flow file with parameters (nesting up to 5 deep) |
| `posture closed|half|open|rear|reset` | folds or unfolds a foldable through the platform's device state service (real devices too); `reset` hands it back to the hinge |
| `rotate 0|90|180|270|auto` | locks the screen's rotation; `auto` gives it back to the sensor. On iPhone and iPad simulators it turns the device, and fails when the app stays as it was (a folded phone's cover screen, a portrait-only app) |
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
| `key <key>…` | presses keys in order: `back home up down left right center enter del menu search`, keyboard keys (`tab space escape page_up page_down`), media and TV remote keys (`play pause playpause next previous rewind fast_forward volume_up volume_down mute channel_up channel_down guide info captions settings`), watch buttons (`stem_primary stem_1 stem_2`), combinations (`ctrl+c`, `ctrl+shift+tab`, `alt+f4`), or a keycode number |
| `swipe up\|down\|left\|right [ms]` | swipes across the screen; the duration (default 300 ms) sets the velocity |
| `swipe x1,y1,x2,y2 [ms]` | swipes between two points |
| `scroll <direction> until <selector>` | swipes until the target is on screen (stops when the content stops moving, at most 25 swipes) |
| `touch down <selector>` · `touch move <selector>` · `touch up` | a finger held across steps — check what exists only while touching |
| `mouse right <selector>` · `mouse hover <selector>` | a mouse: right click (context menus), pointer over the target (hover states) — tablets, desktops, headsets |
| `mouse wheel up|down [steps] [selector]` | turns the wheel `steps` notches (default 3) over the target or the app's scroller |
| `rotary up|down [steps]` | a watch crown or bezel; the events go to the focused view, so a scroller that never takes focus does not move (the answer says so) |
| `sleep <ms>` | waits; prefer `wait` |

### Checking

| Step | Passes when |
|---|---|
| `wait <selector> [seconds]` | the target appears (default 10 s) |
| `wait gone <selector> [seconds]` | the target disappears |
| `expect <selector>` | the target is there now or within 5 s |
| `expect gone <selector>` | the target is gone now or within 5 s |
| `expect focus <selector>` | the target has input focus (TV, keyboard) |
| `expect playing [selector]` | the region (or screen) moves between frames and is not black; tried a few times while a player starts |
| `expect paused [selector]` | nothing moves in the region |
| `visual <name> [mask <selector>]…` | the screen matches the stored baseline `<name>`; the first run stores it. Masked targets (a video, a clock) are blanked on both sides |
| `tool <name> key=value… [contains "text"]` | the project tool exits with 0 (and its output contains the text) |
| `screenshot [name] [full]` | always passes; saves a downscaled JPEG, or a full-resolution PNG with `full` (store screenshots). Under `matrix` the file goes into the variant's folder |

## Recording

```sh
pitbox record start
# … press, fill, swipe, key, goto as usual …
pitbox record stop checkout          # saves flows/checkout.flow
```

Recorded steps use `id=`, then unique `text=`, then `label=`; coordinates only when nothing else identifies the
node.

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

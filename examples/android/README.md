# Android example

A small native app (no framework, no AndroidX) that pitbox's own end-to-end run drives on every kind of Android
device — phones, foldables, tablets, desktops, TVs (it has a TV launcher entry and needs no touchscreen), XR
headsets, AI glasses, watches and cars — plus two watch-only pieces: `wear/` (a tile, a complication data source,
an ambient-aware screen; AndroidX) and `wearface/` (a Watch Face Format face, resources only, whose complication
slot defaults to the example's data source).

What it has: a text field and a button that greets, a button that asks the stand (`../stand/server.mjs` on port
4100, forwarded to the device), a button that crashes, forty rows below the fold, and a second screen behind the
deep link `pitboxexample://detail/<id>`.

| Flow | Runs on | Checks |
|---|---|---|
| `smoke` | phone, foldable, tablet, desktop, XR, glasses, car | input, the stand over forwarded ports, a project tool, scrolling to a target, a deep link, back |
| `tv` | TV | D-pad focus and center presses, the focus walk |
| `wear` | watch | the same on a round screen a few rows tall, then the crown |
| `watch` | watch | a tile shown and removed, the pitbox face set and its complication served, ambient on and off |
| `xr` | XR | the view turned and recentered, the panel's menu, tidy up, minimise and back |
| `xr-poses` | XR | taps, hover, text and the wheel with the head turned away, tilted, upside down, walked off and moving |
| `xr-panel` | XR | every panel control: spatial audio, app info, tidy up, close the panel, close the app |
| `xr-world` | XR | the surroundings by night and by day, the room showing through and not |
| `glasses` | glasses | the temple touchpad moves the focus and presses |
| `car` | car | night and day, driving blocks the app, parking brings it back |
| `rotate` | phone, tablet | the layout follows a turn, the sensor takes over again |
| `fold` | foldable | the app follows the hinge from the outer screen to the inner one |
| `mouse` | foldable, tablet, desktop, XR | hover, a context menu on a right click, the wheel |
| `window` | foldable, tablet, desktop | a freeform window, resized, fullscreen again |
| `crash` | phone | fails on purpose: the crash comes back with the step and the stack |
| `sign-in` | phone | what `as <user>` runs: the user's name typed and greeted |
| `matrix` | phone | run by `matrix` over the config's font scales and dark modes |

On a phone the run also checks the commands around flows (`scripts/e2e-features.mjs`): settings, the network,
app lifecycle, snapshots, screenshots, visual baselines, media, recording, named states, the matrix, `as`, the
LLM mock, actors, the stand's logs, doctor, docs and the MCP server.

```sh
yarn build && yarn e2e                       # every kind that has an AVD on this machine
PITBOX_E2E_KINDS=phone,tv yarn e2e
PITBOX_E2E_AVD_TV=My_TV yarn e2e             # a given AVD for a kind
```

The run builds the APK with Gradle (a JDK and the Android SDK are needed), boots one AVD per kind, installs,
runs the kind's flows through the CLI and shuts down what it booted. A device that was already running is left
running. By hand, from this directory: `pitbox up`, `pitbox install app/build/outputs/apk/debug/app-debug.apk`,
`pitbox run smoke`.

AVDs are picked by kind from their config: a watch from a Wear OS image, a car from an Automotive image, glasses
from the AI glasses image, a tablet by a short side of 600 dp or more, a desktop from a `desktop_*` profile.

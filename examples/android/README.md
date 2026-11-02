# Android example

A small native app (no framework, no AndroidX) that pitbox's own end-to-end run drives on every kind of Android
device: one APK for phones, foldables, tablets, TVs (it has a TV launcher entry and needs no touchscreen), XR
headsets and watches, all run end to end; desktop, glasses and car AVDs get the smoke flow too, once there is one.

What it has: a text field and a button that greets, a button that asks the stand (`stand/server.mjs` on port
4100, forwarded to the device), a button that crashes, forty rows below the fold, and a second screen behind the
deep link `pitboxexample://detail/<id>`.

| Flow | Runs on | Checks |
|---|---|---|
| `smoke` | phone, foldable, tablet, desktop, XR, glasses, car | input, the stand over forwarded ports, a project tool, scrolling to a target, a deep link, back |
| `tv` | TV | D-pad focus and center presses, the focus walk |
| `wear` | watch | the same on a round screen a few rows tall |
| `crash` | phone | fails on purpose: the crash comes back with the step and the stack |

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

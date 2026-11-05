# Apple example

A SwiftUI app that pitbox's own end-to-end run (`yarn e2e:apple`) drives on every kind of Apple simulator —
iPhone, foldable iPhone, iPad, Apple TV, Apple Watch (`Watch/`) and Vision Pro. It has what the Android example
has: a text field and a button that greets, a button that asks the stand (`stand/server.mjs` on port 4100; a
simulator shares the Mac's network), a button that crashes, forty rows below the fold and a second screen behind
`pitboxexample://detail/<id>`. On iPhone and iPad it also has an alert over a button of the same name and a
navigation stack with a pushed screen. On visionOS it adds a second window, an ornament and an immersive space with a box
that names itself for accessibility.

| Flow | Runs on | Checks |
|---|---|---|
| `smoke` | iPhone, foldable, iPad, Vision Pro | input, the stand, a project tool, scrolling, a deep link and its question |
| `rotate` | iPhone, iPad | the layout follows a turn |
| `modal` | iPhone, iPad | an alert's button over the same text behind it, `key back` on a pushed screen |
| `permission` | iPhone | the system's camera request over the app, answered by its button's id |
| `fold` | foldable | the hinge's poses, turns and the lit screen |
| `pointer` | iPad | the pointer's hover, a context menu, the wheel, ⌘ shortcuts |
| `tv` | Apple TV | the Siri Remote and the focus walk |
| `watch`, `crown` | Apple Watch | the watch app, the Digital Crown |
| `vision` | Vision Pro | a second window, an ornament, a context menu, an immersive space, home |
| `crash` | iPhone, foldable, watch, Vision Pro | fails on purpose: the crash comes back with its stack |
| `sign-in`, `matrix` | iPhone | `as <user>`, and the config's matrix |

```sh
yarn build && yarn e2e:apple                 # every kind that has a simulator on this Mac
PITBOX_E2E_KINDS=phone,xr yarn e2e:apple
```

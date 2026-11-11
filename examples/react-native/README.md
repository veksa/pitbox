# React Native example

A bare React Native app (no Expo) that pitbox's end-to-end run drives through pitbox's own dev server. It
depends on pitbox (`link:../..`), so the connect library autolinks into its debug build: `open` starts it
through the connect link, already pointed at the dev server, with no dev launcher.

What it has: the same screen as the [native example](../android) — a field and a greeting, a request to the
stand (`../stand/server.mjs`, port 4100), forty rows, a deep link `pitboxexample-rn://detail/<id>` — plus a
button that throws a JS error.

| Flow | Checks |
|---|---|
| `smoke` | the app starts on pitbox's dev server (bytecode once compiled), input, the stand, a tool, scrolling, a deep link, back |
| `js-error` | passes, and its verdict carries the JS error with its stack mapped to `App.tsx` |

Push notifications: React Native Firebase on Android (with a placeholder `google-services.json`: no Firebase
project, Play services or network needed), `UNUserNotificationCenter` in `AppDelegate.swift` on iOS. A push whose
data has `link` opens that screen when tapped; one that arrives with the app in front shows as `#push`.

```sh
pitbox push title=Hi body=There data='{"link":"pitboxexample-rn://detail/7"}'
pitbox push tap                                   # → Detail 7
pitbox tool notify title=Hi body=There link=pitboxexample-rn://detail/7   # the backend, through the push gateway
```

The e2e run also checks `fresh` (the app runs the newest bundle) and `app-log` (the app's request to the stand,
seen from inside the app).

```sh
yarn install                                 # here, once
cd android && ./gradlew assembleDebug        # or let `yarn e2e` build it
cd ../../.. && PITBOX_E2E_EXAMPLES=react-native yarn e2e
```

The dev server runs on port 8095 (`devserver.port` in `pitbox.config.ts`), so the example does not collide with
another project's bundler on the default 8081.

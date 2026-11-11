# Push notifications

`push` sends a push notification to the app on an iOS simulator or an Android emulator with no credentials: no
APNs key, no Firebase project of its own, no Google account on the emulator, no app code. The app takes it the way
it takes a real one — its foreground handler, the notification the system posts while it is in the background,
the tap that opens it, data-only messages — and the answer is one line about what the system showed.

```sh
pitbox push title="New message" body="Hi there" data='{"chat":"c1"}'
# ✓ android com.example.app (background): notification posted "New message" — "Hi there" · channel messages
#   sent "New message" — "Hi there" · data chat · via ExpoFirebaseMessagingService

pitbox push tap          # tap the app's latest notification: the shade on Android, the banner or Notification Center on iOS
# tapped "New message" → app foreground
```

The stand can take pushes from the project's own server too: a [push gateway](#the-push-gateway) that answers
the APNs and FCM requests a server sends, and delivers them to the running device.

## The command

| | |
|---|---|
| `push title=… body=… [data='{…}']` | the simple form; `subtitle`, `badge`, `sound`, `category`, `threadId`, `collapseId`, `channel` (Android), `image`, `tag` (Android), `priority=high\|normal`, `silent=true` (data-only / `content-available`) |
| `push file=payload.json` | a payload file: an APNs payload (`{"aps": …}`, the `.apns` files Xcode makes) or an FCM message |
| `push apns='{"aps":…}'` · `push fcm='{"notification":…,"data":…}'` | a raw payload for one platform, converted for the other when the device is of the other kind |
| `delay=s` · `repeat=n` | send later (the call answers at once; `push log` tells how it went) · send n copies |
| `grant=true` | allow notifications first (Android 13+ runtime permission) |
| `push tap [title]` | tap the latest notification (or the one with that text) |
| `push clear` | remove the app's notifications (Android) |
| `push grant` | grant POST_NOTIFICATIONS (Android) |
| `push status` | can the app take pushes here: the receiver, the FCM service, Firebase, the permission |
| `push log [-n 10]` | the last pushes (from `push` and from the gateway) with their verdicts |
| `push bind <token>` | send the gateway's pushes for this device token to this device |

`--device` picks the device, `--app` the package or bundle id (default: `app.android` / `app.apple` from the
config). Over MCP it is the `push` tool with an `action`. A typical answer is one or two lines.

Simple fields go on top of a raw payload, so `push file=chat.json body="another text"` reuses a file. Data
values are kept as they are on iOS (APNs custom keys may be any JSON) and turned into strings on Android (FCM
data is strings only; objects become JSON).

### Verdicts

| Verdict | Meaning |
|---|---|
| `notification posted "…" · channel …` | Android posted a notification for the app: Firebase's own (the app in the background or not running) or one the app made |
| `banner shown "…"` | iOS showed a banner: over the home screen, or over the app when its notification handler asks for one |
| `delivered with the app in front: no notification posted` | Android: the app was in front, Firebase handed the message to the app's handler (`onMessage`, expo's handler), which showed nothing |
| `delivered; no banner seen` | iOS: the app is in front and its handler shows nothing, or notifications are not allowed |
| `data message delivered` | a data-only message: nothing is expected on screen |
| `not delivered: notifications are not allowed …` | iOS: the app has not asked for permission yet, or it was declined — answer the app's prompt with "Allow" |
| `delivered, but no notification: POST_NOTIFICATIONS not granted` | Android 13+: `push grant` |

## How it is delivered

### iOS simulator

`xcrun simctl push` with the APNs payload, the app named in `Simulator Target Bundle`. The app needs nothing
from pitbox; it must have asked for notification permission (the prompt answered "Allow"). The banner is read
from the system shell by the runner, which sees it over any app.

A message that came as an FCM message gets `gcm.message_id`, as FCM adds it: React Native Firebase on iOS treats a
notification as its own (`onMessage`, `getInitialNotification`) only with it.

Limits of the simulator:

- **No `apns-collapse-id`**: `simctl push` takes no headers, so every push shows on its own. `thread-id` groups.
- **Background pushes** (`content-available`, no alert) reach an app in front; one that is suspended may not wake.
- **No VoIP (PushKit)**: the gateway answers a VoIP push with `400 BadTopic`.
- **No permission from outside**: iOS gives notification permission only in the app's own prompt
  (`press Allow`); `push grant` is Android-only.
- **No `push clear`**: no command removes delivered notifications.

### Android emulator

A real FCM message comes from Google Play services as the broadcast `com.google.android.c2dm.intent.RECEIVE`,
which only a holder of Play services' signature may send. The pitbox connect library — autolinked into React
Native apps, `debugImplementation` in native ones — carries a receiver that stands in for it:

1. `push` puts the app on the temporary power allowlist (`cmd deviceidle tempwhitelist`), as Play services does
   for a high-priority message, so Android 8+ lets the app start services from the background;
2. sends the message to the receiver with `am broadcast` (explicit component, foreground, stopped packages
   included);
3. the receiver gives the message, in the FCM wire format (`gcm.n.e`, `gcm.notification.*`, `google.message_id`,
   data keys…), to Firebase's own `FcmBroadcastProcessor` — exactly what Firebase's receiver does with a message
   from Play services — which starts or binds the app's `FirebaseMessagingService` (expo-notifications'
   `ExpoFirebaseMessagingService`, React Native Firebase's, or the app's own: the one Firebase itself would pick);
4. every other receiver of the app that listens for FCM messages gets it too, as the system would broadcast it:
   React Native Firebase takes its messages (`onMessage`, `setBackgroundMessageHandler`, the tap) in one.

From there it is the app's code and Firebase's: in the background Firebase posts the notification itself (with the
default channel from the manifest, or its fallback channel), a tap opens the app with the message's extras, and
`getInitialNotification` / `getLastNotificationResponseAsync` see it on a cold start.

It needs no Google Play services on the emulator (a `google_apis` image works, and so does one without Play
services) and no network: only the app's Firebase client library and an initialised Firebase app (its
`google-services.json`). A message is delivered to an app that was force-stopped too (`app stop`); real FCM
would not wake one, so the verdict then carries a note saying so.

**Release builds are not affected.** The receiver is switched off in release builds (`pitbox_connect_enabled` is
`false` outside the debug source set), it answers only in a debuggable app, and it is guarded by the `DUMP`
permission, which the adb shell holds and no installed app can.

## Recipes

### expo-notifications

```sh
pitbox push grant                                         # Android 13+: or answer the app's prompt
pitbox push title="New message" body="Hi" data='{"chat":"c1"}'
pitbox push tap                                           # addNotificationResponseReceivedListener gets it
pitbox app stop && pitbox push title="Cold" body="start" && pitbox push tap   # getLastNotificationResponseAsync
```

The token from `getDevicePushTokenAsync` is a real FCM token only when the emulator has Play services and a
network; the push itself needs no token.

### React Native Firebase

```sh
pitbox push fcm='{"notification":{"title":"Hi","body":"there"},"data":{"url":"/item/1"},"android":{"priority":"high"}}'
pitbox push data='{"type":"sync"}'                        # data-only: setBackgroundMessageHandler runs
pitbox push tap                                           # onNotificationOpenedApp / getInitialNotification
```

### A payload file

```json
{"aps": {"alert": {"title": "Order shipped", "body": "Arrives Friday"}, "sound": "default", "thread-id": "orders"}, "orderId": "42"}
```

```sh
pitbox push file=pushes/shipped.json                      # both platforms: converted for Android
```

### In a flow

A flow has no `push` step; a tool runs the command, or the gateway takes a push from the backend the flow
drives:

```text
tool notify title=Hi body=There link=myapp://item/1
wait text=Hi
```

## The push gateway

A stand-in for APNs and FCM that the project's server uses in its local environment. Turn it on in the config;
`up` starts it:

```ts
mocks: {push: {port: 4980}},   // host: '127.0.0.1' by default
```

It answers the requests the real services take, on the same paths, so a server only swaps the origin:

| Request | As |
|---|---|
| `POST /3/device/<token>` | APNs, over HTTP/2 cleartext (what an HTTP/2 APNs client opens with `http2.connect('http://127.0.0.1:4980')`) or HTTP/1.1; headers `apns-topic` (the bundle id), `apns-collapse-id`, `apns-push-type`, `apns-priority`; answers `200` with `apns-id` |
| `POST /v1/projects/<id>/messages:send` | FCM HTTP v1: `{"message": {"token", "notification", "data", "android", "apns"}}`; answers `{"name": "projects/<id>/messages/<id>"}` |
| `POST /fcm/send` | the legacy FCM API: `{"to" \| "registration_ids", "notification", "data", …}` |
| `POST /push` | pitbox's own: `{token?, device?, app?, apns? + headers? \| fcm? \| title, body, data…}`; answers the verdict as JSON |
| `GET /health` | `200` while it runs |

Every answer carries the verdict in `x-pitbox-verdict`, and `push log` lists what the server sent. The status
codes are the ones the real services use, so the server's token handling runs as in production:

| Case | APNs | FCM |
|---|---|---|
| delivered, whatever the device did with it (permission off, no banner): the verdict says | `200` | `200` |
| the app is not installed, has no pitbox receiver or no FCM client: the token is dead | `400 BadDeviceToken` | `404 UNREGISTERED` |
| payload over 4 KB | `413 PayloadTooLarge` | `400 INVALID_ARGUMENT` |
| no device of this session online | `503` | `503` |

Only a dead token should make the server drop it; a denied permission is not one. Authorization headers are
ignored. The gateway refuses what a web page could send to it: a request with an `Origin` header (`403`), and an
HTTP/1.1 `POST` whose `Content-Type` is not `application/json` (`415`). Package names and bundle ids are checked
before they reach a shell. A gateway request does not start a UI runner on a simulator: until one runs there (any
`snapshot`, `press`, `push tap`), the verdict is `delivered (banner not checked …)`.

When the port is taken, `up` brings the rest of the stand up and reports `push gateway :4980 not started: port
4980 is in use`; `status` says the same.

**Which device.** Only a device this session holds ([device leases](parallel.md)): never one another session
holds, never one that runs with no lease. A token bound with `push bind <token> --device …` goes to that device
while the session holds it (a binding to a device it no longer holds is skipped, and the verdict says so); so does
one that came with a `device` in a `POST /push` — which the session must hold: the gateway never takes a device,
and a device it does not hold is refused with its holder in the verdict. Bindings are kept in the state directory (`push-tokens.json`)
across daemon restarts. Otherwise an APNs
request goes to the booted simulator; an FCM request goes to the Android device online, or to the simulator when
the token is an APNs token (64 hex digits) or no Android device is online — React Native Firebase registers FCM
tokens on iOS too. An FCM token routed while both an emulator and a simulator are online is a guess, and the
verdict says which one it took. The token the app registered does not need to be real: an app on an emulator without Play
services can register any placeholder in debug.

### From a server

The helper needs nothing but `fetch`:

```ts
import {sendToPitbox} from '@veksa/pitbox/push';

// In the server's push transport, when it runs locally (PITBOX_PUSH_URL, default http://127.0.0.1:4980):
await sendToPitbox({token, fcm: message});                          // the firebase-admin Message it would send
await sendToPitbox({token, apns: payload, headers: {'apns-collapse-id': id}});
await sendToPitbox({title: 'Hi', body: 'There', data: {chat: 'c1'}});
```

It resolves with `{ok, id, platform, device, app, verdict}` and rejects when the gateway is down or the push
could not be delivered. Or point the existing client at the gateway: an FCM HTTP v1 client at
`http://127.0.0.1:4980` instead of `https://fcm.googleapis.com`, an HTTP/2 APNs client at `http://127.0.0.1:4980`
instead of `https://api.push.apple.com`.

firebase-admin itself has no option for another FCM origin; a server that uses it adds a local transport that
calls `sendToPitbox` with the same message object.

The [React Native example](../examples/react-native) has the whole loop: `tool notify` runs a backend script that
sends an FCM v1 request to the gateway; the app shows it and opens the link a tapped push carries.

## Troubleshooting

| Answer | What to do |
|---|---|
| `… has no pitbox push receiver` | the debug build predates push support in the connect library: rebuild it with the current @veksa/pitbox |
| `no-fcm-service` | the app has no FCM client (expo-notifications, @react-native-firebase/messaging, firebase-messaging); on such an app a push cannot arrive in production either |
| `firebase-not-initialized` | no default Firebase app: the app lacks `google-services.json` (or `FirebaseApp.initializeApp`) |
| `service-start <code>` | Android refused to start or bind the messaging service (a background-start limit the temporary allowlist did not lift, a device policy); open the app and send again |
| `firebase-obfuscated` | R8 renamed Firebase's classes in a minified debug build: the connect library's consumer rules keep them, unless the app's own rules strip them again |
| `POST_NOTIFICATIONS not granted` | `push grant`, or answer the app's prompt |
| iOS `not delivered: notifications are not allowed` | the app asks for permission at some point: get there and press "Allow" |
| no notification in the background on Android | the app counted as in front for a moment after leaving it; send again a second later |

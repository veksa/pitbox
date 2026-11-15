# Wear OS pairing on emulators

A Wear OS app and its phone app talk through Play services' Data Layer (`MessageClient`, `NodeClient`,
`CapabilityClient`, `WearableListenerService`). Two emulators get a Data Layer connection only through the
companion app from the Play Store and a Google account signed in on both; Play services offers no shell or adb way
to add one. pitbox stands in for it, with no account and no Play Store:

```
device action=pair value=watch            # MCP: your Android phone emulator + a Wear OS emulator
pitbox device pair watch [<avd|serial>]   # CLI
```

pairs the app on the two emulators (both leased to your session). From then on its Data Layer calls answer with
the other device, and messages go through the pitbox daemon. It is a **stand-in**, and says so: the transport is
not Play services'. What the app does with a message is real — its listeners, its `WearableListenerService` woken
in a process that was not running, its answer back.

| | the stand-in | a real pair |
|---|---|---|
| `connectedNodes`, `localNode` | the paired device (8-hex node id, the AVD name) | the paired device |
| `sendMessage` | relayed by the daemon; fails with 4000 (`TARGET_NODE_NOT_CONNECTED`) for another node or a daemon that is gone, 4003 above 100 KB | Play services |
| `getCapability` | the paired device when its app declares the capability (`android_wear_capabilities`) | the same |
| listeners added with `addListener` | called on the main thread | the same |
| `WearableListenerService` for `MESSAGE_RECEIVED` | bound by the system for a message whose path its data filter matches (created and attached as usual, `onMessageReceived` on its own looper thread), also when the app does not run | the same |
| data items, channels, RPC (`onRequest`), remote activities | **not relayed** | Play services |
| a phone or watch app of another package or signing key | another package is refused; another key is a warning | not delivered |

## Wiring an app

The relay lives in the debug variant of pitbox's Android connect library (autolinked into React Native apps; another
module of the same Gradle build — a Wear OS app, a native module — adds `debugImplementation
project(':veksa_pitbox')`; an app outside React Native takes the JitPack artifact, see [install.md](install.md)). The
release variant carries none of it — `yarn check-connect` asserts that. The app also needs
`play-services-wearable` (it has it anyway) and the INTERNET permission (the apps reach the daemon at the
emulator's host alias `10.0.2.2`).

`dev.pitbox.connect.PitboxWearable` has Play services' signatures and returns its types (`Task`, `Node`,
`CapabilityInfo`); on a device pitbox has not paired, every call is Play services' own. So the app routes its few
Data Layer calls through one name with a file per source set:

```kotlin
// src/debug/…/DataLayer.kt
typealias DataLayer = dev.pitbox.connect.PitboxWearable

// src/release/…/DataLayer.kt
object DataLayer {
  fun connectedNodes(context: Context) = Wearable.getNodeClient(context).connectedNodes
  fun sendMessage(context: Context, nodeId: String, path: String, data: ByteArray?) = Wearable.getMessageClient(context).sendMessage(nodeId, path, data)
  fun getCapability(context: Context, capability: String, filter: Int) = Wearable.getCapabilityClient(context).getCapability(capability, filter)
  fun addListener(context: Context, listener: MessageClient.OnMessageReceivedListener) = Wearable.getMessageClient(context).addListener(listener)
  fun removeListener(context: Context, listener: MessageClient.OnMessageReceivedListener) = Wearable.getMessageClient(context).removeListener(listener)
}
```

and calls `DataLayer.sendMessage(context, …)` where it called `Wearable.getMessageClient(context).sendMessage(…)`.
A `WearableListenerService` needs no change. `examples/android/relay` is a complete app wired this way.

## Commands

- `device action=pair value=watch [device=<phone>] [watch=<avd|serial>]` — the phone is the Android phone
  emulator you hold (or `device=`); the watch is the one named (`watch=`, else `android.watch`; an AVD is booted
  for you), else a Wear OS emulator you hold, else the first Wear OS AVD. The app is `app.android` on both
  (`app.watch.android` for the watch, which must be the same package). The answer names the pair and both node
  ids, with warnings for what would keep a message from arriving: no INTERNET, no listener service, different
  signing keys. Install the debug build on both devices first.
- Again: `already`, the number of messages relayed and the last three, each with what the receiving app did
  (`watch→phone /ping 0B: listeners=0 services=PingService`).
- `device=watch` names the paired watch; on a Wear OS device a call without a package takes `app.watch.android`.
- `device action=unpair value=watch`, a release of either device, `down` and a daemon's orderly exit make both
  apps forget the pairing. A daemon that dies cannot: its pairs are kept in `.pitbox/wear-pairs.json`, and the
  next daemon of the project takes each up while both devices are still the session's (the apps are told where it
  listens now) or makes the apps forget it; until then the apps see no node and their sends fail with 4000.
  `unpair` also undoes a pairing only the apps still know. An install over the app keeps the pairing; `app clear`
  or a reinstall through pitbox pairs that side again.
- A send is answered once the other app has the message in hand — a cold start included, not what its listeners
  then do (that goes to the log) —, and fails with 4000 when that app does not take it (not running and cannot be
  started, not paired, the device gone). The message itself never travels on a command line: the other device
  gets its number and fetches it from the daemon, so the 100 KB limit is the Data Layer's own.

Typical answer: one line, about 200 characters; again with the log, four lines.

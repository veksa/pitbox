# pitbox

[![CI](https://github.com/veksa/pitbox/actions/workflows/ci.yml/badge.svg)](https://github.com/veksa/pitbox/actions/workflows/ci.yml)
[![npm](https://img.shields.io/npm/v/@veksa/pitbox)](https://www.npmjs.com/package/@veksa/pitbox)
[![node](https://img.shields.io/node/v/@veksa/pitbox)](docs/install.md#requirements)
[![license](https://img.shields.io/npm/l/@veksa/pitbox)](LICENSE)

Run, drive and debug apps on emulators, simulators and devices from one MCP server — fast and token-lean.

pitbox gives a coding agent (and you) one tool for the whole local loop: the stand your app talks to, the
devices it runs on, and the checks that tell you what is broken. It works with any framework; React Native gets
extra reach inside the app.

- **Phones, foldables, tablets, TVs, watches, XR headsets, glasses and cars** — Android emulators and devices,
  Apple simulators, native apps on the Mac, and web apps in a browser, behind the same tools.
- **Answers an agent can afford** — the screen as short lines with refs, actions that wait for the UI to settle
  and reply with what changed, images only on request.
- **Flows** — a line-per-step script run by the daemon: a whole pass in one call, one verdict.
- **Checks instead of screenshots** — is the video playing, does the screen match its baseline, can the D-pad
  reach everything, which function made the frame janky.
- **The stand** — services, mocks and backend states started from one config and kept warm between sessions.
- **Push notifications with no credentials** — `push` on simulators and emulators, through the app's own FCM
  client on Android; a one-line verdict from the system UI, `push tap` to open it, and a gateway that takes the
  APNs and FCM requests of the project's server.
- **Media** — sound into the microphone, what the app plays captured and checked, screen recordings around a
  flow, the camera fed a picture or a clip, the gallery, phone calls and permissions.
- **Parallel sessions** — every device is leased to the session that drives it: another session's simulator is
  never shut down or driven, and `boot` gives each session a device of its own.
- **Inside a React Native app with no app code** — fresh code or stale, the network log and rules, the
  console, `eval` and logpoints, hot updates, React renders.

## Speed

What pitbox does to devices and builds by default, measured on an Apple-silicon Mac: before is the same step
without it. Details and method: [slim devices, warm templates and native builds](docs/parallel.md#slim-devices).

**Android emulator** (API 36 Google APIs phone image, 2 GB, headless; median of three boots):

| | Before | pitbox |
|---|---|---|
| Boot | 15.0 s | 12.9 s |
| Settings cold start | 207 ms | 117 ms |
| App processes running | 46 | 28 |
| Guest swap in use | 583 MB | 200 MB |
| Emulator CPU while idle | 0.15 cores | 0.08 cores |
| Shutdown | 3.1–3.8 s | 2.1 s |
| Written to disk at every shutdown | 2.6 GB | none |
| Background dexopt starting mid-run | 21 s at ~3 cores | never |

**iOS simulator** (iPhone 17, iOS 27.2):

| | Before | pitbox |
|---|---|---|
| Processes running | 207 | 122 |
| Memory footprint on the Mac | 8.5 GB | 4.5 GB (3.8 GB with widgets off) |
| A second session's own simulator: boot | 12.0–13.2 s | 1.9–2.0 s |
| … boot to the app's first screen | 29.1–32.1 s | 21.6–22.9 s |
| … its CPU over the minute after | 0.24–0.28 cores | 0.02–0.16 cores |
| First UI action, 20 s or more after the boot | 17 s | 2.6 s |

**iOS UI actions** (the Apple example on an iPhone 17 Pro simulator, iOS 27.2; median of five):

| | Before | pitbox |
|---|---|---|
| Tap | 395 ms | 249 ms |
| Fill a field | 3.67 s | 2.87 s |
| Fill a field with a sentence | 5.39 s | 4.77 s |
| Press a button under the keyboard after a fill | 3.10 s | 1.74 s |
| Press that changes nothing | 2.25 s | 0.90 s |
| Snapshot | 166 ms | 68 ms |
| A call's time outside its action (finding the device, the crash check) | 340 ms | 40 ms |
| UI runner start, to the first snapshot | 14.1 s | 3.4 s |
| … after a daemon restart (the running runner is taken over) | 14.1 s | 0.24 s |
| Relaunch of the app and the first snapshot after it | 2.49 s | 1.78 s |
| A crash macOS saves no report of (it keeps 25 per app): the answer | after a 60 s wait | at once |

**Android UI actions** (the Android example on an API 36 phone emulator; median of five, each call through the
daemon):

| | Before | pitbox |
|---|---|---|
| Press that changes nothing | 1.58 s | 0.72 s |
| Press that changes the screen | 0.40–0.68 s | 0.26 s |
| Snapshot | 137 ms | 42 ms |
| A call's time outside its action (finding the device) | 25–110 ms | 12 ms |

An action that changed nothing watches the screen 0.6 s after its input instead of 1.2 s; a later effect still
reaches a flow, whose next step waits for the target it brings
([features](docs/features.md#ui-automation)).

**Native builds** (the React Native example; once built, every checkout and session on the Mac reuses the build):

| | Android | iOS |
|---|---|---|
| Build | 12.0 s | 16.1 s |
| Again, same native inputs | 0.24 s | 0.37 s |
| After a JS-only edit | 0.08 s | 0.11 s |
| In another checkout of the app | 0.26 s | 0.16 s |

## Quick start

```sh
yarn add -D @veksa/pitbox
npx pitbox init          # writes pitbox.config.ts from what it finds in the project
```

Add the MCP server to the project's `.mcp.json`:

```json
{"mcpServers": {"pitbox": {"command": "npx", "args": ["pitbox", "mcp"]}}}
```

Or drive it from the shell:

```sh
pitbox up                # the stand: services, dev server
pitbox boot              # the configured emulator, ports forwarded
pitbox open              # launch the app
pitbox snapshot          # the screen as text
pitbox run smoke         # flows/smoke.flow, one verdict
```

A config by hand:

```ts
// pitbox.config.ts
import {defineConfig} from '@veksa/pitbox';

export default defineConfig({
  app: {android: 'com.example.app', apple: 'com.example.app'},
  android: {avd: 'Pixel_8'},
  services: {
    db: {start: 'docker compose up -d db', stop: 'docker compose stop db', health: 'docker:db'},
    api: {start: 'yarn --cwd server start', health: 'http://localhost:3000/health', expose: 3000, dependsOn: ['db']},
  },
  devserver: {adapter: 'metro', root: 'mobile', bytecode: true},
});
```

## Documentation

| | |
|---|---|
| [Install](docs/install.md) | requirements, the MCP server, connect libraries for React Native, Swift and Android |
| [Features](docs/features.md) | everything pitbox does, by area |
| [Config](docs/config.md) | every field of `pitbox.config.ts` |
| [Flows](docs/flows.md) | the flow language: steps, selectors, recording |
| [Push notifications](docs/push.md) | `push` on simulators and emulators, the stand's push gateway, recipes |
| [Media](docs/media.md) | microphone, sound out, screen recording, camera, gallery, calls; what each platform can do |
| [Wear OS pairing](docs/wear.md) | a phone and a Wear OS emulator paired through pitbox's Data Layer stand-in |
| [Using pitbox from an agent](docs/agents.md) | how an agent gets the most out of the tools |
| [Working in parallel](docs/parallel.md) | device leases: several sessions on one machine, each on its own device |
| [Benchmarks](bench/README.md) | what pitbox measures and how |
| [Examples](examples) | sample Android, Apple and React Native apps with their flows |

## Contributing

See [CONTRIBUTING.md](CONTRIBUTING.md).

## License

[MIT](LICENSE)

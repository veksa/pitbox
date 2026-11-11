# Install

## Requirements

- Node.js 22.18 or newer.
- For Android: the Android SDK (`adb`, the emulator). The Android runner ships prebuilt in the package.
- For Apple simulators: a Mac with Xcode. The XCUITest runner is built from its sources on first use.
- For web apps: `playwright-core` in the project (`yarn add -D playwright-core`) and a browser
  (`npx playwright-core install chromium`).

## The package

```sh
yarn add -D @veksa/pitbox     # or npm i -D @veksa/pitbox, pnpm add -D @veksa/pitbox
```

It carries the CLI (`pitbox`), the MCP server, the runners and the connect libraries for React Native.

## As an MCP server

`.mcp.json` in the project:

```json
{"mcpServers": {"pitbox": {"command": "npx", "args": ["pitbox", "mcp"]}}}
```

The server talks over stdio and starts the project's daemon on first use. After an upgrade of the package, the
first command replaces a daemon of the old version; services keep running, and the dev server, actors and the
LLM mock come back with `up`. How an agent should use it:
[agents.md](agents.md).

## A first config

`pitbox init` in the project writes a first `pitbox.config.ts` from what it finds (the app, its id and
scheme, the bundler, an Xcode project, an emulator), lets the Android debug build use plain HTTP when nothing
does yet, and adds `.pitbox/` to `.gitignore`. `--dry-run` only says what it would do. Every field:
[config.md](config.md).

## Connect libraries

Small debug-only libraries that point an app at pitbox's dev server and named hosts from a
`pitbox.<bundle id>://connect` link. Simulators and emulators opened by pitbox need none of them; they matter on
physical devices and in native apps that read named hosts. The Android library also carries the receiver that
`push` delivers through (an Android app needs it for [push notifications](push.md); iOS needs nothing).

**React Native** — comes with the npm package. Android is autolinked. On iOS, add the pod to the app's
`Podfile`:

```ruby
pod 'PitboxConnect', :path => '../node_modules/@veksa/pitbox', :configurations => ['Debug']
```

**Swift** (SwiftPM, product `PitboxConnect`):

```swift
.package(url: "https://github.com/veksa/pitbox.git", from: "0.1.0")
```

```swift
PitboxConnect.url("api")          // http://host:port of a named host, or nil
PitboxConnect.handle(url)         // in the app's URL handler, for the connect link
```

**Android** (through JitPack; the artifact is meant for debug builds):

```kotlin
repositories { maven("https://jitpack.io") }
dependencies { debugImplementation("com.github.veksa:pitbox:0.1.0") }
```

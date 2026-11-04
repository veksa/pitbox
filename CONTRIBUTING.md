# Contributing

Issues and pull requests are welcome. For a larger change, open an issue first so the approach can be agreed
before the work.

## Setup

```sh
corepack enable
yarn install
yarn check-all        # type check and unit tests
```

The code is TypeScript in `strict` mode (daemon, CLI, MCP server), Kotlin for the Android runner and connect
library, Swift for the Apple runner and connect library.

| Path | What |
|---|---|
| `src/` | daemon, CLI, MCP server, drivers, flows, dev server |
| `runners/android/` | the Android runner (instrumentation APK); `yarn build-runner` rebuilds the shipped APK |
| `runners/apple/` | the XCUITest runner, built on the Mac on first use |
| `android/` | the Android connect library, autolinked into React Native apps |
| `connect/apple/` | the Swift connect library (`Package.swift` at the root) |
| `examples/` | sample apps used to test pitbox itself |
| `bench/` | measurement scripts, see [bench/README.md](bench/README.md) |

## Tests

- `yarn test` — unit tests (vitest).
- `yarn e2e` — drives the example apps through the CLI on every kind of Android emulator found on the machine
  (phone, foldable, tablet, desktop, TV, XR, glasses, watch, car) and the React Native example through
  pitbox's dev server, with a verdict per device kind.
- `yarn e2e:apple` — the same on every Apple simulator kind (iPhone, foldable iPhone, iPad, Apple TV, Apple
  Watch, Vision Pro).

CI runs the unit tests on Linux, macOS and Windows and builds the runners and connect libraries; device runs
need emulators and simulators and are run locally.

## Rules

- pitbox knows nothing about the projects that use it: examples, tests and docs use neutral placeholders
  (`com.example.app`, `MyApp`, `api.example.test`, `user@example.test`).
- The core never imports a framework; React Native, Metro, Expo and the like live in adapters.
- Every agent-facing response is budgeted: text first, short ids, diffs instead of full trees, images only on
  request. A new MCP tool documents its typical response size.
- A silent failure is closed with a check (a test or a `doctor` rule), not only with a fix.
- Commits follow [Conventional Commits](https://www.conventionalcommits.org/): `<type>(<scope>): <subject>`, one
  line, imperative, lowercase.

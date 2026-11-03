# Config

pitbox reads `pitbox.config.ts` (or `.mts`, `.mjs`, `.js`, `.json`) from the current directory or the nearest
parent. Relative paths in it resolve against the config's directory; runtime state (logs, pids, shots, states,
bytecode) goes to `.pitbox/` next to it.

```ts
import {defineConfig} from '@veksa/pitbox';

export default defineConfig({
  app: {android: 'com.example.app'},
  services: {/* … */},
});
```

`pitbox init` writes a first one from the project's files. `defineConfig` only adds type checking. The config is validated on load; an error names the field
(`services.api.health: probe must start with …`). Edits are picked up by a running daemon without a restart.

## app

| Field | Meaning |
|---|---|
| `android` | Android package; the default for `open`, `stop`, `clear`, logs, perf |
| `apple` | Apple bundle id; the default for the same commands on a simulator, and the app the Apple runner reads |
| `scheme` | the app's URL scheme |
| `connect` | link that points the app at the dev server, used by `qr` and by `open` without a target. Placeholders: `{devserver}` (URL-encoded `http://host:port`), `{host}`, `{port}`. Default: pitbox's connect link `pitbox.<android>://connect?devserver={host}:{port}`, handled by the connect library in debug builds. With a dev launcher, its own link: `myapp://expo-development-client/?url={devserver}` |

## shell

Shell for every project command (services, tools, actors, state hooks): `bash` (default; Git Bash on Windows
when installed), `sh`, `cmd`, or a path to a shell.

## services

A map of stand services. `pitbox up` starts the autostart ones in dependency order; a service whose probe
already answers is adopted, not started twice. Services outlive the daemon; only `down` stops them.

```ts
services: {
  db: {start: 'docker compose up -d db', stop: 'docker compose stop db', health: 'docker:db'},
  api: {start: 'yarn start', cwd: 'server', env: {PORT: '3000'}, health: 'http://localhost:3000/health', expose: 3000, dependsOn: ['db']},
  media: {health: 'tcp:8080', expose: 8080, autostart: false},
},
```

| Field | Meaning |
|---|---|
| `start` | command that runs the service. A command that exits with 0 after launching something in the background (`docker compose up -d`) is fine: pitbox keeps waiting for the probe. Omit it for a service pitbox only watches |
| `stop` | command for `down`, for services started detached |
| `cwd`, `env` | working directory and extra environment |
| `health` | probe: `http(s)://…` (any answer below 500), `tcp:<port>` / `tcp:<host>:<port>`, `docker:<container>` (running, and healthy when it has a health check), `cmd:<command>` (exit 0) |
| `expose` | host port(s) devices must reach; forwarded to every device |
| `dependsOn` | services that start first (and stop after) |
| `startTimeout` | seconds to wait for the probe (default 120) |
| `autostart` | started by a bare `up` (default true) |

Logs go to `.pitbox/logs/<name>.log` (`pitbox logs <name> -n 40 --grep error`).

## devserver

The JavaScript dev server, run behind pitbox's proxy. The proxy sits on the device-facing port; the bundler
runs on an internal one.

```ts
devserver: {adapter: 'metro', root: 'mobile', bytecode: true},
```

| Field | Meaning |
|---|---|
| `adapter` | `metro` (React Native with Metro, Expo included), `rspack` (Re.Pack), `command` (anything else). Default `metro` |
| `root` | the app directory the bundler runs in |
| `start` | start command; `{port}` is the internal port. Default `yarn start --port {port}` |
| `port` | port devices talk to (the proxy). Default 8081 |
| `internalPort` | port of the bundler itself. Default `port + 1` |
| `host` | where the proxy listens: `127.0.0.1` (default; devices behind adb), `lan` (phones on the network; the LAN address goes into links and Expo's manifest), or an address |
| `env` | extra environment for the bundler |
| `bytecode` | serve the main bundle as Hermes bytecode compiled on the host with the app's own `hermesc`. While bytecode for new code compiles, devices get source, so they are never slower than with the bundler alone. Off by default: the compiler must match the Hermes the app was built with |
| `inApp` | splice the in-app script into the dev bundle: freshness, network log and rules, trace headers, in-flight requests. Default on for `metro` and `rspack` |
| `platforms` | platforms whose main bundle is built before a device asks. Default `['android']` |
| `bundlePath` | main bundle path for prewarming when it cannot be discovered from Expo's manifest or a device's request (`{platform}` placeholder) |
| `startTimeout` | seconds to wait for the bundler (default 180) |
| `embed` | `dev embed`: `output` — where each platform's bundle is written, relative to `root` (`{android, ios}`; for `metro` and `rspack` Android defaults to `android/app/src/main/assets/index.android.bundle`), `build` — the command that builds the app around it, `timeout` — seconds for it (default 900). The bundle comes whole from the running bundler, as bytecode when the app's `hermesc` is there; a debug build runs it when no dev server answers. Keep the file out of git |

With `adapter: 'metro'` the bundler also gets Metro's native recursive file watcher on every platform (no
change on disk) and, for Expo, `EXPO_PACKAGER_PROXY_URL` pointing at the proxy. `devserver` is also a service
named `devserver` in `status`, `up`, `down`, `restart`; do not name a service that.

## android

| Field | Meaning |
|---|---|
| `avd` | default emulator for `boot` |
| `reverse` | extra host ports to forward besides the services' `expose` (React DevTools, for example) |
| `forward` | how exposed ports reach devices: `reverse` (adb reverse), `relay` (pitbox's runner listens on the device and pipes to the emulator host alias 10.0.2.2), `auto` (default: adb reverse, switching an emulator to the relay when its forwards stop carrying data; remembered per AVD) |

## apple

| Field | Meaning |
|---|---|
| `simulator` | default simulator for `boot`: a name (`iPhone 17`; the newest runtime wins when names repeat) or a udid |
| `remote` | a Mac that serves its simulators to this machine: `http://mac.example.test:7700` |
| `token` | the device host's token; better in `PITBOX_REMOTE_TOKEN` than in the config |

Simulators share the Mac's network, so exposed ports need no forwarding. The UI runner (XCUITest) drives iOS,
iPadOS, tvOS, watchOS and visionOS simulators; it is built on first use per platform and cached under `~/Library/Caches/pitbox/apple-runner`; a changed runner source
rebuilds it.

### A remote Mac

From Windows or Linux, drive a Mac's simulators over a VPN overlay (Tailscale, WireGuard): on the Mac run

```sh
PITBOX_TOKEN=<a secret> pitbox serve-devices --listen <the Mac's VPN address>:7700
```

and on this machine set `apple.remote` and `PITBOX_REMOTE_TOKEN`. Every tool works as with local simulators:
an `.app` is uploaded for `install`, screenshots come back as files here, flows, baselines and recordings stay
here; only device operations and runner commands cross the network. `open` points the app at this machine's
dev server by the address the Mac sees it at, so the dev server must listen beyond loopback
(`devserver.host: '0.0.0.0'`).

## actors

Extra users of the app: instances of a project command that pitbox starts on a free port.

```ts
actors: {
  peer: {start: 'node tools/peer.mjs {name} {port}', health: 'http://127.0.0.1:{port}/health'},
},
```

| Field | Meaning |
|---|---|
| `start` | command; `{name}` and `{port}` are filled in |
| `cwd`, `env` | as for services |
| `health` | probe with `{port}`; default `tcp:{port}` |
| `call` | where `actor call` sends its JSON body: `{method, path}`, default `POST /` |

## tools

Project commands with parameters. Each becomes the CLI command `pitbox tool <name> key=value…` and the MCP
tool `tool_<name>`.

```ts
tools: {
  sql: {description: 'SQL in the stand database', run: 'docker exec -i db psql -U app -qAt -c {query}', params: {query: 'SQL statement'}},
},
```

| Field | Meaning |
|---|---|
| `run` | command with `{param}` placeholders; values are quoted for the shell |
| `params` | `name → description`; every placeholder must be listed (checked on load) |
| `description` | shown to agents |
| `cwd`, `env`, `timeout` | working directory, environment, seconds (default 120) |

## mocks

```ts
mocks: {llm: {port: 4010, fixtures: 'fixtures/llm'}},
```

An OpenAI-compatible stand-in (`/v1/chat/completions`, `/v1/models`, streaming or not) started by `up`.
`fixtures` is a JSON file or a directory of them: `[{"match": "regex", "reply": "text"}]`, matched against
the last user message; no match answers `mock reply to: …`.

## states

```ts
states: {
  save: 'docker exec db pg_dump -U app -Fc app > {file}',
  restore: 'docker exec -i db pg_restore -U app -d app --clean --if-exists --single-transaction < {file}',
},
```

Commands that back up and bring back the backend for `state save <name>` / `state restore <name>`; `{name}`
and `{file}` (a file under `.pitbox/states`) are filled in. The device side is an emulator snapshot taken by
pitbox; on restore the backend comes first, then the snapshot.

## matrix

```ts
matrix: {devices: ['Pixel_8', 'Pixel_Fold'], fontScale: [1, 1.3], dark: [false, true], locale: ['en-US', 'fr-FR']},
```

Variants for `pitbox matrix <flow>` (MCP: `run` with `matrix: true`): every combination runs the flow once.
Screenshots go to `.pitbox/shots/<variant>/`, visual baselines are kept per variant, and the settings are put
back afterwards. `locale` is the app's own locale (Android 13+ per-app locales).

## Paths and lookups

| Field | Meaning |
|---|---|
| `flows` | directory of `.flow` files. Default `flows` |
| `visual` | directory of visual baselines. Default `visual` |
| `routes` | deep link templates for `goto`: `{item: 'myapp://item/{id}'}` |
| `signIn` | flow name for `as <user>`; it gets `${user}` |
| `docs` | named documents for `docs`: `{check: 'CHECK.md', knowledge: 'docs/KNOWLEDGE.md'}` |
| `doctor` | module whose default export is an array of extra doctor rules: `{id, title, check(ctx) → findings}` |

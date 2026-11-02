# pitbox

Run, drive and debug apps on emulators, simulators and devices from one MCP server — fast and token-lean.

pitbox gives a coding agent (and you) one tool for the whole local loop: the stand your app talks to, the
devices it runs on, and the checks that tell you what is broken. Status: early development; measurements in
[bench/README.md](bench/README.md).

## What works today

- **Stand from a config.** Services start in dependency order and are health-checked; anything already
  answering its probe is adopted instead of started twice; logs go to files; services outlive agent sessions
  and daemon restarts, and only `down` stops them. Actors (extra users of the app), project tools (a protocol
  call, an SQL query) and an OpenAI-compatible LLM mock.
- **Android** — phones, foldables, tablets, TV and XR, emulators and hardware: boot, install, open apps and
  deep links, logs, settings, network conditions, screenshots, keys. Stand ports are forwarded to every device
  and re-forwarded when a device reconnects.
- **Dev server** — your bundler (`yarn start`) behind pitbox's proxy: a native file watcher on every platform
  (Metro crawls every directory on Windows otherwise), the main bundle built before the device asks, and, with
  `bytecode: true`, Hermes bytecode compiled on the host so the app skips parsing megabytes of source.
- **Inside the app, with no app code** (React Native dev bundles served through pitbox): `fresh` says whether
  the app runs the newest code or a stale bundle; the app's network log; network rules applied inside the app
  (fail, mock, delay, a WebSocket frozen open, offline); a `traceparent` on every request an action causes;
  in-flight requests count toward "the UI has settled".
- **No dev launcher needed**: the Android connect library (autolinked, debug builds only) points the app at the
  dev server from a link — `pitbox qr` puts it in a QR code for a phone, `open` uses it on emulators.
- **UI automation on Android** through pitbox's own runner: the screen as short lines with refs, actions that
  wait for the UI to settle and answer with what changed, exact gestures (double tap, swipe velocity), D-pad
  keys and focus for TV. A finger can be held across calls (inspect a scrubber mid-drag). Taps on a screen
  with a playing video take milliseconds (the platform's wait-for-animations is skipped).
- **Checks instead of screenshots** — `media` (is the video playing, or black), `visual` (the screen against a
  baseline, changed regions in pixels), `focus_map` (D-pad reachability, traps, irreversible moves), `perf`
  (janky frames, frame-time percentiles, memory), `app_tree` (the React tree from inside the app). Crashes
  and ANRs come back with the step they happened in, with the stack.
- **Named states** — an emulator snapshot plus the project's backend dump, restored in seconds.
- **Several devices and variants** — a flow can switch devices (`device <avd>`); `matrix` runs a flow over
  devices × font scales × themes × locales, with full-size screenshots per variant (store screenshots).
- **Forwards that really work** — when `adb reverse` lists its forwards but carries no data, emulators switch to
  a relay inside the runner through the emulator's host alias.
- **Flows** — a line-per-step script the daemon runs on its own (`open`, `goto <route>`, `as <user>`, `press`,
  `fill`, `scroll … until`, `wait`, `expect`, `tool … contains`, …): one call, one verdict, and on failure the
  line, the error and the screen. Sessions can be recorded into flows.
- **Doctor** — known failures with remedies (`doctor --fix`), plus your own rules.
- **Docs** — the lines of a long checklist or knowledge base that a step needs, not the whole file.
- **MCP server** over stdio; the CLI prints the same compact text. How an agent should use it:
  [docs/agents.md](docs/agents.md).

## Quick start

```ts
// pitbox.config.ts
import {defineConfig} from '@veksa/pitbox';

export default defineConfig({
  app: {android: 'com.example.app'},
  android: {avd: 'Pixel_8'},
  services: {
    db: {start: 'docker compose up -d db', stop: 'docker compose stop db', health: 'docker:db'},
    api: {start: 'yarn --cwd server start', health: 'http://localhost:3000/health', expose: 3000, dependsOn: ['db']},
  },
  devserver: {adapter: 'metro', root: 'mobile', bytecode: true},
  tools: {
    sql: {run: 'docker exec -i db psql -U app -qAt -c {query}', params: {query: 'SQL statement'}},
  },
  docs: {check: 'CHECK.md'},
});
```

```sh
pitbox up            # the whole stand
pitbox boot          # the configured emulator, ports forwarded
pitbox install app-debug.apk && pitbox open
pitbox doctor --fix
pitbox status
```

As an MCP server (`.mcp.json`):

```json
{"mcpServers": {"pitbox": {"command": "npx", "args": ["pitbox", "mcp"]}}}
```

Probes: `http(s)://…` (any answer below 500), `tcp:<port>`, `docker:<container>`, `cmd:<command>`. Project
commands run in bash (Git Bash on Windows) unless `shell` says otherwise.

## License

MIT

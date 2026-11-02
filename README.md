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
- **Doctor** — known failures with remedies (`doctor --fix`), plus your own rules.
- **Docs** — the lines of a long checklist or knowledge base that a step needs, not the whole file.
- **MCP server** over stdio; the CLI prints the same compact text.

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

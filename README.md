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
  Apple simulators, and web apps in a browser, behind the same tools.
- **Answers an agent can afford** — the screen as short lines with refs, actions that wait for the UI to settle
  and reply with what changed, images only on request.
- **Flows** — a line-per-step script run by the daemon: a whole pass in one call, one verdict.
- **Checks instead of screenshots** — is the video playing, does the screen match its baseline, can the D-pad
  reach everything, which function made the frame janky.
- **The stand** — services, mocks and backend states started from one config and kept warm between sessions.
- **Inside a React Native app with no app code** — fresh code or stale, the network log and rules, the
  console, `eval` and logpoints, hot updates, React renders.

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
| [Using pitbox from an agent](docs/agents.md) | how an agent gets the most out of the tools |
| [Benchmarks](bench/README.md) | what pitbox measures and how |
| [Examples](examples) | sample Android, Apple and React Native apps with their flows |

## Contributing

See [CONTRIBUTING.md](CONTRIBUTING.md).

## License

[MIT](LICENSE)

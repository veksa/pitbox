// The project config: what the stand consists of and how pitbox should treat the app.

import {z} from 'zod';

const env = z.record(z.string(), z.string());
const ports = z.union([z.number().int().positive(), z.array(z.number().int().positive())]);

/**
 * A health probe:
 * - `http://…` / `https://…` — any answer below 500;
 * - `tcp:3000` or `tcp:host:3000` — the port accepts a connection;
 * - `docker:<container>` — the container is running (and healthy, when it has a health check);
 * - `cmd:<command>` — the command exits with 0.
 */
const probe = z.string().regex(/^(https?:\/\/|tcp:|docker:|cmd:)/, 'probe must start with http(s)://, tcp:, docker: or cmd:');

export const serviceSchema = z.object({
  description: z.string().optional(),
  /** Command that starts the service in the foreground. Omit for something pitbox only watches. */
  start: z.string().optional(),
  /** Command that stops it, for services started detached (for example `docker compose stop db`). */
  stop: z.string().optional(),
  cwd: z.string().optional(),
  env: env.optional(),
  health: probe.optional(),
  /** Host ports the device must reach (forwarded to Android devices automatically). */
  expose: ports.optional(),
  dependsOn: z.array(z.string()).optional(),
  /** Seconds to wait for health after starting. */
  startTimeout: z.number().positive().optional(),
  /** Started by a bare `up`. Default true. */
  autostart: z.boolean().optional(),
});

export const actorSchema = z.object({
  description: z.string().optional(),
  /** Command for one actor instance; `{name}` and `{port}` are filled in by pitbox. */
  start: z.string(),
  cwd: z.string().optional(),
  env: env.optional(),
  /** Probe with `{port}`; default `tcp:{port}`. */
  health: z.string().optional(),
  /** Where `actor_call` sends its JSON body. Default `POST /`. */
  call: z.object({method: z.string().optional(), path: z.string().optional()}).optional(),
});

export const toolSchema = z.object({
  description: z.string().optional(),
  /** Command with `{param}` placeholders; values are quoted for the shell. */
  run: z.string(),
  cwd: z.string().optional(),
  env: env.optional(),
  /** Parameter descriptions; every placeholder in `run` must be listed. */
  params: z.record(z.string(), z.string()).optional(),
  timeout: z.number().positive().optional(),
});

export const devserverSchema = z.object({
  /** `metro` (React Native with Metro, Expo included), `rspack` (Re.Pack) or `command` (anything else). */
  adapter: z.enum(['metro', 'rspack', 'command']).optional(),
  /** App directory the bundler runs in. */
  root: z.string().optional(),
  /** Start command; `{port}` is the internal port pitbox gives it. Default `yarn start --port {port}`. */
  start: z.string().optional(),
  /** Port the device talks to (pitbox's proxy). Default 8081. */
  port: z.number().int().positive().optional(),
  /** Port the bundler itself listens on. Default `port + 1`. */
  internalPort: z.number().int().positive().optional(),
  /** Where the proxy listens: `127.0.0.1` (default, devices behind adb), `lan` (phones on the network) or an address. */
  host: z.string().optional(),
  env: env.optional(),
  /** Serve the app's main bundle as Hermes bytecode compiled on the host (React Native with Hermes). */
  bytecode: z.boolean().optional(),
  /**
   * Splice pitbox's in-app script into the dev bundle: which bundle runs (freshness), network log and rules,
   * trace headers, in-flight requests for settling. Default on for `metro` and `rspack`.
   */
  inApp: z.boolean().optional(),
  /** Platforms whose main bundle is built ahead of the device asking. Default `['android']`. */
  platforms: z.array(z.enum(['android', 'ios'])).optional(),
  /** Main bundle path for prewarming when it cannot be discovered (`/index.bundle?platform={platform}&dev=true`). */
  bundlePath: z.string().optional(),
  startTimeout: z.number().positive().optional(),
});

export const configSchema = z.object({
  app: z
    .object({
      android: z.string().optional(),
      apple: z.string().optional(),
      scheme: z.string().optional(),
      /**
       * Link that points the app at the dev server, for `qr` and for `open` without a target:
       * `{devserver}` (URL-encoded http://host:port), `{host}`, `{port}`. Default: pitbox's own connect link
       * (`pitbox.<android id>://connect?devserver=host:port`), handled by the connect library in debug builds.
       */
      connect: z.string().optional(),
    })
    .optional(),
  /** Shell for project commands: `bash` (default; Git Bash on Windows), `sh`, `cmd` or a path. */
  shell: z.string().optional(),
  services: z.record(z.string(), serviceSchema).optional(),
  /** The JS dev server, run behind pitbox's proxy with a native watcher, prewarming and optional bytecode. */
  devserver: devserverSchema.optional(),
  actors: z.record(z.string(), actorSchema).optional(),
  tools: z.record(z.string(), toolSchema).optional(),
  mocks: z
    .object({
      llm: z
        .object({
          port: z.number().int().positive(),
          /** JSON file or directory of JSON files: `[{match: "regex", reply: "text"}]`. */
          fixtures: z.string().optional(),
        })
        .optional(),
    })
    .optional(),
  android: z
    .object({
      /** Default emulator for `boot`. */
      avd: z.string().optional(),
      /** Extra host ports to forward besides the services' `expose`. */
      reverse: z.array(z.number().int().positive()).optional(),
      /**
       * How exposed ports reach devices: `reverse` (adb reverse), `relay` (pitbox runner on the emulator pipes to
       * the host alias 10.0.2.2), `auto` (default: adb reverse, switching an emulator to the relay when its forwards
       * stop carrying data).
       */
      forward: z.enum(['auto', 'reverse', 'relay']).optional(),
    })
    .optional(),
  /** Directory of `.flow` files. Default `flows`. */
  flows: z.string().optional(),
  /** Deep link templates for `goto`: `{item: 'myapp://item/{id}'}`. */
  routes: z.record(z.string(), z.string()).optional(),
  /** Flow that signs a user in for `as <user>`; it gets `${user}`. */
  signIn: z.string().optional(),
  /** Named documents for `docs`: `{check: 'CHECK.md'}`. */
  docs: z.record(z.string(), z.string()).optional(),
  /** Module whose default export is an array of extra doctor rules. */
  doctor: z.string().optional(),
});

export type ServiceConfig = z.infer<typeof serviceSchema>;
export type DevserverConfig = z.infer<typeof devserverSchema>;
export type ActorConfig = z.infer<typeof actorSchema>;
export type ToolConfig = z.infer<typeof toolSchema>;
export type PitboxConfig = z.infer<typeof configSchema>;

/** Identity helper that gives a config file type checking and completion. */
export const defineConfig = (config: PitboxConfig): PitboxConfig => config;

export const asArray = (value: number | number[] | undefined): number[] => (value === undefined ? [] : Array.isArray(value) ? value : [value]);

/** Every host port the device side needs, deduplicated. */
export const exposedPorts = (config: PitboxConfig): number[] => {
  const all = [
    ...Object.values(config.services ?? {}).flatMap(s => asArray(s.expose)),
    ...(config.devserver ? [config.devserver.port ?? 8081] : []),
    ...(config.android?.reverse ?? []),
    ...(config.mocks?.llm ? [config.mocks.llm.port] : []),
  ];
  return [...new Set(all)].sort((a, b) => a - b);
};

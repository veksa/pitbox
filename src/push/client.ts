// `@veksa/pitbox/push`: what a project's server calls in its local environment to send a push through the
// stand's push gateway (`mocks.push` in pitbox.config.ts) instead of APNs or FCM. No dependencies: it is only
// a fetch to the gateway, which delivers to the running simulator or emulator.

export type PitboxPush = {
  /** The device token the app registered, if it has one; it picks the device when tokens are bound. */
  token?: string;
  /** A device by name, serial or udid; default: from the token, else the only one online. */
  device?: string;
  /** Package or bundle id; default: the app in pitbox.config.ts. */
  app?: string;
  /** An APNs payload ({aps, …custom}) with its request headers (apns-collapse-id, apns-push-type…). */
  apns?: Record<string, unknown>;
  headers?: Record<string, string>;
  /** An FCM message, as firebase-admin's send() or the HTTP v1 API takes it. */
  fcm?: Record<string, unknown>;
  /** Or the simple form. */
  title?: string;
  body?: string;
  data?: Record<string, unknown>;
  badge?: number;
  sound?: string;
  silent?: boolean;
};

export type PitboxPushResult = {
  ok: boolean;
  id: string;
  platform: 'android' | 'apple';
  device: string;
  app: string;
  /** What the device showed: "notification posted …", "banner shown …", "delivered with the app in front …". */
  verdict: string;
};

/** The gateway's address: `PITBOX_PUSH_URL`, else the default port. */
export const pitboxPushUrl = (): string => process.env.PITBOX_PUSH_URL ?? 'http://127.0.0.1:4980';

/**
 * Sends one push through the stand. Rejects when the gateway is not running or the push could not be delivered;
 * a push the device took but did not show (the app in front) resolves with `ok: true` and says so in `verdict`.
 */
export const sendToPitbox = async (push: PitboxPush, opts: {url?: string; timeoutMs?: number} = {}): Promise<PitboxPushResult> => {
  const url = (opts.url ?? pitboxPushUrl()).replace(/\/+$/, '');
  let res: Response;
  try {
    res = await fetch(`${url}/push`, {
      method: 'POST',
      headers: {'content-type': 'application/json'},
      body: JSON.stringify(push),
      signal: AbortSignal.timeout(opts.timeoutMs ?? 15_000),
    });
  } catch (e) {
    throw new Error(`pitbox push gateway at ${url} does not answer (${(e as Error).message}) — is the stand up with mocks.push in pitbox.config.ts?`);
  }
  const body = (await res.json().catch(() => ({}))) as Partial<PitboxPushResult>;
  if (!res.ok || !body.ok) throw new Error(`pitbox push failed: ${body.verdict ?? `HTTP ${res.status}`}`);
  return body as PitboxPushResult;
};

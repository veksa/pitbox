// A backend's push transport in its local environment, as the examples' reference: the same FCM HTTP v1 request a
// server sends to Google, aimed at the stand's push gateway (`mocks.push` in pitbox.config.ts), which delivers it to
// the running emulator or simulator. A real server swaps only the origin (or calls sendToPitbox from
// `@veksa/pitbox/push`).
//
//   node ../stand/push.mjs "Title" "Body" [link]

const [title = 'Hello', body = 'From the stand', link] = process.argv.slice(2);
const gateway = process.env.PITBOX_PUSH_URL ?? 'http://127.0.0.1:4980';

const res = await fetch(`${gateway}/v1/projects/example/messages:send`, {
  method: 'POST',
  headers: {'content-type': 'application/json'},
  body: JSON.stringify({
    message: {
      // Any token: the gateway sends to the device that is online (or the one `pitbox push bind` named).
      token: 'example-device-token',
      notification: {title, body},
      data: link ? {link} : {},
      android: {priority: 'high'},
      apns: {payload: {aps: {sound: 'default'}}},
    },
  }),
});
console.log(res.status, res.headers.get('x-pitbox-verdict') ?? (await res.text()));

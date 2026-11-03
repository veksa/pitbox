// The React Native example's checks, shared by `yarn e2e` (an Android phone) and `yarn e2e:apple` (an iPhone
// simulator): the flows, the in-app channel, the JS runtime, perf and the hot-update loop. `rn` runs the pitbox
// CLI in examples/react-native and returns {code, out}; `device` names the device; `platform` is android | apple.

import fs from 'node:fs';
import path from 'node:path';

const head = (out, n = 6) => console.log(out.split('\n').slice(0, n).join('\n'));

export const rnChecks = ({rn, device, rnDir, platform}) => {
  const checks = [];
  const on = args => rn([...args, '--device', device]);
  const steps = text => rn(['run', '--steps', text, '--device', device]);
  const check = (name, ok) => checks.push({name, ok: !!ok});

  // iOS has no back key: its smoke flow closes the detail screen by pressing it.
  const smoke = on(['run', platform === 'apple' ? 'smoke-ios' : 'smoke']);
  head(smoke.out);
  check('smoke', smoke.code === 0 && smoke.out.startsWith('✓'));
  const fresh = rn(['fresh']);
  head(fresh.out, 3);
  check('fresh bundle', /runs the newest bundle/.test(fresh.out));
  check('network log', /localhost:4100\/hello/.test(rn(['app-log', '-n', '50']).out));

  const err = on(['run', 'js-error']);
  head(err.out, 8);
  check('js error with its source line', err.out.startsWith('✓') && /! JS error: example js error/.test(err.out) && /App\.tsx:\d+:\d+/.test(err.out));
  const errors = rn(['app-errors', '-n', '3']);
  head(errors.out, 3);
  check('app errors keep it, mapped to the source', /example js error/.test(errors.out) && /App\.tsx:\d+/.test(errors.out));

  const greet = on(['run', 'console']);
  head(greet.out, 2);
  const warned = rn(['app-console', '--level', 'warn']);
  head(warned.out, 3);
  check('console warning with its source line', greet.code === 0 && /W {2}greeting without a name {2}← greet {2}App\.tsx:\d+:\d+/.test(warned.out));

  // The React tree from inside the app: the form's testIDs are in it.
  const tree = rn(['app-tree']);
  head(tree.out, 4);
  check('in-app react tree', tree.code === 0 && /\bname\b/.test(tree.out) && /\bgreet\b/.test(tree.out));

  // A rule on the dev server's network hooks: the stand's answer is replaced inside the app's HTTP client.
  rn(['net', 'mock', '/hello', '--body', 'mocked by pitbox']);
  const mocked = rn(['run', '--steps', 'press id=fetch\nwait text~="mocked by pitbox" 10', '--device', device]);
  head(mocked.out, 3);
  // The first matching rule wins: the mock goes before the failure is set.
  rn(['net', 'clear']);
  rn(['net', 'fail', '/hello', '--status', '503']);
  const failed = rn(['run', '--steps', 'press id=fetch\nwait text~="503 from pitbox" 10', '--device', device]);
  head(failed.out, 3);
  rn(['net', 'clear']);
  check('net mock and fail reach the app', mocked.code === 0 && failed.code === 0);

  // The example's Work hard button runs a slow function: the JS profile must name it, in the app's code.
  // Typing first: the name is Main's state, so React's commits must name Main and why it rendered.
  on(['perf', 'reset']);
  on(['fill', 'id=name', 'Perf']);
  on(['press', 'id=busy']);
  const perf = on(['perf']);
  head(perf.out.split('\n').filter(l => /JS thread|workHard|React:|Main —|heap/.test(l)).join('\n'), 6);
  check('js profile names the slow app function', /app code, with what it called:(\n {4}\s*\d+ ms {2}\S.*)*?\n {4}\s*\d+ ms {2}workHard {2}App\.tsx:\d+/.test(perf.out));
  check('react commits name a component and why it rendered', /React: \d+ commits?/.test(perf.out) && /\d+× +[\d.]+ ms {2}Main — state/.test(perf.out));
  const budgets = on(['run', 'perf']);
  head(budgets.out, 3);
  check('perf budgets in a flow', budgets.code === 0 && /perf: js \d+ms ✓/.test(budgets.out));

  if (platform === 'android') {
    // The platform trace over a scroll: the app's main thread and its render thread are in it.
    on(['perf', 'reset', 'trace']);
    on(['swipe', 'up']);
    const traced = on(['perf']);
    head(traced.out.split('\n').filter(l => l.startsWith('platform trace')).join('\n'), 1);
    check('platform trace of the app', /platform trace [\d.]+s: .*\bmain \d+ ms/.test(traced.out) && /RenderThread \d+ ms/.test(traced.out));
  } else {
    // No platform trace on a simulator: said so, not left out silently.
    const traced = on(['perf', 'reset', 'trace']);
    head(traced.out, 2);
    check('no platform trace is reported, not hidden', /no platform trace on Apple simulators/.test(traced.out));
    on(['swipe', 'up']);
    on(['perf']);
  }

  // An edit reaches the app as a hot update (the app runs bytecode), and a broken edit comes back as text.
  // The title is back on screen first: the swipe above scrolled the list.
  on(['scroll', 'up', 'until', 'id=title']);
  const appFile = path.join(rnDir, 'App.tsx');
  const appSource = fs.readFileSync(appFile, 'utf8');
  try {
    fs.writeFileSync(appFile, appSource.replace(/(testID="title"[^>]*>\s*)pitbox example/, '$1pitbox example, edited'));
    const title = on(['wait', 'text=pitbox example, edited', '--timeout', '15']);
    const hotFresh = rn(['fresh']);
    head(hotFresh.out, 2);
    // Fresh either way: on the newest bundle with the update on top, or on the bundle the update was rebuilt into.
    check('an edit arrives as a hot update', title.code === 0 && /^✓ app \d+ \(\w+\) runs the newest (code|bundle).* · [1-9]\d* hot updates?/m.test(hotFresh.out));
    fs.writeFileSync(appFile, appSource.replace(/(testID="title"[^>]*>\s*)pitbox example/, '$1pitbox example {{'));
    const broken = rn(['fresh']);
    head(broken.out, 3);
    check('a broken edit comes back as text', /the last edit did not compile/.test(broken.out) && /SyntaxError: App\.tsx/.test(broken.out));
  } finally {
    fs.writeFileSync(appFile, appSource);
  }
  on(['wait', 'text=pitbox example', '--timeout', '15']);

  const ev = rn(['js', 'eval', 'Promise.resolve(40 + 2)']);
  head(ev.out, 2);
  check('js eval', /^= 42/.test(ev.out));
  // A logpoint on the Greet button's line, which runs on every render: it must see the typed name.
  const greetLine = appSource.split('\n').findIndex(l => l.includes('testID="greet"')) + 1;
  const lp = rn(['js', 'log', `App.tsx:${greetLine}`, 'name']);
  head(lp.out, 2);
  on(['fill', 'id=name', 'Logpoint']);
  const hits = rn(['js', 'hits', '-n', '3']);
  head(hits.out, 4);
  check('logpoint sees a local', lp.code === 0 && /"Logpoint"/.test(hits.out));
  rn(['js', 'clear']);

  // The trace of the last action: the app stamped its request with a traceparent, the stand logged its id.
  steps('open!\nwait id=title 90\npress id=fetch\nwait text~="hello from the stand" 10');
  const trace = rn(['trace']);
  head(trace.out, 3);
  check('the trace of an action reaches the stand log', /^trace [0-9a-f]{32}/.test(trace.out) && /GET \/hello trace=[0-9a-f]{32}/.test(trace.out));

  // The dev server's own commands: its status, the connect link as a QR, a reload of the app.
  const status = rn(['dev', 'status']);
  head(status.out, 2);
  const qr = rn(['qr']);
  check('dev status and the connect QR', status.code === 0 && /devserver|metro|:8095/.test(status.out) && /qr image: .*\.png/.test(qr.out) && /8095/.test(qr.out));
  const reload = rn(['dev', 'reload']);
  check('a reload reaches the app', /reload sent/.test(reload.out) && on(['wait', 'id=title', '--timeout', '30']).code === 0);

  // More network rules: a slow answer and no network at all, inside the app's HTTP client.
  rn(['net', 'delay', '/hello', '--ms', '1500']);
  const slow = steps('press id=fetch\nwait text~="hello from the stand" 10');
  const slowLog = rn(['app-log', '-n', '3']).out;
  rn(['net', 'clear']);
  rn(['net', 'offline']);
  const offline = steps('press id=fetch\nwait text~="failed" 10');
  rn(['net', 'clear']);
  check('net delay and offline reach the app', slow.code === 0 && /\/hello → 200 in (1[5-9]\d\d|[2-9]\d{3}) ms/.test(slowLog) && offline.code === 0, slowLog.split('\n').slice(-1)[0]);
  return checks;
};

/**
 * A build with the bundle inside (`dev embed`), installed and run with no dev server in the loop. Android only:
 * the example's embed command is its Gradle build.
 */
export const rnEmbedChecks = ({rn, device, apk, install}) => {
  const embed = rn(['dev', 'embed'], {timeout: 1_200_000});
  console.log(embed.out.split('\n').slice(0, 3).join('\n'));
  const built = /✓ android: \w+ \d+ KB/.test(embed.out) && /✓ build in/.test(embed.out);
  install(apk);
  rn(['down', 'devserver']);
  const run = rn(['run', '--steps', 'open!\nwait id=title 60\npress id=greet\nexpect text="Hello, stranger"', '--device', device]);
  console.log(run.out.split('\n').slice(0, 2).join('\n'));
  rn(['up', 'devserver'], {timeout: 900_000});
  return [{name: 'an embedded build runs with no dev server', ok: built && run.code === 0}];
};

// What a native example checks around its flows, on an Android phone (`yarn e2e`) and an iPhone simulator
// (`yarn e2e:apple`): the device and app commands, settings, snapshots and images, recording, named states, the
// matrix, signing in, the stand (services, the LLM mock, actors, project tools), doctor, docs, init and the MCP
// server. `pitbox` runs the CLI in the example's directory and returns {code, out}; `dir` is that directory.

import fs from 'node:fs';
import path from 'node:path';
import {Client} from '@modelcontextprotocol/sdk/client/index.js';
import {StdioClientTransport} from '@modelcontextprotocol/sdk/client/stdio.js';

const head = (out, n = 3) => console.log(out.split('\n').slice(0, n).join('\n'));

export const featureChecks = async ({pitbox, device, dir, platform, bin}) => {
  const checks = [];
  const android = platform === 'android';
  const on = args => pitbox([...args, '--device', device]);
  const check = (name, ok, note) => checks.push({name, ok: !!ok, ...(ok || !note ? {} : {note})});
  const steps = text => on(['run', '--steps', text]);
  const fresh = () => steps('open!\nwait id=title 30');

  // ---- the device and the app ----
  const info = on(['info']);
  head(info.out, 2);
  check('info names the model', /model: \S/.test(info.out));
  check('apps lists the example', /dev\.pitbox\.example/.test(on(['apps', 'pitbox']).out));
  const status = pitbox(['status']);
  head(status.out, 3);
  check('status shows the stand and the LLM mock', /✓ stand\s+up/.test(status.out) && /✓ llm-mock :4010/.test(status.out));
  check('a service log', pitbox(['logs', 'stand', '-n', '5']).out.split('\n').length >= 1 && pitbox(['logs', 'stand', '-n', '5']).code === 0);
  check('project tools are listed', /reset\(\)/.test(pitbox(['tools']).out));
  if (android) {
    const rev = pitbox(['reverse']);
    head(rev.out, 1);
    check('the stand ports reach the device', /forwarded to devices: .*4100/.test(rev.out));
  }

  fresh();
  const snap = on(['snapshot']);
  check('snapshot lists the screen with refs', /@e\d+ .*#title/.test(snap.out));

  // ---- input beyond a tap ----
  const menu = steps('longpress id=menu_target\npress text="Copy"\nexpect text="copied"');
  head(menu.out, 2);
  check('a long press opens the context menu', menu.code === 0);
  if (android) {
    const dbl = steps('doubletap id=greet\nexpect text="Hello, stranger"');
    check('a double tap', dbl.code === 0);
  }
  const typed = steps('fill id=name "Al"\ntype "ice"\npress id=greet\nexpect text="Hello, Alice"');
  head(typed.out, 2);
  check('type appends to the field fill wrote', typed.code === 0);
  if (android) {
    const touch = steps('touch down id=greet\ntouch move id=fetch\ntouch up');
    check('a finger held across steps', touch.code === 0);
    check('focus answers', /input focus:/.test(on(['focus']).out));
  } else {
    // XCUITest has no finger to hold: said so, not faked.
    check('a held finger is refused on Apple, not faked', /cannot hold a finger/.test(on(['touch', 'down', 'id=greet']).out));
  }

  // ---- images ----
  fresh();
  const shot = on(['shot', 'features']);
  const size = /\((\d+)×(\d+), \d+ KB\)/.exec(shot.out);
  check('a downscaled shot', !!size && Number(size[1]) > 100);
  const png = on(['screenshot']);
  check('a full screenshot', /\.png \(\d+ KB\)/.test(png.out));
  const name = `features-${platform}`;
  // A baseline is its grid and two images; all of them go afterwards.
  const visualDir = path.join(dir, 'visual');
  const dropBaseline = () => fs.existsSync(visualDir) && fs.readdirSync(visualDir).filter(f => f.startsWith(`${name}.`)).forEach(f => fs.rmSync(path.join(visualDir, f), {force: true}));
  dropBaseline();
  try {
    const first = on(['visual', name]);
    const same = on(['visual', name]);
    on(['goto', 'detail', 'id=7']);
    on(['wait', 'text=Detail 7', '--timeout', '10']);
    const other = on(['visual', name]);
    head(other.out, 2);
    check('a visual baseline is stored, matched, and tells another screen apart', /baseline saved/.test(first.out) && /^matches/.test(same.out) && !/^matches/.test(other.out));
  } finally {
    dropBaseline();
  }
  fresh();
  const media = on(['media']);
  check('media sees a still screen', /not moving/.test(media.out));

  // ---- settings ----
  const dark = on(['settings', 'dark=true']);
  const darkOn = android ? steps('open!\nwait id=title 30\nexpect text~="night"') : on(['info']);
  check('dark mode reaches the app', /dark on/.test(dark.out) && (android ? darkOn.code === 0 : /appearance: dark/.test(darkOn.out)));
  const scale = on(['settings', 'fontScale=1.3', 'locale=fr-FR']);
  const back = on(['settings', 'dark=false', 'fontScale=1', 'locale=en-US']);
  head(back.out, 2);
  check('font scale and locale are set and put back', scale.code === 0 && back.code === 0 && /locale en-US/.test(back.out));
  if (android) {
    on(['network', 'offline']);
    const offline = steps('open!\nwait id=title 30\npress id=fetch\nwait text~="failed" 15');
    on(['network', 'online']);
    head(offline.out, 2);
    check('the network goes offline and comes back', offline.code === 0 && steps('press id=fetch\nwait text~="hello from the stand" 15').code === 0);
  } else {
    check('the network is refused on a simulator, with the way that works', /shares the Mac's network/.test(on(['network', 'offline']).out));
  }

  // ---- the app's life ----
  fresh();
  on(['stop-app']);
  const stopped = on(['app-logs', '-n', '5']);
  const opened = on(['open']);
  check('stop, open and the app log', opened.code === 0 && stopped.code === 0);
  on(['clear-app']);
  check('clear-app', fresh().code === 0);

  // ---- recording, named states, the matrix, signing in ----
  const recorded = path.join(dir, 'flows', 'e2e-recorded.flow');
  fs.rmSync(recorded, {force: true});
  try {
    fresh();
    on(['record', 'start']);
    on(['fill', 'id=name', 'Rec']);
    on(['press', 'id=greet']);
    const saved = on(['record', 'stop', 'e2e-recorded']);
    const text = fs.existsSync(recorded) ? fs.readFileSync(recorded, 'utf8') : '';
    const replay = on(['run', 'e2e-recorded']);
    check('a recorded session becomes a flow that replays', /saved .*e2e-recorded\.flow/.test(saved.out) && /fill id=name "Rec"/.test(text) && /press id=greet/.test(text) && replay.code === 0);
    check('a recorded press is followed by the check of its outcome', /press id=greet\nexpect (id=greeting|text="Hello, Rec")/.test(text), text);
  } finally {
    fs.rmSync(recorded, {force: true});
  }

  // ---- writing and fixing flows ----
  fresh();
  const byWords = on(['press', 'greet']);
  head(byWords.out, 3);
  check('an action given plain words answers with its step and outcome', /step: press id=greet\n\s+expect (id=greeting|text="Hello, )/.test(byWords.out), byWords.out);
  const miss = on(['press', 'id=gret']);
  check('a selector that misses names the closest control', /nothing matches "id=gret" — closest: @e\d+ .*#greet → id=greet/.test(miss.out), miss.out);
  const broken = steps('open!\nwait id=title 30\npress id=gret');
  head(broken.out, 3);
  check('a broken flow suggests the fixed step', broken.code !== 0 && /fix\? line 3: press id=greet/.test(broken.out), broken.out);
  const resumed = on(['run', '--steps', 'press id=gret\nfill id=name "Bo"\npress id=greet\nexpect text="Hello, Bo"', '--from', '2']);
  check('a flow resumes from a line', resumed.code === 0, resumed.out);
  steps('open!\nwait id=title 30\ntool reset\npress id=fetch\nwait text~="#1" 10');
  const save = on(['state', 'save', 'e2e']);
  head(save.out, 1);
  steps('press id=fetch\nwait text~="#2" 10');
  const restore = on(['state', 'restore', 'e2e']);
  const hits = pitbox(['tool', 'hits']);
  check('a named state brings the backend back', save.code === 0 && restore.code === 0 && /\b1\b/.test(hits.out.split('\n').pop() ?? ''), `${save.out.split('\n')[0]} / ${restore.out.split('\n')[0]}`);
  on(['state', 'rm', 'e2e']);
  const signIn = on(['as', 'Ada']);
  check('as <user> runs the sign-in flow', signIn.code === 0 && signIn.out.startsWith('✓'));
  const matrix = pitbox(['matrix', 'matrix', '--device', device]);
  head(matrix.out, 1);
  check('the matrix runs every variant', /^4\/4 variants passed/.test(matrix.out), matrix.out.split('\n').find(l => l.startsWith('✗')));

  // ---- the LLM mock ----
  const chat = async prompt => {
    const t0 = Date.now();
    const r = await fetch('http://127.0.0.1:4010/v1/chat/completions', {method: 'POST', headers: {'content-type': 'application/json'}, body: JSON.stringify({model: 'm', messages: [{role: 'user', content: prompt}]})});
    const body = await r.json().catch(() => ({}));
    return {status: r.status, text: body.choices?.[0]?.message?.content ?? '', ms: Date.now() - t0};
  };
  pitbox(['llm', 'clear']);
  const count = () => Number(/· (\d+) requests?/.exec(pitbox(['llm', 'log', '-n', '1']).out)?.[1] ?? NaN);
  const before = count();
  const fixture = await chat('please greet me');
  pitbox(['llm', 'reply', 'forced answer', '--once']);
  const forced = await chat('anything');
  const after = await chat('anything');
  pitbox(['llm', 'fail', '429']);
  const failed = await chat('anything');
  pitbox(['llm', 'clear']);
  pitbox(['llm', 'delay', '600']);
  const slow = await chat('anything');
  pitbox(['llm', 'clear']);
  const log = pitbox(['llm', 'log', '-n', '10']);
  head(log.out, 2);
  check('the LLM mock: fixtures, a forced reply once, an error, a delay, the log', fixture.text === 'Hello from the mock' && forced.text === 'forced answer' && /mock reply to/.test(after.text) && failed.status === 429 && slow.ms >= 550 && count() - before === 5, JSON.stringify({fixture, forced, after, failed: failed.status, slow: slow.ms, logged: count() - before}));

  // ---- actors ----
  const started = pitbox(['actor', 'start', 'peer', 'p1']);
  const listed = pitbox(['actors']);
  const called = pitbox(['actor', 'call', 'p1', '{"hi":1}']);
  const stoppedActor = pitbox(['actor', 'stop', 'p1']);
  head(called.out, 2);
  check('an actor starts, answers a call and stops', /✓ actor p1 \(peer\)/.test(started.out) && /p1/.test(listed.out) && /"from":"p1"/.test(called.out) && /stopped actor p1/.test(stoppedActor.out));
  check('a service restarts', pitbox(['restart', 'stand']).code === 0 && /✓ stand\s+up/.test(pitbox(['status']).out));

  // ---- support ----
  const doctor = pitbox(['doctor']);
  head(doctor.out, 2);
  check('doctor finds no failure', doctor.code === 0 && !/^✗/m.test(doctor.out));
  const docs = pitbox(['docs', 'readme', 'grep', 'Flow']);
  check('docs looks a line up in a project document', /docs: readme/.test(pitbox(['docs']).out) && /\| Flow \|/.test(docs.out));
  const init = pitbox(['init', '--dry-run']);
  check('init recognises the project', /found: native .* dev\.pitbox\.example/.test(init.out), init.out.split('\n')[0]);

  // ---- the MCP server, as an agent sees it ----
  const client = new Client({name: 'pitbox-e2e', version: '0'});
  try {
    await client.connect(new StdioClientTransport({command: process.execPath, args: [bin, 'mcp'], cwd: dir}));
    const {tools} = await client.listTools();
    const text = r => (r.content ?? []).map(c => c.text ?? '').join('\n');
    const mStatus = text(await client.callTool({name: 'status', arguments: {}}));
    const mRun = text(await client.callTool({name: 'run', arguments: {device, steps: 'open!\nwait id=title 30\npress id=greet\nexpect text="Hello, stranger"'}}));
    const mSnap = text(await client.callTool({name: 'snapshot', arguments: {device}}));
    console.log(`mcp: ${tools.length} tools · ${mRun.split('\n')[0]}`);
    check('the MCP server lists its tools and drives the device', tools.length >= 20 && tools.some(t => t.name === 'tool_hits') && /stand/.test(mStatus) && mRun.startsWith('✓') && /#title/.test(mSnap));
  } catch (e) {
    check('the MCP server lists its tools and drives the device', false, e.message);
  } finally {
    await client.close().catch(() => undefined);
  }
  return checks;
};

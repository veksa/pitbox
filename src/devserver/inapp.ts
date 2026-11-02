// The in-app side of pitbox for React Native dev bundles, injected by the proxy right after the runtime has
// initialised and before the app's own code runs. No library in the app, no native code.
//
// It tells the daemon which bundle is running (freshness), logs network requests and stamps them with a W3C
// `traceparent`, applies network rules from the daemon (fail, mock, delay; freeze or fail a WebSocket), and
// answers how many requests are in flight (so UI settling can wait for the network too).
//
// Written as plain ES2017 inside a function that is serialised with `toString()`: Hermes runs it as is.

export type InAppConfig = {bundle: string; gen: number; platform: string; http: string; ws: string};

// The body below runs inside the app, not in Node.
/* eslint-disable */
function pitboxInApp(cfg: InAppConfig) {
  var g: any = globalThis as any;
  if (g.__pitbox) return;
  var state: any = {rules: [], trace: null, inflight: 0, last: Date.now(), log: [], sockets: [], frozenAll: false};
  g.__pitbox = state;
  var seq = 0;
  var hex = function (n: number) {
    var s = '';
    for (var i = 0; i < n; i++) s += Math.floor(Math.random() * 16).toString(16);
    return s;
  };
  var traceparent = function () {
    return '00-' + (state.trace || hex(32)) + '-' + hex(16) + '-01';
  };
  var match = function (url: string, kind: string) {
    for (var i = 0; i < state.rules.length; i++) {
      var r = state.rules[i];
      if ((r.kind || 'http') === kind && (r.match === '*' || url.indexOf(r.match) >= 0)) return r;
    }
    return null;
  };
  var record = function (e: any) {
    e.at = Date.now();
    state.log.push(e);
    if (state.log.length > 200) state.log.shift();
  };
  var ours = function (url: string) {
    return url.indexOf(cfg.http) === 0;
  };

  var X = g.XMLHttpRequest;
  if (X && X.prototype) {
    var open = X.prototype.open;
    var send = X.prototype.send;
    X.prototype.open = function (method: string, url: string) {
      var u = String(url);
      var rule = ours(u) ? null : match(u, 'http');
      this.__pb = {id: ++seq, method: method, url: u, rule: rule};
      var args = Array.prototype.slice.call(arguments);
      if (rule && rule.action === 'fail') args[1] = 'http://127.0.0.1:9/pitbox-fail';
      if (rule && rule.action === 'mock') args[1] = cfg.http + '/pitbox/mock/' + rule.id;
      return open.apply(this, args);
    };
    X.prototype.send = function () {
      var xhr = this;
      var pb = xhr.__pb;
      var args = arguments;
      if (!pb || (ours(pb.url) && !pb.rule)) return send.apply(xhr, args);
      try {
        xhr.setRequestHeader('traceparent', traceparent());
      } catch (e) {}
      state.inflight++;
      state.last = Date.now();
      var t0 = Date.now();
      xhr.addEventListener('loadend', function () {
        state.inflight--;
        state.last = Date.now();
        record({id: pb.id, m: pb.method, url: pb.url, s: xhr.status, ms: Date.now() - t0, rule: pb.rule ? pb.rule.action : undefined});
      });
      if (pb.rule && pb.rule.action === 'delay') {
        setTimeout(function () {
          send.apply(xhr, args);
        }, pb.rule.ms || 2000);
        return;
      }
      return send.apply(xhr, args);
    };
  }

  var W = g.WebSocket;
  if (W) {
    var Patched: any = function (url: string, protocols: any, options: any) {
      var u = String(url);
      var rule = match(u, 'ws');
      var ws = new W(rule && rule.action === 'fail' ? 'ws://127.0.0.1:9/pitbox-fail' : url, protocols, options);
      var entry: any = {url: u, ws: ws, frozen: !!(rule && rule.action === 'freeze')};
      state.sockets.push(entry);
      record({ws: u, ev: 'connect', rule: rule ? rule.action : undefined});
      var origSend = ws.send.bind(ws);
      ws.send = function (data: any) {
        if (entry.frozen || state.frozenAll) return;
        return origSend(data);
      };
      // A frozen socket stays open and silent: messages are dropped, and nobody hears a close.
      var dispatch = ws.dispatchEvent.bind(ws);
      ws.dispatchEvent = function (ev: any) {
        if ((entry.frozen || state.frozenAll) && ev && ev.type === 'message') return true;
        if (ev && (ev.type === 'close' || ev.type === 'error')) record({ws: u, ev: ev.type});
        return dispatch(ev);
      };
      return ws;
    };
    Patched.prototype = W.prototype;
    ['CONNECTING', 'OPEN', 'CLOSING', 'CLOSED'].forEach(function (k) {
      Patched[k] = W[k];
    });
    g.WebSocket = Patched;
  }

  var connect = function (delay: number) {
    var ch: any;
    try {
      ch = new W(cfg.ws);
    } catch (e) {
      return;
    }
    ch.onopen = function () {
      ch.send(JSON.stringify({type: 'hello', bundle: cfg.bundle, gen: cfg.gen, platform: cfg.platform, startedAt: Date.now()}));
    };
    ch.onmessage = function (ev: any) {
      var msg: any;
      try {
        msg = JSON.parse(ev.data);
      } catch (e) {
        return;
      }
      if (msg.type === 'rules') {
        state.rules = msg.rules || [];
        state.frozenAll = false;
        for (var i = 0; i < state.sockets.length; i++) {
          var s = state.sockets[i];
          var r = match(s.url, 'ws');
          s.frozen = !!(r && r.action === 'freeze');
        }
      } else if (msg.type === 'trace') {
        state.trace = msg.id || null;
      } else if (msg.type === 'query') {
        var data: any = msg.what === 'log' ? state.log.slice(-(msg.limit || 30)) : {inflight: state.inflight, quietMs: Date.now() - state.last, sockets: state.sockets.length};
        ch.send(JSON.stringify({type: 'reply', reqId: msg.reqId, data: data}));
      }
    };
    ch.onclose = function () {
      setTimeout(function () {
        connect(Math.min(delay * 2, 10000));
      }, delay);
    };
  };
  connect(1000);
}
/* eslint-enable */

/** The script with its config inlined, ready to splice into a bundle. */
export const inAppScript = (cfg: InAppConfig): string => `;(${pitboxInApp.toString()})(${JSON.stringify(cfg)});\n`;

/**
 * Splices the script in front of the bundle's last module call (the app entry), after the runtime's own
 * initialisation (which defines XMLHttpRequest and WebSocket). Appended at the end when the shape is unknown.
 */
export const injectInApp = (source: Buffer, script: string): Buffer => {
  const text = source.toString('utf8');
  const tail = text.lastIndexOf('\n__r(');
  if (tail < 0) return Buffer.from(`${text}\n${script}`);
  return Buffer.from(`${text.slice(0, tail + 1)}${script}${text.slice(tail + 1)}`);
};

// The in-app side of pitbox for React Native dev bundles, injected by the proxy right after the runtime has
// initialised and before the app's own code runs. No library in the app, no native code.
//
// It tells the daemon which bundle is running (freshness), logs network requests and stamps them with a W3C
// `traceparent`, applies network rules from the daemon (fail, mock, delay; freeze or fail a WebSocket), and
// answers how many requests are in flight (so UI settling can wait for the network too). JS errors that reach
// the global handler go to the daemon with their raw stack, which the proxy symbolicates. The app's console is
// kept in a ring (warnings and errors with the stack of the call), so what was logged before anyone asked —
// at startup, during a flow — is still there.
//
// Written as plain ES2017 inside a function that is serialised with `toString()`: Hermes runs it as is.

import {pitboxFmt} from './valuefmt.ts';

export type InAppConfig = {
  bundle: string;
  gen: number;
  platform: string;
  http: string;
  ws: string;
  /** Served as source for sure (with bytecode on, a source answer may also be bytecode that was not ready yet). */
  fromSource?: boolean;
};

// The body below runs inside the app, not in Node.
/* eslint-disable */
function pitboxInApp(cfg: InAppConfig, fmt: (v: any, depth?: number, seen?: any[]) => string) {
  var g: any = globalThis as any;
  if (g.__pitbox) return;
  var scriptStart = Date.now();
  var state: any = {rules: [], trace: null, inflight: 0, last: Date.now(), log: [], sockets: [], frozenAll: false, errors: [], ch: null, fromSource: !!cfg.fromSource, console: [], consoleSeq: 0};
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
      // A failure with a status is an HTTP answer with it; without one, the connection fails.
      if (rule && rule.action === 'fail') args[1] = rule.status ? cfg.http + '/pitbox/mock/' + rule.id : 'http://127.0.0.1:9/pitbox-fail';
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

  // Errors are seen before whichever handler the app installs (LogBox, a crash reporter), and passed on.
  var report = function (e: any, fatal: boolean) {
    var msg = {type: 'error', message: String((e && e.message) || e), name: e && e.name, stack: e && typeof e.stack === 'string' ? e.stack : '', fatal: !!fatal, at: Date.now()};
    var ch = state.ch;
    if (ch && ch.readyState === 1) ch.send(JSON.stringify(msg));
    else if (state.errors.length < 20) state.errors.push(msg);
  };
  var EU = g.ErrorUtils;
  if (EU && EU.setGlobalHandler && EU.getGlobalHandler) {
    var wrap = function (h: any) {
      return function (e: any, fatal: boolean) {
        try {
          report(e, fatal);
        } catch (x) {}
        if (h) return h(e, fatal);
      };
    };
    var setHandler = EU.setGlobalHandler;
    setHandler.call(EU, wrap(EU.getGlobalHandler()));
    EU.setGlobalHandler = function (h: any) {
      return setHandler.call(EU, wrap(h));
    };
  }

  // Wrapped on top of whatever the runtime installed (LogBox), so the app's own calls come here first.
  var C = g.console;
  var printf = function (args: any[]) {
    var first = args[0];
    var rest = args.slice(1);
    var head = '';
    if (typeof first === 'string' && /%[sdifoOjc]/.test(first) && rest.length) {
      head = first.replace(/%([sdifoOjc%])/g, function (m: string, k: string) {
        if (k === '%') return '%';
        if (!rest.length) return m;
        var a = rest.shift();
        if (k === 'c') return '';
        if (k === 's') return typeof a === 'string' ? a : fmt(a, 1);
        if (k === 'd' || k === 'i') return String(parseInt(a, 10));
        if (k === 'f') return String(parseFloat(a));
        return fmt(a, 1);
      });
    } else if (args.length) {
      head = typeof first === 'string' ? first : fmt(first, 1);
    }
    var parts = [head];
    for (var i = 0; i < rest.length; i++) parts.push(typeof rest[i] === 'string' ? rest[i] : fmt(rest[i], 1));
    return parts.join(' ');
  };
  if (C) {
    ['debug', 'log', 'info', 'warn', 'error'].forEach(function (level) {
      var orig = C[level];
      if (typeof orig !== 'function') return;
      C[level] = function () {
        try {
          var m = printf(Array.prototype.slice.call(arguments));
          var e: any = {n: ++state.consoleSeq, l: level, at: Date.now(), m: m.length > 2000 ? m.slice(0, 2000) + '…' : m};
          if (level === 'warn' || level === 'error') e.stack = new Error().stack;
          state.console.push(e);
          if (state.console.length > 300) state.console.shift();
        } catch (x) {}
        return orig.apply(this, arguments);
      };
    });
  }

  // From React Native 0.80 a debug build sends warnings to the debugger and shows, on the first one, a toast
  // ("Open debugger to view warnings.") over the bottom of every screen until someone closes it: a tab bar or a
  // send button under it takes no taps, and the tap that lands on it tries to open a debugger. The warnings are
  // in the console ring above, so the toast tells nothing pitbox does not; LogBox's own ignore list keeps it away
  // (its message is checked against that list before it is shown). Errors and red screens are left as they are.
  var quietLogBox = function () {
    var r = g.__r;
    var mods = r && typeof r.getModules === 'function' ? r.getModules() : null;
    if (!mods || typeof mods.forEach !== 'function') return;
    var id: any = null;
    mods.forEach(function (m: any, k: any) {
      if (id === null && m && m.isInitialized && /(^|[\\/])Libraries[\\/]LogBox[\\/]LogBox\.js$/.test(m.verboseName || '')) id = k;
    });
    if (id === null) return;
    var mod = r(id);
    var LogBox = mod && (mod.default || mod);
    if (LogBox && typeof LogBox.ignoreLogs === 'function') LogBox.ignoreLogs(['Open debugger to view warnings.']);
  };
  try {
    quietLogBox();
  } catch (x) {}

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

  // The React tree as the app renders it, through the dev tools hook React Native installs in development:
  // host components with a testID, an accessibility label or text. Reaches what accessibility does not (panels
  // outside the accessibility tree, views marked not important).
  var reactTree = function (limit: number) {
    var hook = g.__REACT_DEVTOOLS_GLOBAL_HOOK__;
    if (!hook || !hook.getFiberRoots || !hook.renderers) return {error: 'no React dev tools hook in this bundle'};
    var out: any[] = [];
    var textOf = function (fiber: any): string {
      var p = fiber.memoizedProps;
      if (typeof p === 'string' || typeof p === 'number') return String(p);
      if (p && (typeof p.children === 'string' || typeof p.children === 'number')) return String(p.children);
      var s = '';
      for (var c = fiber.child; c && s.length < 120; c = c.sibling) s += textOf(c);
      return s;
    };
    var walk = function (fiber: any, depth: number, surface: number) {
      for (var f = fiber; f && out.length < limit; f = f.sibling) {
        var p = f.memoizedProps || {};
        if (typeof f.type === 'string') {
          var id = p.testID || p.nativeID;
          var label = p.accessibilityLabel || p['aria-label'];
          var isText = /Text$/.test(f.type);
          var text = isText ? textOf(f) : '';
          if (id || label || text) out.push({s: surface, d: depth, c: f.type.replace(/^RCT/, ''), id: id, l: label, t: text || undefined, hidden: p.accessibilityElementsHidden || p.importantForAccessibility === 'no-hide-descendants' || undefined});
          if (isText) continue;
        }
        if (f.child) walk(f.child, depth + (typeof f.type === 'string' ? 1 : 0), surface);
      }
    };
    var surface = 0;
    hook.renderers.forEach(function (_r: any, rid: any) {
      var roots = hook.getFiberRoots(rid);
      if (roots) roots.forEach(function (root: any) {
        walk(root.current && root.current.child, 0, surface++);
      });
    });
    return {surfaces: surface, nodes: out, truncated: out.length >= limit};
  };

  // React commits while a measurement runs: which components rendered, their own time, and why. Wrapped on the
  // dev tools hook when the measurement starts, so the wrapper sits above anything installed since. Durations
  // come from React's profiling timers, on whenever the hook is present (development).
  var rec: any = null;
  var nameOf = function (t: any): string {
    if (!t) return 'Anonymous';
    if (typeof t === 'function') return t.displayName || t.name || 'Anonymous';
    return t.displayName || (t.type && nameOf(t.type)) || (t.render && (t.render.displayName || t.render.name)) || 'Anonymous';
  };
  var isEffect = function (x: any) {
    return x && typeof x === 'object' && 'create' in x && 'deps' in x;
  };
  var hooksChanged = function (a: any, b: any) {
    for (var n = 0; a && b && n < 100; n++, a = a.next, b = b.next) if (!isEffect(a.memoizedState) && a.memoizedState !== b.memoizedState) return true;
    return false;
  };
  var whyOf = function (f: any): string {
    var p = f.alternate;
    if (!p) return 'mount';
    var np = f.memoizedProps;
    var pp = p.memoizedProps;
    var stateChanged = f.tag === 1 ? f.memoizedState !== p.memoizedState : hooksChanged(f.memoizedState, p.memoizedState);
    if (np !== pp && np && pp && typeof np === 'object') {
      var keys: string[] = [];
      var all: any = {};
      for (var a in np) all[a] = 1;
      for (var b in pp) all[b] = 1;
      for (var k in all) if (np[k] !== pp[k]) keys.push(k);
      if (keys.length) return 'props ' + keys.slice(0, 3).join(', ') + (keys.length > 3 ? '…' : '');
      return stateChanged ? 'state' : 'parent rendered, same props';
    }
    return stateChanged ? 'state' : 'context';
  };
  var onCommit = function (root: any) {
    var cur = root && root.current;
    if (!cur) return;
    rec.commits++;
    rec.ms += cur.actualDuration || 0;
    var budget = 20000;
    // Only what this commit touched: a subtree React skipped keeps its children (and their flags from an older
    // commit), so it is not entered.
    var walk = function (x: any) {
      for (; x && budget-- > 0; x = x.sibling) {
        var prev = x.alternate;
        // Function, class, forwardRef and memo components that did work in this commit.
        if ((!prev || (x.flags & 1) !== 0) && (x.tag === 0 || x.tag === 1 || x.tag === 11 || x.tag === 14 || x.tag === 15)) {
          var self = x.actualDuration || 0;
          for (var c = x.child; c; c = c.sibling) self -= c.actualDuration || 0;
          var name = nameOf(x.type);
          var e = rec.by[name] || (rec.by[name] = {n: 0, ms: 0, why: {}});
          e.n++;
          e.ms += self > 0 ? self : 0;
          var w = whyOf(x);
          e.why[w] = (e.why[w] || 0) + 1;
        }
        if (!prev || x.child !== prev.child) walk(x.child);
      }
    };
    if (!cur.alternate || cur.child !== cur.alternate.child) walk(cur.child);
  };
  // The JS heap as the runtime counts it (Hermes): live bytes, all bytes allocated, collections.
  var heapStats = function () {
    var HI = g.HermesInternal;
    var s = HI && HI.getInstrumentedStats ? HI.getInstrumentedStats() : null;
    if (!s) return null;
    return {live: s.js_allocatedBytes, total: s.js_totalAllocatedBytes, gcs: s.js_numGCs, gcMs: (s.js_gcTime || 0) * 1000};
  };
  var renders = function (msg: any) {
    var hook = g.__REACT_DEVTOOLS_GLOBAL_HOOK__;
    if (msg.start) {
      if (!hook) {
        rec = {since: Date.now(), commits: 0, ms: 0, by: {}, heap: heapStats(), noReact: true};
        return {started: true, react: false};
      }
      if (!hook.__pitboxRenders) {
        var orig = hook.onCommitFiberRoot;
        hook.onCommitFiberRoot = function (id: any, root: any) {
          try {
            if (rec) onCommit(root);
          } catch (e) {}
          return orig ? orig.apply(this, arguments) : undefined;
        };
        hook.__pitboxRenders = true;
      }
      rec = {since: Date.now(), commits: 0, ms: 0, by: {}, heap: heapStats()};
      return {started: true, react: true};
    }
    if (!rec) return {error: 'no React measurement running'};
    var r = rec;
    rec = null;
    var list: any[] = [];
    // Every component's count, for budgets on one of them (`renders:Row<=40`); only the top ones are shown.
    var counts: any = {};
    for (var cn in r.by) counts[cn] = r.by[cn].n;
    for (var name in r.by) {
      var e = r.by[name];
      var why: any[] = [];
      for (var w in e.why) why.push([w, e.why[w]]);
      why.sort(function (a: any, b: any) {
        return b[1] - a[1];
      });
      list.push({name: name, n: e.n, ms: Math.round(e.ms * 10) / 10, why: why.slice(0, 2)});
    }
    var byN = list.slice().sort(function (a, b) {
      return b.n - a.n || b.ms - a.ms;
    });
    var byMs = list.slice().sort(function (a, b) {
      return b.ms - a.ms;
    });
    var shown = byN.slice(0, 10);
    for (var i = 0; i < byMs.length && i < 5; i++) if (shown.indexOf(byMs[i]) < 0) shown.push(byMs[i]);
    var h0 = r.heap;
    var h1 = heapStats();
    var heap = h0 && h1 ? {liveBefore: h0.live, liveAfter: h1.live, allocated: h1.total - h0.total, gcs: h1.gcs - h0.gcs, gcMs: Math.round((h1.gcMs - h0.gcMs) * 10) / 10} : undefined;
    return {ms: Date.now() - r.since, react: !r.noReact, commits: r.commits, renderMs: Math.round(r.ms * 10) / 10, components: list.length, shown: shown, counts: counts, heap: heap};
  };

  var connect = function (delay: number) {
    var ch: any;
    try {
      ch = new W(cfg.ws);
    } catch (e) {
      return;
    }
    ch.onopen = function () {
      ch.send(JSON.stringify({type: 'hello', bundle: cfg.bundle, gen: cfg.gen, platform: cfg.platform, startedAt: scriptStart, sinceStart: Date.now() - scriptStart}));
      state.ch = ch;
      var pending = state.errors.splice(0);
      for (var i = 0; i < pending.length; i++) ch.send(JSON.stringify(pending[i]));
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
        var data: any =
          msg.what === 'log'
            ? state.log.slice(-(msg.limit || 30))
            : msg.what === 'tree'
              ? reactTree(msg.limit || 600)
              : msg.what === 'console'
                ? state.console.slice(0)
                : msg.what === 'renders'
                  ? renders(msg)
                  : {inflight: state.inflight, quietMs: Date.now() - state.last, sockets: state.sockets.length};
        ch.send(JSON.stringify({type: 'reply', reqId: msg.reqId, data: data}));
      }
    };
    ch.onclose = function () {
      if (state.ch === ch) state.ch = null;
      setTimeout(function () {
        connect(Math.min(delay * 2, 10000));
      }, delay);
    };
  };
  connect(1000);
}
/* eslint-enable */

/** The script with its config inlined, ready to splice into a bundle. */
export const inAppScript = (cfg: InAppConfig): string => `;(${pitboxInApp.toString()})(${JSON.stringify(cfg)}, ${pitboxFmt.toString()});\n`;

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

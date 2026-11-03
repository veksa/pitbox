// Values as compact text, inside the app: `{id: 3, tags: ["a", "b"], user: {…}}`. Serialised with `toString()`
// into the scripts pitbox runs in the app (the in-app script, the debugger helper), so it is self-contained ES5
// and calls nothing outside itself.

/* eslint-disable */
export function pitboxFmt(v: any, depth?: number, seen?: any[]): string {
  var d = depth || 0;
  var s: any[] = seen || [];
  var errText = function (e: any) {
    return e && e.name ? e.name + ': ' + e.message : String(e);
  };
  var keyText = function (k: string) {
    return /^[A-Za-z_$][\w$]*$/.test(k) ? k : JSON.stringify(k);
  };
  var fmt = function (v: any, depth: number, seen: any[]): string {
    var t = typeof v;
    if (v === null) return 'null';
    if (t === 'undefined') return 'undefined';
    if (t === 'string') return JSON.stringify(v.length > 300 ? v.slice(0, 300) + '…' : v);
    if (t === 'number' || t === 'boolean' || t === 'bigint' || t === 'symbol') return String(v);
    if (t === 'function') return 'ƒ ' + (v.name || 'anonymous');
    if (seen.indexOf(v) >= 0) return '[Circular]';
    if (v instanceof Error) return errText(v);
    if (v instanceof Date) return isNaN(v.getTime()) ? 'Invalid Date' : v.toISOString();
    if (v instanceof RegExp) return String(v);
    if (v.$$typeof && v.type !== undefined) return '<' + (typeof v.type === 'string' ? v.type : (v.type && (v.type.displayName || v.type.name)) || 'Component') + '>';
    if (typeof v.then === 'function') return 'Promise';
    var isArr = Array.isArray(v);
    if (depth >= 3) return isArr ? '[…' + v.length + ']' : '{…}';
    var next = seen.concat([v]);
    var items: string[] = [];
    var more = 0;
    if (isArr) {
      for (var i = 0; i < v.length; i++) {
        if (i >= 20) {
          more = v.length - 20;
          break;
        }
        items.push(fmt(v[i], depth + 1, next));
      }
      if (more) items.push('… ' + more + ' more');
      return '[' + items.join(', ') + ']';
    }
    if (typeof Map !== 'undefined' && v instanceof Map) {
      v.forEach(function (val: any, k: any) {
        if (items.length < 20) items.push(fmt(k, depth + 1, next) + ' => ' + fmt(val, depth + 1, next));
      });
      return 'Map(' + v.size + ') {' + items.join(', ') + '}';
    }
    if (typeof Set !== 'undefined' && v instanceof Set) {
      v.forEach(function (val: any) {
        if (items.length < 20) items.push(fmt(val, depth + 1, next));
      });
      return 'Set(' + v.size + ') {' + items.join(', ') + '}';
    }
    var keys = Object.keys(v);
    for (var j = 0; j < keys.length; j++) {
      if (j >= 20) {
        more = keys.length - 20;
        break;
      }
      var val;
      try {
        val = fmt(v[keys[j]!], depth + 1, next);
      } catch (e) {
        val = '(' + errText(e) + ')';
      }
      items.push(keyText(keys[j]!) + ': ' + val);
    }
    if (more) items.push('… ' + more + ' more');
    var ctor = v.constructor && v.constructor.name;
    return (ctor && ctor !== 'Object' ? ctor + ' ' : '') + '{' + items.join(', ') + '}';
  };
  return fmt(v, d, s);
}
/* eslint-enable */

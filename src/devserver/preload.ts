// Loaded into the dev server process with `--import` (through NODE_OPTIONS). Metro's file map enables its
// native recursive watcher only on macOS and otherwise walks the whole tree, opening one watch handle per
// directory — tens of seconds per start on Windows. Node's recursive `fs.watch` is native on Windows too, so
// every copy of the watcher class (Metro's and forks of it) is allowed there as it loads. Nothing on disk
// changes.

import fs from 'node:fs';
import {createRequire} from 'node:module';

type ModuleInternals = {_load: (request: string, parent: unknown, isMain: boolean) => unknown; _resolveFilename: (request: string, parent: unknown, isMain: boolean) => string};

const NATIVE_WATCHER = /metro-file-map[\\/](src|build)[\\/]watchers[\\/]NativeWatcher\.js$/;

const patch = (exports: unknown) => {
  const mod = exports as {default?: {isSupported?: () => boolean}; isSupported?: () => boolean};
  const cls = mod?.default ?? mod;
  if (cls && typeof cls.isSupported === 'function' && !cls.isSupported()) cls.isSupported = () => true;
};

export const installWatcherPatch = () => {
  const require = createRequire(import.meta.url);
  const Module = require('node:module') as ModuleInternals;
  const load = Module._load;
  Module._load = function (request, parent, isMain) {
    const exports = load.call(this, request, parent, isMain);
    if (typeof request === 'string' && request.includes('NativeWatcher')) {
      try {
        if (NATIVE_WATCHER.test(Module._resolveFilename(request, parent, isMain))) patch(exports);
      } catch {
        // not resolvable from here: not ours
      }
    }
    return exports;
  };
};

/**
 * A recursive watcher on Windows reports some changes with no file name (an overflowed change buffer, a renamed
 * watched directory). Metro's native watcher was written for macOS, where that does not happen, and dies on
 * `path.resolve(root, null)`: those events are dropped before they reach it.
 */
export const installNullNameFilter = () => {
  const watch = fs.watch;
  fs.watch = function (this: unknown, ...args: unknown[]) {
    const watcher = (watch as (...a: unknown[]) => fs.FSWatcher).apply(this, args);
    const opts = args[1];
    if (opts && typeof opts === 'object' && (opts as {recursive?: boolean}).recursive) {
      const emit = watcher.emit;
      watcher.emit = function (this: fs.FSWatcher, event: string | symbol, ...rest: unknown[]) {
        if (event === 'change' && rest[1] == null) return false;
        return emit.call(this, event, ...rest);
      } as typeof watcher.emit;
    }
    return watcher;
  } as typeof fs.watch;
};

if (process.platform !== 'darwin') installWatcherPatch();
if (process.platform === 'win32') installNullNameFilter();

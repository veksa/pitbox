// App crashes and ANRs as they happen: one long-lived `adb logcat` per device, so every action can say what
// broke while it ran without an extra adb call.

import {spawn, type ChildProcess} from 'node:child_process';

export type AppEvent = {at: number; kind: 'crash' | 'anr' | 'native-crash'; summary: string; lines: string[]};

/** Parses logcat lines (`-v epoch`) into crash and ANR events of one package. */
export class CrashParser {
  readonly #pkg?: string;
  readonly events: AppEvent[] = [];
  #open?: AppEvent;

  constructor(pkg?: string) {
    this.#pkg = pkg;
  }

  feed(line: string) {
    const at = Math.round(parseFloat(line.trim().split(/\s+/)[0] ?? '0') * 1000) || Date.now();
    const body = line.replace(/^\s*[\d.]+\s+\d+\s+\d+\s+\w\s+/, '');
    if (this.#open) {
      // Stack lines follow on the same tag; a different tag ends the event.
      if (/^AndroidRuntime:|^DEBUG\s*:|^libc\s*:|^crash_dump/.test(body) && this.#open.lines.length < 25) {
        this.#open.lines.push(body.replace(/^\w+\s*:\s?/, ''));
        if (this.#open.kind === 'crash' && !this.#open.summary.includes(':') && /^AndroidRuntime: [\w.$]+(Exception|Error)/.test(body)) {
          this.#open.summary = body.replace(/^AndroidRuntime:\s*/, '');
        }
        return;
      }
      this.#open = undefined;
    }
    const mine = (s: string) => !this.#pkg || s.includes(this.#pkg);
    if (/^AndroidRuntime: FATAL EXCEPTION/.test(body)) {
      this.#open = {at, kind: 'crash', summary: 'FATAL EXCEPTION', lines: []};
      this.#push(this.#open);
    } else if (/ANR in /.test(body) && mine(body)) {
      this.#push({at, kind: 'anr', summary: body.replace(/^\w+\s*:\s*/, ''), lines: []});
    } else if (/Fatal signal \d+/.test(body) && mine(body)) {
      this.#open = {at, kind: 'native-crash', summary: body.replace(/^\w+\s*:\s*/, ''), lines: []};
      this.#push(this.#open);
    }
  }

  #push(e: AppEvent) {
    this.events.push(e);
    if (this.events.length > 50) this.events.shift();
  }

  /** Events of the app since `since` (ms epoch); crashes of other processes are dropped here. */
  since(since: number): AppEvent[] {
    return this.events.filter(e => e.at >= since - 500 && (e.kind !== 'crash' || !this.#pkg || e.lines.some(l => l.includes(this.#pkg!)) || e.lines.length === 0));
  }
}

export class CrashWatcher {
  readonly parser: CrashParser;
  #child?: ChildProcess;
  readonly #adb: string;
  readonly #serial: string;

  constructor(adb: string, serial: string, pkg?: string) {
    this.#adb = adb;
    this.#serial = serial;
    this.parser = new CrashParser(pkg);
  }

  start() {
    if (this.#child && this.#child.exitCode === null) return;
    // -T 1: from now on, not the device's history.
    const child = spawn(this.#adb, ['-s', this.#serial, 'logcat', '-v', 'epoch', '-T', '1', '-b', 'main,crash'], {windowsHide: true, stdio: ['ignore', 'pipe', 'ignore']});
    let rest = '';
    child.stdout?.on('data', (d: Buffer) => {
      const text = rest + d.toString('utf8');
      const lines = text.split(/\r?\n/);
      rest = lines.pop() ?? '';
      for (const l of lines) this.parser.feed(l);
    });
    child.on('exit', () => {
      if (this.#child === child) this.#child = undefined;
    });
    this.#child = child;
  }

  stop() {
    this.#child?.kill();
    this.#child = undefined;
  }

  since(t: number) {
    this.start();
    return this.parser.since(t);
  }
}

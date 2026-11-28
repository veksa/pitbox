// What a simulator pitbox creates starts with, whatever the Mac it runs on. A new simulator takes the Mac's language
// and region (a flow that reads English text fails on a Mac in another language), and the first keyboard it shows
// covers the screen with the "Slide to Type" introduction, which waits for a tap on Continue.

import fs from 'node:fs';
import path from 'node:path';
import {run} from '../../util/proc.ts';

export type SimPref = {domain: '.GlobalPreferences' | 'com.apple.keyboard.preferences'; key: string; value: string | boolean | string[]};

/** The default language and region of the simulators pitbox creates. */
export const DEFAULT_SIM_LOCALE = 'en-US';

/**
 * The preferences a new simulator gets: the language and region of `locale` (`en-US`, `fr-FR`; `system` keeps the
 * Mac's), and the keyboard's introduction marked as shown.
 */
export const simPrefs = (locale: string = DEFAULT_SIM_LOCALE): SimPref[] => {
  const prefs: SimPref[] = [{domain: 'com.apple.keyboard.preferences', key: 'DidShowContinuousPathIntroduction', value: true}];
  if (locale === 'system') return prefs;
  const m = /^([a-z]{2,3})(?:[-_]([A-Za-z]{4}))?(?:[-_]([A-Z]{2}|\d{3}))?$/.exec(locale);
  if (!m) throw new Error(`not a locale: ${locale} (like en-US or fr-FR; system keeps the Mac's)`);
  const [, lang, script, region] = m;
  const tag = [lang, script, region].filter(Boolean).join('-');
  return [
    {domain: '.GlobalPreferences', key: 'AppleLanguages', value: [tag]},
    {domain: '.GlobalPreferences', key: 'AppleLocale', value: [lang, script, region].filter(Boolean).join('_')},
    ...prefs,
  ];
};

const plutil = async (args: string[]) => {
  const r = await run('plutil', args, {timeoutMs: 10_000});
  if (r.code !== 0) throw new Error(`plutil ${args[0]} failed: ${(r.stderr || r.stdout).trim().split('\n').pop()}`);
};

/**
 * Writes the preferences into a shut-down simulator's data folder (`<device>/data`), where its cfprefsd reads them
 * on the next boot; a booted one would keep its cached values, so it is written through `simctl spawn defaults`.
 */
export const writeSimPrefs = async (dataDir: string, prefs: SimPref[]) => {
  const dir = path.join(dataDir, 'Library', 'Preferences');
  fs.mkdirSync(dir, {recursive: true});
  for (const p of prefs) {
    const file = path.join(dir, `${p.domain}.plist`);
    if (!fs.existsSync(file)) await plutil(['-create', 'xml1', file]);
    const typed = typeof p.value === 'boolean' ? ['-bool', p.value ? 'YES' : 'NO'] : Array.isArray(p.value) ? ['-json', JSON.stringify(p.value)] : ['-string', p.value];
    await plutil(['-replace', p.key, ...typed, file]);
  }
};

/** The `defaults write` arguments of a preference, for a booted simulator (`simctl spawn <udid> defaults …`). */
export const defaultsArgs = (p: SimPref): string[] => [
  'defaults',
  'write',
  p.domain === '.GlobalPreferences' ? '-g' : p.domain,
  p.key,
  ...(typeof p.value === 'boolean' ? ['-bool', p.value ? 'YES' : 'NO'] : Array.isArray(p.value) ? ['-array', ...p.value] : ['-string', p.value]),
];

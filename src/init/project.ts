// What a project is, read from its files: where the app and its Android and Xcode projects live, the application
// and bundle ids, the framework and the bundler. Used by `pitbox init` to write a first config and by doctor to check the Android
// debug build can reach the stand over plain HTTP.

import fs from 'node:fs';
import path from 'node:path';

export type Project = {
  /** Directory of the app (the one with package.json for React Native, the Gradle root for a native app). */
  appRoot: string;
  /** The Android Gradle root, when there is one. */
  androidDir?: string;
  /** The application module (`app/`), when found. */
  appModule?: string;
  applicationId?: string;
  /** The Xcode project (`*.xcodeproj`), at the app's root or in `ios/`, when there is one. */
  xcodeProject?: string;
  /** The app's bundle id from the Xcode project. */
  bundleId?: string;
  framework: 'expo' | 'react-native' | 'native' | 'unknown';
  adapter?: 'metro' | 'rspack';
  scheme?: string;
  /** Start command for the bundler with a `{port}` placeholder. */
  start?: string;
  /** Whether the app depends on pitbox (its connect library autolinks into debug builds). */
  hasPitbox: boolean;
};

const read = (file: string) => {
  try {
    return fs.readFileSync(file, 'utf8');
  } catch {
    return undefined;
  }
};

const json = (file: string): Record<string, unknown> | undefined => {
  const text = read(file);
  if (!text) return undefined;
  try {
    return JSON.parse(text) as Record<string, unknown>;
  } catch {
    return undefined;
  }
};

const firstExisting = (...files: string[]) => files.find(f => fs.existsSync(f));

const deps = (pkg: Record<string, unknown> | undefined): Record<string, string> => ({
  ...((pkg?.dependencies as Record<string, string>) ?? {}),
  ...((pkg?.devDependencies as Record<string, string>) ?? {}),
});

const isGradleRoot = (dir: string) => !!firstExisting(path.join(dir, 'settings.gradle'), path.join(dir, 'settings.gradle.kts'));

/** The Xcode project in `dir`, the first by name. */
const xcodeProjectIn = (dir: string): string | undefined => {
  try {
    const p = fs.readdirSync(dir).filter(f => f.endsWith('.xcodeproj')).sort()[0];
    return p ? path.join(dir, p) : undefined;
  } catch {
    return undefined;
  }
};

/** The app's bundle id in a project.pbxproj: the first that is not a test target's and has no build variable. */
export const bundleIdOf = (pbxproj: string): string | undefined =>
  [...pbxproj.matchAll(/PRODUCT_BUNDLE_IDENTIFIER = "?([\w.-]+)"?;/g)].map(m => m[1]!).find(id => !/tests?$|uitests|runner/i.test(id));

const looksLikeApp = (dir: string) => {
  const d = deps(json(path.join(dir, 'package.json')));
  return !!(d['react-native'] || d.expo) || isGradleRoot(path.join(dir, 'android')) || isGradleRoot(dir) || !!xcodeProjectIn(dir) || !!xcodeProjectIn(path.join(dir, 'ios'));
};

/** The app directory: `dir` itself, or a direct child such as `mobile/` or `app/`. */
export const findAppRoot = (dir: string): string | undefined => {
  if (looksLikeApp(dir)) return dir;
  const children = fs.readdirSync(dir, {withFileTypes: true}).filter(e => e.isDirectory() && !e.name.startsWith('.') && e.name !== 'node_modules');
  // React Native apps first: a repository with a backend in Gradle and an app next to it should pick the app.
  const rn = children.find(e => {
    const d = deps(json(path.join(dir, e.name, 'package.json')));
    return d['react-native'] || d.expo;
  });
  if (rn) return path.join(dir, rn.name);
  const native = children.find(e => looksLikeApp(path.join(dir, e.name)));
  return native ? path.join(dir, native.name) : undefined;
};

/** The application id from the module's Gradle file (`applicationId`, else `namespace`). */
export const applicationIdOf = (gradle: string): string | undefined =>
  /applicationId\s*=?\s*["']([\w.]+)["']/.exec(gradle)?.[1] ?? /namespace\s*=?\s*["']([\w.]+)["']/.exec(gradle)?.[1];

const startCommand = (appRoot: string, framework: Project['framework'], scripts: Record<string, string>): string => {
  const pm = fs.existsSync(path.join(appRoot, 'yarn.lock')) || !firstExisting(path.join(appRoot, 'package-lock.json'), path.join(appRoot, 'pnpm-lock.yaml'))
    ? 'yarn'
    : fs.existsSync(path.join(appRoot, 'pnpm-lock.yaml'))
      ? 'pnpm'
      : 'npm';
  if (scripts.start) return pm === 'npm' ? 'npm run start -- --port {port}' : `${pm} start --port {port}`;
  return framework === 'expo' ? 'npx expo start --port {port}' : 'npx react-native start --port {port}';
};

export const detectProject = (dir: string): Project | undefined => {
  const appRoot = findAppRoot(dir);
  if (!appRoot) return undefined;
  const pkg = json(path.join(appRoot, 'package.json'));
  const d = deps(pkg);
  const xcodeProject = xcodeProjectIn(appRoot) ?? xcodeProjectIn(path.join(appRoot, 'ios'));
  const pbxproj = xcodeProject ? read(path.join(xcodeProject, 'project.pbxproj')) : undefined;
  const framework: Project['framework'] = d.expo ? 'expo' : d['react-native'] ? 'react-native' : isGradleRoot(appRoot) || isGradleRoot(path.join(appRoot, 'android')) || xcodeProject ? 'native' : 'unknown';
  const androidDir = isGradleRoot(path.join(appRoot, 'android')) ? path.join(appRoot, 'android') : isGradleRoot(appRoot) ? appRoot : undefined;
  const appModule = androidDir && fs.existsSync(path.join(androidDir, 'app')) ? path.join(androidDir, 'app') : undefined;
  const gradle = appModule ? read(firstExisting(path.join(appModule, 'build.gradle'), path.join(appModule, 'build.gradle.kts')) ?? '') : undefined;
  const appJson = json(path.join(appRoot, 'app.json'));
  const expoScheme = (appJson?.expo as {scheme?: unknown} | undefined)?.scheme;
  const configScheme = /scheme:\s*['"]([\w.+-]+)['"]/.exec(read(firstExisting(path.join(appRoot, 'app.config.ts'), path.join(appRoot, 'app.config.js')) ?? '') ?? '')?.[1];
  const rn = framework === 'expo' || framework === 'react-native';
  return {
    appRoot,
    androidDir,
    appModule,
    applicationId: gradle ? applicationIdOf(gradle) : undefined,
    xcodeProject,
    bundleId: pbxproj ? bundleIdOf(pbxproj) : undefined,
    framework,
    adapter: rn ? (d['@callstack/repack'] ? 'rspack' : 'metro') : undefined,
    scheme: typeof expoScheme === 'string' ? expoScheme : configScheme,
    start: rn ? startCommand(appRoot, framework, (pkg?.scripts as Record<string, string>) ?? {}) : undefined,
    hasPitbox: !!d['@veksa/pitbox'],
  };
};

// ---- cleartext ----------------------------------------------------------------------------------------------

export type Cleartext = {
  /** `allowed`: debug builds may use plain HTTP; `config`: a network security config decides (not read here); `blocked`. */
  status: 'allowed' | 'config' | 'blocked' | 'unknown';
  reason: string;
  debugManifest?: string;
};

/**
 * Whether the debug build of an Android app may talk plain HTTP to the dev server and the stand. Android blocks
 * cleartext by default since API 28; React Native's Gradle plugin allows it for debug builds through a manifest
 * placeholder, native apps usually do not.
 */
export const cleartextOf = (appModule: string): Cleartext => {
  const src = path.join(appModule, 'src');
  const debugManifest = path.join(src, 'debug', 'AndroidManifest.xml');
  const main = read(path.join(src, 'main', 'AndroidManifest.xml'));
  const debug = read(debugManifest);
  const gradle = read(firstExisting(path.join(appModule, 'build.gradle'), path.join(appModule, 'build.gradle.kts')) ?? '') ?? '';
  if (!main) return {status: 'unknown', reason: 'no src/main/AndroidManifest.xml', debugManifest};
  const attr = (xml: string | undefined) => /android:usesCleartextTraffic\s*=\s*"([^"]+)"/.exec(xml ?? '')?.[1];
  if (/android:networkSecurityConfig\s*=/.test(debug ?? '') || /android:networkSecurityConfig\s*=/.test(main)) {
    return {status: 'config', reason: 'a network security config decides (it must permit cleartext to localhost and 10.0.2.2)', debugManifest};
  }
  if (attr(debug) === 'true') return {status: 'allowed', reason: 'the debug manifest allows cleartext', debugManifest};
  const mainAttr = attr(main);
  if (mainAttr === 'true') return {status: 'allowed', reason: 'the manifest allows cleartext', debugManifest};
  if (mainAttr === '${usesCleartextTraffic}') {
    const rnPlugin = /com\.facebook\.react/.test(gradle);
    const placeholder = /usesCleartextTraffic\s*[:=]\s*["']?true/.test(gradle);
    if (rnPlugin || placeholder) return {status: 'allowed', reason: 'debug builds set the usesCleartextTraffic placeholder to true', debugManifest};
  }
  return {status: 'blocked', reason: mainAttr === 'false' ? 'the manifest forbids cleartext' : 'nothing allows cleartext (Android blocks it by default since API 28)', debugManifest};
};

/**
 * Allows cleartext in debug builds only, through the debug source set's manifest (created when missing).
 * Returns what it changed.
 */
export const allowCleartextInDebug = (appModule: string): string => {
  const file = path.join(appModule, 'src', 'debug', 'AndroidManifest.xml');
  const mainForbids = /android:usesCleartextTraffic\s*=\s*"false"/.test(read(path.join(appModule, 'src', 'main', 'AndroidManifest.xml')) ?? '');
  const replace = mainForbids ? ' tools:replace="android:usesCleartextTraffic"' : '';
  const existing = read(file);
  if (!existing) {
    fs.mkdirSync(path.dirname(file), {recursive: true});
    fs.writeFileSync(
      file,
      [
        '<?xml version="1.0" encoding="utf-8"?>',
        '<manifest xmlns:android="http://schemas.android.com/apk/res/android"',
        '    xmlns:tools="http://schemas.android.com/tools">',
        '    <!-- Debug builds reach the dev server and the local stand over plain HTTP. -->',
        `    <application android:usesCleartextTraffic="true"${replace} tools:targetApi="28" />`,
        '</manifest>',
        '',
      ].join('\n'),
    );
    return `created ${file}`;
  }
  let xml = existing;
  if (/android:usesCleartextTraffic\s*=\s*"[^"]*"/.test(xml)) {
    fs.writeFileSync(file, xml.replace(/android:usesCleartextTraffic\s*=\s*"[^"]*"/, 'android:usesCleartextTraffic="true"'));
    return `allowed cleartext in ${file}`;
  }
  if (replace && !/xmlns:tools=/.test(xml)) xml = xml.replace(/<manifest\b/, '<manifest xmlns:tools="http://schemas.android.com/tools"');
  if (/<application\b/.test(xml)) xml = xml.replace(/<application\b/, `<application android:usesCleartextTraffic="true"${replace}`);
  else xml = xml.replace(/<\/manifest>/, `    <application android:usesCleartextTraffic="true"${replace} />\n</manifest>`);
  fs.writeFileSync(file, xml);
  return `allowed cleartext in ${file}`;
};

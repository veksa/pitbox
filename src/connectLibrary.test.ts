// The connect libraries are debug-only by construction: an app's release build must carry none of them. On Android
// the library's release variant (src/main) holds only the empty package class React Native autolinking needs; every
// component and the code behind it live in the debug source set. On iOS nothing is autolinked: the app adds the pod
// for its Debug configuration itself. A component or class drifting back into src/main would ship silently.

import fs from 'node:fs';
import path from 'node:path';
import {pathToFileURL} from 'node:url';
import {describe, expect, it} from 'vitest';

const root = path.resolve(import.meta.dirname, '..');
const android = path.join(root, 'android');
const read = (file: string) => fs.readFileSync(path.join(android, file), 'utf8');
const withoutComments = (xml: string) => xml.replace(/<!--[\s\S]*?-->/g, '');

/** Every file under `dir`, relative to it. */
const filesUnder = (dir: string): string[] =>
  fs.readdirSync(dir, {withFileTypes: true, recursive: true}).filter(e => e.isFile())
    .map(e => path.relative(dir, path.join(e.parentPath, e.name)));

const COMPONENTS = ['dev.pitbox.connect.PitboxConnectProvider', 'dev.pitbox.connect.PitboxConnectActivity',
  'dev.pitbox.connect.PitboxPushReceiver'];

describe('android connect library', () => {
  it('declares no component in the manifest every variant gets', () => {
    const manifest = withoutComments(read('src/main/AndroidManifest.xml'));
    expect(manifest).not.toMatch(/<(provider|activity|activity-alias|receiver|service|application)\b/);
    expect(manifest).not.toMatch(/<(uses-permission|permission|queries)\b/);
  });

  it('keeps only the empty package class in the sources every variant gets', () => {
    const dir = path.join(android, 'src/main/java');
    expect(filesUnder(dir)).toEqual([path.join('dev', 'pitbox', 'connect', 'PitboxPackage.kt')]);
    const pkg = fs.readFileSync(path.join(dir, 'dev/pitbox/connect/PitboxPackage.kt'), 'utf8');
    expect(pkg).not.toMatch(/PitboxConnect\b|PitboxConnectProvider|PitboxConnectActivity|PitboxPushReceiver/);
  });

  it('keeps no other source set or resources in the main variant', () => {
    expect(fs.readdirSync(path.join(android, 'src/main')).sort()).toEqual(['AndroidManifest.xml', 'java']);
  });

  it('declares the provider, the connect activity and the push receiver in the debug manifest', () => {
    const manifest = withoutComments(read('src/debug/AndroidManifest.xml'));
    for (const name of COMPONENTS) expect(manifest).toContain(`android:name="${name}"`);
    for (const name of COMPONENTS) {
      const file = path.join(android, 'src/debug/java', ...name.split('.')) + '.kt';
      expect(fs.existsSync(file), file).toBe(true);
    }
  });
});

describe('react native autolinking', () => {
  it('links the android library and nothing on iOS', async () => {
    const config = (await import(pathToFileURL(path.join(root, 'react-native.config.js')).href)).default;
    expect(config.dependency.platforms.ios).toBeNull();
    expect(config.dependency.platforms.android.sourceDir).toBe('./android');
    // Expo's own module autolinking would link the pod in every configuration.
    expect(fs.existsSync(path.join(root, 'expo-module.config.json'))).toBe(false);
  });
});

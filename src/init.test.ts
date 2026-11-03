import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {describe, expect, it} from 'vitest';
import {configSchema} from './config/schema.ts';
import {configText, init} from './init/init.ts';
import {applicationIdOf, cleartextOf, detectProject} from './init/project.ts';

const tree = (files: Record<string, string>) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pitbox-init-'));
  for (const [f, text] of Object.entries(files)) {
    fs.mkdirSync(path.dirname(path.join(dir, f)), {recursive: true});
    fs.writeFileSync(path.join(dir, f), text);
  }
  return dir;
};

const manifest = (app = '<application android:label="x" />') => `<manifest xmlns:android="http://schemas.android.com/apk/res/android">\n    ${app}\n</manifest>\n`;

describe('project detection', () => {
  it('finds a React Native app one level down, its id, scheme and start command', () => {
    const dir = tree({
      'server/package.json': '{"dependencies": {"express": "5"}}',
      'mobile/package.json': '{"dependencies": {"react-native": "0.80.0", "expo": "55"}, "scripts": {"start": "expo start"}}',
      'mobile/yarn.lock': '',
      'mobile/app.json': '{"expo": {"scheme": "shop"}}',
      'mobile/android/settings.gradle': '',
      'mobile/android/app/build.gradle': 'android {\n  namespace "com.example.ns"\n  defaultConfig { applicationId "com.example.shop" }\n}',
    });
    expect(detectProject(dir)).toMatchObject({appRoot: path.join(dir, 'mobile'), applicationId: 'com.example.shop', framework: 'expo', adapter: 'metro', scheme: 'shop', start: 'yarn start --port {port}', hasPitbox: false});
  });

  it('reads Kotlin DSL ids and native Gradle projects', () => {
    expect(applicationIdOf('defaultConfig {\n applicationId = "com.example.kts"\n}')).toBe('com.example.kts');
    const dir = tree({'settings.gradle.kts': '', 'app/build.gradle.kts': 'android { namespace = "com.example.native" }'});
    expect(detectProject(dir)).toMatchObject({framework: 'native', applicationId: 'com.example.native', androidDir: dir});
  });

  it("reads an Xcode project's bundle id, here and in ios/, and leaves test targets out", async () => {
    const {bundleIdOf} = await import('./init/project.ts');
    expect(bundleIdOf('PRODUCT_BUNDLE_IDENTIFIER = com.example.MyAppTests;\nPRODUCT_BUNDLE_IDENTIFIER = "com.example.myapp";')).toBe('com.example.myapp');
    expect(bundleIdOf('PRODUCT_BUNDLE_IDENTIFIER = "$(PRODUCT_NAME)";')).toBeUndefined();
    const apple = tree({'MyApp.xcodeproj/project.pbxproj': 'PRODUCT_BUNDLE_IDENTIFIER = com.example.myapp;'});
    expect(detectProject(apple)).toMatchObject({framework: 'native', bundleId: 'com.example.myapp', androidDir: undefined});
    const {configText} = await import('./init/init.ts');
    expect(configText(detectProject(apple), apple)).toContain("app: {apple: 'com.example.myapp'}");
    const rn = tree({'package.json': '{"dependencies": {"react-native": "0.80.0"}}', 'ios/MyApp.xcodeproj/project.pbxproj': 'PRODUCT_BUNDLE_IDENTIFIER = com.example.rn;', 'android/settings.gradle': '', 'android/app/build.gradle': 'applicationId "com.example.rn"'});
    expect(detectProject(rn)).toMatchObject({framework: 'react-native', applicationId: 'com.example.rn', bundleId: 'com.example.rn'});
  });
});

describe('cleartext in debug builds', () => {
  it('trusts the React Native placeholder and an explicit debug manifest', () => {
    const rn = tree({'app/src/main/AndroidManifest.xml': manifest('<application android:usesCleartextTraffic="${usesCleartextTraffic}" />'), 'app/build.gradle': 'apply plugin: "com.facebook.react"'});
    expect(cleartextOf(path.join(rn, 'app')).status).toBe('allowed');
    const cfg = tree({'app/src/main/AndroidManifest.xml': manifest('<application android:networkSecurityConfig="@xml/nsc" />'), 'app/build.gradle': ''});
    expect(cleartextOf(path.join(cfg, 'app')).status).toBe('config');
  });

  it('allows it in the debug manifest when nothing does, overriding a main manifest that forbids it', () => {
    const dir = tree({
      'package.json': '{"dependencies": {"react-native": "0.80.0"}}',
      'android/settings.gradle': '',
      'android/app/build.gradle': 'applicationId "com.example.app"',
      'android/app/src/main/AndroidManifest.xml': manifest('<application android:usesCleartextTraffic="false" />'),
      '.gitignore': 'node_modules',
    });
    const r = init({cwd: dir});
    expect(r.lines.some(l => l.startsWith('cleartext: the manifest forbids cleartext → created'))).toBe(true);
    const debug = fs.readFileSync(path.join(dir, 'android/app/src/debug/AndroidManifest.xml'), 'utf8');
    expect(debug).toContain('android:usesCleartextTraffic="true" tools:replace="android:usesCleartextTraffic"');
    expect(cleartextOf(path.join(dir, 'android/app')).status).toBe('allowed');
    expect(fs.readFileSync(path.join(dir, '.gitignore'), 'utf8')).toBe('node_modules\n.pitbox/\n');
    expect(fs.readFileSync(path.join(dir, 'pitbox.config.ts'), 'utf8')).toContain(`app: {android: 'com.example.app'}`);
    // A second run keeps the config and changes nothing.
    const again = init({cwd: dir});
    expect(again.lines).toContain('kept pitbox.config.ts (--force rewrites it)');
    expect(again.lines.some(l => l.startsWith('cleartext: ok'))).toBe(true);
    expect(again.lines.some(l => l.includes('.gitignore'))).toBe(false);
  });

  it('writes nothing on a dry run', () => {
    const dir = tree({'android/settings.gradle': '', 'android/app/build.gradle': '', 'android/app/src/main/AndroidManifest.xml': manifest()});
    init({cwd: dir, dryRun: true});
    expect(fs.readdirSync(dir).sort()).toEqual(['android']);
    expect(fs.existsSync(path.join(dir, 'android/app/src/debug'))).toBe(false);
  });
});

describe('generated config', () => {
  it('puts the app root and a non-default start command into the devserver section', () => {
    const text = configText({appRoot: path.resolve('/r/mobile'), framework: 'react-native', adapter: 'metro', applicationId: 'com.example.app', start: 'npm run start -- --port {port}', hasPitbox: false}, path.resolve('/r'), 'Pixel_8');
    expect(text).toContain(`devserver: {adapter: 'metro', root: 'mobile', start: 'npm run start -- --port {port}'}`);
    expect(text).toContain(`android: {avd: 'Pixel_8'}`);
    // The text is a valid config once `defineConfig` (an identity function) is taken away.
    const body = text.replace(/^import .*$/m, '').replace('export default defineConfig(', 'return (');
    expect(configSchema.safeParse(new Function(body)()).success).toBe(true);
  });
});

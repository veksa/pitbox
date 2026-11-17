import {defineConfig} from '@veksa/pitbox';

export default defineConfig({
  app: {
    android: 'dev.pitbox.rnexample',
    apple: 'dev.pitbox.rnexample',
    scheme: 'pitboxexample-rn',
    // `build`: made once per fingerprint of the native inputs (android/ or ios/, package manifests, lock files) and
    // reused by every checkout and session; a JS edit reuses it, since the debug build takes its JS from the dev server.
    build: {
      android: {
        command: `cd android && ./gradlew assembleDebug -q -PreactNativeArchitectures=${process.arch === 'arm64' ? 'arm64-v8a' : 'x86_64'}`,
        output: 'android/app/build/outputs/apk/debug/app-debug.apk',
      },
      ios: {
        // Pods out of step with the lock file (a pull changed it) fail the build: installed again first.
        command: "(cd ios && (cmp -s Podfile.lock Pods/Manifest.lock || pod install)) && xcodebuild build -workspace ios/PitboxExample.xcworkspace -scheme PitboxExample -configuration Debug -destination 'generic/platform=iOS Simulator' -derivedDataPath ios/build -quiet",
        output: 'ios/build/Build/Products/Debug-iphonesimulator/PitboxExample.app',
      },
    },
  },
  devserver: {
    adapter: 'metro',
    bytecode: true,
    port: 8095,
    // `dev embed`: the bundle into the app's assets, then a debug build that runs with no dev server.
    embed: {build: `cd android && ./gradlew assembleDebug -q -PreactNativeArchitectures=${process.arch === 'arm64' ? 'arm64-v8a' : 'x86_64'}`},
  },
  services: {
    stand: {start: 'node ../stand/server.mjs', health: 'http://127.0.0.1:4100/health', expose: 4100},
  },
  tools: {
    reset: {description: 'Zero the stand counter', run: `node -e "fetch('http://127.0.0.1:4100/reset').then(r => r.text()).then(console.log)"`},
    hits: {description: 'How many times the stand answered /hello', run: `node -e "fetch('http://127.0.0.1:4100/hits').then(r => r.text()).then(console.log)"`},
    notify: {
      description: 'The backend sends a push (FCM HTTP v1 to the stand push gateway)',
      run: 'node ../stand/push.mjs {title} {body} {link}',
      params: {title: 'Title', body: 'Body', link: {description: 'Link the tap opens (pitboxexample-rn://detail/<id>)', default: ''}},
    },
  },
  routes: {detail: 'pitboxexample-rn://detail/{id}'},
  // The push gateway: a server (here `tool notify`, ../stand/push.mjs) sends APNs / FCM requests to it instead of to
  // Apple's and Google's services, and pitbox delivers them to the simulator or emulator.
  mocks: {push: {port: 4980}},
});

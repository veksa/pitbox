import {defineConfig} from '@veksa/pitbox';

export default defineConfig({
  app: {android: 'dev.pitbox.rnexample', apple: 'dev.pitbox.rnexample', scheme: 'pitboxexample-rn'},
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

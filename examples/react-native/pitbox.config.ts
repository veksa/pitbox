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
  },
  routes: {detail: 'pitboxexample-rn://detail/{id}'},
});

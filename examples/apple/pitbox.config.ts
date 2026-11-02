import {defineConfig} from '@veksa/pitbox';

export default defineConfig({
  app: {apple: 'dev.pitbox.example'},
  services: {
    stand: {start: 'node stand/server.mjs', health: 'http://127.0.0.1:4100/health'},
  },
  tools: {
    reset: {description: 'Zero the stand counter', run: `node -e "fetch('http://127.0.0.1:4100/reset').then(r => r.text()).then(console.log)"`},
    hits: {description: 'How many times the stand answered /hello', run: `node -e "fetch('http://127.0.0.1:4100/hits').then(r => r.text()).then(console.log)"`},
  },
  routes: {detail: 'pitboxexample://detail/{id}'},
});

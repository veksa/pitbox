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
  // The rest of what a project can declare, so the end-to-end run checks it too.
  actors: {peer: {start: 'node ../stand/peer.mjs {name} {port}', health: 'http://127.0.0.1:{port}/health'}},
  mocks: {llm: {port: 4010, fixtures: '../stand/llm.json'}},
  states: {
    save: `node -e "fetch('http://127.0.0.1:4100/hits').then(r => r.text()).then(t => require('fs').writeFileSync('{file}', t))"`,
    restore: `node -e "fetch('http://127.0.0.1:4100/set?n=' + require('fs').readFileSync('{file}', 'utf8'))"`,
  },
  matrix: {fontScale: [1, 1.3], dark: [false, true]},
  signIn: 'sign-in',
  docs: {readme: 'README.md'},
});

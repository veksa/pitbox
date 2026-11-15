import {defineConfig} from '@veksa/pitbox';

// The Wear OS relay example (scripts/e2e-wear-pair.mjs): the same app on a phone and a watch emulator.
export default defineConfig({
  app: {android: 'dev.pitbox.example.relay'},
});

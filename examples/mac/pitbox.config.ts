import {defineConfig} from '@veksa/pitbox';

export default defineConfig({
  // The app built by `yarn e2e:mac` (swiftc, no Xcode project): the device `mac`, or `mac:example`.
  mac: {example: {app: 'dev.pitbox.example.mac', path: './build/PitboxExample.app'}},
});

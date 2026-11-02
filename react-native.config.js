// React Native (and Expo) autolinking: the connect library under android/. ESM, as the package is "type": "module".
export default {
  dependency: {
    platforms: {
      android: {
        sourceDir: './android',
        packageImportPath: 'import dev.pitbox.connect.PitboxPackage;',
        packageInstance: 'new PitboxPackage()',
      },
      ios: null,
    },
  },
};

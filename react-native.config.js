// React Native (and Expo) autolinking: the connect library under android/. iOS comes with the Apple driver.
module.exports = {
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

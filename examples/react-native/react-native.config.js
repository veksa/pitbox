// React Native Firebase serves the Android half of the push example only: on iOS the example takes pushes
// through UNUserNotificationCenter in AppDelegate.swift, so the Firebase pods stay out of the iOS build.
module.exports = {
  dependencies: {
    '@react-native-firebase/app': {platforms: {ios: null}},
    '@react-native-firebase/messaging': {platforms: {ios: null}},
  },
};

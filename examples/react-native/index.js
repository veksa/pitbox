/**
 * @format
 */

import { AppRegistry, Platform } from 'react-native';
import App from './App';
import { name as appName } from './app.json';

// Data-only pushes while the app is in the background or not running (React Native Firebase starts a headless
// task for them).
if (Platform.OS === 'android') {
  const m = require('@react-native-firebase/messaging');
  m.setBackgroundMessageHandler(m.getMessaging(), async message => {
    console.log(`push background: ${JSON.stringify(message.data)}`);
  });
}

AppRegistry.registerComponent(appName, () => App);

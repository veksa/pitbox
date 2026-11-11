// The React Native example pitbox's end-to-end run drives: what the native example has, plus a JS error, so the
// dev server side (connect link, bytecode, the in-app channel, symbolicated stacks) is checked too.

import React, {useCallback, useEffect, useState} from 'react';
import {Alert, BackHandler, Button, FlatList, Linking, Platform, StatusBar, StyleSheet, Text, TextInput, View} from 'react-native';
import {SafeAreaProvider, SafeAreaView} from 'react-native-safe-area-context';

const rows = Array.from({length: 40}, (_, i) => `Row ${i + 1}`);

const detailOf = (url: string | null | undefined) => /^pitboxexample-rn:\/\/detail\/(\w+)/.exec(url ?? '')?.[1];

type Push = {notification?: {title?: string}; data?: Record<string, unknown>};

/**
 * Pushes, for `pitbox push`: on Android through React Native Firebase (FCM, emulated by pitbox's connect
 * library); on iOS AppDelegate.swift shows them and opens a tapped push's `link`. A push whose data has `link`
 * opens that screen when tapped.
 */
const usePushes = (open: (url: string) => void): string => {
  const [last, setLast] = useState('');
  useEffect(() => {
    if (Platform.OS !== 'android') return;
    const m = require('@react-native-firebase/messaging') as typeof import('@react-native-firebase/messaging');
    const messaging = m.getMessaging();
    const opened = (how: string) => (p: Push | null) => {
      if (!p) return;
      setLast(`${how}: ${p.notification?.title ?? JSON.stringify(p.data)}`);
      if (typeof p.data?.link === 'string') open(p.data.link);
    };
    m.getInitialNotification(messaging).then(opened('opened cold'));
    const offOpen = m.onNotificationOpenedApp(messaging, opened('opened'));
    const offMessage = m.onMessage(messaging, p => setLast(`foreground: ${p.notification?.title ?? JSON.stringify(p.data)}`));
    return () => {
      offOpen();
      offMessage();
    };
  }, [open]);
  return last;
};

// Slow on purpose, so a CPU profile has an app function to name.
function workHard(): number {
  let x = 0;
  for (let i = 0; i < 3e6; i++) x += Math.sqrt(i) % 7;
  return x;
}

function failOnPurpose(): never {
  throw new Error('example js error');
}

function Main({onFetch, response, push}: {onFetch: () => void; response: string; push: string}) {
  const [name, setName] = useState('');
  const [greeting, setGreeting] = useState('');
  const [removed, setRemoved] = useState('');
  // An alert whose button repeats the button behind it: a press must reach the alert's own.
  const remove = () =>
    Alert.alert('Remove the row?', undefined, [
      {text: 'Cancel', style: 'cancel', onPress: () => setRemoved('kept')},
      {text: 'Remove', style: 'destructive', onPress: () => setRemoved('removed')},
    ]);
  const greet = () => {
    if (!name.trim()) console.warn('greeting without a name');
    setGreeting(`Hello, ${name.trim() || 'stranger'}`);
  };
  return (
    <View style={styles.form}>
      <Text testID="title" style={styles.title}>
        pitbox example
      </Text>
      <TextInput testID="name" placeholder="Your name" value={name} onChangeText={setName} style={styles.input} />
      <Button testID="greet" title="Greet" onPress={() => greet()} />
      {greeting ? <Text testID="greeting">{greeting}</Text> : null}
      <Button testID="fetch" title="Ask the stand" onPress={onFetch} />
      {response ? <Text testID="response">{response}</Text> : null}
      <Button testID="js-error" title="Throw a JS error" onPress={failOnPurpose} />
      <Button testID="busy" title="Work hard" onPress={() => workHard()} />
      <Button testID="remove" title="Remove" onPress={remove} />
      {removed ? <Text testID="removed">{removed}</Text> : null}
      {push ? <Text testID="push">{push}</Text> : null}
    </View>
  );
}

export default function App() {
  const [response, setResponse] = useState('');
  const [detail, setDetail] = useState<string | undefined>();
  const push = usePushes(useCallback((url: string) => setDetail(detailOf(url)), []));

  useEffect(() => {
    // Only a link that opened the app: an empty one must not undo a screen a tapped push opened.
    Linking.getInitialURL().then(url => url && setDetail(detailOf(url)));
    const sub = Linking.addEventListener('url', e => setDetail(detailOf(e.url)));
    return () => sub.remove();
  }, []);

  // Back leaves the detail screen instead of the app.
  useEffect(() => {
    const sub = BackHandler.addEventListener('hardwareBackPress', () => {
      if (!detail) return false;
      setDetail(undefined);
      return true;
    });
    return () => sub.remove();
  }, [detail]);

  const ask = () => {
    setResponse('asking…');
    fetch('http://localhost:4100/hello')
      .then(r => r.text())
      .then(setResponse, e => setResponse(`failed: ${String(e)}`));
  };

  return (
    <SafeAreaProvider>
      <StatusBar barStyle="dark-content" />
      <SafeAreaView style={styles.screen}>
        {detail ? (
          <Text testID="detail-screen" style={styles.title} onPress={() => setDetail(undefined)}>
            Detail {detail}
          </Text>
        ) : (
          <FlatList
            testID="content-list"
            data={rows}
            keyExtractor={r => r}
            ListHeaderComponent={<Main onFetch={ask} response={response} push={push} />}
            renderItem={({item}) => (
              <Text style={styles.row} accessibilityLabel={item.toLowerCase()}>
                {item}
              </Text>
            )}
          />
        )}
      </SafeAreaView>
    </SafeAreaProvider>
  );
}

const styles = StyleSheet.create({
  screen: {flex: 1, padding: 16},
  // One gap between every item of the form; empty texts are left out, or they would widen it.
  form: {gap: 8, marginBottom: 8},
  title: {fontSize: 24},
  input: {borderBottomWidth: 1, paddingVertical: 4},
  row: {fontSize: 18, paddingVertical: 12},
});

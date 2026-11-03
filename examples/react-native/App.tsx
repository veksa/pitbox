// The React Native example pitbox's end-to-end run drives: what the native example has, plus a JS error, so the
// dev server side (connect link, bytecode, the in-app channel, symbolicated stacks) is checked too.

import React, {useEffect, useState} from 'react';
import {BackHandler, Button, FlatList, Linking, StatusBar, StyleSheet, Text, TextInput, View} from 'react-native';
import {SafeAreaProvider, SafeAreaView} from 'react-native-safe-area-context';

const rows = Array.from({length: 40}, (_, i) => `Row ${i + 1}`);

const detailOf = (url: string | null) => /^pitboxexample-rn:\/\/detail\/(\w+)/.exec(url ?? '')?.[1];

// Slow on purpose, so a CPU profile has an app function to name.
function workHard(): number {
  let x = 0;
  for (let i = 0; i < 3e6; i++) x += Math.sqrt(i) % 7;
  return x;
}

function failOnPurpose(): never {
  throw new Error('example js error');
}

function Main({onFetch, response}: {onFetch: () => void; response: string}) {
  const [name, setName] = useState('');
  const [greeting, setGreeting] = useState('');
  const greet = () => {
    if (!name.trim()) console.warn('greeting without a name');
    setGreeting(`Hello, ${name.trim() || 'stranger'}`);
  };
  return (
    <View>
      <Text testID="title" style={styles.title}>
        pitbox example
      </Text>
      <TextInput testID="name" placeholder="Your name" value={name} onChangeText={setName} style={styles.input} />
      <Button testID="greet" title="Greet" onPress={() => greet()} />
      <Text testID="greeting">{greeting}</Text>
      <Button testID="fetch" title="Ask the stand" onPress={onFetch} />
      <Text testID="response">{response}</Text>
      <Button testID="js-error" title="Throw a JS error" onPress={failOnPurpose} />
      <Button testID="busy" title="Work hard" onPress={() => workHard()} />
    </View>
  );
}

export default function App() {
  const [response, setResponse] = useState('');
  const [detail, setDetail] = useState<string | undefined>();

  useEffect(() => {
    Linking.getInitialURL().then(url => setDetail(detailOf(url)));
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
            ListHeaderComponent={<Main onFetch={ask} response={response} />}
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
  title: {fontSize: 24, marginBottom: 8},
  input: {borderBottomWidth: 1, marginBottom: 8, paddingVertical: 4},
  row: {fontSize: 18, paddingVertical: 12},
});

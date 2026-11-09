import React from 'react';
import { StatusBar } from 'expo-status-bar';
import { SafeAreaProvider } from 'react-native-safe-area-context';

import { DemoScreen } from './src/DemoScreen';

export default function App() {
  return (
    <SafeAreaProvider>
      <StatusBar style="light" />
      <DemoScreen />
    </SafeAreaProvider>
  );
}

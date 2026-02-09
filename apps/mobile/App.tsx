import React from 'react';
import { SafeAreaView, Text, View } from 'react-native';
import { StatusBar } from 'expo-status-bar';
import { PairScreen } from './src/screens/PairScreen';

export default function App() {
  return (
    <SafeAreaView style={{ flex: 1, backgroundColor: '#0b0f12' }}>
      <StatusBar style="light" />
      <View style={{ padding: 16 }}>
        <Text style={{ color: '#fff', fontSize: 24, fontWeight: '700', marginBottom: 12 }}>
          Opcode Mobile
        </Text>
        <PairScreen />
      </View>
    </SafeAreaView>
  );
}

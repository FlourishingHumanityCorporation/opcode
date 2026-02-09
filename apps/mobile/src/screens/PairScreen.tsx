import React, { useState } from 'react';
import { Text, TextInput, View } from 'react-native';

export function PairScreen() {
  const [pairCode, setPairCode] = useState('');

  return (
    <View style={{ gap: 8 }}>
      <Text style={{ color: '#D0D7DE' }}>Enter pairing code from desktop settings.</Text>
      <TextInput
        style={{
          borderWidth: 1,
          borderColor: '#30363D',
          color: '#fff',
          borderRadius: 8,
          paddingHorizontal: 12,
          paddingVertical: 10,
        }}
        autoCapitalize="characters"
        placeholder="ABC123"
        placeholderTextColor="#6E7681"
        value={pairCode}
        onChangeText={setPairCode}
      />
    </View>
  );
}

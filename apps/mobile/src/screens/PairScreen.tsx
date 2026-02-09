import React, { useEffect, useMemo, useState } from 'react';
import { Pressable, Text, TextInput, View } from 'react-native';

import type { PairClaimInput } from '../protocol/client';

interface PairScreenProps {
  defaultHost?: string;
  busy?: boolean;
  error?: string | null;
  onPair: (input: PairClaimInput) => Promise<void>;
}

function sanitizeHostInput(input: string): string {
  return input.trim().replace(/\/$/, '');
}

export function PairScreen({ defaultHost, busy = false, error, onPair }: PairScreenProps) {
  const [host, setHost] = useState(defaultHost || '');
  const [pairCode, setPairCode] = useState('');
  const [deviceName, setDeviceName] = useState('iPhone');
  const [localError, setLocalError] = useState<string | null>(null);

  useEffect(() => {
    if (!host.trim() && defaultHost) {
      setHost(defaultHost);
    }
  }, [defaultHost, host]);

  const isDisabled = useMemo(() => {
    return busy || !host.trim() || !pairCode.trim() || !deviceName.trim();
  }, [busy, host, pairCode, deviceName]);

  const handlePair = async () => {
    setLocalError(null);

    const normalizedHost = sanitizeHostInput(host);
    const normalizedPairCode = pairCode.trim().toUpperCase();
    const normalizedDeviceName = deviceName.trim();

    if (!normalizedHost) {
      setLocalError('Desktop host is required');
      return;
    }

    if (!normalizedPairCode) {
      setLocalError('Pairing code is required');
      return;
    }

    try {
      await onPair({
        host: normalizedHost,
        pairCode: normalizedPairCode,
        deviceName: normalizedDeviceName || 'iPhone',
      });
      setPairCode('');
    } catch (pairError) {
      const message = pairError instanceof Error ? pairError.message : 'Pairing failed';
      setLocalError(message);
    }
  };

  return (
    <View style={{ gap: 12 }}>
      <Text style={{ color: '#D0D7DE' }}>
        Pair this phone with your desktop Opcode instance.
      </Text>

      <View style={{ gap: 6 }}>
        <Text style={{ color: '#9BA4AE', fontSize: 12 }}>Desktop host (Tailscale IP or LAN)</Text>
        <TextInput
          style={{
            borderWidth: 1,
            borderColor: '#30363D',
            color: '#fff',
            borderRadius: 8,
            paddingHorizontal: 12,
            paddingVertical: 10,
          }}
          autoCapitalize="none"
          autoCorrect={false}
          placeholder="100.106.158.22:8091"
          placeholderTextColor="#6E7681"
          value={host}
          onChangeText={setHost}
        />
      </View>

      <View style={{ gap: 6 }}>
        <Text style={{ color: '#9BA4AE', fontSize: 12 }}>Pairing code from desktop settings</Text>
        <TextInput
          style={{
            borderWidth: 1,
            borderColor: '#30363D',
            color: '#fff',
            borderRadius: 8,
            paddingHorizontal: 12,
            paddingVertical: 10,
            letterSpacing: 1,
          }}
          autoCapitalize="characters"
          autoCorrect={false}
          placeholder="ABC123"
          placeholderTextColor="#6E7681"
          value={pairCode}
          onChangeText={setPairCode}
        />
      </View>

      <View style={{ gap: 6 }}>
        <Text style={{ color: '#9BA4AE', fontSize: 12 }}>Device name</Text>
        <TextInput
          style={{
            borderWidth: 1,
            borderColor: '#30363D',
            color: '#fff',
            borderRadius: 8,
            paddingHorizontal: 12,
            paddingVertical: 10,
          }}
          autoCorrect={false}
          placeholder="iPhone"
          placeholderTextColor="#6E7681"
          value={deviceName}
          onChangeText={setDeviceName}
        />
      </View>

      {(localError || error) ? (
        <Text style={{ color: '#ff7b72' }}>{localError || error}</Text>
      ) : null}

      <Pressable
        onPress={handlePair}
        disabled={isDisabled}
        style={{
          backgroundColor: isDisabled ? '#30363D' : '#2f81f7',
          borderRadius: 8,
          paddingVertical: 11,
          alignItems: 'center',
        }}
      >
        <Text style={{ color: '#fff', fontWeight: '600' }}>{busy ? 'Pairing...' : 'Pair Device'}</Text>
      </Pressable>
    </View>
  );
}

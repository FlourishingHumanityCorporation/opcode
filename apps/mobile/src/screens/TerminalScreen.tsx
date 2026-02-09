import React, { useMemo, useState } from 'react';
import { Pressable, ScrollView, Text, TextInput, View } from 'react-native';

import type { EventEnvelopeV1 } from '../../../../packages/mobile-sync-protocol/src';
import type { ActionUiRecord } from '../actions/actionExecution';
import type { MirrorTerminal, MirrorWorkspace } from '../store/syncStore';
import { resolveTerminalInputDisabledReason } from './actionGuards';

interface TerminalScreenProps {
  connected: boolean;
  isActionPending: boolean;
  lastActionRecord: ActionUiRecord | null;
  activeWorkspace: MirrorWorkspace | null;
  activeTerminal: MirrorTerminal | null;
  activeEmbeddedTerminalId: string | null;
  recentEvents: EventEnvelopeV1[];
  onSendTerminalInput: (input: string) => Promise<void>;
}

export function TerminalScreen({
  connected,
  isActionPending,
  lastActionRecord,
  activeWorkspace,
  activeTerminal,
  activeEmbeddedTerminalId,
  recentEvents,
  onSendTerminalInput,
}: TerminalScreenProps) {
  const [terminalInput, setTerminalInput] = useState('');
  const [error, setError] = useState<string | null>(null);

  const guardReason = resolveTerminalInputDisabledReason({
    connected,
    isActionPending,
    hasEmbeddedTerminalId: Boolean(activeEmbeddedTerminalId),
    hasInput: terminalInput.trim().length > 0,
  });
  const canSend = !guardReason;
  const actionTarget = activeTerminal
    ? `${activeTerminal.title} (${activeTerminal.id})${activeEmbeddedTerminalId ? ` / ${activeEmbeddedTerminalId}` : ''}`
    : 'N/A';
  const sending = isActionPending && lastActionRecord?.kind === 'terminal.write' && lastActionRecord.status === 'pending';

  const recentTerminalEvents = useMemo(
    () =>
      recentEvents
        .filter((event) => event.eventType.startsWith('terminal') || event.eventType.startsWith('workspace'))
        .slice(-8)
        .reverse(),
    [recentEvents]
  );

  const submitInput = async () => {
    if (!canSend) return;

    try {
      setError(null);
      await onSendTerminalInput(terminalInput);
      setTerminalInput('');
    } catch (sendError) {
      setError(sendError instanceof Error ? sendError.message : 'Failed to send terminal input');
    }
  };

  return (
    <ScrollView contentContainerStyle={{ gap: 12, paddingBottom: 40 }}>
      <View
        style={{
          borderWidth: 1,
          borderColor: '#30363D',
          borderRadius: 10,
          padding: 10,
          gap: 6,
          backgroundColor: '#11161b',
        }}
      >
        <Text style={{ color: '#fff', fontWeight: '700' }}>Active Terminal</Text>
        <Text style={{ color: '#9BA4AE' }}>
          Workspace: {activeWorkspace?.title || 'None'}
        </Text>
        <Text style={{ color: '#9BA4AE' }}>
          Terminal: {activeTerminal?.title || 'None'}
        </Text>
        <Text style={{ color: '#9BA4AE' }}>
          Terminal ID: {activeTerminal?.id || 'N/A'}
        </Text>
        <Text style={{ color: '#9BA4AE' }} numberOfLines={1}>
          Embedded ID: {activeEmbeddedTerminalId || 'Not available (terminal not attached yet)'}
        </Text>
        <Text style={{ color: '#9BA4AE' }} numberOfLines={1}>
          Action target: {actionTarget}
        </Text>
      </View>

      <View style={{ gap: 6 }}>
        <Text style={{ color: '#9BA4AE', fontSize: 12 }}>Send terminal input</Text>
        <TextInput
          style={{
            borderWidth: 1,
            borderColor: '#30363D',
            color: '#fff',
            borderRadius: 8,
            paddingHorizontal: 12,
            paddingVertical: 10,
          }}
          value={terminalInput}
          onChangeText={setTerminalInput}
          autoCapitalize="none"
          autoCorrect={false}
          placeholder="ls -la"
          placeholderTextColor="#6E7681"
        />
        <Pressable
          onPress={submitInput}
          disabled={!canSend}
          style={{
            backgroundColor: canSend ? '#238636' : '#30363D',
            borderRadius: 8,
            paddingVertical: 10,
            alignItems: 'center',
          }}
        >
          <Text style={{ color: '#fff', fontWeight: '600' }}>{sending ? 'Sending...' : 'Send Input'}</Text>
        </Pressable>
        {guardReason ? <Text style={{ color: '#9BA4AE' }}>{guardReason}</Text> : null}
        {error ? <Text style={{ color: '#ff7b72' }}>{error}</Text> : null}
      </View>

      <View style={{ gap: 6 }}>
        <Text style={{ color: '#9BA4AE', fontSize: 12 }}>Recent terminal-related events</Text>
        {recentTerminalEvents.length === 0 ? (
          <Text style={{ color: '#9BA4AE' }}>No events yet.</Text>
        ) : (
          recentTerminalEvents.map((event) => (
            <View
              key={`${event.sequence}-${event.eventType}`}
              style={{
                borderWidth: 1,
                borderColor: '#30363D',
                borderRadius: 8,
                paddingHorizontal: 10,
                paddingVertical: 8,
                backgroundColor: '#0d1117',
              }}
            >
              <Text style={{ color: '#fff' }}>{event.eventType}</Text>
              <Text style={{ color: '#9BA4AE', fontSize: 12 }}>
                seq {event.sequence} • {event.generatedAt}
              </Text>
            </View>
          ))
        )}
      </View>
    </ScrollView>
  );
}

import React, { useState } from 'react';
import { Pressable, ScrollView, Text, TextInput, View } from 'react-native';

import type { MirrorTerminal, MirrorWorkspace } from '../store/syncStore';

interface SessionScreenProps {
  activeWorkspace: MirrorWorkspace | null;
  activeTerminal: MirrorTerminal | null;
  onSubmitPrompt: (prompt: string) => Promise<void>;
  onResumePrompt: (prompt: string) => Promise<void>;
  onCancelSession: () => Promise<void>;
}

export function SessionScreen({
  activeWorkspace,
  activeTerminal,
  onSubmitPrompt,
  onResumePrompt,
  onCancelSession,
}: SessionScreenProps) {
  const [prompt, setPrompt] = useState('');
  const [busyAction, setBusyAction] = useState<'execute' | 'resume' | 'cancel' | null>(null);
  const [error, setError] = useState<string | null>(null);

  const sessionId = activeTerminal?.sessionState?.sessionId;

  const executePrompt = async () => {
    const trimmed = prompt.trim();
    if (!trimmed) return;

    setBusyAction('execute');
    try {
      setError(null);
      await onSubmitPrompt(trimmed);
      setPrompt('');
    } catch (submitError) {
      setError(submitError instanceof Error ? submitError.message : 'Failed to execute prompt');
    } finally {
      setBusyAction(null);
    }
  };

  const resumePrompt = async () => {
    const trimmed = prompt.trim();
    if (!trimmed || !sessionId) return;

    setBusyAction('resume');
    try {
      setError(null);
      await onResumePrompt(trimmed);
      setPrompt('');
    } catch (resumeError) {
      setError(resumeError instanceof Error ? resumeError.message : 'Failed to resume session');
    } finally {
      setBusyAction(null);
    }
  };

  const cancelSession = async () => {
    setBusyAction('cancel');
    try {
      setError(null);
      await onCancelSession();
    } catch (cancelError) {
      setError(cancelError instanceof Error ? cancelError.message : 'Failed to cancel session');
    } finally {
      setBusyAction(null);
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
        <Text style={{ color: '#fff', fontWeight: '700' }}>Session Control</Text>
        <Text style={{ color: '#9BA4AE' }}>
          Workspace: {activeWorkspace?.title || 'None'}
        </Text>
        <Text style={{ color: '#9BA4AE' }}>
          Terminal: {activeTerminal?.title || 'None'}
        </Text>
        <Text style={{ color: '#9BA4AE' }} numberOfLines={1}>
          Project path: {activeWorkspace?.projectPath || 'N/A'}
        </Text>
        <Text style={{ color: '#9BA4AE' }} numberOfLines={1}>
          Session ID: {sessionId || 'No active provider session'}
        </Text>
      </View>

      <View style={{ gap: 6 }}>
        <Text style={{ color: '#9BA4AE', fontSize: 12 }}>Prompt</Text>
        <TextInput
          style={{
            borderWidth: 1,
            borderColor: '#30363D',
            color: '#fff',
            borderRadius: 8,
            paddingHorizontal: 12,
            paddingVertical: 10,
            minHeight: 90,
            textAlignVertical: 'top',
          }}
          multiline
          value={prompt}
          onChangeText={setPrompt}
          autoCorrect={false}
          placeholder="Ask Opcode to run or modify something..."
          placeholderTextColor="#6E7681"
        />
      </View>

      <View style={{ flexDirection: 'row', gap: 8 }}>
        <Pressable
          onPress={executePrompt}
          disabled={busyAction !== null || !prompt.trim() || !activeWorkspace?.projectPath}
          style={{
            flex: 1,
            backgroundColor:
              busyAction !== null || !prompt.trim() || !activeWorkspace?.projectPath
                ? '#30363D'
                : '#238636',
            borderRadius: 8,
            paddingVertical: 10,
            alignItems: 'center',
          }}
        >
          <Text style={{ color: '#fff', fontWeight: '600' }}>
            {busyAction === 'execute' ? 'Executing...' : 'Execute'}
          </Text>
        </Pressable>

        <Pressable
          onPress={resumePrompt}
          disabled={busyAction !== null || !prompt.trim() || !sessionId || !activeWorkspace?.projectPath}
          style={{
            flex: 1,
            backgroundColor:
              busyAction !== null || !prompt.trim() || !sessionId || !activeWorkspace?.projectPath
                ? '#30363D'
                : '#1f6feb',
            borderRadius: 8,
            paddingVertical: 10,
            alignItems: 'center',
          }}
        >
          <Text style={{ color: '#fff', fontWeight: '600' }}>
            {busyAction === 'resume' ? 'Resuming...' : 'Resume'}
          </Text>
        </Pressable>
      </View>

      <Pressable
        onPress={cancelSession}
        disabled={busyAction !== null}
        style={{
          backgroundColor: busyAction !== null ? '#30363D' : '#da3633',
          borderRadius: 8,
          paddingVertical: 10,
          alignItems: 'center',
        }}
      >
        <Text style={{ color: '#fff', fontWeight: '600' }}>
          {busyAction === 'cancel' ? 'Cancelling...' : 'Cancel Session'}
        </Text>
      </Pressable>
      {error ? <Text style={{ color: '#ff7b72' }}>{error}</Text> : null}
    </ScrollView>
  );
}

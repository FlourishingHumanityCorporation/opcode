import React, { useState } from 'react';
import { Pressable, ScrollView, Text, TextInput, View } from 'react-native';

import type { ActionUiRecord } from '../actions/actionExecution';
import type { MirrorTerminal, MirrorWorkspace } from '../store/syncStore';
import {
  resolveSessionCancelDisabledReason,
  resolveSessionExecuteDisabledReason,
  resolveSessionResumeDisabledReason,
} from './actionGuards';

interface SessionScreenProps {
  connected: boolean;
  isActionPending: boolean;
  lastActionRecord: ActionUiRecord | null;
  activeWorkspace: MirrorWorkspace | null;
  activeTerminal: MirrorTerminal | null;
  onSubmitPrompt: (prompt: string) => Promise<void>;
  onResumePrompt: (prompt: string) => Promise<void>;
  onCancelSession: () => Promise<void>;
}

export function SessionScreen({
  connected,
  isActionPending,
  lastActionRecord,
  activeWorkspace,
  activeTerminal,
  onSubmitPrompt,
  onResumePrompt,
  onCancelSession,
}: SessionScreenProps) {
  const [prompt, setPrompt] = useState('');
  const [error, setError] = useState<string | null>(null);

  const sessionId = activeTerminal?.sessionState?.sessionId;
  const hasWorkspacePath = Boolean(activeWorkspace?.projectPath);
  const hasPromptInput = prompt.trim().length > 0;
  const executeDisabledReason = resolveSessionExecuteDisabledReason({
    connected,
    isActionPending,
    hasWorkspacePath,
    hasInput: hasPromptInput,
  });
  const resumeDisabledReason = resolveSessionResumeDisabledReason({
    connected,
    isActionPending,
    hasWorkspacePath,
    hasSessionId: Boolean(sessionId),
    hasInput: hasPromptInput,
  });
  const cancelDisabledReason = resolveSessionCancelDisabledReason({
    connected,
    isActionPending,
    hasSessionId: Boolean(sessionId),
  });
  const isExecutePending =
    isActionPending &&
    lastActionRecord?.kind === 'provider_session.execute' &&
    lastActionRecord.status === 'pending';
  const isResumePending =
    isActionPending &&
    lastActionRecord?.kind === 'provider_session.resume' &&
    lastActionRecord.status === 'pending';
  const isCancelPending =
    isActionPending &&
    lastActionRecord?.kind === 'provider_session.cancel' &&
    lastActionRecord.status === 'pending';
  const actionTarget = `${activeWorkspace?.projectPath || 'N/A'}${sessionId ? ` / ${sessionId}` : ''}`;

  const executePrompt = async () => {
    const trimmed = prompt.trim();
    if (!trimmed) return;

    try {
      setError(null);
      await onSubmitPrompt(trimmed);
      setPrompt('');
    } catch (submitError) {
      setError(submitError instanceof Error ? submitError.message : 'Failed to execute prompt');
    }
  };

  const resumePrompt = async () => {
    const trimmed = prompt.trim();
    if (!trimmed || !sessionId) return;

    try {
      setError(null);
      await onResumePrompt(trimmed);
      setPrompt('');
    } catch (resumeError) {
      setError(resumeError instanceof Error ? resumeError.message : 'Failed to resume session');
    }
  };

  const cancelSession = async () => {
    try {
      setError(null);
      await onCancelSession();
    } catch (cancelError) {
      setError(cancelError instanceof Error ? cancelError.message : 'Failed to cancel session');
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
        <Text style={{ color: '#9BA4AE' }} numberOfLines={1}>
          Action target: {actionTarget}
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
          placeholder="Ask CodeInterfaceX to run or modify something..."
          placeholderTextColor="#6E7681"
        />
      </View>

      <View style={{ flexDirection: 'row', gap: 8 }}>
        <Pressable
          onPress={executePrompt}
          disabled={Boolean(executeDisabledReason)}
          style={{
            flex: 1,
            backgroundColor:
              executeDisabledReason
                ? '#30363D'
                : '#238636',
            borderRadius: 8,
            paddingVertical: 10,
            alignItems: 'center',
          }}
        >
          <Text style={{ color: '#fff', fontWeight: '600' }}>
            {isExecutePending ? 'Executing...' : 'Execute'}
          </Text>
        </Pressable>

        <Pressable
          onPress={resumePrompt}
          disabled={Boolean(resumeDisabledReason)}
          style={{
            flex: 1,
            backgroundColor:
              resumeDisabledReason
                ? '#30363D'
                : '#1f6feb',
            borderRadius: 8,
            paddingVertical: 10,
            alignItems: 'center',
          }}
        >
          <Text style={{ color: '#fff', fontWeight: '600' }}>
            {isResumePending ? 'Resuming...' : 'Resume'}
          </Text>
        </Pressable>
      </View>
      {executeDisabledReason ? <Text style={{ color: '#9BA4AE' }}>Execute: {executeDisabledReason}</Text> : null}
      {resumeDisabledReason ? <Text style={{ color: '#9BA4AE' }}>Resume: {resumeDisabledReason}</Text> : null}

      <Pressable
        onPress={cancelSession}
        disabled={Boolean(cancelDisabledReason)}
        style={{
          backgroundColor: cancelDisabledReason ? '#30363D' : '#da3633',
          borderRadius: 8,
          paddingVertical: 10,
          alignItems: 'center',
        }}
      >
        <Text style={{ color: '#fff', fontWeight: '600' }}>
          {isCancelPending ? 'Cancelling...' : 'Cancel Session'}
        </Text>
      </Pressable>
      {cancelDisabledReason ? <Text style={{ color: '#9BA4AE' }}>Cancel: {cancelDisabledReason}</Text> : null}
      {error ? <Text style={{ color: '#ff7b72' }}>{error}</Text> : null}
    </ScrollView>
  );
}

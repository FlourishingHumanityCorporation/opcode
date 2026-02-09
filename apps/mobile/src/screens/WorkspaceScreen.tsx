import React, { useState } from 'react';
import { Pressable, ScrollView, Text, View } from 'react-native';

import type { ActionUiRecord } from '../actions/actionExecution';
import type { MirrorState } from '../store/syncStore';
import { resolveWorkspaceActionDisabledReason } from './actionGuards';

interface WorkspaceScreenProps {
  connected: boolean;
  isActionPending: boolean;
  lastActionRecord: ActionUiRecord | null;
  mirror: MirrorState | null;
  onActivateWorkspace: (workspaceId: string, workspaceTitle?: string) => Promise<void>;
  onActivateTerminal: (
    workspaceId: string,
    terminalTabId: string,
    terminalTitle?: string
  ) => Promise<void>;
}

export function WorkspaceScreen({
  connected,
  isActionPending,
  lastActionRecord,
  mirror,
  onActivateWorkspace,
  onActivateTerminal,
}: WorkspaceScreenProps) {
  const [error, setError] = useState<string | null>(null);

  if (!mirror || mirror.tabs.length === 0) {
    return <Text style={{ color: '#9BA4AE' }}>No workspaces mirrored yet.</Text>;
  }

  const actionDisabledReason = resolveWorkspaceActionDisabledReason({
    connected,
    isActionPending,
  });

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
        <Text style={{ color: '#fff', fontWeight: '700' }}>Active Target</Text>
        <Text style={{ color: '#9BA4AE' }}>
          Workspace ID: {mirror.activeContext.activeWorkspaceId || 'N/A'}
        </Text>
        <Text style={{ color: '#9BA4AE' }}>
          Terminal ID: {mirror.activeContext.activeTerminalTabId || 'N/A'}
        </Text>
        <Text style={{ color: '#9BA4AE' }}>
          Session ID: {mirror.activeContext.activeSessionId || 'N/A'}
        </Text>
        <Text style={{ color: '#9BA4AE' }}>
          Action target: {lastActionRecord?.targetLabel || 'N/A'}
        </Text>
      </View>
      {actionDisabledReason ? <Text style={{ color: '#9BA4AE' }}>{actionDisabledReason}</Text> : null}
      {error ? <Text style={{ color: '#ff7b72' }}>{error}</Text> : null}

      {mirror.tabs.map((workspace) => {
        const isActiveWorkspace = workspace.id === mirror.activeTabId;
        const canActivateWorkspace = !isActiveWorkspace && !actionDisabledReason;

        return (
          <View
            key={workspace.id}
            style={{
              borderWidth: 1,
              borderColor: isActiveWorkspace ? '#2f81f7' : '#30363D',
              borderRadius: 10,
              padding: 10,
              gap: 8,
              backgroundColor: '#11161b',
            }}
          >
            <View style={{ flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center' }}>
              <View style={{ flex: 1, paddingRight: 8 }}>
                <Text style={{ color: '#fff', fontWeight: '700' }}>{workspace.title}</Text>
                <Text style={{ color: '#9BA4AE', fontSize: 12 }} numberOfLines={1}>
                  {workspace.projectPath || 'No project path'}
                </Text>
              </View>
              <Pressable
                onPress={() => {
                  setError(null);
                  void onActivateWorkspace(workspace.id, workspace.title).catch((activateError) => {
                    setError(
                      activateError instanceof Error
                        ? activateError.message
                        : 'Failed to activate workspace'
                    );
                  });
                }}
                disabled={!canActivateWorkspace}
                style={{
                  backgroundColor: canActivateWorkspace ? '#1f6feb' : '#30363D',
                  paddingHorizontal: 10,
                  paddingVertical: 6,
                  borderRadius: 8,
                }}
              >
                <Text style={{ color: '#fff', fontSize: 12 }}>
                  {isActiveWorkspace ? 'Active' : 'Activate'}
                </Text>
              </Pressable>
            </View>

            {workspace.terminalTabs.map((terminal) => {
              const isActiveTerminal = terminal.id === workspace.activeTerminalTabId;

              return (
                <Pressable
                  key={terminal.id}
                  onPress={() => {
                    setError(null);
                    void onActivateTerminal(workspace.id, terminal.id, terminal.title).catch((activateError) => {
                      setError(
                        activateError instanceof Error
                          ? activateError.message
                          : 'Failed to activate terminal'
                      );
                    });
                  }}
                  disabled={Boolean(actionDisabledReason)}
                  style={{
                    borderWidth: 1,
                    borderColor: isActiveTerminal ? '#2f81f7' : '#30363D',
                    borderRadius: 8,
                    paddingHorizontal: 10,
                    paddingVertical: 8,
                    backgroundColor: '#0d1117',
                  }}
                >
                  <Text style={{ color: '#fff', fontWeight: '600' }}>{terminal.title}</Text>
                  <Text style={{ color: '#9BA4AE', fontSize: 12 }}>
                    {terminal.kind} {terminal.status ? `• ${terminal.status}` : ''}
                  </Text>
                  <Text style={{ color: '#9BA4AE', fontSize: 12 }}>
                    Action target: {workspace.title} ({workspace.id}) → {terminal.title} ({terminal.id})
                  </Text>
                </Pressable>
              );
            })}
          </View>
        );
      })}
    </ScrollView>
  );
}

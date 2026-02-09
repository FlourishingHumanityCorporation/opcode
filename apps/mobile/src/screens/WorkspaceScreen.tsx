import React from 'react';
import { Pressable, ScrollView, Text, View } from 'react-native';

import type { MirrorState } from '../store/syncStore';

interface WorkspaceScreenProps {
  mirror: MirrorState | null;
  onActivateWorkspace: (workspaceId: string) => Promise<void>;
  onActivateTerminal: (workspaceId: string, terminalTabId: string) => Promise<void>;
}

export function WorkspaceScreen({
  mirror,
  onActivateWorkspace,
  onActivateTerminal,
}: WorkspaceScreenProps) {
  if (!mirror || mirror.tabs.length === 0) {
    return <Text style={{ color: '#9BA4AE' }}>No workspaces mirrored yet.</Text>;
  }

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
      </View>

      {mirror.tabs.map((workspace) => {
        const isActiveWorkspace = workspace.id === mirror.activeTabId;

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
                  void onActivateWorkspace(workspace.id);
                }}
                style={{
                  backgroundColor: isActiveWorkspace ? '#1f6feb' : '#30363D',
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
                    void onActivateTerminal(workspace.id, terminal.id);
                  }}
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
                </Pressable>
              );
            })}
          </View>
        );
      })}
    </ScrollView>
  );
}

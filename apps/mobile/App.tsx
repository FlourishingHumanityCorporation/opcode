import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  Pressable,
  SafeAreaView,
  ScrollView,
  Text,
  View,
} from 'react-native';
import { StatusBar } from 'expo-status-bar';

import {
  MobileSyncClient,
  type MobileSyncCredentials,
  type PairClaimInput,
} from './src/protocol/client';
import {
  computeReconnectDelayMs,
  formatAgeLabel,
  isAuthError,
  runAuthFailureReset,
} from './src/reconnect';
import { PairScreen } from './src/screens/PairScreen';
import { SessionScreen } from './src/screens/SessionScreen';
import { TerminalScreen } from './src/screens/TerminalScreen';
import { WorkspaceScreen } from './src/screens/WorkspaceScreen';
import {
  clearStoredCredentials,
  getActiveEmbeddedTerminalId,
  getActiveTerminal,
  getActiveWorkspace,
  loadStoredCredentials,
  persistCredentials,
  useSyncStore,
} from './src/store/syncStore';

const NAV_ITEMS = [
  { id: 'workspace', label: 'Workspace' },
  { id: 'terminal', label: 'Terminal' },
  { id: 'session', label: 'Session' },
  { id: 'diagnostics', label: 'Diagnostics' },
] as const;

type NavView = (typeof NAV_ITEMS)[number]['id'];

function getErrorMessage(error: unknown): string {
  if (error instanceof Error) {
    return error.message;
  }
  return 'Unexpected error';
}

export default function App() {
  const [activeView, setActiveView] = useState<NavView>('workspace');
  const [bootstrapping, setBootstrapping] = useState(true);
  const [pairBusy, setPairBusy] = useState(false);
  const [pairError, setPairError] = useState<string | null>(null);

  const credentials = useSyncStore((state) => state.credentials);
  const mirror = useSyncStore((state) => state.mirror);
  const events = useSyncStore((state) => state.events);
  const connected = useSyncStore((state) => state.connected);
  const reconnectAttempts = useSyncStore((state) => state.reconnectAttempts);
  const needsSnapshotRefresh = useSyncStore((state) => state.needsSnapshotRefresh);
  const lastSequence = useSyncStore((state) => state.lastSequence);
  const lastEventType = useSyncStore((state) => state.lastEventType);
  const lastEventAt = useSyncStore((state) => state.lastEventAt);
  const lastSnapshotAt = useSyncStore((state) => state.lastSnapshotAt);
  const connectionError = useSyncStore((state) => state.connectionError);

  const setCredentials = useSyncStore((state) => state.setCredentials);
  const clearCredentials = useSyncStore((state) => state.clearCredentials);
  const setConnected = useSyncStore((state) => state.setConnected);
  const setReconnectAttempts = useSyncStore((state) => state.setReconnectAttempts);
  const setConnectionError = useSyncStore((state) => state.setConnectionError);
  const setSnapshot = useSyncStore((state) => state.setSnapshot);
  const appendEvent = useSyncStore((state) => state.appendEvent);
  const consumeSnapshotRefreshFlag = useSyncStore((state) => state.consumeSnapshotRefreshFlag);
  const resetRuntimeState = useSyncStore((state) => state.resetRuntimeState);

  const activeWorkspace = useMemo(() => getActiveWorkspace(mirror), [mirror]);
  const activeTerminal = useMemo(() => getActiveTerminal(activeWorkspace), [activeWorkspace]);
  const activeEmbeddedTerminalId = useMemo(
    () => getActiveEmbeddedTerminalId(activeTerminal),
    [activeTerminal]
  );
  const activeContext = mirror?.activeContext ?? null;

  const clientRef = useRef<MobileSyncClient | null>(null);
  const socketRef = useRef<WebSocket | null>(null);
  const reconnectTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const stableTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const reconnectAttemptRef = useRef(0);
  const resyncInFlightRef = useRef(false);
  const credentialsRef = useRef<MobileSyncCredentials | null>(null);
  const shuttingDownRef = useRef(false);

  useEffect(() => {
    credentialsRef.current = credentials;
  }, [credentials]);

  const clearTimers = useCallback(() => {
    if (reconnectTimerRef.current) {
      clearTimeout(reconnectTimerRef.current);
      reconnectTimerRef.current = null;
    }
    if (stableTimerRef.current) {
      clearTimeout(stableTimerRef.current);
      stableTimerRef.current = null;
    }
  }, []);

  const closeSocket = useCallback(() => {
    const socket = socketRef.current;
    if (!socket) return;

    socket.onopen = null;
    socket.onclose = null;
    socket.onerror = null;
    socket.onmessage = null;

    try {
      socket.close();
    } catch {
      // no-op
    }

    socketRef.current = null;
  }, []);

  const handleAuthFailure = useCallback(
    async (message: string) => {
      await runAuthFailureReset(message, {
        clearTimers,
        closeSocket,
        clearStoredCredentials,
        clearCredentials,
        resetRuntimeState,
        setConnectionError,
        setPairError,
        resetReconnectAttempts: () => {
          clientRef.current = null;
          reconnectAttemptRef.current = 0;
          setReconnectAttempts(0);
        },
      });
    },
    [
      clearCredentials,
      clearTimers,
      closeSocket,
      resetRuntimeState,
      setConnectionError,
      setReconnectAttempts,
    ]
  );

  const refreshSnapshot = useCallback(
    async (client: MobileSyncClient) => {
      if (resyncInFlightRef.current) return;
      resyncInFlightRef.current = true;

      try {
        const snapshot = await client.fetchSnapshot();
        setSnapshot(snapshot);
        consumeSnapshotRefreshFlag();
      } catch (error) {
        if (isAuthError(error)) {
          await handleAuthFailure('Authentication failed. Pair again from desktop settings.');
          return;
        }
        setConnectionError(`Snapshot refresh failed: ${getErrorMessage(error)}`);
      } finally {
        resyncInFlightRef.current = false;
      }
    },
    [consumeSnapshotRefreshFlag, handleAuthFailure, setConnectionError, setSnapshot]
  );

  const connectWithCredentials = useCallback(
    async (nextCredentials: MobileSyncCredentials) => {
      if (shuttingDownRef.current) return;

      clearTimers();
      closeSocket();
      setConnectionError(null);

      const client = new MobileSyncClient({
        baseUrl: nextCredentials.baseUrl,
        wsUrl: nextCredentials.wsUrl,
        bearerToken: nextCredentials.token,
      });

      clientRef.current = client;

      let snapshotSequence = 0;
      try {
        const snapshot = await client.fetchSnapshot();
        snapshotSequence = snapshot.sequence;
        setSnapshot(snapshot);
      } catch (error) {
        if (isAuthError(error)) {
          await handleAuthFailure('Saved token is no longer valid. Pair this device again.');
          return;
        }

        setConnected(false);
        setConnectionError(`Failed to fetch snapshot: ${getErrorMessage(error)}`);
        const currentCredentials = credentialsRef.current;
        if (currentCredentials && !shuttingDownRef.current && !reconnectTimerRef.current) {
          const nextAttempt = reconnectAttemptRef.current + 1;
          reconnectAttemptRef.current = nextAttempt;
          setReconnectAttempts(nextAttempt);

          reconnectTimerRef.current = setTimeout(() => {
            reconnectTimerRef.current = null;
            const retryCredentials = credentialsRef.current;
            if (!retryCredentials || shuttingDownRef.current) return;
            void connectWithCredentials(retryCredentials);
          }, computeReconnectDelayMs(nextAttempt));
        }
        return;
      }

      const socket = client.connect({
        since: snapshotSequence,
        onOpen: () => {
          setConnected(true);
          setPairError(null);
          setConnectionError(null);

          if (stableTimerRef.current) {
            clearTimeout(stableTimerRef.current);
          }

          stableTimerRef.current = setTimeout(() => {
            reconnectAttemptRef.current = 0;
            setReconnectAttempts(0);
          }, 30_000);
        },
        onEvent: (event) => {
          appendEvent(event);
        },
        onError: () => {
          setConnectionError('Realtime connection error. Reconnecting...');
        },
        onClose: () => {
          setConnected(false);
          if (shuttingDownRef.current) return;

          if (stableTimerRef.current) {
            clearTimeout(stableTimerRef.current);
            stableTimerRef.current = null;
          }

          const currentCredentials = credentialsRef.current;
          if (!currentCredentials || reconnectTimerRef.current) {
            return;
          }

          const nextAttempt = reconnectAttemptRef.current + 1;
          reconnectAttemptRef.current = nextAttempt;
          setReconnectAttempts(nextAttempt);

          reconnectTimerRef.current = setTimeout(() => {
            reconnectTimerRef.current = null;
            const retryCredentials = credentialsRef.current;
            if (!retryCredentials || shuttingDownRef.current) return;
            void connectWithCredentials(retryCredentials);
          }, computeReconnectDelayMs(nextAttempt));
        },
      });

      socketRef.current = socket;
    },
    [
      appendEvent,
      clearTimers,
      closeSocket,
      handleAuthFailure,
      setConnected,
      setConnectionError,
      setReconnectAttempts,
      setSnapshot,
    ]
  );

  useEffect(() => {
    if (!needsSnapshotRefresh) return;
    if (!clientRef.current) return;

    void refreshSnapshot(clientRef.current);
  }, [needsSnapshotRefresh, refreshSnapshot]);

  useEffect(() => {
    let disposed = false;

    void (async () => {
      const stored = await loadStoredCredentials();
      if (disposed) return;

      if (stored) {
        setCredentials(stored);
        await connectWithCredentials(stored);
      }

      if (!disposed) {
        setBootstrapping(false);
      }
    })();

    return () => {
      disposed = true;
    };
  }, [connectWithCredentials, setCredentials]);

  useEffect(() => {
    return () => {
      shuttingDownRef.current = true;
      clearTimers();
      closeSocket();
      clientRef.current = null;
    };
  }, [clearTimers, closeSocket]);

  const pairDevice = useCallback(
    async (input: PairClaimInput) => {
      setPairBusy(true);
      setPairError(null);

      try {
        const pairedCredentials = await MobileSyncClient.claimPairing(input);
        await persistCredentials(pairedCredentials);
        setCredentials(pairedCredentials);

        reconnectAttemptRef.current = 0;
        setReconnectAttempts(0);

        await connectWithCredentials(pairedCredentials);
      } catch (error) {
        const message = getErrorMessage(error);
        setPairError(message);
        setConnectionError(message);
        throw error;
      } finally {
        setPairBusy(false);
      }
    },
    [connectWithCredentials, setConnectionError, setCredentials, setReconnectAttempts]
  );

  const forgetDevice = useCallback(async () => {
    clearTimers();
    closeSocket();
    clientRef.current = null;
    reconnectAttemptRef.current = 0;

    await clearStoredCredentials();
    clearCredentials();
    resetRuntimeState();
    setPairError(null);
    setBootstrapping(false);
  }, [clearCredentials, clearTimers, closeSocket, resetRuntimeState]);

  const activateWorkspace = useCallback(async (workspaceId: string) => {
    const client = clientRef.current;
    if (!client) throw new Error('Not connected');
    await client.activateWorkspace(workspaceId);
  }, []);

  const activateTerminal = useCallback(async (workspaceId: string, terminalTabId: string) => {
    const client = clientRef.current;
    if (!client) throw new Error('Not connected');

    await client.activateWorkspace(workspaceId);
    await client.activateTerminal(workspaceId, terminalTabId);
  }, []);

  const sendTerminalInput = useCallback(
    async (input: string) => {
      const client = clientRef.current;
      if (!client) throw new Error('Not connected');
      if (!activeEmbeddedTerminalId) throw new Error('No active embedded terminal id available');

      await client.terminalInput(activeEmbeddedTerminalId, input);
    },
    [activeEmbeddedTerminalId]
  );

  const submitPrompt = useCallback(
    async (prompt: string) => {
      const client = clientRef.current;
      if (!client) throw new Error('Not connected');
      if (!activeWorkspace?.projectPath) throw new Error('No active workspace project path');

      await client.submitPrompt(activeWorkspace.projectPath, prompt);
    },
    [activeWorkspace?.projectPath]
  );

  const resumePrompt = useCallback(
    async (prompt: string) => {
      const client = clientRef.current;
      if (!client) throw new Error('Not connected');
      if (!activeWorkspace?.projectPath) throw new Error('No active workspace project path');

      const sessionId = activeTerminal?.sessionState?.sessionId;
      if (!sessionId) throw new Error('No active session id for resume');

      await client.resumeSession(activeWorkspace.projectPath, sessionId, prompt);
    },
    [activeTerminal?.sessionState?.sessionId, activeWorkspace?.projectPath]
  );

  const cancelSession = useCallback(async () => {
    const client = clientRef.current;
    if (!client) throw new Error('Not connected');

    const sessionId = activeTerminal?.sessionState?.sessionId;
    await client.cancelSession(sessionId);
  }, [activeTerminal?.sessionState?.sessionId]);

  if (bootstrapping) {
    return (
      <SafeAreaView style={{ flex: 1, backgroundColor: '#0b0f12', padding: 16 }}>
        <StatusBar style="light" />
        <Text style={{ color: '#fff', fontSize: 24, fontWeight: '700', marginBottom: 12 }}>
          Opcode Mobile
        </Text>
        <Text style={{ color: '#9BA4AE' }}>Loading saved mobile connection...</Text>
      </SafeAreaView>
    );
  }

  if (!credentials) {
    return (
      <SafeAreaView style={{ flex: 1, backgroundColor: '#0b0f12', padding: 16 }}>
        <StatusBar style="light" />
        <Text style={{ color: '#fff', fontSize: 24, fontWeight: '700', marginBottom: 12 }}>
          Opcode Mobile
        </Text>
        <PairScreen busy={pairBusy} error={pairError} onPair={pairDevice} />
      </SafeAreaView>
    );
  }

  return (
    <SafeAreaView style={{ flex: 1, backgroundColor: '#0b0f12' }}>
      <StatusBar style="light" />
      <View style={{ paddingHorizontal: 16, paddingTop: 12, paddingBottom: 8 }}>
        <Text style={{ color: '#fff', fontSize: 24, fontWeight: '700', marginBottom: 8 }}>
          Opcode Mobile
        </Text>

        <View
          style={{
            borderWidth: 1,
            borderColor: connected ? '#238636' : '#da3633',
            borderRadius: 8,
            paddingHorizontal: 10,
            paddingVertical: 8,
            marginBottom: 10,
            backgroundColor: '#11161b',
          }}
        >
          <Text style={{ color: '#fff', fontWeight: '600' }}>
            {connected ? 'Connected' : 'Disconnected'}
          </Text>
          <Text style={{ color: '#9BA4AE', fontSize: 12 }}>
            Device: {credentials.deviceId} • Reconnect attempts: {reconnectAttempts}
          </Text>
          {connectionError ? (
            <Text style={{ color: '#ff7b72', fontSize: 12 }}>{connectionError}</Text>
          ) : null}
        </View>

        <View style={{ flexDirection: 'row', gap: 6 }}>
          {NAV_ITEMS.map((item) => {
            const isActive = activeView === item.id;
            return (
              <Pressable
                key={item.id}
                onPress={() => setActiveView(item.id)}
                style={{
                  flex: 1,
                  backgroundColor: isActive ? '#1f6feb' : '#30363D',
                  borderRadius: 8,
                  paddingVertical: 8,
                  alignItems: 'center',
                }}
              >
                <Text style={{ color: '#fff', fontSize: 12 }}>{item.label}</Text>
              </Pressable>
            );
          })}
        </View>
      </View>

      <View style={{ flex: 1, paddingHorizontal: 16, paddingBottom: 16 }}>
        {activeView === 'workspace' ? (
          <WorkspaceScreen
            mirror={mirror}
            onActivateWorkspace={activateWorkspace}
            onActivateTerminal={activateTerminal}
          />
        ) : null}

        {activeView === 'terminal' ? (
          <TerminalScreen
            activeWorkspace={activeWorkspace}
            activeTerminal={activeTerminal}
            activeEmbeddedTerminalId={activeEmbeddedTerminalId}
            recentEvents={events}
            onSendTerminalInput={sendTerminalInput}
          />
        ) : null}

        {activeView === 'session' ? (
          <SessionScreen
            activeWorkspace={activeWorkspace}
            activeTerminal={activeTerminal}
            onSubmitPrompt={submitPrompt}
            onResumePrompt={resumePrompt}
            onCancelSession={cancelSession}
          />
        ) : null}

        {activeView === 'diagnostics' ? (
          <ScrollView contentContainerStyle={{ gap: 10, paddingBottom: 40 }}>
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
              <Text style={{ color: '#fff', fontWeight: '700' }}>Sync Diagnostics</Text>
              <Text style={{ color: '#9BA4AE' }}>Last sequence: {lastSequence}</Text>
              <Text style={{ color: '#9BA4AE' }}>Last event: {lastEventType || 'N/A'}</Text>
              <Text style={{ color: '#9BA4AE' }}>Last event time: {lastEventAt || 'N/A'}</Text>
              <Text style={{ color: '#9BA4AE' }}>Last snapshot: {lastSnapshotAt || 'N/A'}</Text>
              <Text style={{ color: '#9BA4AE' }}>
                Last event age: {formatAgeLabel(lastEventAt)}
              </Text>
              <Text style={{ color: '#9BA4AE' }}>
                Last snapshot age: {formatAgeLabel(lastSnapshotAt)}
              </Text>
              <Text style={{ color: '#9BA4AE' }}>Buffered events: {events.length}</Text>
              <Text style={{ color: '#9BA4AE' }}>
                Active workspace ID: {activeContext?.activeWorkspaceId || 'N/A'}
              </Text>
              <Text style={{ color: '#9BA4AE' }}>
                Active terminal ID: {activeContext?.activeTerminalTabId || 'N/A'}
              </Text>
              <Text style={{ color: '#9BA4AE' }}>
                Active embedded terminal ID: {activeContext?.activeEmbeddedTerminalId || 'N/A'}
              </Text>
              <Text style={{ color: '#9BA4AE' }}>
                Active session ID: {activeContext?.activeSessionId || 'N/A'}
              </Text>
            </View>

            <View style={{ flexDirection: 'row', gap: 8 }}>
              <Pressable
                onPress={() => {
                  const retryCredentials = credentialsRef.current;
                  if (!retryCredentials) return;
                  void connectWithCredentials(retryCredentials);
                }}
                style={{
                  flex: 1,
                  backgroundColor: '#1f6feb',
                  borderRadius: 8,
                  paddingVertical: 10,
                  alignItems: 'center',
                }}
              >
                <Text style={{ color: '#fff', fontWeight: '600' }}>Reconnect</Text>
              </Pressable>

              <Pressable
                onPress={() => {
                  void forgetDevice();
                }}
                style={{
                  flex: 1,
                  backgroundColor: '#da3633',
                  borderRadius: 8,
                  paddingVertical: 10,
                  alignItems: 'center',
                }}
              >
                <Text style={{ color: '#fff', fontWeight: '600' }}>Forget Device</Text>
              </Pressable>
            </View>
          </ScrollView>
        ) : null}
      </View>
    </SafeAreaView>
  );
}

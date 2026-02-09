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
  MobileSyncRequestError,
  type MobileSyncCredentials,
  type PairClaimInput,
} from './src/protocol/client';
import {
  appendActionHistory,
  completeActionRecord,
  createActionRecord,
  evaluateActionGuard,
  type ActionKind,
  type ActionUiRecord,
} from './src/actions/actionExecution';
import { ActionStatusBanner } from './src/components/ActionStatusBanner';
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

function getErrorStatus(error: unknown): number | null {
  if (error instanceof MobileSyncRequestError) {
    return error.status;
  }
  return null;
}

export default function App() {
  const [activeView, setActiveView] = useState<NavView>('workspace');
  const [bootstrapping, setBootstrapping] = useState(true);
  const [pairBusy, setPairBusy] = useState(false);
  const [pairError, setPairError] = useState<string | null>(null);
  const [lastActionRecord, setLastActionRecord] = useState<ActionUiRecord | null>(null);
  const [actionHistory, setActionHistory] = useState<ActionUiRecord[]>([]);
  const [isActionPending, setIsActionPending] = useState(false);

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
  const actionInFlightRef = useRef(false);

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
      console.warn('mobile_auth_failure_reset', { message });
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
          actionInFlightRef.current = false;
          setIsActionPending(false);
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

      const connectStartedAt = Date.now();
      console.info('mobile_connect_attempt', {
        attempt: reconnectAttemptRef.current + 1,
        baseUrl: nextCredentials.baseUrl,
      });

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
        console.info('mobile_connect_snapshot_success', {
          sequence: snapshot.sequence,
          durationMs: Date.now() - connectStartedAt,
        });
      } catch (error) {
        const message = getErrorMessage(error);
        const status = getErrorStatus(error);
        console.error('mobile_connect_snapshot_failed', {
          status,
          error: message,
          durationMs: Date.now() - connectStartedAt,
        });

        if (isAuthError(error)) {
          await handleAuthFailure('Saved token is no longer valid. Pair this device again.');
          return;
        }

        setConnected(false);
        setConnectionError(`Failed to fetch snapshot: ${message}`);
        const currentCredentials = credentialsRef.current;
        if (currentCredentials && !shuttingDownRef.current && !reconnectTimerRef.current) {
          const nextAttempt = reconnectAttemptRef.current + 1;
          reconnectAttemptRef.current = nextAttempt;
          setReconnectAttempts(nextAttempt);
          const delayMs = computeReconnectDelayMs(nextAttempt);
          console.warn('mobile_reconnect_scheduled', {
            attempt: nextAttempt,
            reason: 'snapshot_fetch_failed',
            delayMs,
          });

          reconnectTimerRef.current = setTimeout(() => {
            reconnectTimerRef.current = null;
            const retryCredentials = credentialsRef.current;
            if (!retryCredentials || shuttingDownRef.current) return;
            void connectWithCredentials(retryCredentials);
          }, delayMs);
        }
        return;
      }

      const socket = client.connect({
        since: snapshotSequence,
        onOpen: () => {
          setConnected(true);
          setPairError(null);
          setConnectionError(null);
          console.info('mobile_connect_ws_open', {
            since: snapshotSequence,
            reconnectAttempts: reconnectAttemptRef.current,
          });

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
          console.warn('mobile_ws_error', {
            reconnectAttempts: reconnectAttemptRef.current,
          });
        },
        onClose: () => {
          setConnected(false);
          console.warn('mobile_ws_closed', {
            reconnectAttempts: reconnectAttemptRef.current,
          });
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
          const delayMs = computeReconnectDelayMs(nextAttempt);
          console.warn('mobile_reconnect_scheduled', {
            attempt: nextAttempt,
            reason: 'ws_closed',
            delayMs,
          });

          reconnectTimerRef.current = setTimeout(() => {
            reconnectTimerRef.current = null;
            const retryCredentials = credentialsRef.current;
            if (!retryCredentials || shuttingDownRef.current) return;
            void connectWithCredentials(retryCredentials);
          }, delayMs);
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
      console.info('mobile_pair_claim_start', {
        host: input.host,
        deviceName: input.deviceName,
      });

      try {
        const pairedCredentials = await MobileSyncClient.claimPairing(input);
        console.info('mobile_pair_claim_success', {
          deviceId: pairedCredentials.deviceId,
          baseUrl: pairedCredentials.baseUrl,
        });
        await persistCredentials(pairedCredentials);
        setCredentials(pairedCredentials);

        reconnectAttemptRef.current = 0;
        setReconnectAttempts(0);

        await connectWithCredentials(pairedCredentials);
      } catch (error) {
        const message = getErrorMessage(error);
        console.error('mobile_pair_claim_failed', {
          error: message,
          status: getErrorStatus(error),
        });
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
    actionInFlightRef.current = false;
    setIsActionPending(false);
    setLastActionRecord(null);
    setActionHistory([]);

    await clearStoredCredentials();
    clearCredentials();
    resetRuntimeState();
    setPairError(null);
    setBootstrapping(false);
  }, [clearCredentials, clearTimers, closeSocket, resetRuntimeState]);

  const runAction = useCallback(
    async (
      kind: ActionKind,
      targetLabel: string,
      options: { hasInput?: boolean } | undefined,
      executeFn: (client: MobileSyncClient) => Promise<unknown>
    ) => {
      const client = clientRef.current;
      const guard = evaluateActionGuard(kind, {
        connected,
        hasClient: Boolean(client),
        hasWorkspacePath: Boolean(activeWorkspace?.projectPath),
        hasSessionId: Boolean(activeTerminal?.sessionState?.sessionId),
        hasEmbeddedTerminalId: Boolean(activeEmbeddedTerminalId),
        hasInput: Boolean(options?.hasInput),
        actionInFlight: actionInFlightRef.current,
      });

      if (!guard.allowed) {
        const blocked = completeActionRecord(
          createActionRecord(kind, targetLabel),
          'failed',
          guard.reason || 'Action blocked'
        );
        setLastActionRecord(blocked);
        setActionHistory((history) => appendActionHistory(history, blocked, 10));
        console.warn('mobile_action_failed', {
          kind,
          targetLabel,
          error: blocked.message,
          blocked: true,
        });
        throw new Error(blocked.message);
      }

      if (!client) {
        throw new Error('Disconnected');
      }

      const pending = createActionRecord(kind, targetLabel);
      const startedAt = Date.now();
      actionInFlightRef.current = true;
      setIsActionPending(true);
      setLastActionRecord(pending);
      console.info('mobile_action_start', {
        kind,
        targetLabel,
        startedAt: pending.startedAt,
      });

      try {
        await executeFn(client);
        const completed = completeActionRecord(pending, 'succeeded', 'Action completed');
        setLastActionRecord(completed);
        setActionHistory((history) => appendActionHistory(history, completed, 10));
        console.info('mobile_action_success', {
          kind,
          targetLabel,
          durationMs: Date.now() - startedAt,
        });
      } catch (error) {
        const message = getErrorMessage(error);
        const failed = completeActionRecord(pending, 'failed', message);
        setLastActionRecord(failed);
        setActionHistory((history) => appendActionHistory(history, failed, 10));
        console.error('mobile_action_failed', {
          kind,
          targetLabel,
          durationMs: Date.now() - startedAt,
          error: message,
        });
        throw error;
      } finally {
        actionInFlightRef.current = false;
        setIsActionPending(false);
      }
    },
    [
      activeEmbeddedTerminalId,
      activeTerminal?.sessionState?.sessionId,
      activeWorkspace?.projectPath,
      connected,
    ]
  );

  const activateWorkspace = useCallback(
    async (workspaceId: string, workspaceTitle?: string) => {
      const targetLabel = `${workspaceTitle || 'Workspace'} (${workspaceId})`;
      await runAction('workspace.activate', targetLabel, undefined, (client) =>
        client.activateWorkspace(workspaceId)
      );
    },
    [runAction]
  );

  const activateTerminal = useCallback(
    async (workspaceId: string, terminalTabId: string, terminalTitle?: string) => {
      const targetLabel = `${terminalTitle || 'Terminal'} (${terminalTabId})`;
      await runAction('terminal.activate', targetLabel, undefined, async (client) => {
        await client.activateWorkspace(workspaceId);
        await client.activateTerminal(workspaceId, terminalTabId);
      });
    },
    [runAction]
  );

  const sendTerminalInput = useCallback(
    async (input: string) => {
      const targetLabel = activeEmbeddedTerminalId
        ? `Embedded terminal (${activeEmbeddedTerminalId})`
        : 'Embedded terminal';
      await runAction(
        'terminal.write',
        targetLabel,
        { hasInput: input.trim().length > 0 },
        (client) => client.terminalInput(activeEmbeddedTerminalId || '', input)
      );
    },
    [activeEmbeddedTerminalId, runAction]
  );

  const submitPrompt = useCallback(
    async (prompt: string) => {
      const projectPath = activeWorkspace?.projectPath || '';
      const targetLabel = `Session execute (${projectPath || 'N/A'})`;
      await runAction(
        'provider_session.execute',
        targetLabel,
        { hasInput: prompt.trim().length > 0 },
        (client) => client.submitPrompt(projectPath, prompt)
      );
    },
    [activeWorkspace?.projectPath, runAction]
  );

  const resumePrompt = useCallback(
    async (prompt: string) => {
      const projectPath = activeWorkspace?.projectPath || '';
      const sessionId = activeTerminal?.sessionState?.sessionId || '';
      const targetLabel = `Session resume (${sessionId || 'N/A'})`;
      await runAction(
        'provider_session.resume',
        targetLabel,
        { hasInput: prompt.trim().length > 0 },
        (client) => client.resumeSession(projectPath, sessionId, prompt)
      );
    },
    [activeTerminal?.sessionState?.sessionId, activeWorkspace?.projectPath, runAction]
  );

  const cancelSession = useCallback(async () => {
    const sessionId = activeTerminal?.sessionState?.sessionId;
    const targetLabel = `Session cancel (${sessionId || 'N/A'})`;
    await runAction('provider_session.cancel', targetLabel, undefined, (client) =>
      client.cancelSession(sessionId)
    );
  }, [activeTerminal?.sessionState?.sessionId, runAction]);

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
        <ActionStatusBanner record={lastActionRecord} />

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
            connected={connected}
            isActionPending={isActionPending}
            lastActionRecord={lastActionRecord}
            mirror={mirror}
            onActivateWorkspace={activateWorkspace}
            onActivateTerminal={activateTerminal}
          />
        ) : null}

        {activeView === 'terminal' ? (
          <TerminalScreen
            connected={connected}
            isActionPending={isActionPending}
            lastActionRecord={lastActionRecord}
            activeWorkspace={activeWorkspace}
            activeTerminal={activeTerminal}
            activeEmbeddedTerminalId={activeEmbeddedTerminalId}
            recentEvents={events}
            onSendTerminalInput={sendTerminalInput}
          />
        ) : null}

        {activeView === 'session' ? (
          <SessionScreen
            connected={connected}
            isActionPending={isActionPending}
            lastActionRecord={lastActionRecord}
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
              <Text style={{ color: '#fff', fontWeight: '700' }}>Recent Actions</Text>
              <Text style={{ color: '#9BA4AE', fontSize: 12 }}>
                Actions are rejected while disconnected; no queued replay.
              </Text>
              {actionHistory.length === 0 ? (
                <Text style={{ color: '#9BA4AE' }}>No actions yet.</Text>
              ) : (
                actionHistory.map((record) => (
                  <View
                    key={record.id}
                    style={{
                      borderWidth: 1,
                      borderColor: '#30363D',
                      borderRadius: 8,
                      paddingHorizontal: 8,
                      paddingVertical: 6,
                      backgroundColor: '#0d1117',
                    }}
                  >
                    <Text style={{ color: '#fff', fontSize: 12 }}>
                      {record.kind} • {record.status}
                    </Text>
                    <Text style={{ color: '#9BA4AE', fontSize: 12 }} numberOfLines={1}>
                      {record.targetLabel}
                    </Text>
                    <Text style={{ color: '#9BA4AE', fontSize: 12 }}>
                      {record.finishedAt || record.startedAt} • {record.message}
                    </Text>
                  </View>
                ))
              )}
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

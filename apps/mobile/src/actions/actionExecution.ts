export type ActionUiStatus = 'pending' | 'succeeded' | 'failed';

export type ActionKind =
  | 'workspace.activate'
  | 'terminal.activate'
  | 'terminal.write'
  | 'provider_session.execute'
  | 'provider_session.resume'
  | 'provider_session.cancel';

export interface ActionUiRecord {
  id: string;
  kind: ActionKind;
  targetLabel: string;
  status: ActionUiStatus;
  message: string;
  startedAt: string;
  finishedAt: string | null;
}

export interface ActionGuardContext {
  connected: boolean;
  hasClient: boolean;
  hasWorkspacePath: boolean;
  hasSessionId: boolean;
  hasEmbeddedTerminalId: boolean;
  hasInput: boolean;
  actionInFlight?: boolean;
}

export interface ActionGuardResult {
  allowed: boolean;
  reason: string | null;
}

const DEFAULT_PENDING_MESSAGE = 'Running action...';

function createActionId(kind: ActionKind): string {
  const seed = Math.random().toString(36).slice(2, 10);
  return `${kind}-${Date.now()}-${seed}`;
}

function fail(reason: string): ActionGuardResult {
  return { allowed: false, reason };
}

export function evaluateActionGuard(kind: ActionKind, context: ActionGuardContext): ActionGuardResult {
  if (context.actionInFlight) {
    return fail('Another action is in progress');
  }

  if (!context.connected || !context.hasClient) {
    return fail('Disconnected');
  }

  switch (kind) {
    case 'workspace.activate':
    case 'terminal.activate':
      return { allowed: true, reason: null };
    case 'terminal.write':
      if (!context.hasEmbeddedTerminalId) return fail('No embedded terminal');
      if (!context.hasInput) return fail('Empty input');
      return { allowed: true, reason: null };
    case 'provider_session.execute':
      if (!context.hasWorkspacePath) return fail('No active workspace project path');
      if (!context.hasInput) return fail('Prompt is empty');
      return { allowed: true, reason: null };
    case 'provider_session.resume':
      if (!context.hasWorkspacePath) return fail('No active workspace project path');
      if (!context.hasSessionId) return fail('No active session to resume');
      if (!context.hasInput) return fail('Prompt is empty');
      return { allowed: true, reason: null };
    case 'provider_session.cancel':
      if (!context.hasSessionId) return fail('No active session to cancel');
      return { allowed: true, reason: null };
    default:
      return fail('Unsupported action');
  }
}

export function createActionRecord(kind: ActionKind, targetLabel: string): ActionUiRecord {
  return {
    id: createActionId(kind),
    kind,
    targetLabel,
    status: 'pending',
    message: DEFAULT_PENDING_MESSAGE,
    startedAt: new Date().toISOString(),
    finishedAt: null,
  };
}

export function completeActionRecord(
  record: ActionUiRecord,
  status: Exclude<ActionUiStatus, 'pending'>,
  message: string
): ActionUiRecord {
  return {
    ...record,
    status,
    message,
    finishedAt: new Date().toISOString(),
  };
}

export function appendActionHistory(
  history: ActionUiRecord[],
  record: ActionUiRecord,
  max = 20
): ActionUiRecord[] {
  return [record, ...history].slice(0, Math.max(1, max));
}

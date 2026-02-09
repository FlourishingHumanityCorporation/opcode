export function resolveWorkspaceActionDisabledReason(params: {
  connected: boolean;
  isActionPending: boolean;
}): string | null {
  if (!params.connected) return 'Disconnected';
  if (params.isActionPending) return 'Another action is in progress';
  return null;
}

export function resolveTerminalInputDisabledReason(params: {
  connected: boolean;
  isActionPending: boolean;
  hasEmbeddedTerminalId: boolean;
  hasInput: boolean;
}): string | null {
  if (!params.connected) return 'Disconnected';
  if (params.isActionPending) return 'Action pending';
  if (!params.hasEmbeddedTerminalId) return 'No embedded terminal';
  if (!params.hasInput) return 'Empty input';
  return null;
}

export function resolveSessionExecuteDisabledReason(params: {
  connected: boolean;
  isActionPending: boolean;
  hasWorkspacePath: boolean;
  hasInput: boolean;
}): string | null {
  if (!params.connected) return 'Disconnected';
  if (params.isActionPending) return 'Action pending';
  if (!params.hasWorkspacePath) return 'No active workspace project path';
  if (!params.hasInput) return 'Prompt is empty';
  return null;
}

export function resolveSessionResumeDisabledReason(params: {
  connected: boolean;
  isActionPending: boolean;
  hasWorkspacePath: boolean;
  hasSessionId: boolean;
  hasInput: boolean;
}): string | null {
  if (!params.connected) return 'Disconnected';
  if (params.isActionPending) return 'Action pending';
  if (!params.hasWorkspacePath) return 'No active workspace project path';
  if (!params.hasSessionId) return 'No active session to resume';
  if (!params.hasInput) return 'Prompt is empty';
  return null;
}

export function resolveSessionCancelDisabledReason(params: {
  connected: boolean;
  isActionPending: boolean;
  hasSessionId: boolean;
}): string | null {
  if (!params.connected) return 'Disconnected';
  if (params.isActionPending) return 'Action pending';
  if (!params.hasSessionId) return 'No active session to cancel';
  return null;
}

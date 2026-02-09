import { describe, expect, it } from 'vitest';

import {
  appendActionHistory,
  completeActionRecord,
  createActionRecord,
  evaluateActionGuard,
  type ActionGuardContext,
} from './actionExecution';

function baseContext(): ActionGuardContext {
  return {
    connected: true,
    hasClient: true,
    hasWorkspacePath: true,
    hasSessionId: true,
    hasEmbeddedTerminalId: true,
    hasInput: true,
    actionInFlight: false,
  };
}

describe('actionExecution', () => {
  it('rejects actions when another action is in progress', () => {
    const guard = evaluateActionGuard('workspace.activate', {
      ...baseContext(),
      actionInFlight: true,
    });

    expect(guard.allowed).toBe(false);
    expect(guard.reason).toBe('Another action is in progress');
  });

  it('returns disconnected guard reason for all actions', () => {
    const guard = evaluateActionGuard('provider_session.execute', {
      ...baseContext(),
      connected: false,
    });

    expect(guard.allowed).toBe(false);
    expect(guard.reason).toBe('Disconnected');
  });

  it('validates action-specific requirements', () => {
    const noTerminal = evaluateActionGuard('terminal.write', {
      ...baseContext(),
      hasEmbeddedTerminalId: false,
    });
    expect(noTerminal.reason).toBe('No embedded terminal');

    const noPrompt = evaluateActionGuard('provider_session.execute', {
      ...baseContext(),
      hasInput: false,
    });
    expect(noPrompt.reason).toBe('Prompt is empty');

    const noSession = evaluateActionGuard('provider_session.resume', {
      ...baseContext(),
      hasSessionId: false,
    });
    expect(noSession.reason).toBe('No active session to resume');

    const cancelNoSession = evaluateActionGuard('provider_session.cancel', {
      ...baseContext(),
      hasSessionId: false,
    });
    expect(cancelNoSession.reason).toBe('No active session to cancel');
  });

  it('creates pending records and completes status transitions', () => {
    const pending = createActionRecord('workspace.activate', 'Repo A');
    expect(pending.status).toBe('pending');
    expect(pending.finishedAt).toBeNull();

    const succeeded = completeActionRecord(pending, 'succeeded', 'Action completed');
    expect(succeeded.status).toBe('succeeded');
    expect(succeeded.message).toBe('Action completed');
    expect(succeeded.finishedAt).not.toBeNull();

    const failed = completeActionRecord(pending, 'failed', 'Disconnected');
    expect(failed.status).toBe('failed');
    expect(failed.message).toBe('Disconnected');
  });

  it('caps action history length', () => {
    const records = Array.from({ length: 5 }, (_, index) =>
      completeActionRecord(
        createActionRecord('workspace.activate', `Workspace ${index}`),
        'succeeded',
        `Done ${index}`
      )
    );

    const history = records.reduce((acc, record) => appendActionHistory(acc, record, 3), [] as typeof records);
    expect(history).toHaveLength(3);
    expect(history[0].targetLabel).toBe('Workspace 4');
    expect(history[2].targetLabel).toBe('Workspace 2');
  });
});

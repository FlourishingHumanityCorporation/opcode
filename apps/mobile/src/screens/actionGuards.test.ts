import { describe, expect, it } from 'vitest';

import {
  resolveSessionCancelDisabledReason,
  resolveSessionExecuteDisabledReason,
  resolveSessionResumeDisabledReason,
  resolveTerminalInputDisabledReason,
  resolveWorkspaceActionDisabledReason,
} from './actionGuards';

describe('screen action guards', () => {
  it('resolves workspace disabled reasons', () => {
    expect(
      resolveWorkspaceActionDisabledReason({
        connected: false,
        isActionPending: false,
      })
    ).toBe('Disconnected');

    expect(
      resolveWorkspaceActionDisabledReason({
        connected: true,
        isActionPending: true,
      })
    ).toBe('Another action is in progress');
  });

  it('resolves terminal input disabled reasons', () => {
    expect(
      resolveTerminalInputDisabledReason({
        connected: true,
        isActionPending: false,
        hasEmbeddedTerminalId: false,
        hasInput: true,
      })
    ).toBe('No embedded terminal');

    expect(
      resolveTerminalInputDisabledReason({
        connected: true,
        isActionPending: false,
        hasEmbeddedTerminalId: true,
        hasInput: false,
      })
    ).toBe('Empty input');
  });

  it('resolves session disabled reasons', () => {
    expect(
      resolveSessionExecuteDisabledReason({
        connected: true,
        isActionPending: false,
        hasWorkspacePath: false,
        hasInput: true,
      })
    ).toBe('No active workspace project path');

    expect(
      resolveSessionResumeDisabledReason({
        connected: true,
        isActionPending: false,
        hasWorkspacePath: true,
        hasSessionId: false,
        hasInput: true,
      })
    ).toBe('No active session to resume');

    expect(
      resolveSessionCancelDisabledReason({
        connected: true,
        isActionPending: false,
        hasSessionId: false,
      })
    ).toBe('No active session to cancel');
  });
});

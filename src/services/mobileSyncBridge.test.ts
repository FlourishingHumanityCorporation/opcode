import { describe, expect, it } from 'vitest';

import {
  buildProviderSessionStateSummaryPayload,
  buildTerminalStateSummaryPayload,
  buildWorkspaceStateChangedPayload,
  type WorkspaceMirrorState,
} from '@/services/mobileSyncBridge';

function sampleState(): WorkspaceMirrorState {
  return {
    activeTabId: 'workspace-1',
    utilityOverlay: 'settings',
    tabs: [
      {
        id: 'workspace-1',
        title: 'Repo A',
        projectPath: '/tmp/repo-a',
        activeTerminalTabId: 'terminal-1',
        terminalTabs: [
          {
            id: 'terminal-1',
            title: 'Terminal 1',
            status: 'running',
            providerId: 'claude',
            activePaneId: 'pane-1',
            sessionState: {
              sessionId: 'session-1',
              projectPath: '/tmp/repo-a',
            },
            paneStates: {
              'pane-1': {
                embeddedTerminalId: 'embedded-1',
                sessionId: 'session-1',
                projectPath: '/tmp/repo-a',
                providerId: 'claude',
              },
            },
          },
        ],
      },
    ],
  };
}

describe('mobileSyncBridge active context payloads', () => {
  it('builds enriched workspace payload', () => {
    const payload = buildWorkspaceStateChangedPayload(sampleState());

    expect(payload.activeWorkspaceId).toBe('workspace-1');
    expect(payload.activeTerminalTabId).toBe('terminal-1');
    expect(payload.activeEmbeddedTerminalId).toBe('embedded-1');
    expect(payload.activeSessionId).toBe('session-1');
    expect(payload.projectPath).toBe('/tmp/repo-a');
    expect(payload.workspaceCount).toBe(1);
    expect(payload.terminalCount).toBe(1);
    expect(payload.utilityOverlay).toBe('settings');
  });

  it('builds terminal and provider summaries', () => {
    const state = sampleState();

    const terminalSummary = buildTerminalStateSummaryPayload(state);
    const providerSummary = buildProviderSessionStateSummaryPayload(state);

    expect(terminalSummary.activeTerminalTabId).toBe('terminal-1');
    expect(terminalSummary.activeEmbeddedTerminalId).toBe('embedded-1');
    expect(providerSummary.activeSessionId).toBe('session-1');
    expect(providerSummary.projectPath).toBe('/tmp/repo-a');
    expect(providerSummary.providerId).toBe('claude');
  });
});

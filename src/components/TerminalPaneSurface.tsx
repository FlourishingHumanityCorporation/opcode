import React from 'react';
import { Bot, Columns2, Terminal, X } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { cn } from '@/lib/utils';
import {
  buildPersistentTerminalSessionId,
  canonicalizeProjectPath,
  projectNameFromPath,
  shouldResetEmbeddedTerminal,
  shouldAutoRenameWorkspaceTitle,
} from '@/lib/terminalPaneState';
import { api } from '@/lib/api';
import type { Tab, TerminalTab } from '@/contexts/TabContext';
import { ClaudeCodeSession } from '@/components/ClaudeCodeSession';
import { AgentExecution } from '@/components/AgentExecution';
import { AgentRunOutputViewer } from '@/components/AgentRunOutputViewer';
import { useTabState } from '@/hooks/useTabState';

interface TerminalPaneSurfaceProps {
  workspace: Tab;
  terminal: TerminalTab;
  paneId: string;
  isActive: boolean;
  isPaneVisible?: boolean;
  exposeTestId?: boolean;
}

export const TerminalPaneSurface: React.FC<TerminalPaneSurfaceProps> = ({
  workspace,
  terminal,
  paneId,
  isActive,
  isPaneVisible = true,
  exposeTestId = true,
}) => {
  const {
    splitPane,
    closePane,
    activatePane,
    updateTab,
    updatePaneState,
  } = useTabState();

  const paneRuntime = terminal.paneStates[paneId] || {};

  const providerId =
    paneRuntime.providerId ||
    terminal.providerId ||
    terminal.sessionState?.providerId ||
    'claude';

  const projectPath =
    paneRuntime.projectPath ||
    terminal.sessionState?.projectPath ||
    terminal.sessionState?.initialProjectPath ||
    workspace.projectPath ||
    '';

  const resumeSessionId =
    paneRuntime.sessionId ||
    terminal.sessionState?.sessionId ||
    terminal.sessionState?.sessionData?.id ||
    (terminal.sessionState?.sessionData as any)?.session_id;

  const persistentTerminalSessionId = buildPersistentTerminalSessionId(
    workspace.id,
    terminal.id,
    paneId
  );

  const handleProviderChange = (nextProvider: string) => {
    updateTab(terminal.id, {
      providerId: nextProvider,
      sessionState: {
        ...terminal.sessionState,
        providerId: nextProvider,
      },
    });

    updatePaneState(workspace.id, terminal.id, paneId, {
      providerId: nextProvider,
    });
  };

  const handleProjectPathChange = (nextPath: string) => {
    const nextCanonicalPath = canonicalizeProjectPath(nextPath);
    const nextProjectName = projectNameFromPath(nextCanonicalPath);
    const currentPanePath =
      paneRuntime.projectPath ||
      terminal.sessionState?.projectPath ||
      terminal.sessionState?.initialProjectPath ||
      '';
    const currentPaneCanonicalPath = canonicalizeProjectPath(currentPanePath);
    const shouldResetTerminal = shouldResetEmbeddedTerminal(currentPaneCanonicalPath, nextCanonicalPath);
    const shouldUpdateWorkspacePath = !workspace.projectPath && Boolean(nextCanonicalPath);
    const shouldUpdatePanePath = nextCanonicalPath !== currentPaneCanonicalPath;

    if (!shouldUpdatePanePath && !shouldUpdateWorkspacePath && !shouldResetTerminal) {
      return;
    }

    updateTab(terminal.id, {
      sessionState: {
        ...terminal.sessionState,
        projectPath: nextCanonicalPath,
        initialProjectPath: terminal.sessionState?.initialProjectPath || nextCanonicalPath,
      },
    });

    if (shouldUpdatePanePath || shouldResetTerminal) {
      const nextPaneState: {
        projectPath?: string;
        embeddedTerminalId?: string;
      } = {};

      if (shouldUpdatePanePath) {
        nextPaneState.projectPath = nextCanonicalPath;
      }

      if (shouldResetTerminal) {
        if (paneRuntime.embeddedTerminalId) {
          api.closeEmbeddedTerminal(paneRuntime.embeddedTerminalId).catch(() => undefined);
        }
        nextPaneState.embeddedTerminalId = undefined;
      }

      updatePaneState(workspace.id, terminal.id, paneId, nextPaneState);
    }

    if (shouldUpdateWorkspacePath) {
      const shouldAutoRenameWorkspace = shouldAutoRenameWorkspaceTitle(
        workspace.title,
        workspace.projectPath
      );
      updateTab(workspace.id, {
        projectPath: nextCanonicalPath,
        title: shouldAutoRenameWorkspace && nextProjectName
          ? nextProjectName
          : workspace.title,
      });
    }
  };

  const handleEmbeddedTerminalIdChange = (nextTerminalId: string | undefined) => {
    if ((paneRuntime.embeddedTerminalId || undefined) === nextTerminalId) {
      return;
    }

    updatePaneState(workspace.id, terminal.id, paneId, {
      embeddedTerminalId: nextTerminalId,
    });
  };

  const handleSessionResolved = (nextSession: any) => {
    if (!nextSession?.id) return;

    const currentSessionId =
      terminal.sessionState?.sessionId ||
      terminal.sessionState?.sessionData?.id ||
      paneRuntime.sessionId;

    if (currentSessionId === nextSession.id && terminal.sessionState?.sessionData?.id === nextSession.id) {
      return;
    }

    updateTab(terminal.id, {
      sessionState: {
        ...terminal.sessionState,
        sessionId: nextSession.id,
        sessionData: nextSession,
        projectPath: terminal.sessionState?.projectPath || nextSession.project_path,
        initialProjectPath: terminal.sessionState?.initialProjectPath || nextSession.project_path,
      },
    });

    updatePaneState(workspace.id, terminal.id, paneId, {
      sessionId: nextSession.id,
      projectPath: paneRuntime.projectPath || nextSession.project_path,
    });
  };

  const handleRestorePreferenceChange = (nextPreference: 'resume_latest' | 'start_fresh') => {
    if (paneRuntime.restorePreference === nextPreference) {
      return;
    }

    updatePaneState(workspace.id, terminal.id, paneId, {
      restorePreference: nextPreference,
    });
  };

  const handleResumeSessionIdChange = (nextSessionId: string | undefined) => {
    if ((paneRuntime.sessionId || undefined) === nextSessionId) {
      return;
    }

    updatePaneState(workspace.id, terminal.id, paneId, {
      sessionId: nextSessionId,
    });
  };

  const handleAutoRenameTerminalTitle = React.useCallback(
    (title: string) => {
      updateTab(terminal.id, { title });
    },
    [terminal.id, updateTab]
  );

  return (
    <div
      className={cn(
        'flex h-full flex-col border bg-background',
        isActive ? 'border-[var(--color-chrome-border)]' : 'border-[var(--color-chrome-border)]/70'
      )}
      onMouseDown={() => activatePane(workspace.id, terminal.id, paneId)}
      data-testid={exposeTestId ? `workspace-pane-${paneId}` : `hidden-workspace-pane-${paneId}`}
    >
      <div className="workspace-chrome-row flex h-8 items-center justify-between border-b border-[var(--color-chrome-border)]/80 bg-[var(--color-chrome-surface)]">
        <div className="workspace-chip-icon-align flex items-center gap-1.5 text-[12px] leading-none font-medium tracking-[0.01em] text-[var(--color-chrome-text)]">
          {terminal.kind === 'agent' ? (
            <Bot className="h-3.5 w-3.5" />
          ) : (
            <Terminal className="h-3.5 w-3.5" />
          )}
          <span className="truncate">{terminal.title}</span>
        </div>

        <div className="flex items-center gap-0.5">
          <Button
            size="icon"
            variant="ghost"
            className="h-5 w-5 text-[var(--color-chrome-text)] hover:bg-[var(--color-chrome-active)] hover:text-[var(--color-chrome-text-active)]"
            onClick={(event) => {
              event.stopPropagation();
              splitPane(workspace.id, terminal.id, paneId);
            }}
            title={exposeTestId ? 'Split Right' : undefined}
            aria-label={exposeTestId ? 'Split Right' : 'Hidden Split Right'}
          >
            <Columns2 className="h-2.5 w-2.5" />
          </Button>
          <Button
            size="icon"
            variant="ghost"
            className="h-5 w-5 text-[var(--color-chrome-text)] hover:bg-[var(--color-chrome-active)] hover:text-[var(--color-chrome-text-active)]"
            onClick={(event) => {
              event.stopPropagation();
              closePane(workspace.id, terminal.id, paneId);
            }}
            title={exposeTestId ? 'Close Pane' : undefined}
            aria-label={exposeTestId ? 'Close Pane' : 'Hidden Close Pane'}
          >
            <X className="h-2.5 w-2.5" />
          </Button>
        </div>
      </div>

      <div className="relative min-h-0 flex-1">
        {terminal.kind === 'agent' ? (
          terminal.sessionState?.agentData ? (
            <AgentExecution
              key={`agent-execution-${terminal.id}-${paneId}-${terminal.sessionState?.agentData?.id || ''}`}
              agent={terminal.sessionState.agentData}
              projectPath={projectPath}
              tabId={terminal.id}
              onBack={() => {}}
              className="h-full"
            />
          ) : terminal.sessionState?.agentRunId ? (
            <AgentRunOutputViewer
              key={`agent-output-${terminal.id}-${paneId}-${terminal.sessionState.agentRunId}`}
              agentRunId={terminal.sessionState.agentRunId}
              tabId={terminal.id}
              className="h-full"
            />
          ) : (
            <div className="flex h-full items-center justify-center text-sm text-muted-foreground">
              No agent run configured for this terminal.
            </div>
          )
        ) : (
          <ClaudeCodeSession
            key={`chat-pane-${terminal.id}-${paneId}`}
            embedded
            paneId={paneId}
            workspaceId={workspace.id}
            terminalTabId={terminal.id}
            hideProjectBar={false}
            hideFloatingGlobalControls={false}
            previewMode="slideover"
            session={terminal.sessionState?.sessionData}
            initialProjectPath={projectPath}
            providerId={providerId}
            onProviderChange={handleProviderChange}
            onProjectPathChange={handleProjectPathChange}
            onSessionResolved={handleSessionResolved}
            embeddedTerminalId={paneRuntime.embeddedTerminalId}
            onEmbeddedTerminalIdChange={handleEmbeddedTerminalIdChange}
            isPaneVisible={isPaneVisible}
            isPaneActive={isActive}
            resumeSessionId={resumeSessionId}
            persistentTerminalSessionId={persistentTerminalSessionId}
            restorePreference={paneRuntime.restorePreference}
            onRestorePreferenceChange={handleRestorePreferenceChange}
            onResumeSessionIdChange={handleResumeSessionIdChange}
            currentTerminalTitle={terminal.title}
            isTerminalTitleLocked={Boolean(terminal.titleLocked)}
            onAutoRenameTerminalTitle={handleAutoRenameTerminalTitle}
            onBack={() => {}}
            className="h-full"
          />
        )}
      </div>
    </div>
  );
};

export default TerminalPaneSurface;

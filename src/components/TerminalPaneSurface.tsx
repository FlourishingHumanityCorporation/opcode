import React from 'react';
import { Bot, Columns2, Terminal, X } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { cn } from '@/lib/utils';
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
}

export const TerminalPaneSurface: React.FC<TerminalPaneSurfaceProps> = ({
  workspace,
  terminal,
  paneId,
  isActive,
}) => {
  const {
    splitPane,
    closePane,
    activatePane,
    updateTab,
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

  const handleProviderChange = (nextProvider: string) => {
    updateTab(terminal.id, {
      providerId: nextProvider,
      sessionState: {
        ...terminal.sessionState,
        providerId: nextProvider,
      },
      paneStates: {
        ...terminal.paneStates,
        [paneId]: {
          ...paneRuntime,
          providerId: nextProvider,
        },
      },
    });
  };

  const handleProjectPathChange = (nextPath: string) => {
    updateTab(terminal.id, {
      sessionState: {
        ...terminal.sessionState,
        projectPath: nextPath,
        initialProjectPath: terminal.sessionState?.initialProjectPath || nextPath,
      },
      paneStates: {
        ...terminal.paneStates,
        [paneId]: {
          ...paneRuntime,
          projectPath: nextPath,
        },
      },
    });

    if (!workspace.projectPath) {
      updateTab(workspace.id, {
        projectPath: nextPath,
        title: workspace.title === 'Project' ? nextPath.split(/[\\/]/).pop() || workspace.title : workspace.title,
      });
    }
  };

  return (
    <div
      className={cn(
        'flex h-full flex-col border bg-background',
        isActive ? 'border-[var(--color-chrome-border)]' : 'border-[var(--color-chrome-border)]/70'
      )}
      onMouseDown={() => activatePane(workspace.id, terminal.id, paneId)}
      data-testid={`workspace-pane-${paneId}`}
    >
      <div className="workspace-chrome-row flex h-8 items-center justify-between border-b border-[var(--color-chrome-border)]/80 bg-[var(--color-chrome-surface)]">
        <div className="flex items-center gap-1.5 text-[12px] leading-none font-medium tracking-[0.01em] text-[var(--color-chrome-text)]">
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
            title="Split Right"
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
            title="Close Pane"
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
            hideProjectBar={false}
            hideFloatingGlobalControls={false}
            previewMode="slideover"
            session={terminal.sessionState?.sessionData}
            initialProjectPath={projectPath}
            providerId={providerId}
            onProviderChange={handleProviderChange}
            onProjectPathChange={handleProjectPathChange}
            onBack={() => {}}
            className="h-full"
          />
        )}
      </div>
    </div>
  );
};

export default TerminalPaneSurface;

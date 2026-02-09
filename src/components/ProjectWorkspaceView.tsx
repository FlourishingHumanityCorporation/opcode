import React from 'react';
import { motion } from 'framer-motion';
import { Files, FolderOpen, Lock, LockOpen, Plus, Terminal, X } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { cn } from '@/lib/utils';
import type { Tab, TerminalTab } from '@/contexts/TabContext';
import { WorkspacePaneTree } from '@/components/WorkspacePaneTree';
import { ProjectExplorerPanel } from '@/components/ProjectExplorerPanel';
import { SplitPane } from '@/components/ui/split-pane';
import { useTabState } from '@/hooks/useTabState';
import {
  getStatusIndicator,
  renderTabStatusMarker,
  type TabStatusIndicator,
} from '@/components/tabStatusIndicator';
import {
  getExplorerOpen,
  getExplorerWidth,
  setExplorerOpen,
  setExplorerWidth,
} from '@/lib/projectExplorerPreferences';

interface ProjectWorkspaceViewProps {
  workspace: Tab;
  isVisible?: boolean;
}

function getTerminalTitle(terminal: TerminalTab, index: number): string {
  if (terminal.title && terminal.title.trim().length > 0) {
    return terminal.title;
  }
  return `Terminal ${index + 1}`;
}

export function getTerminalStatusMeta(
  status: TerminalTab["status"]
): TabStatusIndicator | null {
  return getStatusIndicator(status);
}

export function resolveTerminalStatusOnActivate(
  status: TerminalTab["status"]
): TerminalTab["status"] {
  if (status === "complete" || status === "attention") {
    return "idle";
  }
  return status;
}

export function toggleTerminalTitleLock(
  updateTab: (id: string, updates: Partial<TerminalTab>) => void,
  terminal: TerminalTab
): void {
  updateTab(terminal.id, {
    titleLocked: !terminal.titleLocked,
  });
}

export function toggleExplorerPanel(currentlyOpen: boolean): boolean {
  return !currentlyOpen;
}

export function persistExplorerSplitWidth(workspaceId: string, width: number): number {
  setExplorerWidth(workspaceId, width);
  return width;
}

export const ProjectWorkspaceView: React.FC<ProjectWorkspaceViewProps> = ({
  workspace,
  isVisible = true,
}) => {
  const {
    createTerminalTab,
    closeTerminalTab,
    setActiveTerminalTab,
    updateTab,
  } = useTabState();
  const [explorerOpen, setExplorerPanelOpen] = React.useState<boolean>(() => getExplorerOpen(workspace.id));
  const [explorerSplit, setExplorerSplit] = React.useState<number>(() => getExplorerWidth(workspace.id));

  const activeTerminal = workspace.terminalTabs.find((tab) => tab.id === workspace.activeTerminalTabId) || workspace.terminalTabs[0];
  const openProjectPicker = async () => {
    try {
      const tauriAvailable = typeof window !== 'undefined' && (
        Boolean((window as any).__TAURI__) || Boolean((window as any).__TAURI_INTERNALS__)
      );
      let selected: string | null = null;

      if (tauriAvailable) {
        try {
          const { open } = await import('@tauri-apps/plugin-dialog');
          const result = await open({
            directory: true,
            multiple: false,
            title: 'Open Project',
          });
          if (typeof result === 'string') {
            selected = result;
          }
        } catch (dialogError) {
          console.error('Failed to open native directory picker:', dialogError);
        }
      }

      if (!selected) {
        selected = window.localStorage.getItem('opcode.smoke.projectPath') || '';
      }

      if (!selected) {
        const typedPath = window.prompt('Enter project path', workspace.projectPath || '');
        if (typedPath && typedPath.trim()) {
          selected = typedPath.trim();
        }
      }

      if (!selected) {
        return;
      }

      updateTab(workspace.id, {
        projectPath: selected,
        title: selected.split(/[\\/]/).filter(Boolean).pop() || workspace.title,
      });

      if (activeTerminal) {
        updateTab(activeTerminal.id, {
          sessionState: {
            ...activeTerminal.sessionState,
            projectPath: selected,
            initialProjectPath: activeTerminal.sessionState?.initialProjectPath || selected,
          },
        });
      }
    } catch (error) {
      console.error('Failed to open project picker:', error);
    }
  };

  React.useEffect(() => {
    const handleFocusOpenProject = (event: Event) => {
      const detail = (event as CustomEvent<{ workspaceId: string }>).detail;
      if (!detail?.workspaceId || detail.workspaceId !== workspace.id) {
        return;
      }
      openProjectPicker();
    };

    window.addEventListener('focus-open-project', handleFocusOpenProject as EventListener);
    return () => {
      window.removeEventListener('focus-open-project', handleFocusOpenProject as EventListener);
    };
  }, [workspace.id]);

  React.useEffect(() => {
    setExplorerPanelOpen(getExplorerOpen(workspace.id));
    setExplorerSplit(getExplorerWidth(workspace.id));
  }, [workspace.id]);

  const handleCreateTerminal = () => {
    const terminalCount = workspace.terminalTabs.length;
    createTerminalTab(workspace.id, {
      kind: 'chat',
      title: `Terminal ${terminalCount + 1}`,
      sessionState: {
        projectPath: workspace.projectPath || undefined,
        initialProjectPath: workspace.projectPath || undefined,
      },
    });
  };

  const handleActivateTerminal = (terminal: TerminalTab) => {
    setActiveTerminalTab(workspace.id, terminal.id);
    const nextStatus = resolveTerminalStatusOnActivate(terminal.status);
    if (nextStatus !== terminal.status) {
      updateTab(terminal.id, { status: nextStatus });
    }
  };

  const handleRenameTerminal = (terminal: TerminalTab) => {
    const nextTitle = window.prompt('Rename terminal', terminal.title || 'Terminal');
    if (!nextTitle) return;
    updateTab(terminal.id, { title: nextTitle.trim() });
  };

  const handleToggleExplorer = () => {
    setExplorerPanelOpen((current) => {
      const next = toggleExplorerPanel(current);
      setExplorerOpen(workspace.id, next);
      return next;
    });
  };

  const handleExplorerSplitChange = React.useCallback(
    (nextWidth: number) => {
      const persisted = persistExplorerSplitWidth(workspace.id, nextWidth);
      setExplorerSplit(persisted);
    },
    [workspace.id]
  );

  if (!activeTerminal) {
    return (
      <div className="flex h-full items-center justify-center text-muted-foreground">
        No terminal tabs in this workspace.
      </div>
    );
  }

  return (
    <div className="relative flex h-full min-h-0 flex-col bg-background">
      <div className="workspace-chrome-band shrink-0">
        <div className="workspace-chrome-row workspace-chrome-box flex h-9 items-center gap-0.5">
          <div className="flex min-w-0 flex-1 items-center gap-1.5 overflow-x-auto scrollbar-hide">
            {workspace.terminalTabs.map((terminal, index) => {
              const isActive = terminal.id === activeTerminal.id;
              const statusIndicator = getTerminalStatusMeta(terminal.status);
              return (
                <motion.button
                  key={terminal.id}
                  whileTap={{ scale: 0.98 }}
                  onClick={() => handleActivateTerminal(terminal)}
                  onDoubleClick={() => handleRenameTerminal(terminal)}
                  className={cn(
                    'group flex h-7 min-w-[132px] max-w-[280px] items-center gap-1.5 rounded-md border px-2.5 text-[12px] leading-none tracking-[0.01em]',
                    isActive
                      ? 'border-[var(--color-chrome-border)] bg-[var(--color-chrome-active)] text-[var(--color-chrome-text-active)] font-semibold shadow-[inset_0_1px_0_rgba(255,255,255,0.18),0_1px_1px_rgba(0,0,0,0.05)]'
                      : 'border-transparent bg-[var(--color-chrome-surface)] text-[var(--color-chrome-text)] hover:bg-[var(--color-chrome-active)] hover:text-[var(--color-chrome-text-active)] font-medium'
                  )}
                  data-testid={isVisible ? `terminal-tab-${terminal.id}` : `hidden-terminal-tab-${terminal.id}`}
                >
                  <span className="flex h-3.5 w-3.5 shrink-0 items-center justify-center">
                    {statusIndicator ? (
                      renderTabStatusMarker(statusIndicator)
                    ) : (
                      <Terminal className="h-3.5 w-3.5" />
                    )}
                  </span>
                  <span className="truncate text-left">{getTerminalTitle(terminal, index)}</span>
                  <Button
                    size="icon"
                    variant="ghost"
                    className={cn(
                      "h-4 w-4 shrink-0 p-0",
                      isActive ? "opacity-100" : "opacity-0 group-hover:opacity-100"
                    )}
                    onClick={(event) => {
                      event.stopPropagation();
                      toggleTerminalTitleLock(updateTab, terminal);
                    }}
                    title={terminal.titleLocked ? "Unlock title" : "Lock title"}
                    aria-label={terminal.titleLocked ? "Unlock title" : "Lock title"}
                  >
                    {terminal.titleLocked ? <Lock className="h-3 w-3" /> : <LockOpen className="h-3 w-3" />}
                  </Button>
                  <Button
                    size="icon"
                    variant="ghost"
                    className={cn('h-4 w-4 shrink-0 p-0', isActive ? 'opacity-100' : 'opacity-0 group-hover:opacity-100')}
                    onClick={(event) => {
                      event.stopPropagation();
                      closeTerminalTab(workspace.id, terminal.id);
                    }}
                  >
                    <X className="h-3 w-3" />
                  </Button>
                </motion.button>
              );
            })}
          </div>

          <Button
            size="icon"
            variant="ghost"
            className={cn(
              "h-7 w-7 shrink-0 text-[var(--color-chrome-text)] hover:bg-[var(--color-chrome-active)] hover:text-[var(--color-chrome-text-active)]",
              explorerOpen && "bg-[var(--color-chrome-active)] text-[var(--color-chrome-text-active)]"
            )}
            onClick={handleToggleExplorer}
            title={explorerOpen ? "Hide explorer" : "Show explorer"}
            data-testid={isVisible ? `workspace-toggle-explorer-${workspace.id}` : `hidden-workspace-toggle-explorer-${workspace.id}`}
          >
            <Files className="h-4 w-4" />
          </Button>

          <Button
            size="icon"
            variant="ghost"
            className="h-7 w-7 shrink-0 text-[var(--color-chrome-text)] hover:bg-[var(--color-chrome-active)] hover:text-[var(--color-chrome-text-active)]"
            onClick={handleCreateTerminal}
            title="New terminal tab"
            data-testid={isVisible ? 'workspace-new-terminal' : `hidden-workspace-new-terminal-${workspace.id}`}
          >
            <Plus className="h-4 w-4" />
          </Button>
        </div>
      </div>

      <div className="min-h-0 flex-1">
        {workspace.projectPath ? (
          <SplitPane
            left={
              <ProjectExplorerPanel
                projectPath={workspace.projectPath}
                workspaceId={workspace.id}
                isVisible={isVisible && explorerOpen}
              />
            }
            right={
              <div className="relative h-full min-w-0 overflow-hidden">
                {workspace.terminalTabs.map((terminal) => {
                  const isActive = terminal.id === activeTerminal.id;
                  const isTerminalVisible = isVisible && isActive;
                  return (
                    <div
                      key={terminal.id}
                      className={cn(
                        'absolute inset-0 h-full transition-opacity duration-150',
                        isActive
                          ? 'visible opacity-100 pointer-events-auto'
                          : 'invisible opacity-0 pointer-events-none'
                      )}
                      aria-hidden={!isActive}
                    >
                      <WorkspacePaneTree
                        workspace={workspace}
                        terminal={terminal}
                        node={terminal.paneTree}
                        exposeTestIds={isActive}
                        isPaneVisible={isTerminalVisible}
                      />
                    </div>
                  );
                })}
              </div>
            }
            initialSplit={explorerSplit}
            minLeftWidth={220}
            minRightWidth={420}
            onSplitChange={handleExplorerSplitChange}
            leftCollapsed={!explorerOpen}
          />
        ) : (
          <div className="relative h-full">
            {workspace.terminalTabs.map((terminal) => {
              const isActive = terminal.id === activeTerminal.id;
              const isTerminalVisible = isVisible && isActive;
              return (
                <div
                  key={terminal.id}
                  className={cn(
                    'absolute inset-0 h-full transition-opacity duration-150',
                    isActive
                      ? 'visible opacity-100 pointer-events-auto'
                      : 'invisible opacity-0 pointer-events-none'
                  )}
                  aria-hidden={!isActive}
                >
                  <WorkspacePaneTree
                    workspace={workspace}
                    terminal={terminal}
                    node={terminal.paneTree}
                    exposeTestIds={isActive}
                    isPaneVisible={isTerminalVisible}
                  />
                </div>
              );
            })}
          </div>
        )}
      </div>

      {!workspace.projectPath && (
        <div className="pointer-events-none absolute inset-x-0 top-14 z-20 flex justify-center">
          <div className="pointer-events-auto rounded-lg border border-border/70 bg-card/95 px-4 py-2 shadow-xl backdrop-blur">
            <div className="flex items-center gap-3 text-xs">
              <span className="text-muted-foreground">No project selected for this workspace.</span>
              <Button
                size="sm"
                className="h-7"
                onClick={openProjectPicker}
                data-testid={isVisible ? 'workspace-open-project' : `hidden-workspace-open-project-${workspace.id}`}
              >
                <FolderOpen className="mr-1.5 h-3.5 w-3.5" />
                Open Project
              </Button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
};

export default ProjectWorkspaceView;

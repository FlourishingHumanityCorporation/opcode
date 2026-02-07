import React from 'react';
import { motion } from 'framer-motion';
import { FolderOpen, Plus, Terminal, X } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { cn } from '@/lib/utils';
import type { Tab, TerminalTab } from '@/contexts/TabContext';
import { WorkspacePaneTree } from '@/components/WorkspacePaneTree';
import { useTabState } from '@/hooks/useTabState';

interface ProjectWorkspaceViewProps {
  workspace: Tab;
}

function getTerminalTitle(terminal: TerminalTab, index: number): string {
  if (terminal.title && terminal.title.trim().length > 0) {
    return terminal.title;
  }
  return `Terminal ${index + 1}`;
}

export const ProjectWorkspaceView: React.FC<ProjectWorkspaceViewProps> = ({ workspace }) => {
  const {
    createTerminalTab,
    closeTerminalTab,
    setActiveTerminalTab,
    updateTab,
  } = useTabState();

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

  const handleRenameTerminal = (terminal: TerminalTab) => {
    const nextTitle = window.prompt('Rename terminal', terminal.title || 'Terminal');
    if (!nextTitle) return;
    updateTab(terminal.id, { title: nextTitle.trim() });
  };

  if (!activeTerminal) {
    return (
      <div className="flex h-full items-center justify-center text-muted-foreground">
        No terminal tabs in this workspace.
      </div>
    );
  }

  return (
    <div className="relative flex h-full min-h-0 flex-col bg-background">
      <div className="flex h-10 shrink-0 items-center gap-1 border-b border-border/60 bg-card/70 px-2">
        <div className="flex min-w-0 flex-1 items-center gap-1 overflow-x-auto scrollbar-hide">
          {workspace.terminalTabs.map((terminal, index) => {
            const isActive = terminal.id === activeTerminal.id;
            return (
              <motion.button
                key={terminal.id}
                whileTap={{ scale: 0.98 }}
                onClick={() => setActiveTerminalTab(workspace.id, terminal.id)}
                onDoubleClick={() => handleRenameTerminal(terminal)}
                className={cn(
                  'group flex h-8 min-w-[140px] max-w-[260px] items-center gap-2 rounded-md border px-2 text-xs',
                  isActive
                    ? 'border-primary/50 bg-background text-foreground shadow-[0_0_0_1px_rgba(255,255,255,0.04)]'
                    : 'border-transparent bg-muted/40 text-muted-foreground hover:bg-muted/70 hover:text-foreground'
                )}
                data-testid={`terminal-tab-${terminal.id}`}
              >
                <Terminal className="h-3.5 w-3.5 shrink-0" />
                <span className="truncate text-left">{getTerminalTitle(terminal, index)}</span>
                <Button
                  size="icon"
                  variant="ghost"
                  className={cn('h-5 w-5 shrink-0 p-0', isActive ? 'opacity-100' : 'opacity-0 group-hover:opacity-100')}
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
          className="h-8 w-8 shrink-0"
          onClick={handleCreateTerminal}
          title="New terminal tab"
          data-testid="workspace-new-terminal"
        >
          <Plus className="h-4 w-4" />
        </Button>
      </div>

      <div className="min-h-0 flex-1">
        <WorkspacePaneTree workspace={workspace} terminal={activeTerminal} node={activeTerminal.paneTree} />
      </div>

      {!workspace.projectPath && (
        <div className="pointer-events-none absolute inset-x-0 top-14 z-20 flex justify-center">
          <div className="pointer-events-auto rounded-lg border border-border/70 bg-card/95 px-4 py-2 shadow-xl backdrop-blur">
            <div className="flex items-center gap-3 text-xs">
              <span className="text-muted-foreground">No project selected for this workspace.</span>
              <Button size="sm" className="h-7" onClick={openProjectPicker} data-testid="workspace-open-project">
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

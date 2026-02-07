import React, { useEffect } from 'react';
import { AnimatePresence, motion } from 'framer-motion';
import { FolderOpen, Plus } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { useTabState } from '@/hooks/useTabState';
import { ProjectWorkspaceView } from '@/components/ProjectWorkspaceView';
import { UtilityRail } from '@/components/UtilityRail';
import { UtilityOverlayHost } from '@/components/UtilityOverlayHost';

export const TabContent: React.FC = () => {
  const {
    tabs,
    activeWorkspace,
    activeTabId,
    utilityOverlay,
    utilityPayload,
    createProjectWorkspaceTab,
    createChatTab,
    createAgentExecutionTab,
    createCreateAgentTab,
    createImportAgentTab,
    createClaudeFileTab,
    findTabBySessionId,
    setActiveTerminalTab,
    switchToTab,
    closeTab,
    openUtilityOverlay,
    closeUtilityOverlay,
    updateTab,
  } = useTabState();

  useEffect(() => {
    const handleOpenSessionInTab = (event: Event) => {
      const detail = (event as CustomEvent<{ session: any }>).detail;
      const session = detail?.session;
      if (!session) return;

      const existing = findTabBySessionId(session.id);
      if (existing && 'kind' in existing) {
        const owner = tabs.find((workspace) => workspace.terminalTabs.some((terminal) => terminal.id === existing.id));
        if (owner) {
          switchToTab(owner.id);
          setActiveTerminalTab(owner.id, existing.id);
          updateTab(existing.id, {
            sessionState: {
              ...existing.sessionState,
              sessionData: session,
              sessionId: session.id,
              projectPath: session.project_path,
              initialProjectPath: session.project_path,
            },
            title: session.project_path?.split(/[\\/]/).pop() || existing.title,
          });
          return;
        }
      }

      createChatTab(session.id, session.project_path?.split(/[\\/]/).pop() || 'Session', session.project_path);
    };

    const handleOpenClaudeFile = (event: Event) => {
      const detail = (event as CustomEvent<{ file: any }>).detail;
      const file = detail?.file;
      if (!file) return;
      createClaudeFileTab(file.id, file.name || 'CLAUDE.md');
    };

    const handleOpenAgentExecution = (event: Event) => {
      const detail = (event as CustomEvent<{ agent: any; tabId: string; projectPath?: string }>).detail;
      if (!detail?.agent) return;
      createAgentExecutionTab(detail.agent, detail.tabId, detail.projectPath);
    };

    const handleOpenCreateAgent = () => {
      createCreateAgentTab();
    };

    const handleOpenImportAgent = () => {
      createImportAgentTab();
    };

    const handleCloseTab = (event: Event) => {
      const detail = (event as CustomEvent<{ tabId: string }>).detail;
      if (!detail?.tabId) return;
      closeTab(detail.tabId);
    };

    const handleClaudeSessionSelected = (event: Event) => {
      const detail = (event as CustomEvent<{ session: any }>).detail;
      if (!detail?.session) return;
      window.dispatchEvent(new CustomEvent('open-session-in-tab', { detail }));
    };

    const handleOpenUtilityOverlay = (event: Event) => {
      const detail = (event as CustomEvent<{ overlay: 'agents' | 'usage' | 'mcp' | 'settings' | 'claude-md'; payload?: any }>).detail;
      if (!detail?.overlay) return;
      openUtilityOverlay(detail.overlay, detail.payload);
    };

    const handleCloseUtilityOverlay = () => {
      closeUtilityOverlay();
    };

    window.addEventListener('open-session-in-tab', handleOpenSessionInTab as EventListener);
    window.addEventListener('open-claude-file', handleOpenClaudeFile as EventListener);
    window.addEventListener('open-agent-execution', handleOpenAgentExecution as EventListener);
    window.addEventListener('open-create-agent-tab', handleOpenCreateAgent);
    window.addEventListener('open-import-agent-tab', handleOpenImportAgent);
    window.addEventListener('close-tab', handleCloseTab as EventListener);
    window.addEventListener('claude-session-selected', handleClaudeSessionSelected as EventListener);
    window.addEventListener('open-utility-overlay', handleOpenUtilityOverlay as EventListener);
    window.addEventListener('close-utility-overlay', handleCloseUtilityOverlay);

    return () => {
      window.removeEventListener('open-session-in-tab', handleOpenSessionInTab as EventListener);
      window.removeEventListener('open-claude-file', handleOpenClaudeFile as EventListener);
      window.removeEventListener('open-agent-execution', handleOpenAgentExecution as EventListener);
      window.removeEventListener('open-create-agent-tab', handleOpenCreateAgent);
      window.removeEventListener('open-import-agent-tab', handleOpenImportAgent);
      window.removeEventListener('close-tab', handleCloseTab as EventListener);
      window.removeEventListener('claude-session-selected', handleClaudeSessionSelected as EventListener);
      window.removeEventListener('open-utility-overlay', handleOpenUtilityOverlay as EventListener);
      window.removeEventListener('close-utility-overlay', handleCloseUtilityOverlay);
    };
  }, [
    closeTab,
    createAgentExecutionTab,
    createChatTab,
    createClaudeFileTab,
    createCreateAgentTab,
    createImportAgentTab,
    findTabBySessionId,
    openUtilityOverlay,
    closeUtilityOverlay,
    setActiveTerminalTab,
    switchToTab,
    tabs,
    updateTab,
  ]);

  const content = (!activeWorkspace || !activeTabId) ? (
    <div className="relative flex h-full items-center justify-center bg-background">
      <div className="text-center">
        <p className="text-lg font-medium">No projects open</p>
        <p className="mt-1 text-sm text-muted-foreground">Create a project workspace to begin.</p>
        <div className="mt-4 flex justify-center gap-2">
          <Button onClick={() => createProjectWorkspaceTab('', `Project ${tabs.length + 1}`)} data-testid="empty-new-project">
            <Plus className="mr-2 h-4 w-4" />
            New Project
          </Button>
          <Button
            variant="outline"
            onClick={() => {
              const id = createProjectWorkspaceTab('', `Project ${tabs.length + 1}`);
              window.setTimeout(() => {
                window.dispatchEvent(new CustomEvent('focus-open-project', { detail: { workspaceId: id } }));
              }, 0);
            }}
          >
            <FolderOpen className="mr-2 h-4 w-4" />
            Open Project
          </Button>
        </div>
      </div>
    </div>
  ) : (
    <AnimatePresence mode="wait">
      <motion.div
        key={activeWorkspace.id}
        initial={{ opacity: 0, y: 6 }}
        animate={{ opacity: 1, y: 0 }}
        exit={{ opacity: 0, y: -6 }}
        transition={{ duration: 0.15 }}
        className="h-full"
      >
        <ProjectWorkspaceView workspace={activeWorkspace} />
      </motion.div>
    </AnimatePresence>
  );

  return (
    <div className="relative h-full">
      {content}

      <UtilityRail
        active={utilityOverlay}
        onOpen={(overlay) => openUtilityOverlay(overlay)}
        onClose={closeUtilityOverlay}
      />

      <UtilityOverlayHost overlay={utilityOverlay} payload={utilityPayload} onClose={closeUtilityOverlay} />
    </div>
  );
};

export default TabContent;

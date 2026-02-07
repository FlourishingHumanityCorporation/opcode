import React, { useEffect, useRef, useState } from 'react';
import { AnimatePresence, Reorder, motion } from 'framer-motion';
import { Folder, Plus, X } from 'lucide-react';
import { cn } from '@/lib/utils';
import { useTabState } from '@/hooks/useTabState';
import { useTabContext, type Tab } from '@/contexts/TabContext';

interface TabManagerProps {
  className?: string;
}

interface ProjectTabItemProps {
  tab: Tab;
  isActive: boolean;
  onClick: (id: string) => void;
  onClose: (id: string) => void;
}

const ProjectTabItem: React.FC<ProjectTabItemProps> = ({ tab, isActive, onClick, onClose }) => {
  return (
    <Reorder.Item
      value={tab}
      id={tab.id}
      className={cn(
        'group flex h-9 min-w-[170px] max-w-[260px] items-center gap-2 rounded-lg border px-3 text-sm',
        'cursor-pointer select-none transition-colors',
        isActive
          ? 'border-primary/40 bg-card text-foreground shadow-[0_0_0_1px_rgba(255,255,255,0.04)]'
          : 'border-border/40 bg-background text-muted-foreground hover:bg-muted/40 hover:text-foreground'
      )}
      onClick={() => onClick(tab.id)}
      data-testid={`workspace-tab-${tab.id}`}
    >
      <Folder className="h-4 w-4 shrink-0" />
      <span className="truncate text-center w-full">{tab.title || 'Project'}</span>
      <button
        className={cn(
          'shrink-0 rounded-sm p-0.5 hover:bg-destructive/15 hover:text-destructive',
          isActive ? 'opacity-100' : 'opacity-0 group-hover:opacity-100'
        )}
        onClick={(event) => {
          event.stopPropagation();
          onClose(tab.id);
        }}
        aria-label={`Close ${tab.title}`}
      >
        <X className="h-3.5 w-3.5" />
      </button>
    </Reorder.Item>
  );
};

export const TabManager: React.FC<TabManagerProps> = ({ className }) => {
  const {
    tabs,
    activeTabId,
    switchToTab,
    closeProjectWorkspaceTab,
    createProjectWorkspaceTab,
  } = useTabState();
  const { reorderTabs } = useTabContext();

  const [showLeftScroll, setShowLeftScroll] = useState(false);
  const [showRightScroll, setShowRightScroll] = useState(false);
  const scrollRef = useRef<HTMLDivElement>(null);

  const updateScrollState = () => {
    const node = scrollRef.current;
    if (!node) return;
    setShowLeftScroll(node.scrollLeft > 0);
    setShowRightScroll(node.scrollLeft + node.clientWidth < node.scrollWidth - 1);
  };

  useEffect(() => {
    updateScrollState();
    const node = scrollRef.current;
    if (!node) return;

    node.addEventListener('scroll', updateScrollState);
    window.addEventListener('resize', updateScrollState);

    return () => {
      node.removeEventListener('scroll', updateScrollState);
      window.removeEventListener('resize', updateScrollState);
    };
  }, [tabs]);

  useEffect(() => {
    const onCreateProject = () => {
      createProjectWorkspaceTab('', `Project ${tabs.length + 1}`);
    };

    const onCloseCurrent = () => {
      if (!activeTabId) return;
      closeProjectWorkspaceTab(activeTabId);
    };

    const onNext = () => {
      if (!tabs.length) return;
      const index = tabs.findIndex((tab) => tab.id === activeTabId);
      const next = tabs[(index + 1 + tabs.length) % tabs.length];
      if (next) switchToTab(next.id);
    };

    const onPrev = () => {
      if (!tabs.length) return;
      const index = tabs.findIndex((tab) => tab.id === activeTabId);
      const prev = tabs[(index - 1 + tabs.length) % tabs.length];
      if (prev) switchToTab(prev.id);
    };

    const onByIndex = (event: Event) => {
      const detail = (event as CustomEvent<{ index: number }>).detail;
      const tab = tabs[detail?.index || 0];
      if (tab) switchToTab(tab.id);
    };

    window.addEventListener('create-chat-tab', onCreateProject);
    window.addEventListener('close-current-tab', onCloseCurrent);
    window.addEventListener('switch-to-next-tab', onNext);
    window.addEventListener('switch-to-previous-tab', onPrev);
    window.addEventListener('switch-to-tab-by-index', onByIndex as EventListener);

    return () => {
      window.removeEventListener('create-chat-tab', onCreateProject);
      window.removeEventListener('close-current-tab', onCloseCurrent);
      window.removeEventListener('switch-to-next-tab', onNext);
      window.removeEventListener('switch-to-previous-tab', onPrev);
      window.removeEventListener('switch-to-tab-by-index', onByIndex as EventListener);
    };
  }, [activeTabId, closeProjectWorkspaceTab, createProjectWorkspaceTab, switchToTab, tabs]);

  const handleReorder = (newOrder: Tab[]) => {
    const nextById = newOrder.map((tab) => tab.id);
    const oldOrder = tabs.map((tab) => tab.id);
    const movedId = nextById.find((id, index) => oldOrder[index] !== id);
    if (!movedId) return;
    const startIndex = oldOrder.indexOf(movedId);
    const endIndex = nextById.indexOf(movedId);
    if (startIndex !== -1 && endIndex !== -1 && startIndex !== endIndex) {
      reorderTabs(startIndex, endIndex);
    }
  };

  const scrollTabs = (direction: 'left' | 'right') => {
    const node = scrollRef.current;
    if (!node) return;
    node.scrollBy({
      left: direction === 'left' ? -220 : 220,
      behavior: 'smooth',
    });
  };

  return (
    <div className={cn('relative flex h-11 items-center border-b border-border/60 bg-[#0b0f14] px-2', className)}>
      <AnimatePresence>
        {showLeftScroll && (
          <motion.button
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            className="z-10 mr-1 rounded-md border border-border/40 bg-background/70 px-2 py-1 text-xs"
            onClick={() => scrollTabs('left')}
          >
            {'<'}
          </motion.button>
        )}
      </AnimatePresence>

      <div ref={scrollRef} className="scrollbar-hide flex min-w-0 flex-1 items-center gap-2 overflow-x-auto">
        <Reorder.Group axis="x" values={tabs} onReorder={handleReorder} className="flex items-center gap-2">
          {tabs.map((tab) => (
            <ProjectTabItem
              key={tab.id}
              tab={tab}
              isActive={tab.id === activeTabId}
              onClick={switchToTab}
              onClose={closeProjectWorkspaceTab}
            />
          ))}
        </Reorder.Group>
      </div>

      <AnimatePresence>
        {showRightScroll && (
          <motion.button
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            className="z-10 ml-1 rounded-md border border-border/40 bg-background/70 px-2 py-1 text-xs"
            onClick={() => scrollTabs('right')}
          >
            {'>'}
          </motion.button>
        )}
      </AnimatePresence>

      <button
        onClick={() => createProjectWorkspaceTab('', `Project ${tabs.length + 1}`)}
        className="ml-2 flex h-8 w-8 items-center justify-center rounded-md border border-border/50 bg-card/70 hover:bg-card"
        title="New Project Workspace"
        data-testid="workspace-new-project"
      >
        <Plus className="h-4 w-4" />
      </button>
    </div>
  );
};

export default TabManager;

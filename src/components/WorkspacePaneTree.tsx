import React from 'react';
import { cn } from '@/lib/utils';
import type { PaneNode, Tab, TerminalTab } from '@/contexts/TabContext';
import { TerminalPaneSurface } from '@/components/TerminalPaneSurface';

interface WorkspacePaneTreeProps {
  workspace: Tab;
  terminal: TerminalTab;
  node: PaneNode;
  exposeTestIds?: boolean;
  isPaneVisible?: boolean;
}

export const WorkspacePaneTree: React.FC<WorkspacePaneTreeProps> = ({
  workspace,
  terminal,
  node,
  exposeTestIds = true,
  isPaneVisible = true,
}) => {
  if (node.type === 'leaf') {
    return (
      <TerminalPaneSurface
        workspace={workspace}
        terminal={terminal}
        paneId={node.id}
        isActive={terminal.activePaneId === node.id}
        exposeTestId={exposeTestIds}
        isPaneVisible={isPaneVisible}
      />
    );
  }

  const ratio = Number.isFinite(node.widthRatio) ? Math.min(90, Math.max(10, node.widthRatio)) : 50;

  return (
    <div className="flex h-full w-full min-w-0 min-h-0 flex-row">
      <div className="min-w-0 min-h-0" style={{ width: `${ratio}%` }}>
        <WorkspacePaneTree
          workspace={workspace}
          terminal={terminal}
          node={node.left}
          exposeTestIds={exposeTestIds}
          isPaneVisible={isPaneVisible}
        />
      </div>
      <div className={cn('w-px bg-[var(--color-chrome-border)]/80')} />
      <div className="min-w-0 min-h-0 flex-1" style={{ width: `${100 - ratio}%` }}>
        <WorkspacePaneTree
          workspace={workspace}
          terminal={terminal}
          node={node.right}
          exposeTestIds={exposeTestIds}
          isPaneVisible={isPaneVisible}
        />
      </div>
    </div>
  );
};

export default WorkspacePaneTree;

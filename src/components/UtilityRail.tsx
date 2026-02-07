import React from 'react';
import { BarChart3, Bot, Bug, FileText, Network, Settings, X } from 'lucide-react';
import { cn } from '@/lib/utils';
import { Button } from '@/components/ui/button';
import type { UtilityOverlayType } from '@/contexts/TabContext';

interface UtilityRailProps {
  active: UtilityOverlayType;
  onOpen: (overlay: 'agents' | 'usage' | 'mcp' | 'settings' | 'claude-md' | 'diagnostics') => void;
  onClose: () => void;
}

const utilityItems = [
  { id: 'agents', label: 'Agents', icon: Bot },
  { id: 'usage', label: 'Usage', icon: BarChart3 },
  { id: 'mcp', label: 'MCP', icon: Network },
  { id: 'claude-md', label: 'CLAUDE.md', icon: FileText },
  { id: 'diagnostics', label: 'Diagnostics', icon: Bug },
  { id: 'settings', label: 'Settings', icon: Settings },
] as const;

export const UtilityRail: React.FC<UtilityRailProps> = ({ active, onOpen, onClose }) => {
  return (
    <div className="pointer-events-none absolute inset-y-0 right-0 z-30 flex items-center pr-2">
      <div className="pointer-events-auto flex flex-col items-center gap-1 rounded-lg border border-border/70 bg-card/85 p-1.5 backdrop-blur-sm">
        {utilityItems.map((item) => {
          const Icon = item.icon;
          const isActive = active === item.id;
          return (
            <Button
              key={item.id}
              size="icon"
              variant="ghost"
              className={cn(
                'h-8 w-8',
                isActive && 'bg-primary/15 text-primary hover:bg-primary/15'
              )}
              onClick={() => {
                if (isActive) {
                  onClose();
                } else {
                  onOpen(item.id);
                }
              }}
              title={item.label}
              aria-label={item.label}
            >
              <Icon className="h-4 w-4" />
            </Button>
          );
        })}

        {active && (
          <Button
            size="icon"
            variant="ghost"
            className="mt-1 h-7 w-7 text-muted-foreground"
            onClick={onClose}
            title="Close utility panel"
          >
            <X className="h-3.5 w-3.5" />
          </Button>
        )}
      </div>
    </div>
  );
};

export default UtilityRail;

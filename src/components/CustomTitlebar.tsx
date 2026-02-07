import React, { useState, useRef, useEffect } from 'react';
import { motion } from 'framer-motion';
import { Settings, Minus, Square, X, Bot, BarChart3, FileText, Network, Info, MoreVertical, Bug } from 'lucide-react';
import { getCurrentWindow } from '@tauri-apps/api/window';
import { TooltipProvider, TooltipSimple } from '@/components/ui/tooltip-modern';
import { logWorkspaceEvent } from '@/services/workspaceDiagnostics';

interface CustomTitlebarProps {
  onSettingsClick?: () => void;
  onAgentsClick?: () => void;
  onUsageClick?: () => void;
  onClaudeClick?: () => void;
  onMCPClick?: () => void;
  onDiagnosticsClick?: () => void;
  onInfoClick?: () => void;
}

export const CustomTitlebar: React.FC<CustomTitlebarProps> = ({
  onSettingsClick,
  onAgentsClick,
  onUsageClick,
  onClaudeClick,
  onMCPClick,
  onDiagnosticsClick,
  onInfoClick
}) => {
  const [isHovered, setIsHovered] = useState(false);
  const [isDropdownOpen, setIsDropdownOpen] = useState(false);
  const dropdownRef = useRef<HTMLDivElement>(null);
  const actionButtonClass = "p-1 rounded-md text-[var(--color-chrome-text)] hover:bg-[var(--color-chrome-active)] hover:text-[var(--color-chrome-text-active)] transition-colors tauri-no-drag";
  const menuItemClass = "w-full px-3 py-1 text-left text-[12px] font-medium tracking-[0.01em] text-[var(--color-chrome-text)] hover:bg-[var(--color-chrome-active)] hover:text-[var(--color-chrome-text-active)] transition-colors flex items-center gap-2";

  useEffect(() => {
    const handleClickOutside = (event: MouseEvent) => {
      if (dropdownRef.current && !dropdownRef.current.contains(event.target as Node)) {
        setIsDropdownOpen(false);
      }
    };

    document.addEventListener('mousedown', handleClickOutside);
    return () => document.removeEventListener('mousedown', handleClickOutside);
  }, []);

  const handleMinimize = async () => {
    try {
      const window = getCurrentWindow();
      await window.minimize();
      console.log('Window minimized successfully');
    } catch (error) {
      console.error('Failed to minimize window:', error);
    }
  };

  const handleMaximize = async () => {
    try {
      const window = getCurrentWindow();
      const isMaximized = await window.isMaximized();
      if (isMaximized) {
        await window.unmaximize();
        console.log('Window unmaximized successfully');
      } else {
        await window.maximize();
        console.log('Window maximized successfully');
      }
    } catch (error) {
      console.error('Failed to maximize/unmaximize window:', error);
    }
  };

  const handleClose = async () => {
    try {
      const window = getCurrentWindow();
      await window.close();
      console.log('Window closed successfully');
    } catch (error) {
      console.error('Failed to close window:', error);
    }
  };

  return (
    <TooltipProvider>
    <div 
      className="relative z-[200] h-10 bg-[var(--color-chrome-bg)] backdrop-blur-sm flex items-center justify-between select-none border-b border-[var(--color-chrome-border)] tauri-drag"
      data-tauri-drag-region
      onMouseEnter={() => setIsHovered(true)}
      onMouseLeave={() => setIsHovered(false)}
    >
      {/* Left side - macOS Traffic Light buttons */}
      <div className="flex items-center space-x-1.5 pl-3">
        <div className="flex items-center space-x-1.5">
          {/* Close button */}
          <button
            onClick={(e) => {
              e.stopPropagation();
              handleClose();
            }}
            className="group relative w-3 h-3 rounded-full bg-red-500 hover:bg-red-600 transition-all duration-200 flex items-center justify-center tauri-no-drag"
            title="Close"
          >
            {isHovered && (
              <X size={8} className="text-red-900 opacity-60 group-hover:opacity-100" />
            )}
          </button>

          {/* Minimize button */}
          <button
            onClick={(e) => {
              e.stopPropagation();
              handleMinimize();
            }}
            className="group relative w-3 h-3 rounded-full bg-yellow-500 hover:bg-yellow-600 transition-all duration-200 flex items-center justify-center tauri-no-drag"
            title="Minimize"
          >
            {isHovered && (
              <Minus size={8} className="text-yellow-900 opacity-60 group-hover:opacity-100" />
            )}
          </button>

          {/* Maximize button */}
          <button
            onClick={(e) => {
              e.stopPropagation();
              handleMaximize();
            }}
            className="group relative w-3 h-3 rounded-full bg-green-500 hover:bg-green-600 transition-all duration-200 flex items-center justify-center tauri-no-drag"
            title="Maximize"
          >
            {isHovered && (
              <Square size={6} className="text-green-900 opacity-60 group-hover:opacity-100" />
            )}
          </button>
        </div>
      </div>

      {/* Center - Title (hidden) */}
      {/* <div 
        className="absolute left-1/2 top-1/2 transform -translate-x-1/2 -translate-y-1/2 pointer-events-none"
        data-tauri-drag-region
      >
        <span className="text-sm font-medium text-foreground/80">{title}</span>
      </div> */}

      {/* Right side - Navigation icons with improved spacing */}
      <div className="flex items-center pr-3 gap-1.5 tauri-no-drag">
        {/* Primary actions group */}
        <div className="flex items-center gap-0.5">
          {onAgentsClick && (
            <TooltipSimple content="Agents" side="bottom">
              <motion.button
                onClick={onAgentsClick}
                whileTap={{ scale: 0.97 }}
                transition={{ duration: 0.15 }}
                className={actionButtonClass}
                aria-label="Agents"
                data-testid="titlebar-agents-button"
              >
                <Bot size={13} />
              </motion.button>
            </TooltipSimple>
          )}
          
          {onUsageClick && (
            <TooltipSimple content="Usage Dashboard" side="bottom">
              <motion.button
                onClick={() => {
                  logWorkspaceEvent({
                    category: 'state_action',
                    action: 'titlebar_usage_click',
                  });
                  try {
                    onUsageClick();
                  } catch (error) {
                    logWorkspaceEvent({
                      category: 'error',
                      action: 'titlebar_usage_click_failed',
                      message: error instanceof Error ? error.message : String(error),
                    });
                    throw error;
                  }
                }}
                whileTap={{ scale: 0.97 }}
                transition={{ duration: 0.15 }}
                className={actionButtonClass}
                aria-label="Usage Dashboard"
              >
                <BarChart3 size={13} />
              </motion.button>
            </TooltipSimple>
          )}
        </div>

        {/* Visual separator */}
        <div className="w-px h-3.5 bg-[var(--color-chrome-border)]" />

        {/* Secondary actions group */}
        <div className="flex items-center gap-0.5">
          {onSettingsClick && (
            <TooltipSimple content="Settings" side="bottom">
              <motion.button
                onClick={onSettingsClick}
                whileTap={{ scale: 0.97 }}
                transition={{ duration: 0.15 }}
                className={actionButtonClass}
                aria-label="Settings"
              >
                <Settings size={13} />
              </motion.button>
            </TooltipSimple>
          )}

          {/* Dropdown menu for additional options */}
          <div className="relative" ref={dropdownRef}>
            <TooltipSimple content="More options" side="bottom">
              <motion.button
                onClick={() => setIsDropdownOpen(!isDropdownOpen)}
                whileTap={{ scale: 0.97 }}
                transition={{ duration: 0.15 }}
                className={actionButtonClass}
                aria-label="More options"
              >
                <MoreVertical size={13} />
              </motion.button>
            </TooltipSimple>

            {isDropdownOpen && (
              <div className="absolute right-0 mt-2 w-48 bg-[var(--color-chrome-surface)] border border-[var(--color-chrome-border)] rounded-lg shadow-lg z-[250]">
                <div className="py-1">
                  {onClaudeClick && (
                    <button
                      onClick={() => {
                        onClaudeClick();
                        setIsDropdownOpen(false);
                      }}
                      className={menuItemClass}
                    >
                      <FileText size={12} />
                      <span>CLAUDE.md</span>
                    </button>
                  )}
                  
                  {onMCPClick && (
                    <button
                      onClick={() => {
                        onMCPClick();
                        setIsDropdownOpen(false);
                      }}
                      className={menuItemClass}
                    >
                      <Network size={12} />
                      <span>MCP Servers</span>
                    </button>
                  )}
                  
                  {onInfoClick && (
                    <button
                      onClick={() => {
                        onInfoClick();
                        setIsDropdownOpen(false);
                      }}
                      className={menuItemClass}
                    >
                      <Info size={12} />
                      <span>About</span>
                    </button>
                  )}

                  {onDiagnosticsClick && (
                    <button
                      onClick={() => {
                        onDiagnosticsClick();
                        setIsDropdownOpen(false);
                      }}
                      className={menuItemClass}
                    >
                      <Bug size={12} />
                      <span>Diagnostics</span>
                    </button>
                  )}
                </div>
              </div>
            )}
          </div>
        </div>
      </div>
    </div>
    </TooltipProvider>
  );
};

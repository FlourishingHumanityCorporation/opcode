import React from "react";
import { Columns2, RotateCcw, Play, X } from "lucide-react";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import {
  useEmbeddedTerminalController,
  type TerminalCloseReason,
  type TerminalErrorFallback,
} from "@/components/embedded-terminal";
import {
  applyTerminalInteractivity,
  classifyEditableTargetOutsideContainer,
  encodeTerminalKeyInput,
  focusTerminalIfInteractive,
  isEditableTargetOutsideContainer,
  isXtermHelperTextareaTarget,
  shouldRouteKeyboardFallbackInput,
} from "@/components/embedded-terminal/input";
import {
  classifyTerminalErrorCode,
  closeEmbeddedTerminalForLifecycle,
  isMissingEmbeddedTerminalError,
  shouldTerminatePersistentSessionForClose,
} from "@/components/embedded-terminal/errors";
import { shouldAttemptStaleInputRecovery } from "@/components/embedded-terminal/stale";
import "@xterm/xterm/css/xterm.css";

interface EmbeddedTerminalProps {
  projectPath: string;
  className?: string;
  autoRunCommand?: string;
  clearOnAttach?: boolean;
  quickRunCommand?: string;
  runCommandRequestId?: number;
  existingTerminalId?: string;
  persistentSessionId?: string;
  onTerminalIdChange?: (terminalId: string | undefined) => void;
  isInteractive?: boolean;
  workspaceId?: string;
  terminalTabId?: string;
  paneId?: string;
  onSplitPane?: () => void;
  onClosePane?: () => void;
  canClosePane?: boolean;
  onPaneActivate?: () => void;
  onRunningChange?: (isRunning: boolean) => void;
}

export const EmbeddedTerminal: React.FC<EmbeddedTerminalProps> = (props) => {
  const {
    className,
    quickRunCommand = "claude",
    onSplitPane,
    onClosePane,
    canClosePane = true,
    onPaneActivate,
    onRunningChange,
  } = props;

  const {
    containerRef,
    statusText,
    isCommandActive,
    error,
    recoveryNotice,
    ready,
    quickRunCommandRef,
    runInTerminal,
    handleRestart,
    recoverPointerFocus,
  } = useEmbeddedTerminalController({
    ...props,
    quickRunCommand,
  });

  const stopHeaderControlEvent = React.useCallback((event: React.MouseEvent<HTMLElement>) => {
    event.preventDefault();
    event.stopPropagation();
  }, []);

  const handleSplitClick = React.useCallback(
    (event: React.MouseEvent<HTMLButtonElement>) => {
      stopHeaderControlEvent(event);
      onSplitPane?.();
    },
    [onSplitPane, stopHeaderControlEvent]
  );

  const handleCloseClick = React.useCallback(
    (event: React.MouseEvent<HTMLButtonElement>) => {
      stopHeaderControlEvent(event);
      onClosePane?.();
    },
    [onClosePane, stopHeaderControlEvent]
  );

  const handleRunClick = React.useCallback(
    (event: React.MouseEvent<HTMLButtonElement>) => {
      stopHeaderControlEvent(event);
      void runInTerminal(quickRunCommandRef.current || "claude");
    },
    [runInTerminal, quickRunCommandRef, stopHeaderControlEvent]
  );

  const handleRestartClick = React.useCallback(
    (event: React.MouseEvent<HTMLButtonElement>) => {
      stopHeaderControlEvent(event);
      void handleRestart();
    },
    [handleRestart, stopHeaderControlEvent]
  );

  React.useEffect(() => {
    onRunningChange?.(isCommandActive);
  }, [isCommandActive, onRunningChange]);

  React.useEffect(
    () => () => {
      onRunningChange?.(false);
    },
    [onRunningChange]
  );

  return (
    <div className={cn("flex h-full min-h-0 flex-col", className)}>
      <div className="flex h-8 items-center justify-between border-b border-[var(--color-chrome-border)] px-2">
        <div className="font-mono text-[11px] text-muted-foreground">{statusText}</div>
        <div className="tauri-no-drag flex items-center gap-1" data-no-pane-activate>
          {onSplitPane && (
            <Button
              size="icon"
              variant="ghost"
              className="tauri-no-drag h-6 w-6"
              data-no-pane-activate
              onMouseDown={stopHeaderControlEvent}
              onClick={handleSplitClick}
              title="Split Right"
            >
              <Columns2 className="h-3.5 w-3.5" />
            </Button>
          )}
          {onClosePane && canClosePane && (
            <Button
              size="icon"
              variant="ghost"
              className="tauri-no-drag h-6 w-6"
              data-no-pane-activate
              onMouseDown={stopHeaderControlEvent}
              onClick={handleCloseClick}
              title="Close Pane"
            >
              <X className="h-3.5 w-3.5" />
            </Button>
          )}
          <Button
            size="icon"
            variant="ghost"
            className="tauri-no-drag h-6 w-6"
            data-no-pane-activate
            onMouseDown={stopHeaderControlEvent}
            onClick={handleRunClick}
            disabled={!ready}
            title={`Run ${quickRunCommandRef.current || "claude"}`}
          >
            <Play className="h-3.5 w-3.5" />
          </Button>
          <Button
            size="icon"
            variant="ghost"
            className="tauri-no-drag h-6 w-6"
            data-no-pane-activate
            onMouseDown={stopHeaderControlEvent}
            onClick={handleRestartClick}
            title="Restart terminal"
          >
            <RotateCcw className="h-3.5 w-3.5" />
          </Button>
        </div>
      </div>

      <div
        ref={containerRef}
        className="min-h-0 flex-1 bg-[#0b0f14] pl-1 pr-0.5"
        tabIndex={0}
        onMouseDownCapture={onPaneActivate}
        onMouseDown={recoverPointerFocus}
        onClick={recoverPointerFocus}
      />

      {error && (
        <div className="border-t border-destructive/40 bg-destructive/10 px-2 py-1 text-xs text-destructive">
          {error}
        </div>
      )}
      {!error && recoveryNotice && (
        <div className="border-t border-amber-500/30 bg-amber-500/10 px-2 py-1 text-xs text-amber-300">
          {recoveryNotice}
        </div>
      )}
    </div>
  );
};

export {
  applyTerminalInteractivity,
  classifyEditableTargetOutsideContainer,
  classifyTerminalErrorCode,
  closeEmbeddedTerminalForLifecycle,
  encodeTerminalKeyInput,
  focusTerminalIfInteractive,
  isXtermHelperTextareaTarget,
  isMissingEmbeddedTerminalError,
  isEditableTargetOutsideContainer,
  shouldAttemptStaleInputRecovery,
  shouldRouteKeyboardFallbackInput,
  shouldTerminatePersistentSessionForClose,
};

export type { TerminalCloseReason, TerminalErrorFallback };

export default EmbeddedTerminal;

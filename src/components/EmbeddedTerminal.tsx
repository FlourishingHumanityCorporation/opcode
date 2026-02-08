import React from "react";
import { RotateCcw, Play } from "lucide-react";
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
  quickRunCommand?: string;
  runCommandRequestId?: number;
  existingTerminalId?: string;
  persistentSessionId?: string;
  onTerminalIdChange?: (terminalId: string | undefined) => void;
  isInteractive?: boolean;
  workspaceId?: string;
  terminalTabId?: string;
  paneId?: string;
}

export const EmbeddedTerminal: React.FC<EmbeddedTerminalProps> = (props) => {
  const {
    className,
    quickRunCommand = "claude",
  } = props;

  const {
    containerRef,
    statusText,
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

  return (
    <div className={cn("flex h-full min-h-0 flex-col", className)}>
      <div className="flex h-8 items-center justify-between border-b border-[var(--color-chrome-border)] px-2">
        <div className="font-mono text-[11px] text-muted-foreground">{statusText}</div>
        <div className="flex items-center gap-1">
          <Button
            size="icon"
            variant="ghost"
            className="h-6 w-6"
            onClick={() => void runInTerminal(quickRunCommandRef.current || "claude")}
            disabled={!ready}
            title={`Run ${quickRunCommandRef.current || "claude"}`}
          >
            <Play className="h-3.5 w-3.5" />
          </Button>
          <Button
            size="icon"
            variant="ghost"
            className="h-6 w-6"
            onClick={() => void handleRestart()}
            title="Restart terminal"
          >
            <RotateCcw className="h-3.5 w-3.5" />
          </Button>
        </div>
      </div>

      <div
        ref={containerRef}
        className="min-h-0 flex-1 bg-[#0b0f14]"
        tabIndex={0}
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

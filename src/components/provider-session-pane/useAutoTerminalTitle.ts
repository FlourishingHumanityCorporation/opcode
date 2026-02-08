import { useEffect, useRef } from "react";

interface UseAutoTerminalTitleOptions {
  currentTerminalTitle?: string;
  isTerminalTitleLocked?: boolean;
  workspaceId?: string;
  terminalTabId?: string;
  paneId?: string;
  projectPath: string;
}

export function useAutoTerminalTitle({
  currentTerminalTitle,
  isTerminalTitleLocked,
  workspaceId,
  terminalTabId,
  paneId,
  projectPath,
}: UseAutoTerminalTitleOptions) {
  const terminalTitleRef = useRef<string>(currentTerminalTitle || "");
  const titleLockedRef = useRef<boolean>(Boolean(isTerminalTitleLocked));
  const autoTitleSessionStartedAtRef = useRef<number | null>(null);
  const didApplyEarlyAutoTitleRef = useRef(false);
  const lastAutoTitleTranscriptRef = useRef("");

  useEffect(() => {
    terminalTitleRef.current = currentTerminalTitle || "";
  }, [currentTerminalTitle]);

  useEffect(() => {
    titleLockedRef.current = Boolean(isTerminalTitleLocked);
  }, [isTerminalTitleLocked]);

  useEffect(() => {
    didApplyEarlyAutoTitleRef.current = false;
    autoTitleSessionStartedAtRef.current = null;
    lastAutoTitleTranscriptRef.current = "";
  }, [workspaceId, terminalTabId, paneId, projectPath]);

  return {
    terminalTitleRef,
    titleLockedRef,
    autoTitleSessionStartedAtRef,
    didApplyEarlyAutoTitleRef,
    lastAutoTitleTranscriptRef,
  };
}

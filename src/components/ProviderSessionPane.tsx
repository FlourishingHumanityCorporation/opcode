import React, { useState, useEffect, useRef, useMemo } from "react";
import { motion, AnimatePresence } from "framer-motion";
import { 
  Copy,
  ChevronDown,
  GitBranch,
  ChevronUp,
  X,
  Hash,
  Wrench,
  Sparkles,
  Command,
  Cpu,
  Send,
  Code
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Popover } from "@/components/ui/popover";
import { api, type Session } from "@/lib/api";
import { cn } from "@/lib/utils";

const ENABLE_DEBUG_LOGS =
  Boolean((globalThis as any)?.__OPCODE_DEBUG_LOGS__) &&
  Boolean(import.meta.env?.DEV);

function debugLog(...args: unknown[]) {
  if (!ENABLE_DEBUG_LOGS) return;
  console.log(...args);
}

import {
  listenToProviderSessionEvent as listen,
  type UnlistenFn,
} from "./provider-session-pane/sessionEventBus";
import { StreamMessage } from "./StreamMessage";
import {
  FloatingPromptInput,
  type FloatingPromptInputRef,
  type PromptSendOptions,
} from "./FloatingPromptInput";
import { ErrorBoundary } from "./ErrorBoundary";
import { TimelineNavigator } from "./TimelineNavigator";
import { CheckpointSettings } from "./CheckpointSettings";
import { SlashCommandsManager } from "./SlashCommandsManager";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription, DialogFooter } from "@/components/ui/dialog";
import { TooltipProvider, TooltipSimple } from "@/components/ui/tooltip-modern";
import { SplitPane } from "@/components/ui/split-pane";
import { WebviewPreview } from "./WebviewPreview";
import { EmbeddedTerminal } from "./EmbeddedTerminal";
import type { ClaudeStreamMessage } from "./AgentExecution";
import { useVirtualizer } from "@tanstack/react-virtual";
import { useTrackEvent, useComponentMetrics, useWorkflowTracking } from "@/hooks";
import { SessionPersistenceService } from "@/services/sessionPersistence";
import { logWorkspaceEvent } from "@/services/workspaceDiagnostics";
import {
  emitAgentAttention,
  extractAttentionText,
  shouldTriggerNeedsInput,
  summarizeAttentionBody,
} from "@/services/agentAttention";
import { createStreamWatchdog } from "@/lib/streamWatchdog";
import {
  getDefaultModelForProvider,
  getModelDisplayName,
  getProviderDisplayName,
} from "@/lib/providerModels";
import {
  NATIVE_TERMINAL_START_COMMAND_EVENT,
  NATIVE_TERMINAL_MODE_EVENT,
  PLAIN_TERMINAL_MODE_EVENT,
  loadNativeTerminalStartCommandPreference,
  loadNativeTerminalModePreference,
  loadPlainTerminalModePreference,
  readNativeTerminalStartCommandFromStorage,
  readNativeTerminalModeFromStorage,
  readPlainTerminalModeFromStorage,
  saveNativeTerminalModePreference,
  savePlainTerminalModePreference,
} from "@/lib/uiPreferences";
import { sanitizeProviderSessionId } from "@/services/nativeTerminalRestore";
import {
  deriveAutoTitleFromUserPrompts,
  getAutoTitleTranscriptCursor,
  getNextAutoTitleCheckpointAtMs,
  isGenericTerminalTitle,
  resolveLatestSessionSnapshot,
  sanitizeTerminalTitleCandidate,
  shouldGenerateAutoTitleForTranscript,
  shouldApplyAutoRenameTitle,
} from "@/services/terminalAutoTitle";
import { useProviderDetection } from "./provider-session-pane/useProviderDetection";
import { useNativeTerminalRestore } from "./provider-session-pane/useNativeTerminalRestore";

interface ProviderSessionPaneProps {
  /**
   * Optional session to resume (when clicking from SessionList)
   */
  session?: Session;
  /**
   * Initial project path (for new sessions)
   */
  initialProjectPath?: string;
  /**
   * Callback to go back
   */
  onBack?: () => void;
  /**
   * Callback to open hooks configuration
   */
  onProjectSettings?: (projectPath: string) => void;
  /**
   * Optional className for styling
   */
  className?: string;
  /**
   * Callback when streaming state changes
   */
  onStreamingChange?: (isStreaming: boolean, sessionId: string | null) => void;
  /**
   * Callback when project path changes
   */
  onProjectPathChange?: (path: string) => void;
  /**
   * Agent provider ID (defaults to "claude")
   */
  providerId?: string;
  /**
   * Callback when provider changes
   */
  onProviderChange?: (providerId: string) => void;
  /**
   * Callback when a runtime session is identified/resolved.
   */
  onSessionResolved?: (session: Session) => void;
  /**
   * Whether this is rendered as an embedded pane.
   */
  embedded?: boolean;
  /**
   * Optional pane identity for multi-pane rendering.
   */
  paneId?: string;
  /**
   * Optional workspace identity for multi-workspace rendering.
   */
  workspaceId?: string;
  /**
   * Optional terminal tab identity for multi-terminal rendering.
   */
  terminalTabId?: string;
  /**
   * Existing embedded terminal session id for reattachment.
   */
  embeddedTerminalId?: string;
  /**
   * Callback when embedded terminal session id changes.
   */
  onEmbeddedTerminalIdChange?: (terminalId: string | undefined) => void;
  /**
   * Whether this pane is currently visible to the user.
   */
  isPaneVisible?: boolean;
  /**
   * Whether this pane is the active pane for terminal keyboard input.
   */
  isPaneActive?: boolean;
  /**
   * Explicit session id to resume on next native terminal boot.
   */
  resumeSessionId?: string;
  /**
   * Stable persistent terminal session id used for detached shell continuity.
   */
  persistentTerminalSessionId?: string;
  /**
   * Pane-level restore preference used when no explicit session id exists.
   */
  restorePreference?: 'resume_latest' | 'start_fresh';
  /**
   * Callback when pane restore preference changes.
   */
  onRestorePreferenceChange?: (value: 'resume_latest' | 'start_fresh') => void;
  /**
   * Callback when pane resume session id is updated.
   */
  onResumeSessionIdChange?: (sessionId: string | undefined) => void;
  /**
   * Current terminal tab title for auto-rename comparisons.
   */
  currentTerminalTitle?: string;
  /**
   * Whether terminal title is currently locked.
   */
  isTerminalTitleLocked?: boolean;
  /**
   * Callback used by native terminal auto-title logic.
   */
  onAutoRenameTerminalTitle?: (title: string) => void;
  /**
   * Hide project/provider bar for embedded usage.
   */
  hideProjectBar?: boolean;
  /**
   * Hide floating global controls for embedded usage.
   */
  hideFloatingGlobalControls?: boolean;
  /**
   * Preview layout mode.
   */
  previewMode?: 'split' | 'slideover';
}

export function shouldShowProjectPathHeader(
  hideProjectBar: boolean,
  nativeTerminalMode: boolean,
  detectedProviderCount: number,
  projectPath: string
): boolean {
  return !hideProjectBar && (nativeTerminalMode || detectedProviderCount > 0 || Boolean(projectPath));
}

export function shouldShowProviderSelectorInHeader(
  nativeTerminalMode: boolean,
  detectedProviderCount: number
): boolean {
  return !nativeTerminalMode && detectedProviderCount > 0;
}

function toPlainTextValue(value: unknown): string {
  if (value === null || value === undefined) return "";
  if (typeof value === "string") return value;
  if (typeof value === "number" || typeof value === "boolean") return String(value);
  if (Array.isArray(value)) {
    return value.map((entry) => toPlainTextValue(entry)).filter(Boolean).join("\n");
  }
  if (typeof value === "object") {
    const objectValue = value as Record<string, unknown>;
    if (typeof objectValue.text === "string") {
      return objectValue.text;
    }
    try {
      return JSON.stringify(value, null, 2);
    } catch {
      return String(value);
    }
  }
  return String(value);
}

function getPlainRoleLabel(message: ClaudeStreamMessage): string {
  const base = (message.type || "message").toUpperCase();
  const subtype = typeof message.subtype === "string" && message.subtype.trim() ? `:${message.subtype}` : "";
  return `${base}${subtype}`;
}

function getPlainMessageBody(message: ClaudeStreamMessage): string {
  if (message.type === "assistant" || message.type === "user") {
    const content = message.message?.content;
    if (Array.isArray(content)) {
      const chunks = content
        .map((chunk: any) => {
          if (!chunk || typeof chunk !== "object") return toPlainTextValue(chunk);
          if (chunk.type === "text") return toPlainTextValue(chunk.text);
          if (chunk.type === "tool_use") {
            return `[tool:${chunk.name || "unknown"}]\n${toPlainTextValue(chunk.input)}`;
          }
          if (chunk.type === "tool_result") {
            return `[tool_result]\n${toPlainTextValue(chunk.content)}`;
          }
          return toPlainTextValue(chunk);
        })
        .filter((entry) => entry.trim().length > 0);

      if (chunks.length > 0) {
        return chunks.join("\n\n");
      }
    }
  }

  if (typeof message.result === "string" && message.result.trim()) {
    return message.result;
  }
  if (typeof message.error === "string" && message.error.trim()) {
    return message.error;
  }
  return toPlainTextValue(message).trim();
}

/**
 * ProviderSessionPane component for interactive provider sessions
 * 
 * @example
 * <ProviderSessionPane onBack={() => setView('projects')} />
 */
export const ProviderSessionPane: React.FC<ProviderSessionPaneProps> = ({
  session,
  initialProjectPath = "",
  className,
  onStreamingChange,
  onProjectPathChange,
  providerId: initialProviderId = "claude",
  onProviderChange,
  onSessionResolved,
  embedded = false,
  hideProjectBar = false,
  hideFloatingGlobalControls = false,
  previewMode = 'split',
  paneId,
  workspaceId,
  terminalTabId,
  embeddedTerminalId,
  onEmbeddedTerminalIdChange,
  isPaneVisible = true,
  isPaneActive = true,
  resumeSessionId,
  persistentTerminalSessionId,
  restorePreference,
  onRestorePreferenceChange,
  onResumeSessionIdChange,
  currentTerminalTitle,
  isTerminalTitleLocked = false,
  onAutoRenameTerminalTitle,
}) => {
  type QueuedPrompt = {
    id: string;
    prompt: string;
    model: string;
    providerId: string;
    reasoningEffort?: PromptSendOptions["reasoningEffort"];
  };

  const [projectPath, setProjectPath] = useState(initialProjectPath || session?.project_path || "");
  const [messages, setMessages] = useState<ClaudeStreamMessage[]>([]);
  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [rawJsonlOutput, setRawJsonlOutput] = useState<string[]>([]);
  const [copyPopoverOpen, setCopyPopoverOpen] = useState(false);
  const [isFirstPrompt, setIsFirstPrompt] = useState(!session);
  const [totalTokens, setTotalTokens] = useState(0);
  const [extractedSessionInfo, setExtractedSessionInfo] = useState<{ sessionId: string; projectId: string } | null>(null);
  const [providerSessionId, setProviderSessionId] = useState<string | null>(null);
  const [showTimeline, setShowTimeline] = useState(false);
  const [timelineVersion, setTimelineVersion] = useState(0);
  const [showSettings, setShowSettings] = useState(false);
  const [showForkDialog, setShowForkDialog] = useState(false);
  const [showSlashCommandsSettings, setShowSlashCommandsSettings] = useState(false);
  const [forkCheckpointId, setForkCheckpointId] = useState<string | null>(null);
  const [forkSessionName, setForkSessionName] = useState("");
  
  // Queued prompts state
  const [queuedPrompts, setQueuedPrompts] = useState<QueuedPrompt[]>([]);
  
  // New state for preview feature
  const [showPreview, setShowPreview] = useState(false);
  const [previewUrl, setPreviewUrl] = useState("");
  const [showPreviewPrompt, setShowPreviewPrompt] = useState(false);
  const [splitPosition, setSplitPosition] = useState(50);
  const [isPreviewMaximized, setIsPreviewMaximized] = useState(false);
  
  // Add collapsed state for queued prompts
  const [queuedPromptsCollapsed, setQueuedPromptsCollapsed] = useState(false);

  // Provider state
  const {
    activeProviderId,
    setActiveProviderId,
    detectedProviders,
  } = useProviderDetection({
    initialProviderId,
    isPaneVisible,
    onProviderChange,
  });
  const [showProviderMenu, setShowProviderMenu] = useState(false);
  const [plainTerminalMode, setPlainTerminalMode] = useState<boolean>(() => readPlainTerminalModeFromStorage());
  const [nativeTerminalMode, setNativeTerminalMode] = useState<boolean>(() =>
    readNativeTerminalModeFromStorage()
  );
  const [hasBootedNativeTerminal, setHasBootedNativeTerminal] = useState<boolean>(
    () => Boolean(embeddedTerminalId)
  );
  const [nativeTerminalStartupCommand, setNativeTerminalStartupCommand] = useState<string>(() =>
    readNativeTerminalStartCommandFromStorage()
  );
  const [nativeTerminalCommand, setNativeTerminalCommand] = useState<string>("");
  const [showNativeRestorePrompt, setShowNativeRestorePrompt] = useState<boolean>(false);
  const {
    isResolvingNativeRestore,
    nativeRestoreNotice,
    setNativeRestoreNotice,
    resolveLatestProviderSession,
  } = useNativeTerminalRestore();

  const parentRef = useRef<HTMLDivElement>(null);
  const unlistenRefs = useRef<UnlistenFn[]>([]);
  const hasActiveSessionRef = useRef(false);
  const floatingPromptRef = useRef<FloatingPromptInputRef>(null);
  const queuedPromptsRef = useRef<QueuedPrompt[]>([]);
  const isMountedRef = useRef(true);
  const isListeningRef = useRef(false);
  const streamWatchdogRef = useRef<ReturnType<typeof createStreamWatchdog> | null>(null);
  const FIRST_STREAM_WARNING_MS = 2000;
  const HARD_TIMEOUT_MS = 120000;
  const FIRST_STREAM_WARNING_TEXT = 'No response yet (2s). Still waiting for provider startup.';
  const promptAttemptStartedAtRef = useRef<number | null>(null);
  const streamStartedAtRef = useRef<number | null>(null);
  const sessionStartTime = useRef<number>(Date.now());
  const isIMEComposingRef = useRef(false);
  const lastResolvedSessionIdRef = useRef<string | null>(session?.id ?? null);
  const terminalTitleRef = useRef<string>(currentTerminalTitle || "");
  const titleLockedRef = useRef<boolean>(Boolean(isTerminalTitleLocked));
  const autoTitleSessionStartedAtRef = useRef<number | null>(null);
  const didApplyEarlyAutoTitleRef = useRef(false);
  const lastAutoTitleTranscriptRef = useRef<string>("");

  const AUTO_TITLE_MODEL = "glm-4.7-flash";
  const AUTO_TITLE_EARLY_PROMPT_THRESHOLD = 2;
  const AUTO_TITLE_EARLY_POLL_MS = 15_000;
  
  // Session metrics state for enhanced analytics
  const sessionMetrics = useRef({
    firstMessageTime: null as number | null,
    promptsSent: 0,
    toolsExecuted: 0,
    toolsFailed: 0,
    filesCreated: 0,
    filesModified: 0,
    filesDeleted: 0,
    codeBlocksGenerated: 0,
    errorsEncountered: 0,
    lastActivityTime: Date.now(),
    toolExecutionTimes: [] as number[],
    checkpointCount: 0,
    wasResumed: !!session,
    modelChanges: [] as Array<{ from: string; to: string; timestamp: number }>,
  });

  // Analytics tracking
  const trackEvent = useTrackEvent();
  useComponentMetrics('ProviderSessionPane');
  // const aiTracking = useAIInteractionTracking('sonnet'); // Default model
  const workflowTracking = useWorkflowTracking('provider_session');

  if (!streamWatchdogRef.current) {
    streamWatchdogRef.current = createStreamWatchdog({
      firstWarningMs: FIRST_STREAM_WARNING_MS,
      hardTimeoutMs: HARD_TIMEOUT_MS,
      onFirstWarning: ({ providerId, projectPath }) => {
        if (!isMountedRef.current) return;
        // Disabled noisy 2s UI warning; keep diagnostics logging only.
        // setError(FIRST_STREAM_WARNING_TEXT);
        logWorkspaceEvent({
          category: 'stream_watchdog',
          action: 'first_stream_warning',
          message: 'No stream event received in first 2s; still waiting',
          payload: { providerId, projectPath },
        });
      },
      onHardTimeout: ({ providerId, projectPath }) => {
        if (!isMountedRef.current || !hasActiveSessionRef.current) return;
        const now = Date.now();
        const elapsedSinceStreamStartMs =
          streamStartedAtRef.current !== null ? now - streamStartedAtRef.current : null;
        const endToEndStartupMs =
          promptAttemptStartedAtRef.current !== null ? now - promptAttemptStartedAtRef.current : null;
        setIsLoading(false);
        hasActiveSessionRef.current = false;
        isListeningRef.current = false;
        setError('Session did not complete within 120s. Try stopping and re-running.');
        logWorkspaceEvent({
          category: 'stream_watchdog',
          action: 'hard_timeout',
          message: 'No completion within 120s',
          payload: { providerId, projectPath, elapsedSinceStreamStartMs, endToEndStartupMs },
        });
      },
    });
  }
  
  // Keep internal project path in sync when parent workspace updates it.
  useEffect(() => {
    const nextPath = initialProjectPath || session?.project_path || "";
    setProjectPath((prev) => (prev === nextPath ? prev : nextPath));
  }, [initialProjectPath, session?.project_path]);

  // Notify parent when project path is available/changes.
  useEffect(() => {
    if (onProjectPathChange && projectPath) {
      onProjectPathChange(projectPath);
    }
  }, [onProjectPathChange, projectPath]);

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

  useEffect(() => {
    if (nativeTerminalMode) {
      setShowProviderMenu(false);
    }
  }, [nativeTerminalMode]);

  useEffect(() => {
    let isCancelled = false;
    loadPlainTerminalModePreference().then((enabled) => {
      if (!isCancelled) {
        setPlainTerminalMode(enabled);
      }
    });
    loadNativeTerminalModePreference().then((enabled) => {
      if (!isCancelled) {
        setNativeTerminalMode(enabled);
      }
    });
    loadNativeTerminalStartCommandPreference().then((command) => {
      if (!isCancelled) {
        setNativeTerminalStartupCommand(command);
      }
    });

    const handlePlainModeChange = (event: Event) => {
      const detail = (event as CustomEvent<{ enabled?: boolean }>).detail;
      if (typeof detail?.enabled === "boolean") {
        setPlainTerminalMode(detail.enabled);
      } else {
        setPlainTerminalMode(readPlainTerminalModeFromStorage());
      }
    };
    const handleNativeModeChange = (event: Event) => {
      const detail = (event as CustomEvent<{ enabled?: boolean }>).detail;
      if (typeof detail?.enabled === "boolean") {
        setNativeTerminalMode(detail.enabled);
      } else {
        setNativeTerminalMode(readNativeTerminalModeFromStorage());
      }
    };
    const handleNativeStartCommandChange = (event: Event) => {
      const detail = (event as CustomEvent<{ command?: string }>).detail;
      if (typeof detail?.command === "string") {
        setNativeTerminalStartupCommand(detail.command);
      } else {
        setNativeTerminalStartupCommand(readNativeTerminalStartCommandFromStorage());
      }
    };

    window.addEventListener(PLAIN_TERMINAL_MODE_EVENT, handlePlainModeChange as EventListener);
    window.addEventListener(NATIVE_TERMINAL_MODE_EVENT, handleNativeModeChange as EventListener);
    window.addEventListener(
      NATIVE_TERMINAL_START_COMMAND_EVENT,
      handleNativeStartCommandChange as EventListener
    );
    return () => {
      isCancelled = true;
      window.removeEventListener(PLAIN_TERMINAL_MODE_EVENT, handlePlainModeChange as EventListener);
      window.removeEventListener(NATIVE_TERMINAL_MODE_EVENT, handleNativeModeChange as EventListener);
      window.removeEventListener(
        NATIVE_TERMINAL_START_COMMAND_EVENT,
        handleNativeStartCommandChange as EventListener
      );
    };
  }, []);

  // Keep ref in sync with state
  useEffect(() => {
    queuedPromptsRef.current = queuedPrompts;
  }, [queuedPrompts]);

  // Get effective session info (from prop or extracted) - use useMemo to ensure it updates
  const effectiveSession = useMemo(() => {
    if (session) return session;
    if (extractedSessionInfo) {
      return {
        id: extractedSessionInfo.sessionId,
        project_id: extractedSessionInfo.projectId,
        project_path: projectPath,
        created_at: Date.now(),
      } as Session;
    }
    return null;
  }, [session, extractedSessionInfo, projectPath]);

  const autoTitlePreferredSessionId = useMemo(() => {
    const candidates = [
      providerSessionId,
      effectiveSession?.id,
      extractedSessionInfo?.sessionId,
      resumeSessionId,
    ];

    for (const candidate of candidates) {
      const sanitized = sanitizeProviderSessionId(candidate);
      if (sanitized) {
        return sanitized;
      }
    }

    return undefined;
  }, [effectiveSession?.id, extractedSessionInfo?.sessionId, providerSessionId, resumeSessionId]);

  useEffect(() => {
    if (!effectiveSession || !onSessionResolved) return;
    if (lastResolvedSessionIdRef.current === effectiveSession.id) return;

    lastResolvedSessionIdRef.current = effectiveSession.id;
    onSessionResolved(effectiveSession);
  }, [effectiveSession, onSessionResolved]);

  useEffect(() => {
    didApplyEarlyAutoTitleRef.current = false;
    lastAutoTitleTranscriptRef.current = "";
  }, [autoTitlePreferredSessionId]);

  useEffect(() => {
    if (embeddedTerminalId) {
      setHasBootedNativeTerminal(true);
    }
  }, [embeddedTerminalId]);

  const bootNativeTerminalWithCommand = React.useCallback((command: string) => {
    const resumeMatch = command.match(/^\s*claude\s+--resume\s+([A-Za-z0-9-]+)\s*$/i);
    if (resumeMatch?.[1]) {
      onResumeSessionIdChange?.(resumeMatch[1]);
    }
    autoTitleSessionStartedAtRef.current = Date.now();
    didApplyEarlyAutoTitleRef.current = false;
    setNativeTerminalCommand(command);
    setShowNativeRestorePrompt(false);
    setHasBootedNativeTerminal(true);
  }, [onResumeSessionIdChange]);

  const bootNativeTerminalWithStartupCommand = React.useCallback(() => {
    bootNativeTerminalWithCommand(nativeTerminalStartupCommand);
  }, [bootNativeTerminalWithCommand, nativeTerminalStartupCommand]);

  const resolveLatestNativeSessionAndBoot = React.useCallback(async () => {
    if (!projectPath) {
      return;
    }

    setNativeRestoreNotice(null);
    try {
      const latestSessionId = await resolveLatestProviderSession(projectPath);
      if (latestSessionId) {
        onResumeSessionIdChange?.(latestSessionId);
        bootNativeTerminalWithCommand(`claude --resume ${latestSessionId}`);
        return;
      }

      bootNativeTerminalWithStartupCommand();
    } catch (restoreError) {
      console.warn('[ProviderSessionPane] Failed to resolve latest native restore session', restoreError);
      setNativeRestoreNotice('Could not load prior sessions. Starting fresh.');
      bootNativeTerminalWithStartupCommand();
    }
  }, [
    bootNativeTerminalWithCommand,
    bootNativeTerminalWithStartupCommand,
    onResumeSessionIdChange,
    projectPath,
    resolveLatestProviderSession,
    setNativeRestoreNotice,
  ]);

  useEffect(() => {
    if (!nativeTerminalMode || !projectPath || hasBootedNativeTerminal || !isPaneVisible) {
      return;
    }

    const validExplicitResumeSessionId = sanitizeProviderSessionId(resumeSessionId);
    if (validExplicitResumeSessionId) {
      bootNativeTerminalWithCommand(`claude --resume ${validExplicitResumeSessionId}`);
      return;
    }

    if (restorePreference === 'resume_latest') {
      resolveLatestNativeSessionAndBoot();
      return;
    }

    if (restorePreference === 'start_fresh') {
      bootNativeTerminalWithStartupCommand();
      return;
    }

    bootNativeTerminalWithStartupCommand();
  }, [
    bootNativeTerminalWithCommand,
    bootNativeTerminalWithStartupCommand,
    hasBootedNativeTerminal,
    isPaneVisible,
    nativeTerminalMode,
    projectPath,
    resolveLatestNativeSessionAndBoot,
    restorePreference,
    resumeSessionId,
  ]);

  useEffect(() => {
    if (
      !nativeTerminalMode ||
      !isPaneVisible ||
      !hasBootedNativeTerminal ||
      !projectPath ||
      !terminalTabId ||
      !onAutoRenameTerminalTitle
    ) {
      return;
    }

    if (isTerminalTitleLocked) {
      return;
    }

    if (autoTitleSessionStartedAtRef.current === null) {
      autoTitleSessionStartedAtRef.current = Date.now();
    }

    let isCancelled = false;
    let timedRenameTimeout: number | null = null;
    const sessionStartedAtMs = autoTitleSessionStartedAtRef.current ?? Date.now();
    autoTitleSessionStartedAtRef.current = sessionStartedAtMs;

    const attemptAutoRename = async (reason: "early" | "timed"): Promise<void> => {
      if (isCancelled || titleLockedRef.current) {
        return;
      }

      const snapshot = await resolveLatestSessionSnapshot(projectPath, {
        preferredSessionId: autoTitlePreferredSessionId,
      });
      if (!snapshot || !snapshot.transcript) {
        return;
      }

      if (reason === "early" && snapshot.userPrompts.length < AUTO_TITLE_EARLY_PROMPT_THRESHOLD) {
        return;
      }

      if (
        !shouldGenerateAutoTitleForTranscript(
          snapshot.transcript,
          lastAutoTitleTranscriptRef.current
        )
      ) {
        return;
      }

      // Record transcript cursor before generation so unchanged history does
      // not re-trigger model calls after transient failures.
      lastAutoTitleTranscriptRef.current = getAutoTitleTranscriptCursor(
        snapshot.transcript,
        lastAutoTitleTranscriptRef.current
      );

      try {
        const generatedTitle = await api.generateLocalTerminalTitle({
          transcript: snapshot.transcript,
          model: AUTO_TITLE_MODEL,
        });
        const sanitizedGeneratedTitle = sanitizeTerminalTitleCandidate(
          generatedTitle,
          undefined,
          projectPath
        );
        const resolvedTitle =
          sanitizedGeneratedTitle && !isGenericTerminalTitle(sanitizedGeneratedTitle)
            ? sanitizedGeneratedTitle
            : deriveAutoTitleFromUserPrompts(snapshot.userPrompts, projectPath);

        if (!shouldApplyAutoRenameTitle(
          terminalTitleRef.current,
          resolvedTitle,
          titleLockedRef.current,
          projectPath
        )) {
          return;
        }

        onAutoRenameTerminalTitle(resolvedTitle);
        terminalTitleRef.current = resolvedTitle;
        if (reason === "early") {
          didApplyEarlyAutoTitleRef.current = true;
        }
      } catch (autoRenameError) {
        console.warn("[ProviderSessionPane] Native auto-rename failed", autoRenameError);
      }
    };

    const scheduleNextTimedRename = () => {
      if (isCancelled || titleLockedRef.current) {
        return;
      }

      const now = Date.now();
      const nextCheckpointAt = getNextAutoTitleCheckpointAtMs(sessionStartedAtMs, now);
      const delayMs = Math.max(0, nextCheckpointAt - now);
      timedRenameTimeout = window.setTimeout(() => {
        void attemptAutoRename("timed").finally(() => {
          scheduleNextTimedRename();
        });
      }, delayMs);
    };

    void attemptAutoRename("early");
    const earlyPollInterval = window.setInterval(() => {
      if (didApplyEarlyAutoTitleRef.current || titleLockedRef.current) {
        return;
      }
      void attemptAutoRename("early");
    }, AUTO_TITLE_EARLY_POLL_MS);

    scheduleNextTimedRename();

    return () => {
      isCancelled = true;
      window.clearInterval(earlyPollInterval);
      if (timedRenameTimeout !== null) {
        window.clearTimeout(timedRenameTimeout);
      }
    };
  }, [
    AUTO_TITLE_EARLY_POLL_MS,
    AUTO_TITLE_EARLY_PROMPT_THRESHOLD,
    AUTO_TITLE_MODEL,
    hasBootedNativeTerminal,
    isPaneVisible,
    isTerminalTitleLocked,
    nativeTerminalMode,
    onAutoRenameTerminalTitle,
    autoTitlePreferredSessionId,
    projectPath,
    terminalTabId,
  ]);

  // Filter out messages that shouldn't be displayed
  const displayableMessages = useMemo(() => {
    return messages.filter((message, index) => {
      // Skip meta messages that don't have meaningful content
      if (message.isMeta && !message.leafUuid && !message.summary) {
        return false;
      }

      // Skip user messages that only contain tool results that are already displayed
      if (message.type === "user" && message.message) {
        if (message.isMeta) return false;

        const msg = message.message;
        if (!msg.content || (Array.isArray(msg.content) && msg.content.length === 0)) {
          return false;
        }

        if (Array.isArray(msg.content)) {
          let hasVisibleContent = false;
          for (const content of msg.content) {
            if (content.type === "text") {
              hasVisibleContent = true;
              break;
            }
            if (content.type === "tool_result") {
              let willBeSkipped = false;
              if (content.tool_use_id) {
                // Look for the matching tool_use in previous assistant messages
                for (let i = index - 1; i >= 0; i--) {
                  const prevMsg = messages[i];
                  if (prevMsg.type === 'assistant' && prevMsg.message?.content && Array.isArray(prevMsg.message.content)) {
                    const toolUse = prevMsg.message.content.find((c: any) => 
                      c.type === 'tool_use' && c.id === content.tool_use_id
                    );
                    if (toolUse) {
                      const toolName = toolUse.name?.toLowerCase();
                      const toolsWithWidgets = [
                        'task', 'edit', 'multiedit', 'todowrite', 'ls', 'read', 
                        'glob', 'bash', 'write', 'grep'
                      ];
                      if (toolsWithWidgets.includes(toolName) || toolUse.name?.startsWith('mcp__')) {
                        willBeSkipped = true;
                      }
                      break;
                    }
                  }
                }
              }
              if (!willBeSkipped) {
                hasVisibleContent = true;
                break;
              }
            }
          }
          if (!hasVisibleContent) {
            return false;
          }
        }
      }
      return true;
    });
  }, [messages]);

  const visibleMessageCount = isPaneVisible ? displayableMessages.length : 0;

  const rowVirtualizer = useVirtualizer({
    count: visibleMessageCount,
    getScrollElement: () => parentRef.current,
    estimateSize: () => 150, // Estimate, will be dynamically measured
    overscan: 5,
  });

  // Debug logging
  useEffect(() => {
    debugLog('[ProviderSessionPane] State update:', {
      projectPath,
      session,
      extractedSessionInfo,
      effectiveSession,
      messagesCount: messages.length,
      isLoading
    });
  }, [projectPath, session, extractedSessionInfo, effectiveSession, messages.length, isLoading]);

  // Load session history if resuming
  useEffect(() => {
    if (!isPaneVisible || !session) {
      return;
    }

    if (session) {
      // Set the providerSessionId immediately when we have a session
      setProviderSessionId(session.id);
      
      // Load session history first, then check for active session
      const initializeSession = async () => {
        await loadSessionHistory();
        // After loading history, check if the session is still active
        if (isMountedRef.current) {
          await checkForActiveSession();
        }
      };
      
      initializeSession();
    }
  }, [session, isPaneVisible]); // Lazy-load session work for visible panes only

  // Report streaming state changes
  useEffect(() => {
    onStreamingChange?.(isLoading, providerSessionId);
  }, [isLoading, providerSessionId, onStreamingChange]);

  // Auto-scroll to bottom when new messages arrive
  useEffect(() => {
    if (!isPaneVisible) return;
    if (displayableMessages.length > 0) {
      // Use a more precise scrolling method to ensure content is fully visible
      setTimeout(() => {
        const scrollElement = parentRef.current;
        if (scrollElement) {
          // First, scroll using virtualizer to get close to the bottom
          rowVirtualizer.scrollToIndex(displayableMessages.length - 1, { align: 'end', behavior: 'auto' });

          // Then use direct scroll to ensure we reach the absolute bottom
          requestAnimationFrame(() => {
            scrollElement.scrollTo({
              top: scrollElement.scrollHeight,
              behavior: 'smooth'
            });
          });
        }
      }, 50);
    }
  }, [displayableMessages.length, isPaneVisible, rowVirtualizer]);

  // Calculate total tokens from messages
  useEffect(() => {
    const tokens = messages.reduce((total, msg) => {
      if (msg.message?.usage) {
        return total + msg.message.usage.input_tokens + msg.message.usage.output_tokens;
      }
      if (msg.usage) {
        return total + msg.usage.input_tokens + msg.usage.output_tokens;
      }
      return total;
    }, 0);
    setTotalTokens(tokens);
  }, [messages]);

  const loadSessionHistory = async () => {
    if (!session) return;
    
    try {
      setIsLoading(true);
      setError(null);
      
      const history = await api.loadSessionHistory(session.id, session.project_id);
      
      // Save session data for restoration
      if (history && history.length > 0) {
        SessionPersistenceService.saveSession(
          session.id,
          session.project_id,
          session.project_path,
          history.length
        );
      }
      
      // Convert history to messages format
      const loadedMessages: ClaudeStreamMessage[] = history.map(entry => ({
        ...entry,
        type: entry.type || "assistant"
      }));
      
      setMessages(loadedMessages);
      setRawJsonlOutput(history.map(h => JSON.stringify(h)));
      
      // After loading history, we're continuing a conversation
      setIsFirstPrompt(false);
      
      // Scroll to bottom after loading history
      setTimeout(() => {
        if (!isPaneVisible) return;
        if (loadedMessages.length > 0) {
          const scrollElement = parentRef.current;
          if (scrollElement) {
            // Use the same improved scrolling method
            rowVirtualizer.scrollToIndex(loadedMessages.length - 1, { align: 'end', behavior: 'auto' });
            requestAnimationFrame(() => {
              scrollElement.scrollTo({
                top: scrollElement.scrollHeight,
                behavior: 'auto'
              });
            });
          }
        }
      }, 100);
    } catch (err) {
      console.error("Failed to load session history:", err);
      setError("Failed to load session history");
    } finally {
      setIsLoading(false);
    }
  };

  const checkForActiveSession = async () => {
    // If we have a session prop, check if it's still active
    if (session) {
      try {
        const activeSessions = await api.listRunningProviderSessions();
        const activeSession = activeSessions.find((s: any) => {
          if ('process_type' in s && s.process_type && 'ProviderSession' in s.process_type) {
            return (s.process_type as any).ProviderSession.session_id === session.id;
          }
          return false;
        });
        
        if (activeSession) {
          // Session is still active, reconnect to its stream
          debugLog('[ProviderSessionPane] Found active session, reconnecting:', session.id);
          // IMPORTANT: Set providerSessionId before reconnecting
          setProviderSessionId(session.id);
          
          // Don't add buffered messages here - they've already been loaded by loadSessionHistory
          // Just set up listeners for new messages
          
          // Set up listeners for the active session
          reconnectToSession(session.id);
        }
      } catch (err) {
        console.error('Failed to check for active sessions:', err);
      }
    }
  };

  const reconnectToSession = async (sessionId: string) => {
    debugLog('[ProviderSessionPane] Reconnecting to session:', sessionId);
    
    // Prevent duplicate listeners
    if (isListeningRef.current) {
      debugLog('[ProviderSessionPane] Already listening to session, skipping reconnect');
      return;
    }
    
    // Clean up previous listeners
    unlistenRefs.current.forEach(unlisten => unlisten());
    unlistenRefs.current = [];
    
    // IMPORTANT: Set the session ID before setting up listeners
    setProviderSessionId(sessionId);
    
    // Mark as listening
    isListeningRef.current = true;
    
    // Set up session-specific listeners
    const outputUnlisten = await listen(`provider-session-output:${sessionId}`, async (event: any) => {
      try {
        debugLog('[ProviderSessionPane] Received provider-session-output on reconnect:', event.payload);
        
        if (!isMountedRef.current) return;
        
        // Store raw JSONL
        setRawJsonlOutput(prev => [...prev, event.payload]);
        
        // Parse and display
        const message = JSON.parse(event.payload) as ClaudeStreamMessage;
        setMessages(prev => [...prev, message]);
      } catch (err) {
        console.error("Failed to parse message:", err, event.payload);
      }
    });

    const errorUnlisten = await listen(`provider-session-error:${sessionId}`, (event: any) => {
      console.error("Provider session error:", event.payload);
      if (isMountedRef.current) {
        setError(event.payload);
        clearStreamWatchdogs();
        setIsLoading(false);
        hasActiveSessionRef.current = false;
        isListeningRef.current = false;
      }
    });

    const completeUnlisten = await listen(`provider-session-complete:${sessionId}`, async (event: any) => {
      debugLog('[ProviderSessionPane] Received provider-session-complete on reconnect:', event.payload);
      if (isMountedRef.current) {
        clearStreamWatchdogs();
        setIsLoading(false);
        hasActiveSessionRef.current = false;
      }
    });

    unlistenRefs.current = [outputUnlisten, errorUnlisten, completeUnlisten];
    
    // Mark as loading to show the session is active
    if (isMountedRef.current) {
      setIsLoading(true);
      hasActiveSessionRef.current = true;
    }
  };

  const clearStreamWatchdogs = () => {
    streamWatchdogRef.current?.stop();
    streamStartedAtRef.current = null;
  };

  const markFirstStreamSeen = (providerId: string) => {
    const didMark = streamWatchdogRef.current?.markFirstStream() ?? false;
    if (!didMark) return;
    const now = Date.now();
    const firstTokenLatencyMs =
      streamStartedAtRef.current !== null ? now - streamStartedAtRef.current : null;
    const endToEndStartupMs =
      promptAttemptStartedAtRef.current !== null ? now - promptAttemptStartedAtRef.current : null;
    setError((previous) =>
      previous === FIRST_STREAM_WARNING_TEXT ? null : previous
    );
    logWorkspaceEvent({
      category: 'stream_watchdog',
      action: 'first_stream_message',
      payload: { providerId, firstTokenLatencyMs, endToEndStartupMs },
    });
  };

  const startStreamWatchdogs = (providerId: string, path: string) => {
    streamStartedAtRef.current = Date.now();
    streamWatchdogRef.current?.start({ providerId, projectPath: path });
  };

  const validateProjectPath = async (path: string): Promise<boolean> => {
    try {
      await api.listDirectoryContents(path);
      return true;
    } catch (error) {
      logWorkspaceEvent({
        category: 'preflight',
        action: 'project_path_invalid',
        message: error instanceof Error ? error.message : 'Failed to validate project path',
        payload: { projectPath: path },
      });
      return false;
    }
  };

  const preflightProviderRuntime = async (providerId: string): Promise<boolean> => {
    try {
      const runtime = await api.checkProviderRuntime(providerId);
      if (!runtime.ready) {
        const details = runtime.issues.length > 0 ? runtime.issues.join('; ') : 'Provider runtime not ready';
        setError(details);
        logWorkspaceEvent({
          category: 'preflight',
          action: 'provider_runtime_not_ready',
          message: details,
          payload: { providerId, runtime },
        });
        return false;
      }
      return true;
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Failed to check provider runtime';
      setError(message);
      logWorkspaceEvent({
        category: 'preflight',
        action: 'provider_runtime_check_failed',
        message,
        payload: { providerId },
      });
      return false;
    }
  };

  const resolveProjectPathForPrompt = async (): Promise<string | null> => {
    if (projectPath) {
      return projectPath;
    }

    try {
      const tauriAvailable = typeof window !== 'undefined' && (
        Boolean((window as any).__TAURI__) || Boolean((window as any).__TAURI_INTERNALS__)
      );

      if (tauriAvailable) {
        try {
          const { open } = await import('@tauri-apps/plugin-dialog');
          const result = await open({
            directory: true,
            multiple: false,
            title: 'Select Project Folder',
          });
          if (typeof result === 'string' && result.trim()) {
            return result.trim();
          }
        } catch (dialogError) {
          console.error('Failed to open native directory picker:', dialogError);
        }
      }

      const smokePath = window.localStorage.getItem('opcode.smoke.projectPath');
      if (smokePath && smokePath.trim()) {
        return smokePath.trim();
      }

      const typedPath = window.prompt('Enter project path', '');
      if (typedPath && typedPath.trim()) {
        return typedPath.trim();
      }
    } catch (err) {
      console.error('Failed to resolve project path:', err);
    }

    return null;
  };

  const handleSendPrompt = async (
    prompt: string,
    model: string,
    options?: PromptSendOptions
  ) => {
    promptAttemptStartedAtRef.current = Date.now();
    const providerToUse = options?.providerIdOverride || activeProviderId;
    const reasoningEffort = options?.reasoningEffort;
    const isClaudeProviderForRun = providerToUse === "claude";
    const modelForTracking = model || "default";
    let runProjectPath = projectPath;

    debugLog('[ProviderSessionPane] handleSendPrompt called with:', {
      prompt,
      model,
      providerToUse,
      projectPath,
      providerSessionId,
      effectiveSession
    });

    if (!runProjectPath) {
      const selectedProjectPath = await resolveProjectPathForPrompt();
      if (!selectedProjectPath) {
        setError("Please select a project directory first");
        return;
      }

      runProjectPath = selectedProjectPath;
      setProjectPath(selectedProjectPath);
      onProjectPathChange?.(selectedProjectPath);
    }

    const validPath = await validateProjectPath(runProjectPath);
    if (!validPath) {
      setError(`Project path is invalid or inaccessible: ${runProjectPath}`);
      return;
    }

    const runtimeReady = await preflightProviderRuntime(providerToUse);
    if (!runtimeReady) {
      return;
    }

    // If already loading, queue the prompt
    if (isLoading) {
      const newPrompt = {
        id: `${Date.now()}-${Math.random().toString(36).substr(2, 9)}`,
        prompt,
        model,
        providerId: providerToUse,
        reasoningEffort,
      };
      setQueuedPrompts(prev => [...prev, newPrompt]);
      return;
    }

    try {
      setIsLoading(true);
      setError(null);
      hasActiveSessionRef.current = true;
      startStreamWatchdogs(providerToUse, runProjectPath);
      logWorkspaceEvent({
        category: 'stream_watchdog',
        action: 'prompt_started',
        payload: {
          providerId: providerToUse,
          model: modelForTracking,
          projectPath: runProjectPath,
          firstWarningMs: FIRST_STREAM_WARNING_MS,
          hardTimeoutMs: HARD_TIMEOUT_MS,
        },
      });
      
      // For resuming sessions, ensure we have the session ID
      if (effectiveSession && !providerSessionId) {
        setProviderSessionId(effectiveSession.id);
      }
      
      // Only clean up and set up new listeners if not already listening
      if (!isListeningRef.current) {
        // Clean up previous listeners
        unlistenRefs.current.forEach(unlisten => unlisten());
        unlistenRefs.current = [];
        
        // Mark as setting up listeners
        isListeningRef.current = true;
        
        // --------------------------------------------------------------------
        // 1️⃣  Event Listener Setup Strategy
        // --------------------------------------------------------------------
        // Claude Code may emit a *new* session_id even when we pass --resume. If
        // we listen only on the old session-scoped channel we will miss the
        // stream until the user navigates away & back. To avoid this we:
        //   • Always start with GENERIC listeners (no suffix) so we catch the
        //     very first "system:init" message regardless of the session id.
        //   • Once that init message provides the *actual* session_id, we
        //     dynamically switch to session-scoped listeners and stop the
        //     generic ones to prevent duplicate handling.
        // --------------------------------------------------------------------

        debugLog('[ProviderSessionPane] Setting up generic event listeners first');

        let currentSessionId: string | null = providerSessionId || effectiveSession?.id || null;

        // Helper to attach session-specific listeners **once we are sure**
        const attachSessionSpecificListeners = async (sid: string) => {
          debugLog('[ProviderSessionPane] Attaching session-specific listeners for', sid);

          const specificOutputUnlisten = await listen(`provider-session-output:${sid}`, (evt: any) => {
            handleStreamMessage(evt.payload);
          });

          const specificErrorUnlisten = await listen(`provider-session-error:${sid}`, (evt: any) => {
            console.error('Provider session error (scoped):', evt.payload);
            setError(evt.payload);
            clearStreamWatchdogs();
            setIsLoading(false);
            hasActiveSessionRef.current = false;
            isListeningRef.current = false;
            logWorkspaceEvent({
              category: 'error',
              action: 'provider_session_error_scoped',
              message: String(evt.payload ?? ''),
              payload: {
                providerId: providerToUse,
                sessionId: sid,
              },
            });
          });

          const specificCompleteUnlisten = await listen(`provider-session-complete:${sid}`, (evt: any) => {
            debugLog('[ProviderSessionPane] Received provider-session-complete (scoped):', evt.payload);
            processComplete(evt.payload);
          });

          // Replace existing unlisten refs with these new ones (after cleaning up)
          unlistenRefs.current.forEach((u) => u());
          unlistenRefs.current = [specificOutputUnlisten, specificErrorUnlisten, specificCompleteUnlisten];
        };

        // Generic listeners (catch-all)
        const genericOutputUnlisten = await listen('provider-session-output', async (event: any) => {
          handleStreamMessage(event.payload);

          // Attempt to extract session_id on the fly (for the very first init)
          try {
            const msg =
              typeof event.payload === "string"
                ? (JSON.parse(event.payload) as ClaudeStreamMessage)
                : (event.payload as ClaudeStreamMessage);
            if (msg.type === 'system' && msg.subtype === 'init' && msg.session_id) {
              if (!currentSessionId || currentSessionId !== msg.session_id) {
                debugLog('[ProviderSessionPane] Detected new session_id from generic listener:', msg.session_id);
                currentSessionId = msg.session_id;
                setProviderSessionId(msg.session_id);

                // If we haven't extracted session info before, do it now
                if (!extractedSessionInfo) {
                  const projectId = runProjectPath.replace(/[^a-zA-Z0-9]/g, '-');
                  setExtractedSessionInfo({ sessionId: msg.session_id, projectId });
                  
                  // Save session data for restoration
                  SessionPersistenceService.saveSession(
                    msg.session_id,
                    projectId,
                    runProjectPath,
                    messages.length
                  );
                }

                // Switch to session-specific listeners
                await attachSessionSpecificListeners(msg.session_id);
              }
            }
          } catch {
            /* ignore parse errors */
          }
        });

        // Helper to process any JSONL stream message string or object
        function handleStreamMessage(payload: string | ClaudeStreamMessage) {
          try {
            // Don't process if component unmounted
            if (!isMountedRef.current) return;
            markFirstStreamSeen(providerToUse);
            
            let message: ClaudeStreamMessage;
            let rawPayload: string;
            
            if (typeof payload === 'string') {
              // Tauri mode: payload is a JSON string
              rawPayload = payload;
              message = JSON.parse(payload) as ClaudeStreamMessage;
            } else {
              // Web mode: payload is already parsed object
              message = payload;
              rawPayload = JSON.stringify(payload);
            }
            
            debugLog('[ProviderSessionPane] handleStreamMessage - message type:', message.type);

            if (message.type === "assistant") {
              const candidateText = extractAttentionText(message);
              if (shouldTriggerNeedsInput(candidateText)) {
                void emitAgentAttention({
                  kind: "needs_input",
                  workspaceId,
                  terminalTabId,
                  source: "provider_session",
                  body:
                    summarizeAttentionBody(candidateText) ||
                    "The agent is waiting for your input.",
                });
              }
            }

            // Store raw JSONL
            setRawJsonlOutput((prev) => [...prev, rawPayload]);

            // Track enhanced tool execution
            if (message.type === 'assistant' && message.message?.content) {
              const toolUses = message.message.content.filter((c: any) => c.type === 'tool_use');
              toolUses.forEach((toolUse: any) => {
                // Increment tools executed counter
                sessionMetrics.current.toolsExecuted += 1;
                sessionMetrics.current.lastActivityTime = Date.now();

                // Track file operations
                const toolName = toolUse.name?.toLowerCase() || '';
                if (toolName.includes('create') || toolName.includes('write')) {
                  sessionMetrics.current.filesCreated += 1;
                } else if (toolName.includes('edit') || toolName.includes('multiedit') || toolName.includes('search_replace')) {
                  sessionMetrics.current.filesModified += 1;
                } else if (toolName.includes('delete')) {
                  sessionMetrics.current.filesDeleted += 1;
                }

                // Track tool start - we'll track completion when we get the result
                workflowTracking.trackStep(toolUse.name);
              });
            }

            // Track tool results
            if (message.type === 'user' && message.message?.content) {
              const toolResults = message.message.content.filter((c: any) => c.type === 'tool_result');
              toolResults.forEach((result: any) => {
                const isError = result.is_error || false;
                // Note: We don't have execution time here, but we can track success/failure
                if (isError) {
                  sessionMetrics.current.toolsFailed += 1;
                  sessionMetrics.current.errorsEncountered += 1;

                  trackEvent.enhancedError({
                    error_type: 'tool_execution',
                    error_code: 'tool_failed',
                    error_message: result.content,
                    context: `Tool execution failed`,
                    user_action_before_error: 'executing_tool',
                    recovery_attempted: false,
                    recovery_successful: false,
                    error_frequency: 1,
                    stack_trace_hash: undefined
                  });
                }
              });
            }

            // Track code blocks generated
            if (message.type === 'assistant' && message.message?.content) {
              const codeBlocks = message.message.content.filter((c: any) =>
                c.type === 'text' && c.text?.includes('```')
              );
              if (codeBlocks.length > 0) {
                // Count code blocks in text content
                codeBlocks.forEach((block: any) => {
                  const matches = (block.text.match(/```/g) || []).length;
                  sessionMetrics.current.codeBlocksGenerated += Math.floor(matches / 2);
                });
              }
            }

            // Track errors in system messages
            if (message.type === 'system' && (message.subtype === 'error' || message.error)) {
              sessionMetrics.current.errorsEncountered += 1;
            }

            setMessages((prev) => [...prev, message]);
          } catch (err) {
            console.error('Failed to parse message:', err, payload);
          }
        }

        // Helper to handle completion events (both generic and scoped)
        const processComplete = async (success: boolean) => {
          clearStreamWatchdogs();
          setIsLoading(false);
          hasActiveSessionRef.current = false;
          isListeningRef.current = false; // Reset listening state

          if (success) {
            void emitAgentAttention({
              kind: "done",
              workspaceId,
              terminalTabId,
              source: "provider_session",
              body: `Run completed for ${runProjectPath || "the current workspace"}.`,
            });
          }

          logWorkspaceEvent({
            category: 'stream_watchdog',
            action: 'stream_complete',
            payload: {
              success,
              providerId: providerToUse,
            },
          });
          
          // Track enhanced session stopped metrics when session completes
          if (effectiveSession && providerSessionId) {
            const sessionStartTimeValue = messages.length > 0 ? messages[0].timestamp || Date.now() : Date.now();
            const duration = Date.now() - sessionStartTimeValue;
            const metrics = sessionMetrics.current;
            const timeToFirstMessage = metrics.firstMessageTime 
              ? metrics.firstMessageTime - sessionStartTime.current 
              : undefined;
            const idleTime = Date.now() - metrics.lastActivityTime;
            const avgResponseTime = metrics.toolExecutionTimes.length > 0
              ? metrics.toolExecutionTimes.reduce((a, b) => a + b, 0) / metrics.toolExecutionTimes.length
              : undefined;
            
            trackEvent.enhancedSessionStopped({
              // Basic metrics
              duration_ms: duration,
              messages_count: messages.length,
              reason: success ? 'completed' : 'error',
              
              // Timing metrics
              time_to_first_message_ms: timeToFirstMessage,
              average_response_time_ms: avgResponseTime,
              idle_time_ms: idleTime,
              
              // Interaction metrics
              prompts_sent: metrics.promptsSent,
              tools_executed: metrics.toolsExecuted,
              tools_failed: metrics.toolsFailed,
              files_created: metrics.filesCreated,
              files_modified: metrics.filesModified,
              files_deleted: metrics.filesDeleted,
              
              // Content metrics
              total_tokens_used: totalTokens,
              code_blocks_generated: metrics.codeBlocksGenerated,
              errors_encountered: metrics.errorsEncountered,
              
              // Session context
              model: metrics.modelChanges.length > 0 
                ? metrics.modelChanges[metrics.modelChanges.length - 1].to 
                : (getDefaultModelForProvider(providerToUse) || "default"),
              has_checkpoints: metrics.checkpointCount > 0,
              checkpoint_count: metrics.checkpointCount,
              was_resumed: metrics.wasResumed,
              
              // Agent context (if applicable)
              agent_type: undefined, // TODO: Pass from agent execution
              agent_name: undefined, // TODO: Pass from agent execution
              agent_success: success,
              
              // Stop context
              stop_source: 'completed',
              final_state: success ? 'success' : 'failed',
              has_pending_prompts: queuedPrompts.length > 0,
              pending_prompts_count: queuedPrompts.length,
            });
          }

          if (effectiveSession && success) {
            try {
              const settings = await api.getCheckpointSettings(
                effectiveSession.id,
                effectiveSession.project_id,
                runProjectPath
              );

              if (settings.auto_checkpoint_enabled) {
                await api.checkAutoCheckpoint(
                  effectiveSession.id,
                  effectiveSession.project_id,
                  runProjectPath,
                  prompt
                );
                // Reload timeline to show new checkpoint
                setTimelineVersion((v) => v + 1);
              }
            } catch (err) {
              console.error('Failed to check auto checkpoint:', err);
            }
          }

          // Process queued prompts after completion
          if (queuedPromptsRef.current.length > 0) {
            const [nextPrompt, ...remainingPrompts] = queuedPromptsRef.current;
            setQueuedPrompts(remainingPrompts);
            
            // Small delay to ensure UI updates
            setTimeout(() => {
              handleSendPrompt(nextPrompt.prompt, nextPrompt.model, {
                providerIdOverride: nextPrompt.providerId,
                reasoningEffort: nextPrompt.reasoningEffort,
              });
            }, 100);
          }
        };

        const genericErrorUnlisten = await listen('provider-session-error', (evt: any) => {
          console.error('Provider session error:', evt.payload);
          setError(evt.payload);
          clearStreamWatchdogs();
          setIsLoading(false);
          hasActiveSessionRef.current = false;
          isListeningRef.current = false;
          logWorkspaceEvent({
            category: 'error',
            action: 'provider_session_error_generic',
            message: String(evt.payload ?? ''),
            payload: {
              providerId: providerToUse,
            },
          });
        });

        const genericCompleteUnlisten = await listen('provider-session-complete', (evt: any) => {
          debugLog('[ProviderSessionPane] Received provider-session-complete (generic):', evt.payload);
          processComplete(evt.payload);
        });

        // Store the generic unlisteners for now; they may be replaced later.
        unlistenRefs.current = [genericOutputUnlisten, genericErrorUnlisten, genericCompleteUnlisten];

        // --------------------------------------------------------------------
        // 2️⃣  Auto-checkpoint logic moved after listener setup (unchanged)
        // --------------------------------------------------------------------

        // Add the user message immediately to the UI (after setting up listeners)
        const userMessage: ClaudeStreamMessage = {
          type: "user",
          message: {
            content: [
              {
                type: "text",
                text: prompt
              }
            ]
          }
        };
        setMessages(prev => [...prev, userMessage]);
        
        // Update session metrics
        sessionMetrics.current.promptsSent += 1;
        sessionMetrics.current.lastActivityTime = Date.now();
        if (!sessionMetrics.current.firstMessageTime) {
          sessionMetrics.current.firstMessageTime = Date.now();
        }
        
        // Track model changes
        const defaultModelForProvider = getDefaultModelForProvider(providerToUse) || "default";
        const lastModel = sessionMetrics.current.modelChanges.length > 0 
          ? sessionMetrics.current.modelChanges[sessionMetrics.current.modelChanges.length - 1].to
          : (sessionMetrics.current.wasResumed ? defaultModelForProvider : modelForTracking);
        
        if (lastModel !== modelForTracking) {
          sessionMetrics.current.modelChanges.push({
            from: lastModel,
            to: modelForTracking,
            timestamp: Date.now()
          });
        }
        
        // Track enhanced prompt submission
        const codeBlockMatches = prompt.match(/```[\s\S]*?```/g) || [];
        const hasCode = codeBlockMatches.length > 0;
        const conversationDepth = messages.filter(m => m.user_message).length;
        const sessionAge = sessionStartTime.current ? Date.now() - sessionStartTime.current : 0;
        const wordCount = prompt.split(/\s+/).filter(word => word.length > 0).length;
        
        trackEvent.enhancedPromptSubmitted({
          prompt_length: prompt.length,
          model: modelForTracking,
          has_attachments: false, // TODO: Add attachment support when implemented
          source: 'keyboard', // TODO: Track actual source (keyboard vs button)
          word_count: wordCount,
          conversation_depth: conversationDepth,
          prompt_complexity: wordCount < 20 ? 'simple' : wordCount < 100 ? 'moderate' : 'complex',
          contains_code: hasCode,
          language_detected: hasCode ? codeBlockMatches?.[0]?.match(/```(\w+)/)?.[1] : undefined,
          session_age_ms: sessionAge
        });

        // Execute the appropriate command (provider-aware)
        if (effectiveSession && !isFirstPrompt) {
          debugLog('[ProviderSessionPane] Resuming session:', effectiveSession.id, 'provider:', providerToUse);
          trackEvent.sessionResumed(effectiveSession.id);
          trackEvent.modelSelected(modelForTracking);
          if (isClaudeProviderForRun) {
            await api.resumeProviderSession(runProjectPath, effectiveSession.id, prompt, model);
          } else {
            await api.resumeAgentSession(
              providerToUse,
              runProjectPath,
              effectiveSession.id,
              prompt,
              model,
              reasoningEffort
            );
          }
        } else {
          debugLog('[ProviderSessionPane] Starting new session, provider:', providerToUse);
          setIsFirstPrompt(false);
          trackEvent.sessionCreated(modelForTracking, 'prompt_input');
          trackEvent.modelSelected(modelForTracking);
          if (isClaudeProviderForRun) {
            await api.executeProviderSession(runProjectPath, prompt, model);
          } else {
            await api.executeAgentSession(
              providerToUse,
              runProjectPath,
              prompt,
              model,
              reasoningEffort
            );
          }
        }
      }
    } catch (err) {
      console.error("Failed to send prompt:", err);
      setError("Failed to send prompt");
      setIsLoading(false);
      hasActiveSessionRef.current = false;
      clearStreamWatchdogs();
      logWorkspaceEvent({
        category: 'error',
        action: 'send_prompt_failed',
        message: err instanceof Error ? err.message : 'Failed to send prompt',
        payload: {
          providerId: providerToUse,
          projectPath: runProjectPath,
        },
      });
    }
  };

  const handleCopyAsJsonl = async () => {
    const jsonl = rawJsonlOutput.join('\n');
    await navigator.clipboard.writeText(jsonl);
    setCopyPopoverOpen(false);
  };

  const handleCopyAsMarkdown = async () => {
    let markdown = `# Provider Session\n\n`;
    markdown += `**Project:** ${projectPath}\n`;
    markdown += `**Date:** ${new Date().toISOString()}\n\n`;
    markdown += `---\n\n`;

    for (const msg of messages) {
      if (msg.type === "system" && msg.subtype === "init") {
        markdown += `## System Initialization\n\n`;
        markdown += `- Session ID: \`${msg.session_id || 'N/A'}\`\n`;
        markdown += `- Model: \`${msg.model || 'default'}\`\n`;
        if (msg.cwd) markdown += `- Working Directory: \`${msg.cwd}\`\n`;
        if (msg.tools?.length) markdown += `- Tools: ${msg.tools.join(', ')}\n`;
        markdown += `\n`;
      } else if (msg.type === "assistant" && msg.message) {
        markdown += `## Assistant\n\n`;
        for (const content of msg.message.content || []) {
          if (content.type === "text") {
            const textContent = typeof content.text === 'string' 
              ? content.text 
              : (content.text?.text || JSON.stringify(content.text || content));
            markdown += `${textContent}\n\n`;
          } else if (content.type === "tool_use") {
            markdown += `### Tool: ${content.name}\n\n`;
            markdown += `\`\`\`json\n${JSON.stringify(content.input, null, 2)}\n\`\`\`\n\n`;
          }
        }
        if (msg.message.usage) {
          markdown += `*Tokens: ${msg.message.usage.input_tokens} in, ${msg.message.usage.output_tokens} out*\n\n`;
        }
      } else if (msg.type === "user" && msg.message) {
        markdown += `## User\n\n`;
        for (const content of msg.message.content || []) {
          if (content.type === "text") {
            const textContent = typeof content.text === 'string' 
              ? content.text 
              : (content.text?.text || JSON.stringify(content.text));
            markdown += `${textContent}\n\n`;
          } else if (content.type === "tool_result") {
            markdown += `### Tool Result\n\n`;
            let contentText = '';
            if (typeof content.content === 'string') {
              contentText = content.content;
            } else if (content.content && typeof content.content === 'object') {
              if (content.content.text) {
                contentText = content.content.text;
              } else if (Array.isArray(content.content)) {
                contentText = content.content
                  .map((c: any) => (typeof c === 'string' ? c : c.text || JSON.stringify(c)))
                  .join('\n');
              } else {
                contentText = JSON.stringify(content.content, null, 2);
              }
            }
            markdown += `\`\`\`\n${contentText}\n\`\`\`\n\n`;
          }
        }
      } else if (msg.type === "result") {
        markdown += `## Execution Result\n\n`;
        if (msg.result) {
          markdown += `${msg.result}\n\n`;
        }
        if (msg.error) {
          markdown += `**Error:** ${msg.error}\n\n`;
        }
      }
    }

    await navigator.clipboard.writeText(markdown);
    setCopyPopoverOpen(false);
  };

  const handleCheckpointSelect = async () => {
    // Reload messages from the checkpoint
    await loadSessionHistory();
    // Ensure timeline reloads to highlight current checkpoint
    setTimelineVersion((v) => v + 1);
  };
  
  const handleCheckpointCreated = () => {
    // Update checkpoint count in session metrics
    sessionMetrics.current.checkpointCount += 1;
  };

  const handleCancelExecution = async () => {
    if (!providerSessionId || !isLoading) return;
    
    try {
      const sessionStartTime = messages.length > 0 ? messages[0].timestamp || Date.now() : Date.now();
      const duration = Date.now() - sessionStartTime;
      
      await api.cancelProviderSession(providerSessionId);
      
      // Calculate metrics for enhanced analytics
      const metrics = sessionMetrics.current;
      const timeToFirstMessage = metrics.firstMessageTime 
        ? metrics.firstMessageTime - sessionStartTime.current 
        : undefined;
      const idleTime = Date.now() - metrics.lastActivityTime;
      const avgResponseTime = metrics.toolExecutionTimes.length > 0
        ? metrics.toolExecutionTimes.reduce((a, b) => a + b, 0) / metrics.toolExecutionTimes.length
        : undefined;
      
      // Track enhanced session stopped
      trackEvent.enhancedSessionStopped({
        // Basic metrics
        duration_ms: duration,
        messages_count: messages.length,
        reason: 'user_stopped',
        
        // Timing metrics
        time_to_first_message_ms: timeToFirstMessage,
        average_response_time_ms: avgResponseTime,
        idle_time_ms: idleTime,
        
        // Interaction metrics
        prompts_sent: metrics.promptsSent,
        tools_executed: metrics.toolsExecuted,
        tools_failed: metrics.toolsFailed,
        files_created: metrics.filesCreated,
        files_modified: metrics.filesModified,
        files_deleted: metrics.filesDeleted,
        
        // Content metrics
        total_tokens_used: totalTokens,
        code_blocks_generated: metrics.codeBlocksGenerated,
        errors_encountered: metrics.errorsEncountered,
        
        // Session context
        model: metrics.modelChanges.length > 0 
          ? metrics.modelChanges[metrics.modelChanges.length - 1].to 
          : (getDefaultModelForProvider(activeProviderId) || "default"),
        has_checkpoints: metrics.checkpointCount > 0,
        checkpoint_count: metrics.checkpointCount,
        was_resumed: metrics.wasResumed,
        
        // Agent context (if applicable)
        agent_type: undefined, // TODO: Pass from agent execution
        agent_name: undefined, // TODO: Pass from agent execution
        agent_success: undefined, // TODO: Pass from agent execution
        
        // Stop context
        stop_source: 'user_button',
        final_state: 'cancelled',
        has_pending_prompts: queuedPrompts.length > 0,
        pending_prompts_count: queuedPrompts.length,
      });
      
      // Clean up listeners
      unlistenRefs.current.forEach(unlisten => unlisten());
      unlistenRefs.current = [];
      
      // Reset states
      setIsLoading(false);
      hasActiveSessionRef.current = false;
      isListeningRef.current = false;
      setError(null);
      clearStreamWatchdogs();
      
      // Clear queued prompts
      setQueuedPrompts([]);
      
      // Add a message indicating the session was cancelled
      const cancelMessage: ClaudeStreamMessage = {
        type: "system",
        subtype: "info",
        result: "Session cancelled by user",
        timestamp: new Date().toISOString()
      };
      setMessages(prev => [...prev, cancelMessage]);
    } catch (err) {
      console.error("Failed to cancel execution:", err);
      
      // Even if backend fails, we should update UI to reflect stopped state
      // Add error message but still stop the UI loading state
      const errorMessage: ClaudeStreamMessage = {
        type: "system",
        subtype: "error",
        result: `Failed to cancel execution: ${err instanceof Error ? err.message : 'Unknown error'}. The process may still be running in the background.`,
        timestamp: new Date().toISOString()
      };
      setMessages(prev => [...prev, errorMessage]);
      
      // Clean up listeners anyway
      unlistenRefs.current.forEach(unlisten => unlisten());
      unlistenRefs.current = [];
      
      // Reset states to allow user to continue
      setIsLoading(false);
      hasActiveSessionRef.current = false;
      isListeningRef.current = false;
      setError(null);
      clearStreamWatchdogs();
    }
  };

  const handleFork = (checkpointId: string) => {
    setForkCheckpointId(checkpointId);
    setForkSessionName(`Fork-${new Date().toISOString().slice(0, 10)}`);
    setShowForkDialog(true);
  };

  const handleCompositionStart = () => {
    isIMEComposingRef.current = true;
  };

  const handleCompositionEnd = () => {
    setTimeout(() => {
      isIMEComposingRef.current = false;
    }, 0);
  };

  const handleConfirmFork = async () => {
    if (!forkCheckpointId || !forkSessionName.trim() || !effectiveSession) return;
    
    try {
      setIsLoading(true);
      setError(null);
      
      const newSessionId = `${Date.now()}-${Math.random().toString(36).substr(2, 9)}`;
      await api.forkFromCheckpoint(
        forkCheckpointId,
        effectiveSession.id,
        effectiveSession.project_id,
        projectPath,
        newSessionId,
        forkSessionName
      );
      
      // Open the new forked session
      // You would need to implement navigation to the new session
      debugLog("Forked to new session:", newSessionId);
      
      setShowForkDialog(false);
      setForkCheckpointId(null);
      setForkSessionName("");
    } catch (err) {
      console.error("Failed to fork checkpoint:", err);
      setError("Failed to fork checkpoint");
    } finally {
      setIsLoading(false);
    }
  };

  // Handle URL detection from terminal output
  const handleLinkDetected = (url: string) => {
    if (!showPreview && !showPreviewPrompt) {
      setPreviewUrl(url);
      setShowPreviewPrompt(true);
    }
  };

  const handleClosePreview = () => {
    setShowPreview(false);
    setIsPreviewMaximized(false);
    // Keep the previewUrl so it can be restored when reopening
  };

  const handlePreviewUrlChange = (url: string) => {
    debugLog('[ProviderSessionPane] Preview URL changed to:', url);
    setPreviewUrl(url);
  };

  const handleTogglePreviewMaximize = () => {
    setIsPreviewMaximized(!isPreviewMaximized);
    // Reset split position when toggling maximize
    if (isPreviewMaximized) {
      setSplitPosition(50);
    }
  };

  // Cleanup event listeners and track mount state
  useEffect(() => {
    isMountedRef.current = true;
    
    return () => {
      debugLog('[ProviderSessionPane] Component unmounting, cleaning up listeners');
      isMountedRef.current = false;
      isListeningRef.current = false;
      
      // Track session completion with engagement metrics
      if (effectiveSession) {
        trackEvent.sessionCompleted();
        
        // Track session engagement
        const sessionDuration = sessionStartTime.current ? Date.now() - sessionStartTime.current : 0;
        const messageCount = messages.filter(m => m.user_message).length;
        const toolsUsed = new Set<string>();
        messages.forEach(msg => {
          if (msg.type === 'assistant' && msg.message?.content) {
            const tools = msg.message.content.filter((c: any) => c.type === 'tool_use');
            tools.forEach((tool: any) => toolsUsed.add(tool.name));
          }
        });
        
        // Calculate engagement score (0-100)
        const engagementScore = Math.min(100, 
          (messageCount * 10) + 
          (toolsUsed.size * 5) + 
          (sessionDuration > 300000 ? 20 : sessionDuration / 15000) // 5+ min session gets 20 points
        );
        
        trackEvent.sessionEngagement({
          session_duration_ms: sessionDuration,
          messages_sent: messageCount,
          tools_used: Array.from(toolsUsed),
          files_modified: 0, // TODO: Track file modifications
          engagement_score: Math.round(engagementScore)
        });
      }
      
      // Clean up listeners
      unlistenRefs.current.forEach(unlisten => unlisten());
      unlistenRefs.current = [];
      clearStreamWatchdogs();
      
      // Clear checkpoint manager when session ends
      if (effectiveSession) {
        api.clearCheckpointManager(effectiveSession.id).catch(err => {
          console.error("Failed to clear checkpoint manager:", err);
        });
      }
    };
  }, [effectiveSession, projectPath]);

  const messagesList = (
    <div
      ref={parentRef}
      className="flex-1 overflow-y-auto relative pb-20"
      style={{
        contain: 'strict',
      }}
    >
      <div
        className="relative w-full max-w-6xl mx-auto px-4 pt-8 pb-4"
        style={{
          height: `${Math.max(rowVirtualizer.getTotalSize(), 100)}px`,
          minHeight: '100px',
        }}
      >
        <AnimatePresence>
          {rowVirtualizer.getVirtualItems().map((virtualItem) => {
            const message = displayableMessages[virtualItem.index];
            return (
              <motion.div
                key={virtualItem.key}
                data-index={virtualItem.index}
                ref={(el) => el && rowVirtualizer.measureElement(el)}
                initial={{ opacity: 0, y: 8 }}
                animate={{ opacity: 1, y: 0 }}
                exit={{ opacity: 0, y: -8 }}
                transition={{ duration: 0.3 }}
                className="absolute inset-x-4 pb-4"
                style={{
                  top: virtualItem.start,
                }}
              >
                <StreamMessage 
                  message={message} 
                  streamMessages={messages}
                  onLinkDetected={handleLinkDetected}
                />
              </motion.div>
            );
          })}
        </AnimatePresence>
      </div>

      {/* Loading indicator under the latest message */}
      {isLoading && (
        <motion.div
          initial={{ opacity: 0, y: 8 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ duration: 0.15 }}
          className="flex items-center justify-center py-4 mb-20"
        >
          <div className="rotating-symbol text-primary" />
        </motion.div>
      )}

      {/* Error indicator */}
      {error && (
        <motion.div
          initial={{ opacity: 0, y: 8 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ duration: 0.15 }}
          className="rounded-lg border border-destructive/50 bg-destructive/10 p-4 text-sm text-destructive mb-20 w-full max-w-6xl mx-auto"
        >
          {error}
        </motion.div>
      )}
    </div>
  );

  const plainMessagesList = (
    <div ref={parentRef} className="flex-1 overflow-y-auto pb-20">
      <div className={cn("mx-auto w-full px-4 py-3", embedded ? "" : "max-w-6xl")}>
        {displayableMessages.map((message, index) => {
          const roleLabel = getPlainRoleLabel(message);
          const body = getPlainMessageBody(message);
          return (
            <div
              key={`${roleLabel}-${index}-${(message as any).timestamp || index}`}
              className="border-b border-border/40 py-2 font-mono text-[12px] leading-5"
            >
              <div className="mb-1 text-[10px] uppercase tracking-[0.06em] text-muted-foreground">{roleLabel}</div>
              <pre className="m-0 whitespace-pre-wrap break-words text-foreground">{body || "[empty]"}</pre>
            </div>
          );
        })}

        {isLoading && (
          <div className="py-3 font-mono text-[12px] text-muted-foreground">
            [running]
          </div>
        )}

        {error && (
          <div className="py-3 font-mono text-[12px] text-destructive">
            [error] {error}
          </div>
        )}
      </div>
    </div>
  );

  // Provider names for display
  const providerNames: Record<string, string> = {
    claude: "Claude Code",
    codex: "Codex CLI",
    gemini: "Gemini CLI",
    aider: "Aider",
    goose: "Goose",
    opencode: "OpenCode",
  };

  const providerIcons: Record<string, React.ComponentType<{ className?: string }>> = {
    claude: Sparkles,
    codex: Command,
    gemini: Cpu,
    aider: Wrench,
    goose: Send,
    opencode: Code,
  };

  const handleProviderChange = (newProviderId: string) => {
    setActiveProviderId(newProviderId);
    setShowProviderMenu(false);
    onProviderChange?.(newProviderId);
  };

  const handlePlainTerminalToggle = async () => {
    const next = !plainTerminalMode;
    setPlainTerminalMode(next);
    await savePlainTerminalModePreference(next);
  };

  const handleNativeTerminalToggle = async () => {
    const next = !nativeTerminalMode;
    setNativeTerminalMode(next);
    await saveNativeTerminalModePreference(next);
  };

  async function handleSelectTerminalProject() {
    const resolvedProjectPath = projectPath || (await resolveProjectPathForPrompt());
    if (!resolvedProjectPath) {
      setError("Please select a project directory first");
      return;
    }

    if (!projectPath) {
      setProjectPath(resolvedProjectPath);
      onProjectPathChange?.(resolvedProjectPath);
    }
    setError(null);
  }

  const handleChooseResumeLatest = React.useCallback(async () => {
    onRestorePreferenceChange?.('resume_latest');
    await resolveLatestNativeSessionAndBoot();
  }, [onRestorePreferenceChange, resolveLatestNativeSessionAndBoot]);

  const handleChooseStartFresh = React.useCallback(() => {
    onRestorePreferenceChange?.('start_fresh');
    onResumeSessionIdChange?.(undefined);
    setNativeRestoreNotice(null);
    bootNativeTerminalWithStartupCommand();
  }, [bootNativeTerminalWithStartupCommand, onRestorePreferenceChange, onResumeSessionIdChange]);

  const nativeTerminalPanel = (() => {
    if (!projectPath) {
      return (
        <div className="flex-1 overflow-y-auto pb-20">
          <div className={cn("mx-auto w-full px-4 py-6", embedded ? "" : "max-w-4xl")}>
            <div className="rounded-lg border border-border bg-background p-4">
              <div className="mb-2 text-sm font-medium">In-App Terminal Mode</div>
              <p className="mb-4 text-sm text-muted-foreground">
                Select a project path to start an embedded terminal inside this pane.
              </p>
              <Button size="sm" onClick={handleSelectTerminalProject}>
                Select Project
              </Button>
            </div>
          </div>
        </div>
      );
    }

    if (!hasBootedNativeTerminal) {
      return (
        <div className="flex-1 overflow-y-auto pb-20">
          <div className={cn("mx-auto w-full px-4 py-6", embedded ? "" : "max-w-4xl")}>
            <div className="rounded-lg border border-border bg-background p-4">
              <div className="mb-2 text-sm font-medium">In-App Terminal Mode</div>
              {isResolvingNativeRestore ? (
                <p className="mb-2 text-sm text-muted-foreground">
                  Resolving latest session for this project...
                </p>
              ) : !isPaneVisible ? (
                <p className="mb-2 text-sm text-muted-foreground">
                  Terminal will start when this pane becomes active.
                </p>
              ) : showNativeRestorePrompt ? (
                <>
                  <p className="mb-3 text-sm text-muted-foreground">
                    Restore this pane from the latest session, or start fresh?
                  </p>
                  <div className="flex items-center gap-2">
                    <Button size="sm" onClick={handleChooseResumeLatest} data-testid="native-restore-resume-latest">
                      Resume Latest
                    </Button>
                    <Button
                      size="sm"
                      variant="outline"
                      onClick={handleChooseStartFresh}
                      data-testid="native-restore-start-fresh"
                    >
                      Start Fresh
                    </Button>
                  </div>
                </>
              ) : (
                <p className="mb-2 text-sm text-muted-foreground">Preparing terminal startup...</p>
              )}
              {nativeRestoreNotice && (
                <p className="mt-3 text-xs text-muted-foreground">{nativeRestoreNotice}</p>
              )}
            </div>
          </div>
        </div>
      );
    }

    return (
      <EmbeddedTerminal
        projectPath={projectPath}
        autoRunCommand={nativeTerminalCommand}
        existingTerminalId={embeddedTerminalId}
        persistentSessionId={persistentTerminalSessionId}
        onTerminalIdChange={onEmbeddedTerminalIdChange}
        isInteractive={isPaneVisible && isPaneActive}
        workspaceId={workspaceId}
        terminalTabId={terminalTabId}
        paneId={paneId}
        className="min-h-0 flex-1"
      />
    );
  })();

  const showProjectPathHeader = shouldShowProjectPathHeader(
    hideProjectBar,
    nativeTerminalMode,
    detectedProviders.length,
    projectPath
  );
  const showProviderSelector = shouldShowProviderSelectorInHeader(
    nativeTerminalMode,
    detectedProviders.length
  );

  // Provider selector bar and path/toggles row.
  const projectPathInput = showProjectPathHeader ? (
    <div
      className={cn(
        "flex items-center gap-1.5 px-0 py-1.5 border-b border-border/50 text-xs",
        embedded && "workspace-chip-icon-align"
      )}
    >
      {showProviderSelector ? (
        <div className="relative">
          <button
            onClick={() => setShowProviderMenu(!showProviderMenu)}
            className="flex items-center gap-1.5 px-0 py-1 rounded-md hover:bg-accent/50 transition-colors text-muted-foreground hover:text-foreground"
            data-testid="provider-menu-trigger"
          >
            {(() => {
              const ActiveProviderIcon = providerIcons[activeProviderId] || Command;
              return <ActiveProviderIcon className="h-3.5 w-3.5 shrink-0" />;
            })()}
            <span className="font-medium">{providerNames[activeProviderId] || activeProviderId}</span>
            <ChevronDown className="h-3 w-3" />
          </button>
          {showProviderMenu && (
            <div className="absolute top-full left-0 mt-1 z-50 bg-popover border border-border rounded-md shadow-lg py-1 min-w-[160px]">
              {detectedProviders.map((agent) => (
                <button
                  key={agent.providerId}
                  onClick={() => handleProviderChange(agent.providerId)}
                  className={cn(
                    "w-full text-left px-3 py-1.5 text-xs hover:bg-accent/50 transition-colors flex items-center justify-between",
                    agent.providerId === activeProviderId && "bg-accent/30 text-foreground font-medium"
                  )}
                >
                  {(() => {
                    const ProviderIcon = providerIcons[agent.providerId] || Command;
                    return (
                  <span className="flex min-w-0 items-center gap-1.5">
                    <ProviderIcon className="h-3.5 w-3.5 shrink-0" />
                    <span className="truncate">{providerNames[agent.providerId] || agent.providerId}</span>
                  </span>
                    );
                  })()}
                  {agent.version && (
                    <span className="text-muted-foreground ml-2">v{agent.version}</span>
                  )}
                </button>
              ))}
            </div>
          )}
        </div>
      ) : null}
      {projectPath && (
        <span className="text-muted-foreground truncate">{projectPath.replace(/^\/Users\/[^/]+\//, '~/')}</span>
      )}
      <div className="ml-auto flex items-center gap-1">
        <Button
          variant="ghost"
          size="sm"
          onClick={handleNativeTerminalToggle}
          className={cn(
            "h-6 px-2 text-[10px] font-medium uppercase tracking-[0.06em]",
            nativeTerminalMode ? "text-foreground" : "text-muted-foreground"
          )}
          title={nativeTerminalMode ? "Disable in-app terminal mode" : "Enable in-app terminal mode"}
        >
          Terminal
        </Button>
        <Button
          variant="ghost"
          size="sm"
          onClick={handlePlainTerminalToggle}
          className={cn(
            "h-6 px-2 text-[10px] font-medium uppercase tracking-[0.06em]",
            plainTerminalMode ? "text-foreground" : "text-muted-foreground"
          )}
          title={plainTerminalMode ? "Switch to styled view" : "Switch to plain terminal view"}
        >
          {plainTerminalMode ? "Styled" : "Plain"}
        </Button>
      </div>
    </div>
  ) : null;

  // If preview is maximized, render only the WebviewPreview in full screen
  if (showPreview && isPreviewMaximized && !embedded) {
    return (
      <AnimatePresence>
        <motion.div 
          className="fixed inset-0 z-50 bg-background"
          initial={{ opacity: 0, y: 8 }}
          animate={{ opacity: 1, y: 0 }}
          exit={{ opacity: 0 }}
          transition={{ duration: 0.2 }}
        >
          <WebviewPreview
            initialUrl={previewUrl}
            onClose={handleClosePreview}
            isMaximized={isPreviewMaximized}
            onToggleMaximize={handleTogglePreviewMaximize}
            onUrlChange={handlePreviewUrlChange}
            className="h-full"
          />
        </motion.div>
      </AnimatePresence>
    );
  }

  return (
    <TooltipProvider>
      <div className={cn("relative flex h-full flex-col bg-background", className)}>
        <div className="relative w-full h-full flex flex-col">

        {/* Main Content Area */}
        <div className={cn(
          "flex-1 overflow-hidden transition-all duration-300",
          showTimeline && "sm:mr-96"
        )}>
          {showPreview && previewMode === 'split' ? (
            // Split pane layout when preview is active
            <SplitPane
              left={
                <div className="h-full flex flex-col">
                  {projectPathInput}
                  {nativeTerminalMode
                    ? nativeTerminalPanel
                    : plainTerminalMode
                      ? plainMessagesList
                      : messagesList}
                </div>
              }
              right={
                <WebviewPreview
                  initialUrl={previewUrl}
                  onClose={handleClosePreview}
                  isMaximized={isPreviewMaximized}
                  onToggleMaximize={handleTogglePreviewMaximize}
                  onUrlChange={handlePreviewUrlChange}
                />
              }
              initialSplit={splitPosition}
              onSplitChange={setSplitPosition}
              minLeftWidth={400}
              minRightWidth={400}
              className="h-full"
            />
          ) : (
            // Original layout when no preview
            <div className={cn("h-full flex flex-col", embedded ? "workspace-chrome-row" : "max-w-6xl mx-auto px-6")}>
              {projectPathInput}
              {nativeTerminalMode
                ? nativeTerminalPanel
                : plainTerminalMode
                  ? plainMessagesList
                  : messagesList}
              
              {isLoading && messages.length === 0 && (
                <div className="flex items-center justify-center h-full">
                  <div className="flex items-center gap-3">
                    <div className="rotating-symbol text-primary" />
                    <span className="text-sm text-muted-foreground">
                      {session ? "Loading session history..." : "Initializing session..."}
                    </span>
                  </div>
                </div>
              )}
            </div>
          )}

          {showPreview && previewMode === 'slideover' && (
            <motion.div
              initial={{ x: '100%' }}
              animate={{ x: 0 }}
              exit={{ x: '100%' }}
              transition={{ duration: 0.2, ease: 'easeOut' }}
              className={cn(
                embedded
                  ? "absolute inset-y-0 right-0 z-40 w-[56%] min-w-[360px] border-l border-border/70 bg-background"
                  : "fixed inset-y-0 right-0 z-50 w-[min(720px,56vw)] border-l border-border/70 bg-background shadow-2xl"
              )}
            >
              <WebviewPreview
                initialUrl={previewUrl}
                onClose={handleClosePreview}
                isMaximized={isPreviewMaximized}
                onToggleMaximize={handleTogglePreviewMaximize}
                onUrlChange={handlePreviewUrlChange}
                className="h-full"
              />
            </motion.div>
          )}
        </div>

        {/* Floating Prompt Input - Always visible */}
        <ErrorBoundary>
          {/* Queued Prompts Display */}
          <AnimatePresence>
            {queuedPrompts.length > 0 && !hideFloatingGlobalControls && !plainTerminalMode && !nativeTerminalMode && (
              <motion.div
                initial={{ opacity: 0, y: 20 }}
                animate={{ opacity: 1, y: 0 }}
                exit={{ opacity: 0, y: 20 }}
                className={cn(
                  embedded
                    ? "absolute bottom-20 left-1/2 -translate-x-1/2 z-30 w-full max-w-3xl px-4"
                    : "fixed bottom-24 left-1/2 -translate-x-1/2 z-30 w-full max-w-3xl px-4"
                )}
              >
                <div className="bg-background/95 backdrop-blur-md border rounded-lg shadow-lg p-3 space-y-2">
                  <div className="flex items-center justify-between">
                    <div className="text-xs font-medium text-muted-foreground mb-1">
                      Queued Prompts ({queuedPrompts.length})
                    </div>
                    <TooltipSimple content={queuedPromptsCollapsed ? "Expand queue" : "Collapse queue"} side="top">
                      <motion.div
                        whileTap={{ scale: 0.97 }}
                        transition={{ duration: 0.15 }}
                      >
                        <Button variant="ghost" size="icon" onClick={() => setQueuedPromptsCollapsed(prev => !prev)}>
                          {queuedPromptsCollapsed ? <ChevronUp className="h-3 w-3" /> : <ChevronDown className="h-3 w-3" />}
                        </Button>
                      </motion.div>
                    </TooltipSimple>
                  </div>
                  {!queuedPromptsCollapsed && queuedPrompts.map((queuedPrompt, index) => (
                    <motion.div
                      key={queuedPrompt.id}
                      initial={{ opacity: 0, y: 4 }}
                      animate={{ opacity: 1, y: 0 }}
                      exit={{ opacity: 0, y: -4 }}
                      transition={{ duration: 0.15, delay: index * 0.02 }}
                      className="flex items-start gap-2 bg-muted/50 rounded-md p-2"
                    >
                      <div className="flex-1 min-w-0">
                        <div className="flex items-center gap-2 mb-1">
                          <span className="text-xs font-medium text-muted-foreground">#{index + 1}</span>
                          <span className="text-xs px-1.5 py-0.5 bg-primary/10 text-primary rounded">
                            {getProviderDisplayName(queuedPrompt.providerId)} · {getModelDisplayName(queuedPrompt.providerId, queuedPrompt.model)}
                          </span>
                        </div>
                        <p className="text-sm line-clamp-2 break-words">{queuedPrompt.prompt}</p>
                      </div>
                      <motion.div
                        whileTap={{ scale: 0.97 }}
                        transition={{ duration: 0.15 }}
                      >
                        <Button
                          variant="ghost"
                          size="icon"
                          className="h-6 w-6 flex-shrink-0"
                          onClick={() => setQueuedPrompts(prev => prev.filter(p => p.id !== queuedPrompt.id))}
                        >
                          <X className="h-3 w-3" />
                        </Button>
                      </motion.div>
                    </motion.div>
                  ))}
                </div>
              </motion.div>
            )}
          </AnimatePresence>

          {/* Navigation Arrows - positioned above prompt bar with spacing */}
          {displayableMessages.length > 5 && !hideFloatingGlobalControls && !plainTerminalMode && !nativeTerminalMode && (
            <motion.div
              initial={{ opacity: 0, scale: 0.8 }}
              animate={{ opacity: 1, scale: 1 }}
              exit={{ opacity: 0, scale: 0.8 }}
              transition={{ delay: 0.5 }}
              className={cn(
                embedded ? "absolute bottom-28 right-4 z-40" : "fixed bottom-32 right-6 z-50"
              )}
            >
              <div className="flex items-center bg-background border border-[var(--color-chrome-border)] rounded-md shadow-sm overflow-hidden">
                <TooltipSimple content="Scroll to top" side="top">
                  <motion.div
                    whileTap={{ scale: 0.97 }}
                    transition={{ duration: 0.15 }}
                  >
                    <Button
                      variant="ghost"
                      size="sm"
                      onClick={() => {
                      // Use virtualizer to scroll to the first item
                      if (displayableMessages.length > 0) {
                        // Scroll to top of the container
                        parentRef.current?.scrollTo({
                          top: 0,
                          behavior: 'smooth'
                        });
                        
                        // After smooth scroll completes, trigger a small scroll to ensure rendering
                        setTimeout(() => {
                          if (parentRef.current) {
                            // Scroll down 1px then back to 0 to trigger virtualizer update
                            parentRef.current.scrollTop = 1;
                            requestAnimationFrame(() => {
                              if (parentRef.current) {
                                parentRef.current.scrollTop = 0;
                              }
                            });
                          }
                        }, 500); // Wait for smooth scroll to complete
                      }
                    }}
                      className="px-2.5 py-1.5 hover:bg-accent rounded-none"
                    >
                      <ChevronUp className="h-3.5 w-3.5" />
                    </Button>
                  </motion.div>
                </TooltipSimple>
                <div className="w-px h-3.5 bg-border" />
                <TooltipSimple content="Scroll to bottom" side="top">
                  <motion.div
                    whileTap={{ scale: 0.97 }}
                    transition={{ duration: 0.15 }}
                  >
                    <Button
                      variant="ghost"
                      size="sm"
                      onClick={() => {
                        // Use the improved scrolling method for manual scroll to bottom
                        if (displayableMessages.length > 0) {
                          const scrollElement = parentRef.current;
                          if (scrollElement) {
                            // First, scroll using virtualizer to get close to the bottom
                            rowVirtualizer.scrollToIndex(displayableMessages.length - 1, { align: 'end', behavior: 'auto' });

                            // Then use direct scroll to ensure we reach the absolute bottom
                            requestAnimationFrame(() => {
                              scrollElement.scrollTo({
                                top: scrollElement.scrollHeight,
                                behavior: 'smooth'
                              });
                            });
                          }
                        }
                      }}
                      className="px-2.5 py-1.5 hover:bg-accent rounded-none"
                    >
                      <ChevronDown className="h-3.5 w-3.5" />
                    </Button>
                  </motion.div>
                </TooltipSimple>
              </div>
            </motion.div>
          )}

          <div className={cn(
            embedded
              ? "absolute bottom-0 left-0 right-0 transition-all duration-300 z-40"
              : "fixed bottom-0 left-0 right-0 transition-all duration-300 z-50",
            showTimeline && "sm:right-96"
          )}>
            {nativeTerminalMode ? (
              <div className="border-t border-border bg-background/95 px-4 py-2">
                <div className={cn("mx-auto flex w-full items-center justify-between", embedded ? "" : "max-w-6xl")}>
                  <div className="text-xs text-muted-foreground">
                    {nativeRestoreNotice || 'In-app terminal mode is active'}
                  </div>
                  {!projectPath && (
                    <Button size="sm" onClick={handleSelectTerminalProject}>
                      Select Project
                    </Button>
                  )}
                </div>
              </div>
            ) : (
              <FloatingPromptInput
                ref={floatingPromptRef}
                onSend={handleSendPrompt}
                onCancel={handleCancelExecution}
                isLoading={isLoading}
                disabled={false}
                providerId={activeProviderId}
                defaultModel={getDefaultModelForProvider(activeProviderId)}
                projectPath={projectPath}
                className={embedded ? "!absolute !left-0 !right-0 !bottom-0 !z-40" : undefined}
                extraMenuItems={
                  <>
                    {effectiveSession && !hideFloatingGlobalControls && (
                      <TooltipSimple content="Session Timeline" side="top">
                        <motion.div
                          whileTap={{ scale: 0.97 }}
                          transition={{ duration: 0.15 }}
                        >
                          <Button
                            variant="ghost"
                            size="icon"
                            onClick={() => setShowTimeline(!showTimeline)}
                            className="h-5 w-5 text-muted-foreground hover:text-foreground"
                          >
                            <GitBranch className={cn("h-2.5 w-2.5", showTimeline && "text-primary")} />
                          </Button>
                        </motion.div>
                      </TooltipSimple>
                    )}
                    {messages.length > 0 && !hideFloatingGlobalControls && (
                      <Popover
                        trigger={
                          <TooltipSimple content="Copy conversation" side="top">
                            <motion.div
                              whileTap={{ scale: 0.97 }}
                              transition={{ duration: 0.15 }}
                            >
                              <Button
                                variant="ghost"
                                size="icon"
                                className="h-5 w-5 text-muted-foreground hover:text-foreground"
                              >
                                <Copy className="h-2.5 w-2.5" />
                              </Button>
                            </motion.div>
                          </TooltipSimple>
                        }
                        content={
                          <div className="w-44 p-1">
                            <Button
                              variant="ghost"
                              size="sm"
                              onClick={handleCopyAsMarkdown}
                              className="w-full justify-start text-xs"
                            >
                              Copy as Markdown
                            </Button>
                            <Button
                              variant="ghost"
                              size="sm"
                              onClick={handleCopyAsJsonl}
                              className="w-full justify-start text-xs"
                            >
                              Copy as JSONL
                            </Button>
                          </div>
                        }
                        open={copyPopoverOpen}
                        onOpenChange={setCopyPopoverOpen}
                        side="top"
                        align="end"
                      />
                    )}
                    <TooltipSimple content="Checkpoint Settings" side="top">
                      <motion.div
                        whileTap={{ scale: 0.97 }}
                        transition={{ duration: 0.15 }}
                      >
                        <Button
                          variant="ghost"
                          size="icon"
                          onClick={() => setShowSettings(!showSettings)}
                          className="h-5 w-5 text-muted-foreground hover:text-foreground"
                        >
                          <Wrench className={cn("h-2.5 w-2.5", showSettings && "text-primary")} />
                        </Button>
                      </motion.div>
                    </TooltipSimple>
                  </>
                }
              />
            )}
          </div>

          {/* Token Counter - positioned under the Send button */}
          {totalTokens > 0 && !hideFloatingGlobalControls && !nativeTerminalMode && (
            <div className={cn(
              embedded ? "absolute bottom-0 left-0 right-0 z-30 pointer-events-none" : "fixed bottom-0 left-0 right-0 z-30 pointer-events-none"
            )}>
              <div className="max-w-6xl mx-auto">
                <div className="flex justify-end px-4 pb-2">
                  <motion.div
                    initial={{ opacity: 0, scale: 0.8 }}
                    animate={{ opacity: 1, scale: 1 }}
                    exit={{ opacity: 0, scale: 0.8 }}
                    className="bg-background border border-[var(--color-chrome-border)] rounded-md px-2 py-0.5 shadow-sm pointer-events-auto"
                  >
                    <div className="flex items-center gap-1 text-[11px]">
                      <Hash className="h-2.5 w-2.5 text-muted-foreground" />
                      <span className="font-mono">{totalTokens.toLocaleString()}</span>
                      <span className="text-muted-foreground">tokens</span>
                    </div>
                  </motion.div>
                </div>
              </div>
            </div>
          )}
        </ErrorBoundary>

        {/* Timeline */}
        <AnimatePresence>
          {showTimeline && effectiveSession && (
            <motion.div
              initial={{ x: "100%" }}
              animate={{ x: 0 }}
              exit={{ x: "100%" }}
              transition={{ duration: 0.2, ease: "easeOut" }}
              className="fixed right-0 top-0 h-full w-full sm:w-96 bg-background border-l border-border shadow-xl z-30 overflow-hidden"
            >
              <div className="h-full flex flex-col">
                {/* Timeline Header */}
                <div className="flex items-center justify-between p-4 border-b border-border">
                  <h3 className="text-lg font-semibold">Session Timeline</h3>
                  <Button
                    variant="ghost"
                    size="icon"
                    onClick={() => setShowTimeline(false)}
                    className="h-8 w-8"
                  >
                    <X className="h-4 w-4" />
                  </Button>
                </div>
                
                {/* Timeline Content */}
                <div className="flex-1 overflow-y-auto p-4">
                  <TimelineNavigator
                    sessionId={effectiveSession.id}
                    projectId={effectiveSession.project_id}
                    projectPath={projectPath}
                    currentMessageIndex={messages.length - 1}
                    onCheckpointSelect={handleCheckpointSelect}
                    onFork={handleFork}
                    onCheckpointCreated={handleCheckpointCreated}
                    refreshVersion={timelineVersion}
                  />
                </div>
              </div>
            </motion.div>
          )}
        </AnimatePresence>
      </div>

      {/* Fork Dialog */}
      <Dialog open={showForkDialog} onOpenChange={setShowForkDialog}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Fork Session</DialogTitle>
            <DialogDescription>
              Create a new session branch from the selected checkpoint.
            </DialogDescription>
          </DialogHeader>
          
          <div className="space-y-4 py-4">
            <div className="space-y-2">
              <Label htmlFor="fork-name">New Session Name</Label>
              <Input
                id="fork-name"
                placeholder="e.g., Alternative approach"
                value={forkSessionName}
                onChange={(e) => setForkSessionName(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === "Enter" && !isLoading) {
                    if (e.nativeEvent.isComposing || isIMEComposingRef.current) {
                      return;
                    }
                    handleConfirmFork();
                  }
                }}
                onCompositionStart={handleCompositionStart}
                onCompositionEnd={handleCompositionEnd}
              />
            </div>
          </div>
          
          <DialogFooter>
            <Button
              variant="outline"
              onClick={() => setShowForkDialog(false)}
              disabled={isLoading}
            >
              Cancel
            </Button>
            <Button
              onClick={handleConfirmFork}
              disabled={isLoading || !forkSessionName.trim()}
            >
              Create Fork
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Settings Dialog */}
      {showSettings && effectiveSession && (
        <Dialog open={showSettings} onOpenChange={setShowSettings}>
          <DialogContent className="max-w-2xl">
            <CheckpointSettings
              sessionId={effectiveSession.id}
              projectId={effectiveSession.project_id}
              projectPath={projectPath}
              onClose={() => setShowSettings(false)}
            />
          </DialogContent>
        </Dialog>
      )}

      {/* Slash Commands Settings Dialog */}
      {showSlashCommandsSettings && (
        <Dialog open={showSlashCommandsSettings} onOpenChange={setShowSlashCommandsSettings}>
          <DialogContent className="max-w-4xl max-h-[80vh] overflow-hidden">
            <DialogHeader>
              <DialogTitle>Slash Commands</DialogTitle>
              <DialogDescription>
                Manage project-specific slash commands for {projectPath}
              </DialogDescription>
            </DialogHeader>
            <div className="flex-1 overflow-y-auto">
              <SlashCommandsManager projectPath={projectPath} />
            </div>
          </DialogContent>
        </Dialog>
      )}
      </div>
    </TooltipProvider>
  );
};

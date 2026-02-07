import React, { useState, useEffect, useRef, useMemo } from "react";
import { motion, AnimatePresence } from "framer-motion";
import { 
  Copy,
  ChevronDown,
  GitBranch,
  ChevronUp,
  X,
  Hash,
  Wrench
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Popover } from "@/components/ui/popover";
import { api, type Session } from "@/lib/api";
import { cn } from "@/lib/utils";

// Tauri event listener — use dynamic import to work with Vite's ESM environment.
// `require()` does not work in Vite; `import()` returns the correct ESM module.
type UnlistenFn = () => void;

// Resolved lazily on first use via getTauriListen()
let _tauriListenPromise: Promise<any> | null = null;

function getTauriListen(): Promise<any> {
  const hasTauriBridge = typeof window !== 'undefined' && (
    Boolean((window as any).__TAURI__) ||
    Boolean((window as any).__TAURI_INTERNALS__) ||
    Boolean((window as any).__TAURI_METADATA__)
  );

  if (!hasTauriBridge) {
    return Promise.resolve(null);
  }

  if (!_tauriListenPromise) {
    _tauriListenPromise = import("@tauri-apps/api/event")
      .then((m) => m.listen)
      .catch((error) => {
        // Allow retry on next call if the bridge is still initializing.
        _tauriListenPromise = null;
        console.warn("[ClaudeCodeSession] Failed to load Tauri event listener, falling back to DOM events", error);
        return null;
      });
  }
  return _tauriListenPromise;
}

// DOM-based fallback for web mode (non-Tauri)
const domListen = (eventName: string, callback: (event: any) => void): Promise<UnlistenFn> => {
  console.log('[ClaudeCodeSession] Setting up DOM event listener for:', eventName);
  const domEventHandler = (event: any) => {
    console.log('[ClaudeCodeSession] DOM event received:', eventName, event.detail);
    callback({ payload: event.detail });
  };
  window.addEventListener(eventName, domEventHandler);
  return Promise.resolve(() => {
    window.removeEventListener(eventName, domEventHandler);
  });
};

// Unified listen function: uses Tauri IPC when available, DOM events as fallback
const listen = async (eventName: string, callback: (event: any) => void): Promise<UnlistenFn> => {
  const tauriListen = await getTauriListen();
  if (tauriListen) {
    return tauriListen(eventName, callback);
  }
  return domListen(eventName, callback);
};
import { StreamMessage } from "./StreamMessage";
import { FloatingPromptInput, type FloatingPromptInputRef } from "./FloatingPromptInput";
import { ErrorBoundary } from "./ErrorBoundary";
import { TimelineNavigator } from "./TimelineNavigator";
import { CheckpointSettings } from "./CheckpointSettings";
import { SlashCommandsManager } from "./SlashCommandsManager";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription, DialogFooter } from "@/components/ui/dialog";
import { TooltipProvider, TooltipSimple } from "@/components/ui/tooltip-modern";
import { SplitPane } from "@/components/ui/split-pane";
import { WebviewPreview } from "./WebviewPreview";
import type { ClaudeStreamMessage } from "./AgentExecution";
import { useVirtualizer } from "@tanstack/react-virtual";
import { useTrackEvent, useComponentMetrics, useWorkflowTracking } from "@/hooks";
import { SessionPersistenceService } from "@/services/sessionPersistence";
import { logWorkspaceEvent } from "@/services/workspaceDiagnostics";
import {
  getDefaultModelForProvider,
  getModelDisplayName,
  getProviderDisplayName,
} from "@/lib/providerModels";

interface ClaudeCodeSessionProps {
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

/**
 * ClaudeCodeSession component for interactive Claude Code sessions
 * 
 * @example
 * <ClaudeCodeSession onBack={() => setView('projects')} />
 */
export const ClaudeCodeSession: React.FC<ClaudeCodeSessionProps> = ({
  session,
  initialProjectPath = "",
  className,
  onStreamingChange,
  onProjectPathChange,
  providerId: initialProviderId = "claude",
  onProviderChange,
  embedded = false,
  hideProjectBar = false,
  hideFloatingGlobalControls = false,
  previewMode = 'split',
}) => {
  type QueuedPrompt = {
    id: string;
    prompt: string;
    model: string;
    providerId: string;
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
  const [claudeSessionId, setClaudeSessionId] = useState<string | null>(null);
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
  const [activeProviderId, setActiveProviderId] = useState(initialProviderId);
  const [detectedProviders, setDetectedProviders] = useState<Array<{ providerId: string; binaryPath: string; version: string | null; source: string }>>([]);
  const [showProviderMenu, setShowProviderMenu] = useState(false);

  const parentRef = useRef<HTMLDivElement>(null);
  const unlistenRefs = useRef<UnlistenFn[]>([]);
  const hasActiveSessionRef = useRef(false);
  const floatingPromptRef = useRef<FloatingPromptInputRef>(null);
  const queuedPromptsRef = useRef<QueuedPrompt[]>([]);
  const isMountedRef = useRef(true);
  const isListeningRef = useRef(false);
  const firstStreamTimeoutRef = useRef<number | null>(null);
  const hardTimeoutRef = useRef<number | null>(null);
  const firstStreamSeenRef = useRef(false);
  const sessionStartTime = useRef<number>(Date.now());
  const isIMEComposingRef = useRef(false);
  
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
  useComponentMetrics('ClaudeCodeSession');
  // const aiTracking = useAIInteractionTracking('sonnet'); // Default model
  const workflowTracking = useWorkflowTracking('claude_session');
  
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

  // Sync local provider state if parent tab updates provider.
  useEffect(() => {
    setActiveProviderId(initialProviderId || "claude");
  }, [initialProviderId]);

  // Detect available providers on mount
  useEffect(() => {
    let isCancelled = false;

    api.listDetectedAgents()
      .then((agents: any[]) => {
        if (isCancelled) return;

        const providers = agents.map((a: any) => ({
          providerId: a.provider_id,
          binaryPath: a.binary_path,
          version: a.version,
          source: a.source,
        }));

        setDetectedProviders(providers);

        if (providers.length === 0) return;

        // If the active provider isn't installed, auto-fallback to a detected one.
        setActiveProviderId((current) => {
          const currentDetected = providers.some((p: any) => p.providerId === current);
          if (currentDetected) return current;

          const fallback =
            providers.find((p: any) => p.providerId === initialProviderId) ||
            providers.find((p: any) => p.providerId === "claude") ||
            providers[0];

          if (fallback && fallback.providerId !== current) {
            onProviderChange?.(fallback.providerId);
            return fallback.providerId;
          }
          return current;
        });
      })
      .catch((err: any) => {
        if (isCancelled) return;
        console.warn('[ClaudeCodeSession] Failed to detect agents:', err);
      });

    return () => {
      isCancelled = true;
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

  const rowVirtualizer = useVirtualizer({
    count: displayableMessages.length,
    getScrollElement: () => parentRef.current,
    estimateSize: () => 150, // Estimate, will be dynamically measured
    overscan: 5,
  });

  // Debug logging
  useEffect(() => {
    console.log('[ClaudeCodeSession] State update:', {
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
    if (session) {
      // Set the claudeSessionId immediately when we have a session
      setClaudeSessionId(session.id);
      
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
  }, [session]); // Remove hasLoadedSession dependency to ensure it runs on mount

  // Report streaming state changes
  useEffect(() => {
    onStreamingChange?.(isLoading, claudeSessionId);
  }, [isLoading, claudeSessionId, onStreamingChange]);

  // Auto-scroll to bottom when new messages arrive
  useEffect(() => {
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
  }, [displayableMessages.length, rowVirtualizer]);

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
        const activeSessions = await api.listRunningClaudeSessions();
        const activeSession = activeSessions.find((s: any) => {
          if ('process_type' in s && s.process_type && 'ClaudeSession' in s.process_type) {
            return (s.process_type as any).ClaudeSession.session_id === session.id;
          }
          return false;
        });
        
        if (activeSession) {
          // Session is still active, reconnect to its stream
          console.log('[ClaudeCodeSession] Found active session, reconnecting:', session.id);
          // IMPORTANT: Set claudeSessionId before reconnecting
          setClaudeSessionId(session.id);
          
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
    console.log('[ClaudeCodeSession] Reconnecting to session:', sessionId);
    
    // Prevent duplicate listeners
    if (isListeningRef.current) {
      console.log('[ClaudeCodeSession] Already listening to session, skipping reconnect');
      return;
    }
    
    // Clean up previous listeners
    unlistenRefs.current.forEach(unlisten => unlisten());
    unlistenRefs.current = [];
    
    // IMPORTANT: Set the session ID before setting up listeners
    setClaudeSessionId(sessionId);
    
    // Mark as listening
    isListeningRef.current = true;
    
    // Set up session-specific listeners
    const outputUnlisten = await listen(`claude-output:${sessionId}`, async (event: any) => {
      try {
        console.log('[ClaudeCodeSession] Received claude-output on reconnect:', event.payload);
        
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

    const errorUnlisten = await listen(`claude-error:${sessionId}`, (event: any) => {
      console.error("Claude error:", event.payload);
      if (isMountedRef.current) {
        setError(event.payload);
        clearStreamWatchdogs();
        setIsLoading(false);
        hasActiveSessionRef.current = false;
        isListeningRef.current = false;
      }
    });

    const completeUnlisten = await listen(`claude-complete:${sessionId}`, async (event: any) => {
      console.log('[ClaudeCodeSession] Received claude-complete on reconnect:', event.payload);
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
    if (firstStreamTimeoutRef.current !== null) {
      window.clearTimeout(firstStreamTimeoutRef.current);
      firstStreamTimeoutRef.current = null;
    }
    if (hardTimeoutRef.current !== null) {
      window.clearTimeout(hardTimeoutRef.current);
      hardTimeoutRef.current = null;
    }
  };

  const markFirstStreamSeen = (providerId: string) => {
    if (firstStreamSeenRef.current) return;
    firstStreamSeenRef.current = true;
    if (firstStreamTimeoutRef.current !== null) {
      window.clearTimeout(firstStreamTimeoutRef.current);
      firstStreamTimeoutRef.current = null;
    }
    logWorkspaceEvent({
      category: 'stream_watchdog',
      action: 'first_stream_message',
      payload: { providerId },
    });
  };

  const startStreamWatchdogs = (providerId: string, path: string) => {
    clearStreamWatchdogs();
    firstStreamSeenRef.current = false;

    firstStreamTimeoutRef.current = window.setTimeout(() => {
      if (!isMountedRef.current || firstStreamSeenRef.current) return;
      setIsLoading(false);
      hasActiveSessionRef.current = false;
      isListeningRef.current = false;
      setError('No response stream started within 8s. Check provider runtime or project path.');
      logWorkspaceEvent({
        category: 'stream_watchdog',
        action: 'first_stream_timeout',
        message: 'No stream event received in first 8s',
        payload: { providerId, projectPath: path },
      });
    }, 8000);

    hardTimeoutRef.current = window.setTimeout(() => {
      if (!isMountedRef.current || !hasActiveSessionRef.current) return;
      setIsLoading(false);
      hasActiveSessionRef.current = false;
      isListeningRef.current = false;
      setError('Session did not complete within 120s. Try stopping and re-running.');
      logWorkspaceEvent({
        category: 'stream_watchdog',
        action: 'hard_timeout',
        message: 'No completion within 120s',
        payload: { providerId, projectPath: path },
      });
    }, 120000);
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

  const handleSendPrompt = async (prompt: string, model: string, providerIdOverride?: string) => {
    const providerToUse = providerIdOverride || activeProviderId;
    const isClaudeProviderForRun = providerToUse === "claude";
    const modelForTracking = model || "default";
    let runProjectPath = projectPath;

    console.log('[ClaudeCodeSession] handleSendPrompt called with:', {
      prompt,
      model,
      providerToUse,
      projectPath,
      claudeSessionId,
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
        },
      });
      
      // For resuming sessions, ensure we have the session ID
      if (effectiveSession && !claudeSessionId) {
        setClaudeSessionId(effectiveSession.id);
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

        console.log('[ClaudeCodeSession] Setting up generic event listeners first');

        let currentSessionId: string | null = claudeSessionId || effectiveSession?.id || null;

        // Helper to attach session-specific listeners **once we are sure**
        const attachSessionSpecificListeners = async (sid: string) => {
          console.log('[ClaudeCodeSession] Attaching session-specific listeners for', sid);

          const specificOutputUnlisten = await listen(`claude-output:${sid}`, (evt: any) => {
            handleStreamMessage(evt.payload);
          });

          const specificErrorUnlisten = await listen(`claude-error:${sid}`, (evt: any) => {
            console.error('Claude error (scoped):', evt.payload);
            setError(evt.payload);
            clearStreamWatchdogs();
            setIsLoading(false);
            hasActiveSessionRef.current = false;
            isListeningRef.current = false;
            logWorkspaceEvent({
              category: 'error',
              action: 'claude_error_scoped',
              message: String(evt.payload ?? ''),
              payload: {
                providerId: providerToUse,
                sessionId: sid,
              },
            });
          });

          const specificCompleteUnlisten = await listen(`claude-complete:${sid}`, (evt: any) => {
            console.log('[ClaudeCodeSession] Received claude-complete (scoped):', evt.payload);
            processComplete(evt.payload);
          });

          // Replace existing unlisten refs with these new ones (after cleaning up)
          unlistenRefs.current.forEach((u) => u());
          unlistenRefs.current = [specificOutputUnlisten, specificErrorUnlisten, specificCompleteUnlisten];
        };

        // Generic listeners (catch-all)
        const genericOutputUnlisten = await listen('claude-output', async (event: any) => {
          handleStreamMessage(event.payload);

          // Attempt to extract session_id on the fly (for the very first init)
          try {
            const msg = JSON.parse(event.payload) as ClaudeStreamMessage;
            if (msg.type === 'system' && msg.subtype === 'init' && msg.session_id) {
              if (!currentSessionId || currentSessionId !== msg.session_id) {
                console.log('[ClaudeCodeSession] Detected new session_id from generic listener:', msg.session_id);
                currentSessionId = msg.session_id;
                setClaudeSessionId(msg.session_id);

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
            
            console.log('[ClaudeCodeSession] handleStreamMessage - message type:', message.type);

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
          logWorkspaceEvent({
            category: 'stream_watchdog',
            action: 'stream_complete',
            payload: {
              success,
              providerId: providerToUse,
            },
          });
          
          // Track enhanced session stopped metrics when session completes
          if (effectiveSession && claudeSessionId) {
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
              handleSendPrompt(nextPrompt.prompt, nextPrompt.model, nextPrompt.providerId);
            }, 100);
          }
        };

        const genericErrorUnlisten = await listen('claude-error', (evt: any) => {
          console.error('Claude error:', evt.payload);
          setError(evt.payload);
          clearStreamWatchdogs();
          setIsLoading(false);
          hasActiveSessionRef.current = false;
          isListeningRef.current = false;
          logWorkspaceEvent({
            category: 'error',
            action: 'claude_error_generic',
            message: String(evt.payload ?? ''),
            payload: {
              providerId: providerToUse,
            },
          });
        });

        const genericCompleteUnlisten = await listen('claude-complete', (evt: any) => {
          console.log('[ClaudeCodeSession] Received claude-complete (generic):', evt.payload);
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
          console.log('[ClaudeCodeSession] Resuming session:', effectiveSession.id, 'provider:', providerToUse);
          trackEvent.sessionResumed(effectiveSession.id);
          trackEvent.modelSelected(modelForTracking);
          if (isClaudeProviderForRun) {
            await api.resumeClaudeCode(runProjectPath, effectiveSession.id, prompt, model);
          } else {
            await api.resumeAgentSession(providerToUse, runProjectPath, effectiveSession.id, prompt, model);
          }
        } else {
          console.log('[ClaudeCodeSession] Starting new session, provider:', providerToUse);
          setIsFirstPrompt(false);
          trackEvent.sessionCreated(modelForTracking, 'prompt_input');
          trackEvent.modelSelected(modelForTracking);
          if (isClaudeProviderForRun) {
            await api.executeClaudeCode(runProjectPath, prompt, model);
          } else {
            await api.executeAgentSession(providerToUse, runProjectPath, prompt, model);
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
    let markdown = `# Claude Code Session\n\n`;
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
    if (!claudeSessionId || !isLoading) return;
    
    try {
      const sessionStartTime = messages.length > 0 ? messages[0].timestamp || Date.now() : Date.now();
      const duration = Date.now() - sessionStartTime;
      
      await api.cancelClaudeExecution(claudeSessionId);
      
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
      console.log("Forked to new session:", newSessionId);
      
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
    console.log('[ClaudeCodeSession] Preview URL changed to:', url);
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
      console.log('[ClaudeCodeSession] Component unmounting, cleaning up listeners');
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

  // Provider names for display
  const providerNames: Record<string, string> = {
    claude: "Claude Code",
    codex: "Codex CLI",
    gemini: "Gemini CLI",
    aider: "Aider",
    goose: "Goose",
    opencode: "OpenCode",
  };

  const handleProviderChange = (newProviderId: string) => {
    setActiveProviderId(newProviderId);
    setShowProviderMenu(false);
    onProviderChange?.(newProviderId);
  };

  // Provider selector bar (only shown when multiple providers detected)
  const projectPathInput = !hideProjectBar && detectedProviders.length > 0 ? (
    <div className="flex items-center gap-2 px-4 py-1.5 border-b border-border/50 text-xs">
      <div className="relative">
        <button
          onClick={() => setShowProviderMenu(!showProviderMenu)}
          className="flex items-center gap-1.5 px-2 py-1 rounded-md hover:bg-accent/50 transition-colors text-muted-foreground hover:text-foreground"
        >
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
                <span>{providerNames[agent.providerId] || agent.providerId}</span>
                {agent.version && (
                  <span className="text-muted-foreground ml-2">v{agent.version}</span>
                )}
              </button>
            ))}
          </div>
        )}
      </div>
      {projectPath && (
        <span className="text-muted-foreground truncate">{projectPath.replace(/^\/Users\/[^/]+\//, '~/')}</span>
      )}
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
                  {messagesList}
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
            <div className={cn("h-full flex flex-col", embedded ? "px-3" : "max-w-6xl mx-auto px-6")}>
              {projectPathInput}
              {messagesList}
              
              {isLoading && messages.length === 0 && (
                <div className="flex items-center justify-center h-full">
                  <div className="flex items-center gap-3">
                    <div className="rotating-symbol text-primary" />
                    <span className="text-sm text-muted-foreground">
                      {session ? "Loading session history..." : "Initializing Claude Code..."}
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
            {queuedPrompts.length > 0 && !hideFloatingGlobalControls && (
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
          {displayableMessages.length > 5 && !hideFloatingGlobalControls && (
            <motion.div
              initial={{ opacity: 0, scale: 0.8 }}
              animate={{ opacity: 1, scale: 1 }}
              exit={{ opacity: 0, scale: 0.8 }}
              transition={{ delay: 0.5 }}
              className={cn(
                embedded ? "absolute bottom-28 right-4 z-40" : "fixed bottom-32 right-6 z-50"
              )}
            >
              <div className="flex items-center bg-background/95 backdrop-blur-md border rounded-full shadow-lg overflow-hidden">
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
                      className="px-3 py-2 hover:bg-accent rounded-none"
                    >
                      <ChevronUp className="h-4 w-4" />
                    </Button>
                  </motion.div>
                </TooltipSimple>
                <div className="w-px h-4 bg-border" />
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
                      className="px-3 py-2 hover:bg-accent rounded-none"
                    >
                      <ChevronDown className="h-4 w-4" />
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
                          className="h-9 w-9 text-muted-foreground hover:text-foreground"
                        >
                          <GitBranch className={cn("h-3.5 w-3.5", showTimeline && "text-primary")} />
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
                              className="h-9 w-9 text-muted-foreground hover:text-foreground"
                            >
                              <Copy className="h-3.5 w-3.5" />
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
                        className="h-8 w-8 text-muted-foreground hover:text-foreground"
                      >
                        <Wrench className={cn("h-3.5 w-3.5", showSettings && "text-primary")} />
                      </Button>
                    </motion.div>
                  </TooltipSimple>
                </>
              }
            />
          </div>

          {/* Token Counter - positioned under the Send button */}
          {totalTokens > 0 && !hideFloatingGlobalControls && (
            <div className={cn(
              embedded ? "absolute bottom-0 left-0 right-0 z-30 pointer-events-none" : "fixed bottom-0 left-0 right-0 z-30 pointer-events-none"
            )}>
              <div className="max-w-6xl mx-auto">
                <div className="flex justify-end px-4 pb-2">
                  <motion.div
                    initial={{ opacity: 0, scale: 0.8 }}
                    animate={{ opacity: 1, scale: 1 }}
                    exit={{ opacity: 0, scale: 0.8 }}
                    className="bg-background/95 backdrop-blur-md border rounded-full px-3 py-1 shadow-lg pointer-events-auto"
                  >
                    <div className="flex items-center gap-1.5 text-xs">
                      <Hash className="h-3 w-3 text-muted-foreground" />
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

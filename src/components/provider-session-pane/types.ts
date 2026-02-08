import type { Session } from "@/lib/api";
import type { PromptSendOptions } from "@/components/FloatingPromptInput";

export interface ProviderSessionPaneProps {
  session?: Session;
  initialProjectPath?: string;
  onBack?: () => void;
  onProjectSettings?: (projectPath: string) => void;
  className?: string;
  onStreamingChange?: (isStreaming: boolean, sessionId: string | null) => void;
  onProjectPathChange?: (path: string) => void;
  providerId?: string;
  onProviderChange?: (providerId: string) => void;
  onSessionResolved?: (session: Session) => void;
  embedded?: boolean;
  paneId?: string;
  workspaceId?: string;
  terminalTabId?: string;
  embeddedTerminalId?: string;
  onEmbeddedTerminalIdChange?: (terminalId: string | undefined) => void;
  isPaneVisible?: boolean;
  isPaneActive?: boolean;
  resumeSessionId?: string;
  persistentTerminalSessionId?: string;
  restorePreference?: "resume_latest" | "start_fresh";
  onRestorePreferenceChange?: (value: "resume_latest" | "start_fresh") => void;
  onResumeSessionIdChange?: (sessionId: string | undefined) => void;
  currentTerminalTitle?: string;
  isTerminalTitleLocked?: boolean;
  onAutoRenameTerminalTitle?: (title: string) => void;
  hideProjectBar?: boolean;
  hideFloatingGlobalControls?: boolean;
  previewMode?: "split" | "slideover";
}

export interface QueuedPrompt {
  id: string;
  prompt: string;
  model: string;
  providerId: string;
  reasoningEffort?: PromptSendOptions["reasoningEffort"];
}

export interface DetectedProvider {
  providerId: string;
  binaryPath: string;
  version: string | null;
  source: string;
}

export type ProviderSessionCompletionStatus = "success" | "error" | "cancelled";

export interface ProviderSessionCompletionPayload {
  status: ProviderSessionCompletionStatus;
  success: boolean;
  error?: string;
  sessionId?: string;
  providerId?: string;
}

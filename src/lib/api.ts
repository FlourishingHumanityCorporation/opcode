import { apiCall } from './apiAdapter';
import type { HooksConfiguration } from '@/types/hooks';
import { logger } from '@/lib/logger';

/** Process type for tracking in ProcessRegistry */
export type ProcessType = 
  | { AgentRun: { agent_id: number; agent_name: string } }
  | { ProviderSession: { session_id: string } };

/** Information about a running process */
export interface ProcessInfo {
  run_id: number;
  process_type: ProcessType;
  pid: number;
  started_at: string;
  project_path: string;
  task: string;
  model: string;
}

/**
 * Represents a project in the ~/.claude/projects directory
 */
export interface Project {
  /** The project ID (derived from the directory name) */
  id: string;
  /** The original project path (decoded from the directory name) */
  path: string;
  /** List of session IDs (JSONL file names without extension) */
  sessions: string[];
  /** Unix timestamp when the project directory was created */
  created_at: number;
  /** Unix timestamp of the most recent session (if any) */
  most_recent_session?: number;
}

/**
 * Represents a session with its metadata
 */
export interface Session {
  /** The session ID (UUID) */
  id: string;
  /** The project ID this session belongs to */
  project_id: string;
  /** The project path */
  project_path: string;
  /** Optional todo data associated with this session */
  todo_data?: any;
  /** Unix timestamp when the session file was created */
  created_at: number;
  /** First user message content (if available) */
  first_message?: string;
  /** Timestamp of the first user message (if available) */
  message_timestamp?: string;
}

/**
 * Represents the settings from ~/.claude/settings.json
 */
export interface ClaudeSettings {
  [key: string]: any;
}

/**
 * Represents the Claude Code version status
 */
export interface ClaudeVersionStatus {
  /** Whether Claude Code is installed and working */
  is_installed: boolean;
  /** The version string if available */
  version?: string;
  /** The full output from the command */
  output: string;
}

/**
 * Represents a CLAUDE.md file found in the project
 */
export interface ClaudeMdFile {
  /** Relative path from the project root */
  relative_path: string;
  /** Absolute path to the file */
  absolute_path: string;
  /** File size in bytes */
  size: number;
  /** Last modified timestamp */
  modified: number;
}

/**
 * Represents a file or directory entry
 */
export interface FileEntry {
  name: string;
  path: string;
  is_directory: boolean;
  size: number;
  extension?: string;
}

/**
 * Represents a Claude installation found on the system
 */
export interface ClaudeInstallation {
  /** Full path to the Claude binary */
  path: string;
  /** Version string if available */
  version?: string;
  /** Source of discovery (e.g., "nvm", "system", "homebrew", "which") */
  source: string;
  /** Type of installation */
  installation_type: "System" | "Custom";
}

// Agent API types
export interface Agent {
  id?: number;
  name: string;
  icon: string;
  system_prompt: string;
  default_task?: string;
  provider_id: string;
  model: string;
  hooks?: string; // JSON string of HooksConfiguration
  created_at: string;
  updated_at: string;
}

export interface AgentExport {
  version: number;
  exported_at: string;
  agent: {
    name: string;
    icon: string;
    system_prompt: string;
    default_task?: string;
    provider_id?: string;
    model: string;
    hooks?: string;
  };
}

export interface GitHubAgentFile {
  name: string;
  path: string;
  download_url: string;
  size: number;
  sha: string;
}

export interface AgentRun {
  id?: number;
  agent_id: number;
  agent_name: string;
  agent_icon: string;
  provider_id: string;
  task: string;
  model: string;
  project_path: string;
  session_id: string;
  output?: string;
  status: string; // 'pending', 'running', 'completed', 'failed', 'cancelled'
  pid?: number;
  process_started_at?: string;
  created_at: string;
  completed_at?: string;
}

export interface AgentRunMetrics {
  duration_ms?: number;
  total_tokens?: number;
  cost_usd?: number;
  message_count?: number;
}

export interface AgentRunWithMetrics {
  id?: number;
  agent_id: number;
  agent_name: string;
  agent_icon: string;
  provider_id: string;
  task: string;
  model: string;
  project_path: string;
  session_id: string;
  status: string; // 'pending', 'running', 'completed', 'failed', 'cancelled'
  pid?: number;
  duration_ms?: number;
  total_tokens?: number;
  process_started_at?: string;
  created_at: string;
  completed_at?: string;
  metrics?: AgentRunMetrics;
  output?: string; // Real-time JSONL content
}

export interface ProviderRuntimeStatus {
  provider_id: string;
  installed: boolean;
  auth_ready: boolean;
  ready: boolean;
  detected_binary?: string;
  detected_version?: string;
  issues: string[];
  setup_hints: string[];
}

export interface ProviderCapability {
  provider_id: string;
  supports_continue: boolean;
  supports_resume: boolean;
  supports_reasoning_effort: boolean;
  model_strategy: string;
}

export interface SessionStartupProbeResult {
  benchmark_kind: "startup" | "assistant" | "assistant_iterm";
  provider_id: string;
  project_path: string;
  model: string;
  timeout_ms: number;
  timed_out: boolean;
  total_ms: number;
  first_stdout_ms?: number | null;
  first_stderr_ms?: number | null;
  first_byte_ms?: number | null;
  first_json_event_ms?: number | null;
  first_assistant_message_ms?: number | null;
  first_result_message_ms?: number | null;
  stdout_json_lines: number;
  stdout_parse_errors: number;
  stdout_bytes: number;
  stderr_bytes: number;
  exit_code?: number | null;
  signal?: number | null;
}

export interface StartEmbeddedTerminalResult {
  terminalId: string;
  reusedExistingSession: boolean;
}

export interface EmbeddedTerminalDebugSession {
  terminalId: string;
  persistentSessionId?: string | null;
  alive: boolean;
  createdAtMs: number;
  lastInputWriteMs?: number | null;
  lastResizeMs?: number | null;
  lastReadOutputMs?: number | null;
  lastReadErr?: string | null;
  lastWriteErr?: string | null;
  lastExitReason?: string | null;
}

export interface EmbeddedTerminalDebugSnapshot {
  capturedAtMs: number;
  sessionCount: number;
  sessions: EmbeddedTerminalDebugSession[];
}

export interface MobileSyncStatus {
  version: number;
  enabled: boolean;
  bindHost: string;
  publicHost: string;
  port: number;
  baseUrl: string;
  wsUrl: string;
  tailscaleIp?: string | null;
  connectedClients: number;
  sequence: number;
}

export interface MobileSyncPairingPayload {
  version: number;
  pairCode: string;
  host: string;
  port: number;
  expiresAt: string;
}

export interface MobileSyncDevice {
  id: string;
  deviceName: string;
  createdAt: string;
  lastSeenAt?: string | null;
  revoked: boolean;
}

export interface MobileSyncPublishEventInput {
  eventType: string;
  payload: any;
}

export interface GenerateLocalTerminalTitleInput {
  transcript: string;
  model?: string;
}

// Usage Dashboard types
export interface UsageEntry {
  timestamp: string;
  model: string;
  input_tokens: number;
  output_tokens: number;
  cache_creation_tokens: number;
  cache_read_tokens: number;
  cost: number;
  session_id: string;
  project_path: string;
}

export interface ModelUsage {
  model: string;
  total_cost: number;
  total_tokens: number;
  input_tokens: number;
  output_tokens: number;
  cache_creation_tokens: number;
  cache_read_tokens: number;
  session_count: number;
}

export interface DailyUsage {
  date: string;
  total_cost: number;
  total_tokens: number;
  models_used: string[];
}

export interface ProjectUsage {
  project_path: string;
  project_name: string;
  total_cost: number;
  total_tokens: number;
  session_count: number;
  last_used: string;
}

export interface UsageStats {
  total_cost: number;
  total_tokens: number;
  total_input_tokens: number;
  total_output_tokens: number;
  total_cache_creation_tokens: number;
  total_cache_read_tokens: number;
  total_sessions: number;
  by_model: ModelUsage[];
  by_date: DailyUsage[];
  by_project: ProjectUsage[];
}

export interface UsageIndexStatus {
  state: 'idle' | 'indexing' | 'error';
  started_at?: string;
  last_completed_at?: string;
  last_error?: string;
  files_total: number;
  files_processed: number;
  lines_processed: number;
  entries_indexed: number;
  current_file?: string;
  cancelled: boolean;
}

/**
 * Represents a checkpoint in the session timeline
 */
export interface Checkpoint {
  id: string;
  sessionId: string;
  projectId: string;
  messageIndex: number;
  timestamp: string;
  description?: string;
  parentCheckpointId?: string;
  metadata: CheckpointMetadata;
}

/**
 * Metadata associated with a checkpoint
 */
export interface CheckpointMetadata {
  totalTokens: number;
  modelUsed: string;
  userPrompt: string;
  fileChanges: number;
  snapshotSize: number;
}

/**
 * Represents a file snapshot at a checkpoint
 */
export interface FileSnapshot {
  checkpointId: string;
  filePath: string;
  content: string;
  hash: string;
  isDeleted: boolean;
  permissions?: number;
  size: number;
}

/**
 * Represents a node in the timeline tree
 */
export interface TimelineNode {
  checkpoint: Checkpoint;
  children: TimelineNode[];
  fileSnapshotIds: string[];
}

/**
 * The complete timeline for a session
 */
export interface SessionTimeline {
  sessionId: string;
  rootNode?: TimelineNode;
  currentCheckpointId?: string;
  autoCheckpointEnabled: boolean;
  checkpointStrategy: CheckpointStrategy;
  totalCheckpoints: number;
}

/**
 * Strategy for automatic checkpoint creation
 */
export type CheckpointStrategy = 'manual' | 'per_prompt' | 'per_tool_use' | 'smart';

/**
 * Result of a checkpoint operation
 */
export interface CheckpointResult {
  checkpoint: Checkpoint;
  filesProcessed: number;
  warnings: string[];
}

/**
 * Diff between two checkpoints
 */
export interface CheckpointDiff {
  fromCheckpointId: string;
  toCheckpointId: string;
  modifiedFiles: FileDiff[];
  addedFiles: string[];
  deletedFiles: string[];
  tokenDelta: number;
}

/**
 * Diff for a single file
 */
export interface FileDiff {
  path: string;
  additions: number;
  deletions: number;
  diffContent?: string;
}

/**
 * Represents an MCP server configuration
 */
export interface MCPServer {
  /** Server name/identifier */
  name: string;
  /** Transport type: "stdio" or "sse" */
  transport: string;
  /** Command to execute (for stdio) */
  command?: string;
  /** Command arguments (for stdio) */
  args: string[];
  /** Environment variables */
  env: Record<string, string>;
  /** URL endpoint (for SSE) */
  url?: string;
  /** Configuration scope: "local", "project", or "user" */
  scope: string;
  /** Whether the server is currently active */
  is_active: boolean;
  /** Server status */
  status: ServerStatus;
}

/**
 * Server status information
 */
export interface ServerStatus {
  /** Whether the server is running */
  running: boolean;
  /** Last error message if any */
  error?: string;
  /** Last checked timestamp */
  last_checked?: number;
}

/**
 * MCP configuration for project scope (.mcp.json)
 */
export interface MCPProjectConfig {
  mcpServers: Record<string, MCPServerConfig>;
}

/**
 * Individual server configuration in .mcp.json
 */
export interface MCPServerConfig {
  command: string;
  args: string[];
  env: Record<string, string>;
}

/**
 * Represents a custom slash command
 */
export interface SlashCommand {
  /** Unique identifier for the command */
  id: string;
  /** Command name (without prefix) */
  name: string;
  /** Full command with prefix (e.g., "/project:optimize") */
  full_command: string;
  /** Command scope: "project" or "user" */
  scope: string;
  /** Optional namespace (e.g., "frontend" in "/project:frontend:component") */
  namespace?: string;
  /** Path to the markdown file */
  file_path: string;
  /** Command content (markdown body) */
  content: string;
  /** Optional description from frontmatter */
  description?: string;
  /** Allowed tools from frontmatter */
  allowed_tools: string[];
  /** Whether the command has bash commands (!) */
  has_bash_commands: boolean;
  /** Whether the command has file references (@) */
  has_file_references: boolean;
  /** Whether the command uses $ARGUMENTS placeholder */
  accepts_arguments: boolean;
}

/**
 * Result of adding a server
 */
export interface AddServerResult {
  success: boolean;
  message: string;
  server_name?: string;
}

/**
 * Import result for multiple servers
 */
export interface ImportResult {
  imported_count: number;
  failed_count: number;
  servers: ImportServerResult[];
}

/**
 * Result for individual server import
 */
export interface ImportServerResult {
  name: string;
  success: boolean;
  error?: string;
}

/**
 * API client for interacting with the Rust backend
 */
export const api = {
  /**
   * Gets the user's home directory path
   * @returns Promise resolving to the home directory path
   */
  async getHomeDirectory(): Promise<string> {
    try {
      return await apiCall<string>("get_home_directory");
    } catch (error) {
      logger.error("ipc", "Failed to get home directory", { error });
      return "/";
    }
  },

  /**
   * Lists all projects in the ~/.claude/projects directory
   * @returns Promise resolving to an array of projects
   */
  async listProjects(): Promise<Project[]> {
    try {
      return await apiCall<Project[]>("list_projects");
    } catch (error) {
      logger.error("ipc", "Failed to list projects", { error });
      throw error;
    }
  },

  /**
   * Creates a new project for the given directory path
   * @param path - The directory path to create a project for
   * @returns Promise resolving to the created project
   */
  async createProject(path: string): Promise<Project> {
    try {
      return await apiCall<Project>('create_project', { path });
    } catch (error) {
      logger.error("ipc", "Failed to create project", { error });
      throw error;
    }
  },

  /**
   * Retrieves sessions for a specific project
   * @param projectId - The ID of the project to retrieve sessions for
   * @returns Promise resolving to an array of sessions
   */
  async getProjectSessions(projectId: string): Promise<Session[]> {
    try {
      return await apiCall<Session[]>('get_project_sessions', { projectId });
    } catch (error) {
      logger.error("ipc", "Failed to get project sessions", { error });
      throw error;
    }
  },

  /**
   * Fetch list of agents from GitHub repository
   * @returns Promise resolving to list of available agents on GitHub
   */
  async fetchGitHubAgents(): Promise<GitHubAgentFile[]> {
    try {
      return await apiCall<GitHubAgentFile[]>('fetch_github_agents');
    } catch (error) {
      logger.error("ipc", "Failed to fetch GitHub agents", { error });
      throw error;
    }
  },

  /**
   * Fetch and preview a specific agent from GitHub
   * @param downloadUrl - The download URL for the agent file
   * @returns Promise resolving to the agent export data
   */
  async fetchGitHubAgentContent(downloadUrl: string): Promise<AgentExport> {
    try {
      return await apiCall<AgentExport>('fetch_github_agent_content', { downloadUrl });
    } catch (error) {
      logger.error("ipc", "Failed to fetch GitHub agent content", { error });
      throw error;
    }
  },

  /**
   * Import an agent directly from GitHub
   * @param downloadUrl - The download URL for the agent file
   * @returns Promise resolving to the imported agent
   */
  async importAgentFromGitHub(downloadUrl: string): Promise<Agent> {
    try {
      return await apiCall<Agent>('import_agent_from_github', { downloadUrl });
    } catch (error) {
      logger.error("ipc", "Failed to import agent from GitHub", { error });
      throw error;
    }
  },

  /**
   * Reads the Claude settings file
   * @returns Promise resolving to the settings object
   */
  async getClaudeSettings(): Promise<ClaudeSettings> {
    try {
      const result = await apiCall<{ data: ClaudeSettings }>("get_claude_settings");
      logger.debug("ipc", "Raw result from get_claude_settings", { result });
      
      // The Rust backend returns ClaudeSettings { data: ... }
      // We need to extract the data field
      if (result && typeof result === 'object' && 'data' in result) {
        return result.data;
      }
      
      // If the result is already the settings object, return it
      return result as ClaudeSettings;
    } catch (error) {
      logger.error("ipc", "Failed to get Claude settings", { error });
      throw error;
    }
  },

  /**
   * Opens a new provider session
   * @param path - Optional path to open the session in
   * @returns Promise resolving when the session is opened
   */
  async openProviderSession(path?: string): Promise<string> {
    try {
      return await apiCall<string>("open_provider_session", { path });
    } catch (error) {
      logger.error("ipc", "Failed to open new session", { error });
      throw error;
    }
  },

  /**
   * Reads the CLAUDE.md system prompt file
   * @returns Promise resolving to the system prompt content
   */
  async getSystemPrompt(): Promise<string> {
    try {
      return await apiCall<string>("get_system_prompt");
    } catch (error) {
      logger.error("ipc", "Failed to get system prompt", { error });
      throw error;
    }
  },

  /**
   * Checks if Claude Code is installed and gets its version
   * @returns Promise resolving to the version status
   */
  async checkClaudeVersion(): Promise<ClaudeVersionStatus> {
    try {
      return await apiCall<ClaudeVersionStatus>("check_claude_version");
    } catch (error) {
      logger.error("ipc", "Failed to check Claude version", { error });
      throw error;
    }
  },

  /**
   * Saves the CLAUDE.md system prompt file
   * @param content - The new content for the system prompt
   * @returns Promise resolving when the file is saved
   */
  async saveSystemPrompt(content: string): Promise<string> {
    try {
      return await apiCall<string>("save_system_prompt", { content });
    } catch (error) {
      logger.error("ipc", "Failed to save system prompt", { error });
      throw error;
    }
  },

  /**
   * Saves the Claude settings file
   * @param settings - The settings object to save
   * @returns Promise resolving when the settings are saved
   */
  async saveClaudeSettings(settings: ClaudeSettings): Promise<string> {
    try {
      return await apiCall<string>("save_claude_settings", { settings });
    } catch (error) {
      logger.error("ipc", "Failed to save Claude settings", { error });
      throw error;
    }
  },

  /**
   * Finds all CLAUDE.md files in a project directory
   * @param projectPath - The absolute path to the project
   * @returns Promise resolving to an array of CLAUDE.md files
   */
  async findClaudeMdFiles(projectPath: string): Promise<ClaudeMdFile[]> {
    try {
      return await apiCall<ClaudeMdFile[]>("find_claude_md_files", { projectPath });
    } catch (error) {
      logger.error("ipc", "Failed to find CLAUDE.md files", { error });
      throw error;
    }
  },

  /**
   * Reads a specific CLAUDE.md file
   * @param filePath - The absolute path to the file
   * @returns Promise resolving to the file content
   */
  async readClaudeMdFile(filePath: string): Promise<string> {
    try {
      return await apiCall<string>("read_claude_md_file", { filePath });
    } catch (error) {
      logger.error("ipc", "Failed to read CLAUDE.md file", { error });
      throw error;
    }
  },

  /**
   * Saves a specific CLAUDE.md file
   * @param filePath - The absolute path to the file
   * @param content - The new content for the file
   * @returns Promise resolving when the file is saved
   */
  async saveClaudeMdFile(filePath: string, content: string): Promise<string> {
    try {
      return await apiCall<string>("save_claude_md_file", { filePath, content });
    } catch (error) {
      logger.error("ipc", "Failed to save CLAUDE.md file", { error });
      throw error;
    }
  },

  /**
   * Saves a pasted clipboard image into the active project and returns a relative path.
   */
  async saveClipboardImageAttachment(projectPath: string, dataUrl: string): Promise<string> {
    try {
      return await apiCall<string>("save_clipboard_image_attachment", { projectPath, dataUrl });
    } catch (error) {
      logger.error("ipc", "Failed to save clipboard image attachment", { error });
      throw error;
    }
  },

  // Agent API methods
  
  /**
   * Lists all CC agents
   * @returns Promise resolving to an array of agents
   */
  async listAgents(): Promise<Agent[]> {
    try {
      return await apiCall<Agent[]>('list_agents');
    } catch (error) {
      logger.error("ipc", "Failed to list agents", { error });
      throw error;
    }
  },

  /**
   * Creates a new agent
   * @param name - The agent name
   * @param icon - The icon identifier
   * @param system_prompt - The system prompt for the agent
   * @param default_task - Optional default task
   * @param model - Optional model (provider-specific default when omitted)
   * @param hooks - Optional hooks configuration as JSON string
   * @returns Promise resolving to the created agent
   */
  async createAgent(
    name: string, 
    icon: string, 
    system_prompt: string, 
    default_task?: string, 
    providerId?: string,
    model?: string,
    hooks?: string
  ): Promise<Agent> {
    try {
      return await apiCall<Agent>('create_agent', { 
        name, 
        icon, 
        systemPrompt: system_prompt,
        defaultTask: default_task,
        providerId,
        model,
        hooks
      });
    } catch (error) {
      logger.error("ipc", "Failed to create agent", { error });
      throw error;
    }
  },

  /**
   * Updates an existing agent
   * @param id - The agent ID
   * @param name - The updated name
   * @param icon - The updated icon
   * @param system_prompt - The updated system prompt
   * @param default_task - Optional default task
   * @param model - Optional model
   * @param hooks - Optional hooks configuration as JSON string
   * @returns Promise resolving to the updated agent
   */
  async updateAgent(
    id: number, 
    name: string, 
    icon: string, 
    system_prompt: string, 
    default_task?: string, 
    providerId?: string,
    model?: string,
    hooks?: string
  ): Promise<Agent> {
    try {
      return await apiCall<Agent>('update_agent', { 
        id, 
        name, 
        icon, 
        systemPrompt: system_prompt,
        defaultTask: default_task,
        providerId,
        model,
        hooks
      });
    } catch (error) {
      logger.error("ipc", "Failed to update agent", { error });
      throw error;
    }
  },

  /**
   * Deletes an agent
   * @param id - The agent ID to delete
   * @returns Promise resolving when the agent is deleted
   */
  async deleteAgent(id: number): Promise<void> {
    try {
      return await apiCall('delete_agent', { id });
    } catch (error) {
      logger.error("ipc", "Failed to delete agent", { error });
      throw error;
    }
  },

  /**
   * Gets a single agent by ID
   * @param id - The agent ID
   * @returns Promise resolving to the agent
   */
  async getAgent(id: number): Promise<Agent> {
    try {
      return await apiCall<Agent>('get_agent', { id });
    } catch (error) {
      logger.error("ipc", "Failed to get agent", { error });
      throw error;
    }
  },

  /**
   * Exports a single agent to JSON format
   * @param id - The agent ID to export
   * @returns Promise resolving to the JSON string
   */
  async exportAgent(id: number): Promise<string> {
    try {
      return await apiCall<string>('export_agent', { id });
    } catch (error) {
      logger.error("ipc", "Failed to export agent", { error });
      throw error;
    }
  },

  /**
   * Imports an agent from JSON data
   * @param jsonData - The JSON string containing the agent export
   * @returns Promise resolving to the imported agent
   */
  async importAgent(jsonData: string): Promise<Agent> {
    try {
      return await apiCall<Agent>('import_agent', { jsonData });
    } catch (error) {
      logger.error("ipc", "Failed to import agent", { error });
      throw error;
    }
  },

  /**
   * Imports an agent from a file
   * @param filePath - The path to the JSON file
   * @returns Promise resolving to the imported agent
   */
  async importAgentFromFile(filePath: string): Promise<Agent> {
    try {
      return await apiCall<Agent>('import_agent_from_file', { filePath });
    } catch (error) {
      logger.error("ipc", "Failed to import agent from file", { error });
      throw error;
    }
  },

  /**
   * Executes an agent
   * @param agentId - The agent ID to execute
   * @param projectPath - The project path to run the agent in
   * @param task - The task description
   * @param model - Optional model override
   * @returns Promise resolving to the run ID when execution starts
   */
  async executeAgent(
    agentId: number,
    projectPath: string,
    task: string,
    model?: string,
    reasoningEffort?: string
  ): Promise<number> {
    try {
      return await apiCall<number>('execute_agent', {
        agentId,
        projectPath,
        task,
        model,
        reasoningEffort,
      });
    } catch (error) {
      logger.error("ipc", "Failed to execute agent", { error });
      // Return a sentinel value to indicate error
      throw new Error(`Failed to execute agent: ${error instanceof Error ? error.message : 'Unknown error'}`);
    }
  },

  /**
   * Lists agent runs without metrics (basic info only)
   * @param agentId - Optional agent ID to filter runs
   * @returns Promise resolving to an array of agent runs
   */
  async listAgentRuns(agentId?: number): Promise<AgentRunWithMetrics[]> {
    try {
      return await apiCall<AgentRunWithMetrics[]>('list_agent_runs', { agentId });
    } catch (error) {
      logger.error("ipc", "Failed to list agent runs", { error });
      // Return empty array instead of throwing to prevent UI crashes
      return [];
    }
  },

  /**
   * Lists agent runs with metrics (includes token counts and duration)
   * @param agentId - Optional agent ID to filter runs
   * @returns Promise resolving to an array of agent runs with metrics
   */
  async listAgentRunsWithMetrics(agentId?: number): Promise<AgentRunWithMetrics[]> {
    try {
      return await apiCall<AgentRunWithMetrics[]>('list_agent_runs_with_metrics', { agentId });
    } catch (error) {
      logger.error("ipc", "Failed to list agent runs with metrics", { error });
      // Return empty array instead of throwing to prevent UI crashes
      return [];
    }
  },

  /**
   * Gets a single agent run by ID with metrics
   * @param id - The run ID
   * @returns Promise resolving to the agent run with metrics
   */
  async getAgentRun(id: number): Promise<AgentRunWithMetrics> {
    try {
      return await apiCall<AgentRunWithMetrics>('get_agent_run', { id });
    } catch (error) {
      logger.error("ipc", "Failed to get agent run", { error });
      throw new Error(`Failed to get agent run: ${error instanceof Error ? error.message : 'Unknown error'}`);
    }
  },

  /**
   * Gets a single agent run by ID with real-time metrics from JSONL
   * @param id - The run ID
   * @returns Promise resolving to the agent run with metrics
   */
  async getAgentRunWithRealTimeMetrics(id: number): Promise<AgentRunWithMetrics> {
    try {
      return await apiCall<AgentRunWithMetrics>('get_agent_run_with_real_time_metrics', { id });
    } catch (error) {
      logger.error("ipc", "Failed to get agent run with real-time metrics", { error });
      throw new Error(`Failed to get agent run with real-time metrics: ${error instanceof Error ? error.message : 'Unknown error'}`);
    }
  },

  /**
   * Lists all currently running agent sessions
   * @returns Promise resolving to list of running agent sessions
   */
  async listRunningAgentSessions(): Promise<AgentRun[]> {
    try {
      return await apiCall<AgentRun[]>('list_running_sessions');
    } catch (error) {
      logger.error("ipc", "Failed to list running agent sessions", { error });
      throw new Error(`Failed to list running agent sessions: ${error instanceof Error ? error.message : 'Unknown error'}`);
    }
  },

  /**
   * Kills a running agent session
   * @param runId - The run ID to kill
   * @returns Promise resolving to whether the session was successfully killed
   */
  async killAgentSession(runId: number): Promise<boolean> {
    try {
      return await apiCall<boolean>('kill_agent_session', { runId });
    } catch (error) {
      logger.error("ipc", "Failed to kill agent session", { error });
      throw new Error(`Failed to kill agent session: ${error instanceof Error ? error.message : 'Unknown error'}`);
    }
  },

  /**
   * Gets the status of a specific agent session
   * @param runId - The run ID to check
   * @returns Promise resolving to the session status or null if not found
   */
  async getSessionStatus(runId: number): Promise<string | null> {
    try {
      return await apiCall<string | null>('get_session_status', { runId });
    } catch (error) {
      logger.error("ipc", "Failed to get session status", { error });
      throw new Error(`Failed to get session status: ${error instanceof Error ? error.message : 'Unknown error'}`);
    }
  },

  /**
   * Cleanup finished processes and update their status
   * @returns Promise resolving to list of run IDs that were cleaned up
   */
  async cleanupFinishedProcesses(): Promise<number[]> {
    try {
      return await apiCall<number[]>('cleanup_finished_processes');
    } catch (error) {
      logger.error("ipc", "Failed to cleanup finished processes", { error });
      throw new Error(`Failed to cleanup finished processes: ${error instanceof Error ? error.message : 'Unknown error'}`);
    }
  },

  /**
   * Get real-time output for a running session (with live output fallback)
   * @param runId - The run ID to get output for
   * @returns Promise resolving to the current session output (JSONL format)
   */
  async getSessionOutput(runId: number): Promise<string> {
    try {
      return await apiCall<string>('get_session_output', { runId });
    } catch (error) {
      logger.error("ipc", "Failed to get session output", { error });
      throw new Error(`Failed to get session output: ${error instanceof Error ? error.message : 'Unknown error'}`);
    }
  },

  /**
   * Get live output directly from process stdout buffer
   * @param runId - The run ID to get live output for
   * @returns Promise resolving to the current live output
   */
  async getLiveSessionOutput(runId: number): Promise<string> {
    try {
      return await apiCall<string>('get_live_session_output', { runId });
    } catch (error) {
      logger.error("ipc", "Failed to get live session output", { error });
      throw new Error(`Failed to get live session output: ${error instanceof Error ? error.message : 'Unknown error'}`);
    }
  },

  /**
   * Start streaming real-time output for a running session
   * @param runId - The run ID to stream output for
   * @returns Promise that resolves when streaming starts
   */
  async streamSessionOutput(runId: number): Promise<void> {
    try {
      return await apiCall<void>('stream_session_output', { runId });
    } catch (error) {
      logger.error("ipc", "Failed to start streaming session output", { error });
      throw new Error(`Failed to start streaming session output: ${error instanceof Error ? error.message : 'Unknown error'}`);
    }
  },

  /**
   * Loads the JSONL history for a specific session
   */
  async loadProviderSessionHistory(sessionId: string, projectId: string): Promise<any[]> {
    return apiCall("load_provider_session_history", { sessionId, projectId });
  },

  /**
   * Loads the JSONL history for a specific agent session
   * Similar to loadProviderSessionHistory but searches across all project directories
   * @param sessionId - The session ID (UUID)
   * @returns Promise resolving to array of session messages
   */
  async loadAgentSessionHistory(sessionId: string): Promise<any[]> {
    try {
      return await apiCall<any[]>('load_agent_session_history', { sessionId });
    } catch (error) {
      logger.error("ipc", "Failed to load agent session history", { error });
      throw error;
    }
  },

  /**
   * Executes a new interactive provider session with streaming output
   */
  async executeProviderSession(projectPath: string, prompt: string, model: string): Promise<void> {
    return apiCall("execute_provider_session", { projectPath, prompt, model });
  },

  /**
   * Continues an existing provider conversation with streaming output
   */
  async continueProviderSession(projectPath: string, prompt: string, model: string): Promise<void> {
    return apiCall("continue_provider_session", { projectPath, prompt, model });
  },

  /**
   * Resumes an existing provider session by ID with streaming output
   */
  async resumeProviderSession(projectPath: string, sessionId: string, prompt: string, model: string): Promise<void> {
    return apiCall("resume_provider_session", { projectPath, sessionId, prompt, model });
  },

  /**
   * Cancels the currently running provider session execution
   * @param sessionId - Optional session ID to cancel a specific session
   */
  async cancelProviderSession(sessionId?: string): Promise<void> {
    return apiCall("cancel_provider_session", { sessionId });
  },

  /**
   * Lists all currently running provider sessions
   * @returns Promise resolving to list of running provider sessions
   */
  async listRunningProviderSessions(): Promise<any[]> {
    return apiCall("list_running_provider_sessions");
  },

  /**
   * Gets live output from a provider session
   * @param sessionId - The session ID to get output for
   * @returns Promise resolving to the current live output
   */
  async getProviderSessionOutput(sessionId: string): Promise<string> {
    return apiCall("get_provider_session_output", { sessionId });
  },

  // ─── Multi-Provider Agent API ─────────────────────────────────────────

  /**
   * Lists all detected CLI coding agents on the system
   */
  async listDetectedAgents(): Promise<any[]> {
    return apiCall("list_detected_agents");
  },

  /**
   * Checks whether a provider is ready to run (binary + auth prerequisites).
   */
  async checkProviderRuntime(providerId: string): Promise<ProviderRuntimeStatus> {
    return apiCall("check_provider_runtime", { providerId });
  },

  /**
   * Lists provider runtime capabilities used by the provider-session UI.
   */
  async listProviderCapabilities(): Promise<ProviderCapability[]> {
    return apiCall("list_provider_capabilities");
  },

  async mobileSyncGetStatus(): Promise<MobileSyncStatus> {
    return apiCall("mobile_sync_get_status");
  },

  async mobileSyncSetEnabled(enabled: boolean): Promise<MobileSyncStatus> {
    return apiCall("mobile_sync_set_enabled", { enabled });
  },

  async mobileSyncSetPublicHost(publicHost: string): Promise<MobileSyncStatus> {
    return apiCall("mobile_sync_set_public_host", { publicHost });
  },

  async mobileSyncPublishSnapshot(snapshotState: Record<string, any>): Promise<void> {
    await apiCall("mobile_sync_publish_snapshot", { snapshotState });
  },

  async mobileSyncPublishEvents(events: MobileSyncPublishEventInput[]): Promise<void> {
    await apiCall("mobile_sync_publish_events", { events });
  },

  async mobileSyncStartPairing(): Promise<MobileSyncPairingPayload> {
    return apiCall("mobile_sync_start_pairing");
  },

  async mobileSyncListDevices(): Promise<MobileSyncDevice[]> {
    return apiCall("mobile_sync_list_devices");
  },

  async mobileSyncRevokeDevice(deviceId: string): Promise<void> {
    await apiCall("mobile_sync_revoke_device", { deviceId });
  },

  /**
   * Starts desktop-side file watcher for automatic hot refresh.
   */
  async hotRefreshStart(paths: string[]): Promise<void> {
    await apiCall("hot_refresh_start", { paths });
  },

  /**
   * Stops desktop-side file watcher for automatic hot refresh.
   */
  async hotRefreshStop(): Promise<void> {
    await apiCall("hot_refresh_stop");
  },

  /**
   * Updates desktop-side file watcher paths for automatic hot refresh.
   */
  async hotRefreshUpdatePaths(paths: string[]): Promise<void> {
    await apiCall("hot_refresh_update_paths", { paths });
  },

  /**
   * Runs a real Claude startup probe and returns timing metrics.
   */
  async runSessionStartupProbe(
    projectPath: string,
    options?: {
      model?: string;
      prompt?: string;
      timeoutMs?: number;
      includePartialMessages?: boolean;
      benchmarkKind?: "startup" | "assistant" | "assistant_iterm";
    }
  ): Promise<SessionStartupProbeResult> {
    return apiCall("run_session_startup_probe", {
      projectPath,
      model: options?.model,
      prompt: options?.prompt,
      timeoutMs: options?.timeoutMs,
      includePartialMessages: options?.includePartialMessages,
      benchmarkKind: options?.benchmarkKind,
    });
  },

  /**
   * Opens a real native terminal window for the project path and runs the provided command.
   */
  async openExternalTerminal(projectPath: string, command = "claude"): Promise<string> {
    return apiCall("open_external_terminal", {
      projectPath,
      command,
    });
  },

  async startEmbeddedTerminal(
    projectPath: string,
    cols?: number,
    rows?: number,
    persistentSessionId?: string
  ): Promise<StartEmbeddedTerminalResult> {
    return apiCall("start_embedded_terminal", {
      projectPath,
      cols,
      rows,
      persistentSessionId,
    });
  },

  async writeEmbeddedTerminalInput(terminalId: string, data: string): Promise<void> {
    return apiCall("write_embedded_terminal_input", {
      terminalId,
      data,
    });
  },

  async resizeEmbeddedTerminal(terminalId: string, cols: number, rows: number): Promise<void> {
    return apiCall("resize_embedded_terminal", {
      terminalId,
      cols,
      rows,
    });
  },

  async closeEmbeddedTerminal(
    terminalId: string,
    options?: { terminatePersistentSession?: boolean }
  ): Promise<void> {
    return apiCall("close_embedded_terminal", {
      terminalId,
      terminatePersistentSession: options?.terminatePersistentSession,
    });
  },

  async generateLocalTerminalTitle(input: GenerateLocalTerminalTitleInput): Promise<string> {
    return apiCall("generate_local_terminal_title", {
      transcript: input.transcript,
      model: input.model,
    });
  },

  async getEmbeddedTerminalDebugSnapshot(): Promise<EmbeddedTerminalDebugSnapshot> {
    return apiCall("get_embedded_terminal_debug_snapshot");
  },

  async writeTerminalIncidentBundle(
    payload: unknown,
    note?: string
  ): Promise<string> {
    return apiCall("write_terminal_incident_bundle", {
      payload,
      note,
    });
  },

  /**
   * Executes a new session with any detected CLI agent
   */
  async executeAgentSession(
    providerId: string,
    projectPath: string,
    prompt: string,
    model: string,
    reasoningEffort?: string
  ): Promise<void> {
    return apiCall("execute_agent_session", {
      providerId,
      projectPath,
      prompt,
      model,
      reasoningEffort,
    });
  },

  /**
   * Continues an existing agent session
   */
  async continueAgentSession(
    providerId: string,
    projectPath: string,
    prompt: string,
    model: string,
    reasoningEffort?: string
  ): Promise<void> {
    return apiCall("continue_agent_session", {
      providerId,
      projectPath,
      prompt,
      model,
      reasoningEffort,
    });
  },

  /**
   * Resumes an existing agent session by ID
   */
  async resumeAgentSession(
    providerId: string,
    projectPath: string,
    sessionId: string,
    prompt: string,
    model: string,
    reasoningEffort?: string
  ): Promise<void> {
    return apiCall("resume_agent_session", {
      providerId,
      projectPath,
      sessionId,
      prompt,
      model,
      reasoningEffort,
    });
  },

  /**
   * Lists files and directories in a given path
   */
  async listDirectoryContents(directoryPath: string): Promise<FileEntry[]> {
    return apiCall("list_directory_contents", { directoryPath });
  },

  /**
   * Searches for files and directories matching a pattern
   */
  async searchFiles(basePath: string, query: string): Promise<FileEntry[]> {
    return apiCall("search_files", { basePath, query });
  },

  /**
   * Gets overall usage statistics
   * @returns Promise resolving to usage statistics
   */
  async getUsageStats(): Promise<UsageStats> {
    try {
      return await apiCall<UsageStats>("get_usage_stats");
    } catch (error) {
      logger.error("ipc", "Failed to get usage stats", { error });
      throw error;
    }
  },

  /**
   * Gets usage statistics filtered by date range
   * @param startDate - Start date (ISO format)
   * @param endDate - End date (ISO format)
   * @returns Promise resolving to usage statistics
   */
  async getUsageByDateRange(startDate: string, endDate: string): Promise<UsageStats> {
    try {
      return await apiCall<UsageStats>("get_usage_by_date_range", { startDate, endDate });
    } catch (error) {
      logger.error("ipc", "Failed to get usage by date range", { error });
      throw error;
    }
  },

  /**
   * Gets usage statistics grouped by session
   * @param since - Optional start date (YYYYMMDD)
   * @param until - Optional end date (YYYYMMDD)
   * @param order - Optional sort order ('asc' or 'desc')
   * @returns Promise resolving to an array of session usage data
   */
  async getSessionStats(
    since?: string,
    until?: string,
    order?: "asc" | "desc",
    limit?: number,
    offset?: number,
  ): Promise<ProjectUsage[]> {
    try {
      return await apiCall<ProjectUsage[]>("get_session_stats", {
        since,
        until,
        order,
        limit,
        offset,
      });
    } catch (error) {
      logger.error("ipc", "Failed to get session stats", { error });
      throw error;
    }
  },

  /**
   * Gets detailed usage entries with optional filtering
   * @param projectPath - Optional project path filter
   * @param date - Optional date filter prefix (YYYY-MM-DD)
   * @returns Promise resolving to array of usage entries
   */
  async getUsageDetails(
    projectPath?: string,
    date?: string,
    limit?: number,
    offset?: number,
  ): Promise<UsageEntry[]> {
    try {
      return await apiCall<UsageEntry[]>("get_usage_details", { projectPath, date, limit, offset });
    } catch (error) {
      logger.error("ipc", "Failed to get usage details", { error });
      throw error;
    }
  },

  async getUsageIndexStatus(): Promise<UsageIndexStatus> {
    try {
      return await apiCall<UsageIndexStatus>("get_usage_index_status");
    } catch (error) {
      logger.error("ipc", "Failed to get usage index status", { error });
      throw error;
    }
  },

  async startUsageIndexSync(): Promise<UsageIndexStatus> {
    try {
      return await apiCall<UsageIndexStatus>("start_usage_index_sync");
    } catch (error) {
      logger.error("ipc", "Failed to start usage index sync", { error });
      throw error;
    }
  },

  async cancelUsageIndexSync(): Promise<UsageIndexStatus> {
    try {
      return await apiCall<UsageIndexStatus>("cancel_usage_index_sync");
    } catch (error) {
      logger.error("ipc", "Failed to cancel usage index sync", { error });
      throw error;
    }
  },

  /**
   * Creates a checkpoint for the current session state
   */
  async createCheckpoint(
    sessionId: string,
    projectId: string,
    projectPath: string,
    messageIndex?: number,
    description?: string
  ): Promise<CheckpointResult> {
    return apiCall("create_checkpoint", {
      sessionId,
      projectId,
      projectPath,
      messageIndex,
      description
    });
  },

  /**
   * Restores a session to a specific checkpoint
   */
  async restoreCheckpoint(
    checkpointId: string,
    sessionId: string,
    projectId: string,
    projectPath: string
  ): Promise<CheckpointResult> {
    return apiCall("restore_checkpoint", {
      checkpointId,
      sessionId,
      projectId,
      projectPath
    });
  },

  /**
   * Lists all checkpoints for a session
   */
  async listCheckpoints(
    sessionId: string,
    projectId: string,
    projectPath: string
  ): Promise<Checkpoint[]> {
    return apiCall("list_checkpoints", {
      sessionId,
      projectId,
      projectPath
    });
  },

  /**
   * Forks a new timeline branch from a checkpoint
   */
  async forkFromCheckpoint(
    checkpointId: string,
    sessionId: string,
    projectId: string,
    projectPath: string,
    newSessionId: string,
    description?: string
  ): Promise<CheckpointResult> {
    return apiCall("fork_from_checkpoint", {
      checkpointId,
      sessionId,
      projectId,
      projectPath,
      newSessionId,
      description
    });
  },

  /**
   * Gets the timeline for a session
   */
  async getSessionTimeline(
    sessionId: string,
    projectId: string,
    projectPath: string
  ): Promise<SessionTimeline> {
    return apiCall("get_session_timeline", {
      sessionId,
      projectId,
      projectPath
    });
  },

  /**
   * Updates checkpoint settings for a session
   */
  async updateCheckpointSettings(
    sessionId: string,
    projectId: string,
    projectPath: string,
    autoCheckpointEnabled: boolean,
    checkpointStrategy: CheckpointStrategy
  ): Promise<void> {
    return apiCall("update_checkpoint_settings", {
      sessionId,
      projectId,
      projectPath,
      autoCheckpointEnabled,
      checkpointStrategy
    });
  },

  /**
   * Gets diff between two checkpoints
   */
  async getCheckpointDiff(
    fromCheckpointId: string,
    toCheckpointId: string,
    sessionId: string,
    projectId: string
  ): Promise<CheckpointDiff> {
    try {
      return await apiCall<CheckpointDiff>("get_checkpoint_diff", {
        fromCheckpointId,
        toCheckpointId,
        sessionId,
        projectId
      });
    } catch (error) {
      logger.error("ipc", "Failed to get checkpoint diff", { error });
      throw error;
    }
  },

  /**
   * Tracks a message for checkpointing
   */
  async trackCheckpointMessage(
    sessionId: string,
    projectId: string,
    projectPath: string,
    message: string
  ): Promise<void> {
    try {
      await apiCall("track_checkpoint_message", {
        sessionId,
        projectId,
        projectPath,
        message
      });
    } catch (error) {
      logger.error("ipc", "Failed to track checkpoint message", { error });
      throw error;
    }
  },

  /**
   * Checks if auto-checkpoint should be triggered
   */
  async checkAutoCheckpoint(
    sessionId: string,
    projectId: string,
    projectPath: string,
    message: string
  ): Promise<boolean> {
    try {
      return await apiCall<boolean>("check_auto_checkpoint", {
        sessionId,
        projectId,
        projectPath,
        message
      });
    } catch (error) {
      logger.error("ipc", "Failed to check auto checkpoint", { error });
      throw error;
    }
  },

  /**
   * Triggers cleanup of old checkpoints
   */
  async cleanupOldCheckpoints(
    sessionId: string,
    projectId: string,
    projectPath: string,
    keepCount: number
  ): Promise<number> {
    try {
      return await apiCall<number>("cleanup_old_checkpoints", {
        sessionId,
        projectId,
        projectPath,
        keepCount
      });
    } catch (error) {
      logger.error("ipc", "Failed to cleanup old checkpoints", { error });
      throw error;
    }
  },

  /**
   * Gets checkpoint settings for a session
   */
  async getCheckpointSettings(
    sessionId: string,
    projectId: string,
    projectPath: string
  ): Promise<{
    auto_checkpoint_enabled: boolean;
    checkpoint_strategy: CheckpointStrategy;
    total_checkpoints: number;
    current_checkpoint_id?: string;
  }> {
    try {
      return await apiCall("get_checkpoint_settings", {
        sessionId,
        projectId,
        projectPath
      });
    } catch (error) {
      logger.error("ipc", "Failed to get checkpoint settings", { error });
      throw error;
    }
  },

  /**
   * Clears checkpoint manager for a session (cleanup on session end)
   */
  async clearCheckpointManager(sessionId: string): Promise<void> {
    try {
      await apiCall("clear_checkpoint_manager", { sessionId });
    } catch (error) {
      logger.error("ipc", "Failed to clear checkpoint manager", { error });
      throw error;
    }
  },

  /**
   * Tracks a batch of messages for a session for checkpointing
   */
  trackSessionMessages: (
    sessionId: string, 
    projectId: string, 
    projectPath: string, 
    messages: string[]
  ): Promise<void> =>
    apiCall("track_session_messages", { sessionId, projectId, projectPath, messages }),

  /**
   * Adds a new MCP server
   */
  async mcpAdd(
    name: string,
    transport: string,
    command?: string,
    args: string[] = [],
    env: Record<string, string> = {},
    url?: string,
    scope: string = "local"
  ): Promise<AddServerResult> {
    try {
      return await apiCall<AddServerResult>("mcp_add", {
        name,
        transport,
        command,
        args,
        env,
        url,
        scope
      });
    } catch (error) {
      logger.error("ipc", "Failed to add MCP server", { error });
      throw error;
    }
  },

  /**
   * Lists all configured MCP servers
   */
  async mcpList(): Promise<MCPServer[]> {
    try {
      logger.debug("ipc", "Calling mcp_list");
      const result = await apiCall<MCPServer[]>("mcp_list");
      logger.debug("ipc", "mcp_list returned", { result });
      return result;
    } catch (error) {
      logger.error("ipc", "Failed to list MCP servers", { error });
      throw error;
    }
  },

  /**
   * Gets details for a specific MCP server
   */
  async mcpGet(name: string): Promise<MCPServer> {
    try {
      return await apiCall<MCPServer>("mcp_get", { name });
    } catch (error) {
      logger.error("ipc", "Failed to get MCP server", { error });
      throw error;
    }
  },

  /**
   * Removes an MCP server
   */
  async mcpRemove(name: string): Promise<string> {
    try {
      return await apiCall<string>("mcp_remove", { name });
    } catch (error) {
      logger.error("ipc", "Failed to remove MCP server", { error });
      throw error;
    }
  },

  /**
   * Adds an MCP server from JSON configuration
   */
  async mcpAddJson(name: string, jsonConfig: string, scope: string = "local"): Promise<AddServerResult> {
    try {
      return await apiCall<AddServerResult>("mcp_add_json", { name, jsonConfig, scope });
    } catch (error) {
      logger.error("ipc", "Failed to add MCP server from JSON", { error });
      throw error;
    }
  },

  /**
   * Imports MCP servers from Claude Desktop
   */
  async mcpAddFromClaudeDesktop(scope: string = "local"): Promise<ImportResult> {
    try {
      return await apiCall<ImportResult>("mcp_add_from_claude_desktop", { scope });
    } catch (error) {
      logger.error("ipc", "Failed to import from Claude Desktop", { error });
      throw error;
    }
  },

  /**
   * Starts Claude Code as an MCP server
   */
  async mcpServe(): Promise<string> {
    try {
      return await apiCall<string>("mcp_serve");
    } catch (error) {
      logger.error("ipc", "Failed to start MCP server", { error });
      throw error;
    }
  },

  /**
   * Tests connection to an MCP server
   */
  async mcpTestConnection(name: string): Promise<string> {
    try {
      return await apiCall<string>("mcp_test_connection", { name });
    } catch (error) {
      logger.error("ipc", "Failed to test MCP connection", { error });
      throw error;
    }
  },

  /**
   * Resets project-scoped server approval choices
   */
  async mcpResetProjectChoices(): Promise<string> {
    try {
      return await apiCall<string>("mcp_reset_project_choices");
    } catch (error) {
      logger.error("ipc", "Failed to reset project choices", { error });
      throw error;
    }
  },

  /**
   * Gets the status of MCP servers
   */
  async mcpGetServerStatus(): Promise<Record<string, ServerStatus>> {
    try {
      return await apiCall<Record<string, ServerStatus>>("mcp_get_server_status");
    } catch (error) {
      logger.error("ipc", "Failed to get server status", { error });
      throw error;
    }
  },

  /**
   * Reads .mcp.json from the current project
   */
  async mcpReadProjectConfig(projectPath: string): Promise<MCPProjectConfig> {
    try {
      return await apiCall<MCPProjectConfig>("mcp_read_project_config", { projectPath });
    } catch (error) {
      logger.error("ipc", "Failed to read project MCP config", { error });
      throw error;
    }
  },

  /**
   * Saves .mcp.json to the current project
   */
  async mcpSaveProjectConfig(projectPath: string, config: MCPProjectConfig): Promise<string> {
    try {
      return await apiCall<string>("mcp_save_project_config", { projectPath, config });
    } catch (error) {
      logger.error("ipc", "Failed to save project MCP config", { error });
      throw error;
    }
  },

  /**
   * Get the stored Claude binary path from settings
   * @returns Promise resolving to the path if set, null otherwise
   */
  async getClaudeBinaryPath(): Promise<string | null> {
    try {
      return await apiCall<string | null>("get_claude_binary_path");
    } catch (error) {
      logger.error("ipc", "Failed to get Claude binary path", { error });
      throw error;
    }
  },

  /**
   * Set the Claude binary path in settings
   * @param path - The absolute path to the Claude binary
   * @returns Promise resolving when the path is saved
   */
  async setClaudeBinaryPath(path: string): Promise<void> {
    try {
      return await apiCall<void>("set_claude_binary_path", { path });
    } catch (error) {
      logger.error("ipc", "Failed to set Claude binary path", { error });
      throw error;
    }
  },

  /**
   * List all available Claude installations on the system
   * @returns Promise resolving to an array of Claude installations
   */
  async listClaudeInstallations(): Promise<ClaudeInstallation[]> {
    try {
      return await apiCall<ClaudeInstallation[]>("list_claude_installations");
    } catch (error) {
      logger.error("ipc", "Failed to list Claude installations", { error });
      throw error;
    }
  },

  // Storage API methods

  /**
   * Lists all tables in the SQLite database
   * @returns Promise resolving to an array of table information
   */
  async storageListTables(): Promise<any[]> {
    try {
      return await apiCall<any[]>("storage_list_tables");
    } catch (error) {
      logger.error("ipc", "Failed to list tables", { error });
      throw error;
    }
  },

  /**
   * Reads table data with pagination
   * @param tableName - Name of the table to read
   * @param page - Page number (1-indexed)
   * @param pageSize - Number of rows per page
   * @param searchQuery - Optional search query
   * @returns Promise resolving to table data with pagination info
   */
  async storageReadTable(
    tableName: string,
    page: number,
    pageSize: number,
    searchQuery?: string
  ): Promise<any> {
    try {
      return await apiCall<any>("storage_read_table", {
        tableName,
        page,
        pageSize,
        searchQuery,
      });
    } catch (error) {
      logger.error("ipc", "Failed to read table", { error });
      throw error;
    }
  },

  /**
   * Updates a row in a table
   * @param tableName - Name of the table
   * @param primaryKeyValues - Map of primary key column names to values
   * @param updates - Map of column names to new values
   * @returns Promise resolving when the row is updated
   */
  async storageUpdateRow(
    tableName: string,
    primaryKeyValues: Record<string, any>,
    updates: Record<string, any>
  ): Promise<void> {
    try {
      return await apiCall<void>("storage_update_row", {
        tableName,
        primaryKeyValues,
        updates,
      });
    } catch (error) {
      logger.error("ipc", "Failed to update row", { error });
      throw error;
    }
  },

  /**
   * Deletes a row from a table
   * @param tableName - Name of the table
   * @param primaryKeyValues - Map of primary key column names to values
   * @returns Promise resolving when the row is deleted
   */
  async storageDeleteRow(
    tableName: string,
    primaryKeyValues: Record<string, any>
  ): Promise<void> {
    try {
      return await apiCall<void>("storage_delete_row", {
        tableName,
        primaryKeyValues,
      });
    } catch (error) {
      logger.error("ipc", "Failed to delete row", { error });
      throw error;
    }
  },

  /**
   * Inserts a new row into a table
   * @param tableName - Name of the table
   * @param values - Map of column names to values
   * @returns Promise resolving to the last insert row ID
   */
  async storageInsertRow(
    tableName: string,
    values: Record<string, any>
  ): Promise<number> {
    try {
      return await apiCall<number>("storage_insert_row", {
        tableName,
        values,
      });
    } catch (error) {
      logger.error("ipc", "Failed to insert row", { error });
      throw error;
    }
  },

  /**
   * Executes a raw SQL query
   * @param query - SQL query string
   * @returns Promise resolving to query result
   */
  async storageExecuteSql(query: string): Promise<any> {
    try {
      return await apiCall<any>("storage_execute_sql", { query });
    } catch (error) {
      logger.error("ipc", "Failed to execute SQL", { error });
      throw error;
    }
  },

  /**
   * Resets the entire database
   * @returns Promise resolving when the database is reset
   */
  async storageResetDatabase(): Promise<void> {
    try {
      return await apiCall<void>("storage_reset_database");
    } catch (error) {
      logger.error("ipc", "Failed to reset database", { error });
      throw error;
    }
  },

  /**
   * Finds a non-empty legacy workspace payload from prior WebKit localStorage origins.
   * Returns null when no legacy workspace can be recovered.
   */
  async storageFindLegacyWorkspaceState(): Promise<string | null> {
    try {
      return await apiCall<string | null>("storage_find_legacy_workspace_state");
    } catch (error) {
      logger.error("ipc", "Failed to find legacy workspace state", { error });
      return null;
    }
  },

  // Theme settings helpers

  /**
   * Gets a setting from the app_settings table
   * @param key - The setting key to retrieve
   * @returns Promise resolving to the setting value or null if not found
   */
  async getSetting(key: string, options?: { fresh?: boolean }): Promise<string | null> {
    try {
      const useCache = options?.fresh !== true;
      // Fast path: check localStorage mirror to avoid startup flicker
      if (useCache && typeof window !== 'undefined' && 'localStorage' in window) {
        const cached = window.localStorage.getItem(`app_setting:${key}`);
        if (cached !== null) {
          return cached;
        }
      }
      // Use storageReadTable to safely query the app_settings table
      const result = await this.storageReadTable('app_settings', 1, 1000);
      const rows = Array.isArray(result?.rows) ? result.rows : [];
      const setting = rows.find((row: any) => row?.key === key);
      const value = typeof setting?.value === 'string' ? setting.value : null;
      if (value !== null && typeof window !== 'undefined' && 'localStorage' in window) {
        window.localStorage.setItem(`app_setting:${key}`, value);
      }
      return value;
    } catch (error) {
      logger.error('ipc', `Failed to get setting ${key}`, { error });
      return null;
    }
  },

  /**
   * Saves a setting to the app_settings table (insert or update)
   * @param key - The setting key
   * @param value - The setting value
   * @returns Promise resolving when the setting is saved
   */
  async saveSetting(key: string, value: string): Promise<void> {
    try {
      // Mirror to localStorage for instant availability on next startup
      if (typeof window !== 'undefined' && 'localStorage' in window) {
        try {
          window.localStorage.setItem(`app_setting:${key}`, value);
        } catch (_ignore) {
          // best-effort; continue to persist in DB
        }
      }
      // Try to update first
      try {
        await this.storageUpdateRow(
          'app_settings',
          { key },
          { value }
        );
      } catch (updateError) {
        // If update fails (row doesn't exist), insert new row
        await this.storageInsertRow('app_settings', { key, value });
      }
    } catch (error) {
      logger.error('ipc', `Failed to save setting ${key}`, { error });
      throw error;
    }
  },

  /**
   * Get hooks configuration for a specific scope
   * @param scope - The configuration scope: 'user', 'project', or 'local'
   * @param projectPath - Project path (required for project and local scopes)
   * @returns Promise resolving to the hooks configuration
   */
  async getHooksConfig(scope: 'user' | 'project' | 'local', projectPath?: string): Promise<HooksConfiguration> {
    try {
      return await apiCall<HooksConfiguration>("get_hooks_config", { scope, projectPath });
    } catch (error) {
      logger.error("ipc", "Failed to get hooks config", { error });
      throw error;
    }
  },

  /**
   * Update hooks configuration for a specific scope
   * @param scope - The configuration scope: 'user', 'project', or 'local'
   * @param hooks - The hooks configuration to save
   * @param projectPath - Project path (required for project and local scopes)
   * @returns Promise resolving to success message
   */
  async updateHooksConfig(
    scope: 'user' | 'project' | 'local',
    hooks: HooksConfiguration,
    projectPath?: string
  ): Promise<string> {
    try {
      return await apiCall<string>("update_hooks_config", { scope, projectPath, hooks });
    } catch (error) {
      logger.error("ipc", "Failed to update hooks config", { error });
      throw error;
    }
  },

  /**
   * Validate a hook command syntax
   * @param command - The shell command to validate
   * @returns Promise resolving to validation result
   */
  async validateHookCommand(command: string): Promise<{ valid: boolean; message: string }> {
    try {
      return await apiCall<{ valid: boolean; message: string }>("validate_hook_command", { command });
    } catch (error) {
      logger.error("ipc", "Failed to validate hook command", { error });
      throw error;
    }
  },

  /**
   * Get merged hooks configuration (respecting priority)
   * @param projectPath - The project path
   * @returns Promise resolving to merged hooks configuration
   */
  async getMergedHooksConfig(projectPath: string): Promise<HooksConfiguration> {
    try {
      const [userHooks, projectHooks, localHooks] = await Promise.all([
        this.getHooksConfig('user'),
        this.getHooksConfig('project', projectPath),
        this.getHooksConfig('local', projectPath)
      ]);

      // Import HooksManager for merging
      const { HooksManager } = await import('@/lib/hooksManager');
      return HooksManager.mergeConfigs(userHooks, projectHooks, localHooks);
    } catch (error) {
      logger.error("ipc", "Failed to get merged hooks config", { error });
      throw error;
    }
  },

  // Slash Commands API methods

  /**
   * Lists all available slash commands
   * @param projectPath - Optional project path to include project-specific commands
   * @returns Promise resolving to array of slash commands
   */
  async slashCommandsList(projectPath?: string): Promise<SlashCommand[]> {
    try {
      return await apiCall<SlashCommand[]>("slash_commands_list", { projectPath });
    } catch (error) {
      logger.error("ipc", "Failed to list slash commands", { error });
      throw error;
    }
  },

  /**
   * Gets a single slash command by ID
   * @param commandId - Unique identifier of the command
   * @returns Promise resolving to the slash command
   */
  async slashCommandGet(commandId: string): Promise<SlashCommand> {
    try {
      return await apiCall<SlashCommand>("slash_command_get", { commandId });
    } catch (error) {
      logger.error("ipc", "Failed to get slash command", { error });
      throw error;
    }
  },

  /**
   * Creates or updates a slash command
   * @param scope - Command scope: "project" or "user"
   * @param name - Command name (without prefix)
   * @param namespace - Optional namespace for organization
   * @param content - Markdown content of the command
   * @param description - Optional description
   * @param allowedTools - List of allowed tools for this command
   * @param projectPath - Required for project scope commands
   * @returns Promise resolving to the saved command
   */
  async slashCommandSave(
    scope: string,
    name: string,
    namespace: string | undefined,
    content: string,
    description: string | undefined,
    allowedTools: string[],
    projectPath?: string
  ): Promise<SlashCommand> {
    try {
      return await apiCall<SlashCommand>("slash_command_save", {
        scope,
        name,
        namespace,
        content,
        description,
        allowedTools,
        projectPath
      });
    } catch (error) {
      logger.error("ipc", "Failed to save slash command", { error });
      throw error;
    }
  },

  /**
   * Deletes a slash command
   * @param commandId - Unique identifier of the command to delete
   * @param projectPath - Optional project path for deleting project commands
   * @returns Promise resolving to deletion message
   */
  async slashCommandDelete(commandId: string, projectPath?: string): Promise<string> {
    try {
      return await apiCall<string>("slash_command_delete", { commandId, projectPath });
    } catch (error) {
      logger.error("ipc", "Failed to delete slash command", { error });
      throw error;
    }
  },

};

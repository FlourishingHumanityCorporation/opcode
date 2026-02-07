/**
 * Multi-provider agent configuration types.
 *
 * Each provider represents a CLI coding agent (Claude Code, Codex, Gemini CLI, etc.)
 * that can be spawned and managed through the same GUI.
 */

export interface AgentProviderFeatures {
  /** Can resume previous sessions */
  resume: boolean;
  /** Supports session checkpointing */
  checkpoints: boolean;
  /** Streams output as JSONL or similar */
  streaming: boolean;
  /** Supports Model Context Protocol */
  mcp: boolean;
  /** Supports --output-format stream-json */
  streamJson: boolean;
}

export interface AgentProvider {
  /** Unique identifier: "claude" | "codex" | "gemini" | custom */
  id: string;
  /** Display name: "Claude Code" | "Codex CLI" | "Gemini CLI" */
  name: string;
  /** Binary command name: "claude" | "codex" | "gemini" */
  command: string;
  /** Default CLI args appended to every invocation */
  defaultArgs: string[];
  /** Provider-specific environment variables */
  env: Record<string, string>;
  /** Lucide icon name for the UI */
  icon: string;
  /** Theme color (hex or Tailwind class) */
  color: string;
  /** Whether this provider was auto-detected on the system */
  detected: boolean;
  /** Binary path if detected (empty if not found) */
  binaryPath: string;
  /** Detected version string */
  version: string | null;
  /** Discovery source (e.g., "which", "homebrew", "PATH") */
  source: string;
  /** Feature capabilities */
  features: AgentProviderFeatures;
  /** Whether the user has enabled this provider */
  enabled: boolean;
  /** Whether this is a built-in provider (vs user-defined custom) */
  builtin: boolean;
}

/** Minimal info returned from Rust agent discovery */
export interface DetectedAgent {
  providerId: string;
  binaryPath: string;
  version: string | null;
  source: string;
}

/**
 * Built-in provider definitions.
 * These define the known CLI agents — detection fills in binaryPath/version/detected.
 */
export const BUILTIN_PROVIDERS: Omit<AgentProvider, 'detected' | 'binaryPath' | 'version' | 'source'>[] = [
  {
    id: 'claude',
    name: 'Claude Code',
    command: 'claude',
    defaultArgs: ['--output-format', 'stream-json', '--verbose'],
    env: {},
    icon: 'Bot',
    color: '#D97706',
    features: {
      resume: true,
      checkpoints: true,
      streaming: true,
      mcp: true,
      streamJson: true,
    },
    enabled: true,
    builtin: true,
  },
  {
    id: 'codex',
    name: 'Codex CLI',
    command: 'codex',
    defaultArgs: [],
    env: {},
    icon: 'Cpu',
    color: '#10B981',
    features: {
      resume: false,
      checkpoints: false,
      streaming: true,
      mcp: false,
      streamJson: false,
    },
    enabled: true,
    builtin: true,
  },
  {
    id: 'gemini',
    name: 'Gemini CLI',
    command: 'gemini',
    defaultArgs: [],
    env: {},
    icon: 'Sparkles',
    color: '#3B82F6',
    features: {
      resume: false,
      checkpoints: false,
      streaming: true,
      mcp: false,
      streamJson: false,
    },
    enabled: true,
    builtin: true,
  },
  {
    id: 'aider',
    name: 'Aider',
    command: 'aider',
    defaultArgs: [],
    env: {},
    icon: 'Wrench',
    color: '#8B5CF6',
    features: {
      resume: false,
      checkpoints: false,
      streaming: true,
      mcp: false,
      streamJson: false,
    },
    enabled: true,
    builtin: true,
  },
  {
    id: 'goose',
    name: 'Goose',
    command: 'goose',
    defaultArgs: [],
    env: {},
    icon: 'Bird',
    color: '#F59E0B',
    features: {
      resume: false,
      checkpoints: false,
      streaming: true,
      mcp: true,
      streamJson: false,
    },
    enabled: true,
    builtin: true,
  },
  {
    id: 'opencode',
    name: 'OpenCode',
    command: 'opencode',
    defaultArgs: [],
    env: {},
    icon: 'Code',
    color: '#06B6D4',
    features: {
      resume: false,
      checkpoints: false,
      streaming: true,
      mcp: false,
      streamJson: false,
    },
    enabled: true,
    builtin: true,
  },
];

/**
 * Merge detection results with built-in provider definitions.
 */
export function mergeProviderDetection(
  detectedAgents: DetectedAgent[]
): AgentProvider[] {
  return BUILTIN_PROVIDERS.map((provider) => {
    const detected = detectedAgents.find((a) => a.providerId === provider.id);
    return {
      ...provider,
      detected: !!detected,
      binaryPath: detected?.binaryPath ?? '',
      version: detected?.version ?? null,
      source: detected?.source ?? '',
    };
  });
}

/** Default provider ID */
export const DEFAULT_PROVIDER_ID = 'claude';

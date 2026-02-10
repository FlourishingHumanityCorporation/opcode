import { api } from "@/lib/api";
import { canonicalizeProjectPath, projectNameFromPath } from "@/lib/terminalPaneState";
import { logger } from '@/lib/logger';

const INITIAL_CHECKPOINTS_MINUTES = [2, 10, 15] as const;
const FOLLOW_UP_INTERVAL_MINUTES = 5;
const DEFAULT_MAX_TRANSCRIPT_CHARS = 6000;
const DEFAULT_MAX_TITLE_CHARS = 72;
const DEFAULT_FALLBACK_TITLE_WORD_LIMIT = 6;

const GENERIC_TITLE_PATTERNS = [
  /^general assistance$/i,
  /^chat( with (assistant|ai))?$/i,
  /^assistant( chat)?$/i,
  /^help( request)?$/i,
  /^terminal( session)?$/i,
  /^session summary$/i,
  /^coding task$/i,
];

const TITLE_STOPWORDS = new Set([
  "a", "an", "the", "and", "or", "to", "for", "of", "in", "on", "with", "from", "by",
  "can", "could", "would", "should", "please", "help", "me", "you", "my", "our", "we",
  "i", "it", "is", "are", "be", "this", "that", "as", "at", "into", "about", "around",
  "need", "needs", "want", "wants", "check", "review",
]);

export interface LatestSessionSnapshot {
  projectId: string;
  sessionId: string;
  history: unknown[];
  userPrompts: string[];
  transcript: string;
}

export interface ResolveSessionSnapshotOptions {
  preferredSessionId?: string;
}

function normalizeInlineWhitespace(value: string): string {
  return value.replace(/\s+/g, " ").trim();
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function stripProjectName(title: string, projectPath?: string): string {
  const projectName = projectNameFromPath(projectPath);
  if (!projectName) {
    return title;
  }

  const escapedProjectName = escapeRegExp(projectName);
  let next = title;

  const exactProjectNamePattern = new RegExp(`^${escapedProjectName}$`, "i");
  if (exactProjectNamePattern.test(next)) {
    return "";
  }

  const prefixPatterns = [
    new RegExp(`^${escapedProjectName}\\s*[:\\-|]\\s*`, "i"),
    new RegExp(`^\\[\\s*${escapedProjectName}\\s*\\]\\s*`, "i"),
    new RegExp(`^\\(\\s*${escapedProjectName}\\s*\\)\\s*`, "i"),
    new RegExp(`^${escapedProjectName}\\s+`, "i"),
  ];

  for (const pattern of prefixPatterns) {
    next = next.replace(pattern, "");
  }

  // Remove inline project name mentions to keep titles task-focused.
  next = next
    .replace(new RegExp(`\\b${escapedProjectName}\\b`, "ig"), "")
    .replace(/\s{2,}/g, " ")
    .trim();

  next = next.replace(/^[\s:|\-–—]+/, "").trim();
  return next;
}

function stripPromptPreamble(prompt: string): string {
  const patterns = [
    /^(please\s+)?(can|could|would)\s+you\s+/i,
    /^help\s+me\s+/i,
    /^i\s+need\s+to\s+/i,
    /^let'?s\s+/i,
    /^we\s+need\s+to\s+/i,
  ];

  let next = prompt.trim();
  for (const pattern of patterns) {
    next = next.replace(pattern, "");
  }
  return next.trim();
}

function normalizePromptForFallback(prompt: string): string {
  const withoutMarkup = prompt
    .replace(/`+/g, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/\[[^\]]+\]\([^)]+\)/g, " ")
    .replace(/https?:\/\/\S+/g, " ");
  const firstClause = withoutMarkup.split(/[\n.!?]/)[0] || withoutMarkup;
  return normalizeInlineWhitespace(stripPromptPreamble(firstClause));
}

function toTitleKeywords(prompt: string, projectPath?: string): string[] {
  const projectName = projectNameFromPath(projectPath).toLowerCase();
  const tokens = (prompt.match(/[A-Za-z0-9][A-Za-z0-9._-]*/g) || [])
    .filter((token) => token.trim().length > 0)
    .filter((token) => token.toLowerCase() !== projectName)
    .filter((token) => !TITLE_STOPWORDS.has(token.toLowerCase()));

  return tokens;
}

function capitalizeFirst(value: string): string {
  if (!value) return value;
  return `${value[0].toUpperCase()}${value.slice(1)}`;
}

function toText(value: unknown): string {
  if (value === null || value === undefined) return "";
  if (typeof value === "string") return value;
  if (typeof value === "number" || typeof value === "boolean") return String(value);
  if (Array.isArray(value)) {
    return value.map(toText).filter((entry) => entry.trim().length > 0).join("\n");
  }
  if (typeof value === "object") {
    const record = value as Record<string, unknown>;
    if (typeof record.text === "string") {
      return record.text;
    }
    if (typeof record.content === "string") {
      return record.content;
    }
    try {
      return JSON.stringify(value);
    } catch {
      return "";
    }
  }
  return "";
}

function getRole(entry: unknown): string {
  if (!entry || typeof entry !== "object") {
    return "unknown";
  }

  const record = entry as Record<string, unknown>;
  if (typeof record.type === "string" && record.type.trim().length > 0) {
    return record.type;
  }

  if (record.message && typeof record.message === "object") {
    const message = record.message as Record<string, unknown>;
    if (typeof message.role === "string" && message.role.trim().length > 0) {
      return message.role;
    }
  }

  if (typeof record.role === "string" && record.role.trim().length > 0) {
    return record.role;
  }

  return "unknown";
}

function getEntryText(entry: unknown): string {
  if (!entry || typeof entry !== "object") {
    return "";
  }

  const record = entry as Record<string, unknown>;
  const fromMessage = record.message;
  if (fromMessage && typeof fromMessage === "object") {
    const message = fromMessage as Record<string, unknown>;
    if (message.content !== undefined) {
      return extractMessageText(message.content);
    }
  }

  if (record.content !== undefined) {
    return extractMessageText(record.content);
  }

  if (record.result !== undefined) {
    return toText(record.result);
  }

  return "";
}

function extractMessageText(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return toText(content);

  const parts = content
    .map((chunk) => {
      if (!chunk || typeof chunk !== "object") {
        return toText(chunk);
      }
      const record = chunk as Record<string, unknown>;
      if (record.type === "text") {
        return toText(record.text);
      }
      if (record.type === "tool_result") {
        return toText(record.content);
      }
      return "";
    })
    .map((part) => part.trim())
    .filter((part) => part.length > 0);

  return parts.join("\n\n");
}

export function getAutoTitleCheckpointMinute(index: number): number {
  if (index < 0) {
    return INITIAL_CHECKPOINTS_MINUTES[0];
  }
  if (index < INITIAL_CHECKPOINTS_MINUTES.length) {
    return INITIAL_CHECKPOINTS_MINUTES[index];
  }

  const extraIndex = index - (INITIAL_CHECKPOINTS_MINUTES.length - 1);
  return INITIAL_CHECKPOINTS_MINUTES[INITIAL_CHECKPOINTS_MINUTES.length - 1] + (extraIndex * FOLLOW_UP_INTERVAL_MINUTES);
}

export function listAutoTitleCheckpointMinutes(count: number): number[] {
  if (count <= 0) return [];
  return Array.from({ length: count }, (_, index) => getAutoTitleCheckpointMinute(index));
}

export function getNextAutoTitleCheckpointAtMs(sessionStartedAtMs: number, nowMs: number): number {
  if (!Number.isFinite(sessionStartedAtMs)) {
    return nowMs + INITIAL_CHECKPOINTS_MINUTES[0] * 60_000;
  }

  const elapsedMinutes = Math.max(0, (nowMs - sessionStartedAtMs) / 60_000);
  let nextMinute: number;

  if (elapsedMinutes < INITIAL_CHECKPOINTS_MINUTES[0]) {
    nextMinute = INITIAL_CHECKPOINTS_MINUTES[0];
  } else if (elapsedMinutes < INITIAL_CHECKPOINTS_MINUTES[1]) {
    nextMinute = INITIAL_CHECKPOINTS_MINUTES[1];
  } else if (elapsedMinutes < INITIAL_CHECKPOINTS_MINUTES[2]) {
    nextMinute = INITIAL_CHECKPOINTS_MINUTES[2];
  } else {
    const baseline = INITIAL_CHECKPOINTS_MINUTES[2] + FOLLOW_UP_INTERVAL_MINUTES;
    if (elapsedMinutes < baseline) {
      nextMinute = baseline;
    } else {
      const steps = Math.floor((elapsedMinutes - baseline) / FOLLOW_UP_INTERVAL_MINUTES) + 1;
      nextMinute = baseline + (steps * FOLLOW_UP_INTERVAL_MINUTES);
    }
  }

  return sessionStartedAtMs + nextMinute * 60_000;
}

export function sanitizeTerminalTitleCandidate(
  raw: string,
  maxChars = DEFAULT_MAX_TITLE_CHARS,
  projectPath?: string
): string {
  const firstLine = raw
    .split("\n")
    .map((line) => line.trim())
    .find((line) => line.length > 0) || "";

  const withoutEdgePunctuation = firstLine.replace(/^[`"'*#\-\s>]+|[`"'*#\-\s>]+$/g, "");
  const withoutProjectPrefix = stripProjectName(withoutEdgePunctuation, projectPath);
  const normalized = normalizeInlineWhitespace(withoutProjectPrefix);
  if (!normalized) {
    return "";
  }

  if (normalized.length <= maxChars) {
    return normalized;
  }

  return normalized.slice(0, maxChars).trimEnd();
}

export function isGenericTerminalTitle(title: string): boolean {
  const normalized = normalizeInlineWhitespace(title);
  if (!normalized) {
    return true;
  }
  return GENERIC_TITLE_PATTERNS.some((pattern) => pattern.test(normalized));
}

export function deriveAutoTitleFromUserPrompts(
  userPrompts: string[],
  projectPath?: string,
  maxChars = DEFAULT_MAX_TITLE_CHARS
): string {
  if (!Array.isArray(userPrompts) || userPrompts.length === 0) {
    return "";
  }

  for (let index = userPrompts.length - 1; index >= 0; index -= 1) {
    const normalizedPrompt = normalizePromptForFallback(userPrompts[index] || "");
    if (!normalizedPrompt) continue;

    const keywords = toTitleKeywords(normalizedPrompt, projectPath);
    if (keywords.length >= 2) {
      const compact = capitalizeFirst(
        keywords.slice(0, DEFAULT_FALLBACK_TITLE_WORD_LIMIT).join(" ")
      );
      const sanitized = sanitizeTerminalTitleCandidate(compact, maxChars, projectPath);
      if (sanitized && !isGenericTerminalTitle(sanitized)) {
        return sanitized;
      }
    }

    const sanitizedPrompt = sanitizeTerminalTitleCandidate(normalizedPrompt, maxChars, projectPath);
    if (sanitizedPrompt && !isGenericTerminalTitle(sanitizedPrompt)) {
      return sanitizedPrompt;
    }
  }

  return "";
}

export function shouldGenerateAutoTitleForTranscript(
  transcript: string,
  previousTranscript?: string | null
): boolean {
  const next = normalizeInlineWhitespace(transcript || "");
  if (!next) {
    return false;
  }

  const previous = normalizeInlineWhitespace(previousTranscript || "");
  return next !== previous;
}

export function getAutoTitleTranscriptCursor(
  transcript: string,
  previousTranscript?: string | null
): string {
  const next = normalizeInlineWhitespace(transcript || "");
  if (!next) {
    return normalizeInlineWhitespace(previousTranscript || "");
  }
  return next;
}

export function shouldApplyAutoRenameTitle(
  currentTitle: string | undefined,
  candidateTitle: string,
  isLocked: boolean,
  projectPath?: string
): boolean {
  if (isLocked) {
    return false;
  }

  const nextTitle = sanitizeTerminalTitleCandidate(candidateTitle, DEFAULT_MAX_TITLE_CHARS, projectPath);
  if (!nextTitle || isGenericTerminalTitle(nextTitle)) {
    return false;
  }

  return normalizeInlineWhitespace(currentTitle || "") !== nextTitle;
}

export function extractUserPromptTexts(history: unknown[]): string[] {
  if (!Array.isArray(history)) {
    return [];
  }

  const prompts: string[] = [];

  history.forEach((entry) => {
    const role = getRole(entry).toLowerCase();
    if (role !== "user") {
      return;
    }

    const text = normalizeInlineWhitespace(getEntryText(entry));
    if (!text) {
      return;
    }

    if (text.includes("Caveat: The messages below were generated by the user while running local commands")) {
      return;
    }

    if (text.startsWith("<command-name>") || text.startsWith("<local-command-stdout>")) {
      return;
    }

    prompts.push(text);
  });

  return prompts;
}

export function buildSessionTranscript(history: unknown[], maxChars = DEFAULT_MAX_TRANSCRIPT_CHARS): string {
  if (!Array.isArray(history)) {
    return "";
  }

  const lines = history
    .map((entry) => {
      const role = getRole(entry).toUpperCase();
      const text = normalizeInlineWhitespace(getEntryText(entry));
      if (!text) {
        return "";
      }
      return `${role}: ${text}`;
    })
    .filter((line) => line.length > 0);

  if (lines.length === 0) {
    return "";
  }

  while (lines.length > 1 && lines.join("\n").length > maxChars) {
    lines.shift();
  }

  return lines.join("\n").slice(0, maxChars);
}

export async function resolveLatestSessionSnapshot(
  projectPath: string,
  options: ResolveSessionSnapshotOptions = {}
): Promise<LatestSessionSnapshot | null> {
  const canonicalPath = canonicalizeProjectPath(projectPath);
  if (!canonicalPath) {
    return null;
  }

  try {
    const projects = await api.listProjects();
    const project = projects.find(
      (entry) => canonicalizeProjectPath(entry.path) === canonicalPath
    );

    if (!project) {
      return null;
    }

    const preferredSessionId = options.preferredSessionId?.trim();

    let selectedSessionId: string | undefined;
    let safeHistory: unknown[] | null = null;

    if (preferredSessionId) {
      try {
        const preferredHistory = await api.loadProviderSessionHistory(preferredSessionId, project.id);
        if (Array.isArray(preferredHistory)) {
          selectedSessionId = preferredSessionId;
          safeHistory = preferredHistory;
        } else {
          return null;
        }
      } catch {
        // Keep title unchanged when active session history is temporarily unavailable.
        return null;
      }
    }

    if (!selectedSessionId) {
      const sessions = await api.getProjectSessions(project.id);
      const latestSessionId = sessions[0]?.id?.trim();
      if (!latestSessionId) {
        return null;
      }

      const history = await api.loadProviderSessionHistory(latestSessionId, project.id);
      selectedSessionId = latestSessionId;
      safeHistory = Array.isArray(history) ? history : [];
    }

    const resolvedSessionId = selectedSessionId?.trim();
    if (!resolvedSessionId) {
      return null;
    }

    const history = Array.isArray(safeHistory) ? safeHistory : [];
    const userPrompts = extractUserPromptTexts(history);
    const transcript = buildSessionTranscript(history);

    return {
      projectId: project.id,
      sessionId: resolvedSessionId,
      history,
      userPrompts,
      transcript,
    };
  } catch (error) {
    logger.warn('misc', '[terminalAutoTitle] Failed to resolve latest session snapshot', { value: error });
    return null;
  }
}

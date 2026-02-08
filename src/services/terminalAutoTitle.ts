import { api } from "@/lib/api";
import { canonicalizeProjectPath, projectNameFromPath } from "@/lib/terminalPaneState";

const INITIAL_CHECKPOINTS_MINUTES = [2, 10, 15] as const;
const FOLLOW_UP_INTERVAL_MINUTES = 5;
const DEFAULT_MAX_TRANSCRIPT_CHARS = 6000;
const DEFAULT_MAX_TITLE_CHARS = 72;

export interface LatestSessionSnapshot {
  projectId: string;
  sessionId: string;
  history: unknown[];
  userPrompts: string[];
  transcript: string;
}

function normalizeInlineWhitespace(value: string): string {
  return value.replace(/\s+/g, " ").trim();
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function stripLeadingProjectName(title: string, projectPath?: string): string {
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

  return next;
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
  const withoutProjectPrefix = stripLeadingProjectName(withoutEdgePunctuation, projectPath);
  const normalized = normalizeInlineWhitespace(withoutProjectPrefix);
  if (!normalized) {
    return "";
  }

  if (normalized.length <= maxChars) {
    return normalized;
  }

  return normalized.slice(0, maxChars).trimEnd();
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
  if (!nextTitle) {
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

export async function resolveLatestSessionSnapshot(projectPath: string): Promise<LatestSessionSnapshot | null> {
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

    const sessions = await api.getProjectSessions(project.id);
    const latestSessionId = sessions[0]?.id?.trim();
    if (!latestSessionId) {
      return null;
    }

    const history = await api.loadSessionHistory(latestSessionId, project.id);
    const safeHistory = Array.isArray(history) ? history : [];
    const userPrompts = extractUserPromptTexts(safeHistory);
    const transcript = buildSessionTranscript(safeHistory);

    return {
      projectId: project.id,
      sessionId: latestSessionId,
      history: safeHistory,
      userPrompts,
      transcript,
    };
  } catch (error) {
    console.warn("[terminalAutoTitle] Failed to resolve latest session snapshot", error);
    return null;
  }
}

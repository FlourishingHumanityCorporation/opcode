const EXPLORER_OPEN_PREFIX = "opcode:explorer:open:";
const EXPLORER_WIDTH_PREFIX = "opcode:explorer:width:";
const EXPLORER_EXPANDED_PREFIX = "opcode:explorer:expanded:";

const DEFAULT_EXPLORER_OPEN = true;
const DEFAULT_EXPLORER_WIDTH = 24;
const MIN_EXPLORER_WIDTH = 12;
const MAX_EXPLORER_WIDTH = 55;

function hasStorage(): boolean {
  return typeof window !== "undefined" && "localStorage" in window;
}

function toProjectKey(projectPath: string): string {
  return encodeURIComponent(projectPath || "");
}

function clampWidth(width: number): number {
  if (!Number.isFinite(width)) {
    return DEFAULT_EXPLORER_WIDTH;
  }
  return Math.min(MAX_EXPLORER_WIDTH, Math.max(MIN_EXPLORER_WIDTH, width));
}

export function getExplorerOpen(workspaceId: string): boolean {
  if (!hasStorage() || !workspaceId) {
    return DEFAULT_EXPLORER_OPEN;
  }

  const value = window.localStorage.getItem(`${EXPLORER_OPEN_PREFIX}${workspaceId}`);
  if (value === null) {
    return DEFAULT_EXPLORER_OPEN;
  }

  return value === "true";
}

export function setExplorerOpen(workspaceId: string, isOpen: boolean): void {
  if (!hasStorage() || !workspaceId) {
    return;
  }

  window.localStorage.setItem(`${EXPLORER_OPEN_PREFIX}${workspaceId}`, String(Boolean(isOpen)));
}

export function getExplorerWidth(workspaceId: string): number {
  if (!hasStorage() || !workspaceId) {
    return DEFAULT_EXPLORER_WIDTH;
  }

  const value = window.localStorage.getItem(`${EXPLORER_WIDTH_PREFIX}${workspaceId}`);
  if (value === null) {
    return DEFAULT_EXPLORER_WIDTH;
  }

  return clampWidth(Number.parseFloat(value));
}

export function setExplorerWidth(workspaceId: string, width: number): void {
  if (!hasStorage() || !workspaceId) {
    return;
  }

  window.localStorage.setItem(`${EXPLORER_WIDTH_PREFIX}${workspaceId}`, String(clampWidth(width)));
}

export function getExpandedPaths(projectPath: string): string[] {
  if (!hasStorage() || !projectPath) {
    return [];
  }

  const value = window.localStorage.getItem(`${EXPLORER_EXPANDED_PREFIX}${toProjectKey(projectPath)}`);
  if (!value) {
    return [];
  }

  try {
    const parsed = JSON.parse(value);
    if (!Array.isArray(parsed)) {
      return [];
    }
    return parsed.filter((entry): entry is string => typeof entry === "string");
  } catch (error) {
    console.warn("[projectExplorerPreferences] Failed to parse expanded paths:", error);
    return [];
  }
}

export function setExpandedPaths(projectPath: string, paths: string[]): void {
  if (!hasStorage() || !projectPath) {
    return;
  }

  const normalized = Array.from(
    new Set(
      paths
        .map((entry) => entry.trim())
        .filter(Boolean)
    )
  );

  window.localStorage.setItem(
    `${EXPLORER_EXPANDED_PREFIX}${toProjectKey(projectPath)}`,
    JSON.stringify(normalized)
  );
}

export function clearExplorerPreferencesForWorkspace(workspaceId: string): void {
  if (!hasStorage() || !workspaceId) {
    return;
  }
  window.localStorage.removeItem(`${EXPLORER_OPEN_PREFIX}${workspaceId}`);
  window.localStorage.removeItem(`${EXPLORER_WIDTH_PREFIX}${workspaceId}`);
}

import { api } from '@/lib/api';
import { canonicalizeProjectPath } from '@/lib/terminalPaneState';

const CACHE_TTL_MS = 30_000;
const SESSION_ID_PATTERN = /^[A-Za-z0-9-]+$/;

type CacheEntry = {
  expiresAt: number;
  sessionId: string | undefined;
};

const latestSessionCache = new Map<string, CacheEntry>();

export function sanitizeClaudeSessionId(sessionId?: string | null): string | undefined {
  if (!sessionId) {
    return undefined;
  }

  const trimmed = sessionId.trim();
  if (!trimmed) {
    return undefined;
  }

  return SESSION_ID_PATTERN.test(trimmed) ? trimmed : undefined;
}

export function clearNativeTerminalRestoreCache(): void {
  latestSessionCache.clear();
}

export async function resolveLatestSessionIdForProject(
  projectPath?: string | null
): Promise<string | undefined> {
  const canonicalPath = canonicalizeProjectPath(projectPath);
  if (!canonicalPath) {
    return undefined;
  }

  const now = Date.now();
  const cached = latestSessionCache.get(canonicalPath);
  if (cached && cached.expiresAt > now) {
    return cached.sessionId;
  }

  const projects = await api.listProjects();
  const matchingProject = projects.find(
    (project) => canonicalizeProjectPath(project.path) === canonicalPath
  );

  if (!matchingProject) {
    latestSessionCache.set(canonicalPath, {
      expiresAt: now + CACHE_TTL_MS,
      sessionId: undefined,
    });
    return undefined;
  }

  const sessions = await api.getProjectSessions(matchingProject.id);
  const sessionId = sanitizeClaudeSessionId(sessions[0]?.id);

  latestSessionCache.set(canonicalPath, {
    expiresAt: now + CACHE_TTL_MS,
    sessionId,
  });

  return sessionId;
}


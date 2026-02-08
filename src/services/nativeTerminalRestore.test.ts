import { afterEach, describe, expect, it, vi } from 'vitest';
import { api, type Project, type Session } from '@/lib/api';
import {
  clearNativeTerminalRestoreCache,
  resolveLatestSessionIdForProject,
  sanitizeProviderSessionId,
} from '@/services/nativeTerminalRestore';

function makeProject(id: string, path: string): Project {
  return {
    id,
    path,
    sessions: [],
    created_at: 0,
  };
}

function makeSession(id: string): Session {
  return {
    id,
    project_id: 'project-1',
    project_path: '/tmp/project-1',
    created_at: Date.now(),
  };
}

describe('nativeTerminalRestore', () => {
  afterEach(() => {
    vi.restoreAllMocks();
    clearNativeTerminalRestoreCache();
  });

  it('resolves latest session id for the matching project path', async () => {
    vi.spyOn(api, 'listProjects').mockResolvedValue([
      makeProject('project-1', '/tmp/project-1'),
    ]);
    vi.spyOn(api, 'getProjectSessions').mockResolvedValue([
      makeSession('session-latest'),
      makeSession('session-older'),
    ]);

    const sessionId = await resolveLatestSessionIdForProject('/tmp/project-1');
    expect(sessionId).toBe('session-latest');
  });

  it('returns undefined when no project matches path', async () => {
    const listProjectsSpy = vi.spyOn(api, 'listProjects').mockResolvedValue([
      makeProject('project-2', '/tmp/project-2'),
    ]);
    const getProjectSessionsSpy = vi.spyOn(api, 'getProjectSessions').mockResolvedValue([]);

    const sessionId = await resolveLatestSessionIdForProject('/tmp/project-1');
    expect(sessionId).toBeUndefined();
    expect(listProjectsSpy).toHaveBeenCalledTimes(1);
    expect(getProjectSessionsSpy).not.toHaveBeenCalled();
  });

  it('returns undefined when the project has no sessions', async () => {
    vi.spyOn(api, 'listProjects').mockResolvedValue([
      makeProject('project-1', '/tmp/project-1'),
    ]);
    vi.spyOn(api, 'getProjectSessions').mockResolvedValue([]);

    const sessionId = await resolveLatestSessionIdForProject('/tmp/project-1');
    expect(sessionId).toBeUndefined();
  });

  it('caches lookups for the same canonical path', async () => {
    const listProjectsSpy = vi.spyOn(api, 'listProjects').mockResolvedValue([
      makeProject('project-1', '/tmp/project-1'),
    ]);
    const getProjectSessionsSpy = vi.spyOn(api, 'getProjectSessions').mockResolvedValue([
      makeSession('session-latest'),
    ]);

    const first = await resolveLatestSessionIdForProject('/tmp/project-1');
    const second = await resolveLatestSessionIdForProject('/tmp/project-1/');

    expect(first).toBe('session-latest');
    expect(second).toBe('session-latest');
    expect(listProjectsSpy).toHaveBeenCalledTimes(1);
    expect(getProjectSessionsSpy).toHaveBeenCalledTimes(1);
  });

  it('sanitizes session ids before use', () => {
    expect(sanitizeProviderSessionId('abc-123')).toBe('abc-123');
    expect(sanitizeProviderSessionId(' abc-123 ')).toBe('abc-123');
    expect(sanitizeProviderSessionId('bad value')).toBeUndefined();
    expect(sanitizeProviderSessionId('../../etc/passwd')).toBeUndefined();
    expect(sanitizeProviderSessionId('')).toBeUndefined();
  });
});


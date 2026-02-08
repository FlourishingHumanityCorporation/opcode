function normalizeSeparators(path: string): string {
  return path.replace(/\\/g, '/');
}

const DEFAULT_WORKSPACE_TITLE_PATTERN = /^Project(?:\s+\d+)?$/i;

function sanitizeSessionKeyPart(value: string): string {
  return value.replace(/[^A-Za-z0-9_-]/g, '_');
}

export function canonicalizeProjectPath(path?: string | null): string {
  if (!path) return '';
  const trimmed = normalizeSeparators(path.trim());
  if (!trimmed) return '';
  if (trimmed === '/') return '/';
  return trimmed.replace(/\/+$/, '');
}

export function shouldResetEmbeddedTerminal(
  currentPath?: string | null,
  nextPath?: string | null
): boolean {
  const nextCanonical = canonicalizeProjectPath(nextPath);
  if (!nextCanonical) {
    return false;
  }
  const currentCanonical = canonicalizeProjectPath(currentPath);
  return currentCanonical !== nextCanonical;
}

export function projectNameFromPath(path?: string | null): string {
  const canonicalPath = canonicalizeProjectPath(path);
  if (!canonicalPath || canonicalPath === '/') {
    return '';
  }
  const segments = canonicalPath.split('/').filter(Boolean);
  return segments[segments.length - 1] || '';
}

export function shouldAutoRenameWorkspaceTitle(
  currentTitle?: string | null,
  currentProjectPath?: string | null
): boolean {
  const title = (currentTitle || '').trim();
  if (!title) {
    return true;
  }
  if (DEFAULT_WORKSPACE_TITLE_PATTERN.test(title)) {
    return true;
  }

  const currentProjectName = projectNameFromPath(currentProjectPath);
  return Boolean(currentProjectName) && currentProjectName === title;
}

export function buildPersistentTerminalSessionId(
  workspaceId: string,
  terminalId: string,
  paneId: string
): string {
  const parts = [
    sanitizeSessionKeyPart(workspaceId),
    sanitizeSessionKeyPart(terminalId),
    sanitizeSessionKeyPart(paneId),
  ];
  return `opcode_${parts.join('_')}`;
}

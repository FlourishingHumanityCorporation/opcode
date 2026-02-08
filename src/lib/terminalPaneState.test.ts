import { describe, expect, it } from 'vitest';
import {
  buildPersistentTerminalSessionId,
  canonicalizeProjectPath,
  projectNameFromPath,
  shouldAutoRenameWorkspaceTitle,
  shouldResetEmbeddedTerminal,
} from '@/lib/terminalPaneState';

describe('terminalPaneState', () => {
  it('canonicalizes separators and trims trailing slashes', () => {
    expect(canonicalizeProjectPath('  /tmp/project///  ')).toBe('/tmp/project');
    expect(canonicalizeProjectPath('C:\\Users\\paul\\repo\\')).toBe('C:/Users/paul/repo');
  });

  it('does not reset embedded terminal for equivalent paths', () => {
    expect(shouldResetEmbeddedTerminal('/tmp/project', '/tmp/project/')).toBe(false);
    expect(shouldResetEmbeddedTerminal('C:\\Users\\paul\\repo', 'C:/Users/paul/repo/')).toBe(false);
  });

  it('resets embedded terminal when project path truly changes', () => {
    expect(shouldResetEmbeddedTerminal('/tmp/project-a', '/tmp/project-b')).toBe(true);
  });

  it('does not reset embedded terminal for empty updates', () => {
    expect(shouldResetEmbeddedTerminal('/tmp/project', '')).toBe(false);
    expect(shouldResetEmbeddedTerminal('/tmp/project', undefined)).toBe(false);
  });

  it('builds stable sanitized persistent session ids', () => {
    const id = buildPersistentTerminalSessionId(
      'workspace-1',
      'terminal-2',
      'pane-3'
    );
    expect(id).toBe('opcode_workspace-1_terminal-2_pane-3');

    const sanitized = buildPersistentTerminalSessionId(
      'workspace:1',
      'terminal/2',
      'pane 3'
    );
    expect(sanitized).toBe('opcode_workspace_1_terminal_2_pane_3');
  });

  it('extracts project names from canonicalized paths', () => {
    expect(projectNameFromPath('/Users/paul/CodeProjects/apps/VideoProcessor/')).toBe('VideoProcessor');
    expect(projectNameFromPath('C:\\Users\\paul\\repo\\ProjectPulse\\')).toBe('ProjectPulse');
  });

  it('auto-renames generic workspace titles and preserves custom titles', () => {
    expect(shouldAutoRenameWorkspaceTitle('Project', '')).toBe(true);
    expect(shouldAutoRenameWorkspaceTitle('Project 2', '')).toBe(true);
    expect(shouldAutoRenameWorkspaceTitle('VideoProcessor', '/Users/paul/CodeProjects/apps/VideoProcessor')).toBe(
      true
    );
    expect(shouldAutoRenameWorkspaceTitle('My Team Workspace', '/Users/paul/CodeProjects/apps/VideoProcessor')).toBe(
      false
    );
  });
});

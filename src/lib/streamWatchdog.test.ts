import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createStreamWatchdog } from '@/lib/streamWatchdog';

describe('streamWatchdog', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('fires first warning at configured threshold and hard timeout later', () => {
    const events: string[] = [];
    const watchdog = createStreamWatchdog({
      firstWarningMs: 2000,
      hardTimeoutMs: 120000,
      onFirstWarning: () => {
        events.push('first-warning');
      },
      onHardTimeout: () => {
        events.push('hard-timeout');
      },
    });

    watchdog.start({ providerId: 'claude', projectPath: '/tmp/project' });

    vi.advanceTimersByTime(1999);
    expect(events).toEqual([]);

    vi.advanceTimersByTime(1);
    expect(events).toEqual(['first-warning']);

    vi.advanceTimersByTime(118000);
    expect(events).toEqual(['first-warning', 'hard-timeout']);
  });

  it('suppresses first warning after first stream arrives', () => {
    const events: string[] = [];
    const watchdog = createStreamWatchdog({
      firstWarningMs: 2000,
      hardTimeoutMs: 120000,
      onFirstWarning: () => {
        events.push('first-warning');
      },
      onHardTimeout: () => {
        events.push('hard-timeout');
      },
    });

    watchdog.start({ providerId: 'claude', projectPath: '/tmp/project' });
    vi.advanceTimersByTime(900);
    expect(watchdog.markFirstStream()).toBe(true);
    expect(watchdog.markFirstStream()).toBe(false);

    vi.advanceTimersByTime(2000);
    expect(events).toEqual([]);
  });

  it('cancels all timers on stop', () => {
    const events: string[] = [];
    const watchdog = createStreamWatchdog({
      firstWarningMs: 2000,
      hardTimeoutMs: 120000,
      onFirstWarning: () => {
        events.push('first-warning');
      },
      onHardTimeout: () => {
        events.push('hard-timeout');
      },
    });

    watchdog.start({ providerId: 'claude', projectPath: '/tmp/project' });
    expect(watchdog.isActive()).toBe(true);
    watchdog.stop();
    expect(watchdog.isActive()).toBe(false);

    vi.advanceTimersByTime(130000);
    expect(events).toEqual([]);
  });
});

export interface StreamWatchdogContext {
  providerId: string;
  projectPath: string;
}

export interface StreamWatchdogOptions {
  firstWarningMs: number;
  hardTimeoutMs: number;
  onFirstWarning: (context: StreamWatchdogContext) => void;
  onHardTimeout: (context: StreamWatchdogContext) => void;
}

export interface StreamWatchdogController {
  start: (context: StreamWatchdogContext) => void;
  markFirstStream: () => boolean;
  stop: () => void;
  isActive: () => boolean;
}

export function createStreamWatchdog(options: StreamWatchdogOptions): StreamWatchdogController {
  let firstWarningTimer: ReturnType<typeof setTimeout> | null = null;
  let hardTimeoutTimer: ReturnType<typeof setTimeout> | null = null;
  let firstStreamSeen = false;
  let active = false;
  let currentContext: StreamWatchdogContext | null = null;

  const clearTimers = () => {
    if (firstWarningTimer !== null) {
      clearTimeout(firstWarningTimer);
      firstWarningTimer = null;
    }
    if (hardTimeoutTimer !== null) {
      clearTimeout(hardTimeoutTimer);
      hardTimeoutTimer = null;
    }
  };

  return {
    start(context) {
      clearTimers();
      currentContext = context;
      firstStreamSeen = false;
      active = true;

      firstWarningTimer = setTimeout(() => {
        if (!active || firstStreamSeen || !currentContext) {
          return;
        }
        options.onFirstWarning(currentContext);
      }, options.firstWarningMs);

      hardTimeoutTimer = setTimeout(() => {
        if (!active || !currentContext) {
          return;
        }
        options.onHardTimeout(currentContext);
      }, options.hardTimeoutMs);
    },

    markFirstStream() {
      if (!active || firstStreamSeen) {
        return false;
      }
      firstStreamSeen = true;
      if (firstWarningTimer !== null) {
        clearTimeout(firstWarningTimer);
        firstWarningTimer = null;
      }
      return true;
    },

    stop() {
      active = false;
      firstStreamSeen = false;
      currentContext = null;
      clearTimers();
    },

    isActive() {
      return active;
    },
  };
}

type LogLevel = 'debug' | 'info' | 'warn' | 'error';
type LogModule = 'terminal' | 'persistence' | 'ipc' | 'mobile-sync' |
                 'provider' | 'ui' | 'analytics' | 'misc';

interface LogEntry {
  timestamp: string;
  level: LogLevel;
  module: LogModule;
  message: string;
  context?: Record<string, unknown>;
}

// Module-based colors for console output (using ANSI codes)
const MODULE_COLORS: Record<LogModule, string> = {
  terminal: '\x1b[36m',      // Cyan
  persistence: '\x1b[33m',   // Yellow
  ipc: '\x1b[35m',           // Magenta
  'mobile-sync': '\x1b[32m', // Green
  provider: '\x1b[34m',      // Blue
  ui: '\x1b[37m',            // White
  analytics: '\x1b[31m',     // Red
  misc: '\x1b[90m',          // Gray
};

const RESET_COLOR = '\x1b[0m';

const LOG_LEVEL_NAMES: Record<LogLevel, string> = {
  debug: '[DEBUG]',
  info: '[INFO]',
  warn: '[WARN]',
  error: '[ERROR]',
};

const LOG_LEVEL_PRIORITY: Record<LogLevel, number> = {
  debug: 0,
  info: 1,
  warn: 2,
  error: 3,
};

// Circular buffer for post-mortem export
class CircularBuffer<T> {
  private buffer: (T | undefined)[];
  private index: number = 0;
  private size: number = 0;
  private maxSize: number;

  constructor(maxSize: number) {
    this.maxSize = maxSize;
    this.buffer = new Array(maxSize);
  }

  push(item: T): void {
    this.buffer[this.index] = item;
    this.index = (this.index + 1) % this.maxSize;
    if (this.size < this.maxSize) {
      this.size++;
    }
  }

  getAll(): T[] {
    const result: T[] = [];
    for (let i = 0; i < this.size; i++) {
      const idx = (this.index - this.size + i + this.maxSize) % this.maxSize;
      const item = this.buffer[idx];
      if (item !== undefined) {
        result.push(item);
      }
    }
    return result;
  }
}

// Credential stripping patterns
const CREDENTIAL_PATTERNS = [
  /sk_live_[a-zA-Z0-9_]+/g,
  /pk_live_[a-zA-Z0-9_]+/g,
  /ghp_[a-zA-Z0-9_]+/g,
  /gho_[a-zA-Z0-9_]+/g,
  /"key"\s*:\s*"[^"]*"/g,
  /"token"\s*:\s*"[^"]*"/g,
  /"apiKey"\s*:\s*"[^"]*"/g,
  /"password"\s*:\s*"[^"]*"/g,
  /"secret"\s*:\s*"[^"]*"/g,
];

function stripCredentials(context?: Record<string, unknown>): Record<string, unknown> | undefined {
  if (!context) return undefined;

  const stripped = { ...context };
  const stringified = JSON.stringify(stripped);
  let sanitized = stringified;

  for (const pattern of CREDENTIAL_PATTERNS) {
    sanitized = sanitized.replace(pattern, '[REDACTED]');
  }

  try {
    return JSON.parse(sanitized);
  } catch {
    return stripped;
  }
}

class Logger {
  private buffer: CircularBuffer<LogEntry>;
  private logLevel: LogLevel;
  private isDev: boolean;

  constructor() {
    this.buffer = new CircularBuffer<LogEntry>(1000);
    this.isDev = typeof import.meta !== 'undefined' && !!import.meta.env?.DEV;
    this.logLevel = this.getInitialLogLevel();
  }

  private getSafeStorage():
    | Pick<Storage, 'getItem' | 'setItem'>
    | undefined {
    try {
      const storage = globalThis.localStorage as Partial<Storage> | undefined;
      if (
        storage &&
        typeof storage.getItem === 'function' &&
        typeof storage.setItem === 'function'
      ) {
        return {
          getItem: storage.getItem.bind(storage),
          setItem: storage.setItem.bind(storage),
        };
      }
    } catch {
      return undefined;
    }
    return undefined;
  }

  private getInitialLogLevel(): LogLevel {
    // Check for __CODEINTERFACEX_DEBUG_LOGS__ flag
    if (typeof window !== 'undefined' && (window as any).__CODEINTERFACEX_DEBUG_LOGS__) {
      return 'debug';
    }

    // Check localStorage
    const storage = this.getSafeStorage();
    if (storage) {
      try {
        const stored = storage.getItem('codeinterfacex.log.level');
        if (stored && (stored === 'debug' || stored === 'info' || stored === 'warn' || stored === 'error')) {
          return stored;
        }
      } catch {
        // Ignore storage read failures and fall back to defaults.
      }
    }

    // Default based on environment
    return this.isDev ? 'debug' : 'info';
  }

  setLogLevel(level: LogLevel): void {
    this.logLevel = level;
    const storage = this.getSafeStorage();
    if (storage) {
      try {
        storage.setItem('codeinterfacex.log.level', level);
      } catch {
        // Ignore storage write failures; runtime level still updates in-memory.
      }
    }
  }

  private shouldLog(level: LogLevel): boolean {
    return LOG_LEVEL_PRIORITY[level] >= LOG_LEVEL_PRIORITY[this.logLevel];
  }

  private formatConsoleOutput(
    level: LogLevel,
    module: LogModule,
    message: string,
    context?: Record<string, unknown>
  ): string {
    const color = MODULE_COLORS[module];
    const timestamp = new Date().toISOString().split('T')[1];
    const levelName = LOG_LEVEL_NAMES[level];
    const moduleTag = `[${module.toUpperCase()}]`;

    const baseLine = `${timestamp} ${levelName} ${color}${moduleTag}${RESET_COLOR} ${message}`;

    if (context && Object.keys(context).length > 0) {
      return `${baseLine}\n${JSON.stringify(context, null, 2)}`;
    }

    return baseLine;
  }

  private log(
    level: LogLevel,
    module: LogModule,
    message: string,
    context?: Record<string, unknown>
  ): void {
    if (!this.shouldLog(level)) {
      return;
    }

    const strippedContext = stripCredentials(context);

    const entry: LogEntry = {
      timestamp: new Date().toISOString(),
      level,
      module,
      message,
      context: strippedContext,
    };

    // Store in circular buffer
    this.buffer.push(entry);

    // Log to console in dev
    if (this.isDev) {
      const formatted = this.formatConsoleOutput(level, module, message, strippedContext);
      const consoleMethod = level === 'error' ? 'error' : level === 'warn' ? 'warn' : 'log';
      console[consoleMethod](formatted);
    }

    // Forward to backend for error and warn
    if (level === 'error' || level === 'warn') {
      this.forwardToBackend(level, module, message, strippedContext);
    }
  }

  private async forwardToBackend(
    level: LogLevel,
    module: LogModule,
    message: string,
    context?: Record<string, unknown>
  ): Promise<void> {
    try {
      const { invoke } = await import('@tauri-apps/api/core');
      await invoke('log_frontend_event', {
        module,
        level,
        message,
        context: context ? JSON.stringify(context) : null,
      });
    } catch {
      // Silently fail - we're already logging to console
    }
  }

  debug(module: LogModule, message: string, context?: Record<string, unknown>): void {
    this.log('debug', module, message, context);
  }

  info(module: LogModule, message: string, context?: Record<string, unknown>): void {
    this.log('info', module, message, context);
  }

  warn(module: LogModule, message: string, context?: Record<string, unknown>): void {
    this.log('warn', module, message, context);
  }

  error(module: LogModule, message: string, context?: Record<string, unknown>): void {
    this.log('error', module, message, context);
  }

  getSnapshot(): LogEntry[] {
    return this.buffer.getAll();
  }
}

// Singleton instance
const logger = new Logger();

// Helper to create module-scoped loggers
function createModuleLogger(module: LogModule) {
  return {
    debug: (message: string, context?: Record<string, unknown>) => logger.debug(module, message, context),
    info: (message: string, context?: Record<string, unknown>) => logger.info(module, message, context),
    warn: (message: string, context?: Record<string, unknown>) => logger.warn(module, message, context),
    error: (message: string, context?: Record<string, unknown>) => logger.error(module, message, context),
  };
}

export { logger, createModuleLogger };
export type { LogLevel, LogModule, LogEntry };

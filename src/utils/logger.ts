/**
 * Logger Utility
 *
 * Colored console output with log levels.
 * NEVER log API keys or sensitive data!
 */

import chalk from 'chalk';

/**
 * Log levels
 */
export enum LogLevel {
  ERROR = 0,
  WARN = 1,
  INFO = 2,
  DEBUG = 3,
  TRACE = 4,
}

/**
 * Get log level from environment variable
 */
function getLogLevelFromEnv(): LogLevel {
  const envLevel = process.env.VOCAREUM_LOG_LEVEL?.toUpperCase();
  switch (envLevel) {
    case 'ERROR':
      return LogLevel.ERROR;
    case 'WARN':
      return LogLevel.WARN;
    case 'INFO':
      return LogLevel.INFO;
    case 'DEBUG':
      return LogLevel.DEBUG;
    case 'TRACE':
      return LogLevel.TRACE;
    default:
      return LogLevel.INFO;
  }
}

/**
 * Format timestamp for debug logging
 */
function timestamp(): string {
  return new Date().toISOString();
}

/**
 * Logger class with colored output and log levels
 */
export class Logger {
  private level: LogLevel;

  constructor(level?: LogLevel) {
    this.level = level ?? getLogLevelFromEnv();
  }

  /**
   * Set log level
   */
  setLevel(level: LogLevel): void {
    this.level = level;
  }

  /**
   * Log error message
   */
  error(message: string, meta?: unknown): void {
    // Always log errors
    process.stderr.write(chalk.red('✗ ') + message + '\n');
    if (meta !== undefined && meta !== null && this.level >= LogLevel.DEBUG) {
      process.stderr.write(chalk.gray(JSON.stringify(meta, null, 2)) + '\n');
    }
  }

  /**
   * Log warning message
   */
  warn(message: string, meta?: unknown): void {
    if (this.level >= LogLevel.WARN) {
      process.stderr.write(chalk.yellow('⚠ ') + message + '\n');
      if (meta !== undefined && meta !== null && this.level >= LogLevel.DEBUG) {
        process.stderr.write(chalk.gray(JSON.stringify(meta, null, 2)) + '\n');
      }
    }
  }

  /**
   * Log info message
   */
  info(message: string): void {
    if (this.level >= LogLevel.INFO) {
      process.stdout.write(chalk.blue('ℹ ') + message + '\n');
    }
  }

  /**
   * Log success message
   */
  success(message: string): void {
    if (this.level >= LogLevel.INFO) {
      process.stdout.write(chalk.green('✓ ') + message + '\n');
    }
  }

  /**
   * Log debug message
   */
  debug(message: string, meta?: unknown): void {
    if (this.level >= LogLevel.DEBUG) {
      process.stdout.write(chalk.gray(`[DEBUG ${timestamp()}] `) + message + '\n');
      if (meta !== undefined && meta !== null) {
        process.stdout.write(chalk.gray(JSON.stringify(meta, null, 2)) + '\n');
      }
    }
  }

  /**
   * Log trace message
   */
  trace(message: string, meta?: unknown): void {
    if (this.level >= LogLevel.TRACE) {
      process.stdout.write(chalk.gray(`[TRACE ${timestamp()}] `) + message + '\n');
      if (meta !== undefined && meta !== null) {
        process.stdout.write(chalk.gray(JSON.stringify(meta, null, 2)) + '\n');
      }
    }
  }

  /**
   * Log plain text (no prefix)
   */
  plain(message: string): void {
    process.stdout.write(message + '\n');
  }

  /**
   * Log a blank line
   */
  newline(): void {
    process.stdout.write('\n');
  }
}

/**
 * Default logger instance
 */
export const logger = new Logger();

/**
 * Create a child logger with a prefix
 *
 * @param prefix - Prefix to prepend to all messages
 * @param level - Optional log level override
 * @returns Logger instance with prefix
 */
export function createLogger(prefix: string, level?: LogLevel): Logger {
  const childLogger = new Logger(level);
  const originalInfo = childLogger.info.bind(childLogger);
  const originalError = childLogger.error.bind(childLogger);
  const originalWarn = childLogger.warn.bind(childLogger);
  const originalDebug = childLogger.debug.bind(childLogger);
  const originalSuccess = childLogger.success.bind(childLogger);

  childLogger.info = (message: string): void => originalInfo(`[${prefix}] ${message}`);
  childLogger.error = (message: string, meta?: unknown): void =>
    originalError(`[${prefix}] ${message}`, meta);
  childLogger.warn = (message: string, meta?: unknown): void =>
    originalWarn(`[${prefix}] ${message}`, meta);
  childLogger.debug = (message: string, meta?: unknown): void =>
    originalDebug(`[${prefix}] ${message}`, meta);
  childLogger.success = (message: string): void => originalSuccess(`[${prefix}] ${message}`);

  return childLogger;
}

/**
 * Get the current log level
 */
export function getLogLevel(): LogLevel {
  return getLogLevelFromEnv();
}

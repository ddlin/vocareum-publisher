/**
 * Logger Utility Tests
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { Logger, LogLevel, createLogger, getLogLevel } from '../../src/utils/logger';

describe('Logger', () => {
  let stdoutWrite: ReturnType<typeof vi.spyOn>;
  let stderrWrite: ReturnType<typeof vi.spyOn>;
  let originalEnv: string | undefined;

  beforeEach(() => {
    // Mock stdout and stderr
    stdoutWrite = vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
    stderrWrite = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
    originalEnv = process.env.VOCAREUM_LOG_LEVEL;
  });

  afterEach(() => {
    stdoutWrite.mockRestore();
    stderrWrite.mockRestore();
    if (originalEnv === undefined) {
      delete process.env.VOCAREUM_LOG_LEVEL;
    } else {
      process.env.VOCAREUM_LOG_LEVEL = originalEnv;
    }
  });

  describe('constructor', () => {
    it('should use provided log level', () => {
      const logger = new Logger(LogLevel.DEBUG);
      logger.debug('test message');
      expect(stdoutWrite).toHaveBeenCalled();
    });

    it('should default to INFO level when no env var', () => {
      delete process.env.VOCAREUM_LOG_LEVEL;
      const logger = new Logger();
      logger.debug('test message');
      // Debug shouldn't be called at INFO level
      expect(stdoutWrite).not.toHaveBeenCalled();
    });
  });

  describe('setLevel', () => {
    it('should change log level', () => {
      const logger = new Logger(LogLevel.ERROR);
      logger.info('test');
      expect(stdoutWrite).not.toHaveBeenCalled();

      logger.setLevel(LogLevel.INFO);
      logger.info('test');
      expect(stdoutWrite).toHaveBeenCalled();
    });
  });

  describe('error', () => {
    it('should always log errors', () => {
      const logger = new Logger(LogLevel.ERROR);
      logger.error('test error');
      expect(stderrWrite).toHaveBeenCalled();
      const call = stderrWrite.mock.calls[0][0] as string;
      expect(call).toContain('test error');
      expect(call).toContain('✗');
    });

    it('should log meta at DEBUG level', () => {
      const logger = new Logger(LogLevel.DEBUG);
      logger.error('test error', { detail: 'info' });
      expect(stderrWrite).toHaveBeenCalledTimes(2);
      const metaCall = stderrWrite.mock.calls[1][0] as string;
      expect(metaCall).toContain('detail');
    });

    it('should not log meta at INFO level', () => {
      const logger = new Logger(LogLevel.INFO);
      logger.error('test error', { detail: 'info' });
      expect(stderrWrite).toHaveBeenCalledTimes(1);
    });
  });

  describe('warn', () => {
    it('should log at WARN level', () => {
      const logger = new Logger(LogLevel.WARN);
      logger.warn('test warning');
      expect(stderrWrite).toHaveBeenCalled();
      const call = stderrWrite.mock.calls[0][0] as string;
      expect(call).toContain('test warning');
      expect(call).toContain('⚠');
    });

    it('should not log below WARN level', () => {
      const logger = new Logger(LogLevel.ERROR);
      logger.warn('test warning');
      expect(stderrWrite).not.toHaveBeenCalled();
    });
  });

  describe('info', () => {
    it('should log at INFO level', () => {
      const logger = new Logger(LogLevel.INFO);
      logger.info('test info');
      expect(stdoutWrite).toHaveBeenCalled();
      const call = stdoutWrite.mock.calls[0][0] as string;
      expect(call).toContain('test info');
      expect(call).toContain('ℹ');
    });

    it('should not log below INFO level', () => {
      const logger = new Logger(LogLevel.WARN);
      logger.info('test info');
      expect(stdoutWrite).not.toHaveBeenCalled();
    });
  });

  describe('success', () => {
    it('should log at INFO level with checkmark', () => {
      const logger = new Logger(LogLevel.INFO);
      logger.success('operation complete');
      expect(stdoutWrite).toHaveBeenCalled();
      const call = stdoutWrite.mock.calls[0][0] as string;
      expect(call).toContain('operation complete');
      expect(call).toContain('✓');
    });
  });

  describe('debug', () => {
    it('should log at DEBUG level with timestamp', () => {
      const logger = new Logger(LogLevel.DEBUG);
      logger.debug('debug message');
      expect(stdoutWrite).toHaveBeenCalled();
      const call = stdoutWrite.mock.calls[0][0] as string;
      expect(call).toContain('debug message');
      expect(call).toContain('[DEBUG');
    });

    it('should log meta when provided', () => {
      const logger = new Logger(LogLevel.DEBUG);
      logger.debug('debug message', { key: 'value' });
      expect(stdoutWrite).toHaveBeenCalledTimes(2);
    });
  });

  describe('trace', () => {
    it('should log at TRACE level', () => {
      const logger = new Logger(LogLevel.TRACE);
      logger.trace('trace message');
      expect(stdoutWrite).toHaveBeenCalled();
      const call = stdoutWrite.mock.calls[0][0] as string;
      expect(call).toContain('trace message');
      expect(call).toContain('[TRACE');
    });
  });

  describe('plain', () => {
    it('should output without prefix', () => {
      const logger = new Logger(LogLevel.ERROR);
      logger.plain('plain message');
      expect(stdoutWrite).toHaveBeenCalled();
      const call = stdoutWrite.mock.calls[0][0] as string;
      expect(call).toBe('plain message\n');
    });
  });

  describe('newline', () => {
    it('should output blank line', () => {
      const logger = new Logger(LogLevel.ERROR);
      logger.newline();
      expect(stdoutWrite).toHaveBeenCalledWith('\n');
    });
  });
});

describe('createLogger', () => {
  let stdoutWrite: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    stdoutWrite = vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
  });

  afterEach(() => {
    stdoutWrite.mockRestore();
  });

  it('should create logger with prefix', () => {
    const logger = createLogger('TestModule', LogLevel.INFO);
    logger.info('test message');
    const call = stdoutWrite.mock.calls[0][0] as string;
    expect(call).toContain('[TestModule]');
    expect(call).toContain('test message');
  });
});

describe('getLogLevel', () => {
  let originalEnv: string | undefined;

  beforeEach(() => {
    originalEnv = process.env.VOCAREUM_LOG_LEVEL;
  });

  afterEach(() => {
    if (originalEnv === undefined) {
      delete process.env.VOCAREUM_LOG_LEVEL;
    } else {
      process.env.VOCAREUM_LOG_LEVEL = originalEnv;
    }
  });

  it('should return DEBUG when env is set to DEBUG', () => {
    process.env.VOCAREUM_LOG_LEVEL = 'DEBUG';
    expect(getLogLevel()).toBe(LogLevel.DEBUG);
  });

  it('should return INFO by default', () => {
    delete process.env.VOCAREUM_LOG_LEVEL;
    expect(getLogLevel()).toBe(LogLevel.INFO);
  });

  it('should be case insensitive', () => {
    process.env.VOCAREUM_LOG_LEVEL = 'debug';
    expect(getLogLevel()).toBe(LogLevel.DEBUG);
  });
});

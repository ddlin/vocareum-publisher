/**
 * Logger Utility Tests
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { Logger, LogLevel, createLogger, getLogLevel, logger } from '../../src/utils/logger';

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

describe('logger JSON mode', () => {
  const capture = () => {
    const out: string[] = [];
    const err: string[] = [];
    const so = process.stdout.write.bind(process.stdout);
    const se = process.stderr.write.bind(process.stderr);
    // @ts-expect-error test double
    process.stdout.write = (s: string) => { out.push(String(s)); return true; };
    // @ts-expect-error test double
    process.stderr.write = (s: string) => { err.push(String(s)); return true; };
    return { out, err, restore: () => { process.stdout.write = so; process.stderr.write = se; } };
  };

  it('sends stdout-bound levels to stderr while enabled', () => {
    const { out, err, restore } = capture();
    try {
      logger.setJsonMode(true);
      logger.info('info line');
      logger.success('success line');
      logger.plain('plain line');
    } finally {
      logger.setJsonMode(false);
      restore();
    }
    expect(out).toEqual([]);
    expect(err.join('')).toContain('info line');
    expect(err.join('')).toContain('success line');
    expect(err.join('')).toContain('plain line');
  });

  it('restores stdout routing when disabled', () => {
    const { out, restore } = capture();
    try {
      logger.setJsonMode(true);
      logger.setJsonMode(false);
      logger.info('back on stdout');
    } finally {
      restore();
    }
    expect(out.join('')).toContain('back on stdout');
  });

  it('leaves warn and error on stderr in both modes', () => {
    const { out, err, restore } = capture();
    try {
      logger.setJsonMode(true);
      logger.warn('warned');
      logger.error('errored');
    } finally {
      logger.setJsonMode(false);
      restore();
    }
    expect(out).toEqual([]);
    expect(err.join('')).toContain('warned');
    expect(err.join('')).toContain('errored');
  });
});

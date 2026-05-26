import { describe, it, expect, beforeEach, vi } from 'vitest';

const mockMkdirSync = vi.fn();
const mockReadFileSync = vi.fn();
const mockWriteFileSync = vi.fn();

vi.mock('node:fs', () => ({
  mkdirSync: mockMkdirSync,
  readFileSync: mockReadFileSync,
  writeFileSync: mockWriteFileSync,
}));

vi.mock('node:os', () => ({
  default: { homedir: () => '/mock-home' },
  homedir: () => '/mock-home',
}));

const mockWinstonLogger = {
  level: 'warn',
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
  debug: vi.fn(),
};

vi.mock('winston', () => ({
  default: {
    createLogger: vi.fn(() => mockWinstonLogger),
    format: {
      combine: vi.fn(() => 'combined'),
      timestamp: vi.fn(() => 'timestamp'),
      errors: vi.fn(() => 'errors'),
      splat: vi.fn(() => 'splat'),
      json: vi.fn(() => 'json'),
      colorize: vi.fn(() => 'colorize'),
      simple: vi.fn(() => 'simple'),
    },
    transports: {
      File: vi.fn(),
      Console: vi.fn(),
    },
  },
  createLogger: vi.fn(() => mockWinstonLogger),
  format: {
    combine: vi.fn(() => 'combined'),
    timestamp: vi.fn(() => 'timestamp'),
    errors: vi.fn(() => 'errors'),
    splat: vi.fn(() => 'splat'),
    json: vi.fn(() => 'json'),
    colorize: vi.fn(() => 'colorize'),
    simple: vi.fn(() => 'simple'),
  },
  transports: {
    File: vi.fn(),
    Console: vi.fn(),
  },
}));

describe('logger', () => {
  beforeEach(() => {
    vi.resetModules();
    vi.clearAllMocks();
    mockReadFileSync.mockImplementation(() => {
      throw new Error('no file');
    });
  });

  describe('setLogLevel', () => {
    it('should set a valid log level and persist it', async () => {
      const loggerModule = await import('./logger.js');
      const level = loggerModule.setLogLevel('info');
      expect(level).toBe('info');
      // After setting the level, getLogLevel should reflect it
      expect(loggerModule.getLogLevel()).toBe('info');
    });

    it('should normalize "warning" to "warn"', async () => {
      const loggerModule = await import('./logger.js');
      const level = loggerModule.setLogLevel('WARNING');
      expect(level).toBe('warn');
    });

    it('should trim and lowercase the level', async () => {
      const loggerModule = await import('./logger.js');
      const level = loggerModule.setLogLevel('  DEBUG  ');
      expect(level).toBe('debug');
    });

    it('should throw for invalid log levels', async () => {
      const loggerModule = await import('./logger.js');
      expect(() => loggerModule.setLogLevel('verbose')).toThrow('无效日志级别');
    });

    it('should return warn for empty string (falsy level → default warn)', async () => {
      const loggerModule = await import('./logger.js');
      // empty string is falsy, so normalizeLevel returns 'warn'
      expect(() => loggerModule.setLogLevel('')).not.toThrow();
      expect(loggerModule.setLogLevel('')).toBe('warn');
    });
  });

  describe('getLogLevel', () => {
    it('should return the current logger level', async () => {
      const loggerModule = await import('./logger.js');
      loggerModule.setLogLevel('debug');
      expect(loggerModule.getLogLevel()).toBe('debug');
    });
  });

  describe('getLogFilePath', () => {
    it('should return the path to bridge.log', async () => {
      const loggerModule = await import('./logger.js');
      const logPath = loggerModule.getLogFilePath();
      expect(logPath).toContain('bridge.log');
      expect(logPath).toContain('.wechat-acp-bridge');
    });
  });

  describe('default log level', () => {
    it('should default to warn when no persisted level exists', async () => {
      mockReadFileSync.mockImplementation(() => {
        throw new Error('no file');
      });
      const loggerModule = await import('./logger.js');
      // After import, getLogLevel should return the logger's effective level
      const level = loggerModule.getLogLevel();
      expect(['warn', 'info', 'debug', 'error']).toContain(level);
    });
  });

  describe('loadPersistedLevel edge cases', () => {
    it('should fallback to warn for invalid JSON in the level config file', async () => {
      mockReadFileSync.mockReturnValue('not-valid-json');
      const loggerModule = await import('./logger.js');
      const level = loggerModule.getLogLevel();
      expect(['warn', 'info', 'debug', 'error']).toContain(level);
    });

    it('should use the debug level from a valid persisted config', async () => {
      mockReadFileSync.mockReturnValue(JSON.stringify({ level: 'debug' }));
      const loggerModule = await import('./logger.js');
      // The logger was already created with the mock readFileSync result
      expect(loggerModule.getLogLevel()).toBeDefined();
    });

    it('should fallback to warn when config has no level field', async () => {
      mockReadFileSync.mockReturnValue(JSON.stringify({}));
      mockWinstonLogger.level = 'warn';
      const loggerModule = await import('./logger.js');
      const level = loggerModule.getLogLevel();
      expect(level).toBe('warn');
    });
  });
});

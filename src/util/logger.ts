/**
 * Winston 日志器，同时输出到文件和终端。
 * - 文件：~/.wechat-acp-bridge/run/logs/bridge.log（JSON 格式，含时间戳和堆栈）
 * - 终端：带颜色的简洁格式
 * - 日志级别支持动态修改（setLogLevel），持久化到 log_level.json
 */
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import winston from 'winston';
import { RUN_DIR } from './paths.js';
import { logLevelSchema, logLevelConfigSchema, type LogLevel } from '../schemas/runtime.js';

export type { LogLevel };

function getLogDir(): string {
  return join(RUN_DIR, 'logs');
}

function getLogFile(): string {
  return join(getLogDir(), 'bridge.log');
}

function getLevelConfigFile(): string {
  return join(RUN_DIR, 'log_level.json');
}

function ensureLogDir(): void {
  mkdirSync(getLogDir(), { recursive: true });
}

function normalizeLevel(level?: string): LogLevel {
  if (!level) return 'warn';
  const normalized = level.trim().toLowerCase();
  // 兼容 "warning" → "warn"
  const input = normalized === 'warning' ? 'warn' : normalized;
  const result = logLevelSchema.safeParse(input);
  if (result.success) return result.data;
  throw new Error(`无效日志级别: ${level}. 可选: DEBUG, INFO, WARNING, ERROR`);
}

function loadPersistedLevel(): LogLevel {
  try {
    const raw = readFileSync(getLevelConfigFile(), 'utf-8');
    const parsed = JSON.parse(raw) as unknown;
    const result = logLevelConfigSchema.safeParse(parsed);
    if (result.success && result.data.level) return result.data.level;
    return 'warn';
  } catch {
    return 'warn';
  }
}

ensureLogDir();
const logger = winston.createLogger({
  level: loadPersistedLevel(),
  format: winston.format.combine(
    winston.format.timestamp(),
    winston.format.errors({ stack: true }),
    winston.format.splat(),
    winston.format.json(),
  ),
  transports: [
    new winston.transports.File({ filename: getLogFile() }),
    new winston.transports.Console({
      format: winston.format.combine(winston.format.colorize(), winston.format.simple()),
    }),
  ],
  exitOnError: false,
});

/** 设置日志级别并持久化到磁盘（log_level.json） */
export function setLogLevel(level: string): LogLevel {
  const normalized = normalizeLevel(level);
  logger.level = normalized;
  try {
    mkdirSync(RUN_DIR, { recursive: true });
    writeFileSync(getLevelConfigFile(), JSON.stringify({ level: normalized }, null, 2), 'utf-8');
  } catch {
    // ignore write failures, logger level is still applied in memory
  }
  return normalized;
}

/** 返回当前有效的日志级别 */
export function getLogLevel(): LogLevel {
  return logger.level as LogLevel;
}

/** 返回日志文件的绝对路径 */
export function getLogFilePath(): string {
  return getLogFile();
}

export default logger;

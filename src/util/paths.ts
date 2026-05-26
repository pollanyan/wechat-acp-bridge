import { homedir } from 'node:os';
import { join } from 'node:path';
import { settings } from './settings.js';

/** Runtime data directory: ~/.<name>/run */
export const RUN_DIR = join(homedir(), `.${safeSegment(settings.name)}`, 'run');

/** 将用户输入转义为安全的文件系统路径段。空字符串返回 '_' 防止路径折叠。 */
export function safeSegment(value: string): string {
  if (!value) return '_';
  return encodeURIComponent(value);
}

/** PID 文件路径，用于防止重复启动 */
export function getPidFile(): string {
  return join(RUN_DIR, 'bridge.pid');
}

/** 激活账号列表文件路径，supervisorLoop 每 10s 读取一次实现热加载 */
export function getActiveAccountsFile(): string {
  return join(RUN_DIR, 'active_accounts.json');
}

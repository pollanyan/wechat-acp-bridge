import { homedir } from 'node:os';
import { join } from 'node:path';
import { settings } from './settings.js';

/** 从 package name 提取文件系统安全名称：@scope/name → name */
export function toFsName(pkgName: string): string {
  const match = pkgName.match(/^@[^/]+\/(.+)$/);
  return match ? match[1] : pkgName;
}

const APP_DIR = toFsName(settings.name);

/** Runtime data directory: ~/.<app-dir>/run */
export const RUN_DIR = join(homedir(), `.${safeSegment(APP_DIR)}`, 'run');

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

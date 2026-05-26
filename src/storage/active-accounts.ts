/**
 * 激活账号持久化 — active_accounts.json 的读写。
 */
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { getActiveAccountsFile } from '../util/paths.js';
import { activeAccountsSchema } from '../schemas/runtime.js';
import logger from '../util/logger.js';

/** 从 active_accounts.json 读取当前激活的账号列表 */
export function readActiveAliases(): string[] {
  try {
    const data = readFileSync(getActiveAccountsFile(), 'utf-8');
    const parsed = JSON.parse(data) as unknown;
    const result = activeAccountsSchema.safeParse(parsed);
    if (result.success) return result.data;
    logger.warn('active_accounts.json Schema 验证失败');
    return [];
  } catch {
    return [];
  }
}

/** 将激活账号列表写入 active_accounts.json */
export function writeActiveAliases(aliases: string[]): void {
  const filePath = getActiveAccountsFile();
  mkdirSync(dirname(filePath), { recursive: true });
  writeFileSync(filePath, JSON.stringify(aliases, null, 2));
}

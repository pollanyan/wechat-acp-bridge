/**
 * 账号状态持久化 — account_state/<alias>/state.json 的读写。
 */
import { readFileSync, promises as fsa } from 'node:fs';
import { join } from 'node:path';
import { RUN_DIR, safeSegment } from '../util/paths.js';
import { accountStateSchema, type AccountState } from '../schemas/account-state.js';
import { DEFAULT_AGENT_KEY } from '../config/agents.js';
import logger from '../util/logger.js';

function getAccountStatePath(accountAlias: string): string {
  return join(RUN_DIR, 'account_state', safeSegment(accountAlias), 'state.json');
}

/** 从磁盘读取账号状态，文件缺失或校验失败返回 null */
export function readAccountState(accountAlias: string): AccountState | null {
  try {
    const raw = readFileSync(getAccountStatePath(accountAlias), 'utf-8');
    const parsed = JSON.parse(raw) as unknown;
    const result = accountStateSchema.safeParse(parsed);
    if (result.success) return result.data;
    logger.warn('[%s] account state Schema 验证失败', accountAlias);
    return null;
  } catch {
    return null;
  }
}

/** 读取账号状态，缺失时返回默认值 */
export function loadAccountState(accountAlias: string): AccountState {
  return (
    readAccountState(accountAlias) ?? {
      currentAgentKey: DEFAULT_AGENT_KEY,
      sessions: {},
      lastActive: 0,
    }
  );
}

/** 持久化账号状态到磁盘 */
export async function saveAccountState(accountAlias: string, state: AccountState): Promise<void> {
  const statePath = getAccountStatePath(accountAlias);
  await fsa.mkdir(join(RUN_DIR, 'account_state', safeSegment(accountAlias)), { recursive: true });
  await fsa.writeFile(statePath, JSON.stringify(state, null, 2), 'utf-8');
}

export { getAccountStatePath };

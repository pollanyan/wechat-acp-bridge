/**
 * Session 元数据持久化 — sessions/<alias>/<agent>/<uuid>.json 的读写。
 */
import { readFileSync, promises as fsa } from 'node:fs';
import { join } from 'node:path';
import { RUN_DIR, safeSegment } from '../util/paths.js';
import { sessionMetaSchema, type SessionMeta } from '../schemas/session.js';
import logger from '../util/logger.js';

function getSessionDir(accountAlias: string, agentKey: string): string {
  return join(RUN_DIR, 'sessions', safeSegment(accountAlias), safeSegment(agentKey));
}

export function getSessionMetaPath(accountAlias: string, agentKey: string, sessionKey: string): string {
  return join(getSessionDir(accountAlias, agentKey), `${sessionKey}.json`);
}

/** 持久化 session 元数据到磁盘 */
export async function saveSessionMeta(meta: SessionMeta): Promise<void> {
  const metaPath = getSessionMetaPath(meta.accountAlias, meta.agentKey, meta.sessionKey);
  await fsa.mkdir(getSessionDir(meta.accountAlias, meta.agentKey), { recursive: true });
  await fsa.writeFile(metaPath, JSON.stringify(meta, null, 2), 'utf-8');
}

/** 按 sessionKey 查找 session 元数据 */
export async function findSessionMetaByKey(accountAlias: string, sessionKey: string): Promise<SessionMeta | null> {
  const sessions = await listAccountSessions(accountAlias);
  return sessions.find((s) => s.sessionKey === sessionKey) ?? null;
}

/** 列出指定账号的所有 session（按最近活跃时间降序） */
export async function listAccountSessions(accountAlias: string): Promise<SessionMeta[]> {
  const root = join(RUN_DIR, 'sessions', safeSegment(accountAlias));
  try {
    const agentDirs = await fsa.readdir(root, { withFileTypes: true });
    const sessions: SessionMeta[] = [];
    for (const agentDir of agentDirs) {
      if (!agentDir.isDirectory()) continue;
      const agentPath = join(root, agentDir.name);
      const files = await fsa.readdir(agentPath, { withFileTypes: true });
      for (const file of files) {
        if (!file.isFile() || !file.name.endsWith('.json')) continue;
        try {
          const raw = await fsa.readFile(join(agentPath, file.name), 'utf-8');
          const parsed = JSON.parse(raw) as unknown;
          const result = sessionMetaSchema.safeParse(parsed);
          if (result.success) {
            sessions.push(result.data);
          }
        } catch {
          // skip corrupted session files
        }
      }
    }
    return sessions.sort((a, b) => b.lastActive - a.lastActive);
  } catch {
    return [];
  }
}

/** CLI 用：同步读取 session 元数据的摘要信息 */
export function readSessionSummary(
  alias: string,
  agentKey: string,
  sessionKey: string,
): { description: string; lastActive: number } | null {
  try {
    const metaPath = getSessionMetaPath(alias, agentKey, sessionKey);
    const raw = readFileSync(metaPath, 'utf-8');
    const parsed = JSON.parse(raw) as unknown;
    const result = sessionMetaSchema.safeParse(parsed);
    if (result.success) return { description: result.data.description, lastActive: result.data.lastActive };
    logger.warn('[%s/%s] session meta Schema 验证失败', alias, sessionKey);
    return null;
  } catch {
    return null;
  }
}

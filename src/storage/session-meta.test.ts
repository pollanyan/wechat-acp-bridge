import { describe, it, expect, beforeAll, beforeEach, afterEach, vi } from 'vitest';
import { mkdirSync, writeFileSync } from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';

const tempHome = path.join(os.tmpdir(), `wechat-acp-bridge-session-meta-${Date.now()}`);

vi.mock('os', async () => {
  const actual = await vi.importActual<typeof import('os')>('os');
  return { ...actual, homedir: () => tempHome };
});

vi.mock('../util/logger', () => ({
  default: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

function validSessionMeta(overrides: Record<string, unknown> = {}) {
  return {
    sessionKey: 'test-key',
    accountAlias: 'test-alias',
    userId: 'user1',
    agentKey: 'agent1',
    sessionId: 'session-1',
    session: 'active',
    description: 'test session',
    createdAt: Date.now(),
    lastActive: Date.now(),
    ...overrides,
  };
}

describe('session-meta', () => {
  let sessionMeta: typeof import('./session-meta.js');
  let fsp: typeof import('node:fs/promises');
  let logger: { warn: ReturnType<typeof vi.fn> };
  let runDir: string;

  beforeAll(async () => {
    sessionMeta = await import('./session-meta.js');
    fsp = await import('node:fs/promises');
    const loggerMod = await import('../util/logger.js');
    logger = loggerMod.default as unknown as { warn: ReturnType<typeof vi.fn> };
    // RUN_DIR = ~/.wechat-acp-bridge/run
    runDir = path.join(tempHome, '.wechat-acp-bridge', 'run');
  });

  beforeEach(async () => {
    vi.clearAllMocks();
    await fsp.rm(tempHome, { recursive: true, force: true });
  });

  afterEach(async () => {
    await fsp.rm(tempHome, { recursive: true, force: true });
  });

  describe('saveSessionMeta', () => {
    it('should persist session metadata to disk', async () => {
      const meta = validSessionMeta();
      await sessionMeta.saveSessionMeta(meta);

      const expectedPath = sessionMeta.getSessionMetaPath(meta.accountAlias, meta.agentKey, meta.sessionKey);
      const raw = await fsp.readFile(expectedPath, 'utf-8');
      const parsed = JSON.parse(raw);
      expect(parsed.sessionKey).toBe(meta.sessionKey);
      expect(parsed.accountAlias).toBe(meta.accountAlias);
    });
  });

  describe('findSessionMetaByKey', () => {
    it('should return session meta when key matches', async () => {
      const meta = validSessionMeta();
      await sessionMeta.saveSessionMeta(meta);

      const found = await sessionMeta.findSessionMetaByKey('test-alias', 'test-key');
      expect(found).not.toBeNull();
      expect(found!.sessionKey).toBe('test-key');
    });

    it('should return null when no session matches key', async () => {
      const meta = validSessionMeta();
      await sessionMeta.saveSessionMeta(meta);

      const found = await sessionMeta.findSessionMetaByKey('test-alias', 'non-existent-key');
      expect(found).toBeNull();
    });

    it('should return null when account alias has no sessions', async () => {
      const found = await sessionMeta.findSessionMetaByKey('unknown-alias', 'any-key');
      expect(found).toBeNull();
    });
  });

  describe('listAccountSessions', () => {
    it('should return empty array for account with no sessions', async () => {
      const sessions = await sessionMeta.listAccountSessions('no-sessions');
      expect(sessions).toEqual([]);
    });

    it('should skip non-directory entries in agent directory', async () => {
      // Create sessions/alias/ directory and add a regular file directly (not a directory)
      const sessionsDir = path.join(runDir, 'sessions', encodeURIComponent('alias-with-file'));
      const notADir = path.join(sessionsDir, 'not-a-directory');
      await fsp.mkdir(sessionsDir, { recursive: true });
      await fsp.writeFile(notADir, 'i am a file not a dir');

      const sessions = await sessionMeta.listAccountSessions('alias-with-file');
      expect(sessions).toEqual([]);
    });

    it('should skip non-.json files in agent directories', async () => {
      const meta = validSessionMeta({ accountAlias: 'alias-txt', agentKey: 'agent1', sessionKey: 'key1' });
      await sessionMeta.saveSessionMeta(meta);

      // Add a .txt file in the same agent dir
      const agentDir = path.join(runDir, 'sessions', encodeURIComponent('alias-txt'), encodeURIComponent('agent1'));
      await fsp.writeFile(path.join(agentDir, 'readme.txt'), 'hello');

      const sessions = await sessionMeta.listAccountSessions('alias-txt');
      expect(sessions).toHaveLength(1);
      expect(sessions[0].sessionKey).toBe('key1');
    });

    it('should skip .json files that fail schema validation', async () => {
      // Save a valid session first, then manually create an invalid one in the same agent dir
      const valid = validSessionMeta({ accountAlias: 'alias-inv', agentKey: 'agent1', sessionKey: 'valid-key' });
      await sessionMeta.saveSessionMeta(valid);

      // Create a .json file that parses to valid JSON but fails schema (missing required fields)
      const agentDir = path.join(runDir, 'sessions', encodeURIComponent('alias-inv'), encodeURIComponent('agent1'));
      await fsp.writeFile(
        path.join(agentDir, 'incomplete.json'),
        JSON.stringify({ description: 'no required fields' }),
      );

      const sessions = await sessionMeta.listAccountSessions('alias-inv');
      expect(sessions).toHaveLength(1);
      expect(sessions[0].sessionKey).toBe('valid-key');
    });

    it('should list and sort sessions by lastActive descending', async () => {
      const old = validSessionMeta({ accountAlias: 'alias-sort', agentKey: 'ag', sessionKey: 'old', lastActive: 1000 });
      const newer = validSessionMeta({
        accountAlias: 'alias-sort',
        agentKey: 'ag',
        sessionKey: 'newer',
        lastActive: 3000,
      });
      const mid = validSessionMeta({ accountAlias: 'alias-sort', agentKey: 'ag', sessionKey: 'mid', lastActive: 2000 });

      await sessionMeta.saveSessionMeta(old);
      await sessionMeta.saveSessionMeta(mid);
      await sessionMeta.saveSessionMeta(newer);

      const sessions = await sessionMeta.listAccountSessions('alias-sort');
      expect(sessions).toHaveLength(3);
      expect(sessions[0].sessionKey).toBe('newer');
      expect(sessions[1].sessionKey).toBe('mid');
      expect(sessions[2].sessionKey).toBe('old');
    });
  });

  describe('readSessionSummary', () => {
    it('should return summary for valid session meta', () => {
      const meta = validSessionMeta({ accountAlias: 'alias-sum', agentKey: 'agent1', sessionKey: 'key1' });
      const metaPath = sessionMeta.getSessionMetaPath('alias-sum', 'agent1', 'key1');
      mkdirSync(path.dirname(metaPath), { recursive: true });
      writeFileSync(metaPath, JSON.stringify(meta));

      const summary = sessionMeta.readSessionSummary('alias-sum', 'agent1', 'key1');
      expect(summary).not.toBeNull();
      expect(summary!.description).toBe('test session');
      expect(summary!.lastActive).toBe(meta.lastActive);
    });

    it('should return null and warn when schema validation fails', () => {
      const metaPath = sessionMeta.getSessionMetaPath('alias-bad', 'agent1', 'key1');
      mkdirSync(path.dirname(metaPath), { recursive: true });
      // Write valid JSON but missing required schema fields (no sessionKey, no sessionId)
      writeFileSync(metaPath, JSON.stringify({ description: 'incomplete', lastActive: 123 }));

      const summary = sessionMeta.readSessionSummary('alias-bad', 'agent1', 'key1');
      expect(summary).toBeNull();
      expect(logger.warn).toHaveBeenCalledWith('[%s/%s] session meta Schema 验证失败', 'alias-bad', 'key1');
    });

    it('should return null when file does not exist', () => {
      const summary = sessionMeta.readSessionSummary('no-file', 'ag', 'no-key');
      expect(summary).toBeNull();
    });

    it('should return null when file contains invalid JSON', () => {
      const metaPath = sessionMeta.getSessionMetaPath('alias-json', 'agent1', 'key1');
      mkdirSync(path.dirname(metaPath), { recursive: true });
      writeFileSync(metaPath, 'not valid json {{{');

      const summary = sessionMeta.readSessionSummary('alias-json', 'agent1', 'key1');
      expect(summary).toBeNull();
    });
  });
});

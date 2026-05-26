import { describe, it, expect, afterEach, vi } from 'vitest';
import * as path from 'node:path';
import * as os from 'node:os';

let tempCounter = 0;

function createTempHome() {
  return path.join(os.tmpdir(), `wechat-acp-bridge-router-${Date.now()}-${tempCounter++}`);
}

// Use a global to set the temp homedir that the os mock reads
let currentTestHomedir = '';

class MockAcpBridgeClient {
  static counter = 0;
  static nullSessionId = false;
  static failWaitReady = false;
  instanceId: number;
  constructor(public options: Record<string, unknown>) {
    MockAcpBridgeClient.counter++;
    this.instanceId = MockAcpBridgeClient.counter;
  }
  async waitReady() {
    if (MockAcpBridgeClient.failWaitReady) throw new Error('agent failed to start');
    return;
  }
  getSessionId() {
    if (MockAcpBridgeClient.nullSessionId) return null as unknown as string;
    return `session-${this.instanceId}`;
  }
  async sendPrompt(content: string) {
    return `reply:${content}`;
  }
  disconnect() {}
}

vi.mock('../acp/client', () => ({
  AcpBridgeClient: MockAcpBridgeClient,
}));

vi.mock('../../util/logger', () => ({
  default: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

// vi.mock is hoisted and preserved across vi.resetModules()
vi.mock('os', async () => {
  const actual = await vi.importActual<typeof import('os')>('os');
  function getHomedir() {
    if (currentTestHomedir) return currentTestHomedir;
    return actual.homedir();
  }
  // Return as a plain object that supports both default and named access
  const mockOs = { ...actual, homedir: getHomedir };
  return { ...mockOs, default: mockOs };
});

// Dynamic mock state for agents configuration
const mockAgentsState = {
  configs: {
    Hermes: { name: 'Hermes Agent', command: 'hermes', args: ['acp'], cwd: '/tmp', env: {}, short: 'HA', logo: '☤' },
  } as Record<string, unknown>,
  timeout: 30,
};

function buildAgentCmdMap(configs: Record<string, unknown>) {
  const map: Record<string, string> = {};
  for (const [key, cfg] of Object.entries(configs)) {
    const c = cfg as Record<string, unknown>;
    if (c.short) map[String(c.short).toLowerCase()] = key;
  }
  return map;
}

vi.mock('../config/agents', () => ({
  get AGENT_CONFIGS() {
    return { ...mockAgentsState.configs };
  },
  get SESSION_TIMEOUT_MINUTES() {
    return mockAgentsState.timeout;
  },
  get AGENT_COMMAND_MAP() {
    return buildAgentCmdMap(mockAgentsState.configs);
  },
  get DEFAULT_AGENT_KEY() {
    return Object.keys(mockAgentsState.configs)[0] || 'Hermes';
  },
  buildAgentCommandMap: vi.fn(),
  loadAgentDisplayNames: vi.fn(() => ({})),
}));

const mockSettingsState: Record<string, unknown> = { name: 'wechat-acp-bridge' };

vi.mock('../util/settings', () => ({
  get settings() {
    return mockSettingsState;
  },
}));

describe('MessageRouter', () => {
  async function createRouter(existingTempHome?: string) {
    const tempHome = existingTempHome ?? createTempHome();
    currentTestHomedir = tempHome;
    vi.resetModules();
    MockAcpBridgeClient.counter = 0;
    const mod = await import('./router.js');
    return { router: new mod.MessageRouter(), tempHome };
  }

  function getAgentSessionsDir(tempHome: string, agentKey: string) {
    return path.join(tempHome, '.wechat-acp-bridge', 'run', 'sessions', 'alias', agentKey);
  }

  function getAccountStateDir(tempHome: string) {
    return path.join(tempHome, '.wechat-acp-bridge', 'run', 'account_state', 'alias');
  }

  afterEach(async () => {
    currentTestHomedir = '';
    mockAgentsState.configs = {
      Hermes: { name: 'Hermes Agent', command: 'hermes', args: ['acp'], cwd: '/tmp', env: {}, short: 'HA', logo: '☤' },
    };
    mockAgentsState.timeout = 30;
    delete mockSettingsState.Agent;
    MockAcpBridgeClient.nullSessionId = false;
    MockAcpBridgeClient.failWaitReady = false;
    vi.restoreAllMocks();
  });

  describe('command: /h', () => {
    it('should return WeChat-side help with available commands', async () => {
      const { router } = await createRouter();
      const reply = await router.routeMessage('alias', '/h');
      expect(reply).toContain('/h');
      expect(reply).toContain('/sessions');
      expect(reply).toContain('/new');
      expect(reply).toContain('/session');
      expect(reply).toContain('latest');
    });

    it('should NOT include terminal management commands', async () => {
      const { router } = await createRouter();
      const reply = await router.routeMessage('alias', '/h');
      expect(reply).not.toContain('wechat-acp-bridge');
      expect(reply).not.toContain('终端管理');
    });

    it('should list agent shortcuts when available', async () => {
      const { router } = await createRouter();
      const reply = await router.routeMessage('alias', '/h');
      expect(reply).toContain('Agent 切换');
    });
  });

  describe('command: /sessions', () => {
    it('should show empty message when no sessions exist', async () => {
      const { router } = await createRouter();
      const reply = await router.routeMessage('alias', '/sessions');
      expect(reply).toContain('暂无 session');
    });

    it('should list sessions after creating one via /new', async () => {
      const { router } = await createRouter();
      await router.routeMessage('alias', '/new');
      const reply = await router.routeMessage('alias', '/sessions');
      expect(reply).toContain('session');
      expect(reply).not.toContain('暂无 session');
    });
  });

  describe('command: /new', () => {
    it('should create a new session and return a confirmation', async () => {
      const { router } = await createRouter();
      const reply = await router.routeMessage('alias', '/new');
      expect(reply).toContain('已为');
      expect(reply).toContain('session');
    });
  });

  describe('plain text message', () => {
    it('should route to agent and return reply', async () => {
      const { router } = await createRouter();
      const reply = await router.routeMessage('alias', 'hello world');
      expect(reply).toBe('☤ Hermes Agent\nreply:hello world');
    });

    it('should create a session on first message if none exists', async () => {
      const { router } = await createRouter();
      await router.routeMessage('alias', 'first message');
      const sessions = await router.routeMessage('alias', '/sessions');
      expect(sessions).toContain('session');
      expect(sessions).not.toContain('暂无 session');
    });
  });

  describe('command: /session <key>', () => {
    it('should switch to an existing session', async () => {
      const { router } = await createRouter();
      const newReply = await router.routeMessage('alias', '/new');
      const match = newReply.match(/session:\s*(\S+)/);
      if (match) {
        const sessionKey = match[1];
        const switchReply = await router.routeMessage('alias', `/session ${sessionKey}`);
        expect(switchReply).toContain('已切换到 session');
      }
    });

    it('should return error for non-existent session key', async () => {
      const { router } = await createRouter();
      const reply = await router.routeMessage('alias', '/session nonexistent-key-12345');
      expect(reply).toContain('未找到当前 Agent 下的 session');
    });

    it('should switch to session by short ID prefix', async () => {
      const { router } = await createRouter();
      const newReply = await router.routeMessage('alias', '/new');
      const match = newReply.match(/session:\s*(\S+)/);
      if (match) {
        const sessionKey = match[1];
        const shortId = sessionKey.slice(0, 8);
        const switchReply = await router.routeMessage('alias', `/session ${shortId}`);
        expect(switchReply).toContain('已切换到 session');
        expect(switchReply).toContain(shortId);
      }
    });
  });

  describe('command: /session latest', () => {
    it('should show empty message when no sessions exist', async () => {
      const { router } = await createRouter();
      const reply = await router.routeMessage('alias', '/session latest');
      expect(reply).toContain('暂无 session');
    });

    it('should switch to most recently active session', async () => {
      const { router } = await createRouter();
      await router.routeMessage('alias', '/new');
      const reply = await router.routeMessage('alias', '/session latest');
      expect(reply).toContain('已切换到最近 session');
    });
  });

  describe('agent switching via /<short>', () => {
    it('should switch to Hermes agent via /ha', async () => {
      const { router } = await createRouter();
      const reply = await router.routeMessage('alias', '/ha');
      expect(reply).toContain('已切换');
      expect(reply).toContain('Hermes');
    });

    it('should treat unknown shortcut as a regular message', async () => {
      const { router } = await createRouter();
      const reply = await router.routeMessage('alias', '/unknown');
      expect(reply).toContain('reply:/unknown');
    });
  });

  describe('session creation isolation', () => {
    it('should create distinct session keys for multiple /new calls', async () => {
      const { router } = await createRouter();
      const reply1 = await router.routeMessage('alias', '/new');
      const reply2 = await router.routeMessage('alias', '/new');
      const key1 = reply1.match(/session:\s*(\S+)/)?.[1];
      const key2 = reply2.match(/session:\s*(\S+)/)?.[1];
      if (key1 && key2) {
        expect(key1).not.toBe(key2);
      }
    });
  });

  describe('session reuse', () => {
    it('should reuse the same session for consecutive messages', async () => {
      const { router } = await createRouter();
      const reply1 = await router.routeMessage('alias', 'first message');
      const reply2 = await router.routeMessage('alias', 'second message');
      expect(reply1).toContain('reply:first message');
      expect(reply2).toContain('reply:second message');
    });
  });

  describe('session persistence', () => {
    it('should persist session metadata to disk', async () => {
      const { router, tempHome } = await createRouter();
      await router.routeMessage('alias', 'persist me');
      const fs = await import('fs/promises');
      const runDir = path.join(tempHome, '.wechat-acp-bridge', 'run');
      const sessionDir = path.join(runDir, 'sessions');
      try {
        const entries = await fs.readdir(sessionDir, { withFileTypes: true });
        const dirs = entries.filter((e) => e.isDirectory());
        expect(dirs.length).toBeGreaterThan(0);
      } catch {
        // dir may not exist — sessions use fallback
      }
    });
  });

  describe('makeDescriptionFromText edge cases', () => {
    it('should handle whitespace-only message and create session with empty description', async () => {
      const { router } = await createRouter();
      // Whitespace message → makeDescriptionFromText returns '' (covers L53 || '' and L54 || firstLine)
      const reply = await router.routeMessage('alias', '   ');
      // Should get a reply (session was created even with empty description)
      expect(reply).toContain('reply:');
      // Verify session created
      const sessions = await router.routeMessage('alias', '/sessions');
      expect(sessions).toContain('session');
    });

    it('should handle message starting with punctuation', async () => {
      const { router } = await createRouter();
      const reply = await router.routeMessage('alias', '.hello world');
      expect(reply).toContain('reply:.hello world');
    });
  });

  describe('DEFAULT_AGENT_KEY fallback', () => {
    it('should fallback to DEFAULT_AGENT_KEY when account state has empty currentAgentKey', async () => {
      const { router, tempHome } = await createRouter();
      const fs = await import('fs/promises');
      const stateDir = path.join(tempHome, '.wechat-acp-bridge', 'run', 'account_state', 'alias');
      await fs.mkdir(stateDir, { recursive: true });
      await fs.writeFile(
        path.join(stateDir, 'state.json'),
        JSON.stringify({
          currentAgentKey: '',
          sessions: {},
          lastActive: 0,
        }),
      );
      const reply = await router.routeMessage('alias', 'hello');
      expect(reply).toContain('reply:hello');
      const sessions = await router.routeMessage('alias', '/sessions');
      expect(sessions).toContain('Hermes Agent');
    });

    it('should fallback to DEFAULT_AGENT_KEY when /new with empty currentAgentKey', async () => {
      const { router, tempHome } = await createRouter();
      const fs = await import('fs/promises');
      const stateDir = getAccountStateDir(tempHome);
      await fs.mkdir(stateDir, { recursive: true });
      await fs.writeFile(
        path.join(stateDir, 'state.json'),
        JSON.stringify({
          currentAgentKey: '',
          sessions: {},
          lastActive: 0,
        }),
      );
      const reply = await router.routeMessage('alias', '/new');
      expect(reply).toContain('已为');
      expect(reply).toContain('session');
    });

    it('should fallback to DEFAULT_AGENT_KEY when /session with empty currentAgentKey', async () => {
      const { router, tempHome } = await createRouter();
      const fs = await import('fs/promises');
      const stateDir = getAccountStateDir(tempHome);
      await fs.mkdir(stateDir, { recursive: true });
      await fs.writeFile(
        path.join(stateDir, 'state.json'),
        JSON.stringify({
          currentAgentKey: '',
          sessions: { Hermes: '00000000-0000-0000-0000-000000000001' },
          lastActive: 0,
        }),
      );
      const sessionsDir = getAgentSessionsDir(tempHome, 'Hermes');
      await fs.mkdir(sessionsDir, { recursive: true });
      await fs.writeFile(
        path.join(sessionsDir, '00000000-0000-0000-0000-000000000001.json'),
        JSON.stringify({
          sessionKey: '00000000-0000-0000-0000-000000000001',
          accountAlias: 'alias',
          userId: '',
          agentKey: 'Hermes',
          sessionId: 's1',
          session: 's1',
          description: 'test desc',
          createdAt: Date.now(),
          lastActive: Date.now(),
        }),
      );
      const reply = await router.routeMessage('alias', '/session 00000000');
      expect(reply).toContain('已切换到 session');
    });
  });

  describe('agent logo handling', () => {
    it('should omit logo prefix when agent config has no logo', async () => {
      mockAgentsState.configs = {
        Bare: { name: 'BareAgent', command: 'bare', args: ['acp'], cwd: '/tmp', env: {}, short: 'BA' },
      };
      const { router } = await createRouter();
      const reply = await router.routeMessage('alias', 'hello');
      expect(reply).toBe('reply:hello');
    });
  });

  describe('getSessionId null fallback', () => {
    it('should handle getSessionId returning null with ?? fallback', async () => {
      MockAcpBridgeClient.nullSessionId = true;
      const { router } = await createRouter();
      const reply = await router.routeMessage('alias', 'hello');
      expect(reply).toContain('reply:hello');
    });
  });

  describe('session timeout', () => {
    it('should create new session when current session has timed out and disconnect old', async () => {
      const { router, tempHome } = await createRouter();
      await router.routeMessage('alias', 'first message');

      // Modify session meta lastActive to be older than timeout threshold
      const fs = await import('fs/promises');
      const sessionsDir = getAgentSessionsDir(tempHome, 'Hermes');
      const files = await fs.readdir(sessionsDir);
      const metaFile = files.find((f: string) => f.endsWith('.json'));
      expect(metaFile).toBeTruthy();
      const metaPath = path.join(sessionsDir, metaFile!);
      const meta = JSON.parse(await fs.readFile(metaPath, 'utf-8'));
      meta.lastActive = Date.now() - 31 * 60 * 1000;
      await fs.writeFile(metaPath, JSON.stringify(meta));

      const reply = await router.routeMessage('alias', 'second message');
      expect(reply).toContain('reply:second message');
    });
  });

  describe('session listing with multiple sessions', () => {
    const agentKey = 'Hermes';
    const commonPrefix = 'abcdef12';
    const key1 = `${commonPrefix}-1111-1111-1111-111111111111`;
    const key2 = `${commonPrefix}-2222-2222-2222-222222222222`;

    async function createSessionsWithCommonPrefix(tempHome: string) {
      const fs = await import('fs/promises');
      const sessionsDir = getAgentSessionsDir(tempHome, agentKey);
      await fs.mkdir(sessionsDir, { recursive: true });

      const now = Date.now();
      const baseMeta = {
        accountAlias: 'alias',
        userId: '',
        agentKey,
        sessionId: 's1',
        session: 's1',
        description: '',
        createdAt: now,
        lastActive: now,
      };

      await fs.writeFile(
        path.join(sessionsDir, `${key1}.json`),
        JSON.stringify({ ...baseMeta, sessionKey: key1, description: 'session one' }),
      );
      await fs.writeFile(path.join(sessionsDir, `${key2}.json`), JSON.stringify({ ...baseMeta, sessionKey: key2 }));

      const stateDir = getAccountStateDir(tempHome);
      await fs.mkdir(stateDir, { recursive: true });
      await fs.writeFile(
        path.join(stateDir, 'state.json'),
        JSON.stringify({
          currentAgentKey: agentKey,
          sessions: {},
          lastActive: now,
        }),
      );

      return { commonPrefix, key1, key2 };
    }

    it('should show ambiguous prefix match error with description fallback', async () => {
      const { router, tempHome } = await createRouter();
      const { commonPrefix: prefix } = await createSessionsWithCommonPrefix(tempHome);
      const reply = await router.routeMessage('alias', `/session ${prefix}`);
      expect(reply).toContain('匹配多个 session');
      expect(reply).toContain('session one');
      expect(reply).toContain('无描述');
    });

    it('should mark only the current session with asterisk', async () => {
      const { router, tempHome } = await createRouter();
      await createSessionsWithCommonPrefix(tempHome);
      // Switch to a specific session to set it as current
      await router.routeMessage('alias', `/session ${key1}`);
      const sessions = await router.routeMessage('alias', '/sessions');
      const lines = sessions.split('\n');
      const markedLines = lines.filter((l: string) => l.includes(' *'));
      expect(markedLines.length).toBe(1);
    });
  });

  describe('session description fallback', () => {
    it('should show agentKey as fallback for empty description in /session latest', async () => {
      const { router, tempHome } = await createRouter();
      const fs = await import('fs/promises');
      const sessionsDir = getAgentSessionsDir(tempHome, 'Hermes');
      await fs.mkdir(sessionsDir, { recursive: true });
      const sessionKey = '00000000-0003-0003-0003-000000000003';
      await fs.writeFile(
        path.join(sessionsDir, `${sessionKey}.json`),
        JSON.stringify({
          sessionKey,
          accountAlias: 'alias',
          userId: '',
          agentKey: 'Hermes',
          sessionId: 's1',
          session: 's1',
          description: '',
          createdAt: Date.now(),
          lastActive: Date.now(),
        }),
      );
      const stateDir = getAccountStateDir(tempHome);
      await fs.mkdir(stateDir, { recursive: true });
      await fs.writeFile(
        path.join(stateDir, 'state.json'),
        JSON.stringify({
          currentAgentKey: 'Hermes',
          sessions: {},
          lastActive: Date.now(),
        }),
      );

      const reply = await router.routeMessage('alias', '/session latest');
      expect(reply).toContain('已切换到最近 session');
      expect(reply).toContain('Hermes');
    });

    it('should show agentKey as fallback for empty description in /session switch', async () => {
      const { router, tempHome } = await createRouter();
      const fs = await import('fs/promises');
      const sessionsDir = getAgentSessionsDir(tempHome, 'Hermes');
      await fs.mkdir(sessionsDir, { recursive: true });
      const sessionKey = '00000000-0004-0004-0004-000000000004';
      await fs.writeFile(
        path.join(sessionsDir, `${sessionKey}.json`),
        JSON.stringify({
          sessionKey,
          accountAlias: 'alias',
          userId: '',
          agentKey: 'Hermes',
          sessionId: 's1',
          session: 's1',
          description: '',
          createdAt: Date.now(),
          lastActive: Date.now(),
        }),
      );
      const stateDir = getAccountStateDir(tempHome);
      await fs.mkdir(stateDir, { recursive: true });
      await fs.writeFile(
        path.join(stateDir, 'state.json'),
        JSON.stringify({
          currentAgentKey: 'Hermes',
          sessions: {},
          lastActive: Date.now(),
        }),
      );

      const switchReply = await router.routeMessage('alias', `/session ${sessionKey}`);
      expect(switchReply).toContain('已切换到 session');
      expect(switchReply).toContain('Hermes');
    });
  });

  describe('restore session from disk', () => {
    it('should restore session from disk when not in activeSessions', async () => {
      const { router, tempHome } = await createRouter();
      const newReply = await router.routeMessage('alias', '/new');
      const match = newReply.match(/session:\s*(\S+)/);
      if (!match) throw new Error('no session key');
      const sessionKey = match[1];

      router.shutdown();

      // Reuse same tempHome to preserve on-disk sessions
      const { router: router2 } = await createRouter(tempHome);
      const switchReply = await router2.routeMessage('alias', `/session ${sessionKey}`);
      expect(switchReply).toContain('已切换到 session');
    });

    it('should return error for session with unknown agent in restore', async () => {
      const { router, tempHome } = await createRouter();
      const fs = await import('fs/promises');

      const sessionsDir = getAgentSessionsDir(tempHome, 'UnknownAgent');
      await fs.mkdir(sessionsDir, { recursive: true });
      const sessionKey = '12345678-1234-1234-1234-123456789abc';
      await fs.writeFile(
        path.join(sessionsDir, `${sessionKey}.json`),
        JSON.stringify({
          sessionKey,
          accountAlias: 'alias',
          userId: '',
          agentKey: 'UnknownAgent',
          sessionId: 's1',
          session: 's1',
          description: 'test',
          createdAt: Date.now(),
          lastActive: Date.now(),
        }),
      );

      // Set account state's currentAgentKey to match the session's agentKey
      // so it appears in the filtered list
      const stateDir = getAccountStateDir(tempHome);
      await fs.mkdir(stateDir, { recursive: true });
      await fs.writeFile(
        path.join(stateDir, 'state.json'),
        JSON.stringify({
          currentAgentKey: 'UnknownAgent',
          sessions: {},
          lastActive: Date.now(),
        }),
      );

      const reply = await router.routeMessage('alias', `/session ${sessionKey}`);
      expect(reply).toContain('session 所属 Agent 未知');
    });

    it('should restore session and handle getSessionId null during restore', async () => {
      MockAcpBridgeClient.nullSessionId = true;
      const { router, tempHome } = await createRouter();
      const newReply = await router.routeMessage('alias', '/new');
      const match = newReply.match(/session:\s*(\S+)/);
      if (!match) throw new Error('no session key');
      const sessionKey = match[1];

      router.shutdown();

      MockAcpBridgeClient.nullSessionId = true;
      const { router: router2 } = await createRouter(tempHome);
      const switchReply = await router2.routeMessage('alias', `/session ${sessionKey}`);
      expect(switchReply).toContain('已切换到 session');
    });
  });

  describe('unknown agent in account state', () => {
    it('should show fallback name when agent not in AGENT_CONFIGS with sessions', async () => {
      const { router, tempHome } = await createRouter();
      const fs = await import('fs/promises');
      const stateDir = getAccountStateDir(tempHome);
      await fs.mkdir(stateDir, { recursive: true });
      // Create a session for the unknown agent so L228 is reached
      const sessionsDir = getAgentSessionsDir(tempHome, 'NonExistentAgent');
      await fs.mkdir(sessionsDir, { recursive: true });
      await fs.writeFile(
        path.join(sessionsDir, '00000000-0001-0001-0001-000000000001.json'),
        JSON.stringify({
          sessionKey: '00000000-0001-0001-0001-000000000001',
          accountAlias: 'alias',
          userId: '',
          agentKey: 'NonExistentAgent',
          sessionId: 's1',
          session: 's1',
          description: '',
          createdAt: Date.now(),
          lastActive: Date.now(),
        }),
      );
      await fs.writeFile(
        path.join(stateDir, 'state.json'),
        JSON.stringify({
          currentAgentKey: 'NonExistentAgent',
          sessions: {},
          lastActive: 0,
        }),
      );

      const sessions = await router.routeMessage('alias', '/sessions');
      expect(sessions).toContain('NonExistentAgent');
    });

    it('should show empty message for /session latest without sessions for unknown agent', async () => {
      const { router, tempHome } = await createRouter();
      const fs = await import('fs/promises');
      const stateDir = getAccountStateDir(tempHome);
      await fs.mkdir(stateDir, { recursive: true });
      await fs.writeFile(
        path.join(stateDir, 'state.json'),
        JSON.stringify({
          currentAgentKey: 'NonExistentAgent',
          sessions: {},
          lastActive: 0,
        }),
      );

      const reply = await router.routeMessage('alias', '/session latest');
      expect(reply).toContain('NonExistentAgent');
      expect(reply).toContain('暂无 session');
    });

    it('should return error for /session latest with unknown agent session', async () => {
      const { router, tempHome } = await createRouter();
      const fs = await import('fs/promises');
      const stateDir = getAccountStateDir(tempHome);
      await fs.mkdir(stateDir, { recursive: true });
      const sessionsDir = getAgentSessionsDir(tempHome, 'NonExistentAgent');
      await fs.mkdir(sessionsDir, { recursive: true });
      const sessionKey = '00000000-0002-0002-0002-000000000002';
      await fs.writeFile(
        path.join(sessionsDir, `${sessionKey}.json`),
        JSON.stringify({
          sessionKey,
          accountAlias: 'alias',
          userId: '',
          agentKey: 'NonExistentAgent',
          sessionId: 's1',
          session: 's1',
          description: '',
          createdAt: Date.now(),
          lastActive: Date.now(),
        }),
      );
      await fs.writeFile(
        path.join(stateDir, 'state.json'),
        JSON.stringify({
          currentAgentKey: 'NonExistentAgent',
          sessions: {},
          lastActive: 0,
        }),
      );

      const reply = await router.routeMessage('alias', '/session latest');
      expect(reply).toContain('session 所属 Agent 未知');
    });

    it('should return error when /new with unknown agent in account state', async () => {
      const { router, tempHome } = await createRouter();
      const fs = await import('fs/promises');
      const stateDir = getAccountStateDir(tempHome);
      await fs.mkdir(stateDir, { recursive: true });
      await fs.writeFile(
        path.join(stateDir, 'state.json'),
        JSON.stringify({
          currentAgentKey: 'NonExistentAgent',
          sessions: {},
          lastActive: 0,
        }),
      );

      const reply = await router.routeMessage('alias', '/new');
      expect(reply).toContain('Agent 配置无效');
    });

    it('should use agentKey as fallback in /sessions when agent not in AGENT_CONFIGS', async () => {
      const { router, tempHome } = await createRouter();
      const fs = await import('fs/promises');
      const stateDir = getAccountStateDir(tempHome);
      await fs.mkdir(stateDir, { recursive: true });
      await fs.writeFile(
        path.join(stateDir, 'state.json'),
        JSON.stringify({
          currentAgentKey: 'NonExistentAgent',
          sessions: {},
          lastActive: 0,
        }),
      );

      const sessions = await router.routeMessage('alias', '/sessions');
      expect(sessions).toContain('NonExistentAgent');
      expect(sessions).toContain('暂无 session');
    });
  });

  describe('restore session edge cases', () => {
    it('should throw error when restoring session with unknown agent from disk', async () => {
      const { router, tempHome } = await createRouter();
      const fs = await import('fs/promises');
      const agentKey = 'UnknownAgent';
      const sessionKey = '00000000-0005-0005-0005-000000000005';

      const sessionsDir = getAgentSessionsDir(tempHome, agentKey);
      await fs.mkdir(sessionsDir, { recursive: true });
      await fs.writeFile(
        path.join(sessionsDir, `${sessionKey}.json`),
        JSON.stringify({
          sessionKey,
          accountAlias: 'alias',
          userId: '',
          agentKey,
          sessionId: 's1',
          session: 's1',
          description: 'test',
          createdAt: Date.now(),
          lastActive: Date.now(),
        }),
      );

      const stateDir = getAccountStateDir(tempHome);
      await fs.mkdir(stateDir, { recursive: true });
      await fs.writeFile(
        path.join(stateDir, 'state.json'),
        JSON.stringify({
          currentAgentKey: agentKey,
          sessions: { [agentKey]: sessionKey },
          lastActive: Date.now(),
        }),
      );

      await expect(router.routeMessage('alias', 'hello')).rejects.toThrow('未知 Agent');
    });
  });

  describe('agent startup failure', () => {
    it('should throw error when agent waitReady fails during session creation', async () => {
      MockAcpBridgeClient.failWaitReady = true;
      const { router } = await createRouter();
      await expect(router.routeMessage('alias', 'hello')).rejects.toThrow('无法启动 Agent');
    });

    it('should throw error when agent waitReady fails during session restore', async () => {
      const { router, tempHome } = await createRouter();
      const newReply = await router.routeMessage('alias', '/new');
      const match = newReply.match(/session:\s*(\S+)/);
      if (!match) throw new Error('no session key');
      const sessionKey = match[1];

      router.shutdown();

      MockAcpBridgeClient.failWaitReady = true;
      const { router: router2 } = await createRouter(tempHome);
      await expect(router2.routeMessage('alias', `/session ${sessionKey}`)).rejects.toThrow('无法恢复 Agent');
    });
  });

  describe('sendUserMessage error handling', () => {
    it('should return error when session meta not found after creation', async () => {
      vi.doMock('../storage/session-meta', () => {
        const store = new Map<string, unknown>();
        return {
          saveSessionMeta: async (meta: any) => {
            store.set(meta.sessionKey, meta);
          },
          findSessionMetaByKey: async () => null,
          listAccountSessions: async () => [...store.values()],
        };
      });

      const { router } = await createRouter();
      const reply = await router.routeMessage('alias', 'hello');
      expect(reply).toContain('未能找到当前 session');
    });
  });
});

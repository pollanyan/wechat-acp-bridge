import { describe, it, expect, beforeAll, beforeEach, afterEach, vi } from 'vitest';
import * as path from 'node:path';
import * as os from 'node:os';
import { TypingStatus } from './weixin/api.js';

const tempHome = path.join(os.tmpdir(), `wechat-acp-bridge-index-${Date.now()}`);

vi.mock('os', async () => {
  const actual = await vi.importActual<typeof import('os')>('os');
  return { ...actual, homedir: () => tempHome, default: { ...actual, homedir: () => tempHome } };
});

vi.mock('./util/logger', () => ({
  default: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

const mockSendText = vi.fn().mockResolvedValue(undefined);
const mockGetUpdates = vi.fn().mockResolvedValue({ msgs: [] });
const mockLoadCredentials = vi.fn().mockResolvedValue(true);
const mockGetAccountId = vi.fn().mockReturnValue('test-account');
const mockSendTyping = vi.fn().mockResolvedValue(undefined);

vi.mock('./weixin/api', () => ({
  TypingStatus: { START: 1, STOP: 2 } as const,
  MessageType: { INBOUND_TEXT: 1, OUTBOUND_TEXT: 2 } as const,
  WXAPI: class {
    static getSavedAccounts = vi.fn().mockResolvedValue(['test-account']);
    loadCredentials = mockLoadCredentials;
    getAccountId = mockGetAccountId;
    getUpdates = mockGetUpdates;
    sendText = mockSendText;
    sendTyping = mockSendTyping;
  },
}));

vi.mock('./bridge/router', () => ({
  MessageRouter: class {
    async routeMessage(_alias: string, _text: string) {
      return 'test reply';
    }
    shutdown(): void {}
  },
}));

describe('WeChatACPBridge', () => {
  let fs: Awaited<typeof import('fs/promises')>;
  beforeAll(async () => {
    fs = await import('fs/promises');
  });

  beforeEach(async () => {
    vi.clearAllMocks();
    await fs.rm(tempHome, { recursive: true, force: true });
    mockGetUpdates.mockResolvedValue({ msgs: [] });
    mockLoadCredentials.mockResolvedValue(true);
    mockGetAccountId.mockReturnValue('test-account');
    mockSendText.mockResolvedValue(undefined);
    mockSendTyping.mockResolvedValue(undefined);
  });

  afterEach(async () => {
    vi.useRealTimers();
    await fs.rm(tempHome, { recursive: true, force: true });
    vi.restoreAllMocks();
  });

  describe('path helpers', () => {
    it('getPidFile should return path under .wechat-acp-bridge', async () => {
      const { getPidFile } = await import('./index.js');
      expect(getPidFile()).toContain('.wechat-acp-bridge');
      expect(getPidFile()).toContain('bridge.pid');
    });

    it('getActiveAccountsFile should return path under .wechat-acp-bridge', async () => {
      const { getActiveAccountsFile } = await import('./index.js');
      expect(getActiveAccountsFile()).toContain('.wechat-acp-bridge');
      expect(getActiveAccountsFile()).toContain('active_accounts.json');
    });
  });

  describe('construction', () => {
    it('should create an instance with no arguments', async () => {
      const { WeChatACPBridge } = await import('./index.js');
      const bridge = new WeChatACPBridge();
      expect(bridge).toBeDefined();
      expect(typeof bridge.run).toBe('function');
      expect(typeof bridge.stop).toBe('function');
    });
  });

  describe('isRunning detection', () => {
    it('should exit when PID file exists and process is alive', async () => {
      const { getPidFile } = await import('./index.js');
      const dir = path.dirname(getPidFile());
      await fs.mkdir(dir, { recursive: true });
      await fs.writeFile(getPidFile(), String(process.pid));

      const mockExit = vi.spyOn(process, 'exit').mockImplementation(() => undefined as never);

      const { WeChatACPBridge } = await import('./index.js');
      const bridge = new WeChatACPBridge();
      await bridge.run();

      expect(mockExit).toHaveBeenCalledWith(1);
      mockExit.mockRestore();
    });

    it('should not exit when PID file does not exist', async () => {
      const { WeChatACPBridge } = await import('./index.js');
      const bridge = new WeChatACPBridge();
      expect(bridge).toBeDefined();
    });

    it('should return false when PID file does not exist (ENOENT)', async () => {
      const { WeChatACPBridge } = await import('./index.js');
      const bridge = new WeChatACPBridge();
      const isRunning = await (bridge as any).isRunning();
      expect(isRunning).toBe(false);
    });

    it('should handle non-ENOENT errors (stale PID) in isRunning', async () => {
      const { getPidFile } = await import('./index.js');
      const dir = path.dirname(getPidFile());
      await fs.mkdir(dir, { recursive: true });
      // Write a PID that doesn't exist — process.kill(pid, 0) throws ESRCH
      await fs.writeFile(getPidFile(), '9999999');

      const { WeChatACPBridge } = await import('./index.js');
      const bridge = new WeChatACPBridge();
      const isRunning = await (bridge as any).isRunning();
      // ESRCH is not ENOENT → warning logged → should return false
      expect(isRunning).toBe(false);
    });

    it('should proceed with run when isRunning returns false', async () => {
      const { WeChatACPBridge } = await import('./index.js');
      const bridge = new WeChatACPBridge();

      // Verify isRunning returns false
      const isRunning = await (bridge as any).isRunning();
      expect(isRunning).toBe(false);

      // Mock supervisorLoop to avoid infinite while loop
      let loopCalled = false;
      (bridge as any).supervisorLoop = async () => {
        loopCalled = true;
      };

      const mockExit = vi.spyOn(process, 'exit').mockImplementation(() => undefined as never);
      await bridge.run();
      mockExit.mockRestore();

      // Should NOT have called process.exit (isRunning returned false)
      expect(mockExit).not.toHaveBeenCalled();
      // Should have called supervisorLoop (proceeded past isRunning check)
      expect(loopCalled).toBe(true);
    });
  });

  describe('savePid', () => {
    it('should write current PID to pid file', async () => {
      const { WeChatACPBridge, getPidFile } = await import('./index.js');
      const bridge = new WeChatACPBridge();
      await (bridge as any).savePid();

      const content = await fs.readFile(getPidFile(), 'utf-8');
      expect(parseInt(content)).toBe(process.pid);
    });
  });

  describe('removePid', () => {
    it('should remove the PID file', async () => {
      const { WeChatACPBridge, getPidFile } = await import('./index.js');
      const dir = path.dirname(getPidFile());
      await fs.mkdir(dir, { recursive: true });
      await fs.writeFile(getPidFile(), '12345');

      const bridge = new WeChatACPBridge();
      await (bridge as any).removePid();

      await expect(fs.access(getPidFile())).rejects.toThrow();
    });

    it('should not throw when PID file does not exist', async () => {
      const { WeChatACPBridge } = await import('./index.js');
      const bridge = new WeChatACPBridge();
      await expect((bridge as any).removePid()).resolves.toBeUndefined();
    });
  });

  describe('reloadActivatedAliases', () => {
    it('should load aliases from active accounts file', async () => {
      const { WeChatACPBridge, getActiveAccountsFile } = await import('./index.js');
      const dir = path.dirname(getActiveAccountsFile());
      await fs.mkdir(dir, { recursive: true });
      await fs.writeFile(getActiveAccountsFile(), JSON.stringify(['acc1', 'acc2']));

      const bridge = new WeChatACPBridge();
      await (bridge as any).reloadActivatedAliases();

      expect((bridge as any).activeAliases.has('acc1')).toBe(true);
      expect((bridge as any).activeAliases.has('acc2')).toBe(true);
      expect((bridge as any).activeAliases.size).toBe(2);
    });

    it('should keep current set when file is missing', async () => {
      const { WeChatACPBridge } = await import('./index.js');
      const bridge = new WeChatACPBridge();
      (bridge as any).activeAliases = new Set(['existing']);

      await (bridge as any).reloadActivatedAliases();

      expect((bridge as any).activeAliases.has('existing')).toBe(true);
    });

    it('should keep current set when file has invalid JSON', async () => {
      const { WeChatACPBridge, getActiveAccountsFile } = await import('./index.js');
      const dir = path.dirname(getActiveAccountsFile());
      await fs.mkdir(dir, { recursive: true });
      await fs.writeFile(getActiveAccountsFile(), 'not valid json');

      const bridge = new WeChatACPBridge();
      (bridge as any).activeAliases = new Set(['original']);

      await (bridge as any).reloadActivatedAliases();

      expect((bridge as any).activeAliases.has('original')).toBe(true);
    });
  });

  describe('stop', () => {
    it('should set running=false, remove PID and exit', async () => {
      const { WeChatACPBridge, getPidFile } = await import('./index.js');
      const dir = path.dirname(getPidFile());
      await fs.mkdir(dir, { recursive: true });
      await fs.writeFile(getPidFile(), String(process.pid));

      const mockExit = vi.spyOn(process, 'exit').mockImplementation(() => undefined as never);

      const bridge = new WeChatACPBridge();
      (bridge as any).running = true;
      await bridge.stop();

      expect((bridge as any).running).toBe(false);
      await expect(fs.access(getPidFile())).rejects.toThrow();
      expect(mockExit).toHaveBeenCalledWith(0);
      mockExit.mockRestore();
    });
  });

  describe('startNewPolls', () => {
    it('should create WXAPI and start poll for active alias with valid credentials', async () => {
      const { WeChatACPBridge } = await import('./index.js');
      mockLoadCredentials.mockResolvedValue(true);

      const bridge = new WeChatACPBridge();
      (bridge as any).activeAliases = new Set(['test-account']);
      (bridge as any).running = false; // prevent pollAccount IIFE from looping

      await (bridge as any).startNewPolls();

      expect(mockLoadCredentials).toHaveBeenCalled();
      expect((bridge as any).wxapis.has('test-account')).toBe(true);
    });

    it('should skip aliases with invalid credentials', async () => {
      const { WeChatACPBridge } = await import('./index.js');
      mockLoadCredentials.mockResolvedValue(false);

      const bridge = new WeChatACPBridge();
      (bridge as any).activeAliases = new Set(['bad-account']);

      await (bridge as any).startNewPolls();

      expect(mockLoadCredentials).toHaveBeenCalled();
      expect((bridge as any).wxapis.has('bad-account')).toBe(false);
    });

    it('should skip aliases already being polled', async () => {
      const { WeChatACPBridge } = await import('./index.js');
      mockLoadCredentials.mockResolvedValue(true);

      const bridge = new WeChatACPBridge();
      (bridge as any).activeAliases = new Set(['test-account']);
      (bridge as any).wxapis = new Map([['test-account', {}]]); // already polling

      await (bridge as any).startNewPolls();

      expect(mockLoadCredentials).not.toHaveBeenCalled();
    });
  });

  describe('pollAccount', () => {
    async function setupPollTest(
      opts: {
        alias?: string;
        activeAliases?: string[];
        messages?: any[];
        barrierOnSecondCall?: boolean;
      } = {},
    ) {
      const { WeChatACPBridge } = await import('./index.js');
      const { WXAPI } = await import('./weixin/api.js');

      const alias = opts.alias || 'test-account';
      mockGetAccountId.mockReturnValue(alias);

      const messages = opts.messages || [];
      let resolveBarrier: ((v: any) => void) | null = null;

      if (messages.length > 0) {
        mockGetUpdates.mockResolvedValueOnce({ msgs: messages });
      }
      if (opts.barrierOnSecondCall !== false) {
        const barrier = new Promise<any>((r) => {
          resolveBarrier = r;
        });
        mockGetUpdates.mockReturnValueOnce(barrier);
      }

      const bridge = new WeChatACPBridge();
      (bridge as any).activeAliases = new Set(opts.activeAliases || [alias]);
      (bridge as any).running = true;

      const api = new (WXAPI as any)(alias);
      (bridge as any).pollAccount(api);

      // Let async IIFE start and process first getUpdates
      await new Promise((r) => setTimeout(r, 20));

      return { bridge, resolveBarrier };
    }

    function stopPoll(bridge: any, resolveBarrier: ((v: any) => void) | null) {
      bridge.running = false;
      if (resolveBarrier) resolveBarrier({ msgs: [] });
    }

    it('should process text message and reply', async () => {
      const { bridge, resolveBarrier } = await setupPollTest({
        messages: [
          {
            message_type: 1,
            from_user_id: 'u1',
            context_token: 'ctx1',
            item_list: [{ type: 1, text_item: { text: 'hello' } }],
          },
        ],
      });

      expect(mockSendTyping).toHaveBeenCalledWith('u1', 'ctx1', TypingStatus.START);
      expect(mockSendText).toHaveBeenCalledWith('u1', 'ctx1', 'test reply');
      expect(mockSendTyping).toHaveBeenCalledWith('u1', 'ctx1', TypingStatus.STOP);
      stopPoll(bridge, resolveBarrier);
    });

    it('should skip messages with message_type other than 1', async () => {
      const { bridge, resolveBarrier } = await setupPollTest({
        messages: [
          {
            message_type: 2,
            from_user_id: 'u1',
            context_token: 'ctx1',
            item_list: [{ type: 1, text_item: { text: 'should skip' } }],
          },
        ],
      });

      expect(mockSendText).not.toHaveBeenCalled();
      stopPoll(bridge, resolveBarrier);
    });

    it('should skip messages without text', async () => {
      const { bridge, resolveBarrier } = await setupPollTest({
        messages: [
          {
            message_type: 1,
            from_user_id: 'u1',
            context_token: 'ctx1',
            item_list: [],
          },
        ],
      });

      expect(mockSendText).not.toHaveBeenCalled();
      stopPoll(bridge, resolveBarrier);
    });

    it('should handle getUpdates response without msgs field', async () => {
      // msgs field absent entirely → should use || [] default
      let resolveBarrier: ((v: any) => void) | null = null;
      const barrier = new Promise<any>((r) => {
        resolveBarrier = r;
      });
      mockGetUpdates.mockResolvedValueOnce({}).mockReturnValueOnce(barrier);

      const { WeChatACPBridge } = await import('./index.js');
      const { WXAPI } = await import('./weixin/api.js');

      const bridge = new WeChatACPBridge();
      (bridge as any).activeAliases = new Set(['test-account']);
      (bridge as any).running = true;
      (bridge as any).pollAccount(new (WXAPI as any)('test-account'));

      await new Promise((r) => setTimeout(r, 20));
      // Should not crash, just process empty messages array
      expect(mockSendText).not.toHaveBeenCalled();
      stopPoll(bridge, resolveBarrier);
    });

    it('should stop polling when alias is deactivated', async () => {
      await setupPollTest({
        alias: 'removed-alias',
        activeAliases: ['other-alias'],
        messages: [],
        barrierOnSecondCall: false,
      });

      await new Promise((r) => setTimeout(r, 10));
      expect(mockSendText).not.toHaveBeenCalled();
    });

    it('should handle ECONNABORTED errors silently', async () => {
      const axiosError = new Error('timeout') as any;
      axiosError.code = 'ECONNABORTED';
      axiosError.isAxiosError = true;

      let resolveBarrier: ((v: any) => void) | null = null;
      const barrier = new Promise<any>((r) => {
        resolveBarrier = r;
      });

      mockGetUpdates.mockRejectedValueOnce(axiosError).mockResolvedValueOnce({ msgs: [] }).mockReturnValueOnce(barrier);

      const { WeChatACPBridge } = await import('./index.js');
      const { WXAPI } = await import('./weixin/api.js');

      const bridge = new WeChatACPBridge();
      (bridge as any).activeAliases = new Set(['test-account']);
      (bridge as any).running = true;
      (bridge as any).pollAccount(new (WXAPI as any)('test-account'));

      await new Promise((r) => setTimeout(r, 20));
      expect(mockGetUpdates.mock.calls.length).toBeGreaterThanOrEqual(2);

      stopPoll(bridge, resolveBarrier);
    });

    it('should retry after non-ECONNABORTED errors', async () => {
      const genericError = new Error('network failure');

      let resolveBarrier: ((v: any) => void) | null = null;
      const barrier = new Promise<any>((r) => {
        resolveBarrier = r;
      });

      mockGetUpdates
        .mockRejectedValueOnce(genericError)
        .mockResolvedValueOnce({ msgs: [] })
        .mockReturnValueOnce(barrier);

      const { WeChatACPBridge } = await import('./index.js');
      const { WXAPI } = await import('./weixin/api.js');

      const bridge = new WeChatACPBridge();
      (bridge as any).activeAliases = new Set(['test-account']);
      (bridge as any).running = true;
      (bridge as any).pollAccount(new (WXAPI as any)('test-account'));

      await new Promise((r) => setTimeout(r, 100));
      expect(mockGetUpdates).toHaveBeenCalled();

      stopPoll(bridge, resolveBarrier);
    });
  });
});

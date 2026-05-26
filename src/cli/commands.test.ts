import { describe, it, expect, beforeEach, afterEach, vi, type Mock } from 'vitest';
import * as path from 'node:path';
import * as os from 'node:os';

const tempHome = path.join(os.tmpdir(), `wechat-acp-bridge-cmd-${Date.now()}`);
const runDir = path.join(tempHome, '.wechat-acp-bridge', 'run');

vi.mock('os', async () => {
  const actual = await vi.importActual<typeof import('os')>('os');
  return { ...actual, homedir: () => tempHome };
});

const mockFileContents = new Map<string, string>();
const mockWriteFileSync = vi.fn();
const mockMkdirSync = vi.fn();

vi.mock('fs', async () => {
  const actual = await vi.importActual<typeof import('fs')>('fs');
  return {
    ...actual,
    readFileSync: vi.fn((filePath: string, encoding?: string) => {
      const key = filePath as string;
      if (mockFileContents.has(key)) {
        const content = mockFileContents.get(key)!;
        if (content === '__THROW__') throw new Error('ENOENT: file not found');
        return content;
      }
      return actual.readFileSync(filePath, encoding as BufferEncoding);
    }),
    writeFileSync: mockWriteFileSync,
    mkdirSync: mockMkdirSync,
    promises: actual.promises,
    watch: actual.watch,
    createReadStream: actual.createReadStream,
    constants: actual.constants,
  };
});

vi.mock('path', async () => {
  const actual = await vi.importActual<typeof import('path')>('path');
  return { ...actual };
});

const registeredCommands: Array<{
  name: string;
  description: string;
  options: string[];
}> = [];

const commandActions = new Map<string, (...args: unknown[]) => unknown>();

interface MockCommand {
  description(desc: string): MockCommand;
  option(opt: string): MockCommand;
  action(fn: (...args: unknown[]) => unknown): MockCommand;
  command(subCmd: string): MockCommand;
}

function createMockCommand(name: string) {
  const entry: { name: string; description: string; options: string[] } = {
    name,
    description: '',
    options: [],
  };
  registeredCommands.push(entry);

  const cmd: MockCommand = {
    description(desc: string) {
      entry.description = desc;
      return cmd;
    },
    option(opt: string) {
      entry.options.push(opt);
      return cmd;
    },
    action(fn: (...args: unknown[]) => unknown) {
      commandActions.set(name, fn);
      return cmd;
    },
    command(subCmd: string) {
      return createMockCommand(subCmd);
    },
  };
  return cmd;
}

const mockProgram = {
  name: vi.fn().mockReturnThis(),
  version: vi.fn().mockReturnThis(),
  addHelpText: vi.fn().mockReturnThis(),
  command(cmd: string) {
    return createMockCommand(cmd);
  },
  parse: vi.fn(),
};

vi.mock('commander', () => ({
  Command: vi.fn(function () {
    return mockProgram;
  }),
}));

const mockApiLogin = vi.fn();
let mockLoadCredentialsResult = true;
const lastWxapiCtorIds: string[] = [];

// Separate fns for static methods so we can reference them outside vi.mock hoisting
const mockGetSavedAccounts = vi.fn().mockResolvedValue([]);
const mockDeleteSavedAccount = vi.fn().mockResolvedValue(true);

interface WXAPIMockCtor {
  (this: Record<string, unknown>, id: string): WXAPIMockInstance;
  getSavedAccounts: typeof mockGetSavedAccounts;
  deleteSavedAccount: typeof mockDeleteSavedAccount;
}
interface WXAPIMockInstance {
  loadCredentials: ReturnType<typeof vi.fn>;
  login: typeof mockApiLogin;
  getAccountId: () => string;
}

vi.mock('../weixin/api', () => {
  const WXAPIMock = vi.fn(function (this: Record<string, unknown>, _id: string) {
    lastWxapiCtorIds.push(_id);
    this.loadCredentials = vi.fn().mockImplementation(() => Promise.resolve(mockLoadCredentialsResult));
    this.login = mockApiLogin;
    this.getAccountId = () => 'test-account';
    return this;
  }) as unknown as WXAPIMockCtor;
  WXAPIMock.getSavedAccounts = mockGetSavedAccounts;
  WXAPIMock.deleteSavedAccount = mockDeleteSavedAccount;
  return { WXAPI: WXAPIMock };
});

const mockBridgeRun = vi.fn();
const mockBridgeStop = vi.fn();

vi.mock('../index', () => ({
  WeChatACPBridge: vi.fn(function (this: any) {
    this.run = mockBridgeRun;
    this.stop = mockBridgeStop;
    return this;
  }),
  getPidFile: vi.fn(() => path.join(runDir, 'bridge.pid')),
  getActiveAccountsFile: vi.fn(() => path.join(runDir, 'active_accounts.json')),
}));

const mockServiceStatus = vi
  .fn()
  .mockResolvedValue({ backend: 'none', installed: false, running: false, enabled: false });
const mockServiceStart = vi.fn().mockResolvedValue(undefined);
const mockServiceStop = vi.fn().mockResolvedValue(undefined);
const mockServiceRestart = vi.fn().mockResolvedValue(undefined);
const mockServiceInstall = vi.fn().mockResolvedValue(undefined);
const mockServiceUninstall = vi.fn().mockResolvedValue(undefined);

vi.mock('../service/manager', () => ({
  getServiceManager: vi.fn(async () => ({
    status: mockServiceStatus,
    start: mockServiceStart,
    stop: mockServiceStop,
    restart: mockServiceRestart,
    install: mockServiceInstall,
    uninstall: mockServiceUninstall,
  })),
}));

vi.mock('../service/types', () => ({
  ServiceError: class extends Error {
    name = 'ServiceError';
    constructor(
      message: string,
      public backend: string,
    ) {
      super(message);
    }
  },
}));

vi.mock('../util/logger', () => ({
  default: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
  getLogFilePath: vi.fn(() => path.join(runDir, 'logs', 'bridge.log')),
  getLogLevel: vi.fn(() => 'warn'),
  setLogLevel: vi.fn((level: string) => level),
}));

vi.mock('inquirer', () => ({
  default: {
    prompt: vi.fn(),
  },
}));

async function loadCommands() {
  registeredCommands.length = 0;
  commandActions.clear();
  vi.resetModules();
  await import('./commands.js');
}

describe('CLI commands registration', () => {
  beforeEach(async () => {
    mockFileContents.clear();
    mockWriteFileSync.mockClear();
    mockMkdirSync.mockClear();
    vi.clearAllMocks();
    mockApiLogin.mockReset();
    mockBridgeRun.mockReset();
    mockBridgeStop.mockReset();
    lastWxapiCtorIds.length = 0;
    mockServiceStart.mockReset();
    mockServiceStop.mockReset();
    mockServiceRestart.mockReset();
    mockServiceInstall.mockReset();
    mockServiceUninstall.mockReset();
    mockGetSavedAccounts.mockResolvedValue([]);
    mockDeleteSavedAccount.mockResolvedValue(true);
    mockLoadCredentialsResult = true;
    mockApiLogin.mockResolvedValue({
      token: 'test-token',
      baseUrl: 'https://example.com',
      accountId: 'bot-123',
    });

    mockMkdirSync(path.join(runDir), { recursive: true });
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  describe('command registration', () => {
    beforeEach(async () => {
      await loadCommands();
    });

    it('should register all 13 expected commands', () => {
      const names = registeredCommands.map((c) => c.name);
      expect(names).toEqual(
        expect.arrayContaining([
          'login [alias]',
          'run',
          'start',
          'stop',
          'restart',
          'install',
          'uninstall',
          'activate <alias>',
          'deactivate <alias>',
          'list',
          'logout <accountId>',
          'logs',
          'status [alias]',
        ]),
      );
      expect(names.length).toBe(13);
    });

    it('should register login command with description and --force option', () => {
      const login = registeredCommands.find((c) => c.name === 'login [alias]');
      expect(login).toBeDefined();
      expect(login!.description).toContain('登录');
      expect(login!.options).toEqual(
        expect.arrayContaining([expect.stringContaining('-f'), expect.stringContaining('--force')]),
      );
    });

    it('should register run command with description', () => {
      const run = registeredCommands.find((c) => c.name === 'run');
      expect(run).toBeDefined();
      expect(run!.description).toContain('前台');
    });

    it('should register start command with description', () => {
      const start = registeredCommands.find((c) => c.name === 'start');
      expect(start).toBeDefined();
      expect(start!.description).toContain('启动');
    });

    it('should register stop command with description', () => {
      const stop = registeredCommands.find((c) => c.name === 'stop');
      expect(stop).toBeDefined();
      expect(stop!.description).toContain('停止');
    });

    it('should register restart command with description', () => {
      const restart = registeredCommands.find((c) => c.name === 'restart');
      expect(restart).toBeDefined();
      expect(restart!.description).toContain('重启');
    });

    it('should register install command with description', () => {
      const install = registeredCommands.find((c) => c.name === 'install');
      expect(install).toBeDefined();
      expect(install!.description).toContain('安装');
    });

    it('should register uninstall command with description', () => {
      const uninstall = registeredCommands.find((c) => c.name === 'uninstall');
      expect(uninstall).toBeDefined();
      expect(uninstall!.description).toContain('卸载');
    });

    it('should register activate command with description', () => {
      const activate = registeredCommands.find((c) => c.name === 'activate <alias>');
      expect(activate).toBeDefined();
      expect(activate!.description).toContain('激活');
    });

    it('should register deactivate command with description', () => {
      const deactivate = registeredCommands.find((c) => c.name === 'deactivate <alias>');
      expect(deactivate).toBeDefined();
      expect(deactivate!.description).toContain('去激活');
    });

    it('should register list command', () => {
      const list = registeredCommands.find((c) => c.name === 'list');
      expect(list).toBeDefined();
      expect(list!.description).toContain('列出');
    });

    it('should register logout command', () => {
      const logout = registeredCommands.find((c) => c.name === 'logout <accountId>');
      expect(logout).toBeDefined();
      expect(logout!.description).toContain('删除');
    });

    it('should register logs command', () => {
      const logs = registeredCommands.find((c) => c.name === 'logs');
      expect(logs).toBeDefined();
      expect(logs!.description).toContain('日志');
    });

    it('should register status command', () => {
      const status = registeredCommands.find((c) => c.name === 'status [alias]');
      expect(status).toBeDefined();
      expect(status!.description).toContain('状态');
    });
  });

  describe('login action', () => {
    beforeEach(async () => {
      await loadCommands();
    });

    it('should login when no existing credentials', async () => {
      mockLoadCredentialsResult = false;
      const action = commandActions.get('login [alias]')!;
      await action('myalias', { force: false });

      expect(mockApiLogin).toHaveBeenCalledTimes(1);
    });

    it('should login when force flag is set despite existing credentials', async () => {
      mockLoadCredentialsResult = true;
      const action = commandActions.get('login [alias]')!;
      await action('myalias', { alias: 'forced', force: true });

      expect(mockApiLogin).toHaveBeenCalledTimes(1);
    });

    it('should prompt when credentials exist and no force flag', async () => {
      mockLoadCredentialsResult = true;
      const inquirer = await import('inquirer');
      interface InquirerMock {
        prompt: ReturnType<typeof vi.fn>;
      }
      (inquirer.default as unknown as InquirerMock).prompt.mockResolvedValueOnce({ forceLogin: false });

      const action = commandActions.get('login [alias]')!;
      await action('myalias', { force: false });

      expect(inquirer.default.prompt).toHaveBeenCalled();
      expect(mockApiLogin).not.toHaveBeenCalled();
    });

    it('should proceed with login when user confirms re-login prompt', async () => {
      mockLoadCredentialsResult = true;
      const inquirer = await import('inquirer');
      interface InquirerMock {
        prompt: ReturnType<typeof vi.fn>;
      }
      (inquirer.default as unknown as InquirerMock).prompt.mockResolvedValueOnce({ forceLogin: true });

      const action = commandActions.get('login [alias]')!;
      await action('myalias', { force: false });

      expect(mockApiLogin).toHaveBeenCalledTimes(1);
    });

    it('should use alias option over positional argument', async () => {
      mockLoadCredentialsResult = false;
      const action = commandActions.get('login [alias]')!;
      await action('pos', { alias: 'opt-alias', force: true });

      expect(mockApiLogin).toHaveBeenCalled();
      // Verify that the option value was used, not the positional
      expect(lastWxapiCtorIds[lastWxapiCtorIds.length - 1]).toBe('opt-alias');
    });

    it('should display userId when returned from login', async () => {
      mockLoadCredentialsResult = false;
      mockApiLogin.mockResolvedValue({
        token: 'test-token',
        baseUrl: 'https://example.com',
        accountId: 'bot-123',
        userId: 'user-456',
      });
      const loggerModule = await import('..//util/logger.js');
      const mockLogger = loggerModule.default as unknown as { info: Mock };

      const action = commandActions.get('login [alias]')!;
      await action('myalias', { force: false });

      const infoMessages = mockLogger.info.mock.calls.map((c: unknown[]) => String(c[0]));
      expect(infoMessages.some((m: string) => m.includes('User ID: user-456'))).toBe(true);
    });

    it('should warn when auto-activation fails during login', async () => {
      mockLoadCredentialsResult = false;
      mockWriteFileSync.mockImplementationOnce(() => {
        throw new Error('write failed');
      });
      const loggerModule = await import('..//util/logger.js');
      const mockLogger = loggerModule.default as unknown as { warn: Mock };

      const action = commandActions.get('login [alias]')!;
      await action('newalias', { force: false });

      const warnMessages = mockLogger.warn.mock.calls.map((c: unknown[]) => String(c[0]));
      expect(warnMessages.some((m: string) => m.includes('无法更新激活账号列表'))).toBe(true);
    });

    it('should use --alias option when no positional argument given', async () => {
      mockLoadCredentialsResult = false;
      const action = commandActions.get('login [alias]')!;
      await action(undefined, { alias: 'yanxiaoyu' });

      expect(mockApiLogin).toHaveBeenCalled();
      expect(lastWxapiCtorIds[lastWxapiCtorIds.length - 1]).toBe('yanxiaoyu');
    });

    it('should fallback to default when both positional and option are missing', async () => {
      mockLoadCredentialsResult = false;
      const action = commandActions.get('login [alias]')!;
      await action(undefined, {});

      expect(mockApiLogin).toHaveBeenCalled();
      expect(lastWxapiCtorIds[lastWxapiCtorIds.length - 1]).toBe('default');
    });

    it('should use positional argument when no --alias option', async () => {
      mockLoadCredentialsResult = false;
      const action = commandActions.get('login [alias]')!;
      await action('myalias', {});

      expect(mockApiLogin).toHaveBeenCalled();
      expect(lastWxapiCtorIds[lastWxapiCtorIds.length - 1]).toBe('myalias');
    });

    it('should skip reactivation when alias already in active list', async () => {
      mockLoadCredentialsResult = false;
      const activeFile = path.join(runDir, 'active_accounts.json');
      mockFileContents.set(activeFile, JSON.stringify(['existing']));

      const action = commandActions.get('login [alias]')!;
      await action('existing', { force: true });

      expect(mockApiLogin).toHaveBeenCalled();
      // Should not rewrite active_accounts.json (already there)
      const activeWrites = mockWriteFileSync.mock.calls.filter((c: unknown[]) => c[0] === activeFile);
      expect(activeWrites.length).toBe(0);
    });
  });

  describe('run action', () => {
    beforeEach(async () => {
      await loadCommands();
    });

    it('should detect running service and skip run', async () => {
      const pidFile = path.join(runDir, 'bridge.pid');
      mockFileContents.set(pidFile, String(process.pid));

      const action = commandActions.get('run')!;
      await action();

      expect(mockBridgeRun).not.toHaveBeenCalled();
    });

    it('should warn when no active accounts', async () => {
      const activeFile = path.join(runDir, 'active_accounts.json');
      mockFileContents.set(activeFile, '[]');

      const action = commandActions.get('run')!;
      await action();

      expect(mockBridgeRun).toHaveBeenCalled();
    });

    it('should run bridge with active accounts', async () => {
      const activeFile = path.join(runDir, 'active_accounts.json');
      mockFileContents.set(activeFile, JSON.stringify(['acc1', 'acc2']));

      const action = commandActions.get('run')!;
      await action();

      expect(mockBridgeRun).toHaveBeenCalled();
    });

    it('should display agent key as name when agent not in config', async () => {
      const activeFile = path.join(runDir, 'active_accounts.json');
      mockFileContents.set(activeFile, JSON.stringify(['unknown-agent-account']));

      // Set up account state with non-existent agent key
      const stateDir = path.join(runDir, 'account_state', 'unknown-agent-account');
      mockMkdirSync(stateDir, { recursive: true });
      mockFileContents.set(
        path.join(stateDir, 'state.json'),
        JSON.stringify({ currentAgentKey: 'NonExistentAgent', sessions: {}, lastActive: Date.now() }),
      );

      const loggerModule = await import('..//util/logger.js');
      const mockLogger = loggerModule.default as unknown as { info: Mock };

      const action = commandActions.get('run')!;
      await action();

      expect(mockBridgeRun).toHaveBeenCalled();
      const infoMessages = mockLogger.info.mock.calls.map((c: unknown[]) => String(c[0]));
      expect(infoMessages.some((m: string) => m.includes('NonExistentAgent'))).toBe(true);
    });
  });

  describe('start action (service)', () => {
    beforeEach(async () => {
      await loadCommands();
    });

    it('should start via service manager when installed and not running', async () => {
      mockServiceStatus.mockResolvedValue({ backend: 'systemd', installed: true, running: false, enabled: true });

      const action = commandActions.get('start')!;
      await action();

      expect(mockServiceStart).toHaveBeenCalled();
    });

    it('should skip when service already running', async () => {
      mockServiceStatus.mockResolvedValue({
        backend: 'systemd',
        installed: true,
        running: true,
        enabled: true,
        pid: 1234,
      });

      const action = commandActions.get('start')!;
      await action();

      expect(mockServiceStart).not.toHaveBeenCalled();
    });

    it('should error when service not installed', async () => {
      mockServiceStatus.mockResolvedValue({ backend: 'systemd', installed: false, running: false, enabled: false });

      const action = commandActions.get('start')!;
      await action();

      expect(mockServiceStart).not.toHaveBeenCalled();
    });

    it('should log ServiceError message when start fails', async () => {
      const { ServiceError } = await import('..//service/types.js');
      mockServiceStatus.mockResolvedValue({ backend: 'systemd', installed: true, running: false, enabled: true });
      mockServiceStart.mockRejectedValue(new ServiceError('test start error', 'systemd'));
      const loggerModule = await import('..//util/logger.js');
      const mockLogger = loggerModule.default as unknown as { error: Mock };

      const action = commandActions.get('start')!;
      await action();

      const errorMessages = mockLogger.error.mock.calls.map((c: unknown[]) => String(c[0]));
      expect(errorMessages.some((m: string) => m.includes('启动失败: test start error'))).toBe(true);
    });

    it('should log non-ServiceError when start fails unexpectedly', async () => {
      mockServiceStatus.mockResolvedValue({ backend: 'systemd', installed: true, running: false, enabled: true });
      mockServiceStart.mockRejectedValue(new Error('unexpected'));
      const loggerModule = await import('..//util/logger.js');
      const mockLogger = loggerModule.default as unknown as { error: Mock };

      const action = commandActions.get('start')!;
      await action();

      const errorMessages = mockLogger.error.mock.calls.map((c: unknown[]) => String(c[0]));
      expect(errorMessages.some((m: string) => m.includes('启动失败'))).toBe(true);
    });

    it('should display unknown pid when running but pid missing', async () => {
      mockServiceStatus.mockResolvedValue({
        backend: 'systemd',
        installed: true,
        running: true,
        enabled: true,
      });
      // pid is undefined — triggers "pid ?? 'unknown'"

      const action = commandActions.get('start')!;
      await action();

      expect(mockServiceStart).not.toHaveBeenCalled();
    });
  });

  describe('stop action', () => {
    beforeEach(async () => {
      await loadCommands();
    });

    it('should stop via service manager when installed and running', async () => {
      mockServiceStatus.mockResolvedValue({
        backend: 'systemd',
        installed: true,
        running: true,
        enabled: true,
        pid: 1234,
      });

      const action = commandActions.get('stop')!;
      await action();

      expect(mockServiceStop).toHaveBeenCalled();
    });

    it('should fallback to PID signal when no service installed', async () => {
      mockServiceStatus.mockResolvedValue({ backend: 'systemd', installed: false, running: false, enabled: false });
      const pidFile = path.join(runDir, 'bridge.pid');
      mockFileContents.set(pidFile, String(process.pid));
      const mockKill = vi.spyOn(process, 'kill').mockImplementation(() => true);

      const action = commandActions.get('stop')!;
      await action();

      expect(mockKill).toHaveBeenCalledWith(process.pid, 'SIGTERM');
      mockKill.mockRestore();
    });

    it('should error when no service and no PID file', async () => {
      mockServiceStatus.mockResolvedValue({ backend: 'none', installed: false, running: false, enabled: false });

      const action = commandActions.get('stop')!;
      await action();
    });

    it('should log non-ServiceError when stop fails with unexpected error', async () => {
      mockServiceStatus.mockResolvedValue({ backend: 'systemd', installed: true, running: true, enabled: true });
      mockServiceStop.mockRejectedValue(new Error('unexpected stop error'));
      const loggerModule = await import('..//util/logger.js');
      const mockLogger = loggerModule.default as unknown as { error: Mock };

      const action = commandActions.get('stop')!;
      await action();

      const errorMessages = mockLogger.error.mock.calls.map((c: unknown[]) => String(c[0]));
      expect(errorMessages.some((m: string) => m.includes('停止后台服务失败'))).toBe(true);
    });

    it('should silently handle ServiceError during stop (no error log)', async () => {
      const { ServiceError } = await import('..//service/types.js');
      mockServiceStatus.mockResolvedValue({ backend: 'systemd', installed: true, running: true, enabled: true });
      mockServiceStop.mockRejectedValue(new ServiceError('svc stop err', 'systemd'));
      const loggerModule = await import('..//util/logger.js');
      const mockLogger = loggerModule.default as unknown as { error: Mock };

      const action = commandActions.get('stop')!;
      await action();

      const errorMessages = mockLogger.error.mock.calls.map((c: unknown[]) => String(c[0]));
      expect(errorMessages.some((m: string) => m.includes('停止后台服务失败'))).toBe(false);
    });
  });

  describe('restart action', () => {
    beforeEach(async () => {
      await loadCommands();
    });

    it('should call service manager restart', async () => {
      const action = commandActions.get('restart')!;
      await action();

      expect(mockServiceRestart).toHaveBeenCalled();
    });

    it('should handle ServiceError', async () => {
      const { ServiceError } = await import('../service/types.js');
      mockServiceRestart.mockRejectedValue(new ServiceError('failed', 'systemd'));

      const action = commandActions.get('restart')!;
      await action();

      expect(mockServiceRestart).toHaveBeenCalled();
    });

    it('should log non-ServiceError when restart fails unexpectedly', async () => {
      mockServiceRestart.mockRejectedValue(new Error('unexpected restart error'));
      const loggerModule = await import('..//util/logger.js');
      const mockLogger = loggerModule.default as unknown as { error: Mock };

      const action = commandActions.get('restart')!;
      await action();

      const errorMessages = mockLogger.error.mock.calls.map((c: unknown[]) => String(c[0]));
      expect(errorMessages.some((m: string) => m.includes('重启失败'))).toBe(true);
    });
  });

  describe('install action', () => {
    beforeEach(async () => {
      await loadCommands();
    });

    it('should call service manager install', async () => {
      const action = commandActions.get('install')!;
      await action();

      expect(mockServiceInstall).toHaveBeenCalled();
    });

    it('should handle ServiceError on install', async () => {
      const { ServiceError } = await import('../service/types.js');
      mockServiceInstall.mockRejectedValue(new ServiceError('install failed', 'systemd'));

      const action = commandActions.get('install')!;
      await action();

      expect(mockServiceInstall).toHaveBeenCalled();
    });

    it('should log non-ServiceError when install fails unexpectedly', async () => {
      mockServiceInstall.mockRejectedValue(new Error('unexpected install error'));
      const loggerModule = await import('..//util/logger.js');
      const mockLogger = loggerModule.default as unknown as { error: Mock };

      const action = commandActions.get('install')!;
      await action();

      const errorMessages = mockLogger.error.mock.calls.map((c: unknown[]) => String(c[0]));
      expect(errorMessages.some((m: string) => m.includes('安装失败'))).toBe(true);
    });
  });

  describe('uninstall action', () => {
    beforeEach(async () => {
      await loadCommands();
    });

    it('should call service manager uninstall', async () => {
      const action = commandActions.get('uninstall')!;
      await action();

      expect(mockServiceUninstall).toHaveBeenCalled();
    });

    it('should handle ServiceError on uninstall', async () => {
      const { ServiceError } = await import('../service/types.js');
      mockServiceUninstall.mockRejectedValue(new ServiceError('uninstall failed', 'systemd'));

      const action = commandActions.get('uninstall')!;
      await action();

      expect(mockServiceUninstall).toHaveBeenCalled();
    });

    it('should log non-ServiceError when uninstall fails unexpectedly', async () => {
      mockServiceUninstall.mockRejectedValue(new Error('unexpected uninstall error'));
      const loggerModule = await import('..//util/logger.js');
      const mockLogger = loggerModule.default as unknown as { error: Mock };

      const action = commandActions.get('uninstall')!;
      await action();

      const errorMessages = mockLogger.error.mock.calls.map((c: unknown[]) => String(c[0]));
      expect(errorMessages.some((m: string) => m.includes('卸载失败'))).toBe(true);
    });
  });

  describe('activate action', () => {
    beforeEach(async () => {
      await loadCommands();
    });

    it('should activate an account with valid credentials', async () => {
      mockLoadCredentialsResult = true;
      const activeFile = path.join(runDir, 'active_accounts.json');
      mockFileContents.set(activeFile, '[]');

      const action = commandActions.get('activate <alias>')!;
      await action('newalias');

      expect(mockWriteFileSync).toHaveBeenCalledWith(activeFile, JSON.stringify(['newalias'], null, 2));
    });

    it('should error when credentials are invalid', async () => {
      mockLoadCredentialsResult = false;

      const action = commandActions.get('activate <alias>')!;
      await action('badalias');
    });

    it('should skip when account already active', async () => {
      mockLoadCredentialsResult = true;
      const activeFile = path.join(runDir, 'active_accounts.json');
      mockFileContents.set(activeFile, JSON.stringify(['existing']));

      const action = commandActions.get('activate <alias>')!;
      await action('existing');

      const calls = mockWriteFileSync.mock.calls.filter((c: unknown[]) => c[0] === activeFile);
      expect(calls.length).toBe(0);
    });
  });

  describe('deactivate action', () => {
    beforeEach(async () => {
      await loadCommands();
    });

    it('should deactivate an active account', async () => {
      mockLoadCredentialsResult = true;
      const activeFile = path.join(runDir, 'active_accounts.json');
      mockFileContents.set(activeFile, JSON.stringify(['acc1', 'acc2']));

      const action = commandActions.get('deactivate <alias>')!;
      await action('acc1');

      expect(mockWriteFileSync).toHaveBeenCalledWith(activeFile, JSON.stringify(['acc2'], null, 2));
    });

    it('should error when credentials are invalid', async () => {
      mockLoadCredentialsResult = false;

      const action = commandActions.get('deactivate <alias>')!;
      await action('bad');
    });

    it('should skip when account is not active', async () => {
      mockLoadCredentialsResult = true;
      const activeFile = path.join(runDir, 'active_accounts.json');
      mockFileContents.set(activeFile, JSON.stringify(['other']));

      const action = commandActions.get('deactivate <alias>')!;
      await action('not-in-list');

      const calls = mockWriteFileSync.mock.calls.filter((c: unknown[]) => c[0] === activeFile);
      expect(calls.length).toBe(0);
    });
  });

  describe('list action', () => {
    beforeEach(async () => {
      await loadCommands();
    });

    it('should show error when no accounts saved', async () => {
      mockGetSavedAccounts.mockResolvedValue([]);

      const action = commandActions.get('list')!;
      await action();
    });

    it('should list all saved accounts with status', async () => {
      mockGetSavedAccounts.mockResolvedValue(['acc1', 'acc2']);
      mockLoadCredentialsResult = true;
      const activeFile = path.join(runDir, 'active_accounts.json');
      mockFileContents.set(activeFile, JSON.stringify(['acc1']));

      const action = commandActions.get('list')!;
      await action();
    });

    it('should show expired status for accounts with invalid credentials', async () => {
      mockGetSavedAccounts.mockResolvedValue(['expired']);
      mockLoadCredentialsResult = false;

      const action = commandActions.get('list')!;
      await action();
    });
  });

  describe('logout action', () => {
    beforeEach(async () => {
      await loadCommands();
    });

    it('should delete account and remove from active list', async () => {
      mockDeleteSavedAccount.mockResolvedValue(true);
      const activeFile = path.join(runDir, 'active_accounts.json');
      mockFileContents.set(activeFile, JSON.stringify(['target', 'other']));

      const action = commandActions.get('logout <accountId>')!;
      await action('target');

      expect(mockWriteFileSync).toHaveBeenCalledWith(activeFile, JSON.stringify(['other'], null, 2));
    });

    it('should delete account even when not in active list', async () => {
      mockDeleteSavedAccount.mockResolvedValue(true);
      const activeFile = path.join(runDir, 'active_accounts.json');
      mockFileContents.set(activeFile, JSON.stringify(['other']));

      const action = commandActions.get('logout <accountId>')!;
      await action('target');

      // should not write to active file since target wasn't in it
      const activeCalls = mockWriteFileSync.mock.calls.filter((c: unknown[]) =>
        String(c[0]).includes('active_accounts'),
      );
      expect(activeCalls.length).toBe(0);
    });

    it('should error when account not found', async () => {
      mockDeleteSavedAccount.mockResolvedValue(false);

      const action = commandActions.get('logout <accountId>')!;
      await action('nonexistent');
    });

    it('should handle writeActiveAliases failure gracefully', async () => {
      mockDeleteSavedAccount.mockResolvedValue(true);
      const activeFile = path.join(runDir, 'active_accounts.json');
      mockFileContents.set(activeFile, JSON.stringify(['target']));
      mockMkdirSync.mockImplementationOnce(() => {
        throw new Error('permission denied');
      });

      const action = commandActions.get('logout <accountId>')!;
      await action('target');
      // Should not throw, catch block logs success message
    });
  });

  describe('logs action', () => {
    beforeEach(async () => {
      await loadCommands();
    });

    it('should set log level when --level flag provided', async () => {
      const { setLogLevel } = await import('../util/logger.js');

      const action = commandActions.get('logs')!;
      await action({ level: 'DEBUG' });

      expect(setLogLevel).toHaveBeenCalledWith('DEBUG');
    });

    it('should show log file path without flags', async () => {
      const action = commandActions.get('logs')!;
      await action({});
    });

    it('should handle --follow with non-existent log file', async () => {
      const mockExit = vi.spyOn(process, 'exit').mockImplementation(() => undefined as never);

      const action = commandActions.get('logs')!;
      await action({ follow: true });

      // followLogFile runs asynchronously after action returns
      await new Promise((r) => setTimeout(r, 100));

      expect(mockExit).toHaveBeenCalled();
      mockExit.mockRestore();
    });

    it('should follow existing log file and exit on SIGINT', async () => {
      const actualFs = await vi.importActual<typeof import('node:fs')>('node:fs');
      const tmpDir = actualFs.mkdtempSync(path.join(os.tmpdir(), 'follow-test-'));
      const logFile = path.join(tmpDir, 'test.log');
      actualFs.writeFileSync(logFile, 'line 1\n');

      // Override getLogFilePath to return our temp file
      const { getLogFilePath } = await import('..//util/logger.js');
      (getLogFilePath as Mock).mockReturnValue(logFile);

      const mockExit = vi.spyOn(process, 'exit').mockImplementation(() => undefined as never);
      const mockStdout = vi.spyOn(process.stdout, 'write').mockImplementation(() => true);

      const action = commandActions.get('logs')!;
      action({ follow: true }); // don't await — async follow

      // Give followLogFile time to set up (access, stat, read, watch, promise)
      await new Promise((r) => setTimeout(r, 300));

      // Append to trigger file change watcher
      actualFs.appendFileSync(logFile, 'line 2\n');
      await new Promise((r) => setTimeout(r, 300));

      // Emit SIGINT to trigger cleanup and exit
      process.emit('SIGINT' as unknown as NodeJS.Signals);
      await new Promise((r) => setTimeout(r, 100));

      expect(mockExit).toHaveBeenCalledWith(0);

      mockExit.mockRestore();
      mockStdout.mockRestore();
      process.removeAllListeners('SIGINT');
      actualFs.rmSync(tmpDir, { recursive: true, force: true });
    });

    it('should show error when setLogLevel throws', async () => {
      const mockExit = vi.spyOn(process, 'exit').mockImplementation(() => undefined as never);
      const { setLogLevel } = await import('../util/logger.js');
      (setLogLevel as Mock).mockImplementationOnce(() => {
        throw new Error('invalid level');
      });

      const action = commandActions.get('logs')!;
      await action({ level: 'INVALID' });

      expect(mockExit).toHaveBeenCalledWith(1);
      mockExit.mockRestore();
    });

    it('should handle setLogLevel error without message property', async () => {
      const mockExit = vi.spyOn(process, 'exit').mockImplementation(() => undefined as never);
      const { setLogLevel } = await import('../util/logger.js');
      (setLogLevel as Mock).mockImplementationOnce(() => {
        throw 'string error';
      });

      const action = commandActions.get('logs')!;
      await action({ level: 'INVALID' });

      expect(mockExit).toHaveBeenCalledWith(1);
      mockExit.mockRestore();
    });
  });

  describe('status action', () => {
    beforeEach(async () => {
      await loadCommands();
    });

    it('should show status for a specific logged-in alias', async () => {
      mockLoadCredentialsResult = true;
      const activeFile = path.join(runDir, 'active_accounts.json');
      mockFileContents.set(activeFile, JSON.stringify(['testalias']));

      const action = commandActions.get('status [alias]')!;
      await action('testalias', {});
    });

    it('should show error for non-logged-in alias', async () => {
      mockLoadCredentialsResult = false;

      const action = commandActions.get('status [alias]')!;
      await action('noalias', {});
    });

    it('should show logged-in but not activated status', async () => {
      mockLoadCredentialsResult = true;
      const activeFile = path.join(runDir, 'active_accounts.json');
      mockFileContents.set(activeFile, '[]');
      const loggerModule = await import('..//util/logger.js');
      const mockLogger = loggerModule.default as unknown as { info: Mock };

      const action = commandActions.get('status [alias]')!;
      await action('testalias', {});

      const infoMessages = mockLogger.info.mock.calls.map((c: unknown[]) => String(c[0]));
      expect(infoMessages.some((m: string) => m.includes('testalias 已登录'))).toBe(true);
      expect(infoMessages.filter((m: string) => m.includes('已激活')).length).toBe(0);
    });

    it('should list all accounts when no alias specified', async () => {
      mockGetSavedAccounts.mockResolvedValue(['acc1']);
      mockLoadCredentialsResult = true;
      const activeFile = path.join(runDir, 'active_accounts.json');
      mockFileContents.set(activeFile, JSON.stringify(['acc1']));

      const action = commandActions.get('status [alias]')!;
      await action(undefined, {});
    });

    it('should show expired status for accounts with invalid credentials', async () => {
      mockGetSavedAccounts.mockResolvedValue(['expired', 'active']);
      mockLoadCredentialsResult = false;
      const activeFile = path.join(runDir, 'active_accounts.json');
      mockFileContents.set(activeFile, JSON.stringify(['active']));
      const loggerModule = await import('..//util/logger.js');
      const mockLogger = loggerModule.default as unknown as { info: Mock };

      const action = commandActions.get('status [alias]')!;
      await action(undefined, {});

      const infoMessages = mockLogger.info.mock.calls.map((c: unknown[]) => String(c[0]));
      expect(infoMessages.some((m: string) => m.includes('已失效'))).toBe(true);
    });

    it('should list all accounts without agent suffix when no account state', async () => {
      mockGetSavedAccounts.mockResolvedValue(['fresh']);
      mockLoadCredentialsResult = true;
      const activeFile = path.join(runDir, 'active_accounts.json');
      mockFileContents.set(activeFile, JSON.stringify(['fresh']));
      const loggerModule = await import('../util/logger.js');
      const mockLogger = loggerModule.default as unknown as { info: Mock };

      const action = commandActions.get('status [alias]')!;
      await action(undefined, {});

      const infoMessages = mockLogger.info.mock.calls.map((c: unknown[]) => String(c[0]));
      // Should NOT include "Agent:" since no account state exists
      expect(infoMessages.some((m: string) => m.includes('Agent:'))).toBe(false);
      expect(infoMessages.some((m: string) => m.includes('fresh'))).toBe(true);
      expect(infoMessages.some((m: string) => m.includes('已激活'))).toBe(true);
    });

    it('should list accounts with unknown agent key as fallback display', async () => {
      mockGetSavedAccounts.mockResolvedValue(['unknown']);
      mockLoadCredentialsResult = true;
      const activeFile = path.join(runDir, 'active_accounts.json');
      mockFileContents.set(activeFile, JSON.stringify(['unknown']));
      // Create account state with unknown agent
      const stateDir = path.join(runDir, 'account_state', 'unknown');
      mockFileContents.set(
        path.join(stateDir, 'state.json'),
        JSON.stringify({
          currentAgentKey: 'NonExistentAgent',
          sessions: {},
          lastActive: Date.now(),
        }),
      );
      const loggerModule = await import('../util/logger.js');
      const mockLogger = loggerModule.default as unknown as { info: Mock };

      const action = commandActions.get('status [alias]')!;
      await action(undefined, {});

      const infoMessages = mockLogger.info.mock.calls.map((c: unknown[]) => String(c[0]));
      expect(infoMessages.some((m: string) => m.includes('Agent: NonExistentAgent'))).toBe(true);
    });

    it('should show error when no accounts and no alias', async () => {
      mockGetSavedAccounts.mockResolvedValue([]);

      const action = commandActions.get('status [alias]')!;
      await action(undefined, {});
    });

    it('should use --alias option for status when no positional given', async () => {
      mockLoadCredentialsResult = true;
      const activeFile = path.join(runDir, 'active_accounts.json');
      mockFileContents.set(activeFile, JSON.stringify(['optalias']));

      const action = commandActions.get('status [alias]')!;
      await action(undefined, { alias: 'optalias' });

      // Verify WXAPI constructed with the option value
      expect(lastWxapiCtorIds[lastWxapiCtorIds.length - 1]).toBe('optalias');
    });

    it('should prefer --alias option over positional in status', async () => {
      mockLoadCredentialsResult = true;
      const activeFile = path.join(runDir, 'active_accounts.json');
      mockFileContents.set(activeFile, JSON.stringify(['optalias']));

      const action = commandActions.get('status [alias]')!;
      await action('pos', { alias: 'optalias' });

      expect(lastWxapiCtorIds[lastWxapiCtorIds.length - 1]).toBe('optalias');
    });
  });

  describe('status with bridge running', () => {
    beforeEach(async () => {
      const pidFile = path.join(runDir, 'bridge.pid');
      mockFileContents.set(pidFile, String(process.pid));
      await loadCommands();
    });

    it('should show bridge running status', async () => {
      mockGetSavedAccounts.mockResolvedValue([]);

      const action = commandActions.get('status [alias]')!;
      await action(undefined, {});
    });

    it('should show service status when backend is not none', async () => {
      mockServiceStatus.mockResolvedValue({
        backend: 'systemd',
        installed: true,
        running: true,
        enabled: true,
        pid: 12345,
        unitPath: '/home/test-user/.config/systemd/user/wechat-acp-bridge.service',
      });
      mockGetSavedAccounts.mockResolvedValue([]);
      const loggerModule = await import('../util/logger.js');
      const mockLogger = loggerModule.default as unknown as { info: Mock };

      const action = commandActions.get('status [alias]')!;
      await action(undefined, {});

      const infoMessages = mockLogger.info.mock.calls.map((c: unknown[]) => String(c[0]));
      expect(infoMessages.some((m: string) => m.includes('后台服务: systemd'))).toBe(true);
      expect(infoMessages.some((m: string) => m.includes('已安装: ✅'))).toBe(true);
      expect(infoMessages.some((m: string) => m.includes('已启用: ✅'))).toBe(true);
      expect(infoMessages.some((m: string) => m.includes('运行中: ✅'))).toBe(true);
      expect(infoMessages.some((m: string) => m.includes('PID: 12345'))).toBe(true);
      expect(
        infoMessages.some((m: string) =>
          m.includes('配置: /home/test-user/.config/systemd/user/wechat-acp-bridge.service'),
        ),
      ).toBe(true);
    });

    it('should warn when active_accounts.json has invalid schema', async () => {
      const activeFile = path.join(runDir, 'active_accounts.json');
      mockFileContents.set(activeFile, JSON.stringify({ not: 'an-array' }));
      mockGetSavedAccounts.mockResolvedValue(['acc1']);
      const loggerModule = await import('../util/logger.js');
      const mockLogger = loggerModule.default as unknown as { warn: Mock };

      const action = commandActions.get('status [alias]')!;
      await action(undefined, {});

      const warnMessages = mockLogger.warn.mock.calls.map((c: unknown[]) => String(c[0]));
      expect(warnMessages.some((m: string) => m.includes('active_accounts.json'))).toBe(true);
    });

    it('should show service as installed but not running when disabled', async () => {
      mockServiceStatus.mockResolvedValue({
        backend: 'systemd',
        installed: true,
        running: false,
        enabled: false,
      });
      mockGetSavedAccounts.mockResolvedValue([]);
      const loggerModule = await import('../util/logger.js');
      const mockLogger = loggerModule.default as unknown as { info: Mock };

      const action = commandActions.get('status [alias]')!;
      await action(undefined, {});

      const infoMessages = mockLogger.info.mock.calls.map((c: unknown[]) => String(c[0]));
      expect(infoMessages.some((m: string) => m.includes('已安装: ✅'))).toBe(true);
      expect(infoMessages.some((m: string) => m.includes('已启用: ❌'))).toBe(true);
      expect(infoMessages.some((m: string) => m.includes('运行中: ❌'))).toBe(true);
    });

    it('should not show service info when backend is none', async () => {
      mockServiceStatus.mockResolvedValue({
        backend: 'none',
        installed: false,
        running: false,
        enabled: false,
      });
      mockGetSavedAccounts.mockResolvedValue([]);
      const loggerModule = await import('../util/logger.js');
      const mockLogger = loggerModule.default as unknown as { info: Mock };

      const action = commandActions.get('status [alias]')!;
      await action(undefined, {});

      const infoMessages = mockLogger.info.mock.calls.map((c: unknown[]) => String(c[0]));
      expect(infoMessages.some((m: string) => m.includes('后台服务'))).toBe(false);
    });

    it('should show service as not installed when installed is false', async () => {
      mockServiceStatus.mockResolvedValue({
        backend: 'systemd',
        installed: false,
        running: false,
        enabled: false,
      });
      mockGetSavedAccounts.mockResolvedValue([]);
      const loggerModule = await import('../util/logger.js');
      const mockLogger = loggerModule.default as unknown as { info: Mock };

      const action = commandActions.get('status [alias]')!;
      await action(undefined, {});

      const infoMessages = mockLogger.info.mock.calls.map((c: unknown[]) => String(c[0]));
      expect(infoMessages.some((m: string) => m.includes('后台服务: systemd'))).toBe(true);
      expect(infoMessages.some((m: string) => m.includes('已安装: ❌'))).toBe(true);
    });
  });

  describe('status with session data', () => {
    /** Build a valid SessionMeta object with all required fields for schema validation */
    function makeSessionMeta(
      overrides: Partial<{
        sessionKey: string;
        accountAlias: string;
        userId: string;
        agentKey: string;
        sessionId: string;
        session: string;
        description: string;
        createdAt: number;
        lastActive: number;
      }> = {},
    ) {
      const now = Date.now();
      return {
        sessionKey: 'session-key-1',
        accountAlias: 'sessionalias',
        userId: '',
        agentKey: 'OpenClaw',
        sessionId: 'sid-1',
        session: 'sid-1',
        description: 'test description',
        createdAt: now - 3600000,
        lastActive: now - 120000,
        ...overrides,
      };
    }

    beforeEach(async () => {
      const activeFile = path.join(runDir, 'active_accounts.json');
      mockFileContents.set(activeFile, JSON.stringify(['sessionalias']));

      // Account state with active agent and session
      const now = Date.now();
      const stateDir = path.join(runDir, 'account_state', 'sessionalias');
      mockMkdirSync(stateDir, { recursive: true });
      mockFileContents.set(
        path.join(stateDir, 'state.json'),
        JSON.stringify({
          currentAgentKey: 'OpenClaw',
          sessions: { OpenClaw: 'session-key-1' },
          lastActive: now - 120000,
        }),
      );

      // Session metadata — full fields for schema validation
      const sessionDir = path.join(runDir, 'sessions', 'sessionalias', 'OpenClaw');
      mockMkdirSync(sessionDir, { recursive: true });
      mockFileContents.set(path.join(sessionDir, 'session-key-1.json'), JSON.stringify(makeSessionMeta()));

      mockLoadCredentialsResult = true;
      await loadCommands();
    });

    it('should show agent and session info for logged-in alias', async () => {
      const loggerModule = await import('../util/logger.js');
      const mockLogger = loggerModule.default as unknown as { info: Mock };

      const action = commandActions.get('status [alias]')!;
      await action('sessionalias', {});

      const infoMessages = mockLogger.info.mock.calls.map((c: unknown[]) => String(c[0]));
      expect(infoMessages.some((m: string) => m.includes('Session: session-key-1'))).toBe(true);
      expect(infoMessages.some((m: string) => m.includes('test description'))).toBe(true);
    });

    it('should display 无描述 when session has empty description', async () => {
      const sessionDirWithEmpty = path.join(runDir, 'sessions', 'sessionalias', 'OpenClaw');
      mockFileContents.set(
        path.join(sessionDirWithEmpty, 'session-key-1.json'),
        JSON.stringify(makeSessionMeta({ description: '' })),
      );

      const loggerModule = await import('../util/logger.js');
      const mockLogger = loggerModule.default as unknown as { info: Mock };

      const action = commandActions.get('status [alias]')!;
      await action('sessionalias', {});

      const infoMessages = mockLogger.info.mock.calls.map((c: unknown[]) => String(c[0]));
      expect(infoMessages.some((m: string) => m.includes('无描述'))).toBe(true);
    });

    it('should show recent activity as just now', async () => {
      const now = Date.now();
      const stateDir = path.join(runDir, 'account_state', 'sessionalias');
      const sessionDir = path.join(runDir, 'sessions', 'sessionalias', 'OpenClaw');

      mockFileContents.set(
        path.join(stateDir, 'state.json'),
        JSON.stringify({
          currentAgentKey: 'OpenClaw',
          sessions: { OpenClaw: 'session-key-1' },
          lastActive: now,
        }),
      );
      mockFileContents.set(
        path.join(sessionDir, 'session-key-1.json'),
        JSON.stringify(makeSessionMeta({ lastActive: now })),
      );

      const loggerModule = await import('../util/logger.js');
      const mockLogger = loggerModule.default as unknown as { info: Mock };

      const action = commandActions.get('status [alias]')!;
      await action('sessionalias', {});

      const infoMessages = mockLogger.info.mock.calls.map((c: unknown[]) => String(c[0]));
      expect(infoMessages.some((m: string) => m.includes('刚刚'))).toBe(true);
    });

    it('should show recent activity in minutes ago', async () => {
      const thirtyMinAgo = Date.now() - 30 * 60 * 1000;
      const stateDir = path.join(runDir, 'account_state', 'sessionalias');
      const sessionDir = path.join(runDir, 'sessions', 'sessionalias', 'OpenClaw');

      mockFileContents.set(
        path.join(stateDir, 'state.json'),
        JSON.stringify({
          currentAgentKey: 'OpenClaw',
          sessions: { OpenClaw: 'session-key-1' },
          lastActive: thirtyMinAgo,
        }),
      );
      mockFileContents.set(
        path.join(sessionDir, 'session-key-1.json'),
        JSON.stringify(makeSessionMeta({ lastActive: thirtyMinAgo })),
      );

      const loggerModule = await import('../util/logger.js');
      const mockLogger = loggerModule.default as unknown as { info: Mock };

      const action = commandActions.get('status [alias]')!;
      await action('sessionalias', {});

      const infoMessages = mockLogger.info.mock.calls.map((c: unknown[]) => String(c[0]));
      expect(infoMessages.some((m: string) => m.includes('30 分钟前'))).toBe(true);
    });

    it('should show recent activity in hours ago', async () => {
      const threeHoursAgo = Date.now() - 3 * 3600 * 1000;
      const stateDir = path.join(runDir, 'account_state', 'sessionalias');
      const sessionDir = path.join(runDir, 'sessions', 'sessionalias', 'OpenClaw');

      mockFileContents.set(
        path.join(stateDir, 'state.json'),
        JSON.stringify({
          currentAgentKey: 'OpenClaw',
          sessions: { OpenClaw: 'session-key-1' },
          lastActive: threeHoursAgo,
        }),
      );
      mockFileContents.set(
        path.join(sessionDir, 'session-key-1.json'),
        JSON.stringify(makeSessionMeta({ lastActive: threeHoursAgo })),
      );

      const loggerModule = await import('../util/logger.js');
      const mockLogger = loggerModule.default as unknown as { info: Mock };

      const action = commandActions.get('status [alias]')!;
      await action('sessionalias', {});

      const infoMessages = mockLogger.info.mock.calls.map((c: unknown[]) => String(c[0]));
      expect(infoMessages.some((m: string) => m.includes('小时前'))).toBe(true);
    });

    it('should show recent activity in days ago', async () => {
      const twoDaysAgo = Date.now() - 2 * 86400 * 1000;
      const stateDir = path.join(runDir, 'account_state', 'sessionalias');
      const sessionDir = path.join(runDir, 'sessions', 'sessionalias', 'OpenClaw');

      mockFileContents.set(
        path.join(stateDir, 'state.json'),
        JSON.stringify({
          currentAgentKey: 'OpenClaw',
          sessions: { OpenClaw: 'session-key-1' },
          lastActive: twoDaysAgo,
        }),
      );
      mockFileContents.set(
        path.join(sessionDir, 'session-key-1.json'),
        JSON.stringify(makeSessionMeta({ lastActive: twoDaysAgo })),
      );

      const loggerModule = await import('../util/logger.js');
      const mockLogger = loggerModule.default as unknown as { info: Mock };

      const action = commandActions.get('status [alias]')!;
      await action('sessionalias', {});

      const infoMessages = mockLogger.info.mock.calls.map((c: unknown[]) => String(c[0]));
      expect(infoMessages.some((m: string) => m.includes('天前'))).toBe(true);
    });

    it('should show status when no current agent set', async () => {
      const stateDir = path.join(runDir, 'account_state', 'sessionalias');
      mockFileContents.set(path.join(stateDir, 'state.json'), JSON.stringify({ sessions: {} }));

      const loggerModule = await import('../util/logger.js');
      const mockLogger = loggerModule.default as unknown as { info: Mock };

      const action = commandActions.get('status [alias]')!;
      await action('sessionalias', {});

      const infoMessages = mockLogger.info.mock.calls.map((c: unknown[]) => String(c[0]));
      expect(infoMessages.some((m: string) => m.includes('暂无'))).toBe(true);
    });

    it('should show session with cleaned metadata', async () => {
      // Account state has session key but metadata file doesn't exist
      const stateDir = path.join(runDir, 'account_state', 'sessionalias');
      mockFileContents.set(
        path.join(stateDir, 'state.json'),
        JSON.stringify({
          currentAgentKey: 'OpenClaw',
          sessions: { OpenClaw: 'missing-key' },
          lastActive: Date.now(),
        }),
      );

      const loggerModule = await import('../util/logger.js');
      const mockLogger = loggerModule.default as unknown as { info: Mock };

      const action = commandActions.get('status [alias]')!;
      await action('sessionalias', {});

      const infoMessages = mockLogger.info.mock.calls.map((c: unknown[]) => String(c[0]));
      expect(infoMessages.some((m: string) => m.includes('元数据已清理'))).toBe(true);
    });

    it('should show no session when state has no session key', async () => {
      const stateDir = path.join(runDir, 'account_state', 'sessionalias');
      mockFileContents.set(
        path.join(stateDir, 'state.json'),
        JSON.stringify({
          currentAgentKey: 'OpenClaw',
          sessions: {},
          lastActive: Date.now(),
        }),
      );

      const loggerModule = await import('../util/logger.js');
      const mockLogger = loggerModule.default as unknown as { info: Mock };

      const action = commandActions.get('status [alias]')!;
      await action('sessionalias', {});

      const infoMessages = mockLogger.info.mock.calls.map((c: unknown[]) => String(c[0]));
      expect(infoMessages.some((m: string) => m.includes('Session: 暂无'))).toBe(true);
    });

    it('should fallback when agents.yaml cannot be loaded', async () => {
      // __dirname in commands.ts resolves to src/cli/, so ../../config/agents.yaml → config/agents.yaml
      const agentsYamlPath = path.resolve(process.cwd(), 'config/agents.yaml');
      mockFileContents.set(agentsYamlPath, '__THROW__');

      const stateDir = path.join(runDir, 'account_state', 'sessionalias');
      mockFileContents.set(path.join(stateDir, 'state.json'), JSON.stringify({ sessions: {} }));

      const loggerModule = await import('../util/logger.js');
      const mockLogger = loggerModule.default as unknown as { info: Mock };

      // Reload commands with the __THROW__ agents.yaml in place
      await loadCommands();
      const action = commandActions.get('status [alias]')!;
      await action('sessionalias', {});

      const infoMessages = mockLogger.info.mock.calls.map((c: unknown[]) => String(c[0]));
      // Should see fallback agent name from loadAgentDisplayNames catch block
      expect(infoMessages.some((m: string) => m.includes('暂无'))).toBe(true);

      // Clean up
      mockFileContents.delete(agentsYamlPath);
    });

    it('should warn when session meta fails schema validation', async () => {
      const stateDir = path.join(runDir, 'account_state', 'sessionalias');
      const sessionDir = path.join(runDir, 'sessions', 'sessionalias', 'OpenClaw');

      mockFileContents.set(
        path.join(stateDir, 'state.json'),
        JSON.stringify({
          currentAgentKey: 'OpenClaw',
          sessions: { OpenClaw: 'invalid-key' },
          lastActive: Date.now(),
        }),
      );
      // Put invalid data — missing required fields (sessionKey, accountAlias, etc.)
      mockFileContents.set(
        path.join(sessionDir, 'invalid-key.json'),
        JSON.stringify({ description: 'bad', lastActive: 'not-a-number' }),
      );

      const loggerModule = await import('../util/logger.js');
      const mockLogger = loggerModule.default as unknown as { info: Mock; warn: Mock };

      const action = commandActions.get('status [alias]')!;
      await action('sessionalias', {});

      const warnMessages = mockLogger.warn.mock.calls.map((c: unknown[]) => String(c[0]));
      expect(warnMessages.some((m: string) => m.includes('Schema 验证失败'))).toBe(true);
    });

    it('should use agentKey as display name when not in agentNames', async () => {
      const stateDir = path.join(runDir, 'account_state', 'sessionalias');
      mockFileContents.set(
        path.join(stateDir, 'state.json'),
        JSON.stringify({
          currentAgentKey: 'UnknownAgent',
          sessions: { UnknownAgent: 'session-key-1' },
          lastActive: Date.now(),
        }),
      );
      const sessionDir = path.join(runDir, 'sessions', 'sessionalias', 'UnknownAgent');
      mockMkdirSync(sessionDir, { recursive: true });
      mockFileContents.set(
        path.join(sessionDir, 'session-key-1.json'),
        JSON.stringify(makeSessionMeta({ agentKey: 'UnknownAgent' })),
      );

      const loggerModule = await import('../util/logger.js');
      const mockLogger = loggerModule.default as unknown as { info: Mock };

      const action = commandActions.get('status [alias]')!;
      await action('sessionalias', {});

      const infoMessages = mockLogger.info.mock.calls.map((c: unknown[]) => String(c[0]));
      expect(infoMessages.some((m: string) => m.includes('UnknownAgent'))).toBe(true);
    });
  });
});

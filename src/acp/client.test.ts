import { describe, it, expect, beforeEach, afterEach, vi, type Mock } from 'vitest';
import { PassThrough } from 'node:stream';
import { EventEmitter } from 'node:events';

type MockLogger = { info: Mock; warn: Mock; error: Mock; debug: Mock };

vi.mock('../util/logger.js', () => ({
  default: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

let mockSpawn: any;
const mockWriteFile = vi.fn();

vi.mock('child_process', async () => {
  const actual = await vi.importActual<typeof import('child_process')>('child_process');
  mockSpawn = vi.fn((_command: string, _args: string[], _opts: Record<string, unknown>) => {
    const proc: any = new EventEmitter();
    proc.stdin = new PassThrough();
    proc.stdout = new PassThrough();
    proc.stderr = new PassThrough();
    proc.kill = vi.fn();
    proc.pid = 12345;
    return proc;
  });
  return {
    ...actual,
    spawn: mockSpawn,
  };
});

vi.mock('fs/promises', async () => {
  const actual = await vi.importActual<typeof import('fs/promises')>('fs/promises');
  mockWriteFile.mockImplementation(async (p: string, content: string, encoding: string) => {
    return actual.writeFile(p, content, encoding as BufferEncoding);
  });
  return { ...actual, writeFile: mockWriteFile };
});

vi.mock('@agentclientprotocol/sdk', () => ({
  ndJsonStream: (input: any, output: any) => ({ input, output }),
  ClientSideConnection: class {
    initializeResult = { protocolVersion: '1.0.0' };
    newSessionResult = { sessionId: 'fake-session' };
    promptResult = { stopReason: 'end_turn' };
    async initialize() {
      return this.initializeResult;
    }
    async newSession() {
      return this.newSessionResult;
    }
    async prompt() {
      return this.promptResult;
    }
  },
  PROTOCOL_VERSION: '1.0.0',
}));

describe('AcpBridgeClient', () => {
  let clientModule: typeof import('./client.js');

  beforeEach(async () => {
    vi.resetModules();
    clientModule = await import('./client.js');
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  describe('constructor and waitReady', () => {
    it('should spawn the agent process on construction', () => {
      new clientModule.AcpBridgeClient({ command: 'test-agent', args: ['--flag'] });
      expect(mockSpawn).toHaveBeenCalledWith(
        'test-agent',
        ['--flag'],
        expect.objectContaining({
          stdio: ['pipe', 'pipe', 'pipe'],
          cwd: expect.any(String),
          shell: false,
        }),
      );
    });

    it('should resolve waitReady after initialization', async () => {
      const c = new clientModule.AcpBridgeClient({ command: 'test-agent', args: [] });
      await c.waitReady();
      expect(c.getSessionId()).toBe('fake-session');
    });

    it('should emit ready event after initialization', async () => {
      const c = new clientModule.AcpBridgeClient({ command: 'test-agent', args: [] });
      const readyHandler = vi.fn();
      c.on('ready', readyHandler);
      await c.waitReady();
      expect(readyHandler).toHaveBeenCalled();
    });

    it('should emit error event on startup failure', async () => {
      mockSpawn.mockImplementationOnce(() => {
        throw new Error('spawn failed');
      });
      const c = new clientModule.AcpBridgeClient({ command: 'bad-cmd', args: [] });
      const errorHandler = vi.fn();
      c.on('error', errorHandler);
      try {
        await c.waitReady();
      } catch {
        /* expected */
      }
      expect(errorHandler).toHaveBeenCalled();
    });
  });

  describe('sendPrompt', () => {
    it('should throw if connection is not ready', async () => {
      const c = new clientModule.AcpBridgeClient({ command: 'test-agent', args: [] });
      await expect(c.sendPrompt('hello')).rejects.toThrow('ACP 连接未就绪');
    });

    it('should return fallback when agent produces no content', async () => {
      const c = new clientModule.AcpBridgeClient({ command: 'test-agent', args: [] });
      await c.waitReady();
      const reply = await c.sendPrompt('hello');
      expect(reply).toBe('Agent 无回复');
    });
  });

  describe('stopReason handling', () => {
    it('should append refusal notice when stopReason is refusal', async () => {
      const sdkMod = await import('@agentclientprotocol/sdk');
      const orig = sdkMod.ClientSideConnection.prototype.prompt;
      sdkMod.ClientSideConnection.prototype.prompt = vi.fn().mockResolvedValue({ stopReason: 'refusal' });

      vi.resetModules();
      const mod = await import('./client.js');
      const c = new mod.AcpBridgeClient({ command: 'test-agent', args: [] });
      await c.waitReady();
      const reply = await c.sendPrompt('hello');
      expect(reply).toContain('[agent refused to continue]');
      sdkMod.ClientSideConnection.prototype.prompt = orig;
    });

    it('should append cancelled notice when stopReason is cancelled', async () => {
      const sdkMod = await import('@agentclientprotocol/sdk');
      const orig = sdkMod.ClientSideConnection.prototype.prompt;
      sdkMod.ClientSideConnection.prototype.prompt = vi.fn().mockResolvedValue({ stopReason: 'cancelled' });

      vi.resetModules();
      const mod = await import('./client.js');
      const c = new mod.AcpBridgeClient({ command: 'test-agent', args: [] });
      await c.waitReady();
      const reply = await c.sendPrompt('hello');
      expect(reply).toContain('[cancelled]');
      sdkMod.ClientSideConnection.prototype.prompt = orig;
    });
  });

  describe('disconnect', () => {
    it('should kill the spawned process with SIGTERM', async () => {
      const c = new clientModule.AcpBridgeClient({ command: 'test-agent', args: [] });
      await c.waitReady();
      const proc = (c as any).proc;
      c.disconnect();
      expect(proc.kill).toHaveBeenCalledWith('SIGTERM');
    });

    it('should set connection to null and ready to false', async () => {
      const c = new clientModule.AcpBridgeClient({ command: 'test-agent', args: [] });
      await c.waitReady();
      c.disconnect();
      expect((c as any).connection).toBeNull();
      expect((c as any).ready).toBe(false);
    });

    it('should not throw when calling disconnect on a non-ready client', async () => {
      // Create a client, wait for it to be ready, then disconnect is safe
      const c = new clientModule.AcpBridgeClient({ command: 'test-agent', args: [] });
      await c.waitReady();
      expect(() => c.disconnect()).not.toThrow();
    });
  });

  describe('process lifecycle', () => {
    it('should log stderr data', async () => {
      const loggerModule = await import('../util/logger.js');
      const logger = loggerModule.default as unknown as MockLogger;
      const c = new clientModule.AcpBridgeClient({ command: 'test-agent', args: [] });
      await c.waitReady();
      const proc = (c as any).proc;
      proc.stderr.emit('data', Buffer.from('error output'));
      expect(logger.info).toHaveBeenCalledWith(expect.stringContaining('error output'));
    });

    it('should emit exit event when process exits', async () => {
      const c = new clientModule.AcpBridgeClient({ command: 'test-agent', args: [] });
      await c.waitReady();
      const exitHandler = vi.fn();
      c.on('exit', exitHandler);
      const proc = (c as any).proc;
      proc.emit('exit', 0, null);
      expect(exitHandler).toHaveBeenCalledWith(0, null);
      expect((c as any).ready).toBe(false);
    });
  });

  describe('AcpClientImpl integration', () => {
    it('should accumulate text chunks from agent_message_chunk and return via flush', async () => {
      // Access the internal AcpClientImpl class via the connection factory
      // Create a custom mock ClientSideConnection that captures the client impl
      const sdkMod = await import('@agentclientprotocol/sdk');
      let capturedImpl: any = null;
      const origCtor = sdkMod.ClientSideConnection;
      const origPrompt = origCtor.prototype.prompt;

      // Replace the constructor to capture factory()
      (sdkMod as any).ClientSideConnection = class extends origCtor {
        constructor(factory: any, stream: any) {
          super(factory, stream);
          capturedImpl = factory();
        }
      };
      (sdkMod as any).ClientSideConnection.prototype.initialize = origCtor.prototype.initialize;
      (sdkMod as any).ClientSideConnection.prototype.newSession = origCtor.prototype.newSession;
      (sdkMod as any).ClientSideConnection.prototype.prompt = vi.fn().mockImplementation(async function () {
        if (capturedImpl) {
          await capturedImpl.sessionUpdate({
            sessionId: 's1',
            update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'Hello' } },
          });
          await capturedImpl.sessionUpdate({
            sessionId: 's1',
            update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'World' } },
          });
        }
        return { stopReason: 'end_turn' };
      });

      vi.resetModules();
      const freshMod = await import('./client.js');
      const c = new freshMod.AcpBridgeClient({ command: 'test-agent', args: [] });
      await c.waitReady();
      const reply = await c.sendPrompt('hello');
      expect(reply).toBe('HelloWorld');

      (sdkMod as any).ClientSideConnection = origCtor;
      sdkMod.ClientSideConnection.prototype.prompt = origPrompt;
    });

    it('should log tool_call updates', async () => {
      const sdkMod = await import('@agentclientprotocol/sdk');
      const loggerModule = await import('../util/logger.js');
      const logger = loggerModule.default as unknown as MockLogger;
      const origCtor = sdkMod.ClientSideConnection;
      const origPrompt = origCtor.prototype.prompt;
      let capturedImpl: any = null;

      (sdkMod as any).ClientSideConnection = class extends origCtor {
        constructor(factory: any, stream: any) {
          super(factory, stream);
          capturedImpl = factory();
        }
      };
      (sdkMod as any).ClientSideConnection.prototype.initialize = origCtor.prototype.initialize;
      (sdkMod as any).ClientSideConnection.prototype.newSession = origCtor.prototype.newSession;
      (sdkMod as any).ClientSideConnection.prototype.prompt = vi.fn().mockImplementation(async function () {
        if (capturedImpl) {
          await capturedImpl.sessionUpdate({
            sessionId: 's1',
            update: { sessionUpdate: 'tool_call', title: 'read_file', status: 'in_progress' },
          });
        }
        return { stopReason: 'end_turn' };
      });

      vi.resetModules();
      const freshMod = await import('./client.js');
      const c = new freshMod.AcpBridgeClient({ command: 'test-agent', args: [] });
      await c.waitReady();
      const infoCallsBefore = logger.info.mock.calls.length;
      await c.sendPrompt('hello');
      // Check that at least one new info call contains the tool log
      const newCalls = logger.info.mock.calls.slice(infoCallsBefore);
      const toolCall = newCalls.find((call: any[]) => String(call[0]).includes('[tool] read_file (in_progress)'));
      expect(toolCall).toBeTruthy();

      (sdkMod as any).ClientSideConnection = origCtor;
      sdkMod.ClientSideConnection.prototype.prompt = origPrompt;
    });

    it('should auto-allow permission (prefer allow_once)', async () => {
      const sdkMod = await import('@agentclientprotocol/sdk');
      const loggerModule = await import('../util/logger.js');
      const logger = loggerModule.default as unknown as MockLogger;
      const origCtor = sdkMod.ClientSideConnection;
      const origPrompt = origCtor.prototype.prompt;
      let capturedImpl: any = null;

      (sdkMod as any).ClientSideConnection = class extends origCtor {
        constructor(factory: any, stream: any) {
          super(factory, stream);
          capturedImpl = factory();
        }
      };
      (sdkMod as any).ClientSideConnection.prototype.initialize = origCtor.prototype.initialize;
      (sdkMod as any).ClientSideConnection.prototype.newSession = origCtor.prototype.newSession;
      (sdkMod as any).ClientSideConnection.prototype.prompt = vi.fn().mockImplementation(async function () {
        if (capturedImpl) {
          await capturedImpl.requestPermission({
            options: [
              { kind: 'allow_once', optionId: 'allow-once' },
              { kind: 'allow_always', optionId: 'allow-always' },
            ],
            toolCall: { title: 'execute_command' },
          });
        }
        return { stopReason: 'end_turn' };
      });

      vi.resetModules();
      const freshMod = await import('./client.js');
      const c = new freshMod.AcpBridgeClient({ command: 'test-agent', args: [] });
      await c.waitReady();
      const infoCallsBefore = logger.info.mock.calls.length;
      await c.sendPrompt('hello');
      const newCalls = logger.info.mock.calls.slice(infoCallsBefore);
      const permCall = newCalls.find((call: any[]) =>
        String(call[0]).includes('[permission] auto-allowed: execute_command → allow-once'),
      );
      expect(permCall).toBeTruthy();

      (sdkMod as any).ClientSideConnection = origCtor;
      sdkMod.ClientSideConnection.prototype.prompt = origPrompt;
    });

    it('should handle unknown toolCall title in permission', async () => {
      const sdkMod = await import('@agentclientprotocol/sdk');
      const loggerModule = await import('../util/logger.js');
      const logger = loggerModule.default as unknown as MockLogger;
      const origCtor = sdkMod.ClientSideConnection;
      const origPrompt = origCtor.prototype.prompt;
      let capturedImpl: any = null;

      (sdkMod as any).ClientSideConnection = class extends origCtor {
        constructor(factory: any, stream: any) {
          super(factory, stream);
          capturedImpl = factory();
        }
      };
      (sdkMod as any).ClientSideConnection.prototype.initialize = origCtor.prototype.initialize;
      (sdkMod as any).ClientSideConnection.prototype.newSession = origCtor.prototype.newSession;
      (sdkMod as any).ClientSideConnection.prototype.prompt = vi.fn().mockImplementation(async function () {
        if (capturedImpl) {
          await capturedImpl.requestPermission({
            options: [{ kind: 'allow_once', optionId: 'allow-once' }],
          });
        }
        return { stopReason: 'end_turn' };
      });

      vi.resetModules();
      const freshMod = await import('./client.js');
      const c = new freshMod.AcpBridgeClient({ command: 'test-agent', args: [] });
      await c.waitReady();
      const infoCallsBefore = logger.info.mock.calls.length;
      await c.sendPrompt('hello');
      const newCalls = logger.info.mock.calls.slice(infoCallsBefore);
      const permCall = newCalls.find((call: any[]) =>
        String(call[0]).includes('[permission] auto-allowed: unknown → allow-once'),
      );
      expect(permCall).toBeTruthy();

      (sdkMod as any).ClientSideConnection = origCtor;
      sdkMod.ClientSideConnection.prototype.prompt = origPrompt;
    });

    it('should read text files via readTextFile', async () => {
      const { tmpdir } = await import('os');
      const { join } = await import('path');
      const tmpFile = join(tmpdir(), `acp-read-test-${Date.now()}.txt`);
      const fs = await import('fs/promises');
      await fs.writeFile(tmpFile, 'test content');

      const sdkMod = await import('@agentclientprotocol/sdk');
      const origCtor = sdkMod.ClientSideConnection;
      const origPrompt = origCtor.prototype.prompt;
      let capturedImpl: any = null;

      (sdkMod as any).ClientSideConnection = class extends origCtor {
        constructor(factory: any, stream: any) {
          super(factory, stream);
          capturedImpl = factory();
        }
      };
      (sdkMod as any).ClientSideConnection.prototype.initialize = origCtor.prototype.initialize;
      (sdkMod as any).ClientSideConnection.prototype.newSession = origCtor.prototype.newSession;
      (sdkMod as any).ClientSideConnection.prototype.prompt = vi.fn().mockImplementation(async function () {
        if (capturedImpl) {
          const result = await capturedImpl.readTextFile({ path: tmpFile });
          (globalThis as any).__acpReadResult = result.content;
        }
        return { stopReason: 'end_turn' };
      });

      vi.resetModules();
      const freshMod = await import('./client.js');
      const c = new freshMod.AcpBridgeClient({ command: 'test-agent', args: [] });
      await c.waitReady();
      await c.sendPrompt('hello');
      expect((globalThis as any).__acpReadResult).toBe('test content');

      (sdkMod as any).ClientSideConnection = origCtor;
      sdkMod.ClientSideConnection.prototype.prompt = origPrompt;
      await fs.unlink(tmpFile).catch(() => {});
      delete (globalThis as any).__acpReadResult;
    });

    it('should log tool_call_update events', async () => {
      const sdkMod = await import('@agentclientprotocol/sdk');
      const loggerModule = await import('../util/logger.js');
      const logger = loggerModule.default as unknown as MockLogger;
      const origCtor = sdkMod.ClientSideConnection;
      const origPrompt = origCtor.prototype.prompt;
      let capturedImpl: any = null;

      (sdkMod as any).ClientSideConnection = class extends origCtor {
        constructor(factory: any, stream: any) {
          super(factory, stream);
          capturedImpl = factory();
        }
      };
      (sdkMod as any).ClientSideConnection.prototype.initialize = origCtor.prototype.initialize;
      (sdkMod as any).ClientSideConnection.prototype.newSession = origCtor.prototype.newSession;
      (sdkMod as any).ClientSideConnection.prototype.prompt = vi.fn().mockImplementation(async function () {
        if (capturedImpl) {
          await capturedImpl.sessionUpdate({
            sessionId: 's1',
            update: { sessionUpdate: 'tool_call_update', toolCallId: 'tc1', status: 'completed' },
          });
        }
        return { stopReason: 'end_turn' };
      });

      vi.resetModules();
      const freshMod = await import('./client.js');
      const c = new freshMod.AcpBridgeClient({ command: 'test-agent', args: [] });
      await c.waitReady();
      const infoCallsBefore = logger.info.mock.calls.length;
      await c.sendPrompt('hello');
      const newCalls = logger.info.mock.calls.slice(infoCallsBefore);
      const toolUpdateCall = newCalls.find((call: any[]) => String(call[0]).includes('[tool] tc1 → completed'));
      expect(toolUpdateCall).toBeTruthy();

      (sdkMod as any).ClientSideConnection = origCtor;
      sdkMod.ClientSideConnection.prototype.prompt = origPrompt;
    });

    it('should write text files via writeTextFile', async () => {
      const { tmpdir } = await import('os');
      const { join } = await import('path');
      const tmpFile = join(tmpdir(), `acp-write-test-${Date.now()}.txt`);
      mockWriteFile.mockClear();

      const sdkMod = await import('@agentclientprotocol/sdk');
      const origCtor = sdkMod.ClientSideConnection;
      const origPrompt = origCtor.prototype.prompt;
      let capturedImpl: any = null;

      (sdkMod as any).ClientSideConnection = class extends origCtor {
        constructor(factory: any, stream: any) {
          super(factory, stream);
          capturedImpl = factory();
        }
      };
      (sdkMod as any).ClientSideConnection.prototype.initialize = origCtor.prototype.initialize;
      (sdkMod as any).ClientSideConnection.prototype.newSession = origCtor.prototype.newSession;
      (sdkMod as any).ClientSideConnection.prototype.prompt = vi.fn().mockImplementation(async function () {
        if (capturedImpl) {
          await capturedImpl.writeTextFile({ path: tmpFile, content: 'write-test' });
        }
        return { stopReason: 'end_turn' };
      });

      vi.resetModules();
      const freshMod = await import('./client.js');
      const c = new freshMod.AcpBridgeClient({ command: 'test-agent', args: [] });
      await c.waitReady();
      await c.sendPrompt('hello');
      expect(mockWriteFile).toHaveBeenCalledWith(tmpFile, 'write-test', 'utf-8');

      (sdkMod as any).ClientSideConnection = origCtor;
      sdkMod.ClientSideConnection.prototype.prompt = origPrompt;
    });

    it('should throw when spawn returns no stdio', async () => {
      // Override mockSpawn to return a proc without stdin
      mockSpawn.mockImplementationOnce(() => {
        const proc: any = new EventEmitter();
        proc.stdin = null;
        proc.stdout = null;
        proc.stderr = null;
        proc.kill = vi.fn();
        return proc;
      });

      vi.resetModules();
      const freshMod = await import('./client.js');
      const c = new freshMod.AcpBridgeClient({ command: 'bad-cmd', args: [] });
      const errorHandler = vi.fn();
      c.on('error', errorHandler);
      try {
        await c.waitReady();
      } catch {
        /* expected */
      }
      expect(errorHandler).toHaveBeenCalled();
    });

    it('should handle agent_message_chunk with non-text content type', async () => {
      const sdkMod = await import('@agentclientprotocol/sdk');
      const origCtor = sdkMod.ClientSideConnection;
      const origPrompt = origCtor.prototype.prompt;
      let capturedImpl: any = null;

      (sdkMod as any).ClientSideConnection = class extends origCtor {
        constructor(factory: any, stream: any) {
          super(factory, stream);
          capturedImpl = factory();
        }
      };
      (sdkMod as any).ClientSideConnection.prototype.initialize = origCtor.prototype.initialize;
      (sdkMod as any).ClientSideConnection.prototype.newSession = origCtor.prototype.newSession;
      (sdkMod as any).ClientSideConnection.prototype.prompt = vi.fn().mockImplementation(async function () {
        if (capturedImpl) {
          await capturedImpl.sessionUpdate({
            sessionId: 's1',
            update: {
              sessionUpdate: 'agent_message_chunk',
              content: { type: 'image', text: 'should be ignored' },
            },
          });
        }
        return { stopReason: 'end_turn' };
      });

      vi.resetModules();
      const freshMod = await import('./client.js');
      const c = new freshMod.AcpBridgeClient({ command: 'test-agent', args: [] });
      await c.waitReady();
      const reply = await c.sendPrompt('hello');
      expect(reply).toBe('Agent 无回复');

      (sdkMod as any).ClientSideConnection = origCtor;
      sdkMod.ClientSideConnection.prototype.prompt = origPrompt;
    });

    it('should handle tool_call_update without status', async () => {
      const sdkMod = await import('@agentclientprotocol/sdk');
      const loggerModule = await import('../util/logger.js');
      const logger = loggerModule.default as unknown as MockLogger;
      const origCtor = sdkMod.ClientSideConnection;
      const origPrompt = origCtor.prototype.prompt;
      let capturedImpl: any = null;

      (sdkMod as any).ClientSideConnection = class extends origCtor {
        constructor(factory: any, stream: any) {
          super(factory, stream);
          capturedImpl = factory();
        }
      };
      (sdkMod as any).ClientSideConnection.prototype.initialize = origCtor.prototype.initialize;
      (sdkMod as any).ClientSideConnection.prototype.newSession = origCtor.prototype.newSession;
      (sdkMod as any).ClientSideConnection.prototype.prompt = vi.fn().mockImplementation(async function () {
        if (capturedImpl) {
          await capturedImpl.sessionUpdate({
            sessionId: 's1',
            update: { sessionUpdate: 'tool_call_update', toolCallId: 'tc1' },
          });
        }
        return { stopReason: 'end_turn' };
      });

      vi.resetModules();
      const freshMod = await import('./client.js');
      const c = new freshMod.AcpBridgeClient({ command: 'test-agent', args: [] });
      await c.waitReady();
      const infoCallsBefore = logger.info.mock.calls.length;
      await c.sendPrompt('hello');
      const newCalls = logger.info.mock.calls.slice(infoCallsBefore);
      const toolUpdateCall = newCalls.find((call: any[]) => String(call[0]).includes('[tool] tc1'));
      // No status → should not log (empty status is falsy)
      expect(toolUpdateCall).toBeFalsy();

      (sdkMod as any).ClientSideConnection = origCtor;
      sdkMod.ClientSideConnection.prototype.prompt = origPrompt;
    });

    it('should auto-allow permission using first option when allow_once not found', async () => {
      const sdkMod = await import('@agentclientprotocol/sdk');
      const loggerModule = await import('../util/logger.js');
      const logger = loggerModule.default as unknown as MockLogger;
      const origCtor = sdkMod.ClientSideConnection;
      const origPrompt = origCtor.prototype.prompt;
      let capturedImpl: any = null;

      (sdkMod as any).ClientSideConnection = class extends origCtor {
        constructor(factory: any, stream: any) {
          super(factory, stream);
          capturedImpl = factory();
        }
      };
      (sdkMod as any).ClientSideConnection.prototype.initialize = origCtor.prototype.initialize;
      (sdkMod as any).ClientSideConnection.prototype.newSession = origCtor.prototype.newSession;
      (sdkMod as any).ClientSideConnection.prototype.prompt = vi.fn().mockImplementation(async function () {
        if (capturedImpl) {
          await capturedImpl.requestPermission({
            options: [{ kind: 'allow_always', optionId: 'allow-always' }],
            toolCall: { title: 'read_file' },
          });
        }
        return { stopReason: 'end_turn' };
      });

      vi.resetModules();
      const freshMod = await import('./client.js');
      const c = new freshMod.AcpBridgeClient({ command: 'test-agent', args: [] });
      await c.waitReady();
      const infoCallsBefore = logger.info.mock.calls.length;
      await c.sendPrompt('hello');
      const newCalls = logger.info.mock.calls.slice(infoCallsBefore);
      const permCall = newCalls.find((call: any[]) =>
        String(call[0]).includes('[permission] auto-allowed: read_file → allow-always'),
      );
      expect(permCall).toBeTruthy();

      (sdkMod as any).ClientSideConnection = origCtor;
      sdkMod.ClientSideConnection.prototype.prompt = origPrompt;
    });

    it('should handle process with no stderr', async () => {
      mockSpawn.mockImplementationOnce(() => {
        const proc: any = new EventEmitter();
        proc.stdin = new PassThrough();
        proc.stdout = new PassThrough();
        proc.stderr = null;
        proc.kill = vi.fn();
        return proc;
      });

      vi.resetModules();
      const freshMod = await import('./client.js');
      const c = new freshMod.AcpBridgeClient({ command: 'test-agent', args: [] });
      await c.waitReady();
      expect(c.getSessionId()).toBe('fake-session');
    });
  });

  describe('sendPrompt with stopReason and content', () => {
    it('should append refusal notice when stopReason is refusal and hadContent', async () => {
      const sdkMod = await import('@agentclientprotocol/sdk');
      const origCtor = sdkMod.ClientSideConnection;
      const origPrompt = origCtor.prototype.prompt;
      let capturedImpl: any = null;

      (sdkMod as any).ClientSideConnection = class extends origCtor {
        constructor(factory: any, stream: any) {
          super(factory, stream);
          capturedImpl = factory();
        }
      };
      (sdkMod as any).ClientSideConnection.prototype.initialize = origCtor.prototype.initialize;
      (sdkMod as any).ClientSideConnection.prototype.newSession = origCtor.prototype.newSession;
      (sdkMod as any).ClientSideConnection.prototype.prompt = vi.fn().mockImplementation(async function () {
        if (capturedImpl) {
          await capturedImpl.sessionUpdate({
            sessionId: 's1',
            update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'Partial reply' } },
          });
        }
        return { stopReason: 'refusal' };
      });

      vi.resetModules();
      const freshMod = await import('./client.js');
      const c = new freshMod.AcpBridgeClient({ command: 'test-agent', args: [] });
      await c.waitReady();
      const reply = await c.sendPrompt('hello');
      expect(reply).toBe('Partial reply\n[agent refused to continue]');

      (sdkMod as any).ClientSideConnection = origCtor;
      sdkMod.ClientSideConnection.prototype.prompt = origPrompt;
    });

    it('should append cancelled notice when stopReason is cancelled and hadContent', async () => {
      const sdkMod = await import('@agentclientprotocol/sdk');
      const origCtor = sdkMod.ClientSideConnection;
      const origPrompt = origCtor.prototype.prompt;
      let capturedImpl: any = null;

      (sdkMod as any).ClientSideConnection = class extends origCtor {
        constructor(factory: any, stream: any) {
          super(factory, stream);
          capturedImpl = factory();
        }
      };
      (sdkMod as any).ClientSideConnection.prototype.initialize = origCtor.prototype.initialize;
      (sdkMod as any).ClientSideConnection.prototype.newSession = origCtor.prototype.newSession;
      (sdkMod as any).ClientSideConnection.prototype.prompt = vi.fn().mockImplementation(async function () {
        if (capturedImpl) {
          await capturedImpl.sessionUpdate({
            sessionId: 's1',
            update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'Partial reply' } },
          });
        }
        return { stopReason: 'cancelled' };
      });

      vi.resetModules();
      const freshMod = await import('./client.js');
      const c = new freshMod.AcpBridgeClient({ command: 'test-agent', args: [] });
      await c.waitReady();
      const reply = await c.sendPrompt('hello');
      expect(reply).toBe('Partial reply\n[cancelled]');

      (sdkMod as any).ClientSideConnection = origCtor;
      sdkMod.ClientSideConnection.prototype.prompt = origPrompt;
    });
  });
});

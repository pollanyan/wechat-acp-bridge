/**
 * ACP Bridge Client — 通过 ACP 协议（NDJSON-over-stdio）与外部 Agent 子进程通信。
 *
 * 每个 AcpBridgeClient 实例 spawn 一个 Agent 子进程，在初始化时建立 ACP 连接并创建会话。
 * sendPrompt() 向 Agent 发送用户消息，通过 AcpClientImpl 累积文本块，最终拼接返回。
 */
import { spawn } from 'node:child_process';
import type { ChildProcess } from 'node:child_process';
import { Writable, Readable } from 'node:stream';
import { EventEmitter } from 'node:events';
import { readFile, writeFile } from 'node:fs/promises';
import * as acp from '@agentclientprotocol/sdk';
import logger from '../util/logger.js';
import { type AgentConfig } from '../schemas/agents.js';
import { settings } from '../util/settings.js';

/**
 * ACP Client 接口实现。
 * - agent_message_chunk → 累积文本块到 chunks 数组
 * - tool_call / tool_call_update → 记录日志
 * - requestPermission → 自动授权（优先 allow_once）
 * - flush() → 拼接并清空累积的文本，返回给调用方
 */
class AcpClientImpl implements acp.Client {
  private chunks: string[] = [];
  private hadContent = false;
  private log: (msg: string) => void;

  constructor(log: (msg: string) => void) {
    this.log = log;
  }

  async sessionUpdate(params: acp.SessionNotification): Promise<void> {
    const update = params.update;
    switch (update.sessionUpdate) {
      case 'agent_message_chunk':
        if (update.content.type === 'text') {
          this.chunks.push(update.content.text);
          this.hadContent = true;
        }
        break;
      case 'tool_call':
        this.log(`[tool] ${update.title} (${update.status})`);
        break;
      case 'tool_call_update':
        if (update.status) {
          this.log(`[tool] ${update.toolCallId} → ${update.status}`);
        }
        break;
    }
  }

  async requestPermission(params: acp.RequestPermissionRequest): Promise<acp.RequestPermissionResponse> {
    const allowOption = params.options.find((o) => o.kind === 'allow_once') || params.options[0];
    this.log(`[permission] auto-allowed: ${params.toolCall?.title ?? 'unknown'} → ${allowOption.optionId}`);
    return { outcome: { outcome: 'selected', optionId: allowOption.optionId } };
  }

  async readTextFile(params: acp.ReadTextFileRequest): Promise<acp.ReadTextFileResponse> {
    const content = await readFile(params.path, 'utf-8');
    return { content };
  }

  async writeTextFile(params: acp.WriteTextFileRequest): Promise<acp.WriteTextFileResponse> {
    await writeFile(params.path, params.content, 'utf-8');
    return {};
  }

  /**
   * 拼接累积的文本块并清空缓冲区。
   * 在每次 sendPrompt 前后各调用一次：前一次清空残留，后一次返回结果。
   */
  flush(): string {
    const text = this.chunks.join('');
    this.chunks = [];
    this.hadContent = false;
    return text;
  }

  /** 自上次 flush 以来是否收到过 agent_message_chunk */
  hasReceivedContent(): boolean {
    return this.hadContent;
  }
}

export class AcpBridgeClient extends EventEmitter {
  private proc: ChildProcess | null = null;
  private connection: acp.ClientSideConnection | null = null;
  private sessionId: string | null = null;
  private clientImpl: AcpClientImpl;
  private ready = false;
  /** startPromise 确保并发调用 waitReady/sendPrompt 都能等待初始化完成 */
  private startPromise: Promise<void>;

  constructor(options: AgentConfig) {
    super();
    this.clientImpl = new AcpClientImpl((msg) => logger.info(`[ACP] ${msg}`));
    this.startPromise = this.startAgent(options).catch((err) => {
      logger.error('启动 Agent 失败: %O', err);
      this.disconnect();
      this.emit('error', err);
      throw err;
    });
  }

  /**
   * 启动 Agent 子进程并完成 ACP 握手。
   * 流程：spawn → 构建 NDJSON 流 → initialize → newSession → emit('ready')
   */
  private async startAgent(options: AgentConfig) {
    const { command, args, cwd = process.cwd(), env = {} } = options;
    logger.info(`🚀 启动 ACP Agent: ${command} ${args.join(' ')} (cwd: ${cwd})`);

    this.proc = spawn(command, args, {
      stdio: ['pipe', 'pipe', 'pipe'],
      cwd,
      env: { ...process.env, ...env },
      shell: process.platform === 'win32',
    });

    this.proc.on('error', (err) => {
      logger.error(`ACP Agent 进程启动失败: ${err.message}`);
      this.ready = false;
      this.emit('error', err);
    });

    if (!this.proc.stdin || !this.proc.stdout) {
      throw new Error('无法获取子进程 stdio');
    }

    // Agent 子进程通过 stderr 输出运行日志（stdout 用于 ACP NDJSON 协议通信）
    if (this.proc.stderr) {
      this.proc.stderr.on('data', (data) => {
        logger.info(`[ACP] ${data.toString().trimEnd()}`);
      });
    }

    this.proc.on('exit', (code, signal) => {
      logger.info(`ACP Agent 退出: code=${code}, signal=${signal}`);
      this.ready = false;
      this.emit('exit', code, signal);
    });

    // Node.js Readable/Writable → Web Streams → ACP NDJSON 流
    const input = Writable.toWeb(this.proc.stdin);
    const output = Readable.toWeb(this.proc.stdout) as ReadableStream<Uint8Array>;
    const stream = acp.ndJsonStream(input, output);

    this.connection = new acp.ClientSideConnection(() => this.clientImpl, stream);

    const initResult = await this.connection.initialize({
      protocolVersion: acp.PROTOCOL_VERSION,
      clientInfo: { name: settings.name, version: settings.version },
    });
    logger.info(`✅ ACP 初始化成功，协议版本: ${initResult.protocolVersion}`);

    // 创建会话
    const sessionResult = await this.connection.newSession({
      cwd,
      mcpServers: [],
    });
    this.sessionId = sessionResult.sessionId;
    logger.info(`✅ ACP 会话已创建: ${this.sessionId}`);

    this.ready = true;
    this.emit('ready');
  }

  /**
   * 向 Agent 发送用户消息并返回回复文本。
   * 在调用前 flush() 清空上次残留，调用后 flush() 取出本次积累的文本块。
   * stopReason 为 refusal/cancelled 时追加提示标记。
   */
  async sendPrompt(content: string): Promise<string> {
    if (!this.ready || !this.connection || !this.sessionId) {
      throw new Error('ACP 连接未就绪');
    }
    // 清空之前的累积消息
    this.clientImpl.flush();
    const result = await this.connection.prompt({
      sessionId: this.sessionId,
      prompt: [{ type: 'text', text: content }],
    });
    const hadContent = this.clientImpl.hasReceivedContent();
    const reply = this.clientImpl.flush();

    if (result.stopReason === 'refusal') {
      return hadContent ? reply + '\n[agent refused to continue]' : '[agent refused to continue]';
    }
    if (result.stopReason === 'cancelled') {
      return hadContent ? reply + '\n[cancelled]' : '[cancelled]';
    }
    if (!hadContent) {
      return 'Agent 无回复';
    }
    return reply;
  }

  async waitReady(): Promise<void> {
    await this.startPromise;
  }

  getSessionId(): string | null {
    return this.sessionId;
  }

  disconnect() {
    if (this.proc) {
      this.proc.kill('SIGTERM');
      this.proc = null;
    }
    this.connection = null;
    this.ready = false;
  }
}

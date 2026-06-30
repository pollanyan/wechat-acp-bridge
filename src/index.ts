/**
 * WeChat ACP Bridge — 主桥接器
 *
 * 数据流：WeChat 用户消息 → WXAPI.getUpdates() 轮询 → MessageRouter 路由
 * → AcpBridgeClient.sendPrompt() 转发 Agent → 回复发回 WeChat
 *
 * 支持多账号：每个账号独立轮询，账号的激活/去激活通过 supervisorLoop 实时生效。
 */
import { readFile, writeFile, mkdir, unlink } from 'node:fs/promises';
import { dirname } from 'node:path';
import axios from 'axios';
import { WXAPI, TypingStatus, MessageType } from './weixin/api.js';
import { MessageRouter } from './bridge/router.js';
import logger from './util/logger.js';
import { getPidFile } from './util/paths.js';
import { settings } from './util/settings.js';
import { readActiveAliases } from './storage/active-accounts.js';

export { getPidFile, getActiveAccountsFile } from './util/paths.js';

/** supervisorLoop 轮询间隔：每 N 毫秒重新读取激活列表、补充新账号的轮询 */
const SUPERVISOR_INTERVAL_MS = 10_000;

export class WeChatACPBridge {
  private router: MessageRouter;
  private running = false;
  /** 当前已激活的账号别名集合，由 supervisorLoop 从 active_accounts.json 热加载 */
  private activeAliases = new Set<string>();
  /** 正在轮询的账号 → WXAPI 实例映射，避免重复启动同一账号的轮询 */
  private wxapis = new Map<string, WXAPI>();

  constructor() {
    this.router = new MessageRouter();
  }

  /** 前台运行桥接服务：写 PID 文件 → 进入 supervisorLoop（阻塞主线程） */
  async run() {
    if (await this.isRunning()) {
      logger.error('❌ 服务已在运行');
      process.exit(1);
      return;
    }
    logger.info(`🚀 ${settings.displayName} 启动中...`);

    this.running = true;
    await this.savePid();
    this.setupSignalHandlers();
    await this.supervisorLoop();
  }

  /**
   * 监控循环：每 SUPERVISOR_INTERVAL_MS 刷新激活列表并为新账号启动轮询。
   * 已存在的轮询不会被重复启动；被去激活的账号在其 pollAccount IIFE 内自行退出。
   */
  private async supervisorLoop() {
    while (this.running) {
      this.reloadActivatedAliases();
      await this.startNewPolls();
      await new Promise((r) => setTimeout(r, SUPERVISOR_INTERVAL_MS));
    }
  }

  /** 为尚未启动轮询的激活账号创建 WXAPI 并启动 pollAccount */
  private async startNewPolls() {
    for (const alias of this.activeAliases) {
      if (this.wxapis.has(alias)) continue;
      const api = new WXAPI(alias);
      const ok = await api.loadCredentials();
      if (!ok) {
        logger.warn(`[${alias}] 凭证失效，跳过`);
        continue;
      }
      this.wxapis.set(alias, api);
      logger.info(`✅ 已开始为账号 ${alias} 提供桥接服务`);
      this.pollAccount(api);
    }
  }

  /**
   * 启动单个账号的长轮询（fire-and-forget IIFE）。
   * 使用 IIFE 而非直接 await，使得多个账号可以并行轮询。
   * - ECONNABORTED: 长轮询超时是正常行为，立即重试
   * - 其他错误: 等待 5s 后重试，避免错误风暴
   */
  private pollAccount(api: WXAPI) {
    const alias = api.getAccountId();
    (async () => {
      while (this.running) {
        try {
          if (!this.activeAliases.has(alias)) {
            logger.info(`[${alias}] 该账号已被去激活，退出轮询`);
            this.wxapis.delete(alias);
            return;
          }
          const data = await api.getUpdates();
          const messages = data.msgs || [];
          for (const msg of messages) {
            if (msg.message_type !== MessageType.INBOUND_TEXT) continue;
            const text = msg.item_list?.[0]?.text_item?.text || '';
            const userId = msg.from_user_id;
            const contextToken = msg.context_token;
            if (!text) continue;

            logger.info(`[${alias}] 收到消息: ${text}`);

            // 发送"正在输入"状态，后续每 5 秒重发保持指示
            api
              .sendTyping(userId, contextToken, TypingStatus.START)
              .catch((e: unknown) => logger.warn('[%s] sendTyping 失败: %s', alias, (e as Error).message));
            const typingInterval = setInterval(() => {
              api
                .sendTyping(userId, contextToken, TypingStatus.START)
                .catch((e: unknown) => logger.warn('[%s] sendTyping 失败: %s', alias, (e as Error).message));
            }, 5000);

            let reply = '';
            try {
              reply = await this.router.routeMessage(alias, text);
            } finally {
              // 无论成功失败，停止定时 typing 并发送"结束输入"
              clearInterval(typingInterval);
              api
                .sendTyping(userId, contextToken, TypingStatus.STOP)
                .catch((e: unknown) => logger.warn('[%s] sendTyping(结束) 失败: %s', alias, (e as Error).message));
            }

            try {
              await api.sendText(userId, contextToken, reply);
              logger.info(`[${alias}] 已回复: ${reply}`);
            } catch (sendErr) {
              logger.error('[%s] 发送回复失败，消息已丢失: %s', alias, (sendErr as Error).message);
              continue;
            }
          }
        } catch (err) {
          if (axios.isAxiosError(err) && err.code === 'ECONNABORTED') {
            // 长轮询超时是正常行为，立即重新发起轮询
            continue;
          }
          logger.error(`[${alias}] 轮询出错: %O`, err);
          await new Promise((r) => setTimeout(r, 5000));
        }
      }
    })();
  }

  private setupSignalHandlers(): void {
    const shutdown = () => {
      logger.info('收到终止信号，正在优雅关闭...');
      this.running = false;
      this.router.shutdown();
      this.removePid().finally(() => process.exit(0));
    };
    process.on('SIGTERM', shutdown);
    process.on('SIGINT', shutdown);
  }

  async stop() {
    logger.info(`🛑 停止 ${settings.displayName}...`);
    this.running = false;
    this.router.shutdown();
    await this.removePid();
    process.exit(0);
  }

  /**
   * 通过 kill(pid, 0) 检测进程是否存在。
   * 信号 0 不发送实际信号，仅检查进程是否存活。
   */
  private async isRunning(): Promise<boolean> {
    try {
      const pid = await readFile(getPidFile(), 'utf-8');
      process.kill(parseInt(pid), 0);
      return true;
    } catch (err: unknown) {
      const code = (err as NodeJS.ErrnoException).code;
      if (code !== 'ENOENT' && code !== 'ESRCH') {
        logger.warn('读取 PID 文件失败: %s', (err as Error).message);
      }
      return false;
    }
  }

  private async savePid() {
    const dir = dirname(getPidFile());
    await mkdir(dir, { recursive: true });
    await writeFile(getPidFile(), process.pid.toString());
  }

  /** 从 active_accounts.json 热加载激活列表，覆盖内存中的集合 */
  private reloadActivatedAliases() {
    const aliases = readActiveAliases();
    if (aliases.length > 0) {
      this.activeAliases = new Set(aliases);
    }
  }

  private async removePid() {
    try {
      await unlink(getPidFile());
    } catch {
      /* file may not exist */
    }
  }
}

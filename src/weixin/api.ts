/**
 * WeChat HTTP API 客户端 — 微信 iLink Bot API 的封装。
 *
 * 功能：扫码登录 → 长轮询接收消息 → 发送文本回复 / 输入状态
 * 凭证存储：~/.wechat-acp-bridge/run/accounts/<accountId>.json
 */
import axios, { AxiosInstance } from 'axios';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import QRCode from 'qrcode-terminal';
import logger from '../util/logger.js';
import { settings } from '../util/settings.js';
import { RUN_DIR, safeSegment } from '../util/paths.js';
import { credentialsFileSchema, type Credentials } from '../schemas/credentials.js';
import {
  type QrCodeResponse,
  type QrCodeStatusResponse,
  type GetUpdatesResponse,
  type ConfigResponse,
  getUpdatesResponseSchema,
  configResponseSchema,
} from '../schemas/api.js';

/** 微信 iLink Bot API 基地址 */
const BASE_URL = 'https://ilinkai.weixin.qq.com';
/** 官方固定 bot_type 参数 */
const BOT_TYPE = 3;
/** 微信 iLink Bot API channel_version */
const CHANNEL_VERSION = '1.0.2';

/** 输入状态 */
export const TypingStatus = { START: 1, STOP: 2 } as const;
export type TypingStatus = (typeof TypingStatus)[keyof typeof TypingStatus];

/** 消息类型（接收/发送方向不同值） */
export const MessageType = { INBOUND_TEXT: 1, OUTBOUND_TEXT: 2 } as const;

/** 消息发送状态 */
const MessageState = { NORMAL: 2 } as const;

/** 消息内容项类型 */
const ItemType = { TEXT: 1 } as const;
export class WXAPI {
  private static readonly ACCOUNT_DIR = path.join(RUN_DIR, 'accounts');
  private accountId: string;
  private http: AxiosInstance;
  private credentialsPath: string;
  private botToken: string = '';
  private botBaseUrl: string = BASE_URL;
  private getUpdatesBuf: string = '';
  private typingTicketCache: Map<string, string> = new Map();

  constructor(accountId = 'default') {
    this.accountId = accountId;
    this.http = axios.create({ timeout: 35000 }); // 长轮询超时35秒
    this.credentialsPath = path.join(WXAPI.ACCOUNT_DIR, `${safeSegment(accountId)}.json`);
  }

  /** 构建 API 请求头：Authorization + 随机 X-WECHAT-UIN */
  private makeHeaders(token?: string): Record<string, string> {
    const uin = Math.floor(Math.random() * 0xffffffff).toString();
    const headers: Record<string, string> = {
      'Content-Type': 'application/json',
      AuthorizationType: 'ilink_bot_token',
      'X-WECHAT-UIN': Buffer.from(uin).toString('base64'),
    };
    const effectiveToken = token ?? this.botToken;
    if (effectiveToken) {
      headers['Authorization'] = `Bearer ${effectiveToken}`;
    }
    return headers;
  }

  // 通用 API 请求
  private async request<T>(
    method: 'GET' | 'POST',
    path: string,
    data?: Record<string, unknown>,
    token?: string,
  ): Promise<T> {
    const url = `${this.botBaseUrl}${path.startsWith('/') ? path : '/' + path}`;
    const config = {
      method,
      url,
      headers: this.makeHeaders(token),
      data: method === 'POST' ? data : undefined,
      params: method === 'GET' ? data : undefined,
    };
    const response = await this.http.request(config);
    return response.data;
  }

  /** 持久化登录凭证到磁盘（canonical 格式） */
  private async saveCredentials(creds: Credentials): Promise<void> {
    try {
      const dir = path.dirname(this.credentialsPath);
      await fs.mkdir(dir, { recursive: true });
      // store all fields, alias is in the filename
      const out = {
        token: creds.token,
        ilink_bot_id: creds.accountId,
        ilink_user_id: creds.userId || '',
        baseurl: creds.baseUrl,
        savedAt: Date.now(),
      };
      await fs.writeFile(this.credentialsPath, JSON.stringify(out, null, 2));
    } catch (err) {
      logger.error('保存凭证失败: %s', (err as Error).message);
      throw err;
    }
  }

  /**
   * 扫码登录流程：获取二维码 → 终端展示 → 轮询状态直到 confirmed
   * 完成后自动保存凭证到磁盘。
   */
  async login(): Promise<Credentials> {
    logger.info(`正在获取登录二维码，账号别名: ${this.accountId}`);
    const qrData = await this.request<QrCodeResponse>('GET', `/ilink/bot/get_bot_qrcode?bot_type=${BOT_TYPE}`);
    const { qrcode, qrcode_img_content } = qrData;
    QRCode.generate(qrcode_img_content, { small: true });
    logger.info('请扫描二维码登录');

    while (true) {
      const status = await this.request<QrCodeStatusResponse>('GET', `/ilink/bot/get_qrcode_status`, { qrcode });
      if (status.status === 'confirmed') {
        if (!status.bot_token || !status.ilink_bot_id) {
          throw new Error('登录确认但未返回 token 或 bot_id');
        }
        const creds: Credentials = {
          token: status.bot_token,
          baseUrl: status.baseurl || BASE_URL,
          accountId: status.ilink_bot_id,
          userId: status.ilink_user_id || '',
        };
        await this.saveCredentials(creds);
        this.botToken = creds.token;
        this.botBaseUrl = creds.baseUrl;
        logger.info(`[auth] ✅ 登录成功! accountId=${creds.accountId}`);
        return creds;
      } else if (status.status === 'scanned') {
        logger.info('📱 已扫描，请在手机上确认登录');
      } else if (status.status === 'expired') {
        throw new Error('二维码已过期，请重新登录');
      } else {
        logger.info('⏳ 等待扫码...');
      }
      await new Promise((r) => setTimeout(r, 2000));
    }
  }

  async loadCredentials(): Promise<boolean> {
    const tryRead = async (p: string): Promise<boolean> => {
      try {
        const data = await fs.readFile(p, 'utf-8');
        const parsed = JSON.parse(data) as unknown;
        const result = credentialsFileSchema.safeParse(parsed);
        if (!result.success) {
          logger.warn('[%s] 凭证文件 Schema 验证失败: %O', this.accountId, result.error.issues);
          return false;
        }
        this.botToken = result.data.token;
        this.botBaseUrl = result.data.baseUrl;
        return true;
      } catch {
        return false;
      }
    };

    if (await tryRead(this.credentialsPath)) return true;

    // 迁移兼容：尝试未编码的旧格式凭据文件路径
    const rawPath = path.join(WXAPI.ACCOUNT_DIR, `${this.accountId}.json`);
    if (rawPath !== this.credentialsPath && (await tryRead(rawPath))) {
      logger.info('[%s] 已从旧格式加载凭据', this.accountId);
      return true;
    }
    return false;
  }

  getAccountId(): string {
    return this.accountId;
  }

  static async getSavedAccounts(): Promise<string[]> {
    try {
      const files = await fs.readdir(WXAPI.ACCOUNT_DIR);
      return files
        .filter((file) => file.endsWith('.json'))
        .map((file) => decodeURIComponent(path.basename(file, '.json')));
    } catch {
      return [];
    }
  }

  static async deleteSavedAccount(accountId: string): Promise<boolean> {
    const encodedPath = path.join(WXAPI.ACCOUNT_DIR, `${safeSegment(accountId)}.json`);
    const rawPath = path.join(WXAPI.ACCOUNT_DIR, `${accountId}.json`);
    let deleted = false;
    for (const p of [encodedPath, rawPath]) {
      try {
        await fs.unlink(p);
        deleted = true;
      } catch {
        /* file may not exist */
      }
    }
    return deleted;
  }

  /**
   * 长轮询获取新消息。使用 getUpdatesBuf 实现增量拉取，
   * 服务器在无新消息时会保持连接直到超时（35s）。
   */
  async getUpdates(): Promise<GetUpdatesResponse> {
    const payload = {
      get_updates_buf: this.getUpdatesBuf,
      base_info: { channel_version: CHANNEL_VERSION },
    };
    const data = await this.request<GetUpdatesResponse>('POST', '/ilink/bot/getupdates', payload);
    const result = getUpdatesResponseSchema.safeParse(data);
    if (!result.success) {
      logger.warn('getUpdates 响应 Schema 验证失败: %O', result.error.issues);
      return { msgs: [] };
    }
    if (result.data.get_updates_buf) {
      this.getUpdatesBuf = result.data.get_updates_buf;
    }
    return result.data;
  }

  /** 获取 typing_ticket（按 ilinkUserId:contextToken 缓存） */
  private async getTypingTicket(ilinkUserId: string, contextToken: string): Promise<string> {
    const cacheKey = `${ilinkUserId}:${contextToken}`;
    if (this.typingTicketCache.has(cacheKey)) {
      return this.typingTicketCache.get(cacheKey)!;
    }
    const data = await this.request<ConfigResponse>('POST', '/ilink/bot/getconfig', {
      ilink_user_id: ilinkUserId,
      context_token: contextToken,
      base_info: { channel_version: CHANNEL_VERSION },
    });
    const parsed = configResponseSchema.safeParse(data);
    if (!parsed.success) {
      logger.warn('getconfig 响应 Schema 验证失败: %O', parsed.error.issues);
      return '';
    }
    const ticket = parsed.data.typing_ticket || '';
    if (!ticket) {
      logger.warn('getconfig 未返回 typing_ticket，sendTyping 将跳过');
    } else {
      this.typingTicketCache.set(cacheKey, ticket);
    }
    return ticket;
  }

  /** 发送"正在输入"状态 */
  async sendTyping(ilinkUserId: string, contextToken: string, status: TypingStatus): Promise<void> {
    const ticket = await this.getTypingTicket(ilinkUserId, contextToken);
    if (!ticket) return;
    await this.request('POST', '/ilink/bot/sendtyping', {
      ilink_user_id: ilinkUserId,
      typing_ticket: ticket,
      status,
    });
  }

  // 发送文本消息
  async sendText(toUserId: string, contextToken: string, text: string): Promise<void> {
    const prefix = settings.clientIdPrefix || settings.name;
    const clientId = `${prefix}-${Math.floor(Math.random() * 0xffffffff)
      .toString(16)
      .padStart(8, '0')}`;
    await this.request('POST', '/ilink/bot/sendmessage', {
      msg: {
        from_user_id: '',
        to_user_id: toUserId,
        client_id: clientId,
        message_type: MessageType.OUTBOUND_TEXT,
        message_state: MessageState.NORMAL,
        context_token: contextToken,
        item_list: [{ type: ItemType.TEXT, text_item: { text } }],
      },
      base_info: { channel_version: CHANNEL_VERSION },
    });
  }
}

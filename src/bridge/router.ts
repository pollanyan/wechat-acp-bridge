/**
 * MessageRouter — 消息路由与 session 管理。
 *
 * 将用户输入分为两类：
 * 1. 命令（/help /new /sessions /session <key> /<agent-short>）→ 路由处理
 * 2. 普通文本 → 转发给当前 Agent
 *
 * Session 生命周期：
 * - 每个 (账号, Agent) 维护一个活跃 sessionKey
 * - session 超过 SESSION_TIMEOUT_MINUTES 未活动则自动过期，下次消息触发创建新 session
 * - /new 强制创建新 session，/sessions 列出历史，/session <key> 切换到指定 session
 *
 * 持久化：
 * - ~/.wechat-acp-bridge/run/account_state/<alias>/state.json   → 当前 Agent、当前 sessionKey
 * - ~/.wechat-acp-bridge/run/sessions/<alias>/<agent>/<uuid>.json → session 元数据
 */
import { randomUUID } from 'node:crypto';
import { AcpBridgeClient } from '../acp/client.js';
import logger from '../util/logger.js';
import { settings } from '../util/settings.js';
import { AGENT_CONFIGS, SESSION_TIMEOUT_MINUTES, AGENT_COMMAND_MAP, DEFAULT_AGENT_KEY } from '../config/agents.js';
import { type AgentConfig, type SessionMeta, type AccountState } from '../schemas/index.js';
import { loadAccountState as loadAccountStateFromDisk, saveAccountState } from '../storage/account-state.js';
import { saveSessionMeta, findSessionMetaByKey, listAccountSessions } from '../storage/session-meta.js';

type AgentKey = string;

const accountStates = new Map<string, AccountState>();
const activeSessions = new Map<string, { client: AcpBridgeClient; meta: SessionMeta }>();

function resolveModeByCommand(command: string): AgentKey | null {
  const normalized = command.trim().toLowerCase().replace(/^\/+/, '');
  return AGENT_COMMAND_MAP[normalized] ?? null;
}

/** 带内存缓存的 loadAccountState，避免重复磁盘读取 */
function loadAccountState(accountAlias: string): AccountState {
  if (accountStates.has(accountAlias)) {
    return accountStates.get(accountAlias)!;
  }
  const state = loadAccountStateFromDisk(accountAlias);
  accountStates.set(accountAlias, state);
  return state;
}

/** 持久化并更新内存缓存 */
async function saveAccountStateCached(accountAlias: string, state: AccountState): Promise<void> {
  await saveAccountState(accountAlias, state);
  accountStates.set(accountAlias, state);
}

function makeDescriptionFromText(text: string): string {
  const firstLine = text.trim().split(/\r?\n/)[0] || '';
  const sentence = firstLine.split(/[。！？.!?]/)[0] || firstLine;
  return sentence.slice(0, 80).trim();
}

function getSessionTimeoutMinutes(): number {
  // 优先级：settings.yaml > agents.yaml > 默认值
  return settings.Agent?.session_timeout ?? SESSION_TIMEOUT_MINUTES;
}

function getSessionTimeoutMs(): number {
  return getSessionTimeoutMinutes() * 60 * 1000;
}

export class MessageRouter {
  /**
   * 路由入口：根据消息内容判断是命令还是普通文本，执行对应操作。
   * 命令优先级：/help > /sessions > /session <key> > /new > /<agent-short>
   * 均不匹配时作为普通文本转发给当前 Agent。
   */
  async routeMessage(accountAlias: string, content: string): Promise<string> {
    const trimmed = content.trim();
    if (trimmed === '/h') {
      return this.renderHelp();
    }
    if (trimmed === '/sessions') {
      return await this.renderSessionList(accountAlias);
    }
    if (trimmed.startsWith('/session ')) {
      const requestedKey = trimmed.slice('/session '.length).trim();
      return await this.selectSession(accountAlias, requestedKey);
    }
    if (trimmed === '/new') {
      return await this.createNewSession(accountAlias);
    }

    const agentKey = resolveModeByCommand(trimmed);
    if (agentKey) {
      return await this.switchAgent(accountAlias, agentKey);
    }

    return await this.sendUserMessage(accountAlias, content);
  }

  private renderHelp(): string {
    const available = Object.values(AGENT_CONFIGS)
      .filter((agent): agent is AgentConfig & { short: string } => Boolean(agent.short))
      .map((agent) => `  /${agent.short?.toLowerCase()} - 切换到 ${agent.name}`)
      .join('\n');

    return [
      '📋 可用命令：',
      '',
      '会话管理：',
      '  /h             - 显示本帮助',
      '  /new           - 创建新会话（重置上下文）',
      '  /sessions      - 列出历史会话（显示短 ID）',
      '  /session <id>  - 切换到指定会话（支持短 ID 前缀匹配）',
      '  /session latest - 切换到最近活跃的会话',
      '',
      'Agent 切换：',
      available || '  (无可用 Agent 快捷方式)',
      '',
      '直接发送文本即可与当前 Agent 对话。',
    ].join('\n');
  }

  private async switchAgent(accountAlias: string, agentKey: AgentKey): Promise<string> {
    const accountState = await loadAccountState(accountAlias);
    accountState.currentAgentKey = agentKey;
    accountState.lastActive = Date.now();
    await saveAccountStateCached(accountAlias, accountState);

    const sessionKey = await this.ensureCurrentSession(accountAlias, agentKey);
    return `✅ 已切换当前账号 ${accountAlias} 的后端为 ${AGENT_CONFIGS[agentKey].name}，当前 session: ${sessionKey}`;
  }

  private async createNewSession(accountAlias: string): Promise<string> {
    const accountState = await loadAccountState(accountAlias);
    const agentKey = accountState.currentAgentKey || DEFAULT_AGENT_KEY;
    if (!AGENT_CONFIGS[agentKey]) {
      return `❌ 当前账号 Agent 配置无效，请先切换 Agent`;
    }

    // 断开旧 session 的 Agent 进程，避免僵尸进程累积
    const oldSessionKey = accountState.sessions[agentKey];
    if (oldSessionKey && activeSessions.has(oldSessionKey)) {
      try {
        activeSessions.get(oldSessionKey)!.client.disconnect();
      } catch {
        /* ignore */
      }
      activeSessions.delete(oldSessionKey);
    }

    const { sessionKey } = await this.createSession(accountAlias, agentKey, '新会话');

    accountState.sessions[agentKey] = sessionKey;
    accountState.lastActive = Date.now();
    await saveAccountStateCached(accountAlias, accountState);

    return `✅ 已为 ${AGENT_CONFIGS[agentKey].name} 创建新的 session: ${sessionKey}`;
  }

  private async selectSession(accountAlias: string, requestedKey: string): Promise<string> {
    const accountState = await loadAccountState(accountAlias);
    const agentKey = accountState.currentAgentKey || DEFAULT_AGENT_KEY;
    const sessions = await listAccountSessions(accountAlias);
    const agentSessions = sessions.filter((s) => s.agentKey === agentKey);

    // /session latest → 切换到最近活跃的 session
    if (requestedKey === 'latest') {
      if (!agentSessions.length) {
        return `当前 Agent (${AGENT_CONFIGS[agentKey]?.name || agentKey}) 暂无 session。`;
      }
      // listAccountSessions 已按 lastActive 降序排列
      const latest = agentSessions[0];
      if (!AGENT_CONFIGS[latest.agentKey]) {
        return `❌ session 所属 Agent 未知: ${latest.agentKey}`;
      }
      await this.restoreSessionClient(latest);
      accountState.sessions[agentKey] = latest.sessionKey;
      accountState.lastActive = Date.now();
      await saveAccountStateCached(accountAlias, accountState);
      return `✅ 已切换到最近 session ${latest.sessionKey.slice(0, 8)} (${latest.description || latest.agentKey})`;
    }

    // 精确匹配完整 UUID
    let meta = agentSessions.find((s) => s.sessionKey === requestedKey) ?? null;

    // 前缀匹配（短 ID）
    if (!meta) {
      const prefixMatches = agentSessions.filter((s) => s.sessionKey.startsWith(requestedKey));
      if (prefixMatches.length === 0) {
        return `❌ 未找到当前 Agent 下的 session: ${requestedKey}`;
      }
      if (prefixMatches.length > 1) {
        const candidates = prefixMatches
          .map((s) => `  ${s.sessionKey.slice(0, 8)} ${s.description || '无描述'}`)
          .join('\n');
        return `❌ 短 ID "${requestedKey}" 匹配多个 session:\n${candidates}\n请使用更长的 ID 前缀。`;
      }
      meta = prefixMatches[0];
    }

    if (!AGENT_CONFIGS[meta.agentKey]) {
      return `❌ session 所属 Agent 未知: ${meta.agentKey}`;
    }
    await this.restoreSessionClient(meta);

    accountState.sessions[agentKey] = meta.sessionKey;
    accountState.lastActive = Date.now();
    await saveAccountStateCached(accountAlias, accountState);

    return `✅ 已切换到 session ${meta.sessionKey.slice(0, 8)} (${meta.description || meta.agentKey})`;
  }

  private async renderSessionList(accountAlias: string): Promise<string> {
    const accountState = await loadAccountState(accountAlias);
    const agentKey = accountState.currentAgentKey || DEFAULT_AGENT_KEY;
    const allSessions = await listAccountSessions(accountAlias);
    const sessions = allSessions.filter((s) => s.agentKey === agentKey);
    if (!sessions.length) {
      return `当前 Agent (${AGENT_CONFIGS[agentKey]?.name || agentKey}) 暂无 session。发送 /new 以创建新 session。`;
    }
    const lines = sessions.map((meta) => {
      const currentMark = accountState.sessions[meta.agentKey] === meta.sessionKey ? ' *' : '';
      const lastActiveAgo = Math.max(0, Math.floor((Date.now() - meta.lastActive) / 60000));
      const shortId = meta.sessionKey.slice(0, 8);
      return `- ${shortId}${currentMark} ${meta.description || '无描述'} (最近活跃 ${lastActiveAgo} 分钟)`;
    });
    return `当前 Agent (${AGENT_CONFIGS[agentKey]?.name || agentKey}) session 列表:\n${lines.join('\n')}`;
  }

  /**
   * 确保当前 (账号, Agent) 有一个活跃 session。
   * - 若已有 session 且未超时 → 复用
   * - 否则 → 创建新 session（旧 session 元数据保留在磁盘中，可通过 /sessions 查看）
   */
  private async ensureCurrentSession(
    accountAlias: string,
    agentKey: string,
    initialDescription?: string,
  ): Promise<string> {
    const accountState = await loadAccountState(accountAlias);
    const now = Date.now();
    const timeoutMs = getSessionTimeoutMs();
    const currentSessionKey = accountState.sessions[agentKey];

    if (currentSessionKey) {
      const meta = await findSessionMetaByKey(accountAlias, currentSessionKey);
      if (meta && meta.agentKey === agentKey && now - meta.lastActive <= timeoutMs) {
        const idleMin = Math.floor((now - meta.lastActive) / 60000);
        const timeoutMin = getSessionTimeoutMinutes();
        logger.info(
          '[%s] 复用已有 session: %s (空闲 %d 分钟, 超时阈值 %d 分钟)',
          accountAlias,
          currentSessionKey,
          idleMin,
          timeoutMin,
        );
        accountState.lastActive = now;
        await saveAccountStateCached(accountAlias, accountState);
        return currentSessionKey;
      }
    }

    // 断开旧 session 的 Agent 进程，避免僵尸进程累积
    if (currentSessionKey && activeSessions.has(currentSessionKey)) {
      try {
        activeSessions.get(currentSessionKey)!.client.disconnect();
      } catch {
        /* ignore */
      }
      activeSessions.delete(currentSessionKey);
    }

    const description = initialDescription || '';
    const { sessionKey } = await this.createSession(accountAlias, agentKey, description);
    accountState.sessions[agentKey] = sessionKey;
    accountState.lastActive = now;
    await saveAccountStateCached(accountAlias, accountState);
    return sessionKey;
  }

  /** 创建新 session：spawn Agent 子进程 → 生成 UUID sessionKey → 持久化元数据 */
  private async createSession(
    accountAlias: string,
    agentKey: string,
    description: string,
  ): Promise<{ client: AcpBridgeClient; meta: SessionMeta; sessionKey: string }> {
    const agentConfig = AGENT_CONFIGS[agentKey];
    const client = new AcpBridgeClient(agentConfig);
    try {
      await client.waitReady();
    } catch {
      client.disconnect();
      throw new Error(`无法启动 Agent: ${agentConfig.command}`);
    }
    const sessionId = client.getSessionId() ?? '';
    const sessionKey = randomUUID();
    const now = Date.now();
    const meta: SessionMeta = {
      sessionKey,
      accountAlias,
      userId: '',
      agentKey,
      sessionId,
      session: sessionId,
      description: description || '',
      createdAt: now,
      lastActive: now,
    };
    await saveSessionMeta(meta);
    activeSessions.set(sessionKey, { client, meta });
    return { client, meta, sessionKey };
  }

  /**
   * 恢复已有 session 的 Agent 客户端。
   * - 若该 session 的 Agent 进程仍在运行（activeSessions 中有记录）→ 直接复用
   * - 否则重新 spawn Agent 子进程并通过 AcpBridgeClient 连接
   */
  private async restoreSessionClient(meta: SessionMeta): Promise<{ client: AcpBridgeClient; meta: SessionMeta }> {
    if (activeSessions.has(meta.sessionKey)) {
      return activeSessions.get(meta.sessionKey)!;
    }
    const agentConfig = AGENT_CONFIGS[meta.agentKey];
    if (!agentConfig) {
      throw new Error(`未知 Agent: ${meta.agentKey}`);
    }
    const client = new AcpBridgeClient(agentConfig);
    try {
      await client.waitReady();
    } catch {
      client.disconnect();
      throw new Error(`无法恢复 Agent: ${agentConfig.command}`);
    }
    const sessionId = client.getSessionId() ?? '';
    meta.sessionId = sessionId;
    meta.session = sessionId;
    meta.lastActive = Date.now();
    await saveSessionMeta(meta);
    activeSessions.set(meta.sessionKey, { client, meta });
    return { client, meta };
  }

  /**
   * 处理普通文本消息：确保有活跃 session → 转发给 Agent → 返回回复。
   * 首次消息自动使用文本首句作为 session 描述。
   */
  private async sendUserMessage(accountAlias: string, content: string): Promise<string> {
    const accountState = await loadAccountState(accountAlias);
    const agentKey = accountState.currentAgentKey || DEFAULT_AGENT_KEY;
    const initialDescription = accountState.sessions[agentKey] ? undefined : makeDescriptionFromText(content);
    const sessionKey = await this.ensureCurrentSession(accountAlias, agentKey, initialDescription);
    const meta = await findSessionMetaByKey(accountAlias, sessionKey);
    if (!meta) {
      return '❌ 未能找到当前 session，请稍后重试';
    }
    const { client } = await this.restoreSessionClient(meta);
    const reply = await client.sendPrompt(content);
    const agentConfig = AGENT_CONFIGS[agentKey];
    const prefix = agentConfig?.logo ? `${agentConfig.logo} ${agentConfig.name}\n` : '';
    meta.lastActive = Date.now();
    if (!meta.description) {
      meta.description = makeDescriptionFromText(content);
    }
    await saveSessionMeta(meta);
    accountState.sessions[agentKey] = sessionKey;
    accountState.lastActive = Date.now();
    await saveAccountStateCached(accountAlias, accountState);
    return prefix + reply;
  }

  /** 断开所有活跃 Agent 子进程连接，用于优雅关闭 */
  shutdown(): void {
    for (const [sessionKey, { client }] of activeSessions) {
      try {
        client.disconnect();
      } catch {
        /* ignore disconnect errors */
      }
      activeSessions.delete(sessionKey);
    }
  }
}

/**
 * Agent 配置加载 — 解析 config/agents.yaml，供 router 和 CLI 共用。
 */
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import YAML from 'yaml';
import { yamlAgentEntrySchema, agentConfigSchema, type AgentConfig } from '../schemas/agents.js';
import logger from '../util/logger.js';

type AgentKey = string;

const DEFAULT_SESSION_TIMEOUT_MINUTES = 30;

function getAgentsConfigPath() {
  return join(dirname(fileURLToPath(import.meta.url)), '../../config/agents.yaml');
}

function loadAgentConfigs(): {
  AGENT_CONFIGS: Record<AgentKey, AgentConfig>;
  SESSION_TIMEOUT_MINUTES: number;
} {
  const configPath = getAgentsConfigPath();
  try {
    const raw = readFileSync(configPath, 'utf-8');
    const parsed = YAML.parse(raw) as unknown;
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('agents.yaml 内容格式错误');

    let sessionTimeoutMinutes = DEFAULT_SESSION_TIMEOUT_MINUTES;
    const normalized: Record<AgentKey, AgentConfig> = {};

    for (const [key, value] of Object.entries(parsed as Record<string, unknown>)) {
      if (key === 'session_timeout_minutes' || key === 'sessionTimeoutMinutes') {
        sessionTimeoutMinutes = Number(value) || DEFAULT_SESSION_TIMEOUT_MINUTES;
        continue;
      }
      const entryResult = yamlAgentEntrySchema.safeParse(value);
      if (!entryResult.success || !entryResult.data.command) continue;

      const entry = entryResult.data;
      const agentResult = agentConfigSchema.safeParse({
        name: key,
        command: entry.command,
        args: entry.args ?? [],
        cwd: entry.cwd ?? process.cwd(),
        env: entry.env ?? {},
        short: entry.short,
        logo: entry.logo,
      });
      if (agentResult.success) {
        normalized[key] = agentResult.data;
      }
    }

    if (Object.keys(normalized).length === 0) {
      throw new Error('agents.yaml 中未找到有效 agent 配置');
    }

    return { AGENT_CONFIGS: normalized, SESSION_TIMEOUT_MINUTES: sessionTimeoutMinutes };
  } catch (err) {
    logger.warn('无法加载 agents.yaml，使用默认后端配置: %O', err);
    return {
      AGENT_CONFIGS: {
        OpenClaw: {
          name: 'OpenClaw',
          command: 'openclaw',
          args: ['acp'],
          cwd: process.cwd(),
          env: {},
          short: 'CL',
          logo: '\u{1F99E}',
        },
        Hermes: {
          name: 'Hermes',
          command: 'hermes',
          args: ['acp'],
          cwd: process.cwd(),
          env: {},
          short: 'HA',
          logo: '\u{2624}',
        },
      },
      SESSION_TIMEOUT_MINUTES: DEFAULT_SESSION_TIMEOUT_MINUTES,
    };
  }
}

function buildAgentCommandMap(configs: Record<AgentKey, AgentConfig>): Record<string, AgentKey> {
  const map: Record<string, AgentKey> = {};
  for (const [key, agentConfig] of Object.entries(configs)) {
    if (agentConfig.short) {
      map[agentConfig.short.toLowerCase()] = key;
    }
  }
  return map;
}

const { AGENT_CONFIGS, SESSION_TIMEOUT_MINUTES } = loadAgentConfigs();
const AGENT_COMMAND_MAP = buildAgentCommandMap(AGENT_CONFIGS);
const DEFAULT_AGENT_KEY = Object.keys(AGENT_CONFIGS)[0];

export { AGENT_CONFIGS, SESSION_TIMEOUT_MINUTES, AGENT_COMMAND_MAP, DEFAULT_AGENT_KEY, buildAgentCommandMap };

/** 为 CLI 提供 Agent 名称映射（仅含有效 agent 的 name → name 映射） */
export function loadAgentDisplayNames(): Record<string, string> {
  try {
    const configPath = getAgentsConfigPath();
    const raw = readFileSync(configPath, 'utf-8');
    const parsed = YAML.parse(raw) as unknown;
    const names: Record<string, string> = {};
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
      for (const [key, value] of Object.entries(parsed as Record<string, unknown>)) {
        const result = yamlAgentEntrySchema.safeParse(value);
        if (result.success && result.data.command) {
          names[key] = key;
        }
      }
    }
    return names;
  } catch {
    return { 'Hermes Agent': 'Hermes Agent', OpenClaw: 'OpenClaw', OpenCode: 'OpenCode' };
  }
}

import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import YAML from 'yaml';
import { settingsSchema, type Settings } from '../schemas/settings.js';

interface PackageJson {
  name?: string;
  version?: string;
  bin?: string | Record<string, string>;
}

function readPackageJson(): PackageJson {
  try {
    const pkgPath = join(dirname(fileURLToPath(import.meta.url)), '../../package.json');
    return JSON.parse(readFileSync(pkgPath, 'utf-8')) as PackageJson;
  } catch {
    return {};
  }
}

function getBinName(pkg: PackageJson): string {
  if (!pkg.bin) return 'wechat-acp-bridge';
  if (typeof pkg.bin === 'string') return pkg.bin.split('/').pop() || 'wechat-acp-bridge';
  return Object.keys(pkg.bin)[0] || 'wechat-acp-bridge';
}

const pkg = readPackageJson();
const binName = getBinName(pkg);

const defaults: Settings = {
  name: binName,
  version: pkg.version || '0.0.0',
  displayName: 'WeChat ACP Bridge',
  clientIdPrefix: binName,
  Agent: { session_timeout: 30 },
};

function loadSettings(): Settings {
  try {
    const configPath = join(dirname(fileURLToPath(import.meta.url)), '../../config/settings.yaml');
    const raw = readFileSync(configPath, 'utf-8');
    const yamlData = YAML.parse(raw) as Record<string, unknown> | null;
    const userConfig = (yamlData && typeof yamlData === 'object' ? yamlData : {}) as Record<string, unknown>;
    // 静默剥离 name/version，确保 package.json 为唯一来源
    delete userConfig.name;
    delete userConfig.version;
    const merged = { ...defaults, ...userConfig };
    const result = settingsSchema.safeParse(merged);
    if (result.success) return result.data;

    console.warn('[settings] Schema 验证失败，使用默认值:', result.error.issues);
    return defaults;
  } catch {
    return defaults;
  }
}

export const settings = loadSettings();

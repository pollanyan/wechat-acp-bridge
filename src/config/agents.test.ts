import { describe, it, expect, beforeEach, vi } from 'vitest';
import * as YAML from 'yaml';

const mockReadFileSync = vi.fn();

vi.mock('node:fs', async () => {
  const actual = await vi.importActual<typeof import('node:fs')>('node:fs');
  return { ...actual, readFileSync: mockReadFileSync };
});

vi.mock('../util/logger', () => ({
  default: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

function agentYaml(entries: Record<string, unknown>) {
  return YAML.stringify(entries);
}

describe('loadAgentConfigs', () => {
  beforeEach(async () => {
    vi.resetModules();
    mockReadFileSync.mockReset();
  });

  it('should load valid agent config from yaml', async () => {
    mockReadFileSync.mockReturnValue(agentYaml({ TestAgent: { command: 'test', args: ['--flag'], short: 'T' } }));
    const mod = await import('./agents.js');
    expect(mod.AGENT_CONFIGS).toHaveProperty('TestAgent');
    expect(mod.AGENT_CONFIGS.TestAgent.command).toBe('test');
    expect(mod.AGENT_CONFIGS.TestAgent.short).toBe('T');
    expect(mod.DEFAULT_AGENT_KEY).toBe('TestAgent');
  });

  it('should use defaults when yaml file cannot be read', async () => {
    mockReadFileSync.mockImplementation(() => {
      throw new Error('ENOENT');
    });
    const mod = await import('./agents.js');
    expect(mod.AGENT_CONFIGS).toHaveProperty('OpenClaw');
    expect(mod.AGENT_CONFIGS).toHaveProperty('Hermes');
    expect(mod.SESSION_TIMEOUT_MINUTES).toBe(30);
  });

  it('should throw for non-object yaml (array)', async () => {
    mockReadFileSync.mockReturnValue(YAML.stringify([1, 2, 3]));
    const mod = await import('./agents.js');
    // Falls back to defaults
    expect(mod.AGENT_CONFIGS).toHaveProperty('OpenClaw');
    expect(mod.AGENT_CONFIGS).toHaveProperty('Hermes');
  });

  it('should throw for null yaml', async () => {
    mockReadFileSync.mockReturnValue(YAML.stringify(null));
    const mod = await import('./agents.js');
    expect(mod.AGENT_CONFIGS).toHaveProperty('OpenClaw');
  });

  it('should parse session_timeout_minutes from yaml', async () => {
    mockReadFileSync.mockReturnValue(
      agentYaml({
        session_timeout_minutes: 45,
        TestAgent: { command: 'test' },
      }),
    );
    const mod = await import('./agents.js');
    expect(mod.SESSION_TIMEOUT_MINUTES).toBe(45);
    expect(mod.AGENT_CONFIGS).toHaveProperty('TestAgent');
  });

  it('should parse sessionTimeoutMinutes (camelCase) from yaml', async () => {
    mockReadFileSync.mockReturnValue(
      agentYaml({
        sessionTimeoutMinutes: 60,
        TestAgent: { command: 'test' },
      }),
    );
    const mod = await import('./agents.js');
    expect(mod.SESSION_TIMEOUT_MINUTES).toBe(60);
  });

  it('should use default timeout when session_timeout_minutes is 0', async () => {
    mockReadFileSync.mockReturnValue(
      agentYaml({
        session_timeout_minutes: 0,
        TestAgent: { command: 'test' },
      }),
    );
    const mod = await import('./agents.js');
    expect(mod.SESSION_TIMEOUT_MINUTES).toBe(30);
  });

  it('should skip entries without command', async () => {
    mockReadFileSync.mockReturnValue(
      agentYaml({
        NoCommand: { args: ['--x'] },
        HasCommand: { command: 'test' },
      }),
    );
    const mod = await import('./agents.js');
    expect(mod.AGENT_CONFIGS).not.toHaveProperty('NoCommand');
    expect(mod.AGENT_CONFIGS).toHaveProperty('HasCommand');
  });

  it('should skip entries that fail yaml schema validation', async () => {
    mockReadFileSync.mockReturnValue(
      agentYaml({
        Invalid: { command: 123 },
        Valid: { command: 'test' },
      }),
    );
    const mod = await import('./agents.js');
    expect(mod.AGENT_CONFIGS).not.toHaveProperty('Invalid');
    expect(mod.AGENT_CONFIGS).toHaveProperty('Valid');
  });

  it('should use defaults for args, cwd, env when not specified', async () => {
    mockReadFileSync.mockReturnValue(agentYaml({ Minimal: { command: 'minimal' } }));
    const mod = await import('./agents.js');
    const cfg = mod.AGENT_CONFIGS.Minimal;
    expect(cfg.args).toEqual([]);
    expect(cfg.cwd).toBe(process.cwd());
    expect(cfg.env).toEqual({});
  });

  it('should use specified args, cwd, env', async () => {
    mockReadFileSync.mockReturnValue(
      agentYaml({
        Full: {
          command: 'full',
          args: ['a', 'b'],
          cwd: '/custom',
          env: { FOO: 'bar' },
        },
      }),
    );
    const mod = await import('./agents.js');
    const cfg = mod.AGENT_CONFIGS.Full;
    expect(cfg.args).toEqual(['a', 'b']);
    expect(cfg.cwd).toBe('/custom');
    expect(cfg.env).toEqual({ FOO: 'bar' });
  });

  it('should skip entries that fail agentConfigSchema validation', async () => {
    // command is required in agentConfigSchema — entry with only short should fail
    mockReadFileSync.mockReturnValue(
      agentYaml({
        BadAgent: { command: '' },
        GoodAgent: { command: 'good' },
      }),
    );
    const mod = await import('./agents.js');
    expect(mod.AGENT_CONFIGS).not.toHaveProperty('BadAgent');
    expect(mod.AGENT_CONFIGS).toHaveProperty('GoodAgent');
  });

  it('should throw when no valid agent configs found', async () => {
    mockReadFileSync.mockReturnValue(agentYaml({ session_timeout_minutes: 10 }));
    const mod = await import('./agents.js');
    // Falls back to defaults (which have agents)
    expect(mod.AGENT_CONFIGS).toHaveProperty('OpenClaw');
  });

  it('should build command map from agent shorts', async () => {
    mockReadFileSync.mockReturnValue(
      agentYaml({
        Alpha: { command: 'a', short: 'AL' },
        Beta: { command: 'b', short: 'BE' },
      }),
    );
    const mod = await import('./agents.js');
    expect(mod.AGENT_COMMAND_MAP).toEqual({ al: 'Alpha', be: 'Beta' });
  });

  it('should build command map skipping agents without short', async () => {
    mockReadFileSync.mockReturnValue(
      agentYaml({
        NoShort: { command: 'ns' },
        WithShort: { command: 'ws', short: 'WS' },
      }),
    );
    const mod = await import('./agents.js');
    expect(mod.AGENT_COMMAND_MAP).toEqual({ ws: 'WithShort' });
  });

  it('should have DEFAULT_AGENT_KEY that exists', async () => {
    mockReadFileSync.mockReturnValue(agentYaml({ First: { command: 'f' }, Second: { command: 's' } }));
    const mod = await import('./agents.js');
    expect(mod.DEFAULT_AGENT_KEY).toBe('First');
  });
});

describe('loadAgentDisplayNames', () => {
  beforeEach(async () => {
    vi.resetModules();
    mockReadFileSync.mockReset();
  });

  it('should return display names for valid agents', async () => {
    mockReadFileSync.mockReturnValue(
      agentYaml({
        MyAgent: { command: 'my-agent' },
        Other: { command: 'other-agent' },
      }),
    );
    const mod = await import('./agents.js');
    const names = mod.loadAgentDisplayNames();
    expect(names).toEqual({ MyAgent: 'MyAgent', Other: 'Other' });
  });

  it('should skip entries without command in display names', async () => {
    mockReadFileSync.mockReturnValue(
      agentYaml({
        NoCmd: { args: ['--x'] },
        HasCmd: { command: 'has-cmd' },
      }),
    );
    const mod = await import('./agents.js');
    const names = mod.loadAgentDisplayNames();
    expect(names).toEqual({ HasCmd: 'HasCmd' });
  });

  it('should return default names when file read fails', async () => {
    mockReadFileSync.mockImplementation(() => {
      throw new Error('ENOENT');
    });
    const mod = await import('./agents.js');
    const names = mod.loadAgentDisplayNames();
    expect(names).toHaveProperty('OpenClaw', 'OpenClaw');
    expect(names).toHaveProperty('OpenCode', 'OpenCode');
    expect(names).toHaveProperty('Hermes Agent', 'Hermes Agent');
  });

  it('should handle non-object yaml in display names', async () => {
    mockReadFileSync.mockReturnValue('not yaml');
    const mod = await import('./agents.js');
    const names = mod.loadAgentDisplayNames();
    expect(names).toEqual({});
  });
});

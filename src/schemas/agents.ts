import { z } from 'zod';

export const yamlAgentEntrySchema = z.object({
  command: z.string().optional(),
  args: z.array(z.string()).optional(),
  cwd: z.string().optional(),
  env: z.record(z.string(), z.string()).optional(),
  short: z.string().optional(),
  logo: z.string().optional(),
  description: z.string().optional(),
});

export const agentConfigSchema = z.object({
  name: z.string(),
  command: z.string(),
  args: z.array(z.string()),
  cwd: z.string(),
  env: z.record(z.string(), z.string()),
  short: z.string().optional(),
  logo: z.string().optional(),
});

export type YamlAgentEntry = z.infer<typeof yamlAgentEntrySchema>;
export type AgentConfig = z.infer<typeof agentConfigSchema>;

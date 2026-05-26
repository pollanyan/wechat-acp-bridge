import { z } from 'zod';

export const accountStateSchema = z.object({
  currentAgentKey: z.string(),
  sessions: z.record(z.string(), z.string().nullable()),
  lastActive: z.number(),
});

export type AccountState = z.infer<typeof accountStateSchema>;

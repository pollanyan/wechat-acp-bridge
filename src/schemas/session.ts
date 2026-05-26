import { z } from 'zod';

export const sessionMetaSchema = z.object({
  sessionKey: z.string(),
  accountAlias: z.string(),
  userId: z.string(),
  agentKey: z.string(),
  sessionId: z.string(),
  session: z.string(),
  description: z.string(),
  createdAt: z.number(),
  lastActive: z.number(),
});

export type SessionMeta = z.infer<typeof sessionMetaSchema>;

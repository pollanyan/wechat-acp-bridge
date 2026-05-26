import { z } from 'zod';

export const settingsSchema = z.object({
  name: z.string(),
  version: z.string(),
  displayName: z.string(),
  clientIdPrefix: z.string().optional(),
  Agent: z
    .object({
      session_timeout: z.number().int().positive().optional(),
    })
    .optional(),
});

export type Settings = z.infer<typeof settingsSchema>;

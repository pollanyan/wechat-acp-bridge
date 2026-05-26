import { z } from 'zod';

export const activeAccountsSchema = z.array(z.string());

export const logLevelSchema = z.enum(['debug', 'info', 'warn', 'error']);

export const logLevelConfigSchema = z.object({
  level: logLevelSchema.optional(),
});

export type ActiveAccounts = z.infer<typeof activeAccountsSchema>;
export type LogLevel = z.infer<typeof logLevelSchema>;

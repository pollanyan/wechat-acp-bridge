import { z } from 'zod';

export const serviceStatusResultSchema = z.object({
  backend: z.enum(['systemd', 'launchd', 'none']),
  installed: z.boolean(),
  running: z.boolean(),
  enabled: z.boolean(),
  pid: z.number().optional(),
  unitPath: z.string().optional(),
  error: z.string().optional(),
});

export type ServiceStatusResult = z.infer<typeof serviceStatusResultSchema>;

import { z } from 'zod';

/** 磁盘上的凭证文件格式（兼容历史字段名），normalize 为统一格式 */
export const credentialsFileSchema = z
  .object({
    token: z.string().optional(),
    bot_token: z.string().optional(),
    baseUrl: z.string().optional(),
    baseurl: z.string().optional(),
    ilink_bot_id: z.string().optional(),
    ilink_user_id: z.string().optional(),
    savedAt: z.number().optional(),
  })
  .transform((raw) => ({
    token: raw.token || raw.bot_token || '',
    baseUrl: raw.baseUrl || raw.baseurl || 'https://ilinkai.weixin.qq.com',
    accountId: raw.ilink_bot_id || '',
    userId: raw.ilink_user_id,
  }))
  .refine((data) => data.token.length > 0, { message: 'token 字段不能为空' });

/** 运行时 Credentials 类型 */
export const credentialsSchema = z.object({
  token: z.string(),
  baseUrl: z.string(),
  accountId: z.string(),
  userId: z.string().optional(),
});

export type Credentials = z.infer<typeof credentialsSchema>;

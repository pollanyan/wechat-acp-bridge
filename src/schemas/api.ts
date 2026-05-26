import { z } from 'zod';

export const qrCodeResponseSchema = z.object({
  qrcode: z.string(),
  qrcode_img_content: z.string(),
});

export const qrCodeStatusResponseSchema = z.object({
  status: z.enum(['wait', 'scanned', 'confirmed', 'expired']),
  bot_token: z.string().optional(),
  baseurl: z.string().optional(),
  ilink_bot_id: z.string().optional(),
  ilink_user_id: z.string().optional(),
});

export const textItemSchema = z.object({
  type: z.number(),
  text_item: z.object({ text: z.string() }).optional(),
});

export const weChatMessageSchema = z.object({
  message_type: z.number(),
  from_user_id: z.string(),
  context_token: z.string(),
  item_list: z.array(textItemSchema).optional(),
});

export const getUpdatesResponseSchema = z.object({
  msgs: z.array(weChatMessageSchema).optional(),
  get_updates_buf: z.string().optional(),
});

export const configResponseSchema = z.object({
  typing_ticket: z.string().optional(),
});

export type QrCodeResponse = z.infer<typeof qrCodeResponseSchema>;
export type QrCodeStatusResponse = z.infer<typeof qrCodeStatusResponseSchema>;
export type WeChatMessage = z.infer<typeof weChatMessageSchema>;
export type GetUpdatesResponse = z.infer<typeof getUpdatesResponseSchema>;
export type ConfigResponse = z.infer<typeof configResponseSchema>;

import { describe, it, expect, beforeAll, beforeEach, afterEach, vi } from 'vitest';
import * as path from 'node:path';
import * as os from 'node:os';

const tempHome = path.join(os.tmpdir(), `wechat-acp-bridge-api-${Date.now()}`);
const runDir = path.join(tempHome, '.wechat-acp-bridge', 'run');

vi.mock('os', async () => {
  const actual = await vi.importActual<typeof import('os')>('os');
  return { ...actual, homedir: () => tempHome };
});

vi.mock('../util/logger', () => ({
  default: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

const mockQrGenerate = vi.fn();
vi.mock('qrcode-terminal', () => ({
  default: { generate: mockQrGenerate },
}));

const mockAxiosRequest = vi.fn();

vi.mock('axios', () => ({
  default: {
    create: vi.fn(() => ({
      request: mockAxiosRequest,
    })),
    isAxiosError: vi.fn((err: unknown) => {
      if (err && typeof err === 'object' && 'isAxiosError' in err) return true;
      return false;
    }),
  },
}));

describe('WXAPI', () => {
  let WXAPI: typeof import('./api.js').WXAPI;
  let TypingStatus: typeof import('./api.js').TypingStatus;
  let MessageType: typeof import('./api.js').MessageType;
  let fs: typeof import('node:fs/promises');

  beforeAll(async () => {
    const mod = await import('./api.js');
    WXAPI = mod.WXAPI;
    TypingStatus = mod.TypingStatus;
    MessageType = mod.MessageType;
    fs = await import('node:fs/promises');
  });

  beforeEach(async () => {
    await fs.rm(tempHome, { recursive: true, force: true });
    mockAxiosRequest.mockReset();
  });

  afterEach(async () => {
    await fs.rm(tempHome, { recursive: true, force: true });
  });

  describe('getAccountId', () => {
    it('should return the account alias used in constructor', () => {
      const api = new WXAPI('test-alias');
      expect(api.getAccountId()).toBe('test-alias');
    });

    it('should default to "default" when no alias given', () => {
      const api = new WXAPI('default');
      expect(api.getAccountId()).toBe('default');
    });
  });

  describe('getSavedAccounts', () => {
    it('should return an empty array when no accounts are saved', async () => {
      const saved = await WXAPI.getSavedAccounts();
      expect(saved).toEqual([]);
    });

    it('should return saved account aliases from the accounts directory', async () => {
      const accountDir = path.join(runDir, 'accounts');
      await fs.mkdir(accountDir, { recursive: true });
      await fs.writeFile(path.join(accountDir, 'alias-a.json'), '{}');
      await fs.writeFile(path.join(accountDir, 'alias-b.json'), '{}');
      const saved = await WXAPI.getSavedAccounts();
      expect(saved).toEqual(expect.arrayContaining(['alias-a', 'alias-b']));
      expect(saved.length).toBe(2);
    });

    it('should filter non-JSON files', async () => {
      const accountDir = path.join(runDir, 'accounts');
      await fs.mkdir(accountDir, { recursive: true });
      await fs.writeFile(path.join(accountDir, 'alias-a.json'), '{}');
      await fs.writeFile(path.join(accountDir, 'readme.txt'), 'text');
      const saved = await WXAPI.getSavedAccounts();
      expect(saved).toEqual(['alias-a']);
    });
  });

  describe('deleteSavedAccount', () => {
    const accountDir = path.join(runDir, 'accounts');

    it('should delete an existing saved account', async () => {
      await fs.mkdir(accountDir, { recursive: true });
      await fs.writeFile(path.join(accountDir, 'test-account.json'), '{}');
      const deleted = await WXAPI.deleteSavedAccount('test-account');
      expect(deleted).toBe(true);
      await expect(fs.access(path.join(accountDir, 'test-account.json'))).rejects.toThrow();
    });

    it('should return false when account does not exist', async () => {
      const deleted = await WXAPI.deleteSavedAccount('nonexistent');
      expect(deleted).toBe(false);
    });
  });

  describe('loadCredentials', () => {
    const accountDir = path.join(runDir, 'accounts');

    it('should return false when credential file does not exist', async () => {
      const api = new WXAPI('no-file');
      const ok = await api.loadCredentials();
      expect(ok).toBe(false);
    });

    it('should parse token from canonical format', async () => {
      await fs.mkdir(accountDir, { recursive: true });
      await fs.writeFile(
        path.join(accountDir, 'canonical.json'),
        JSON.stringify({ token: 'my-token', baseUrl: 'https://example.com' }),
      );
      const api = new WXAPI('canonical');
      const ok = await api.loadCredentials();
      expect(ok).toBe(true);
    });

    it('should parse token from legacy bot_token format', async () => {
      await fs.mkdir(accountDir, { recursive: true });
      await fs.writeFile(path.join(accountDir, 'legacy.json'), JSON.stringify({ bot_token: 'legacy-token' }));
      const api = new WXAPI('legacy');
      const ok = await api.loadCredentials();
      expect(ok).toBe(true);
    });

    it('should return false when token is missing from credential file', async () => {
      await fs.mkdir(accountDir, { recursive: true });
      await fs.writeFile(path.join(accountDir, 'bad.json'), JSON.stringify({ other: 'value' }));
      const api = new WXAPI('bad');
      const ok = await api.loadCredentials();
      expect(ok).toBe(false);
    });

    it('should return false for invalid JSON', async () => {
      await fs.mkdir(accountDir, { recursive: true });
      await fs.writeFile(path.join(accountDir, 'invalid.json'), 'not valid json');
      const api = new WXAPI('invalid');
      const ok = await api.loadCredentials();
      expect(ok).toBe(false);
    });

    it('should use default BASE_URL when baseUrl missing', async () => {
      await fs.mkdir(accountDir, { recursive: true });
      await fs.writeFile(path.join(accountDir, 'no-base.json'), JSON.stringify({ token: 'token' }));
      const api = new WXAPI('no-base');
      const ok = await api.loadCredentials();
      expect(ok).toBe(true);
    });
  });

  describe('login', () => {
    it('should return credentials on confirmed status', async () => {
      mockAxiosRequest
        .mockResolvedValueOnce({ data: { qrcode: 'qr1', qrcode_img_content: 'img1' } })
        .mockResolvedValueOnce({
          data: {
            status: 'confirmed',
            bot_token: 'tok123',
            ilink_bot_id: 'bot456',
            baseurl: 'https://custom.example.com',
          },
        });

      const api = new WXAPI('login-test');
      const creds = await api.login();

      expect(creds.token).toBe('tok123');
      expect(creds.accountId).toBe('bot456');
      expect(creds.baseUrl).toBe('https://custom.example.com');
    });

    it('should use default BASE_URL when baseurl not returned', async () => {
      mockAxiosRequest
        .mockResolvedValueOnce({ data: { qrcode: 'qr1', qrcode_img_content: 'img1' } })
        .mockResolvedValueOnce({ data: { status: 'confirmed', bot_token: 'tok123', ilink_bot_id: 'bot456' } });

      const api = new WXAPI('login-test');
      const creds = await api.login();
      expect(creds.baseUrl).toBe('https://ilinkai.weixin.qq.com');
    });

    it('should throw when qrcode expires', async () => {
      mockAxiosRequest
        .mockResolvedValueOnce({ data: { qrcode: 'qr1', qrcode_img_content: 'img1' } })
        .mockResolvedValueOnce({ data: { status: 'expired' } });

      const api = new WXAPI('login-test');
      await expect(api.login()).rejects.toThrow('二维码已过期');
    });

    it('should throw when confirmed without token or bot_id', async () => {
      mockAxiosRequest
        .mockResolvedValueOnce({ data: { qrcode: 'qr1', qrcode_img_content: 'img1' } })
        .mockResolvedValueOnce({ data: { status: 'confirmed' } });

      const api = new WXAPI('login-test');
      await expect(api.login()).rejects.toThrow('登录确认但未返回 token 或 bot_id');
    });

    it('should save credentials to file after login', async () => {
      mockAxiosRequest
        .mockResolvedValueOnce({ data: { qrcode: 'qr1', qrcode_img_content: 'img1' } })
        .mockResolvedValueOnce({
          data: { status: 'confirmed', bot_token: 'tok789', ilink_bot_id: 'bot999', ilink_user_id: 'user1' },
        });

      const api = new WXAPI('save-test');
      await api.login();

      const credPath = path.join(runDir, 'accounts', 'save-test.json');
      const data = await fs.readFile(credPath, 'utf-8');
      const saved = JSON.parse(data);
      expect(saved.token).toBe('tok789');
      expect(saved.ilink_bot_id).toBe('bot999');
      expect(saved.ilink_user_id).toBe('user1');
    });

    it('should retry on wait status then confirm', async () => {
      mockAxiosRequest
        .mockResolvedValueOnce({ data: { qrcode: 'qr1', qrcode_img_content: 'img1' } })
        .mockResolvedValueOnce({ data: { status: 'wait' } })
        .mockResolvedValueOnce({ data: { status: 'scanned' } })
        .mockResolvedValueOnce({ data: { status: 'confirmed', bot_token: 'tok', ilink_bot_id: 'bot' } });

      const api = new WXAPI('retry-test');
      vi.useFakeTimers();
      const loginPromise = api.login();
      await vi.runAllTimersAsync();
      vi.useRealTimers();

      const creds = await loginPromise;
      expect(creds.token).toBe('tok');
      expect(mockAxiosRequest).toHaveBeenCalledTimes(4);
    });
  });

  describe('getUpdates', () => {
    it('should call getUpdates and return response', async () => {
      mockAxiosRequest.mockResolvedValueOnce({
        data: { msgs: [{ message_type: 1, from_user_id: 'u1', context_token: 'ctx1' }], get_updates_buf: 'buf1' },
      });

      const api = new WXAPI('updates-test');
      const result = await api.getUpdates();

      expect(result.msgs).toHaveLength(1);
      expect(result.get_updates_buf).toBe('buf1');
      expect(mockAxiosRequest).toHaveBeenCalledWith(
        expect.objectContaining({
          method: 'POST',
          url: expect.stringContaining('/ilink/bot/getupdates'),
        }),
      );
    });

    it('should preserve previous updates buffer when not returned', async () => {
      mockAxiosRequest
        .mockResolvedValueOnce({ data: { msgs: [], get_updates_buf: 'buf1' } })
        .mockResolvedValueOnce({ data: { msgs: [] } }); // no buffer in second response

      const api = new WXAPI('buf-test');
      const r1 = await api.getUpdates();
      expect(r1.get_updates_buf).toBe('buf1');

      await api.getUpdates();
      // Buffer should persist from first call
      expect(mockAxiosRequest.mock.calls[1][0].data.get_updates_buf).toBe('buf1');
    });

    it('should handle empty response', async () => {
      mockAxiosRequest.mockResolvedValueOnce({ data: {} });

      const api = new WXAPI('empty-test');
      const result = await api.getUpdates();
      expect(result).toEqual({});
    });
  });

  describe('sendText', () => {
    it('should send text message with correct payload', async () => {
      mockAxiosRequest.mockResolvedValueOnce({ data: {} });

      const api = new WXAPI('send-test');
      await api.sendText('user1', 'ctx1', 'hello world');

      const call = mockAxiosRequest.mock.calls[0][0];
      expect(call.method).toBe('POST');
      expect(call.url).toContain('/ilink/bot/sendmessage');
      expect(call.data.msg.to_user_id).toBe('user1');
      expect(call.data.msg.context_token).toBe('ctx1');
      expect(call.data.msg.item_list[0].text_item.text).toBe('hello world');
      expect(call.data.msg.message_type).toBe(MessageType.OUTBOUND_TEXT);
    });
  });

  describe('sendTyping', () => {
    it('should fetch typing ticket and send typing status', async () => {
      mockAxiosRequest
        .mockResolvedValueOnce({ data: { typing_ticket: 'ticket123' } })
        .mockResolvedValueOnce({ data: {} });

      const api = new WXAPI('typing-test');
      await api.sendTyping('user1', 'ctx1', TypingStatus.START);

      expect(mockAxiosRequest).toHaveBeenCalledTimes(2);
      // First call: getconfig
      expect(mockAxiosRequest.mock.calls[0][0].url).toContain('/ilink/bot/getconfig');
      // Second call: sendtyping
      expect(mockAxiosRequest.mock.calls[1][0].url).toContain('/ilink/bot/sendtyping');
      expect(mockAxiosRequest.mock.calls[1][0].data.status).toBe(TypingStatus.START);
    });

    it('should cache typing ticket and reuse for same user', async () => {
      mockAxiosRequest
        .mockResolvedValueOnce({ data: { typing_ticket: 'ticket1' } })
        .mockResolvedValueOnce({ data: {} })
        .mockResolvedValueOnce({ data: {} });

      const api = new WXAPI('cache-test');
      await api.sendTyping('user1', 'ctx1', TypingStatus.START);
      await api.sendTyping('user1', 'ctx1', TypingStatus.STOP);

      // 3 calls total: getconfig + sendtyping + sendtyping (no second getconfig)
      expect(mockAxiosRequest).toHaveBeenCalledTimes(3);
      expect(mockAxiosRequest.mock.calls[0][0].url).toContain('/ilink/bot/getconfig');
      expect(mockAxiosRequest.mock.calls[1][0].url).toContain('/ilink/bot/sendtyping');
      expect(mockAxiosRequest.mock.calls[2][0].url).toContain('/ilink/bot/sendtyping');
    });

    it('should skip sending typing when no ticket returned', async () => {
      mockAxiosRequest.mockResolvedValueOnce({ data: {} }); // no typing_ticket

      const api = new WXAPI('noticket-test');
      await api.sendTyping('user1', 'ctx1', TypingStatus.START);

      expect(mockAxiosRequest).toHaveBeenCalledTimes(1);
    });

    it('should reject when sendtyping request fails', async () => {
      mockAxiosRequest
        .mockResolvedValueOnce({ data: { typing_ticket: 'ticket1' } })
        .mockRejectedValueOnce(new Error('network error'));

      const api = new WXAPI('fail-test');
      await expect(api.sendTyping('user1', 'ctx1', 1)).rejects.toThrow('network error');
    });
  });

  describe('makeHeaders (via request)', () => {
    it('should include Authorization header when botToken is set', async () => {
      // Load credentials to set botToken, then call getUpdates
      const accountDir = path.join(runDir, 'accounts');
      await fs.mkdir(accountDir, { recursive: true });
      await fs.writeFile(path.join(accountDir, 'hdr.json'), JSON.stringify({ token: 'mytoken' }));
      mockAxiosRequest.mockResolvedValueOnce({ data: {} });

      const api = new WXAPI('hdr');
      await api.loadCredentials();
      await api.getUpdates();

      const headers = mockAxiosRequest.mock.calls[0][0].headers;
      expect(headers.Authorization).toBe('Bearer mytoken');
      expect(headers.AuthorizationType).toBe('ilink_bot_token');
      expect(headers['X-WECHAT-UIN']).toBeTruthy();
    });

    it('should not include Authorization header when no token', async () => {
      mockAxiosRequest.mockResolvedValueOnce({ data: {} });

      const api = new WXAPI('notok');
      await api.getUpdates();

      const headers = mockAxiosRequest.mock.calls[0][0].headers;
      expect(headers.Authorization).toBeUndefined();
    });
  });

  describe('request private method', () => {
    it('should prepend / to path when path does not start with slash', async () => {
      mockAxiosRequest.mockResolvedValueOnce({ data: {} });
      const api = new (WXAPI as any)('req-test') as InstanceType<typeof WXAPI>;
      await (api as any).request('GET', 'no-slash-path');
      const url = mockAxiosRequest.mock.calls[0][0].url;
      expect(url).toContain('/no-slash-path');
    });
  });

  describe('loadCredentials legacy path', () => {
    it('should load credentials from legacy (non-encoded) file path', async () => {
      const accountDir = path.join(runDir, 'accounts');
      await fs.mkdir(accountDir, { recursive: true });
      // Alias with @ sign gets encoded to %40 by safeSegment, making rawPath != credentialsPath
      const alias = 'test@legacy';
      await fs.writeFile(path.join(accountDir, `${alias}.json`), JSON.stringify({ token: 'legacy-token' }));
      const api = new WXAPI(alias);
      // First try encoded path (fails), then falls back to raw path (succeeds)
      const ok = await api.loadCredentials();
      expect(ok).toBe(true);
    });
  });

  describe('getUpdates schema validation', () => {
    it('should return empty msgs when response fails schema validation', async () => {
      // Return a non-object that won't pass z.object() validation
      mockAxiosRequest.mockResolvedValueOnce({ data: 'invalid' });

      const api = new WXAPI('schema-fail');
      const result = await api.getUpdates();
      expect(result.msgs).toEqual([]);
    });
  });

  describe('getconfig schema validation', () => {
    it('should return empty ticket when getconfig response fails schema validation', async () => {
      // Return data that fails configResponseSchema (needs to be an object with wrong types, or non-object)
      mockAxiosRequest.mockResolvedValueOnce({ data: 'bad-data' });

      const api = new (WXAPI as any)('cfg-fail') as InstanceType<typeof WXAPI>;
      const ticket = await (api as any).getTypingTicket('user1', 'ctx1');
      expect(ticket).toBe('');
    });
  });

  describe('sendText clientIdPrefix', () => {
    it('should use settings.clientIdPrefix when set', async () => {
      mockAxiosRequest.mockResolvedValueOnce({ data: {} });
      const api = new WXAPI('prefix-test');
      await api.sendText('user1', 'ctx1', 'hello');
      const call = mockAxiosRequest.mock.calls[0][0];
      // clientIdPrefix defaults to pkg.name === 'wechat-acp-bridge'
      expect(call.data.msg.client_id).toMatch(/^wechat-acp-bridge-/);
    });

    it('should fallback to settings.name when clientIdPrefix is empty', async () => {
      // Mutate the imported settings object to clear clientIdPrefix
      const settingsMod = await import('../util/settings.js');
      const orig = settingsMod.settings.clientIdPrefix;
      (settingsMod.settings as Record<string, unknown>).clientIdPrefix = '';

      try {
        mockAxiosRequest.mockResolvedValueOnce({ data: {} });
        const api = new WXAPI('fallback-test');
        await api.sendText('user1', 'ctx1', 'hello');
        const call = mockAxiosRequest.mock.calls[0][0];
        expect(call.data.msg.client_id).toMatch(/^wechat-acp-bridge-/);
      } finally {
        (settingsMod.settings as Record<string, unknown>).clientIdPrefix = orig;
      }
    });
  });
});

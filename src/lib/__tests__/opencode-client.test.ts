import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

vi.mock('undici', () => ({
  fetch: vi.fn(),
  Agent: vi.fn(),
}));

import { fetch as undiciFetch } from 'undici';
import { extractFirstJsonObject, runPrompt } from '../opencode-client';

const mockFetch = vi.mocked(undiciFetch);

function response(body: unknown, ok = true, status = 200) {
  return {
    ok,
    status,
    json: async () => body,
  } as unknown as Response;
}

beforeEach(() => {
  mockFetch.mockReset();
  process.env.OPENCODE_BASE_URL = 'https://opencode.test';
  process.env.OPENCODE_API_KEY = 'test-key';
  delete process.env.OPENCODE_ALLOW_INSECURE_TLS;
});

afterEach(() => {
  delete process.env.OPENCODE_BASE_URL;
  delete process.env.OPENCODE_API_KEY;
  delete process.env.OPENCODE_ALLOW_INSECURE_TLS;
});

describe('runPrompt', () => {
  it('creates a session, polls the message endpoint and parses JSON', async () => {
    mockFetch
      .mockResolvedValueOnce(response({ data: { id: 'ses_1' } }))
      .mockResolvedValueOnce(response({ data: { id: 'msg_1' } }))
      .mockResolvedValueOnce(
        response({
          data: [
            {
              type: 'assistant',
              finish: 'stop',
              content: [{ type: 'text', text: 'Sure: {"type":"weekly"} — done.' }],
            },
          ],
        })
      );

    const result = await runPrompt<{ type: string }>('classify this');

    expect(result).toEqual({ type: 'weekly' });
    expect(mockFetch).toHaveBeenCalledTimes(3);
    expect(mockFetch.mock.calls[0][0]).toBe('https://opencode.test/api/session');
    expect(mockFetch.mock.calls[1][0]).toBe('https://opencode.test/api/session/ses_1/prompt');
    expect(mockFetch.mock.calls[2][0]).toBe(
      'https://opencode.test/api/session/ses_1/message?limit=50&order=desc'
    );
  });

  it('sends the V2 prompt body ({"text"}, not {"prompt":{"text"}})', async () => {
    mockFetch
      .mockResolvedValueOnce(response({ data: { id: 'ses_1' } }))
      .mockResolvedValueOnce(response({ data: { id: 'msg_1' } }))
      .mockResolvedValueOnce(
        response({
          data: [{ type: 'assistant', finish: 'stop', content: [{ type: 'text', text: '{"a":1}' }] }],
        })
      );

    await runPrompt('hello');

    const init = mockFetch.mock.calls[1][1] as { body: string };
    expect(JSON.parse(init.body)).toEqual({ text: 'hello' });
  });

  it('finds the assistant reply when V2 appends idle/system entries after it', async () => {
    mockFetch
      .mockResolvedValueOnce(response({ data: { id: 'ses_1' } }))
      .mockResolvedValueOnce(response({ data: { id: 'msg_1' } }))
      .mockResolvedValueOnce(
        response({
          data: [
            { type: 'idle', outcome: 'completed' },
            { type: 'system' },
            { type: 'assistant', finish: 'stop', content: [{ type: 'text', text: '{"type":"weekly"}' }] },
            { type: 'user' },
          ],
        })
      );

    const result = await runPrompt<{ type: string }>('x');
    expect(result).toEqual({ type: 'weekly' });
    expect(mockFetch).toHaveBeenCalledTimes(3);
  });

  it('keeps polling while the newest assistant step ended in tool-calls', async () => {
    mockFetch
      .mockResolvedValueOnce(response({ data: { id: 'ses_1' } }))
      .mockResolvedValueOnce(response({ data: { id: 'msg_1' } }))
      .mockResolvedValueOnce(
        response({ data: [{ type: 'assistant', finish: 'tool-calls', content: [] }] })
      )
      .mockResolvedValueOnce(
        response({
          data: [{ type: 'assistant', finish: 'stop', content: [{ type: 'text', text: '{"ok":true}' }] }],
        })
      );

    const result = await runPrompt<{ ok: boolean }>('x');
    expect(result).toEqual({ ok: true });
    expect(mockFetch).toHaveBeenCalledTimes(4);
  });

  it('interrupts and deletes the session when an attempt fails', async () => {
    mockFetch
      .mockResolvedValueOnce(response({ data: { id: 'ses_bad' } }))
      .mockResolvedValueOnce(response({}, false, 400)) // prompt rejected
      .mockResolvedValueOnce(response({ interrupted: true })) // interrupt
      .mockResolvedValueOnce(response({})) // delete
      .mockResolvedValueOnce(response({ data: { id: 'ses_ok' } }))
      .mockResolvedValueOnce(response({ data: { id: 'msg_1' } }))
      .mockResolvedValueOnce(
        response({
          data: [{ type: 'assistant', finish: 'stop', content: [{ type: 'text', text: '{"ok":true}' }] }],
        })
      );

    const result = await runPrompt<{ ok: boolean }>('x');
    expect(result).toEqual({ ok: true });
    expect(mockFetch.mock.calls[2][0]).toBe('https://opencode.test/api/session/ses_bad/interrupt');
    expect((mockFetch.mock.calls[2][1] as { method: string }).method).toBe('POST');
    expect(mockFetch.mock.calls[3][0]).toBe('https://opencode.test/api/session/ses_bad');
    expect((mockFetch.mock.calls[3][1] as { method: string }).method).toBe('DELETE');
  });

  it('does not let a failing cleanup hide the original error', async () => {
    mockFetch.mockImplementation(async (url: unknown, init?: unknown) => {
      const u = String(url);
      const method = (init as { method?: string } | undefined)?.method;
      if (u.endsWith('/api/session')) return response({ data: { id: 'ses_x' } });
      if (u.endsWith('/prompt')) return response({}, false, 400);
      if (u.endsWith('/interrupt') || method === 'DELETE') throw new Error('network down');
      return response({});
    });

    await expect(
      runPrompt('x', { models: [{ id: 'm', providerID: 'p' }] })
    ).rejects.toThrow(/opencode prompt failed: 400/);
  });

  it('retries a failed attempt before succeeding', async () => {
    mockFetch
      .mockResolvedValueOnce(response({}, false, 503))
      .mockResolvedValueOnce(response({ data: { id: 'ses_2' } }))
      .mockResolvedValueOnce(response({ data: { id: 'msg_2' } }))
      .mockResolvedValueOnce(
        response({
          data: [
            {
              type: 'assistant',
              finish: 'stop',
              content: [{ type: 'text', text: '{"ok":true}' }],
            },
          ],
        })
      );

    const result = await runPrompt<{ ok: boolean }>('x');
    expect(result).toEqual({ ok: true });
  });

  it('throws when opencode is not configured', async () => {
    delete process.env.OPENCODE_BASE_URL;
    await expect(runPrompt('x')).rejects.toThrow(/not configured/);
  });
});

describe('extractFirstJsonObject', () => {
  it('ignores trailing prose and braces inside strings', () => {
    const text = 'Here {"name":"a } b","nested":{"x":1}} and then prose {not json}';
    expect(extractFirstJsonObject(text)).toBe('{"name":"a } b","nested":{"x":1}}');
  });

  it('rejects replies without JSON', () => {
    expect(() => extractFirstJsonObject('no json here')).toThrow(/did not contain JSON/);
  });
});

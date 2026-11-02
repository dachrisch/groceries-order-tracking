import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

vi.mock('undici', () => ({
  fetch: vi.fn(),
  Agent: vi.fn(),
}));

import { fetch as undiciFetch } from 'undici';
import {
  extractFirstJsonObject,
  getModelChain,
  isFree,
  isUsable,
  resetModelCacheForTests,
  runPrompt,
  type RegistryModel,
} from '../opencode-client';

// Sequential-mock tests pin the chain so no /api/model discovery call is made.
const M = { models: [{ id: 'm1', providerID: 'opencode' }] };

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
  resetModelCacheForTests();
  delete process.env.OPENCODE_MODELS;
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

    const result = await runPrompt<{ type: string }>('classify this', M);

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

    await runPrompt('hello', M);

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

    const result = await runPrompt<{ type: string }>('x', M);
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

    const result = await runPrompt<{ ok: boolean }>('x', M);
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

    const result = await runPrompt<{ ok: boolean }>('x', M);
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

    const result = await runPrompt<{ ok: boolean }>('x', M);
    expect(result).toEqual({ ok: true });
  });

  it('throws when opencode is not configured', async () => {
    delete process.env.OPENCODE_BASE_URL;
    await expect(runPrompt('x', M)).rejects.toThrow(/not configured/);
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

const free = (id: string, extra: Partial<RegistryModel> = {}): RegistryModel => ({
  id,
  providerID: 'opencode',
  status: 'active',
  enabled: true,
  cost: [{ input: 0, output: 0 }],
  ...extra,
});

function routed(registry: unknown, opts: { registryStatus?: number; promptStatus?: Record<string, number> } = {}) {
  const created: string[] = [];
  mockFetch.mockImplementation(async (url: unknown, init?: unknown) => {
    const u = String(url);
    const i = (init ?? {}) as { method?: string; body?: string };
    if (u.endsWith('/api/model')) {
      return response(registry, (opts.registryStatus ?? 200) < 400, opts.registryStatus ?? 200);
    }
    if (u.endsWith('/api/session') && i.method === 'POST') {
      const model = JSON.parse(i.body ?? '{}').model.id as string;
      created.push(model);
      return response({ data: { id: `ses_${model}` } });
    }
    if (u.endsWith('/prompt')) {
      const model = u.split('/api/session/ses_')[1].split('/')[0];
      const status = opts.promptStatus?.[model];
      return status ? response({}, false, status) : response({ data: {} });
    }
    if (u.includes('/message')) {
      return response({
        data: [{ type: 'assistant', finish: 'stop', content: [{ type: 'text', text: '{"ok":true}' }] }],
      });
    }
    return response({});
  });
  return created;
}

describe('model discovery', () => {
  it('uses only active, free opencode models from GET /api/model, in preference order', async () => {
    routed({
      data: [
        free('some-other-free'),
        free('mimo-v2.5-free', { status: 'deprecated' }),
        free('paid-model', { cost: [{ input: 0.15, output: 0.6 }] }),
        free('other-provider-free', { providerID: 'google' }),
        free('disabled-free', { enabled: false }),
        free('big-pickle'),
      ],
    });

    const chain = await getModelChain();
    expect(chain).toEqual([
      { id: 'big-pickle', providerID: 'opencode' },
      { id: 'some-other-free', providerID: 'opencode' },
    ]);
  });

  it('never creates a session for a model the registry does not list', async () => {
    const created = routed({ data: [free('nemotron-3.5-lightning-free')] });
    await runPrompt('x');
    expect(created).toEqual(['nemotron-3.5-lightning-free']);
  });

  it('falls back to the pinned preference list when discovery fails', async () => {
    routed({}, { registryStatus: 500 });
    const chain = await getModelChain();
    expect(chain.length).toBeGreaterThan(0);
    expect(chain.every((m) => m.providerID === 'opencode')).toBe(true);
  });

  it('fails clearly when the registry lists no free model', async () => {
    routed({ data: [free('paid-model', { cost: [{ input: 1, output: 1 }] })] });
    await expect(runPrompt('x')).rejects.toThrow(/no free opencode model/);
  });

  it('caches the registry between calls', async () => {
    routed({ data: [free('big-pickle')] });
    await runPrompt('a');
    await runPrompt('b');
    const discoveries = mockFetch.mock.calls.filter(([u]) => String(u).endsWith('/api/model'));
    expect(discoveries).toHaveLength(1);
  });

  it('moves straight to the next model on a quota error and skips it while cooling down', async () => {
    const created = routed(
      { data: [free('big-pickle'), free('ling-3.1-flash-free')] },
      { promptStatus: { 'big-pickle': 429 } }
    );

    await runPrompt('first');
    expect(created).toEqual(['big-pickle', 'ling-3.1-flash-free']);

    created.length = 0;
    await runPrompt('second');
    expect(created).toEqual(['ling-3.1-flash-free']);
  });

  it('honours OPENCODE_MODELS but drops entries the registry cannot serve', async () => {
    process.env.OPENCODE_MODELS = 'opencode:gone-free,opencode:big-pickle';
    routed({ data: [free('big-pickle')] });
    expect(await getModelChain()).toEqual([{ id: 'big-pickle', providerID: 'opencode' }]);
  });

  it('classifies registry entries', () => {
    expect(isUsable(free('a'))).toBe(true);
    expect(isUsable(free('a', { status: 'deprecated' }))).toBe(false);
    expect(isFree(free('a'))).toBe(true);
    expect(isFree(free('a', { cost: [{ input: 0.15, output: 0.6 }] }))).toBe(false);
    expect(isFree(free('a', { cost: undefined }))).toBe(false);
  });
});

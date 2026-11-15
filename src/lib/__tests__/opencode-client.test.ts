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
  delete process.env.OPENCODE_VISION_MODELS;
  delete process.env.OPENCODE_VISION_PAID;
});

afterEach(() => {
  delete process.env.OPENCODE_BASE_URL;
  delete process.env.OPENCODE_API_KEY;
  delete process.env.OPENCODE_ALLOW_INSECURE_TLS;
  vi.restoreAllMocks();
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

/** Wire shape of a GET /api/model entry: cost and input modalities in one line. */
const capable = (id: string, input: string[], cost = 0, providerID = 'opencode') => ({
  id,
  providerID,
  status: 'active',
  cost: [{ input: cost, output: cost }],
  capabilities: { input },
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

describe('image prompts', () => {
  it('sends files with the prompt', async () => {
    mockFetch
      .mockResolvedValueOnce(response({ data: { id: 'ses_1' } }))
      .mockResolvedValueOnce(response({ data: { id: 'msg_1' } }))
      .mockResolvedValueOnce(
        response({ data: [{ type: 'assistant', finish: 'stop', content: [{ type: 'text', text: '{"ok":true}' }] }] })
      );

    await runPrompt('read it', {
      ...M,
      files: [{ uri: 'data:image/jpeg;base64,AAAA', source: { type: 'inline' }, name: 'list.jpg' }],
    });

    const body = JSON.parse(String(mockFetch.mock.calls[1][1]?.body));
    expect(body.files).toHaveLength(1);
    expect(body.files[0].source).toEqual({ type: 'inline' });
    expect(body.text).toBe('read it');
  });

  it('keeps text-only models out of a vision chain', async () => {
    mockFetch.mockResolvedValue(
      response({ data: [capable('texto', ['text']), capable('seer', ['text', 'image'])] })
    );

    await expect(getModelChain({ require: 'image' })).resolves.toEqual([{ id: 'seer', providerID: 'opencode' }]);
    await expect(getModelChain()).resolves.toEqual([
      { id: 'texto', providerID: 'opencode' },
      { id: 'seer', providerID: 'opencode' },
    ]);
  });

  it('appends only the verified paid tier, after every free vision model', async () => {
    mockFetch.mockResolvedValueOnce(
      response({
        data: [
          { id: 'mimo-v2.6-flash-free', providerID: 'opencode', status: 'active', cost: [{ input: 0, output: 0 }], capabilities: { input: ['text', 'image'] } },
          { id: 'gpt-6-luna', providerID: 'opencode-go', status: 'active', cost: [{ input: 0.1, output: 0.5 }], capabilities: { input: ['text', 'image'] } },
          // Paid, image-capable in the registry, but it never received the probe photo.
          { id: 'gemini-2.5-flash-lite', providerID: 'google', status: 'active', cost: [{ input: 0.1, output: 0.4 }], capabilities: { input: ['text', 'image'] } },
        ],
      })
    );

    await expect(getModelChain({ require: 'image', allowPaid: true })).resolves.toEqual([
      { id: 'mimo-v2.6-flash-free', providerID: 'opencode' },
      { id: 'gpt-6-luna', providerID: 'opencode-go', paid: true },
    ]);
  });

  it('stays free-only when the caller did not ask for paid models', async () => {
    mockFetch.mockResolvedValueOnce(
      response({
        data: [
          { id: 'gpt-6-luna', providerID: 'opencode-go', status: 'active', cost: [{ input: 0.1, output: 0.5 }], capabilities: { input: ['text', 'image'] } },
        ],
      })
    );

    await expect(getModelChain({ require: 'image' })).rejects.toThrow(/no vision-capable/i);
  });

  it('gives a paid model one attempt, not three', async () => {
    mockFetch.mockImplementation(async (url: unknown) => {
      if (String(url).endsWith('/api/session')) return response({ data: { id: 'ses_x' } });
      if (String(url).includes('/prompt')) return response({ error: 'boom' }, false, 500);
      return response({});
    });

    await expect(
      runPrompt('x', { models: [{ id: 'gpt-6-luna', providerID: 'opencode-go', paid: true }] })
    ).rejects.toThrow(/prompt failed/);

    const created = mockFetch.mock.calls.filter(([url]) => String(url).endsWith('/api/session'));
    expect(created).toHaveLength(1);
  });

  it('filters a pinned vision override down to image-capable models', async () => {
    process.env.OPENCODE_VISION_MODELS = 'opencode:texto,opencode:seer';
    mockFetch.mockResolvedValueOnce(
      response({
        data: [
          { id: 'texto', providerID: 'opencode', status: 'active', cost: [{ input: 0, output: 0 }], capabilities: { input: ['text'] } },
          { id: 'seer', providerID: 'opencode', status: 'active', cost: [{ input: 0, output: 0 }], capabilities: { input: ['text', 'image'] } },
        ],
      })
    );

    await expect(getModelChain({ require: 'image' })).resolves.toEqual([{ id: 'seer', providerID: 'opencode' }]);
  });

  it('drops the paid tier when OPENCODE_VISION_PAID is off', async () => {
    process.env.OPENCODE_VISION_PAID = 'off';
    mockFetch.mockResolvedValueOnce(
      response({
        data: [capable('mimo-v2.6-flash-free', ['text', 'image']), capable('gpt-6-luna', ['text', 'image'], 0.1, 'opencode-go')],
      })
    );

    await expect(getModelChain({ require: 'image', allowPaid: true })).resolves.toEqual([
      { id: 'mimo-v2.6-flash-free', providerID: 'opencode' },
    ]);
  });

  it('reads OPENCODE_VISION_PAID the way an operator writes it', async () => {
    process.env.OPENCODE_VISION_PAID = '0';
    mockFetch.mockResolvedValueOnce(
      response({
        data: [capable('mimo-v2.6-flash-free', ['text', 'image']), capable('gpt-6-luna', ['text', 'image'], 0.1, 'opencode-go')],
      })
    );

    await expect(getModelChain({ require: 'image', allowPaid: true })).resolves.toEqual([
      { id: 'mimo-v2.6-flash-free', providerID: 'opencode' },
    ]);
  });

  it('never adds the paid tier to a text chain', async () => {
    mockFetch.mockResolvedValueOnce(
      response({
        data: [capable('texto', ['text']), capable('gpt-6-luna', ['text', 'image'], 0.1, 'opencode-go')],
      })
    );

    await expect(getModelChain({ allowPaid: true })).resolves.toEqual([{ id: 'texto', providerID: 'opencode' }]);
  });

  it('falls back to the pinned free vision list, then the curated paid tier', async () => {
    mockFetch.mockResolvedValueOnce(response({}, false, 500));

    const chain = await getModelChain({ require: 'image', allowPaid: true });

    expect(chain[0]).toEqual({ id: 'mimo-v2.6-flash-free', providerID: 'opencode' });
    // The text preference list would pin big-pickle, which cannot see a photo.
    expect(chain.map((m) => m.id)).not.toContain('big-pickle');
    const firstPaid = chain.findIndex((m) => m.paid);
    expect(chain.slice(0, firstPaid).every((m) => m.providerID === 'opencode')).toBe(true);
    expect(chain.slice(firstPaid).map((m) => m.id)).toEqual(['gpt-6-luna', 'qwen/qwen3.7-flash', 'qwen-vl-ocr']);
  });

  it('excludes a model without capabilities from a vision chain but keeps it for text', async () => {
    mockFetch.mockResolvedValue(
      response({
        data: [
          { id: 'no-caps', providerID: 'opencode', status: 'active', cost: [{ input: 0, output: 0 }] },
          capable('seer', ['text', 'image']),
        ],
      })
    );

    await expect(getModelChain({ require: 'image' })).resolves.toEqual([{ id: 'seer', providerID: 'opencode' }]);
    await expect(getModelChain()).resolves.toEqual([
      { id: 'no-caps', providerID: 'opencode' },
      { id: 'seer', providerID: 'opencode' },
    ]);
  });

  it('keeps a pinned paid model in the chain once and gives it one attempt', async () => {
    process.env.OPENCODE_VISION_MODELS = 'opencode-go:gpt-6-luna';
    const created: string[] = [];
    mockFetch.mockImplementation(async (url: unknown) => {
      const u = String(url);
      if (u.endsWith('/api/model')) return response({ data: [capable('gpt-6-luna', ['text', 'image'], 0.1, 'opencode-go')] });
      if (u.endsWith('/api/session')) {
        created.push('gpt-6-luna');
        return response({ data: { id: 'ses_p' } });
      }
      if (u.endsWith('/prompt')) return response({}, false, 500);
      return response({});
    });

    await expect(getModelChain({ require: 'image', allowPaid: true })).resolves.toEqual([
      { id: 'gpt-6-luna', providerID: 'opencode-go', paid: true },
    ]);

    await expect(runPrompt('x', { require: 'image', allowPaid: true })).rejects.toThrow(/prompt failed/);
    expect(created).toHaveLength(1);
  });

  it('still uses a pinned vision model when the paid tier is switched off', async () => {
    process.env.OPENCODE_VISION_PAID = 'off';
    process.env.OPENCODE_VISION_MODELS = 'opencode-go:gpt-6-luna';
    mockFetch.mockResolvedValueOnce(
      response({ data: [capable('gpt-6-luna', ['text', 'image'], 0.1, 'opencode-go')] })
    );

    await expect(getModelChain({ require: 'image', allowPaid: true })).resolves.toEqual([
      { id: 'gpt-6-luna', providerID: 'opencode-go', paid: true },
    ]);
  });

  it('does not buy a pinned paid model twice when discovery is down', async () => {
    process.env.OPENCODE_VISION_MODELS = 'opencode-go:gpt-6-luna';
    mockFetch.mockResolvedValueOnce(response({}, false, 500));

    const chain = await getModelChain({ require: 'image', allowPaid: true });

    expect(chain[0]).toEqual({ id: 'gpt-6-luna', providerID: 'opencode-go', paid: true });
    expect(chain.map((m) => m.id)).toEqual(['gpt-6-luna', 'qwen/qwen3.7-flash', 'qwen-vl-ocr']);
  });

  it('reports the answering model once, after the reply parsed', async () => {
    mockFetch
      .mockResolvedValueOnce(response({ data: { id: 'ses_1' } }))
      .mockResolvedValueOnce(response({ data: { id: 'msg_1' } }))
      .mockResolvedValueOnce(
        response({ data: [{ type: 'assistant', finish: 'stop', content: [{ type: 'text', text: 'yes: {"ok":true}' }] }] })
      );

    const used: string[] = [];
    await runPrompt('x', { ...M, onModelUsed: (model) => used.push(model.id) });
    expect(used).toEqual(['m1']);
  });

  it('logs a paid model that answered, so a fallback is never silent', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    mockFetch
      .mockResolvedValueOnce(response({ data: { id: 'ses_1' } }))
      .mockResolvedValueOnce(response({ data: { id: 'msg_1' } }))
      .mockResolvedValueOnce(
        response({ data: [{ type: 'assistant', finish: 'stop', content: [{ type: 'text', text: '{"ok":true}' }] }] })
      );

    const used: string[] = [];
    await runPrompt('x', {
      models: [{ id: 'gpt-6-luna', providerID: 'opencode-go', paid: true }],
      onModelUsed: (model) => used.push(model.id),
    });

    expect(used).toEqual(['gpt-6-luna']);
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('paid fallback used: opencode-go:gpt-6-luna'));
  });

  it('warns when the paid tier was requested but the registry serves none of it', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    mockFetch.mockResolvedValueOnce(response({ data: [capable('mimo-v2.6-flash-free', ['text', 'image'])] }));

    await expect(getModelChain({ require: 'image', allowPaid: true })).resolves.toEqual([
      { id: 'mimo-v2.6-flash-free', providerID: 'opencode' },
    ]);
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('staying free-only'));
  });

  it('does not report a model that answered with prose instead of JSON', async () => {
    mockFetch
      .mockResolvedValueOnce(response({ data: { id: 'ses_1' } }))
      .mockResolvedValueOnce(response({ data: { id: 'msg_1' } }))
      .mockResolvedValueOnce(
        response({ data: [{ type: 'assistant', finish: 'stop', content: [{ type: 'text', text: 'no json here, sorry' }] }] })
      );

    const used: string[] = [];
    await expect(
      runPrompt('x', {
        models: [{ id: 'gpt-6-luna', providerID: 'opencode-go', paid: true }],
        onModelUsed: (model) => used.push(model.id),
      })
    ).rejects.toThrow(/did not contain JSON/);
    expect(used).toEqual([]);
  });
});

import { describe, it, expect, vi } from 'vitest';
import {
  EasyShopperClient,
  EasyShopperError,
  basicAuth,
  buildSearchBody,
  SEARCH_LIMIT,
} from '../easyshopper/client';

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

interface Call {
  url: string;
  init: RequestInit;
}

function recordingFetch(responses: Array<() => Response>) {
  const calls: Call[] = [];
  let index = 0;
  const impl = async (url: string, init?: RequestInit) => {
    calls.push({ url, init: init ?? {} });
    const next = responses[Math.min(index, responses.length - 1)];
    index += 1;
    return next();
  };
  return { calls, impl };
}

describe('buildSearchBody', () => {
  it('builds the Mongo-style query the app sends', () => {
    const body = buildSearchBody({
      queryText: 'milch 4001234567890',
      storeGuid: 'store-1',
      userGuid: 'user-1',
      attributes: ['organic'],
      categoryGroupIds: ['cg-1'],
    });

    expect(body).toMatchObject({
      queryText: 'milch 4001234567890',
      skip: 0,
      limit: SEARCH_LIMIT,
      userGuid: 'user-1',
      includeGroups: true,
      fuzzy: false,
    });
    const query = body.query as Record<string, unknown>;
    expect(query.storeGuid).toBe('store-1');
    expect(query.flag).toBeNull();
    expect(query.$and).toEqual([
      { $or: [{ gtin: '4001234567890' }] },
      { text: 'milch' },
      { flag: 'organic' },
    ]);
    expect(query.$or).toEqual([{ cgId: 'cg-1' }]);
  });

  it('omits the category clause when no group is selected', () => {
    const query = buildSearchBody({ queryText: 'brot', storeGuid: 's' }).query as Record<string, unknown>;
    expect(query.$or).toBeUndefined();
  });
});

describe('basicAuth', () => {
  it('encodes secret:deviceId, not deviceId:secret', () => {
    const header = basicAuth({ secret: 'sec', deviceId: 'dev' });
    expect(header).toBe(`Basic ${Buffer.from('sec:dev').toString('base64')}`);
  });
});

describe('EasyShopperClient', () => {
  it('signs up a device and returns the credential pair', async () => {
    const { calls, impl } = recordingFetch([() => jsonResponse({ secret: 's', deviceId: 'd' })]);
    const client = new EasyShopperClient({ baseUrl: 'https://api.test/mobile-backend/api' }, impl);

    const credentials = await client.signup('store-1');

    expect(credentials).toEqual({ secret: 's', deviceId: 'd' });
    expect(calls[0].url).toBe('https://api.test/mobile-backend/api/v4/signup');
    expect(calls[0].init.method).toBe('POST');
    const headers = calls[0].init.headers as Record<string, string>;
    expect(headers['X-Subscription-Key']).toBeTruthy();
    expect(headers.Authorization).toBeUndefined();
    expect(JSON.parse(String(calls[0].init.body))).toEqual({ storeGuid: 'store-1' });
  });

  it('rejects a signup response without credentials', async () => {
    const { impl } = recordingFetch([() => jsonResponse({})]);
    const client = new EasyShopperClient({ baseUrl: 'https://api.test' }, impl);
    await expect(client.signup('store-1')).rejects.toBeInstanceOf(EasyShopperError);
  });

  it('logs in with basic auth and maps the session fields', async () => {
    const { calls, impl } = recordingFetch([
      () => jsonResponse({ authenticationToken: 'tok', userGuid: 'u', storeGuid: 's' }),
    ]);
    const client = new EasyShopperClient({ baseUrl: 'https://api.test' }, impl);

    const session = await client.login({ secret: 'sec', deviceId: 'dev' }, 'uuid-1');

    expect(session).toEqual({ token: 'tok', userGuid: 'u', storeGuid: 's' });
    const headers = calls[0].init.headers as Record<string, string>;
    expect(headers.Authorization).toBe(basicAuth({ secret: 'sec', deviceId: 'dev' }));
    expect(JSON.parse(String(calls[0].init.body))).toEqual({ uniqueDeviceId: 'uuid-1' });
  });

  it('reports an expired token instead of throwing', async () => {
    const { impl } = recordingFetch([() => new Response('', { status: 401 })]);
    const client = new EasyShopperClient({ baseUrl: 'https://api.test' }, impl);
    await expect(client.validateToken('stale')).resolves.toBe(false);
  });

  it('surfaces API errors with their status', async () => {
    const { impl } = recordingFetch([() => new Response('{"title":"Unauthorized"}', { status: 401 })]);
    const client = new EasyShopperClient({ baseUrl: 'https://api.test' }, impl);
    await expect(client.listShoppingLists('bad')).rejects.toMatchObject({ status: 401 });
  });

  it('accepts terms and privacy with the returned legal ids', async () => {
    const { calls, impl } = recordingFetch([
      () => jsonResponse({ legalGuid: 'terms-1' }),
      () => jsonResponse({}),
      () => jsonResponse({ legalGuid: 'privacy-1' }),
      () => jsonResponse({}),
    ]);
    const client = new EasyShopperClient({ baseUrl: 'https://api.test' }, impl);

    await client.acceptLegal('tok');

    expect(calls.map((call) => `${call.init.method} ${call.url}`)).toEqual([
      'GET https://api.test/v4/termsAndConditions',
      'PUT https://api.test/v4/acceptTermsAndConditions',
      'GET https://api.test/v4/dataPrivacy',
      'PUT https://api.test/v4/acceptDataPrivacy',
    ]);
    expect(JSON.parse(String(calls[1].init.body))).toEqual({ legalGuid: 'terms-1' });
    expect(JSON.parse(String(calls[3].init.body))).toEqual({ legalGuid: 'privacy-1' });
  });

  it('searches products and normalises a partial response', async () => {
    const { calls, impl } = recordingFetch([() => jsonResponse({ items: [{ product: { name: 'Milch' } }] })]);
    const client = new EasyShopperClient({ baseUrl: 'https://api.test' }, impl);

    const result = await client.searchProducts('tok', { queryText: 'milch', storeGuid: 's' });

    expect(result.count).toBe(0);
    expect(result.groups).toEqual([]);
    expect(result.items).toHaveLength(1);
    expect(calls[0].url).toBe('https://api.test/v6/searchMeta');
  });

  it('deletes by sending amount 0, as the app does', async () => {
    const { calls, impl } = recordingFetch([() => jsonResponse({})]);
    const client = new EasyShopperClient({ baseUrl: 'https://api.test' }, impl);

    await client.removeItem('tok', 'store-1', 'item-9');

    expect(calls[0].url).toBe('https://api.test/v5/shoppingList/addOrUpdate/store-1');
    const payload = JSON.parse(String(calls[0].init.body));
    expect(payload).toMatchObject({ shoppingListItemGuid: 'item-9', amount: 0 });
  });

  it('reads the plain-text invite URL that createLink returns', async () => {
    const invite =
      'https://feature-app-links.easy-shopper-com.pages.dev/app/es-prod/shopping-list-invite?shoppingListGuid=list-1&token=tok-1';
    const { calls, impl } = recordingFetch([() => new Response(invite, { status: 200 })]);
    const client = new EasyShopperClient({ baseUrl: 'https://api.test' }, impl);

    const link = await client.createShareLink('tok', 'list-1');

    expect(link).toBe(invite);
    expect(calls[0].url).toBe('https://api.test/v7/shoppingLists/list-1/createLink');
  });

  it('rebuilds an invite URL from a JSON linkToken', async () => {
    const { impl } = recordingFetch([() => jsonResponse({ linkToken: 'tok-9' })]);
    const client = new EasyShopperClient({ baseUrl: 'https://api.test' }, impl);

    const link = await client.createShareLink('tok', 'list-9');

    expect(link).toContain('/es-test/shopping-list-invite?');
    expect(link).toContain('shoppingListGuid=list-9');
    expect(link).toContain('token=tok-9');
  });

  it('falls back to the first list when none matches the store', async () => {
    const client = new EasyShopperClient({ baseUrl: 'https://api.test' }, async () =>
      jsonResponse([{ guid: 'list-a' }])
    );
    const lists = await client.listShoppingLists('tok');
    expect(lists[0].guid).toBe('list-a');
  });

  it('sends a timeout signal so a hung request cannot block a job', async () => {
    const impl = vi.fn(async (_url: string, init?: RequestInit) => {
      expect(init?.signal).toBeInstanceOf(AbortSignal);
      return jsonResponse({});
    });
    const client = new EasyShopperClient({ baseUrl: 'https://api.test' }, impl);
    await client.listShoppingLists('tok');
    expect(impl).toHaveBeenCalledOnce();
  });
});

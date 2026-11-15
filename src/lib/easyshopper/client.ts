/**
 * EASY Shopper (Whiz-Cart) REST client.
 *
 * Shapes and paths come from the shipped Android app (Hermes bytecode + BuildConfig),
 * not from guesswork — see docs/easyshopper-api.md:
 *
 *   POST /v4/signup                      {storeGuid}            -> {secret, deviceId}
 *   POST /v4/login                       {uniqueDeviceId} + Basic secret:deviceId
 *                                                               -> {authenticationToken, userGuid, storeGuid}
 *   GET  /v4/validate/token
 *   GET  /v4/termsAndConditions          -> {legalGuid}; PUT /v4/acceptTermsAndConditions {legalGuid}
 *   POST /v4/store/nearest               {lat, lon, name, maxResults, maxDistance}
 *   POST /v6/searchMeta                  Mongo-ish query DSL, limit fixed at 25 by the app
 *   GET  /v7/shoppingLists[/{guid}[/details]]
 *   POST /v7/shoppingLists/{guid}/createLink   -> share link for a follower
 *   POST /v5/shoppingList/addOrUpdate/{storeGuid}   item upsert; amount 0 removes
 *
 * The account is anonymous and device-scoped: `secret` + `deviceId` are the password,
 * the bearer token is the session. Callers own persistence and encryption.
 */

export const DEFAULT_BASE_URL = 'https://api.es-prod.whiz-cart.com/mobile-backend/api';
export const DEFAULT_API_KEY = '4a8bbd6458444086b7f51ca8b5a89ca9';
/** The app's own UA format; the API is keyed per client and this is a known-good one. */
export const DEFAULT_USER_AGENT = 'Whiz-Cart/4.154.0; (android 37)';
/** Search page size is fixed in the app (`MAX_SEARCH_ITEMS`). */
export const SEARCH_LIMIT = 25;
/** Verified App Link host that turns a share link into an EASY Shopper deep link. */
export const SHARE_LINK_BASE = 'https://feature-app-links.easy-shopper-com.pages.dev/app';

export interface EasyShopperConfig {
  baseUrl: string;
  apiKey: string;
  userAgent: string;
  timeoutMs: number;
}

export interface EasyShopperCredentials {
  deviceId: string;
  secret: string;
}

export interface EasyShopperSession {
  token: string;
  userGuid: string;
  storeGuid: string;
}

export interface EasyShopperStore {
  guid: string;
  name?: string;
  [key: string]: unknown;
}

export interface SearchFilter {
  /** Search attribute flags such as `organic`, `regional`, `vegan`, `isFruitOrVeggie`. */
  attributes?: string[];
  /** Category group ids (`cgId`) coming from a previous response's `groups`. */
  categoryGroupIds?: string[];
}

export interface SearchBodyInput extends SearchFilter {
  queryText: string;
  storeGuid: string;
  userGuid?: string;
  skip?: number;
  limit?: number;
  fuzzy?: boolean;
}

export interface SearchProduct {
  [key: string]: unknown;
}

export interface SearchResponse {
  items: SearchProduct[];
  count: number;
  groups: unknown[];
  suggest?: { phrase?: { options?: string[] } };
}

export interface ShoppingListItemInput {
  /** Existing row id — required to update or delete. */
  shoppingListItemGuid?: string;
  amount: number;
  name: string;
  brand?: string | null;
  tag?: string;
  groupName?: string;
  cgIcon?: string;
  cgLocalKey?: string;
  unit?: string;
  /** Full product object from search, when adding a catalogue product. */
  product?: Record<string, unknown>;
}

export class EasyShopperError extends Error {
  readonly status: number;
  constructor(message: string, status: number) {
    super(message);
    this.name = 'EasyShopperError';
    this.status = status;
  }
}

type FetchLike = (input: string, init?: RequestInit) => Promise<Response>;

export function resolveConfig(overrides: Partial<EasyShopperConfig> = {}): EasyShopperConfig {
  return {
    baseUrl: overrides.baseUrl ?? process.env.EASYSHOPPER_API_URL ?? DEFAULT_BASE_URL,
    apiKey: overrides.apiKey ?? process.env.EASYSHOPPER_API_KEY ?? DEFAULT_API_KEY,
    userAgent: overrides.userAgent ?? DEFAULT_USER_AGENT,
    timeoutMs: overrides.timeoutMs ?? 10_000,
  };
}

/** Basic auth for the login handshake: `secret:deviceId`, base64 encoded. */
export function basicAuth(credentials: EasyShopperCredentials): string {
  return `Basic ${Buffer.from(`${credentials.secret}:${credentials.deviceId}`, 'utf8').toString('base64')}`;
}

/**
 * Build the `/v6/searchMeta` body. The server accepts a Mongo-style query: numeric
 * tokens become GTIN lookups, other tokens become text terms, attributes become
 * flag clauses and category selections become `cgId` clauses.
 */
export function buildSearchBody(input: SearchBodyInput): Record<string, unknown> {
  const tokens = input.queryText
    .trim()
    .split(/\s+/)
    .filter(Boolean);
  const gtinTokens = tokens.filter((token) => /^\d{6,}$/.test(token));
  const textTokens = tokens.filter((token) => !/^\d{6,}$/.test(token));

  const and: Array<Record<string, unknown>> = [];
  if (gtinTokens.length > 0) and.push({ $or: gtinTokens.map((gtin) => ({ gtin })) });
  for (const text of textTokens) and.push({ text });
  for (const flag of input.attributes ?? []) and.push({ flag });

  const query: Record<string, unknown> = {
    storeGuid: input.storeGuid,
    flag: null,
    $and: and,
  };
  const categoryGroupIds = input.categoryGroupIds ?? [];
  if (categoryGroupIds.length > 0) query.$or = categoryGroupIds.map((cgId) => ({ cgId }));

  return {
    query,
    queryText: input.queryText,
    skip: input.skip ?? 0,
    limit: input.limit ?? SEARCH_LIMIT,
    ...(input.userGuid ? { userGuid: input.userGuid } : {}),
    includeGroups: true,
    fuzzy: input.fuzzy ?? false,
  };
}

export class EasyShopperClient {
  private readonly config: EasyShopperConfig;
  private readonly fetchImpl: FetchLike;

  constructor(config: Partial<EasyShopperConfig> = {}, fetchImpl?: FetchLike) {
    this.config = resolveConfig(config);
    this.fetchImpl = fetchImpl ?? ((input, init) => fetch(input, init));
  }

  private headers(authorization?: string): Record<string, string> {
    return {
      Accept: 'application/json',
      'Content-Type': 'application/json',
      'Accept-Language': 'de-DE,de;q=0.9',
      'X-Subscription-Key': this.config.apiKey,
      'User-Agent': this.config.userAgent,
      ...(authorization ? { Authorization: authorization } : {}),
    };
  }

  private async request<T>(
    method: 'GET' | 'POST' | 'PUT' | 'DELETE',
    path: string,
    options: { body?: unknown; authorization?: string } = {}
  ): Promise<T> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.config.timeoutMs);
    try {
      const response = await this.fetchImpl(`${this.config.baseUrl}${path}`, {
        method,
        headers: this.headers(options.authorization),
        body: options.body === undefined ? undefined : JSON.stringify(options.body),
        signal: controller.signal,
      });
      const text = await response.text();
      if (!response.ok) {
        throw new EasyShopperError(
          `EASY Shopper ${method} ${path} failed: ${response.status} ${text.slice(0, 300)}`,
          response.status
        );
      }
      if (!text) return {} as T;
      try {
        return JSON.parse(text) as T;
      } catch {
        // createLink answers with a bare URL, not JSON. Keep the text and let the
        // caller decide what it means rather than failing the whole request.
        return text as unknown as T;
      }
    } finally {
      clearTimeout(timer);
    }
  }

  /** Anonymous device onboarding step 1. */
  async signup(storeGuid: string): Promise<EasyShopperCredentials> {
    const body = await this.request<{ secret?: string; deviceId?: string }>('POST', '/v4/signup', {
      body: { storeGuid },
    });
    if (!body.secret || !body.deviceId) {
      throw new EasyShopperError('EASY Shopper signup returned no secret/deviceId', 500);
    }
    return { secret: body.secret, deviceId: body.deviceId };
  }

  /** Anonymous device onboarding step 2 — trades the device pair for a bearer token. */
  async login(credentials: EasyShopperCredentials, uniqueDeviceId: string): Promise<EasyShopperSession> {
    const body = await this.request<{
      authenticationToken?: string;
      userGuid?: string;
      storeGuid?: string;
    }>('POST', '/v4/login', {
      body: { uniqueDeviceId },
      authorization: basicAuth(credentials),
    });
    if (!body.authenticationToken) {
      throw new EasyShopperError('EASY Shopper login returned no authenticationToken', 500);
    }
    return {
      token: body.authenticationToken,
      userGuid: body.userGuid ?? '',
      storeGuid: body.storeGuid ?? '',
    };
  }

  async validateToken(token: string): Promise<boolean> {
    try {
      await this.request('GET', '/v4/validate/token', { authorization: `Bearer ${token}` });
      return true;
    } catch (error) {
      if (error instanceof EasyShopperError && error.status === 401) return false;
      throw error;
    }
  }

  /** T&C and privacy acceptance; the app does this on first run before writing. */
  async acceptLegal(token: string): Promise<void> {
    const authorization = `Bearer ${token}`;
    const terms = await this.request<{ legalGuid?: string }>('GET', '/v4/termsAndConditions', { authorization });
    if (terms.legalGuid) {
      await this.request('PUT', '/v4/acceptTermsAndConditions', {
        body: { legalGuid: terms.legalGuid },
        authorization,
      });
    }
    const privacy = await this.request<{ legalGuid?: string }>('GET', '/v4/dataPrivacy', { authorization });
    if (privacy.legalGuid) {
      await this.request('PUT', '/v4/acceptDataPrivacy', { body: { legalGuid: privacy.legalGuid }, authorization });
    }
  }

  async nearestStores(
    token: string,
    location: { lat: number; lon: number; name?: string; maxResults?: number; maxDistance?: number }
  ): Promise<EasyShopperStore[]> {
    const body = await this.request<unknown>('POST', '/v4/store/nearest', {
      body: {
        lat: location.lat,
        lon: location.lon,
        name: location.name ?? '',
        maxResults: location.maxResults ?? 10,
        maxDistance: location.maxDistance ?? 5,
      },
      authorization: `Bearer ${token}`,
    });
    return Array.isArray(body) ? (body as EasyShopperStore[]) : [];
  }

  async searchProducts(token: string, input: SearchBodyInput): Promise<SearchResponse> {
    const body = await this.request<Partial<SearchResponse>>('POST', '/v6/searchMeta', {
      body: buildSearchBody(input),
      authorization: `Bearer ${token}`,
    });
    return {
      items: Array.isArray(body.items) ? body.items : [],
      count: typeof body.count === 'number' ? body.count : 0,
      groups: Array.isArray(body.groups) ? body.groups : [],
      suggest: body.suggest,
    };
  }

  async listShoppingLists(token: string): Promise<Record<string, unknown>[]> {
    const body = await this.request<unknown>('GET', '/v7/shoppingLists', { authorization: `Bearer ${token}` });
    if (Array.isArray(body)) return body as Record<string, unknown>[];
    const wrapped = body as { shoppingLists?: Record<string, unknown>[] };
    return Array.isArray(wrapped.shoppingLists) ? wrapped.shoppingLists : [];
  }

  async getShoppingList(token: string, listGuid: string): Promise<unknown> {
    return this.request('GET', `/v7/shoppingLists/${encodeURIComponent(listGuid)}`, {
      authorization: `Bearer ${token}`,
    });
  }

  async getShoppingListDetails(token: string, listGuid: string): Promise<Record<string, unknown>> {
    return this.request<Record<string, unknown>>(
      'GET',
      `/v7/shoppingLists/${encodeURIComponent(listGuid)}/details`,
      { authorization: `Bearer ${token}` }
    );
  }

  /**
   * Upsert one row. Deletion is the same call with `amount: 0` — the app branches on
   * `amount > 0` to keep an item and treats anything else as a removal.
   */
  async upsertItem(
    token: string,
    storeGuid: string,
    item: ShoppingListItemInput
  ): Promise<unknown> {
    const payload: Record<string, unknown> = {
      amount: item.amount,
      tag: item.tag ?? item.name,
      groupName: item.groupName ?? 'diverse_nonfood',
      cgIcon: item.cgIcon ?? 'diverse_nonfood',
      cgLocalKey: item.cgLocalKey ?? 'diverse_nonfood',
      product: item.product ?? {
        name: item.name,
        brand: item.brand ?? null,
        cgIcon: item.cgIcon ?? 'diverse_nonfood',
        cgLocalKey: item.cgLocalKey ?? 'diverse_nonfood',
      },
    };
    if (item.shoppingListItemGuid) payload.shoppingListItemGuid = item.shoppingListItemGuid;
    if (item.unit) payload.unit = item.unit;
    return this.request('POST', `/v5/shoppingList/addOrUpdate/${encodeURIComponent(storeGuid)}`, {
      body: payload,
      authorization: `Bearer ${token}`,
    });
  }

  async removeItem(token: string, storeGuid: string, shoppingListItemGuid: string): Promise<unknown> {
    return this.upsertItem(token, storeGuid, {
      shoppingListItemGuid,
      amount: 0,
      name: '',
    });
  }

  /**
   * Mint a share link — the only supported way to hand a list to another account.
   *
   * Verified live: the endpoint answers `text/plain` with the full invite URL
   *
   *   https://feature-app-links.easy-shopper-com.pages.dev/app/<env>/shopping-list-invite
   *     ?shoppingListGuid=<guid>&token=<uuid>
   *
   * and the list then carries the same `linkToken` for 24 h. That host is the app's
   * verified App Link, so opening the URL (or scanning its QR) starts EASY Shopper.
   */
  async createShareLink(token: string, listGuid: string): Promise<string | null> {
    const body = await this.request<{ shareLink?: string; linkToken?: string } | string>(
      'POST',
      `/v7/shoppingLists/${encodeURIComponent(listGuid)}/createLink`,
      { authorization: `Bearer ${token}` }
    );
    if (typeof body === 'string') {
      const text = body.trim();
      if (/^https?:\/\//i.test(text)) return text;
      return this.buildInviteUrl(listGuid, text);
    }
    if (body.shareLink) return body.shareLink;
    if (body.linkToken) return this.buildInviteUrl(listGuid, body.linkToken);
    return null;
  }

  /** Rebuild the invite URL from a token, for lists that already carry one. */
  buildInviteUrl(listGuid: string, token: string): string {
    const environment = this.config.baseUrl.includes('es-prod') ? 'es-prod' : 'es-test';
    const params = new URLSearchParams({ shoppingListGuid: listGuid, token });
    return `${SHARE_LINK_BASE}/${environment}/shopping-list-invite?${params.toString()}`;
  }
}

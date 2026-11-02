import { Agent, fetch as undiciFetch } from 'undici';

/**
 * Minimal opencode client: one prompt in, one JSON object out.
 *
 * The bot never gives opencode tools or database access. The backend computes
 * everything from MongoDB and hands opencode only text (intent classification,
 * occasion naming, reply wording). Replies are polled because opencode's
 * session API acknowledges a prompt before the model has answered.
 *
 * Contract (opencode 2.1.2, V2 API), same as dontforget's client:
 *   POST   /api/session               -> {"data": {"id": "ses_..."}}
 *   POST   /api/session/:id/prompt    -> {"text": "..."} in, ack out (not the reply)
 *   GET    /api/session/:id/message   -> {"data": [...]}, newest first;
 *                                        ?limit=N&order=desc pages it
 *   POST   /api/session/:id/interrupt -> stops the run (V2 has no /abort)
 *   DELETE /api/session/:id           -> drops the session
 * V2 appends idle/system/synthetic/user entries after an assistant turn, so
 * the newest entry is not reliably the reply: scan for the newest assistant
 * entry. A step ending in `tool-calls` is not terminal.
 */

const POLL_INTERVAL_MS = 1000;
const POLL_TIMEOUT_MS = 120_000;
const MAX_ATTEMPTS = 3;
const RETRY_DELAY_MS = 1000;

export interface ModelRef {
  id: string;
  providerID: string;
}

export interface RegistryModel extends ModelRef {
  status?: string;
  enabled?: boolean;
  cost?: Array<{ input?: number; output?: number }>;
}

// GET /api/model is the truth for which models are servable. A pinned model
// that the registry has deprecated is admitted at /prompt and then fails with
// "Model unavailable" (how mimo-v2.5-free died), so never trust a hard-coded
// name without checking it against the registry first.
//
// Preference among discovered free models, best first. Other active cost-0
// `opencode` models follow in registry order. Used as-is only when discovery
// itself is down.
const FREE_PREFERENCE = [
  'mimo-v2.6-flash-free',
  'big-pickle',
  'nemotron-3.5-lightning-free',
  'nemotron-3-ultra-free',
  'ling-3.1-flash-free',
];
const MODELS_TTL_MS = 10 * 60 * 1000;
// A failed discovery suppresses re-probing briefly and never replaces a good list.
const MODELS_FAILURE_TTL_MS = 30 * 1000;
// A model that answered with a quota/rate-limit error is skipped this long.
const EXHAUSTED_COOLDOWN_MS = 15 * 60 * 1000;
const QUOTA_ERROR = /\b429\b|FreeUsageLimitError|rate limit|quota/i;

let lastGoodModels: RegistryModel[] | null = null;
let lastGoodAtMs = 0;
let lastFailureAtMs = 0;
const exhaustedUntil = new Map<string, number>();

export function resetModelCacheForTests(): void {
  lastGoodModels = null;
  lastGoodAtMs = 0;
  lastFailureAtMs = 0;
  exhaustedUntil.clear();
}

const modelKey = (model: ModelRef) => `${model.providerID}:${model.id}`;

function parseModelKey(value: string): ModelRef | null {
  const [providerID, ...rest] = value.trim().split(':');
  const id = rest.join(':');
  return providerID && id ? { providerID, id } : null;
}

/** A registry entry is servable unless deprecated or disabled. */
export function isUsable(model: RegistryModel): boolean {
  return (model.status === undefined || model.status === 'active') && model.enabled !== false;
}

/** Cost-0 entries are the free tier. */
export function isFree(model: RegistryModel): boolean {
  return Array.isArray(model.cost) && model.cost.length > 0 && model.cost.every((c) => !c.input && !c.output);
}

interface OpencodeMessage {
  type: 'user' | 'assistant' | 'idle' | 'system' | 'synthetic';
  finish?: string;
  outcome?: string;
  content?: Array<{ type: string; text?: string }>;
  error?: { message: string };
}

export interface RunPromptOptions {
  models?: ModelRef[];
  timeoutMs?: number;
}

export interface OpencodeConfig {
  baseUrl: string;
  apiKey: string;
  allowInsecureTls: boolean;
}

export function getOpencodeConfig(): OpencodeConfig | null {
  const baseUrl = process.env.OPENCODE_BASE_URL?.replace(/\/+$/, '');
  const apiKey = process.env.OPENCODE_API_KEY;
  if (!baseUrl || !apiKey) return null;
  return {
    baseUrl,
    apiKey,
    allowInsecureTls: process.env.OPENCODE_ALLOW_INSECURE_TLS === 'true',
  };
}

export function isOpencodeConfigured(): boolean {
  return getOpencodeConfig() !== null;
}

// servyy-test's opencode is only reachable at an internal `.lxd` hostname with
// a self-signed certificate. Production has a real cert and must never skip
// verification; this is opt-in per deployment.
function dispatcherFor(config: OpencodeConfig) {
  return config.allowInsecureTls
    ? new Agent({ connect: { rejectUnauthorized: false } })
    : undefined;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function createSession(config: OpencodeConfig, model: ModelRef): Promise<string> {
  const response = await undiciFetch(`${config.baseUrl}/api/session`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-Api-Key': config.apiKey },
    body: JSON.stringify({ model }),
    dispatcher: dispatcherFor(config),
  });
  if (!response.ok) {
    throw new Error(`opencode session create failed: ${response.status}`);
  }
  const data = (await response.json()) as { data: { id: string } };
  return data.data.id;
}

async function sendPrompt(config: OpencodeConfig, sessionId: string, text: string): Promise<void> {
  const response = await undiciFetch(`${config.baseUrl}/api/session/${sessionId}/prompt`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-Api-Key': config.apiKey },
    body: JSON.stringify({ text }),
    dispatcher: dispatcherFor(config),
  });
  if (!response.ok) {
    throw new Error(`opencode prompt failed: ${response.status}`);
  }
}

async function pollForReply(
  config: OpencodeConfig,
  sessionId: string,
  timeoutMs: number
): Promise<string> {
  const deadline = Date.now() + timeoutMs;

  while (Date.now() < deadline) {
    const response = await undiciFetch(
      `${config.baseUrl}/api/session/${sessionId}/message?limit=50&order=desc`,
      {
        headers: { 'X-Api-Key': config.apiKey },
        dispatcher: dispatcherFor(config),
      }
    );
    if (!response.ok) {
      throw new Error(`opencode message poll failed: ${response.status}`);
    }
    const data = (await response.json()) as { data: OpencodeMessage[] };
    const latest = data.data.find((message) => message.type === 'assistant');

    if (latest?.finish && latest.finish !== 'tool-calls') {
      if (latest.finish === 'error') {
        throw new Error(`opencode generation failed: ${latest.error?.message ?? 'unknown error'}`);
      }
      const textPart = latest.content?.find((part) => part.type === 'text' && part.text);
      if (!textPart?.text) {
        throw new Error('opencode reply had no text content');
      }
      return textPart.text;
    }

    await sleep(POLL_INTERVAL_MS);
  }

  throw new Error('opencode reply timed out');
}

async function discoverModels(config: OpencodeConfig): Promise<RegistryModel[] | null> {
  try {
    const response = await undiciFetch(`${config.baseUrl}/api/model`, {
      headers: { 'X-Api-Key': config.apiKey },
      dispatcher: dispatcherFor(config),
    });
    if (!response.ok) return null;
    const json = (await response.json()) as unknown;
    const body = json as { data?: unknown; models?: unknown };
    const list = Array.isArray(json) ? json : Array.isArray(body?.data) ? body.data : Array.isArray(body?.models) ? body.models : null;
    // Right after opencode idles the registry can answer 200 with no models.
    if (!list || list.length === 0) return null;
    return (list as Array<Record<string, unknown>>)
      .filter((m) => m?.id && m?.providerID)
      .map((m) => ({
        id: String(m.id),
        providerID: String(m.providerID),
        status: typeof m.status === 'string' ? m.status : undefined,
        enabled: typeof m.enabled === 'boolean' ? m.enabled : undefined,
        cost: Array.isArray(m.cost) ? (m.cost as RegistryModel['cost']) : undefined,
      }));
  } catch {
    return null;
  }
}

/** The server registry, cached; null when discovery is unavailable. Never throws. */
async function getRegistry(config: OpencodeConfig): Promise<RegistryModel[] | null> {
  const now = Date.now();
  if (lastGoodModels && now - lastGoodAtMs < MODELS_TTL_MS) return lastGoodModels;
  if (lastFailureAtMs && now - lastFailureAtMs < MODELS_FAILURE_TTL_MS) return lastGoodModels;
  const discovered = await discoverModels(config);
  if (discovered) {
    lastGoodModels = discovered;
    lastGoodAtMs = now;
    return discovered;
  }
  lastFailureAtMs = now;
  console.warn(
    `[opencode] model discovery failed, using ${lastGoodModels ? 'the last good list' : 'the pinned preference list'}`
  );
  return lastGoodModels;
}

const preferenceRank = (id: string) => {
  const index = FREE_PREFERENCE.indexOf(id);
  return index === -1 ? FREE_PREFERENCE.length : index;
};

/**
 * Free models to try, best first: OPENCODE_MODELS ("provider:id,...") if set,
 * else the registry's active cost-0 `opencode` models, else (discovery down)
 * the pinned preference list. Models the registry cannot serve are dropped;
 * quota-exhausted models are skipped while their cooldown lasts.
 */
export async function getModelChain(): Promise<ModelRef[]> {
  const config = getOpencodeConfig();
  if (!config) throw new Error('opencode is not configured (OPENCODE_BASE_URL / OPENCODE_API_KEY)');

  const registry = await getRegistry(config);
  const usable = registry ? new Set(registry.filter(isUsable).map(modelKey)) : null;
  const servable = (m: ModelRef) => !usable || usable.has(modelKey(m));

  const override = (process.env.OPENCODE_MODELS ?? '')
    .split(',')
    .map(parseModelKey)
    .filter((m): m is ModelRef => m !== null);

  let chain: ModelRef[];
  if (override.length > 0) {
    chain = override.filter(servable);
  } else if (registry) {
    chain = registry
      .filter((m) => m.providerID === 'opencode' && isUsable(m) && isFree(m))
      .map((m, order) => ({ m, order }))
      .sort((a, b) => preferenceRank(a.m.id) - preferenceRank(b.m.id) || a.order - b.order)
      .map(({ m }) => ({ id: m.id, providerID: m.providerID }));
  } else {
    chain = FREE_PREFERENCE.map((id) => ({ id, providerID: 'opencode' }));
  }

  const now = Date.now();
  const available = chain.filter((m) => (exhaustedUntil.get(modelKey(m)) ?? 0) <= now);
  // Everything cooling down: try the full chain rather than fail without asking.
  return available.length > 0 ? available : chain;
}

/**
 * A failed attempt leaves its session running server-side, burning model quota
 * on a reply we gave up on. Best effort: cleanup never throws over the real
 * error that sent us here.
 */
async function discardSession(config: OpencodeConfig, sessionId: string): Promise<void> {
  const base = `${config.baseUrl}/api/session/${sessionId}`;
  const headers = { 'X-Api-Key': config.apiKey };
  try {
    await undiciFetch(`${base}/interrupt`, { method: 'POST', headers, dispatcher: dispatcherFor(config) });
  } catch {
    // best effort
  }
  try {
    await undiciFetch(base, { method: 'DELETE', headers, dispatcher: dispatcherFor(config) });
  } catch {
    // best effort
  }
}

/**
 * Run one prompt and parse the first JSON object in the reply. Retries on the
 * same model with exponential backoff, then fails over to the next model tier.
 */
export async function runPrompt<T = unknown>(prompt: string, options: RunPromptOptions = {}): Promise<T> {
  const config = getOpencodeConfig();
  if (!config) {
    throw new Error('opencode is not configured (OPENCODE_BASE_URL / OPENCODE_API_KEY)');
  }

  const models = options.models ?? (await getModelChain());
  if (models.length === 0) {
    throw new Error('no free opencode model is available (GET /api/model lists none active at cost 0)');
  }
  const timeoutMs = options.timeoutMs ?? POLL_TIMEOUT_MS;
  let lastError: unknown;

  for (const model of models) {
    for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
      let sessionId: string | undefined;
      try {
        sessionId = await createSession(config, model);
        await sendPrompt(config, sessionId, prompt);
        const replyText = await pollForReply(config, sessionId, timeoutMs);
        return JSON.parse(extractFirstJsonObject(replyText)) as T;
      } catch (error) {
        if (sessionId) {
          await discardSession(config, sessionId);
        }
        lastError = error;
        // Quota/rate limit: retrying the same model won't help for minutes.
        // Cool it down and move straight to the next model.
        if (QUOTA_ERROR.test(error instanceof Error ? error.message : String(error))) {
          exhaustedUntil.set(modelKey(model), Date.now() + EXHAUSTED_COOLDOWN_MS);
          break;
        }
        if (attempt < MAX_ATTEMPTS) {
          await sleep(RETRY_DELAY_MS * 2 ** (attempt - 1));
        }
      }
    }
  }

  throw lastError;
}

/**
 * Walk brace depth, string-aware, and stop at the first balanced object.
 * A greedy regex breaks when the model adds prose after valid JSON.
 */
export function extractFirstJsonObject(text: string): string {
  const start = text.indexOf('{');
  if (start === -1) {
    throw new Error('opencode reply did not contain JSON');
  }

  let depth = 0;
  let inString = false;
  let escapeNext = false;

  for (let index = start; index < text.length; index++) {
    const char = text[index];

    if (escapeNext) {
      escapeNext = false;
      continue;
    }
    if (char === '\\') {
      escapeNext = true;
      continue;
    }
    if (char === '"') {
      inString = !inString;
      continue;
    }
    if (inString) continue;

    if (char === '{') {
      depth++;
    } else if (char === '}') {
      depth--;
      if (depth === 0) {
        return text.slice(start, index + 1);
      }
    }
  }

  throw new Error('opencode reply contained an unterminated JSON object');
}

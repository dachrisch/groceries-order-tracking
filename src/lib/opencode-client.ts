import { Agent, fetch as undiciFetch } from 'undici';

/**
 * Minimal opencode client: one prompt in, one JSON object out.
 *
 * The bot never gives opencode tools or database access. The backend computes
 * everything from MongoDB and hands opencode text (intent classification,
 * occasion naming, reply wording) — plus, for a photographed paper list, one
 * inline image. Replies are polled because opencode's session API acknowledges
 * a prompt before the model has answered.
 *
 * Contract (opencode 2.1.2, V2 API), same as dontforget's client:
 *   POST   /api/session               -> {"data": {"id": "ses_..."}}
 *   POST   /api/session/:id/prompt    -> {"text": "...", "files": [...]} in, ack out (not the reply)
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
  /**
   * This model bills tokens: a registry entry that is not cost 0, a curated paid
   * fallback, or a pin for one. A paid model gets a single attempt and is logged
   * when it answers. Callers that pass `models` themselves own this tagging.
   */
  paid?: boolean;
}

export interface RegistryModel extends ModelRef {
  status?: string;
  enabled?: boolean;
  cost?: Array<{ input?: number; output?: number }>;
  /** Input modalities from `capabilities.input`: text, image, video, audio, pdf. */
  input?: string[];
}

// GET /api/model is the truth for which models are servable. A pinned model
// that the registry has deprecated is admitted at /prompt and then fails with
// "Model unavailable" (how mimo-v2.5-free died), so never trust a hard-coded
// name without checking it against the registry first.
//
// Both lists below are used as-is only when discovery itself is down; otherwise
// the registry decides which models exist and these supply the order.

/** Free text models, best first; other active cost-0 models follow in registry order. */
const FREE_PREFERENCE = [
  'mimo-v2.6-flash-free',
  'big-pickle',
  'nemotron-3.5-lightning-free',
  'nemotron-3-ultra-free',
  'ling-3.1-flash-free',
];

/** Free vision models, best first; used when discovery itself is down. */
const VISION_PREFERENCE = [
  'mimo-v2.6-flash-free',
  'inkling-2-small-free',
  'nemotron-3.5-super-vl-free',
  'longcat-2.5-free',
  'glm-5.3-flash-free',
  'deepseek-v4.1-flash-free',
  'minimax-m3.1-flash-free',
];

/**
 * Verified paid vision fallbacks, best first — used only when every free model failed.
 * Each was probed with a real photo through this exact endpoint; a registry `image`
 * capability is NOT proof the image arrives (gemini-2.5-flash-lite and
 * gemma-3-27b-it answered happily without ever seeing it). Keep the list short, and
 * re-probe before adding or reordering an entry.
 *
 * Worst case, by design: only a quota error sets a cooldown, so while the free tier
 * is out (provider errors, not 429s) every upload re-buys this whole list — one
 * attempt each, unbounded per day. A spend counter is deliberately out of scope.
 */
const PAID_VISION_PREFERENCE: ModelRef[] = [
  { id: 'gpt-6-luna', providerID: 'opencode-go', paid: true },
  { id: 'qwen/qwen3.7-flash', providerID: 'openrouter', paid: true },
  { id: 'qwen-vl-ocr', providerID: 'alibaba', paid: true },
];
const MODELS_TTL_MS = 10 * 60 * 1000;
// A failed discovery suppresses re-probing briefly and never replaces a good list.
const MODELS_FAILURE_TTL_MS = 30 * 1000;
// A model that answered with a quota/rate-limit error is skipped this long.
const EXHAUSTED_COOLDOWN_MS = 15 * 60 * 1000;
const QUOTA_ERROR = /\b429\b|FreeUsageLimitError|rate limit|quota/i;
// A hung generation on the same payload rarely recovers, so a timeout fails over to
// the next model instead of spending two more attempts on the one that hung.
const TIMEOUT_ERROR = /timed out/i;
/**
 * A reply that parsed but is not an answer: the model read this exact prompt and gave
 * nothing usable, and the same prompt on the same image cannot produce a different
 * answer. Kept distinct from a transport failure, which may well be transient. Exported
 * because a caller must map it to wording its own user can act on.
 */
export const NOT_AN_ANSWER = 'opencode reply was not an answer';

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

/** The registry says this model accepts image input. */
export function isVision(model: RegistryModel): boolean {
  return Array.isArray(model.input) && model.input.includes('image');
}

interface OpencodeMessage {
  type: 'user' | 'assistant' | 'idle' | 'system' | 'synthetic';
  finish?: string;
  outcome?: string;
  content?: Array<{ type: string; text?: string }>;
  error?: { message: string };
}

/**
 * A prompt attachment; an inline image needs a vision-capable model. `uri` is
 * posted verbatim: it must already be a downscaled, approved image, because this
 * layer validates neither size nor content type.
 */
export interface PromptFile {
  uri: string;
  name?: string;
  description?: string;
  source?: { type: 'inline' } | { type: 'uri'; uri: string };
}

export interface RunPromptOptions {
  /** Explicit chain, used as given — the caller owns its `paid` tagging. */
  models?: ModelRef[];
  /** Per attempt, not per call: the whole chain is models × attempts × this. */
  timeoutMs?: number;
  /**
   * Try at most this many models (at least one). It bounds wall clock and quota when a
   * caller is latency-sensitive — a user-facing request must not wait out the whole
   * free chain at one timeout per attempt.
   */
  maxModels?: number;
  /** Attachments posted with the prompt. */
  files?: PromptFile[];
  /** Only models whose registry capabilities include this input modality. */
  require?: 'image';
  /** Append the verified paid vision tier. Only photo intake sets this. */
  allowPaid?: boolean;
  /** Called with the model that answered, so a paid fallback is visible. */
  onModelUsed?: (model: ModelRef) => void;
  /**
   * Reject a parsed reply that is not an answer, so the next model is tried. A
   * rejected reply is a failed attempt: it is never reported through `onModelUsed`
   * and never logged as a paid fallback, because it did no useful work.
   */
  accept?: (raw: unknown) => boolean;
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

async function sendPrompt(
  config: OpencodeConfig,
  sessionId: string,
  text: string,
  files?: PromptFile[]
): Promise<void> {
  const response = await undiciFetch(`${config.baseUrl}/api/session/${sessionId}/prompt`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-Api-Key': config.apiKey },
    body: JSON.stringify(files && files.length > 0 ? { text, files } : { text }),
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
        input: Array.isArray((m.capabilities as { input?: unknown } | undefined)?.input)
          ? ((m.capabilities as { input: unknown[] }).input.filter((v) => typeof v === 'string') as string[])
          : undefined,
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

const preferenceRank = (id: string, preferences: string[]) => {
  const index = preferences.indexOf(id);
  return index === -1 ? preferences.length : index;
};

function preferenceChain(models: string[]): ModelRef[] {
  return models.map((id) => ({ id, providerID: 'opencode' }));
}

// Curated ids are known to bill tokens even when discovery is down.
const PAID_VISION_KEYS = new Set(PAID_VISION_PREFERENCE.map(modelKey));

export interface ModelChainOptions {
  require?: 'image';
  /** Append the verified paid vision tier after every free model. Default false. */
  allowPaid?: boolean;
}

/**
 * Models to try, best first: OPENCODE_MODELS ("provider:id,...") if set, else the
 * registry's active cost-0 `opencode` models, else (discovery down) the pinned
 * preference list. Models the registry cannot serve are dropped; quota-exhausted
 * models are skipped while their cooldown lasts.
 *
 * `require: 'image'` keeps text-only models out of the chain — including a pinned
 * OPENCODE_MODELS entry, because a text-only model cannot read a photo at all.
 * `allowPaid` appends the curated paid vision tier after every free model; only
 * photo intake asks for it, so every other call stays cost 0. Photo calls read
 * OPENCODE_VISION_MODELS instead of OPENCODE_MODELS.
 *
 * OPENCODE_VISION_PAID=off|false|0|no drops the curated tier only: an explicit pin
 * is still used, and still gets its single attempt, because a pin is a deliberate
 * operator choice. Remove the pin to stop buying that model.
 */
export async function getModelChain(options: ModelChainOptions = {}): Promise<ModelRef[]> {
  const config = getOpencodeConfig();
  if (!config) throw new Error('opencode is not configured (OPENCODE_BASE_URL / OPENCODE_API_KEY)');

  const needsVision = options.require === 'image';
  const registry = await getRegistry(config);
  const byKey = new Map((registry ?? []).map((model) => [modelKey(model), model]));
  const usable = registry ? new Set(registry.filter(isUsable).map(modelKey)) : null;
  const known = (m: ModelRef): RegistryModel | undefined => byKey.get(modelKey(m));
  // A model the registry knows must advertise `image`; with discovery down nothing
  // can be checked, so the pinned names are tried and a wrong guess fails one call.
  const visionOk = (m: ModelRef) => !needsVision || !registry || isVision(known(m) ?? m);
  const servable = (m: ModelRef) => (!usable || usable.has(modelKey(m))) && visionOk(m);
  // Free is the default; the paid tier is opt-in per call and can be killed by ops.
  // Accept the spellings an operator actually types, not just "off".
  const paidKillSwitch = /^(off|false|0|no)$/i.test((process.env.OPENCODE_VISION_PAID ?? '').trim());
  const paidEnabled = needsVision && options.allowPaid === true && !paidKillSwitch;

  // Vision has its own override so a pinned text model can never hijack a photo call.
  const override = (process.env[needsVision ? 'OPENCODE_VISION_MODELS' : 'OPENCODE_MODELS'] ?? '')
    .split(',')
    .map(parseModelKey)
    .filter((m): m is ModelRef => m !== null);

  // A pin carries its own billing marker; untagged, a paid pin would be retried
  // three times and logged as free. A pin is billed when it is a curated id, when the
  // registry prices it above zero, or when the registry cannot vouch for it at all:
  // only an explicit all-zero cost array proves a model is free, because a missing price
  // is not evidence of free — and that holds for the pin too.
  //
  // This is not vision-only. A pinned text model (OPENCODE_MODELS) that the registry
  // does not know is tagged the same way, so it gets one attempt instead of three and
  // logs `paid fallback used` when it answers. The alternative — trusting an unpriced
  // pin — is what turns a typo'd id into a retry storm on someone's bill.
  const billable = (m: ModelRef): ModelRef => {
    const entry = known(m);
    const paid = PAID_VISION_KEYS.has(modelKey(m)) || entry === undefined || !isFree(entry);
    return paid ? { ...m, paid: true } : m;
  };

  let chain: ModelRef[];
  if (override.length > 0) {
    chain = override.filter(servable).map(billable);
  } else if (registry) {
    const preferences = needsVision ? VISION_PREFERENCE : FREE_PREFERENCE;
    chain = registry
      .filter((m) => m.providerID === 'opencode' && isUsable(m) && isFree(m) && visionOk(m))
      .map((m, order) => ({ m, order }))
      .sort((a, b) => preferenceRank(a.m.id, preferences) - preferenceRank(b.m.id, preferences) || a.order - b.order)
      .map(({ m }) => ({ id: m.id, providerID: m.providerID }));
  } else {
    chain = preferenceChain(needsVision ? VISION_PREFERENCE : FREE_PREFERENCE);
  }

  const now = Date.now();
  const available = chain.filter((m) => (exhaustedUntil.get(modelKey(m)) ?? 0) <= now);
  // Everything cooling down: try the full chain rather than fail without asking.
  let result = available.length > 0 ? available : chain;

  if (paidEnabled) {
    // The curated tier never replaces the free one, it only follows it, and a model
    // the chain already names is not bought a second time. The registry is used to
    // skip a curated name that was deprecated or went free — never to widen the
    // list, because a registry `image` capability does not prove delivery.
    const curated = PAID_VISION_PREFERENCE.filter((m) => {
      if (!servable(m)) return false;
      if (!registry) return true;
      // Narrowed in one place: two separate `known(m)` calls do not share narrowing.
      const entry = known(m);
      return entry !== undefined && !isFree(entry);
    });
    if (curated.length === 0) {
      console.warn('[opencode] paid vision fallback was requested but no curated model is servable');
    }
    const seen = new Set(result.map(modelKey));
    result = [
      ...result,
      ...curated.filter(
        (m) => !seen.has(modelKey(m)) && (exhaustedUntil.get(modelKey(m)) ?? 0) <= now
      ),
    ];
  }

  if (needsVision && result.length === 0) {
    // Name the real blocker: a bad pin needs a different fix from a registry that
    // offers no vision model at all.
    const reason =
      override.length > 0
        ? `OPENCODE_VISION_MODELS pins ${override.map(modelKey).join(', ')}, which the registry cannot serve for images`
        : 'GET /api/model lists no active cost-0 model with image input';
    throw new Error(
      `no vision-capable opencode model is available (${reason}${
        paidEnabled ? '; the curated paid tier is unavailable too' : ''
      })`
    );
  }
  return result;
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
 * `maxModels` truncates the chain before the first attempt, for callers that cannot
 * spend the whole chain's wall clock.
 * A paid fallback model gets a single attempt. A reply that does not parse, or that
 * `accept` rejects, is a failed attempt: it is never reported as the answer. A timeout
 * is non-retryable for every caller — intent, occasions and the bot included — because
 * a call that hung on one payload rarely answers on a retry, so the chain moves on.
 */
export async function runPrompt<T = unknown>(prompt: string, options: RunPromptOptions = {}): Promise<T> {
  const config = getOpencodeConfig();
  if (!config) {
    throw new Error('opencode is not configured (OPENCODE_BASE_URL / OPENCODE_API_KEY)');
  }

  const resolved =
    options.models ??
    (await getModelChain({ require: options.require, allowPaid: options.allowPaid }));
  // A caller that bounded the chain gets a prefix of it, never an empty chain.
  const models =
    options.maxModels === undefined ? resolved : resolved.slice(0, Math.max(1, options.maxModels));
  if (models.length === 0) {
    throw new Error('no free opencode model is available (GET /api/model lists none active at cost 0)');
  }
  const timeoutMs = options.timeoutMs ?? POLL_TIMEOUT_MS;
  let lastError: unknown;

  for (const model of models) {
    // A paid fallback gets one attempt: a retry storm on the owner's bill is worse
    // than a failed read. Free models keep the normal three tries.
    const attempts = model.paid ? 1 : MAX_ATTEMPTS;
    for (let attempt = 1; attempt <= attempts; attempt++) {
      let sessionId: string | undefined;
      try {
        sessionId = await createSession(config, model);
        await sendPrompt(config, sessionId, prompt, options.files);
        const replyText = await pollForReply(config, sessionId, timeoutMs);
        // Only a parsed reply that is also an answer counts: prose that fails to
        // parse, or a well-formed non-answer such as {"lines":[]}, is a failed
        // attempt and must not be reported as the model that answered.
        const parsed = JSON.parse(extractFirstJsonObject(replyText)) as T;
        if (options.accept && !options.accept(parsed)) {
          // A paid read that failed is still worth seeing in the log; the success warn
          // stays below, and neither fires `onModelUsed` for a rejected model.
          if (model.paid) console.warn(`[opencode] paid attempt rejected: ${modelKey(model)}`);
          throw new Error(NOT_AN_ANSWER);
        }
        if (model.paid) console.warn(`[opencode] paid fallback used: ${modelKey(model)}`);
        options.onModelUsed?.(model);
        return parsed;
      } catch (error) {
        if (sessionId) {
          await discardSession(config, sessionId);
        }
        lastError = error;
        const message = error instanceof Error ? error.message : String(error);
        // Quota/rate limit: retrying the same model won't help for minutes.
        // Cool it down and move straight to the next model.
        if (QUOTA_ERROR.test(message)) {
          exhaustedUntil.set(modelKey(model), Date.now() + EXHAUSTED_COOLDOWN_MS);
          break;
        }
        // A timeout or a reply this caller will not accept is about this model on this
        // payload; retrying it cannot change the answer. Transport errors keep their
        // retries, because a 500 or a truncated reply can be transient.
        if (TIMEOUT_ERROR.test(message) || message === NOT_AN_ANSWER) {
          break;
        }
        if (attempt < attempts) {
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

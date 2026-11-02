import { Agent, fetch as undiciFetch } from 'undici';

/**
 * Minimal opencode client: one prompt in, one JSON object out.
 *
 * The bot never gives opencode tools or database access. The backend computes
 * everything from MongoDB and hands opencode only text (intent classification,
 * occasion naming, reply wording). Replies are polled because opencode's
 * session API acknowledges a prompt before the model has answered.
 */

const POLL_INTERVAL_MS = 1000;
const POLL_TIMEOUT_MS = 120_000;
const MAX_ATTEMPTS = 3;
const RETRY_DELAY_MS = 1000;

export interface ModelRef {
  id: string;
  providerID: string;
}

// Free models on OpenCode Zen, fastest first. The fallback is a different
// model, so a per-model rate limit or outage does not fail the whole call.
export const MODEL_TIERS: ModelRef[] = [
  { id: 'mimo-v2.5-free', providerID: 'opencode' },
  { id: 'big-pickle', providerID: 'opencode' },
];

interface OpencodeMessage {
  type: 'user' | 'assistant';
  finish?: string;
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
    body: JSON.stringify({ prompt: { text } }),
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
    const response = await undiciFetch(`${config.baseUrl}/api/session/${sessionId}/message`, {
      headers: { 'X-Api-Key': config.apiKey },
      dispatcher: dispatcherFor(config),
    });
    if (!response.ok) {
      throw new Error(`opencode message poll failed: ${response.status}`);
    }
    const data = (await response.json()) as { data: OpencodeMessage[] };
    const latest = data.data[0];

    if (latest?.type === 'assistant' && latest.finish) {
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

/**
 * Run one prompt and parse the first JSON object in the reply. Retries on the
 * same model with exponential backoff, then fails over to the next model tier.
 */
export async function runPrompt<T = unknown>(prompt: string, options: RunPromptOptions = {}): Promise<T> {
  const config = getOpencodeConfig();
  if (!config) {
    throw new Error('opencode is not configured (OPENCODE_BASE_URL / OPENCODE_API_KEY)');
  }

  const models = options.models ?? MODEL_TIERS;
  const timeoutMs = options.timeoutMs ?? POLL_TIMEOUT_MS;
  let lastError: unknown;

  for (const model of models) {
    for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
      try {
        const sessionId = await createSession(config, model);
        await sendPrompt(config, sessionId, prompt);
        const replyText = await pollForReply(config, sessionId, timeoutMs);
        return JSON.parse(extractFirstJsonObject(replyText)) as T;
      } catch (error) {
        lastError = error;
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

/**
 * Score the order-bot's message understanding against the chat-eval fixture.
 *
 *   npm run bot:eval              # full pipeline: regex fast path, LLM for the rest
 *   npm run bot:eval -- --llm-only  # every message through opencode
 *
 * Needs OPENCODE_BASE_URL and OPENCODE_API_KEY for the LLM path. Not part of CI.
 */
import { readFileSync } from 'node:fs';
import { comparePlan, parsePlan, parsePlanFast, parsePlanWithLlm, type ExpectedAction } from '../src/lib/bot/intent';
import { isOpencodeConfigured } from '../src/lib/opencode-client';

interface EvalCase {
  text: string;
  fast: boolean;
  expected: ExpectedAction[];
}

const fixture = JSON.parse(
  readFileSync(new URL('../src/lib/__tests__/fixtures/chat-eval.json', import.meta.url), 'utf8')
) as { now: string; cases: EvalCase[] };

const llmOnly = process.argv.includes('--llm-only');
const now = new Date(fixture.now);

if (!isOpencodeConfigured()) {
  console.warn('OPENCODE_BASE_URL / OPENCODE_API_KEY not set: only the fast path can be scored.\n');
}

let passed = 0;
for (const entry of fixture.cases) {
  const started = Date.now();
  const fast = llmOnly ? null : parsePlanFast(entry.text, now);
  const plan = fast ?? (llmOnly ? await parsePlanWithLlm(entry.text, { now }) : await parsePlan(entry.text, { now }));
  const { ok, problems } = comparePlan(plan, entry.expected);
  if (ok) passed++;
  const path = fast ? 'fast' : 'llm ';
  console.log(`${ok ? 'PASS' : 'FAIL'} [${path} ${String(Date.now() - started).padStart(6)}ms] ${entry.text}`);
  for (const problem of problems) console.log(`       ${problem}`);
}

const score = Math.round((passed / fixture.cases.length) * 100);
console.log(`\n${passed}/${fixture.cases.length} passed (${score}%)`);
process.exit(passed === fixture.cases.length ? 0 : 1);

import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../opencode-client', () => ({ runPrompt: vi.fn() }));

import { runPrompt } from '../opencode-client';
import {
  parseListLine,
  scoreCandidate,
  matchLines,
  toCandidate,
  type MatchCandidate,
} from '../easyshopper/match';
import { applyPicks, buildPlan, planShoppingList, rerankWithHistory, searchListCandidates } from '../easyshopper/list';
import type { EasyShopperClient, EasyShopperSession } from '../easyshopper/client';

const mockRunPrompt = vi.mocked(runPrompt);

const products: MatchCandidate[] = [
  { id: '1', name: 'Weihenstephan H-Milch 1,5% 1l', brand: 'Weihenstephan', price: 1.19 },
  { id: '2', name: 'Gut & Günstig Vollmilch 3,5% 1l', brand: 'Gut & Günstig', price: 0.99 },
  { id: '3', name: 'Frosch Waschmittel 22WL 1450g Sensitiv Aloe Vera Pulver', brand: 'Frosch', price: 5.45 },
  { id: '4', name: 'Kneipp Dusche 200ml Gute Laune', brand: 'Kneipp', price: 2.95 },
  { id: '5', name: 'Rama Butter 250g', brand: 'Rama', price: 2.29 },
];

describe('parseListLine', () => {
  it('reads a leading quantity', () => {
    expect(parseListLine('2x Milch')).toEqual({ text: 'Milch', quantity: 2 });
    expect(parseListLine('3 × Brötchen')).toEqual({ text: 'Brötchen', quantity: 3 });
  });

  it('defaults to one and collapses whitespace', () => {
    expect(parseListLine('  Milch  1,5  ')).toEqual({ text: 'Milch 1,5', quantity: 1 });
  });

  it('drops blank lines', () => {
    expect(parseListLine('   ')).toBeNull();
  });
});

describe('scoreCandidate', () => {
  it('scores a fragment against a verbose product name', () => {
    const { score } = scoreCandidate('Milch', products[0]);
    expect(score).toBeGreaterThan(0.5);
  });

  it('does not let a bare decimal dilute the score', () => {
    // A handwritten "Milch 1,5" has no unit; the number must not count as a missed word.
    expect(scoreCandidate('Milch 1,5', products[0]).score).toBeGreaterThan(0.6);
    expect(scoreCandidate('milch', products[0]).score).toBeGreaterThan(0.6);
  });

  it('penalises a conflicting pack size', () => {
    const matching = scoreCandidate('Waschmittel 1450g', products[2]).score;
    const conflicting = scoreCandidate('Waschmittel 500g', products[2]).score;
    expect(matching).toBeGreaterThan(conflicting);
  });
});

describe('matchLines', () => {
  it('matches a normalised line to a catalogue product', () => {
    const [result] = matchLines([{ text: 'waschmittel sensitiv', quantity: 1 }], products);
    expect(result.candidate?.id).toBe('3');
    expect(result.score).toBeGreaterThanOrEqual(0.55);
  });

  it('handles umlauts on both sides', () => {
    const [result] = matchLines([{ text: 'Gute Laune dusche' }], products);
    expect(result.candidate?.id).toBe('4');
  });

  it('leaves an unknown line unmatched with a reason', () => {
    const [result] = matchLines([{ text: 'Zahnpasta' }], products);
    expect(result.candidate).toBeNull();
    expect(result.reason).toContain('below threshold');
  });

  it('keeps alternatives ranked below the winner', () => {
    const [result] = matchLines([{ text: 'milch' }], products);
    expect(result.candidate).not.toBeNull();
    expect(result.alternatives.length).toBeGreaterThan(0);
    expect(result.alternatives[0].name).not.toBe(result.candidate?.name);
  });

  it('respects a custom threshold', () => {
    const line = { text: 'milch zahnpasta' }; // one of two words matches -> 0.5
    expect(matchLines([line], products)[0].candidate).toBeNull();
    expect(matchLines([line], products, { threshold: 0.4 })[0].candidate?.id).toBe('1');
  });
});

describe('toCandidate', () => {
  it('unwraps the app search envelope', () => {
    const candidate = toCandidate({
      product: { id: 'abc', name: 'Käse 200g', brand: 'Alpenhain', price: { amount: 2.49 } },
      amount: 1,
    });
    expect(candidate).toMatchObject({ id: 'abc', name: 'Käse 200g', brand: 'Alpenhain', price: 2.49 });
  });

  it('falls back to flat items', () => {
    expect(toCandidate({ name: 'Brot' })?.name).toBe('Brot');
  });

  it('rejects items without a name', () => {
    expect(toCandidate({ price: 1 })).toBeNull();
  });
});

const session = { token: 't', userGuid: 'u', storeGuid: 's' } as unknown as EasyShopperSession;

const client = {
  searchProducts: async (_token: string, input: { queryText: string }) => ({
    items: input.queryText.startsWith('Zahn')
      ? []
      : input.queryText.startsWith('Wasch')
        ? [
            { product: { id: 'w1', name: 'Frosch Waschmittel Sensitiv Pulver', brand: 'Frosch' } },
            { product: { id: 'w2', name: 'Weichspüler Sensitiv 1l', brand: 'Domol' } },
          ]
        : [{ product: { id: 'm1', name: 'Weihenstephan H-Milch 1,5% 1l', brand: 'Weihenstephan' } }],
    count: 2,
    groups: [],
  }),
} as unknown as EasyShopperClient;

describe('planShoppingList', () => {
  beforeEach(() => mockRunPrompt.mockReset());

  it("takes the model's pick", async () => {
    mockRunPrompt.mockResolvedValueOnce({ picks: [{ line: 0, index: 1 }, { line: 1, index: 0 }] });
    const plan = await planShoppingList(client, session, { lines: ['Waschmittel sensitiv', 'Milch 1,5'], storeGuid: 's' });
    expect(plan.lines[0].match.candidate?.id).toBe('w2');
    expect(plan.lines[0].chooser).toBe('model');
    expect(plan.lines[1].match.candidate?.id).toBe('m1');
    expect(plan.source).toBe('model');
    expect(plan.matched).toBe(2);
  });

  it('falls back to the rules score when opencode fails', async () => {
    mockRunPrompt.mockRejectedValueOnce(new Error('opencode reply timed out'));
    const plan = await planShoppingList(client, session, { lines: ['Milch 1,5'], storeGuid: 's' });
    expect(plan.lines[0].match.candidate?.id).toBe('m1');
    expect(plan.lines[0].chooser).toBe('rules');
    expect(plan.source).toBe('rules');
  });

  it('does not ask the model when the caller turned it off', async () => {
    const plan = await planShoppingList(client, session, { lines: ['Milch 1,5'], storeGuid: 's' }, { useModel: false });
    expect(mockRunPrompt).not.toHaveBeenCalled();
    expect(plan.lines[0].chooser).toBe('rules');
  });

  it('trusts the index, not the model’s own words', async () => {
    // The "why" names the product the rules scorer would have taken; only the
    // index into the list we sent may decide.
    mockRunPrompt.mockResolvedValueOnce({
      picks: [{ line: 0, index: 1, why: 'Frosch Waschmittel Sensitiv Pulver' }],
    });
    const plan = await planShoppingList(client, session, { lines: ['Waschmittel sensitiv'], storeGuid: 's' });
    expect(plan.lines[0].match.candidate?.id).toBe('w2');
    expect(plan.lines[0].match.reason).toContain('opencode pick');
  });

  it('keeps the rules result when the model answers with an index it was not given', async () => {
    mockRunPrompt.mockResolvedValueOnce({ picks: [{ line: 0, index: 9 }] });
    const plan = await planShoppingList(client, session, { lines: ['Milch 1,5'], storeGuid: 's' });
    expect(plan.lines[0].match.candidate?.id).toBe('m1');
    expect(plan.lines[0].chooser).toBe('rules');
  });

  it('never marks a line as a product without a real candidate', async () => {
    const entries = await searchListCandidates(client, session, { lines: ['Zahnpasta'], storeGuid: 's' });
    const plan = applyPicks(buildPlan(entries, 's'), entries, [0]);
    expect(plan.lines[0].action).toBe('text');
    expect(plan.lines[0].match.candidate).toBeNull();
    expect(plan.lines[0].chooser).toBe('rules');
    expect(plan.matched).toBe(0);
  });

  it('asks for a cheap text call, never the paid photo path', async () => {
    mockRunPrompt.mockResolvedValueOnce({ picks: [] });
    await planShoppingList(client, session, { lines: ['Milch 1,5'], storeGuid: 's' });
    expect(mockRunPrompt.mock.calls[0][1]).not.toHaveProperty('allowPaid');
    expect(mockRunPrompt.mock.calls[0][1]).not.toHaveProperty('require');
  });
});

describe('rerankWithHistory', () => {
  it('never lets history override a deliberate model pick', () => {
    const plan = { storeGuid: 's', matched: 1, unmatched: 0, source: 'model' as const, lines: [
      { line: { text: 'Milch 1,5', quantity: 1 }, chooser: 'model' as const, action: 'product' as const,
        match: { line: { text: 'Milch 1,5', quantity: 1 }, candidate: { id: 'm2', name: 'Fettarme H-Milch 1,5%' }, score: 0.4, reason: 'pick: powder', alternatives: [] } },
    ]};
    const reranked = rerankWithHistory(plan, [{ id: 'h1', name: 'Vollmilch 3,5%' }]);
    expect(reranked.lines[0].match.candidate?.id).toBe('m2');
  });

  it('still corrects a weak rules match', () => {
    const plan = { storeGuid: 's', matched: 1, unmatched: 0, source: 'rules' as const, lines: [
      { line: { text: 'Milch 1,5', quantity: 1 }, chooser: 'rules' as const, action: 'product' as const,
        match: { line: { text: 'Milch 1,5', quantity: 1 }, candidate: { id: 'm1', name: 'Weihenstephan H-Milch 1,5% 1l' }, score: 0.6, reason: '1/2 words', alternatives: [] } },
    ]};
    const reranked = rerankWithHistory(plan, [{ id: 'h1', name: 'Weihenstephan H-Milch 1,5% 1l' }]);
    expect(reranked.lines[0].chooser).toBe('rules');
    expect(reranked.lines[0].match.reason).toContain('bought before');
  });
});


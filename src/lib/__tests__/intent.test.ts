import { describe, it, expect } from 'vitest';
import fixture from './fixtures/chat-eval.json';
import { comparePlan, normalizeLlmPlan, parsePlanFast } from '../bot/intent';

const NOW = new Date(fixture.now);

describe('fast plan parser (chat-eval fixture)', () => {
  for (const entry of fixture.cases.filter((c) => c.fast)) {
    it(`parses "${entry.text}"`, () => {
      const plan = parsePlanFast(entry.text, NOW);
      expect(plan).not.toBeNull();
      expect(comparePlan(plan!, entry.expected)).toEqual({ ok: true, problems: [] });
    });
  }

  for (const entry of fixture.cases.filter((c) => !c.fast)) {
    it(`leaves "${entry.text}" to the LLM`, () => {
      expect(parsePlanFast(entry.text, NOW)).toBeNull();
    });
  }
});

describe('normalizeLlmPlan', () => {
  it('resolves the date phrases the LLM returns', () => {
    const plan = normalizeLlmPlan(
      {
        actions: [
          { type: 'occasion', occasion: 'Pizza', servings: 6, date: 'wednesday' },
          { type: 'weekly', until: 'end of the week' },
        ],
      },
      'x',
      NOW
    );
    expect(comparePlan(plan, fixture.cases[4].expected)).toEqual({ ok: true, problems: [] });
  });

  it('accepts the old single-intent shape', () => {
    const plan = normalizeLlmPlan({ type: 'occasion', occasion: 'pizza', servings: 4 }, 'x', NOW);
    expect(plan.actions).toEqual([{ type: 'occasion', occasion: 'pizza', servings: 4 }]);
  });

  it('drops invalid actions and keeps the valid ones', () => {
    const plan = normalizeLlmPlan(
      { actions: [{ type: 'occasion', occasion: '', servings: 6 }, { type: 'weekly' }, { type: 'launch rockets' }] },
      'x',
      NOW
    );
    expect(plan.actions).toEqual([{ type: 'weekly' }]);
  });

  it('ignores a date phrase it cannot resolve instead of failing', () => {
    const plan = normalizeLlmPlan({ actions: [{ type: 'weekly', until: 'whenever' }] }, 'x', NOW);
    expect(plan.actions).toEqual([{ type: 'weekly' }]);
  });

  it('returns unknown for garbage', () => {
    expect(normalizeLlmPlan('nope', 'hello', NOW).actions).toEqual([{ type: 'unknown', text: 'hello' }]);
    expect(normalizeLlmPlan({ actions: [] }, 'hello', NOW).actions).toEqual([{ type: 'unknown', text: 'hello' }]);
  });

  it('merges duplicate weekly actions, keeping the latest until', () => {
    const plan = normalizeLlmPlan(
      { actions: [{ type: 'weekly', until: 'friday' }, { type: 'weekly', until: 'sunday' }] },
      'x',
      NOW
    );
    expect(comparePlan(plan, [{ type: 'weekly', until: '2026-11-08' }]).ok).toBe(true);
  });
});

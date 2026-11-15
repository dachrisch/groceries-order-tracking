import { describe, it, expect } from 'vitest';
import {
  parseListLine,
  scoreCandidate,
  matchLines,
  toCandidate,
  type MatchCandidate,
} from '../easyshopper/match';

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

import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../opencode-client', () => ({ runPrompt: vi.fn() }));

import { runPrompt } from '../opencode-client';
import { buildMatchPrompt, chooseWithModel, readPicks } from '../easyshopper/choose';
import type { ListLine, MatchCandidate } from '../easyshopper/match';

const mockRunPrompt = vi.mocked(runPrompt);

const lines: ListLine[] = [
  { text: 'Waschmittel sensitiv', quantity: 1 },
  { text: 'Milch 1,5', quantity: 2 },
  { text: 'Klopapier', quantity: 1 },
];

const pools: MatchCandidate[][] = [
  [
    { id: 'p1', name: 'Frosch Waschmittel 22WL 1450g Sensitiv Aloe Vera Pulver', brand: 'Frosch' },
    { id: 'p2', name: 'Persil Waschmittel Sensitiv Gel 20WL', brand: 'Persil' },
  ],
  [
    { id: 'm1', name: 'Weihenstephan H-Milch 1,5% 1l', brand: 'Weihenstephan' },
    { id: 'm2', name: 'Bärenmarke Kondensmilch 7,5% 340g', brand: 'Bärenmarke' },
  ],
  [],
];

const entries = lines.map((line, i) => ({ line, candidates: pools[i] }));

describe('buildMatchPrompt', () => {
  it('offers candidates by position and no product ids', () => {
    const prompt = buildMatchPrompt(entries);
    expect(prompt).toContain('"index":0');
    expect(prompt).toContain('Frosch Waschmittel');
    expect(prompt).not.toContain('p1');
    expect(prompt).not.toContain('m1');
  });

  it('sends the line as the shopper wrote it and an empty list for a line without candidates', () => {
    const prompt = buildMatchPrompt(entries);
    // describeLine keeps the quantity, so the model can weigh "2x Milch 1,5".
    expect(prompt).toContain('"text":"2x Milch 1,5"');
    expect(prompt).toContain('"candidates":[]');
    // Nothing but position and display name: no ids, no brands, no raw payloads.
    expect(prompt).not.toContain('"brand"');
  });
});

describe('readPicks', () => {
  it("accepts a pick that points into that line's list", () => {
    expect(readPicks({ picks: [{ line: 0, index: 1 }, { line: 1, index: 0 }] }, entries)).toEqual([1, 0, null]);
  });

  it('discards an index outside the list we sent', () => {
    expect(readPicks({ picks: [{ line: 0, index: 7 }, { line: 2, index: 0 }] }, entries)).toEqual([null, null, null]);
  });

  it('discards unknown line numbers and garbage', () => {
    expect(readPicks({ picks: [{ line: 9, index: 0 }, { line: '0', index: 0 }, null] }, entries)).toEqual([null, null, null]);
    expect(readPicks(null, entries)).toEqual([null, null, null]);
  });

  it('takes the last answer for a repeated line', () => {
    expect(readPicks({ picks: [{ line: 0, index: 0 }, { line: 0, index: 1 }] }, entries)).toEqual([1, null, null]);
  });

  it('refuses any index when the line was given no candidates at all', () => {
    const empty = [{ line: lines[0], candidates: [] }];
    expect(readPicks({ picks: [{ line: 0, index: 0 }] }, empty)).toEqual([null]);
  });

  it('refuses a fractional, negative or boolean index', () => {
    expect(
      readPicks(
        {
          picks: [
            { line: 0, index: 0.5 },
            { line: 1, index: -1 },
            { line: 2, index: true },
          ],
        },
        entries
      )
    ).toEqual([null, null, null]);
  });
});

describe('chooseWithModel', () => {
  beforeEach(() => mockRunPrompt.mockReset());

  it('makes one cheap text call and never the paid photo path', async () => {
    mockRunPrompt.mockResolvedValueOnce({ picks: [{ line: 0, index: 1 }] });

    await expect(chooseWithModel(entries)).resolves.toEqual([1, null, null]);
    expect(mockRunPrompt).toHaveBeenCalledTimes(1);

    // The matcher is a text call: no image requirement and no paid fallback tier.
    const options = mockRunPrompt.mock.calls[0][1];
    expect(options).not.toHaveProperty('allowPaid');
    expect(options).not.toHaveProperty('require');
    expect(options).not.toHaveProperty('files');
  });

  it('does not call the model when no line has a candidate', async () => {
    const empty = [{ line: lines[2], candidates: [] }];
    await expect(chooseWithModel(empty)).resolves.toEqual([null]);
    expect(mockRunPrompt).not.toHaveBeenCalled();
  });

  it('forwards a caller-supplied timeout', async () => {
    mockRunPrompt.mockResolvedValueOnce({ picks: [] });
    await chooseWithModel(entries, { timeoutMs: 5_000 });
    expect(mockRunPrompt.mock.calls[0][1]).toMatchObject({ timeoutMs: 5_000 });
  });
});

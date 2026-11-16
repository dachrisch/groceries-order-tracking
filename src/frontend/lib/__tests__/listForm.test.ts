import { describe, it, expect } from 'vitest';

import {
  FULL_LIST_MESSAGE,
  MAX_LIST_LINE_LENGTH,
  MAX_LIST_LINES,
  listLinesFromText,
  listOverflows,
  listRefusalMessage,
  mergeExtractedLines,
} from '../listForm';

describe('listLinesFromText', () => {
  it('trims, drops blanks and keeps the shopper order', () => {
    expect(listLinesFromText('  Milch 1,5 \n\n Brot\n2x Waschmittel ')).toEqual([
      'Milch 1,5',
      'Brot',
      '2x Waschmittel',
    ]);
  });

  it('clamps a line to the schema length instead of sending an invalid body', () => {
    const [line] = listLinesFromText('W'.repeat(MAX_LIST_LINE_LENGTH + 50));
    expect(line).toHaveLength(MAX_LIST_LINE_LENGTH);
  });

  it('never sends more lines than the schema takes', () => {
    const text = Array.from({ length: MAX_LIST_LINES + 5 }, (_unused, i) => `Artikel ${i}`).join('\n');
    const lines = listLinesFromText(text);
    expect(lines).toHaveLength(MAX_LIST_LINES);
    expect(lines[0]).toBe('Artikel 0');
    expect(listOverflows(text)).toBe(true);
  });

  it('does not report a list at exactly the cap as overflowing', () => {
    const text = Array.from({ length: MAX_LIST_LINES }, (_unused, i) => `Artikel ${i}`).join('\n');
    expect(listOverflows(text)).toBe(false);
  });
});

describe('mergeExtractedLines', () => {
  it('adds the photo lines after the typed ones without duplicating either side', () => {
    expect(mergeExtractedLines('Brot\n Milch', [{ text: 'Milch', quantity: 1 }, { text: 'Butter', quantity: 2 }])).toEqual({
      text: 'Brot\nMilch\n2x Butter',
      truncated: false,
    });
  });

  it('stops at the cap a photo alone can already reach', () => {
    const typed = Array.from({ length: 58 }, (_unused, i) => `Getippt ${i}`).join('\n');
    const { text, truncated } = mergeExtractedLines(typed, [
      { text: 'Butter', quantity: 1 },
      { text: 'Eier', quantity: 1 },
      { text: 'Brot', quantity: 1 },
    ]);

    expect(truncated).toBe(true);
    const lines = text.split('\n');
    expect(lines).toHaveLength(MAX_LIST_LINES);
    // Deterministic: typed lines first, then the photo lines that still fit.
    expect(lines[57]).toBe('Getippt 57');
    expect(lines.slice(58)).toEqual(['Butter', 'Eier']);
  });

  it('truncates a list that was already over the cap and says so', () => {
    const typed = Array.from({ length: MAX_LIST_LINES + 2 }, (_unused, i) => `Getippt ${i}`).join('\n');
    const { text, truncated } = mergeExtractedLines(typed, []);

    expect(truncated).toBe(true);
    expect(text.split('\n')).toHaveLength(MAX_LIST_LINES);
  });

  it('names the cap when a line had to be dropped', () => {
    expect(FULL_LIST_MESSAGE).toContain('60 lines');
  });
});

describe('listRefusalMessage', () => {
  it('never shows raw zod detail for a 400', () => {
    const message = listRefusalMessage(400, 'lines: Too big: expected array to have <=60 items', 'planning failed');
    expect(message).not.toContain('Too big');
    expect(message).not.toContain('expected array');
    expect(message).toMatch(/keep to 60 lines/);
  });

  it("keeps the backend's own sentence for the statuses a shopper can act on", () => {
    expect(listRefusalMessage(429, 'a photo is already being read — wait for it to finish', 'planning failed')).toBe(
      'a photo is already being read — wait for it to finish'
    );
    expect(listRefusalMessage(502, undefined, 'planning failed')).toBe('planning failed');
  });
});

import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../opencode-client', () => ({
  runPrompt: vi.fn(),
  isOpencodeConfigured: () => true,
}));

import { runPrompt } from '../opencode-client';
import { extractListLines, normalizeExtractedLines } from '../easyshopper/extract';

const mockRunPrompt = vi.mocked(runPrompt);

beforeEach(() => mockRunPrompt.mockReset());

describe('normalizeExtractedLines', () => {
  it('keeps clean lines and the quantity', () => {
    expect(
      normalizeExtractedLines({ lines: [{ text: '2x Milch 1,5', quantity: 2 }, { text: 'Brot' }] })
    ).toEqual([
      { text: 'Milch 1,5', quantity: 2 },
      { text: 'Brot', quantity: 1 },
    ]);
  });

  it('keeps a quantity the model left inside the text', () => {
    // qwen-vl-ocr answers "2x Milch 1,5" with quantity 1; the "2x" must win.
    expect(normalizeExtractedLines({ lines: [{ text: '2x Milch 1,5', quantity: 1 }] })).toEqual([
      { text: 'Milch 1,5', quantity: 2 },
    ]);
  });

  it('drops junk, empties and non-list noise', () => {
    const lines = normalizeExtractedLines({
      lines: ['', '   ', '---', '12', '[]', { text: 'x'.repeat(200) }, { text: 'Eier', quantity: 4 }],
    });
    expect(lines).toEqual([{ text: 'Eier', quantity: 4 }]);
  });

  it('keeps a line whose quantity reads as zero: a missing item is not correctable', () => {
    // An extra line is visible in the editable textarea and one keystroke to delete;
    // a dropped line is invisible and costs the shopper a trip to the shop.
    expect(normalizeExtractedLines({ lines: [{ text: 'Butter', quantity: 0 }] })).toEqual([
      { text: 'Butter', quantity: 1 },
    ]);
  });

  it('survives a reply that is not the shape we asked for', () => {
    expect(normalizeExtractedLines(null)).toEqual([]);
    expect(normalizeExtractedLines({ lines: 'Milch' })).toEqual([]);
  });

  it('caps how many lines one reply can inject', () => {
    const entries = Array.from({ length: 100 }, (_, index) => ({ text: `Artikel ${index}`, quantity: 1 }));
    expect(normalizeExtractedLines({ lines: entries })).toHaveLength(60);
  });

  it('treats a nonsense quantity as one instead of dropping the line', () => {
    expect(normalizeExtractedLines({ lines: [{ text: 'Milch', quantity: 999 }, { text: 'Brot', quantity: '2' }] })).toEqual([
      { text: 'Milch', quantity: 1 },
      { text: 'Brot', quantity: 1 },
    ]);
  });

  it('collapses the whitespace a photo transcription leaves behind', () => {
    expect(normalizeExtractedLines({ lines: [{ text: '  Waschmittel   sensitiv ' }] })).toEqual([
      { text: 'Waschmittel sensitiv', quantity: 1 },
    ]);
  });
});

describe('extractListLines', () => {
  it('sends the photo inline, allows the paid fallback and returns the lines', async () => {
    mockRunPrompt.mockImplementationOnce(async (_prompt, options) => {
      options?.onModelUsed?.({ id: 'mimo-v2.6-flash-free', providerID: 'opencode' });
      return { lines: [{ text: 'Milch 1,5', quantity: 2 }, { text: 'Brot' }] };
    });

    const result = await extractListLines('data:image/jpeg;base64,AAAA');

    expect(result.lines).toEqual([
      { text: 'Milch 1,5', quantity: 2 },
      { text: 'Brot', quantity: 1 },
    ]);
    expect(result.model).toBe('opencode:mimo-v2.6-flash-free');
    const [prompt, options] = mockRunPrompt.mock.calls[0];
    expect(prompt).toContain('shopping list');
    expect(options?.require).toBe('image');
    expect(options?.allowPaid).toBe(true);
    expect(options?.files?.[0]).toMatchObject({ source: { type: 'inline' }, uri: 'data:image/jpeg;base64,AAAA' });
  });

  it('wraps bare base64 in a data URI', async () => {
    mockRunPrompt.mockResolvedValueOnce({ lines: [{ text: 'Brot', quantity: 1 }] });

    await extractListLines('AAAA');

    expect(mockRunPrompt.mock.calls[0][1]?.files?.[0]).toMatchObject({ uri: 'data:image/jpeg;base64,AAAA' });
  });

  it('asks exactly once per photo', async () => {
    mockRunPrompt.mockResolvedValueOnce({ lines: [{ text: 'Brot', quantity: 1 }] });

    await extractListLines('data:image/jpeg;base64,AAAA');

    expect(mockRunPrompt).toHaveBeenCalledTimes(1);
  });

  it('omits the model when the client never reports one', async () => {
    mockRunPrompt.mockResolvedValueOnce({ lines: [{ text: 'Brot', quantity: 1 }] });

    expect((await extractListLines('data:image/jpeg;base64,AAAA')).model).toBeUndefined();
  });

  it('rejects a photo without a readable list', async () => {
    mockRunPrompt.mockResolvedValueOnce({ lines: [] });
    await expect(extractListLines('data:image/jpeg;base64,AAAA')).rejects.toThrow(/no readable/i);
  });

  it('passes the model failure through', async () => {
    mockRunPrompt.mockRejectedValueOnce(new Error('no vision-capable opencode model is available'));
    await expect(extractListLines('data:image/jpeg;base64,AAAA')).rejects.toThrow(/vision-capable/);
  });
});

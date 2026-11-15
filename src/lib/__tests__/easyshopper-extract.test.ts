import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../opencode-client', async (importOriginal) => {
  // Partial mock: `runPrompt` is stubbed, but the real constants stay in sync with
  // the module whose behaviour `extract.ts` maps.
  const actual = await importOriginal<typeof import('../opencode-client')>();
  return { ...actual, runPrompt: vi.fn() };
});

import { NOT_AN_ANSWER, runPrompt } from '../opencode-client';
import { extractListLines, normalizeExtractedLines } from '../easyshopper/extract';

const mockRunPrompt = vi.mocked(runPrompt);

beforeEach(() => mockRunPrompt.mockReset());

/** A real multi-KB photo, so a payload problem cannot hide behind a 20-byte stub. */
const photo = readFileSync(fileURLToPath(new URL('./fixtures/shopping-list.png', import.meta.url)));
const photoDataUri = `data:image/png;base64,${photo.toString('base64')}`;

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
      lines: ['', '   ', '---', '12', '[]', '2x', { text: 'x'.repeat(200) }, { text: 'Eier', quantity: 4 }],
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

  it('applies the cap after the filters, so junk cannot crowd out real lines', () => {
    const junk = Array.from({ length: 60 }, () => '---');
    expect(normalizeExtractedLines({ lines: [...junk, { text: 'Butter' }] })).toEqual([
      { text: 'Butter', quantity: 1 },
    ]);
  });

  it('treats an unusable quantity as one instead of dropping or trusting it', () => {
    expect(
      normalizeExtractedLines({
        lines: [
          { text: 'Milch', quantity: 999 },
          { text: 'Brot', quantity: '2' },
          { text: 'Eier', quantity: -3 },
          { text: 'Butter', quantity: 2.5 },
        ],
      })
    ).toEqual([
      { text: 'Milch', quantity: 1 },
      { text: 'Brot', quantity: 1 },
      { text: 'Eier', quantity: 1 },
      { text: 'Butter', quantity: 1 },
    ]);
  });

  it('takes a quantity the model moved into its own field, up to the ceiling', () => {
    // Models move the written number into the field and strip it from the text; there is
    // one ceiling, so 21 and 24 survive instead of falling back to 1.
    expect(
      normalizeExtractedLines({
        lines: [
          { text: 'Bier', quantity: 24 },
          { text: 'Wasser', quantity: 21 },
          { text: 'Brot', quantity: 99 },
        ],
      })
    ).toEqual([
      { text: 'Bier', quantity: 24 },
      { text: 'Wasser', quantity: 21 },
      { text: 'Brot', quantity: 99 },
    ]);
  });

  it('lets a quantity written in the text reach the ceiling but not past it', () => {
    expect(normalizeExtractedLines({ lines: [{ text: '24x Bier' }, { text: '999x Eier' }] })).toEqual([
      { text: 'Bier', quantity: 24 },
      { text: 'Eier', quantity: 99 },
    ]);
  });

  it('collapses the whitespace a photo transcription leaves behind', () => {
    expect(normalizeExtractedLines({ lines: [{ text: '  Waschmittel   sensitiv ' }] })).toEqual([
      { text: 'Waschmittel sensitiv', quantity: 1 },
    ]);
  });

  it('strips control and zero-width characters but keeps emoji', () => {
    expect(
      normalizeExtractedLines({ lines: [{ text: 'Wasch\u200bmittel\u0000 sensitiv' }, { text: 'Milch 🥛' }] })
    ).toEqual([
      { text: 'Waschmittel sensitiv', quantity: 1 },
      { text: 'Milch 🥛', quantity: 1 },
    ]);
  });

  it('truncates an over-long line at a word boundary instead of dropping it', () => {
    const long = `Waschmittel ${'sensitiv '.repeat(9)}4,5kg`;
    const [line] = normalizeExtractedLines({ lines: [{ text: long }] });

    expect(line.text.length).toBeLessThanOrEqual(80);
    expect(long.startsWith(line.text)).toBe(true);
    expect(long[line.text.length]).toBe(' ');
  });
});

describe('extractListLines', () => {
  it('sends the photo inline, allows the paid fallback and returns the lines', async () => {
    mockRunPrompt.mockImplementationOnce(async (_prompt, options) => {
      options?.onModelUsed?.({ id: 'mimo-v2.6-flash-free', providerID: 'opencode' });
      return { lines: [{ text: 'Milch 1,5', quantity: 2 }, { text: 'Brot' }] };
    });

    const result = await extractListLines('data:image/jpeg;base64,AAAA');

    expect(result).toEqual({
      lines: [
        { text: 'Milch 1,5', quantity: 2 },
        { text: 'Brot', quantity: 1 },
      ],
      model: 'opencode:mimo-v2.6-flash-free',
      paid: false,
    });
    const [prompt, options] = mockRunPrompt.mock.calls[0];
    expect(prompt).toContain('shopping list');
    expect(options?.require).toBe('image');
    expect(options?.allowPaid).toBe(true);
    expect(options?.files?.[0]).toMatchObject({ source: { type: 'inline' }, uri: 'data:image/jpeg;base64,AAAA' });
  });

  it('bounds the wait per attempt, below the patience of the UI', async () => {
    mockRunPrompt.mockResolvedValueOnce({ lines: [{ text: 'Brot', quantity: 1 }] });

    await extractListLines('data:image/jpeg;base64,AAAA');

    expect(mockRunPrompt.mock.calls[0][1]?.timeoutMs).toBe(90_000);
  });

  it('rejects an empty answer at the client boundary, so the next model is tried', async () => {
    mockRunPrompt.mockResolvedValueOnce({ lines: [{ text: 'Brot', quantity: 1 }] });

    await extractListLines('data:image/jpeg;base64,AAAA');

    const accept = mockRunPrompt.mock.calls[0][1]?.accept;
    expect(accept?.(null)).toBe(false);
    expect(accept?.({ lines: [] })).toBe(false);
    expect(accept?.({ lines: ['---'] })).toBe(false);
    expect(accept?.({ lines: [{ text: 'Brot', quantity: 2 }] })).toBe(true);
  });

  it('reports a paid fallback as the answering model', async () => {
    mockRunPrompt.mockImplementationOnce(async (_prompt, options) => {
      options?.onModelUsed?.({ id: 'gpt-6-luna', providerID: 'opencode-go', paid: true });
      return { lines: [{ text: 'Butter' }] };
    });

    await expect(extractListLines('data:image/jpeg;base64,AAAA')).resolves.toEqual({
      lines: [{ text: 'Butter', quantity: 1 }],
      model: 'opencode-go:gpt-6-luna',
      paid: true,
    });
  });

  it('wraps bare base64 in a data URI', async () => {
    mockRunPrompt.mockResolvedValueOnce({ lines: [{ text: 'Brot', quantity: 1 }] });

    await extractListLines('AAAA');

    expect(mockRunPrompt.mock.calls[0][1]?.files?.[0]).toMatchObject({ uri: 'data:image/jpeg;base64,AAAA' });
  });

  it('names the attachment after the type it actually is', async () => {
    mockRunPrompt.mockResolvedValue({ lines: [{ text: 'Brot', quantity: 1 }] });

    await extractListLines('data:image/png;base64,AAAA');
    await extractListLines('data:image/webp;base64,AAAA');

    expect(mockRunPrompt.mock.calls[0][1]?.files?.[0]?.name).toBe('shopping-list.png');
    expect(mockRunPrompt.mock.calls[1][1]?.files?.[0]?.name).toBe('shopping-list.webp');
  });

  it('posts the fixture photo byte-for-byte', async () => {
    mockRunPrompt.mockResolvedValueOnce({ lines: [{ text: 'Milch 1,5', quantity: 2 }] });

    await extractListLines(photoDataUri);

    const file = mockRunPrompt.mock.calls[0][1]?.files?.[0];
    expect(file?.uri).toBe(photoDataUri);
    expect(file?.name).toBe('shopping-list.png');
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
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    mockRunPrompt.mockRejectedValueOnce(new Error(NOT_AN_ANSWER));

    await expect(extractListLines('data:image/jpeg;base64,AAAA')).rejects.toThrow(/no readable/i);

    // The internal rejection is mapped to shopper wording, but stays diagnosable.
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('no vision model could read the photo'));
    warn.mockRestore();
  });

  it('still refuses an empty reply if the client ever returns one', async () => {
    // `accept` should make this unreachable; the post-check stays as a defensive guard.
    mockRunPrompt.mockResolvedValueOnce({ lines: [] });
    await expect(extractListLines('data:image/jpeg;base64,AAAA')).rejects.toThrow(/no readable/i);
  });

  it('passes the model failure through', async () => {
    mockRunPrompt.mockRejectedValueOnce(new Error('no vision-capable opencode model is available'));
    await expect(extractListLines('data:image/jpeg;base64,AAAA')).rejects.toThrow(/vision-capable/);
  });
});

import { describe, it, expect } from 'vitest';
import { aztecSvg } from '../../frontend/lib/aztec';

describe('aztecSvg', () => {
  it('encodes a userGuid as an Aztec symbol', () => {
    const { path, size } = aztecSvg('c74a298e-67d9-4a98-9684-34baafe8441d');
    // Aztec symbol sizes are 15, 19, 23, 27, … (4n+3)
    expect(size % 4).toBe(3);
    expect(size).toBeGreaterThanOrEqual(15);
    expect(path.startsWith('M')).toBe(true);
    expect(path.length).toBeGreaterThan(100);
  });

  it('is deterministic for the same guid', () => {
    const a = aztecSvg('c74a298e-67d9-4a98-9684-34baafe8441d');
    const b = aztecSvg('c74a298e-67d9-4a98-9684-34baafe8441d');
    expect(a).toEqual(b);
  });

  it('grows for a longer payload', () => {
    const small = aztecSvg('a');
    const large = aztecSvg('c74a298e-67d9-4a98-9684-34baafe8441d-and-more');
    expect(large.size).toBeGreaterThanOrEqual(small.size);
  });
});

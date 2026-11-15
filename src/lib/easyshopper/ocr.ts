/**
 * Handwritten shopping-list intake.
 *
 * OCR is a deliberate, documented exception to "opencode gets text only": a photo of
 * a paper list cannot be read as text. tesseract runs locally (no network, no model
 * account) and the LLM, when enabled, only cleans up the recognised lines — it never
 * sees a product catalogue and never picks products. Matching stays deterministic in
 * `match.ts`.
 */
import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

export interface OcrOptions {
  /** tesseract languages; German list words dominate. */
  languages?: string;
  /** Minimum characters for a line to survive cleanup. */
  minLength?: number;
}

const JUNK = /^[\s\-–—•*·|,.;:_=~]+$/;

/** Drop OCR noise: empty/bullet-only lines, page furniture, stray single characters. */
export function cleanOcrLines(raw: string, options: OcrOptions = {}): string[] {
  const minLength = options.minLength ?? 3;
  return raw
    .split(/\r?\n/)
    .map((line) =>
      line
        .replace(/\s+/g, ' ')
        .replace(/^[\s\-–—•*·|]+/, '')
        .replace(/[\s.,;:]+$/, '')
        .trim()
    )
    .filter((line) => line.length >= minLength && !JUNK.test(line))
    // tesseract often reads a checkbox as a leading digit or pipe.
    .map((line) => line.replace(/^[|!1]\s+(?=[A-Za-zÄÖÜäöüß])/, '').trim())
    .filter((line) => /[A-Za-zÄÖÜäöüß]/.test(line));
}

export function isTesseractAvailable(): boolean {
  const probe = spawnSync('tesseract', ['--version'], { encoding: 'utf8' });
  return probe.status === 0;
}

/** Run tesseract over an image file and return cleaned lines. */
export function ocrImageFile(imagePath: string, options: OcrOptions = {}): string[] {
  const languages = options.languages ?? 'deu+eng';
  const result = spawnSync('tesseract', [imagePath, 'stdout', '-l', languages, '--psm', '6'], {
    encoding: 'utf8',
    timeout: 60_000,
    maxBuffer: 8 * 1024 * 1024,
  });
  if (result.status !== 0) {
    throw new Error(`tesseract failed: ${result.stderr?.trim() || `exit ${result.status}`}`);
  }
  return cleanOcrLines(result.stdout, options);
}

/** Convenience for API callers holding image bytes rather than a path. */
export function ocrImageBuffer(data: Buffer, filename = 'list.jpg', options: OcrOptions = {}): string[] {
  const dir = mkdtempSync(join(tmpdir(), 'easyshopper-ocr-'));
  try {
    const path = join(dir, filename.replace(/[^\w.-]/g, '_'));
    writeFileSync(path, data);
    return ocrImageFile(path, options);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

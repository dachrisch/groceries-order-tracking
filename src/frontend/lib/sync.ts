/**
 * The one reading of the EDEKA capture's state.
 *
 * A capture is a *request to the phone* (plan note T4): the sidecar reads the
 * EASY Shopper app on the device and uploads whatever it found, minutes or
 * hours later. "Requested" is therefore not "done", and no surface may show a
 * spinner that implies a download is in progress.
 *
 * Overview, Activity and Settings all report the same three states, so the
 * derivation lives here rather than three times next to three copies of the
 * seven-day threshold. Settings owns the full card; the other pages use the
 * banner in `components/CapturePanel.tsx`.
 */
import { daysSince } from './format';
import { fetchWithTimeout } from './request';

export interface SyncStatus {
  /** Set while the sidecar has not answered a capture request yet. */
  requestedAt: string | null;
  /** When purchases were last uploaded. */
  lastImportAt: string | null;
  /** The newest receipt the app knows about, which may predate the upload. */
  lastPurchaseAt: string | null;
  /** Receipts stored, so "stale" can be told apart from "never captured". */
  sessions: number;
}

export type CaptureState = 'waiting' | 'connected' | 'offline';

/** Past this, the phone is not "a bit behind", it is not reporting. */
export const STALE_CAPTURE_DAYS = 7;

export function captureState(status: SyncStatus | null): CaptureState {
  if (status?.requestedAt) return 'waiting';
  const days = daysSince(status?.lastImportAt);
  return days === null || days > STALE_CAPTURE_DAYS ? 'offline' : 'connected';
}

/** The exact words the status badge uses; never a bare spinner. */
export function captureLabel(state: CaptureState): string {
  if (state === 'waiting') return 'waiting for phone';
  if (state === 'connected') return 'phone connected';
  return 'phone not connected';
}

/** `GET /api/easyshopper/sync/status`; null when the read failed (chrome, not a page). */
export async function readSyncStatus(): Promise<SyncStatus | null> {
  try {
    const res = await fetchWithTimeout('/api/easyshopper/sync/status');
    if (!res.ok) return null;
    return (await res.json()) as SyncStatus;
  } catch {
    return null;
  }
}

/**
 * Queue a capture. The response is only the request timestamp: the sidecar is a
 * separate device and this call cannot know when, or whether, it will answer.
 */
export async function requestCaptureSync(): Promise<{ ok: boolean; error?: string }> {
  try {
    const res = await fetchWithTimeout('/api/easyshopper/sync/request', { method: 'POST' });
    if (res.ok) return { ok: true };
    const body = (await res.json().catch(() => ({}))) as { error?: string };
    return { ok: false, error: body.error ?? 'Could not request a capture.' };
  } catch {
    return { ok: false, error: 'Could not reach the server to request a capture.' };
  }
}

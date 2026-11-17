/**
 * The EDEKA capture, reported on the pages that are not Settings.
 *
 * A capture is a request to the phone (plan note T4), so this banner has three
 * jobs and no spinner: say the request is queued, say the phone has gone quiet,
 * and otherwise stay out of the way. "Waiting for phone" is the honest state
 * until the sidecar uploads — a spinner here would claim a download that is not
 * happening.
 *
 * Overview and Activity mount it above their own content; both get the same
 * copy and the same action ("Sync now"), which is what keeps the two pages from
 * disagreeing about the phone.
 */
import { createSignal, onCleanup, onMount, Show } from 'solid-js';
import { RefreshCw, Smartphone } from 'lucide-solid';
import { StatePanel } from './StatePanel';
import { relativeDays } from '../lib/format';
import {
  captureState,
  readSyncStatus,
  requestCaptureSync,
  STALE_CAPTURE_DAYS,
  type SyncStatus,
} from '../lib/sync';

/** How long a queued request is polled before the banner stops asking the server. */
const POLL_ATTEMPTS = 12;
const POLL_INTERVAL_MS = 5000;

export function CapturePanel(props: { onSynced?: () => void }) {
  const [status, setStatus] = createSignal<SyncStatus | null>(null);
  const [busy, setBusy] = createSignal(false);
  const [error, setError] = createSignal<string | null>(null);
  const [polling, setPolling] = createSignal(false);

  let disposed = false;
  onCleanup(() => {
    disposed = true;
  });

  const load = async () => {
    const next = await readSyncStatus();
    if (disposed) return;
    if (next) setStatus(next);
    return next;
  };

  /**
   * Poll only while a request is queued. The cap matters: a phone that never
   * answers must not leave this component asking forever, so after a minute it
   * simply stops and "Check again" becomes the way forward.
   */
  const poll = async () => {
    if (polling()) return;
    setPolling(true);
    try {
      for (let attempt = 0; attempt < POLL_ATTEMPTS && !disposed; attempt += 1) {
        await new Promise((resolve) => setTimeout(resolve, POLL_INTERVAL_MS));
        const next = await load();
        if (disposed) break;
        if (!next?.requestedAt) {
          props.onSynced?.();
          break;
        }
      }
    } finally {
      if (!disposed) setPolling(false);
    }
  };

  onMount(async () => {
    const next = await load();
    if (next?.requestedAt) void poll();
  });

  const state = () => captureState(status());

  /** "Stale" needs a receipt to be stale: a fresh account has nothing to sync. */
  const stale = () => state() === 'offline' && (status()?.sessions ?? 0) > 0;

  const visible = () => state() === 'waiting' || stale();

  const syncNow = async () => {
    setBusy(true);
    setError(null);
    try {
      const result = await requestCaptureSync();
      if (!result.ok) {
        setError(result.error ?? 'Could not request a capture.');
        return;
      }
      await load();
      void poll();
    } finally {
      if (!disposed) setBusy(false);
    }
  };

  return (
    <Show when={visible()}>
      <Show
        when={state() === 'waiting'}
        fallback={
          <Show
            when={!error()}
            fallback={
              <StatePanel
                compact
                tone="error"
                icon={<RefreshCw size={18} />}
                title="Could not request a capture"
                body={error()}
                action={{ label: 'Sync now', onClick: syncNow, busy: busy() }}
              />
            }
          >
            <StatePanel
              compact
              tone="warning"
              icon={<Smartphone size={18} />}
              title="EDEKA capture is stale"
              body={`The last in-store capture was ${relativeDays(
                status()?.lastImportAt
              )}. Nothing new has arrived for over ${STALE_CAPTURE_DAYS} days.`}
              hint="A capture is a request to the phone. It changes nothing until the app on the device uploads."
              action={{ label: 'Sync now', onClick: syncNow, busy: busy() }}
            />
          </Show>
        }
      >
        <StatePanel
          compact
          tone="info"
          icon={<Smartphone size={18} />}
          title="Waiting for your phone"
          body="The capture request is queued. This is not a download: the sidecar reads the EDEKA app on your phone and uploads whatever it found."
          hint="You can leave this page. The receipts land on the next upload."
          action={{ label: 'Check again', onClick: () => void load() }}
        />
      </Show>
    </Show>
  );
}

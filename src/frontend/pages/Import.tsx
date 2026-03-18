import { createSignal, onMount, Show } from 'solid-js';
import { A } from '@solidjs/router';
import { RefreshCw } from 'lucide-solid';

export function Import() {
  const [loading, setLoading] = createSignal(false);
  const [connected, setConnected] = createSignal<boolean | null>(null);
  const [result, setResult] = createSignal<any>(null);
  const [error, setError] = createSignal('');

  onMount(async () => {
    const res = await fetch('/api/settings/integrations');
    if (res.ok) {
      const integrations = await res.json();
      setConnected(integrations.some((i: any) => i.provider === 'knuspr'));
    }
  });

  const handleSync = async () => {
    setLoading(true);
    setError('');
    setResult(null);
    try {
      // Use the dedicated sync endpoint (same as Settings "Sync Now")
      const res = await fetch('/api/settings/integrations/knuspr/sync', { method: 'POST' });
      const data = await res.json();
      if (res.ok) {
        setResult(data);
      } else {
        setError(data.error || 'Import failed');
      }
    } catch {
      setError('An error occurred during import.');
    } finally {
      setLoading(false);
    }
  };

  return (
    <div class="max-w-2xl mx-auto space-y-8">
      <h1 class="text-3xl font-bold">Sync Orders</h1>

      <Show when={connected() === false}>
        <div class="alert alert-warning">
          <span>Knuspr is not connected. <A href="/settings" class="link font-semibold">Go to Settings</A> to connect your account.</span>
        </div>
      </Show>

      <Show when={connected()}>
        <div class="card bg-base-100 shadow-xl">
          <div class="card-body space-y-4">
            <h2 class="card-title">Fetch latest orders from Knuspr</h2>
            <p class="text-sm opacity-70">
              Fetches all new delivered orders since your last sync. Already-imported orders are skipped.
            </p>
            <button
              class="btn btn-primary w-full gap-2"
              onClick={handleSync}
              disabled={loading()}
            >
              <Show when={loading()}>
                <span class="loading loading-spinner"></span>
              </Show>
              <Show when={!loading()}>
                <RefreshCw size={18} />
              </Show>
              Sync Now
            </button>

            <Show when={error()}>
              <div class="alert alert-error"><span>{error()}</span></div>
            </Show>
            <Show when={result()}>
              <div class="alert alert-success">
                <span>Sync complete — {result().importedCount} new orders imported!</span>
              </div>
            </Show>
          </div>
        </div>
      </Show>
    </div>
  );
}

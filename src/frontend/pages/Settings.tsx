import { createSignal, onMount, Show } from 'solid-js';
import { Link2, Link2Off, RefreshCw, ShoppingCart } from 'lucide-solid';

interface Integration {
  _id: string;
  provider: string;
  lastSyncAt: string | null;
  createdAt: string;
}

export function Settings() {
  const [integrations, setIntegrations] = createSignal<Integration[]>([]);
  const [loading, setLoading] = createSignal(true);
  const [knusprEmail, setKnusprEmail] = createSignal('');
  const [knusprPassword, setKnusprPassword] = createSignal('');
  const [connecting, setConnecting] = createSignal(false);
  const [syncing, setSyncing] = createSignal(false);
  const [disconnecting, setDisconnecting] = createSignal(false);
  const [message, setMessage] = createSignal<{ type: 'success' | 'error'; text: string } | null>(null);

  const showMessage = (type: 'success' | 'error', text: string) => {
    setMessage({ type, text });
    setTimeout(() => setMessage(null), 4000);
  };

  const fetchIntegrations = async () => {
    try {
      const res = await fetch('/api/settings/integrations');
      if (res.ok) setIntegrations(await res.json());
    } finally {
      setLoading(false);
    }
  };

  onMount(fetchIntegrations);

  const knusprIntegration = () => integrations().find(i => i.provider === 'knuspr');

  const handleConnect = async (e: Event) => {
    e.preventDefault();
    setConnecting(true);
    try {
      const res = await fetch('/api/settings/integrations/knuspr', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email: knusprEmail(), password: knusprPassword() }),
      });
      const data = await res.json();
      if (res.ok) {
        showMessage('success', 'Knuspr connected successfully!');
        setKnusprEmail('');
        setKnusprPassword('');
        await fetchIntegrations();
      } else {
        showMessage('error', data.error || 'Connection failed');
      }
    } catch {
      showMessage('error', 'Network error');
    } finally {
      setConnecting(false);
    }
  };

  const handleSync = async () => {
    setSyncing(true);
    try {
      const res = await fetch('/api/settings/integrations/knuspr/sync', { method: 'POST' });
      const data = await res.json();
      if (res.ok) {
        showMessage('success', `Sync complete — ${data.importedCount} new orders imported`);
        await fetchIntegrations();
      } else {
        showMessage('error', data.error || 'Sync failed');
      }
    } catch {
      showMessage('error', 'Network error during sync');
    } finally {
      setSyncing(false);
    }
  };

  const handleDisconnect = async () => {
    if (!confirm('Disconnect Knuspr? Your imported order history will remain.')) return;
    setDisconnecting(true);
    try {
      const res = await fetch('/api/settings/integrations/knuspr', { method: 'DELETE' });
      if (res.ok) {
        showMessage('success', 'Knuspr disconnected');
        await fetchIntegrations();
      }
    } catch {
      showMessage('error', 'Failed to disconnect');
    } finally {
      setDisconnecting(false);
    }
  };

  return (
    <div class="max-w-2xl mx-auto space-y-8">
      <div class="animate-fade-in">
        <h1 class="page-title">Settings</h1>
        <p class="text-base-content/85 mt-1">Manage your account and integrations</p>
      </div>

      <Show when={message()}>
        <div role="alert" class={`alert ${message()!.type === 'success' ? 'alert-success' : 'alert-error'}`}>
          <span>{message()!.text}</span>
        </div>
      </Show>

      <div class="card bg-base-100 shadow-xl">
        <div class="card-body">
          <h2 class="card-title mb-4">Connected Services</h2>

          <Show when={loading()}>
            <div class="flex justify-center py-8">
              <span class="loading loading-spinner loading-md" />
            </div>
          </Show>

          <Show when={!loading()}>
            {/* Knuspr Integration */}
            <div class="border border-base-300 rounded-xl p-4 space-y-4">
              <div class="flex items-center gap-3">
                <div class="bg-orange-100 text-orange-600 rounded-lg p-2">
                  <ShoppingCart size={24} />
                </div>
                <div class="flex-grow">
                  <div class="font-semibold text-lg">Knuspr</div>
                  <div class="text-xs opacity-85">Online supermarket order history</div>
                </div>
                <Show
                  when={knusprIntegration()}
                  fallback={
                    <div class="badge badge-ghost">Not connected</div>
                  }
                >
                  <div class="badge badge-success gap-1">
                    <Link2 size={12} />
                    Connected
                  </div>
                </Show>
              </div>

              {/* Connected state */}
              <Show when={knusprIntegration()}>
                {(integration) => (
                  <div class="space-y-3">
                    <div class="text-sm opacity-70">
                      Last synced:{' '}
                      {integration().lastSyncAt
                        ? new Date(integration().lastSyncAt!).toLocaleString()
                        : 'Never'}
                    </div>
                    <div class="flex gap-2">
                      <button
                        class="btn btn-primary btn-sm gap-2"
                        onClick={handleSync}
                        disabled={syncing()}
                      >
                        <Show when={syncing()}>
                          <span class="loading loading-spinner loading-xs" />
                        </Show>
                        <Show when={!syncing()}>
                          <RefreshCw size={14} />
                        </Show>
                        Sync Now
                      </button>
                      <button
                        class="btn btn-ghost btn-sm text-error gap-2"
                        onClick={handleDisconnect}
                        disabled={disconnecting()}
                      >
                        <Link2Off size={14} />
                        Disconnect
                      </button>
                    </div>
                  </div>
                )}
              </Show>

              {/* Connect form */}
              <Show when={!knusprIntegration()}>
                <form onSubmit={handleConnect} class="space-y-4">
                  <p class="text-sm opacity-70 mb-4">
                    Enter your Knuspr login credentials. They are encrypted with your app password and stored securely.
                  </p>
                  <div class="grid grid-cols-1 sm:grid-cols-2 gap-4">
                    <div class="form-control w-full">
                      <label for="knuspr-email" class="label">
                        <span class="label-text font-semibold text-xs">Knuspr Email</span>
                      </label>
                      <input
                        id="knuspr-email"
                        type="email"
                        class="input input-bordered input-sm w-full"
                        placeholder="your@email.de"
                        value={knusprEmail()}
                        onInput={(e) => setKnusprEmail(e.currentTarget.value)}
                        required
                      />
                    </div>
                    <div class="form-control w-full">
                      <label for="knuspr-password" class="label">
                        <span class="label-text font-semibold text-xs">Knuspr Password</span>
                      </label>
                      <input
                        id="knuspr-password"
                        type="password"
                        class="input input-bordered input-sm w-full"
                        placeholder="••••••••"
                        value={knusprPassword()}
                        onInput={(e) => setKnusprPassword(e.currentTarget.value)}
                        required
                      />
                    </div>
                  </div>
                  <div class="pt-2">
                    <button
                      type="submit"
                      class="btn btn-primary btn-sm gap-2 w-full"
                      disabled={connecting()}
                    >
                      <Show when={connecting()}>
                        <span class="loading loading-spinner loading-xs" />
                      </Show>
                      <Show when={!connecting()}>
                        <Link2 size={14} />
                      </Show>
                      Connect Knuspr
                    </button>
                  </div>
                </form>
              </Show>
            </div>
          </Show>
        </div>
      </div>

      <div class="card bg-base-100 shadow-xl">
        <div class="card-body">
          <h2 class="card-title text-base">About credential security</h2>
          <p class="text-sm opacity-70">
            Your third-party passwords are encrypted with a key derived from your app login credentials
            using AES-256-GCM. They are never stored in plaintext. The decryption key is stored in a
            secure httpOnly cookie for the duration of your session (7 days) and is never accessible
            to JavaScript.
          </p>
        </div>
      </div>
    </div>
  );
}

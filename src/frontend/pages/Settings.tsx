/**
 * Settings: the two service connections, where you are, and the guardrails.
 *
 * Two things are deliberately read-only here:
 *  - the destination for a plain `+` is derived from location (D3), not stored,
 *    so this page only explains what the current answer is;
 *  - the EDEKA "sync" is a request to the phone sidecar, not an instant
 *    refresh (T4), so the card shows "waiting for phone" or "phone not
 *    connected" instead of pretending the data has arrived.
 */
import { createEffect, createSignal, For, Index, onCleanup, onMount, Show } from 'solid-js';
import {
  Bot,
  Link2,
  Link2Off,
  MapPin,
  Plus,
  RefreshCw,
  Save,
  ShoppingCart,
  Smartphone,
  Trash2,
} from 'lucide-solid';
import { StatePanel } from '../components/StatePanel';
import { destinationLabel, providerLabel, useLocation } from '../lib/location';
import { relativeDays } from '../lib/format';
import { fetchWithTimeout } from '../lib/request';
import {
  captureLabel,
  captureState as captureStateOf,
  readSyncStatus,
  requestCaptureSync,
  STALE_CAPTURE_DAYS,
  type SyncStatus,
} from '../lib/sync';

interface Integration {
  _id: string;
  provider: string;
  lastSyncAt: string | null;
  createdAt: string;
}

interface BotSettings {
  maxEuro: number;
  maxItems: number;
  horizonDays: number;
  deliveryLeadDays: number;
  opencodeEnabled: boolean;
}

interface WindowRow {
  from: string;
  to: string;
  city: string;
}

export function Settings() {
  const location = useLocation();

  const [integrations, setIntegrations] = createSignal<Integration[]>([]);
  const [botSettings, setBotSettings] = createSignal<BotSettings | null>(null);
  const [savingBot, setSavingBot] = createSignal(false);
  const [loading, setLoading] = createSignal(true);
  const [knusprEmail, setKnusprEmail] = createSignal('');
  const [knusprPassword, setKnusprPassword] = createSignal('');
  const [connecting, setConnecting] = createSignal(false);
  const [syncing, setSyncing] = createSignal(false);
  const [disconnecting, setDisconnecting] = createSignal(false);
  const [message, setMessage] = createSignal<{ type: 'success' | 'error'; text: string } | null>(null);

  const [sync, setSync] = createSignal<SyncStatus | null>(null);
  const [edekaBusy, setEdekaBusy] = createSignal(false);
  const [connectingEdeka, setConnectingEdeka] = createSignal(false);

  /**
   * Writing a list needs the store app's own device account. It is created only
   * here, on this button — never as a side effect of adding a product.
   */
  const edekaAccount = () => location.state()?.providers.find((entry) => entry.provider === 'edeka');

  const connectEdeka = async () => {
    if (connectingEdeka()) return;
    setConnectingEdeka(true);
    try {
      const res = await fetch('/api/easyshopper/connect', { method: 'POST' });
      const body = (await res.json().catch(() => ({}))) as { error?: string; alreadyConnected?: boolean };
      if (!res.ok) {
        showMessage('error', body.error ?? 'Could not connect EDEKA');
        return;
      }
      showMessage(
        'success',
        body.alreadyConnected ? 'EDEKA was already connected' : 'EDEKA connected'
      );
      await location.refresh();
    } catch {
      showMessage('error', 'Network error while connecting EDEKA');
    } finally {
      setConnectingEdeka(false);
    }
  };

  const [homeCity, setHomeCity] = createSignal('');
  const [windows, setWindows] = createSignal<WindowRow[]>([]);
  const [seeded, setSeeded] = createSignal(false);
  const [savingLocation, setSavingLocation] = createSignal(false);
  const [locationError, setLocationError] = createSignal<string | null>(null);

  let disposed = false;
  onCleanup(() => {
    disposed = true;
  });

  const showMessage = (type: 'success' | 'error', text: string) => {
    setMessage({ type, text });
    setTimeout(() => setMessage(null), 4000);
  };

  const fetchIntegrations = async () => {
    try {
      const res = await fetchWithTimeout('/api/settings/integrations');
      if (res.ok) setIntegrations(await res.json());
    } catch (failure) {
      console.error('Could not read integrations', failure);
    } finally {
      setLoading(false);
    }
  };

  const fetchBotSettings = async () => {
    try {
      const res = await fetchWithTimeout('/api/bot/settings');
      if (res.ok) setBotSettings(await res.json());
    } catch {
      // The bot card is optional; leave it hidden if the request fails.
    }
  };

  const loadSyncStatus = async () => {
    // Settings is where the phone's state is reported, so a failed read is
    // visible instead of silently pretending the phone is connected.
    const next = await readSyncStatus();
    if (next) setSync(next);
  };

  onMount(() => {
    void fetchIntegrations();
    void fetchBotSettings();
    void loadSyncStatus();
  });

  /**
   * Seed the form from the shared location read once. A later store refresh must
   * not overwrite what the shopper is typing, so the seed happens only once.
   */
  createEffect(() => {
    const state = location.state();
    if (!state || seeded()) return;
    setHomeCity(state.settings.homeCity ?? '');
    setWindows(
      state.settings.awayWindows.map((window) => ({
        from: window.from.slice(0, 10),
        to: window.to.slice(0, 10),
        city: window.city,
      }))
    );
    setSeeded(true);
  });

  const updateBotSetting = <K extends keyof BotSettings>(key: K, value: BotSettings[K]) => {
    setBotSettings((previous) => (previous ? { ...previous, [key]: value } : previous));
  };

  const saveBotSettings = async () => {
    const current = botSettings();
    if (!current) return;
    setSavingBot(true);
    try {
      const res = await fetchWithTimeout('/api/bot/settings', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(current),
      });
      const data = await res.json();
      if (res.ok) {
        setBotSettings(data);
        showMessage('success', 'Bot settings saved');
      } else {
        showMessage('error', data.error || 'Could not save bot settings');
      }
    } catch {
      showMessage('error', 'Network error while saving bot settings');
    } finally {
      setSavingBot(false);
    }
  };

  const knusprIntegration = () => integrations().find((integration) => integration.provider === 'knuspr');

  const handleConnect = async (e: Event) => {
    e.preventDefault();
    setConnecting(true);
    try {
      const res = await fetchWithTimeout('/api/settings/integrations/knuspr', {
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
      const res = await fetchWithTimeout('/api/settings/integrations/knuspr/sync', { method: 'POST' });
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
      const res = await fetchWithTimeout('/api/settings/integrations/knuspr', { method: 'DELETE' });
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

  /** Ask the sidecar for a capture; the phone answers on its own schedule. */
  const requestCapture = async () => {
    setEdekaBusy(true);
    try {
      const result = await requestCaptureSync();
      if (!result.ok) {
        showMessage('error', result.error ?? 'Could not request a capture');
        return;
      }
      await loadSyncStatus();
      showMessage('success', 'Capture requested — waiting for the phone');
    } finally {
      if (!disposed) setEdekaBusy(false);
    }

    // Poll for a bounded while after the request, but never hold the button in
    // a spinner: the phone is a separate device and may answer much later.
    for (let attempt = 0; attempt < 15 && !disposed; attempt += 1) {
      await new Promise((resolve) => setTimeout(resolve, 4000));
      await loadSyncStatus();
      if (!sync()?.requestedAt) {
        if (!disposed) showMessage('success', 'Purchase history updated');
        break;
      }
    }
  };

  const captureState = () => captureStateOf(sync());

  const captureLabelText = () => captureLabel(captureState());

  const addWindow = () => setWindows((previous) => [...previous, { from: '', to: '', city: '' }]);

  const removeWindow = (index: number) =>
    setWindows((previous) => previous.filter((_, position) => position !== index));

  const updateWindow = (index: number, field: keyof WindowRow, value: string) =>
    setWindows((previous) =>
      previous.map((row, position) => (position === index ? { ...row, [field]: value } : row))
    );

  const saveLocation = async () => {
    setLocationError(null);
    const cleaned = windows()
      .filter((row) => row.from && row.to && row.city.trim())
      .map((row) => ({ from: row.from, to: row.to, city: row.city.trim() }));
    if (windows().length > cleaned.length) {
      setLocationError('An away window needs a start, an end and a city.');
      return;
    }
    if (cleaned.some((row) => row.from > row.to)) {
      setLocationError('An away window cannot end before it starts.');
      return;
    }
    setSavingLocation(true);
    try {
      const ok = await location.update({
        homeCity: homeCity().trim() || null,
        awayWindows: cleaned,
      });
      if (!ok) {
        setLocationError(location.error() ?? 'Could not save your location.');
        return;
      }
      showMessage('success', 'Location saved');
    } finally {
      setSavingLocation(false);
    }
  };

  return (
    <div class="mx-auto max-w-2xl space-y-8 pb-12">
      <div class="animate-fade-in">
        <h1 class="page-title">Settings</h1>
        <p class="mt-1 text-base-content/85">Services, location and guardrails</p>
      </div>

      <Show when={message()}>
        <div
          role="alert"
          class={`alert ${message()!.type === 'success' ? 'alert-success' : 'alert-error'}`}
        >
          <span>{message()!.text}</span>
        </div>
      </Show>

      {/* First run: neither source has ever reported anything. The cards below
          are the fix, so the action goes to them rather than to another page. */}
      <Show when={!loading() && !knusprIntegration() && (sync()?.sessions ?? 0) === 0}>
        <StatePanel
          compact
          tone="info"
          icon={<ShoppingCart size={18} />}
          title="No store connected yet"
          body="Connect Knuspr below for deliveries, or run the capture app on your phone for EDEKA receipts. Each card reports its own state."
          hint="A connection only reads your history; nothing is ordered on your behalf."
          action={{
            label: 'Set up Knuspr',
            onClick: () => {
              const field = document.getElementById('knuspr-email');
              field?.scrollIntoView({ block: 'center', behavior: 'smooth' });
              field?.focus();
            },
          }}
        />
      </Show>

      <div class="card rounded-2xl border border-base-300 bg-base-100 shadow-xl">
        <div class="card-body gap-4">
          <h2 class="card-title">Connected services</h2>

          <Show when={loading()}>
            <div class="flex justify-center py-8">
              <span class="loading loading-spinner loading-md" />
            </div>
          </Show>

          <Show when={!loading()}>
            {/* Knuspr: the delivery source, with its own credentials. */}
            <div class="space-y-4 rounded-xl border border-base-300 p-4">
              <div class="flex items-start gap-3">
                <div class="rounded-lg bg-orange-100 p-2 text-orange-600">
                  <ShoppingCart size={24} />
                </div>
                <div class="min-w-0 flex-grow">
                  <div class="flex flex-wrap items-center gap-2">
                    <span class="text-lg font-semibold">Knuspr</span>
                    <Show
                      when={knusprIntegration()}
                      fallback={<span class="badge badge-ghost badge-sm">Not connected</span>}
                    >
                      <span class="badge badge-success badge-sm gap-1">
                        <Link2 size={12} />
                        Connected
                      </span>
                    </Show>
                  </div>
                  <div class="text-xs opacity-85">Online supermarket order history</div>
                </div>
              </div>

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
                      <button class="btn btn-primary btn-sm gap-2" onClick={handleSync} disabled={syncing()}>
                        <Show when={syncing()}>
                          <span class="loading loading-spinner loading-xs" />
                        </Show>
                        <Show when={!syncing()}>
                          <RefreshCw size={14} />
                        </Show>
                        Sync now
                      </button>
                      <button
                        class="btn btn-ghost btn-sm gap-2 text-error"
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

              <Show when={!knusprIntegration()}>
                <form onSubmit={handleConnect} class="space-y-4">
                  <p class="text-sm opacity-70">
                    Enter your Knuspr login credentials. They are encrypted with your app password
                    and stored securely.
                  </p>
                  <div class="grid grid-cols-1 gap-4 sm:grid-cols-2">
                    <div class="form-control w-full">
                      <label for="knuspr-email" class="label">
                        <span class="label-text text-xs font-semibold">Knuspr Email</span>
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
                        <span class="label-text text-xs font-semibold">Knuspr Password</span>
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
                  <button type="submit" class="btn btn-primary btn-sm w-full gap-2" disabled={connecting()}>
                    <Show when={connecting()}>
                      <span class="loading loading-spinner loading-xs" />
                    </Show>
                    <Show when={!connecting()}>
                      <Link2 size={14} />
                    </Show>
                    Connect Knuspr
                  </button>
                </form>
              </Show>
            </div>

            {/*
              EDEKA has no password: the integration keeps its own device account
              and the purchases arrive from the capture sidecar on the phone. So
              this is a request, and the card reports the phone's state.
            */}
            <div class="space-y-3 rounded-xl border border-base-300 p-4">
              <div class="flex items-start gap-3">
                <div class="rounded-lg bg-amber-100 p-2 text-amber-700">
                  <Smartphone size={24} />
                </div>
                <div class="min-w-0 flex-grow">
                  <div class="flex flex-wrap items-center gap-2">
                    <span class="text-lg font-semibold">EDEKA</span>
                    <span
                      class={`badge badge-sm gap-1 ${
                        captureState() === 'waiting'
                          ? 'badge-warning'
                          : captureState() === 'connected'
                            ? 'badge-success'
                            : 'badge-ghost'
                      }`}
                    >
                      {/* A request in flight is a queued message, not a download: no spinner. */}
                      <Show when={captureState() === 'waiting'}>
                        <Smartphone size={11} />
                      </Show>
                      {captureLabelText()}
                    </span>
                  </div>
                  <div class="text-xs opacity-85">
                    In-store purchases, captured from the phone
                  </div>
                </div>
              </div>

              <p class="text-sm opacity-70">
                <Show
                  when={captureState() !== 'waiting'}
                  fallback="The capture request is queued. The phone has not uploaded yet, and this page cannot make it do so — the request stays queued until the capture app runs."
                >
                  <Show
                    when={sync()?.lastImportAt}
                    fallback="No capture yet. Run the capture app on your phone to import a receipt."
                  >
                    {(lastImport) => (
                      <>
                        Last capture {relativeDays(lastImport())} · {sync()?.sessions ?? 0} receipts
                        saved.
                        <Show when={captureState() === 'offline'}>
                          {' '}
                          Nothing arrived for over {STALE_CAPTURE_DAYS} days — check that the
                          capture app still runs on the phone.
                        </Show>
                      </>
                    )}
                  </Show>
                </Show>
              </p>

              <button
                class="btn btn-outline btn-sm gap-2"
                onClick={() => void requestCapture()}
                disabled={edekaBusy()}
                title={
                  edekaBusy()
                    ? 'The request is on its way to the server'
                    : captureState() === 'waiting'
                      ? 'Ask again; a queued request stays queued until the phone uploads'
                      : 'Ask the phone sidecar for a capture'
                }
              >
                <Show when={edekaBusy()} fallback={<RefreshCw size={14} />}>
                  <span class="loading loading-spinner loading-xs" />
                </Show>
                {captureState() === 'waiting' ? 'Request again' : 'Request a capture'}
              </button>
              <p class="text-[11px] opacity-55">
                A capture is a request to the sidecar, not an instant refresh. Until the phone
                uploads, nothing changes.
              </p>

              {/*
                Two different things: capturing receipts needs the phone, writing a
                list needs an account in the store app. Saying so is the point.
              */}
              <div class="rounded-lg border border-base-300 bg-base-200/50 p-3">
                <Show
                  when={!edekaAccount()?.connected}
                  fallback={
                    <p class="text-[11px] opacity-60">
                      The store app's device account exists, so a shopping list can be written and
                      shared as a code.
                    </p>
                  }
                >
                  <p class="text-[11px] opacity-70">
                    Writing a shopping list needs EDEKA's own device account. This creates one in
                    the store app; nothing is ordered and no purchase happens.
                  </p>
                  <button
                    class="btn btn-outline btn-sm mt-2 gap-2"
                    onClick={connectEdeka}
                    disabled={connectingEdeka()}
                  >
                    <Show when={connectingEdeka()}>
                      <span class="loading loading-spinner loading-xs" />
                    </Show>
                    Connect EDEKA
                  </button>
                </Show>
              </div>
            </div>
          </Show>
        </div>
      </div>

      <div class="card rounded-2xl border border-base-300 bg-base-100 shadow-xl">
        <div class="card-body gap-4">
          <h2 class="card-title gap-2">
            <MapPin size={20} />
            Location &amp; coverage
          </h2>
          <p class="text-sm opacity-70">
            Coverage decides what can be ordered: Knuspr delivers inside Munich, EDEKA is a shop
            you walk into anywhere in Germany.
          </p>

          <div class="form-control w-full">
            <label for="home-city" class="label">
              <span class="label-text text-xs font-semibold">Home city</span>
            </label>
            <input
              id="home-city"
              class="input input-bordered input-sm w-full"
              placeholder="e.g. Munich"
              value={homeCity()}
              onInput={(event) => setHomeCity(event.currentTarget.value)}
            />
          </div>

          <div class="space-y-2">
            <div class="flex items-center justify-between gap-2">
              <span class="text-xs font-semibold">Away windows</span>
              <button class="btn btn-ghost btn-xs gap-1" onClick={addWindow}>
                <Plus size={13} /> Add
              </button>
            </div>
            <p class="text-[11px] opacity-60">
              A date outside your home city already counts as away; add a window only when you want
              to correct the city.
            </p>
            <Show when={windows().length === 0}>
              <p class="rounded-xl bg-base-200/50 p-3 text-[11px] opacity-65">
                No away windows. Your home city applies every day.
              </p>
            </Show>
            {/*
              `Index`, not `For`: editing a city builds a new row object, and
              `For` keys by object identity, so every keystroke would recreate
              the input and steal the focus after one character. `Index` keys by
              position, so the fields survive the edit.
            */}
            <Index each={windows()}>
              {(row, index) => (
                <div class="flex flex-wrap items-end gap-2 rounded-xl border border-base-300 p-2">
                  <div class="form-control">
                    <label class="label py-0">
                      <span class="label-text text-[10px] font-semibold">From</span>
                    </label>
                    <input
                      type="date"
                      class="input input-bordered input-sm"
                      value={row().from}
                      onInput={(event) => updateWindow(index, 'from', event.currentTarget.value)}
                    />
                  </div>
                  <div class="form-control">
                    <label class="label py-0">
                      <span class="label-text text-[10px] font-semibold">To</span>
                    </label>
                    <input
                      type="date"
                      class="input input-bordered input-sm"
                      value={row().to}
                      onInput={(event) => updateWindow(index, 'to', event.currentTarget.value)}
                    />
                  </div>
                  <div class="form-control min-w-[8rem] flex-1">
                    <label class="label py-0">
                      <span class="label-text text-[10px] font-semibold">City</span>
                    </label>
                    <input
                      class="input input-bordered input-sm w-full"
                      placeholder="e.g. Berlin"
                      value={row().city}
                      onInput={(event) => updateWindow(index, 'city', event.currentTarget.value)}
                    />
                  </div>
                  <button
                    class="btn btn-ghost btn-sm btn-square text-error"
                    onClick={() => removeWindow(index)}
                    aria-label="Remove away window"
                  >
                    <Trash2 size={15} />
                  </button>
                </div>
              )}
            </Index>
          </div>

          <Show when={locationError()}>
            <div class="alert alert-error py-2 shadow-sm">
              <span class="text-xs font-semibold">{locationError()}</span>
            </div>
          </Show>

          <Show when={location.state()}>
            {(state) => (
              <div class="space-y-2 rounded-xl border border-primary/25 bg-primary/5 p-3">
                <div class="text-[10px] font-bold uppercase tracking-wide text-base-content/55">
                  What that means right now
                </div>
                <div class="text-sm font-bold">
                  {state().context.source === 'unknown'
                    ? 'Location not set'
                    : `${state().context.source === 'away' ? 'Away' : 'Home'} · ${state().context.city ?? ''}`}
                </div>
                <div class="text-xs">
                  Destination for a plain +: <b>{destinationLabel(state().destination)}</b>
                </div>
                <p class="text-[11px] opacity-70">{state().reason}</p>
                <div class="space-y-1 pt-1">
                  <For each={state().providers}>
                    {(provider) => (
                      <div class="flex items-start gap-2 text-[11px]">
                        <span class="font-semibold">{providerLabel(provider.provider)}</span>
                        <span class={`badge badge-xs ${provider.available ? 'badge-success' : 'badge-ghost'}`}>
                          {provider.available ? 'available' : 'not here'}
                        </span>
                        <span class="opacity-65">{provider.reason}</span>
                      </div>
                    )}
                  </For>
                </div>
                <p class="text-[10px] opacity-55">
                  The destination is derived from your location, not a stored preference. Every
                  sheet that starts a run can still override it for that run.
                </p>
              </div>
            )}
          </Show>

          <div class="flex flex-col items-end gap-1">
            <button
              class="btn btn-primary btn-sm gap-2"
              onClick={saveLocation}
              disabled={savingLocation() || location.loading()}
            >
              <Show when={savingLocation()} fallback={<Save size={14} />}>
                <span class="loading loading-spinner loading-xs" />
              </Show>
              Save location
            </button>
            <Show when={location.loading() && !savingLocation()}>
              <p class="text-[11px] opacity-60">
                Reading your saved location first; saving unlocks when it arrives.
              </p>
            </Show>
          </div>
        </div>
      </div>

      <Show when={botSettings()}>
        {(settings) => (
          <div class="card rounded-2xl border border-base-300 bg-base-100 shadow-xl">
            <div class="card-body">
              <h2 class="card-title mb-1 gap-2">
                <Bot size={20} />
                Order bot
              </h2>
              <p class="text-sm opacity-70">
                Guardrails apply to both destinations before anything is added to a basket.
              </p>

              <div class="mt-2 grid grid-cols-1 gap-4 sm:grid-cols-2">
                <div class="form-control w-full">
                  <label for="bot-max-euro" class="label">
                    <span class="label-text text-xs font-semibold">Max € per run</span>
                  </label>
                  <input
                    id="bot-max-euro"
                    type="number"
                    min="1"
                    max="10000"
                    class="input input-bordered input-sm w-full"
                    value={settings().maxEuro}
                    onInput={(event) => updateBotSetting('maxEuro', Number(event.currentTarget.value))}
                  />
                </div>

                <div class="form-control w-full">
                  <label for="bot-max-items" class="label">
                    <span class="label-text text-xs font-semibold">Max items per run</span>
                  </label>
                  <input
                    id="bot-max-items"
                    type="number"
                    min="1"
                    max="500"
                    class="input input-bordered input-sm w-full"
                    value={settings().maxItems}
                    onInput={(event) => updateBotSetting('maxItems', Number(event.currentTarget.value))}
                  />
                </div>

                <div class="form-control w-full">
                  <label for="bot-horizon" class="label">
                    <span class="label-text text-xs font-semibold">Plan ahead (days)</span>
                  </label>
                  <input
                    id="bot-horizon"
                    type="number"
                    min="1"
                    max="60"
                    class="input input-bordered input-sm w-full"
                    value={settings().horizonDays}
                    onInput={(event) => updateBotSetting('horizonDays', Number(event.currentTarget.value))}
                  />
                </div>

                <div class="form-control w-full">
                  <label for="bot-lead" class="label">
                    <span class="label-text text-xs font-semibold">Delivery lead time (days)</span>
                  </label>
                  <input
                    id="bot-lead"
                    type="number"
                    min="0"
                    max="14"
                    class="input input-bordered input-sm w-full"
                    value={settings().deliveryLeadDays}
                    onInput={(event) =>
                      updateBotSetting('deliveryLeadDays', Number(event.currentTarget.value))
                    }
                  />
                </div>
              </div>

              <label class="label mt-2 cursor-pointer justify-start gap-3">
                <input
                  type="checkbox"
                  class="toggle toggle-primary"
                  checked={settings().opencodeEnabled}
                  onChange={(event) => updateBotSetting('opencodeEnabled', event.currentTarget.checked)}
                />
                <span class="label-text">
                  Use opencode for language
                  <span class="block text-xs opacity-60">
                    Simple commands like "fill this week" still work without it.
                  </span>
                </span>
              </label>

              <div class="pt-2">
                <button class="btn btn-primary btn-sm gap-2" onClick={saveBotSettings} disabled={savingBot()}>
                  <Show when={savingBot()} fallback={<Save size={14} />}>
                    <span class="loading loading-spinner loading-xs" />
                  </Show>
                  Save bot settings
                </button>
              </div>
            </div>
          </div>
        )}
      </Show>

      <div class="card rounded-2xl border border-base-300 bg-base-100 shadow-xl">
        <div class="card-body">
          <h2 class="card-title text-base">About credential security</h2>
          <p class="text-sm opacity-70">
            Your third-party passwords are encrypted with a key derived from your app login
            credentials using AES-256-GCM. They are never stored in plaintext. The decryption key is
            stored in a secure httpOnly cookie for the duration of your session (7 days) and is
            never accessible to JavaScript.
          </p>
        </div>
      </div>
    </div>
  );
}

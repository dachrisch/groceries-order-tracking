/**
 * One location read for the whole shell.
 *
 * Every page shows the same city and the same reach per provider, so the shell
 * fetches `GET /api/location` once and shares it through a context instead of
 * each page asking again. Availability only changes defaults and copy — this
 * store never writes to a cart or a list.
 *
 * `update()` is the loader's write half. Settings uses it once away windows
 * become editable; the read path is complete without it.
 */
import { createContext, createSignal, onMount, useContext, type Accessor, type JSX } from 'solid-js';

export type Provider = 'knuspr' | 'edeka';
export type Destination = 'knuspr-cart' | 'edeka-list' | 'checklist';

export interface AwayWindow {
  from: string;
  to: string;
  city: string;
}

export interface LocationSettings {
  homeCity: string | null;
  homeCountry: string | null;
  awayWindows: AwayWindow[];
}

export interface LocationContext {
  source: 'home' | 'away' | 'unknown';
  city: string | null;
  country: string | null;
  awayWindow?: AwayWindow;
}

export interface ProviderStatus {
  provider: Provider;
  /** Whether an account is connected, which is a different question from reach. */
  connected: boolean;
  lastSyncAt: string | null;
  available: boolean;
  reason: string;
}

export interface LocationState {
  now: string;
  settings: LocationSettings;
  context: LocationContext;
  providers: ProviderStatus[];
  destination: Destination;
  reason: string;
}

export interface LocationUpdate {
  homeCity?: string | null;
  homeCountry?: string | null;
  awayWindows?: Array<{ from: string; to: string; city: string }>;
}

interface LocationStore {
  state: Accessor<LocationState | null>;
  loading: Accessor<boolean>;
  error: Accessor<string | null>;
  refresh: () => Promise<void>;
  update: (input: LocationUpdate) => Promise<boolean>;
}

const LocationStoreContext = createContext<LocationStore>();

export function LocationProvider(props: { children?: JSX.Element }) {
  const [state, setState] = createSignal<LocationState | null>(null);
  const [loading, setLoading] = createSignal(true);
  const [error, setError] = createSignal<string | null>(null);

  const read = async (url: string, init?: RequestInit): Promise<boolean> => {
    try {
      const res = await fetch(url, init);
      const body = await res.json().catch(() => ({}));
      if (!res.ok) {
        setError((body as { error?: string }).error ?? 'Could not read your location.');
        return false;
      }
      setState(body as LocationState);
      setError(null);
      return true;
    } catch (failure) {
      console.error('Location request failed', failure);
      setError('Could not read your location.');
      return false;
    }
  };

  const refresh = async () => {
    setLoading(true);
    try {
      await read('/api/location');
    } finally {
      setLoading(false);
    }
  };

  // Settings is the only writer. Kept next to the read so the wire shape and
  // the cache cannot drift apart when that form lands.
  const update = (input: LocationUpdate) =>
    read('/api/location', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(input),
    });

  onMount(refresh);

  return (
    <LocationStoreContext.Provider value={{ state, loading, error, refresh, update }}>
      {props.children}
    </LocationStoreContext.Provider>
  );
}

export function useLocation(): LocationStore {
  const store = useContext(LocationStoreContext);
  if (!store) throw new Error('useLocation must be used inside <LocationProvider>');
  return store;
}

export function destinationLabel(destination: Destination | undefined): string {
  if (destination === 'knuspr-cart') return 'Knuspr cart';
  if (destination === 'edeka-list') return 'EDEKA list';
  if (destination === 'checklist') return 'Checklist';
  return '—';
}

export function providerLabel(provider: Provider): string {
  return provider === 'knuspr' ? 'Knuspr' : 'EDEKA';
}

export function formatAwayWindow(window: AwayWindow): string {
  const format = (value: string) => new Date(value).toLocaleDateString();
  return `${format(window.from)} – ${format(window.to)}`;
}

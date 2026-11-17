import { createSignal, For, onCleanup, onMount, JSX, Show } from 'solid-js';
import { useNavigate, useLocation, A } from '@solidjs/router';
import {
  Activity,
  Bot,
  ChevronLeft,
  ChevronRight,
  LayoutDashboard,
  LogOut,
  Search,
  Settings as SettingsIcon,
  ShoppingBasket,
} from 'lucide-solid';
import { BotPanel } from './components/BotPanel';
import { AskHub } from './components/AskHub';
import { SearchOverlay } from './components/SearchOverlay';
import { LocationChip } from './components/LocationChip';
import { LocationProvider } from './lib/location';
import { askHubOpen, openAsk, openSearch } from './lib/overlays';

/**
 * The shell: five destinations, one navigation model.
 *
 * Desktop keeps the collapsible drawer; mobile uses the bottom tab bar with Ask
 * in the centre. Search and location are overlays mounted here so every page
 * can reach them without owning a copy.
 */

const NAV = [
  { href: '/', label: 'Overview', icon: LayoutDashboard, tone: 'text-primary/90' },
  { href: '/groceries', label: 'Groceries', icon: ShoppingBasket, tone: 'text-accent/90' },
  { href: '/activity', label: 'Activity', icon: Activity, tone: 'text-secondary/90' },
  { href: '/settings', label: 'Settings', icon: SettingsIcon, tone: 'text-neutral/90' },
];

const MOBILE_LEFT = NAV.slice(0, 2);
const MOBILE_RIGHT = NAV.slice(2);

export function App(props: { children?: JSX.Element }) {
  const [user, setUser] = createSignal<{ name: string; email: string } | null>(null);
  const [loading, setLoading] = createSignal(true);
  const [sidebarCollapsed, setSidebarCollapsed] = createSignal(false);
  const [version, setVersion] = createSignal('');
  /**
   * A session read that failed for a reason other than "not logged in". A 429 is
   * the obvious case: treating it as a logout threw the shopper onto the login
   * screen for browsing a little too fast.
   */
  const [sessionIssue, setSessionIssue] = createSignal<string | null>(null);
  const navigate = useNavigate();
  const location = useLocation();

  const fetchUser = async () => {
    try {
      const res = await fetch('/api/session');
      if (res.ok) {
        const data = await res.json();
        setUser(data as { name: string; email: string });
        setSessionIssue(null);
        return;
      }
      if (res.status === 401 || res.status === 403) {
        if (location.pathname !== '/login' && location.pathname !== '/register') navigate('/login');
        return;
      }
      setSessionIssue(
        res.status === 429
          ? 'Slow down for a moment — the app asked too many times in a row. Nothing was lost.'
          : 'Could not check your session. This is not a logout.'
      );
    } catch (e) {
      console.error('Session fetch failed', e);
      setSessionIssue('Could not reach the server. This is not a logout.');
    } finally {
      setLoading(false);
    }
  };

  onMount(fetchUser);

  const fetchVersion = async () => {
    try {
      const res = await fetch('/api/version');
      if (res.ok) {
        const data = await res.json();
        setVersion(data.version);
      }
    } catch {
      // Silently fail
    }
  };

  onMount(fetchVersion);

  // Cmd/Ctrl+K is the one shortcut a search overlay is expected to answer.
  onMount(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (!user()) return;
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 'k') {
        event.preventDefault();
        openSearch();
      }
    };
    window.addEventListener('keydown', onKeyDown);
    onCleanup(() => window.removeEventListener('keydown', onKeyDown));
  });

  const handleLogout = async () => {
    await fetch('/api/logout', { method: 'POST' });
    setUser(null);
    navigate('/login');
  };

  const isAuthPage = () => ['/login', '/register'].includes(location.pathname);

  return (
    <div class="min-h-screen bg-base-200">
      <Show when={!loading()}>
        <Show when={user() && !isAuthPage()}>
          {/* Mounted with the session so the first read is authenticated. */}
          <LocationProvider>
            {/* drawer lg:drawer-open: desktop always shows the sidebar; mobile uses the tab bar */}
          <div class={`drawer lg:drawer-open ${sidebarCollapsed() ? 'lg:drawer-collapsed' : ''}`}>
            <input id="mobile-drawer" type="checkbox" class="drawer-toggle" />

            <div class="drawer-content flex h-screen flex-col overflow-hidden bg-base-200">
              {/* Desktop top bar: search and the one location read */}
              <header class="hidden h-20 shrink-0 items-center gap-4 border-b border-base-300/70 bg-base-100/60 px-8 backdrop-blur lg:flex xl:px-12">
                <button
                  class="flex max-w-xl flex-1 items-center gap-3 rounded-xl border border-base-300 bg-base-100 px-4 py-2.5 text-left text-sm text-base-content/60 transition-colors hover:border-primary/40"
                  onClick={openSearch}
                >
                  <Search size={18} />
                  <span class="truncate">Search history and both stores…</span>
                  <kbd class="kbd kbd-sm ml-auto hidden font-sans text-[10px] xl:inline-flex">
                    Ctrl K
                  </kbd>
                </button>
                <LocationChip />
              </header>

              {/* Mobile top bar: brand, location, search, account */}
              <header class="flex shrink-0 items-center gap-2 border-b border-base-300 bg-base-100 px-3 py-2 lg:hidden">
                <div class="flex min-w-0 items-center gap-2">
                  <div class="flex h-8 w-8 shrink-0 items-center justify-center rounded-xl bg-gradient-to-br from-primary to-primary/80 text-primary-content shadow-md">
                    <ShoppingBasket size={17} />
                  </div>
                  <span class="hidden truncate text-sm font-bold sm:inline">Groceries</span>
                </div>
                <div class="ml-auto flex items-center gap-1">
                  <LocationChip compact />
                  <button
                    class="btn btn-ghost btn-sm btn-square"
                    onClick={openSearch}
                    aria-label="Search"
                  >
                    <Search size={18} />
                  </button>
                  <div class="dropdown dropdown-end">
                    <div
                      tabindex="0"
                      role="button"
                      class="btn btn-ghost btn-sm btn-circle avatar placeholder"
                      aria-label="Account"
                    >
                      <div class="flex w-8 items-center justify-center rounded-full bg-gradient-to-br from-primary to-primary/80 text-primary-content">
                        <span class="text-xs">{user()?.name?.charAt(0).toUpperCase() || 'U'}</span>
                      </div>
                    </div>
                    <ul
                      tabindex="0"
                      class="dropdown-content menu z-[60] mt-2 w-56 rounded-box border border-base-300 bg-base-100 p-2 shadow-xl"
                    >
                      <li>
                        <div class="px-3 py-2">
                          <div class="truncate text-sm font-semibold">{user()?.name}</div>
                          <div class="truncate text-[11px] opacity-60">{user()?.email}</div>
                        </div>
                      </li>
                      <li>
                        <button onClick={handleLogout} class="text-error">
                          <LogOut size={16} /> Logout
                        </button>
                      </li>
                    </ul>
                  </div>
                </div>
              </header>

              <main class="flex-1 overflow-y-auto p-4 pb-24 lg:p-8 xl:p-12">
                <div class="mx-auto w-full max-w-7xl">{props.children}</div>
              </main>
            </div>

            {/* Sidebar: always open on desktop, out of reach on mobile */}
            <div class="drawer-side z-30">
              <label for="mobile-drawer" aria-label="close sidebar" class="drawer-overlay" />
              <div
                class={`flex h-full flex-col border-r border-base-300/75 bg-base-100 text-base-content shadow-xl transition-all duration-300 ease-in-out
                  ${sidebarCollapsed() ? 'w-20' : 'w-72'}`}
              >
                <div class="flex h-20 shrink-0 items-center justify-between border-b border-base-300/75 px-4 py-5">
                  <Show when={!sidebarCollapsed()}>
                    <div class="flex items-center gap-3">
                      <div class="flex h-9 w-9 items-center justify-center rounded-xl bg-gradient-to-br from-primary to-primary/80 text-primary-content shadow-lg shadow-primary/85">
                        <ShoppingBasket size={18} />
                      </div>
                      <div>
                        <span class="whitespace-nowrap text-lg font-bold tracking-tight">
                          Groceries
                        </span>
                        <span class="-mt-0.5 block text-xs opacity-75">Tracking</span>
                      </div>
                    </div>
                  </Show>
                  <button
                    onClick={() => setSidebarCollapsed(!sidebarCollapsed())}
                    class="btn btn-ghost btn-sm btn-square hidden lg:flex"
                    title={sidebarCollapsed() ? 'Expand sidebar' : 'Collapse sidebar'}
                  >
                    <Show when={sidebarCollapsed()} fallback={<ChevronLeft size={18} />}>
                      <ChevronRight size={18} />
                    </Show>
                  </button>
                </div>

                <div class="flex-grow overflow-y-auto py-4">
                  <ul class="menu space-y-1 p-0 px-3">
                    <For each={NAV.slice(0, 2)}>
                      {(item) => (
                        <li>
                          <A
                            href={item.href}
                            end={item.href === '/'}
                            activeClass="active"
                            class={`flex items-center gap-3.5 rounded-xl py-2.5 transition-all duration-200 hover:bg-base-200/75 ${
                              sidebarCollapsed() ? 'justify-center px-2' : 'px-4'
                            }`}
                          >
                            <item.icon size={20} class={item.tone} />
                            <Show when={!sidebarCollapsed()}>
                              <span class="font-medium">{item.label}</span>
                            </Show>
                          </A>
                        </li>
                      )}
                    </For>
                    <li>
                      <button
                        onClick={() => openAsk('chat')}
                        class={`flex items-center gap-3.5 rounded-xl py-2.5 transition-all duration-200 hover:bg-base-200/75 ${
                          sidebarCollapsed() ? 'justify-center px-2' : 'px-4'
                        } ${askHubOpen() ? 'bg-base-200 text-primary' : ''}`}
                        title="Ask"
                      >
                        <Bot size={20} class="text-info/90" />
                        <Show when={!sidebarCollapsed()}>
                          <span class="font-medium">Ask</span>
                        </Show>
                      </button>
                    </li>
                    <For each={NAV.slice(2)}>
                      {(item) => (
                        <li>
                          <A
                            href={item.href}
                            activeClass="active"
                            class={`flex items-center gap-3.5 rounded-xl py-2.5 transition-all duration-200 hover:bg-base-200/75 ${
                              sidebarCollapsed() ? 'justify-center px-2' : 'px-4'
                            }`}
                          >
                            <item.icon size={20} class={item.tone} />
                            <Show when={!sidebarCollapsed()}>
                              <span class="font-medium">{item.label}</span>
                            </Show>
                          </A>
                        </li>
                      )}
                    </For>
                  </ul>
                </div>

                <div class="mt-auto space-y-3 border-t border-base-300/75 bg-base-100/85 p-4">
                  <div
                    class={`flex items-center gap-3 rounded-xl bg-base-200/40 p-2.5 ${
                      sidebarCollapsed() ? 'justify-center' : ''
                    }`}
                  >
                    <div class="avatar placeholder flex-shrink-0">
                      <div class="flex w-9 items-center justify-center rounded-full bg-gradient-to-br from-primary to-primary/80 text-primary-content shadow-md ring-2 ring-primary/10">
                        <span class="text-sm leading-none">
                          {user()?.name?.charAt(0).toUpperCase() || 'U'}
                        </span>
                      </div>
                    </div>
                    <Show when={!sidebarCollapsed()}>
                      <div class="min-w-0 flex-grow">
                        <div class="truncate text-sm font-semibold">{user()?.name}</div>
                        <div class="truncate text-xs opacity-75">{user()?.email}</div>
                      </div>
                    </Show>
                  </div>
                  <button
                    onClick={handleLogout}
                    class={`btn btn-ghost btn-sm flex w-full items-center gap-3 text-error hover:bg-error/10 ${
                      sidebarCollapsed() ? 'justify-center' : ''
                    }`}
                  >
                    <LogOut size={18} />
                    <Show when={!sidebarCollapsed()}>
                      <span class="font-medium">Logout</span>
                    </Show>
                  </button>
                  <Show when={!sidebarCollapsed() && version()}>
                    <div class="text-center text-xs opacity-85">{version()}</div>
                  </Show>
                </div>
              </div>
            </div>
          </div>

          {/* Mobile destinations. Ask is the centre action, not a route. */}
          <nav class="fixed inset-x-0 bottom-0 z-30 border-t border-base-300 bg-base-100/95 pb-[env(safe-area-inset-bottom)] backdrop-blur lg:hidden">
            <div class="grid grid-cols-5 items-end px-2 pb-1 pt-2">
              <For each={MOBILE_LEFT}>
                {(item) => (
                  <A
                    href={item.href}
                    end={item.href === '/'}
                    activeClass="text-primary"
                    inactiveClass="text-base-content/55"
                    class="flex flex-col items-center gap-1 rounded-xl py-1 text-[10px] font-semibold"
                  >
                    <item.icon size={20} />
                    <span>{item.label}</span>
                  </A>
                )}
              </For>
              <button
                class="flex flex-col items-center gap-1 text-[10px] font-semibold text-primary"
                onClick={() => openAsk('chat')}
                aria-label="Ask"
              >
                <span class="-mt-5 flex h-12 w-12 items-center justify-center rounded-2xl border-[3px] border-base-100 bg-gradient-to-br from-primary to-primary/80 text-primary-content shadow-lg shadow-primary/30">
                  <Bot size={22} />
                </span>
                <span>Ask</span>
              </button>
              <For each={MOBILE_RIGHT}>
                {(item) => (
                  <A
                    href={item.href}
                    activeClass="text-primary"
                    inactiveClass="text-base-content/55"
                    class="flex flex-col items-center gap-1 rounded-xl py-1 text-[10px] font-semibold"
                  >
                    <item.icon size={20} />
                    <span>{item.label}</span>
                  </A>
                )}
              </For>
            </div>
          </nav>

          <BotPanel />
          <AskHub />
          <SearchOverlay />
          </LocationProvider>
        </Show>

        {/*
          A route must not mount while the session is unknown: the pages assume a
          user and a location context. The retry is the only way out of this state.
        */}
        <Show when={!user() && sessionIssue() && !isAuthPage()}>
          <div class="flex h-screen items-center justify-center p-6">
            <div class="card w-full max-w-md bg-base-100 shadow-xl">
              <div class="card-body gap-3 text-center">
                <h2 class="card-title justify-center text-base">Not now</h2>
                <p class="text-sm opacity-75">{sessionIssue()}</p>
                <button
                  class="btn btn-primary"
                  onClick={() => {
                    setSessionIssue(null);
                    setLoading(true);
                    void fetchUser();
                  }}
                >
                  Try again
                </button>
              </div>
            </div>
          </div>
        </Show>

        <Show when={(!user() && !sessionIssue()) || isAuthPage()}>{props.children}</Show>
      </Show>

      <Show when={loading()}>
        <div class="flex h-screen items-center justify-center">
          <span class="loading loading-spinner loading-lg" />
        </div>
      </Show>
    </div>
  );
}

import { createSignal, onMount, JSX, Show } from 'solid-js';
import { useNavigate, useLocation, A } from '@solidjs/router';
import { LogOut, LayoutDashboard, ShoppingBasket, ShoppingBag, ChevronRight, ChevronLeft, Settings as SettingsIcon, ClipboardList } from 'lucide-solid';

export function App(props: { children?: JSX.Element }) {
  const [user, setUser] = createSignal<{ name: string; email: string } | null>(null);
  const [loading, setLoading] = createSignal(true);
  const [sidebarCollapsed, setSidebarCollapsed] = createSignal(false);
  const [version, setVersion] = createSignal('');
  const navigate = useNavigate();
  const location = useLocation();

  const fetchUser = async () => {
    try {
      const res = await fetch('/api/session');
      if (res.ok) {
        const data = await res.json();
        setUser(data as { name: string; email: string });
      } else {
        if (location.pathname !== '/login' && location.pathname !== '/register') {
          navigate('/login');
        }
      }
    } catch (e) {
      console.error('Session fetch failed', e);
      if (location.pathname !== '/login' && location.pathname !== '/register') {
        navigate('/login');
      }
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

  const handleLogout = async () => {
    await fetch('/api/logout', { method: 'POST' });
    setUser(null);
    navigate('/login');
  };

  const closeMobileDrawer = () => {
    const drawer = document.getElementById('mobile-drawer') as HTMLInputElement;
    if (drawer) drawer.checked = false;
  };

  const isAuthPage = () => ['/login', '/register'].includes(location.pathname);

  return (
    <div class="min-h-screen bg-base-200">
      <Show when={!loading()}>
        <Show when={user() && !isAuthPage()}>
          {/* drawer lg:drawer-open: on desktop the sidebar is always open; on mobile it slides in */}
          <div class={`drawer lg:drawer-open ${sidebarCollapsed() ? 'lg:drawer-collapsed' : ''}`}>
            <input id="mobile-drawer" type="checkbox" class="drawer-toggle" />

            {/* Main content */}
            <div class="drawer-content flex flex-col h-screen overflow-hidden bg-base-200">
              {/* Mobile header */}
              <div class="lg:hidden navbar bg-base-100 shadow-md border-b border-base-300 shrink-0">
                <div class="flex-none">
                  <label for="mobile-drawer" class="btn btn-square btn-ghost">
                    <svg xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" class="inline-block w-5 h-5 stroke-current">
                      <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M4 6h16M4 12h16M4 18h16" />
                    </svg>
                  </label>
                </div>
                <div class="flex-1 px-2">
                  <span class="text-lg font-bold whitespace-nowrap">Groceries Tracking</span>
                </div>
              </div>

              {/* Desktop header spacer (aligns with sidebar header height) */}
              <div class="h-20 shrink-0 hidden lg:block" />

              {/* Scrollable page content */}
              <main class="flex-1 overflow-y-auto p-4 lg:p-10">
                <div class="max-w-6xl mx-auto">
                  {props.children}
                </div>
              </main>
            </div>

            {/* Sidebar (drawer-side) — always open on desktop, slide-in on mobile */}
            <div class="drawer-side z-30">
              <label for="mobile-drawer" aria-label="close sidebar" class="drawer-overlay" />
              <div
                class={`bg-base-100 text-base-content flex flex-col h-full transition-all duration-300 ease-in-out shadow-xl
                  ${sidebarCollapsed() ? 'w-20' : 'w-72'}`}
              >
                {/* Sidebar header */}
                <div class="flex items-center justify-between px-6 py-4 border-b border-base-300 h-20 shrink-0">
                  <Show when={!sidebarCollapsed()}>
                    <span class="text-xl font-bold tracking-tight whitespace-nowrap overflow-hidden">Groceries Tracking</span>
                  </Show>
                  <button
                    onClick={() => setSidebarCollapsed(!sidebarCollapsed())}
                    class="btn btn-ghost btn-sm btn-square hidden lg:flex"
                  >
                    <Show when={sidebarCollapsed()} fallback={<ChevronLeft size={20} />}>
                      <ChevronRight size={20} />
                    </Show>
                  </button>
                </div>

                {/* Nav items */}
                <div class="flex-grow overflow-y-auto py-4">
                  <ul class="menu p-0 px-2 space-y-1">
                    <li>
                      <A href="/" activeClass="active" end onClick={closeMobileDrawer}
                        class={`flex items-center gap-4 py-3 ${sidebarCollapsed() ? 'justify-center' : ''}`}>
                        <LayoutDashboard size={20} />
                        <Show when={!sidebarCollapsed()}><span class="font-medium">Dashboard</span></Show>
                      </A>
                    </li>
                    <li>
                      <A href="/orders" activeClass="active" onClick={closeMobileDrawer}
                        class={`flex items-center gap-4 py-3 ${sidebarCollapsed() ? 'justify-center' : ''}`}>
                        <ShoppingBag size={20} />
                        <Show when={!sidebarCollapsed()}><span class="font-medium">Orders</span></Show>
                      </A>
                    </li>
                    <li>
                      <A href="/products" activeClass="active" onClick={closeMobileDrawer}
                        class={`flex items-center gap-4 py-3 ${sidebarCollapsed() ? 'justify-center' : ''}`}>
                        <ShoppingBasket size={20} />
                        <Show when={!sidebarCollapsed()}><span class="font-medium">Products</span></Show>
                      </A>
                    </li>
                    <li>
                      <A href="/inventory" activeClass="active" onClick={closeMobileDrawer}
                        class={`flex items-center gap-4 py-3 ${sidebarCollapsed() ? 'justify-center' : ''}`}>
                        <ClipboardList size={20} />
                        <Show when={!sidebarCollapsed()}><span class="font-medium">Inventory</span></Show>
                      </A>
                    </li>
                    <li>
                      <A href="/settings" activeClass="active" onClick={closeMobileDrawer}
                        class={`flex items-center gap-4 py-3 ${sidebarCollapsed() ? 'justify-center' : ''}`}>
                        <SettingsIcon size={20} />
                        <Show when={!sidebarCollapsed()}><span class="font-medium">Settings</span></Show>
                      </A>
                    </li>
                  </ul>
                </div>

                {/* User info + logout */}
                <div class="mt-auto border-t border-base-300 bg-base-100/50 p-4 space-y-3">
                  <div class={`flex items-center gap-3 p-2 rounded-xl bg-base-200/50 ${sidebarCollapsed() ? 'justify-center' : ''}`}>
                    <div class="avatar placeholder flex-shrink-0">
                      <div class="bg-primary text-primary-content rounded-full w-10 shadow-sm ring-2 ring-primary/10 flex items-center justify-center">
                        <span class="text-xl leading-none">🥨</span>
                      </div>
                    </div>
                    <Show when={!sidebarCollapsed()}>
                      <div class="flex-grow min-w-0">
                        <div class="font-bold text-sm truncate">{user()?.name}</div>
                        <div class="text-[10px] opacity-60 truncate">{user()?.email}</div>
                      </div>
                    </Show>
                  </div>
                  <button
                    onClick={handleLogout}
                    class={`btn btn-ghost btn-sm text-error w-full flex items-center gap-4 hover:bg-error/10 ${sidebarCollapsed() ? 'justify-center' : ''}`}
                  >
                    <LogOut size={18} />
                    <Show when={!sidebarCollapsed()}>
                      <span class="font-semibold">Logout</span>
                    </Show>
                  </button>
                  <Show when={!sidebarCollapsed() && version()}>
                    <div class="text-xs opacity-30 text-center">v{version()}</div>
                  </Show>
                </div>
              </div>
            </div>
          </div>
        </Show>

        <Show when={!user() || isAuthPage()}>
          {props.children}
        </Show>
      </Show>

      <Show when={loading()}>
        <div class="flex items-center justify-center h-screen">
          <span class="loading loading-spinner loading-lg" />
        </div>
      </Show>
    </div>
  );
}

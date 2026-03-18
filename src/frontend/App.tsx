import { createSignal, createEffect, onMount, JSX, Show } from 'solid-js';
import { useNavigate, useLocation, A } from '@solidjs/router';
import { LogOut, LayoutDashboard, ShoppingBasket, ShoppingBag, ChevronRight, ChevronLeft, Settings as SettingsIcon } from 'lucide-solid';

export function App(props: { children?: JSX.Element }) {
  const [user, setUser] = createSignal<any>(null);
  const [loading, setLoading] = createSignal(true);
  const [sidebarCollapsed, setSidebarCollapsed] = createSignal(false);
  const navigate = useNavigate();
  const location = useLocation();

  const fetchUser = async () => {
    try {
      const res = await fetch('/api/session');
      if (res.ok) {
        const data = await res.json();
        setUser(data);
      } else {
        if (location.pathname !== '/login' && location.pathname !== '/register') {
          navigate('/login');
        }
      }
    } catch (e) {
      console.error('Session fetch failed', e);
    } finally {
      setLoading(false);
    }
  };

  onMount(fetchUser);

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
          <div class="flex h-screen overflow-hidden">
            {/* Sidebar */}
            <div 
              class={`bg-base-100 text-base-content flex flex-col transition-all duration-300 ease-in-out z-20 shadow-xl
                ${sidebarCollapsed() ? 'w-20' : 'w-72'} 
                hidden lg:flex`}
            >
              <div class="flex items-center justify-between px-6 py-4 border-b border-base-300 h-20 shrink-0">
                <Show when={!sidebarCollapsed()}>
                  <span class="text-xl font-bold tracking-tight whitespace-nowrap overflow-hidden">Groceries Tracking</span>
                </Show>
                <button 
                  onClick={() => setSidebarCollapsed(!sidebarCollapsed())}
                  class="btn btn-ghost btn-sm btn-square"
                >
                  <Show when={sidebarCollapsed()} fallback={<ChevronLeft size={20} />}>
                    <ChevronRight size={20} />
                  </Show>
                </button>
              </div>

              <div class="flex-grow overflow-y-auto py-4">
                <ul class="menu p-0 px-2 space-y-1">
                  <li>
                    <A href="/" activeClass="active" end class={`flex items-center gap-4 py-3 ${sidebarCollapsed() ? 'justify-center' : ''}`}>
                      <LayoutDashboard size={20} />
                      <Show when={!sidebarCollapsed()}>
                        <span class="font-medium">Dashboard</span>
                      </Show>
                    </A>
                  </li>
                  <li>
                    <A href="/orders" activeClass="active" class={`flex items-center gap-4 py-3 ${sidebarCollapsed() ? 'justify-center' : ''}`}>
                      <ShoppingBag size={20} />
                      <Show when={!sidebarCollapsed()}>
                        <span class="font-medium">Orders</span>
                      </Show>
                    </A>
                  </li>
                  <li>
                    <A href="/products" activeClass="active" class={`flex items-center gap-4 py-3 ${sidebarCollapsed() ? 'justify-center' : ''}`}>
                      <ShoppingBasket size={20} />
                      <Show when={!sidebarCollapsed()}>
                        <span class="font-medium">Products</span>
                      </Show>
                    </A>
                  </li>
                  <li>
                    <A href="/settings" activeClass="active" class={`flex items-center gap-4 py-3 ${sidebarCollapsed() ? 'justify-center' : ''}`}>
                      <SettingsIcon size={20} />
                      <Show when={!sidebarCollapsed()}>
                        <span class="font-medium">Settings</span>
                      </Show>
                    </A>
                  </li>
                </ul>
              </div>

              <div class="mt-auto border-t border-base-300 bg-base-100/50 p-4 space-y-3">
                <div class={`flex items-center gap-3 p-2 rounded-xl bg-base-200/50 ${sidebarCollapsed() ? 'justify-center' : ''}`}>
                  <div class="avatar placeholder flex-shrink-0">
                    <div class="bg-primary text-primary-content rounded-full w-10 shadow-sm ring-2 ring-primary/10">
                      <span class="text-sm font-bold">{user()?.name?.[0]?.toUpperCase()}</span>
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
              </div>
            </div>

            {/* Main Content Area */}
            <div class="flex-grow flex flex-col min-w-0 overflow-hidden bg-base-200">
              {/* Header spacer to align with sidebar header */}
              <div class="h-20 shrink-0 hidden lg:block"></div>

              {/* Mobile Header */}
              <div class="lg:hidden navbar bg-base-100 shadow-md border-b border-base-300 h-20 shrink-0">
                <div class="flex-none">
                  <label for="mobile-drawer" class="btn btn-square btn-ghost">
                    <svg xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" class="inline-block w-5 h-5 stroke-current"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="4 6h16M4 12h16M4 18h16"></path></svg>
                  </label>
                </div>
                <div class="flex-1 px-4">
                  <a class="text-xl font-bold">Groceries Tracking</a>
                </div>
              </div>

              {/* Scrollable Content */}
              <main class="flex-1 overflow-y-auto p-6 lg:p-10">
                <div class="max-w-6xl mx-auto">
                  {props.children}
                </div>
              </main>
            </div>

            {/* Mobile Drawer (Overlay) */}
            <div class="drawer lg:hidden">
              <input id="mobile-drawer" type="checkbox" class="drawer-toggle" />
              <div class="drawer-side z-30">
                <label for="mobile-drawer" aria-label="close sidebar" class="drawer-overlay"></label>
                <ul class="menu p-4 w-80 min-h-full bg-base-100 text-base-content flex flex-col">
                  <li class="text-xl font-bold p-4 mb-4 border-b border-base-300">Groceries Tracking</li>
                  <li><A href="/" onClick={() => (document.getElementById('mobile-drawer') as HTMLInputElement).checked = false} activeClass="active" end><LayoutDashboard size={20} /> Dashboard</A></li>
                  <li><A href="/orders" onClick={() => (document.getElementById('mobile-drawer') as HTMLInputElement).checked = false} activeClass="active"><ShoppingBag size={20} /> Orders</A></li>
                  <li><A href="/products" onClick={() => (document.getElementById('mobile-drawer') as HTMLInputElement).checked = false} activeClass="active"><ShoppingBasket size={20} /> Products</A></li>
                  <li><A href="/settings" onClick={() => (document.getElementById('mobile-drawer') as HTMLInputElement).checked = false} activeClass="active"><SettingsIcon size={20} /> Settings</A></li>
                  <div class="flex-grow"></div>
                  <li class="mt-auto border-t pt-4">
                    <div class="flex items-center gap-3 p-4">
                      <div class="avatar placeholder">
                        <div class="bg-neutral text-neutral-content rounded-full w-8"><span>{user()?.name?.[0]?.toUpperCase()}</span></div>
                      </div>
                      <div>
                        <div class="font-bold">{user()?.name}</div>
                        <div class="text-xs opacity-50">{user()?.email}</div>
                      </div>
                    </div>
                    <button onClick={handleLogout} class="text-error"><LogOut size={20} /> Logout</button>
                  </li>
                </ul>
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
          <span class="loading loading-spinner loading-lg"></span>
        </div>
      </Show>
    </div>
  );
}

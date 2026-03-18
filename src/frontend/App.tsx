import { createSignal, createEffect, onMount, JSX, Show } from 'solid-js';
import { useNavigate, useLocation, A } from '@solidjs/router';
import { LogOut, LayoutDashboard, ShoppingBasket, Import as ImportIcon } from 'lucide-solid';

export function App(props: { children?: JSX.Element }) {
  const [user, setUser] = createSignal<any>(null);
  const [loading, setLoading] = createSignal(true);
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
          <div class="drawer lg:drawer-open">
            <input id="my-drawer-2" type="checkbox" class="drawer-toggle" />
            <div class="drawer-content flex flex-col p-4 lg:p-8">
              {/* Page content here */}
              <label for="my-drawer-2" class="btn btn-primary drawer-button lg:hidden mb-4">Open Sidebar</label>
              {props.children}
            </div>
            <div class="drawer-side">
              <label for="my-drawer-2" aria-label="close sidebar" class="drawer-overlay"></label>
              <ul class="menu p-4 w-80 min-h-full bg-base-100 text-base-content flex flex-col">
                {/* Sidebar content here */}
                <li class="text-xl font-bold p-4 mb-4">Groceries Tracking</li>
                <li>
                  <A href="/" activeClass="active" end>
                    <LayoutDashboard size={20} /> Dashboard
                  </A>
                </li>
                <li>
                  <A href="/products" activeClass="active">
                    <ShoppingBasket size={20} /> Products
                  </A>
                </li>
                <li>
                  <A href="/import" activeClass="active">
                    <ImportIcon size={20} /> Import Orders
                  </A>
                </li>
                
                <div class="flex-grow"></div>
                
                <li class="mt-auto border-t pt-4">
                  <div class="flex items-center gap-3 p-4">
                    <div class="avatar placeholder">
                      <div class="bg-neutral text-neutral-content rounded-full w-8">
                        <span>{user()?.name?.[0]?.toUpperCase()}</span>
                      </div>
                    </div>
                    <div class="flex-grow overflow-hidden">
                      <div class="font-bold truncate">{user()?.name}</div>
                      <div class="text-xs opacity-50 truncate">{user()?.email}</div>
                    </div>
                  </div>
                  <button onClick={handleLogout} class="text-error">
                    <LogOut size={20} /> Logout
                  </button>
                </li>
              </ul>
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

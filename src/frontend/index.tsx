/* @refresh reload */
import { render } from 'solid-js/web';
import { Navigate, Router, Route } from '@solidjs/router';
import { App } from './App';
import { patchFetch } from './lib/api';
import { Login } from './pages/Login';
import { Register } from './pages/Register';
import { Overview } from './pages/Overview';
import { Groceries } from './pages/Groceries';
import { Activity } from './pages/Activity';
import { Settings } from './pages/Settings';
import { AskEntry } from './pages/AskEntry';
import { ListsEntry } from './pages/ListsEntry';
import './index.css';

patchFetch();

const root = document.getElementById('root');

if (import.meta.env.DEV && !(root instanceof HTMLElement)) {
  throw new Error(
    'Root element not found. Did you forget to add it to your index.html? Or maybe the id attribute is misspelled?',
  );
}

/**
 * Old URLs are bookmarks and bot links, so they redirect instead of 404ing.
 * The destinations they collapse into are the five tabs from Phase 4.
 */
const redirectTo = (path: string) => () => <Navigate href={path} />;

render(
  () => (
    <Router root={App}>
      <Route path="/" component={Overview} />
      <Route path="/groceries" component={Groceries} />
      <Route path="/activity" component={Activity} />
      <Route path="/settings" component={Settings} />
      <Route path="/bot" component={AskEntry} />
      <Route path="/lists" component={ListsEntry} />

      <Route path="/products" component={redirectTo('/groceries')} />
      <Route path="/products/:productId" component={redirectTo('/groceries')} />
      <Route path="/inventory" component={redirectTo('/groceries')} />

      <Route path="/orders" component={redirectTo('/activity')} />
      <Route path="/orders/:orderId" component={redirectTo('/activity')} />
      <Route path="/orders/:orderId/products/:productId" component={redirectTo('/groceries')} />
      <Route path="/in-store" component={redirectTo('/activity')} />
      <Route path="/order/:orderId" component={redirectTo('/activity')} />

      <Route path="/login" component={Login} />
      <Route path="/register" component={Register} />
    </Router>
  ),
  root!,
);

import { createSignal, Show } from 'solid-js';
import { Products } from './Products';
import { Inventory } from './Inventory';

/**
 * Groceries is where Products and Inventory collapse into one destination.
 *
 * Placeholder for Phase 4: the page pass builds the real merged body. Keeping
 * both old pages behind a local switch means the frame can ship without hiding
 * anything the user had before.
 */
export function Groceries() {
  const [pane, setPane] = createSignal<'products' | 'inventory'>('products');

  return (
    <div class="space-y-6">
      <div class="tabs tabs-box w-fit rounded-2xl border border-base-300 bg-base-100 p-1 shadow-sm">
        <button
          class={`btn btn-sm border-none rounded-xl px-5 ${
            pane() === 'products' ? 'btn-primary shadow-md' : 'btn-ghost opacity-85'
          }`}
          onClick={() => setPane('products')}
        >
          Products
        </button>
        <button
          class={`btn btn-sm border-none rounded-xl px-5 ${
            pane() === 'inventory' ? 'btn-primary shadow-md' : 'btn-ghost opacity-85'
          }`}
          onClick={() => setPane('inventory')}
        >
          Inventory
        </button>
      </div>

      <Show when={pane() === 'products'}>
        <Products />
      </Show>
      <Show when={pane() === 'inventory'}>
        <Inventory />
      </Show>
    </div>
  );
}

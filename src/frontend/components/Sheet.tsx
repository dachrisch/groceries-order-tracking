/**
 * The one sheet primitive: a bottom sheet on a phone, a centred panel on a
 * desktop. Ask, search and the location card all use it so they share the same
 * backdrop, close affordance and escape behaviour.
 */
import { onCleanup, onMount, Show, type JSX } from 'solid-js';
import { X } from 'lucide-solid';

interface SheetProps {
  open: boolean;
  onClose: () => void;
  title: string;
  subtitle?: string;
  /** `lg` is for the Ask hub, whose panes need room for cards. */
  width?: 'md' | 'lg';
  /** Lets a pane own its scrolling instead of the sheet body. */
  bodyClass?: string;
  /**
   * Keep the body mounted while closed. Chat uses this so closing the hub does
   * not throw the conversation away; every other sheet would only pay for DOM.
   */
  keepMounted?: boolean;
  children: JSX.Element;
}

export function Sheet(props: SheetProps) {
  onMount(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape' && props.open) props.onClose();
    };
    window.addEventListener('keydown', onKeyDown);
    onCleanup(() => window.removeEventListener('keydown', onKeyDown));
  });

  return (
    <>
      <Show when={props.open}>
        <div class="fixed inset-0 z-40 bg-black/30 backdrop-blur-[1px]" onClick={props.onClose} />
      </Show>
      <Show when={props.open || props.keepMounted}>
        <section
          role="dialog"
          aria-modal="true"
          aria-label={props.title}
          class={`${props.open ? 'flex' : 'hidden'} fixed inset-x-0 bottom-0 z-50 max-h-[90vh] flex-col rounded-t-2xl border border-base-300 bg-base-100 shadow-2xl
            md:inset-x-auto md:bottom-auto md:left-1/2 md:top-1/2 md:max-h-[85vh] md:-translate-x-1/2 md:-translate-y-1/2 md:rounded-2xl
            ${props.width === 'lg' ? 'md:w-[46rem]' : 'md:w-[34rem]'}`}
        >
          <div class="mx-auto mt-2 h-1.5 w-10 shrink-0 rounded-full bg-base-300 md:hidden" />
          <header class="flex shrink-0 items-start gap-3 border-b border-base-300 px-4 py-3">
            <div class="min-w-0 flex-1">
              <h2 class="truncate text-lg font-bold leading-tight">{props.title}</h2>
              <Show when={props.subtitle}>
                <p class="mt-0.5 text-xs text-base-content/70">{props.subtitle}</p>
              </Show>
            </div>
            <button class="btn btn-ghost btn-sm btn-square" onClick={props.onClose} aria-label="Close">
              <X size={18} />
            </button>
          </header>
          <div class={props.bodyClass ?? 'min-h-0 flex-1 overflow-y-auto p-4'}>{props.children}</div>
        </section>
      </Show>
    </>
  );
}

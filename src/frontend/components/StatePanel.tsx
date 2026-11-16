/**
 * One deliberate state, one action.
 *
 * The merge left a lot of paths that could be empty at once (no account, no
 * delivery here, nothing due, a stale phone), and each page used to improvise
 * its own fallback. This is the one shape for all of them, so the copy stays
 * consistent and a state cannot be mistaken for a broken page.
 *
 * Two layouts: the card is a whole screen-sized answer; `compact` is a banner
 * for a page that still has content (a list with no deliveries, a timeline with
 * a stale capture). Both take at most one action.
 *
 * The rule the component enforces: an action that cannot run carries its
 * reason. A greyed button with no explanation reads as a bug, so a disabled
 * action always renders `disabledReason` underneath it.
 */
import { Match, Show, Switch, type JSX } from 'solid-js';
import { A } from '@solidjs/router';
import { AlertCircle, CheckCircle2, Info, TriangleAlert } from 'lucide-solid';

export type StateTone = 'neutral' | 'info' | 'success' | 'warning' | 'error';

export interface StateAction {
  label: string;
  /** A route (`/settings`) or an in-page anchor (`#home-city`). */
  href?: string;
  onClick?: () => void;
  /** The action is running; the label stays visible next to the spinner. */
  busy?: boolean;
  /** Why this action cannot run right now. Renders the button disabled plus the reason. */
  disabledReason?: string;
}

export interface StatePanelProps {
  title: string;
  body?: JSX.Element;
  /** Small print: what happens after the action, or why there is none. */
  hint?: string;
  action?: StateAction;
  tone?: StateTone;
  compact?: boolean;
  /** Overrides the tone's default icon. */
  icon?: JSX.Element;
}

const TONE: Record<StateTone, { box: string; icon: string }> = {
  neutral: { box: 'border-base-300 bg-base-100', icon: 'text-base-content/45' },
  info: { box: 'border-info/30 bg-info/5', icon: 'text-info' },
  success: { box: 'border-success/30 bg-success/5', icon: 'text-success' },
  warning: { box: 'border-warning/35 bg-warning/5', icon: 'text-warning' },
  error: { box: 'border-error/35 bg-error/5', icon: 'text-error' },
};

function DefaultIcon(props: { tone: StateTone }) {
  return (
    <Switch fallback={<Info size={18} />}>
      <Match when={props.tone === 'success'}>
        <CheckCircle2 size={18} />
      </Match>
      <Match when={props.tone === 'warning'}>
        <TriangleAlert size={18} />
      </Match>
      <Match when={props.tone === 'error'}>
        <AlertCircle size={18} />
      </Match>
    </Switch>
  );
}

export function StatePanel(props: StatePanelProps) {
  const tone = () => props.tone ?? 'neutral';
  const colors = () => TONE[tone()];

  const link = () => {
    const action = props.action;
    if (!action?.href) return null;
    // Anchors are plain links; routes go through the router so the shell survives.
    return action.href.startsWith('#') ? (
      <a href={action.href} class="btn btn-primary btn-sm rounded-xl">
        {action.label}
      </a>
    ) : (
      <A href={action.href} class="btn btn-primary btn-sm rounded-xl">
        {action.label}
      </A>
    );
  };

  return (
    <div
      class={`rounded-2xl border shadow-sm ${colors().box} ${
        props.compact ? 'p-3' : 'p-6 sm:p-8'
      }`}
    >
      <div class={props.compact ? 'flex items-start gap-3' : 'flex flex-col items-center text-center'}>
        <div class={`shrink-0 ${colors().icon} ${props.compact ? 'mt-0.5' : ''}`}>
          {props.icon ?? <DefaultIcon tone={tone()} />}
        </div>
        <div class={props.compact ? 'min-w-0 flex-1' : 'mt-2'}>
          <h2 class={props.compact ? 'text-sm font-bold' : 'text-lg font-bold'}>{props.title}</h2>
          <Show when={props.body}>
            <div
              class={`mt-1 text-sm text-base-content/70 ${
                props.compact ? 'text-xs leading-snug' : 'max-w-md'
              }`}
            >
              {props.body}
            </div>
          </Show>
          <Show when={props.hint}>
            <p class="mt-1.5 text-[11px] text-base-content/50">{props.hint}</p>
          </Show>
        </div>

        <Show when={props.action}>
          {(action) => (
            <div class={props.compact ? 'shrink-0' : 'mt-4 flex flex-col items-center'}>
              <Show
                when={!action().disabledReason}
                fallback={
                  <>
                    <button type="button" class="btn btn-primary btn-sm rounded-xl" disabled>
                      {action().label}
                    </button>
                    <p class="mt-1 max-w-[15rem] text-[11px] leading-tight text-base-content/55">
                      {action().disabledReason}
                    </p>
                  </>
                }
              >
                <Show
                  when={action().href}
                  fallback={
                    <button
                      type="button"
                      class="btn btn-primary btn-sm gap-2 rounded-xl"
                      onClick={() => action().onClick?.()}
                      disabled={action().busy}
                    >
                      <Show when={action().busy}>
                        <span class="loading loading-spinner loading-xs" />
                      </Show>
                      {action().label}
                    </button>
                  }
                >
                  {link()}
                </Show>
              </Show>
            </div>
          )}
        </Show>
      </div>
    </div>
  );
}

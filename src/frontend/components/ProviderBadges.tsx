/**
 * The two source badges, in one place so a K/E chip cannot drift between the
 * overview, the product list and the activity stream. The letter is the badge:
 * three surfaces of coloured chips read faster than three store names.
 */
import { For } from 'solid-js';
import { providerLabel, type Provider } from '../lib/location';

const TONE: Record<Provider, string> = {
  knuspr: 'badge-primary',
  edeka: 'badge-secondary',
};

export function ProviderChip(props: { provider: Provider; className?: string }) {
  return (
    <span
      class={`badge badge-sm font-bold ${TONE[props.provider]} ${props.className ?? ''}`}
      title={providerLabel(props.provider)}
    >
      {props.provider === 'knuspr' ? 'K' : 'E'}
    </span>
  );
}

export function ProviderBadges(props: { providers: Provider[] }) {
  return (
    <>
      <For each={props.providers}>
        {(provider) => <ProviderChip provider={provider} />}
      </For>
    </>
  );
}

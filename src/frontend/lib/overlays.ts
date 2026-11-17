/**
 * Overlay state that outlives a single page.
 *
 * The Ask hub, the search sheet, the shopping-list flow and the location sheet
 * are mounted once by the shell, but anything can open them: the mobile centre
 * tab, the desktop sidebar, the floating chat button and old routes such as
 * `/bot` and `/lists`. Module-level signals keep that one source of truth
 * without threading callbacks through every page.
 */
import { createSignal } from 'solid-js';

export type AskTab = 'chat' | 'occasions' | 'groups';

export const [askHubOpen, setAskHubOpen] = createSignal(false);
export const [askTab, setAskTab] = createSignal<AskTab>('chat');
export const [searchOpen, setSearchOpen] = createSignal(false);

/**
 * The EDEKA shopping list is an action, not a destination, so Activity,
 * Groceries and the `/lists` bookmark all open this one sheet.
 */
export const [listFlowOpen, setListFlowOpen] = createSignal(false);

export function openAsk(tab: AskTab = 'chat') {
  setAskTab(tab);
  setAskHubOpen(true);
}

export function closeAsk() {
  setAskHubOpen(false);
}

export function openSearch() {
  setSearchOpen(true);
}

export function closeSearch() {
  setSearchOpen(false);
}

export function openListFlow() {
  setListFlowOpen(true);
}

export function closeListFlow() {
  setListFlowOpen(false);
}

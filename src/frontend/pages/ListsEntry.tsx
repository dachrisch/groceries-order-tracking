import { onMount } from 'solid-js';
import { useNavigate } from '@solidjs/router';
import { openListFlow } from '../lib/overlays';

/**
 * `/lists` is a bookmark and a bot-link target, not a destination any more.
 *
 * Opening the flow and replacing the history entry keeps the old URL working
 * without leaving a dead route in the shell: the sheet sits over Activity,
 * where the list action lives.
 */
export function ListsEntry() {
  const navigate = useNavigate();

  onMount(() => {
    openListFlow();
    navigate('/activity', { replace: true });
  });

  return null;
}

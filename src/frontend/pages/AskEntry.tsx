import { onMount } from 'solid-js';
import { useNavigate } from '@solidjs/router';
import { openAsk } from '../lib/overlays';

/**
 * `/bot` is a bookmark and a bot-link target, not a destination any more.
 *
 * Opening the hub and replacing the history entry keeps the old URL working
 * without leaving a dead route in the shell.
 */
export function AskEntry() {
  const navigate = useNavigate();

  onMount(() => {
    openAsk('chat');
    navigate('/', { replace: true });
  });

  return null;
}

/**
 * The Session popover's entry point.
 *
 * A separate Vite entry rather than a route inside Studio: this window must
 * not carry the audio engine. Only Studio holds the graph, and the main
 * process enforces that — a popover that imported the engine would build a
 * second AudioContext that could never be used.
 */

import { mount } from 'svelte';
import Popover from './Popover.svelte';
import { theme } from '../lib/theme.svelte.ts';
import '@fontsource-variable/inter';
import '../app.css';
import './popover.css';

const target = document.getElementById('app');
if (!target) throw new Error('#app not found');

// The popover follows the same preference as Studio. It reads the same store,
// so a change made in Studio's Settings reaches this window through the main
// process without either window knowing about the other.
theme.start();

export default mount(Popover, { target });

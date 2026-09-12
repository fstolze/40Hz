import { mount } from 'svelte';
import App from './App.svelte';
import { theme } from './lib/theme.svelte.ts';
// Bundled and self-hosted; see the font stack note in app.css.
import '@fontsource-variable/inter';
import './app.css';

const target = document.getElementById('app');
if (!target) throw new Error('#app not found');

// Before the app mounts, so the first frame is already in the right theme.
// Never stopped: this window lives as long as the process does, and the
// document element it writes to outlives every component in it.
theme.start();

export default mount(App, { target });

import { vitePreprocess } from '@sveltejs/vite-plugin-svelte';

export default {
  // Lets <script lang="ts"> in components go through Vite's TS transform.
  preprocess: vitePreprocess(),
};

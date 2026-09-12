/**
 * Which workspace is showing.
 *
 * Ephemeral renderer state, deliberately. It is not persisted, not a route,
 * and not a second window: Studio owns the audio graph, and a destination
 * that could create or destroy a renderer would be a destination that could
 * take the audio with it. Changing this swaps what `main` renders and nothing
 * else — no engine call, no store read, no session effect.
 */
export type View = 'studio' | 'history';

// Optimization-only state at $HERDR_PLUGIN_STATE_DIR/map.json.
//
// IMPORTANT: correctness never depends on this file. The session→workspace mapping
// is always reconstructable from cmux itself (the herdr key is embedded in each
// mirror workspace's description marker). map.json just caches last-seen status so
// we can skip no-op `set-status` calls, and holds the user-closed suppress-list.
// If it is deleted, the next reconcile issues a few redundant (idempotent) writes.

import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { join, dirname } from 'node:path';

function statePath(env = process.env) {
  const dir = env.HERDR_PLUGIN_STATE_DIR || join(env.HOME || '.', '.herdr-plugin-cmux');
  return join(dir, 'map.json');
}

export function loadState(env = process.env) {
  try {
    const d = JSON.parse(readFileSync(statePath(env), 'utf8'));
    return { byKey: d.byKey || {}, suppress: new Set(d.suppress || []) };
  } catch {
    return { byKey: {}, suppress: new Set() };
  }
}

export function saveState(state, env = process.env) {
  const p = statePath(env);
  try {
    mkdirSync(dirname(p), { recursive: true });
    writeFileSync(
      p,
      JSON.stringify({ byKey: state.byKey || {}, suppress: [...(state.suppress || [])] }, null, 2),
    );
  } catch {
    /* optimization only — ignore write failures */
  }
}

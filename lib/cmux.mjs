// cmux write layer.
//
// Talks to the cmux control socket via the `cmux` CLI. Requires cmux running with
// automation.socketControlMode = "automation" (admits same-user local processes,
// no password) or "password" (see README / `doctor`); this plugin runs under the
// herdr daemon, not under cmux, so the default "cmuxOnly" ancestry gate rejects it.
//
// Command shapes below are VERIFIED live against cmux 0.64.17 (M1):
//   - JSON output is a single whole-document (array or object), NOT NDJSON.
//   - `cmux workspace list --json --id-format both` → workspaces with {id,ref,title,...}.
//   - `cmux new-workspace ...` prints "OK workspace:N" (no --json); that IS the stable
//     short ref — resolve it to the UUID via the list.
//   - `cmux set-status <key> <text> --icon --color --priority --workspace <uuid>` updates in place.
//   - `cmux close-workspace --workspace <uuid>` / `cmux clear-status <key> --workspace <uuid>`.

import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

// Row identity lives in workspace ENV VARS (invisible to the user): HPCX_KEY is
// the full herdr session key, HPCX_TERM the terminal an attach row was seeded
// against. `cmux workspace env <ws> --json` reads them back, so the session →
// workspace mapping stays reconstructable from cmux alone; the state file is a
// cache that keeps the common path at one `workspace list` call per pass.
// Descriptions are not used at all (by request — they only ever showed plumbing).
//
// The legacy regexes recognize rows from older versions that carried the identity
// in the description; those are adopted and replaced (reseed) on the next pass.
const LEGACY_HASH_RE = /hpcx:([0-9a-f]{12})(?:\+([\w.-]+))?/;
const LEGACY_KEY_RE = /\[hpcx:key=([^\]]+)\]/;
export const keyHash = (key) => createHash('sha256').update(String(key)).digest('hex').slice(0, 12);

// Shell-escape for single-quoted interpolation into a `--command` string.
const sq = (s) => `'${String(s).replace(/'/g, "'\\''")}'`;

/**
 * The pane content command for an attach-mode mirror workspace: resolve the
 * agent's CURRENT terminal id at spawn time (bin/attach.mjs), then exec the live
 * attach. If the agent is gone, show a short notice instead of a dead exec.
 */
export function attachRowCommand(key) {
  const resolver = join(dirname(fileURLToPath(import.meta.url)), '..', 'bin', 'attach.mjs');
  return (
    `clear; t=$(node ${sq(resolver)} ${sq(key)}); ` +
    `if [ -n "$t" ]; then exec herdr agent attach "$t"; fi; ` +
    `printf '%s\n' ${sq(`herdr agent for this row is gone (${key})`)}; exec cat`
  );
}

/**
 * The pane content for a focus-mode mirror workspace: print the agent's identity
 * and a hint, then park on `cat` (near-zero footprint — no login shell, no node).
 */
export function thinRowCommand(key, label) {
  return (
    `clear; printf '%s\n' ${sq(`herdr agent · ${label}`)} ${sq(`key: ${key}`)} '' ` +
    `'Selecting this row focuses the agent back in herdr.'; exec cat`
  );
}

export function cmux(args, cfg = {}) {
  const env = { ...process.env, CMUX_QUIET: '1' };
  if (cfg.password) env.CMUX_SOCKET_PASSWORD = cfg.password;
  const r = spawnSync('cmux', args, { encoding: 'utf8', env });
  const stderr = (r.stderr || '').trim();
  const denied = /Access denied|Broken pipe|only processes started inside cmux|no socket password/i.test(stderr);
  return { ok: r.status === 0, status: r.status, stdout: (r.stdout || '').trim(), stderr, denied };
}

// Parse a whole-document JSON payload into an array of records, tolerating the
// several shapes cmux returns (bare array, {result:[...]}, {workspaces:[...]},
// or a single object).
function toArray(stdout) {
  let d;
  try { d = JSON.parse(stdout); } catch { return []; }
  if (Array.isArray(d)) return d;
  if (d && Array.isArray(d.result)) return d.result;
  if (d && Array.isArray(d.workspaces)) return d.workspaces;
  if (d && d.result && Array.isArray(d.result.workspaces)) return d.result.workspaces;
  if (d && typeof d === 'object' && d.id) return [d];
  return [];
}

export function ping(cfg) {
  return cmux(['ping'], cfg);
}

export function listWindows(cfg) {
  const r = cmux(['list-windows', '--json', '--id-format', 'uuids'], cfg);
  return r.ok ? toArray(r.stdout) : [];
}

function listWorkspaces(cfg) {
  const r = cmux(['workspace', 'list', '--json', '--id-format', 'both'], cfg);
  if (!r.ok) return null; // socket unreachable → caller HOLDs
  return toArray(r.stdout);
}

/** uuid for a short ref ("workspace:N") as printed by `new-workspace`, or null. */
function uuidByRef(cfg, ref) {
  const list = listWorkspaces(cfg);
  if (!list || !ref) return null;
  const hit = list.find((w) => w.ref === ref);
  return hit ? hit.id : null;
}

/** { HPCX_KEY, HPCX_TERM, ... } for a workspace, or null on failure. */
function readWorkspaceEnv(cfg, wsUuid) {
  const r = cmux(['workspace', 'env', wsUuid, '--json'], cfg);
  if (!r.ok) return null;
  try {
    return JSON.parse(r.stdout).env || {};
  } catch {
    return null;
  }
}

const statusOf = (state, key) =>
  (state && state.byKey && state.byKey[key] && state.byKey[key].status) || 'unknown';

/**
 * Read the mirror workspaces WE own. Identity is resolved in three tiers:
 *   1. state cache (wsUuid → key/attachedTerm) — the no-extra-calls common path;
 *   2. legacy description markers (older plugin versions) — adopted with
 *      `legacyDesc: true`, which makes the engine replace the row;
 *   3. workspace env (HPCX_KEY/HPCX_TERM) — the source of truth, consulted once
 *      per unknown workspace; workspaces without it land in `state.foreign` so
 *      they are never probed again.
 * `roster` supplies the hash → full-key mapping for tier 2. Returns null if the
 * socket is unreachable (caller should HOLD).
 */
export function readMirrors(cfg, state, roster = []) {
  const list = listWorkspaces(cfg);
  if (list === null) return null;
  const keyByHash = new Map((roster || []).map((a) => [keyHash(a.key), a.key]));
  const byUuid = new Map();
  for (const [key, v] of Object.entries((state && state.byKey) || {})) {
    if (v && v.wsUuid) byUuid.set(v.wsUuid, { key, attachedTerm: v.attachedTerm });
  }
  const foreign = (state && state.foreign) || new Set();
  const liveIds = new Set();
  const mirrors = [];
  for (const w of list) {
    liveIds.add(w.id);
    // Legacy detection uses the DESCRIPTION only (that's where old versions put
    // the marker) — a title can never trigger the replace-once migration.
    const desc = String(w.description || '');
    const legacy = desc.match(LEGACY_KEY_RE);
    const m = legacy ? null : desc.match(LEGACY_HASH_RE);
    const isLegacy = Boolean(legacy || m);
    const known = byUuid.get(w.id);
    if (known) {
      mirrors.push({
        key: known.key,
        wsUuid: w.id,
        title: w.title,
        attachedTerm: known.attachedTerm,
        legacyDesc: isLegacy, // even a cached row migrates off a description marker
        status: statusOf(state, known.key),
      });
      continue;
    }
    if (isLegacy) {
      const key = legacy ? legacy[1] : keyByHash.get(m[1]) || `unknown:${m[1]}`;
      mirrors.push({
        key,
        wsUuid: w.id,
        title: w.title,
        attachedTerm: (m && m[2]) || undefined,
        legacyDesc: true, // description-era row → the engine replaces it
        status: statusOf(state, key),
      });
      continue;
    }
    if (foreign.has(w.id)) continue;
    const env = readWorkspaceEnv(cfg, w.id);
    if (env && env.HPCX_KEY) {
      mirrors.push({
        key: env.HPCX_KEY,
        wsUuid: w.id,
        title: w.title,
        attachedTerm: env.HPCX_TERM || undefined,
        status: statusOf(state, env.HPCX_KEY),
      });
    } else if (env !== null) {
      foreign.add(w.id); // confirmed not ours — never probe it again
    }
  }
  // Forget foreign workspaces that no longer exist so the set can't grow forever.
  if (state) state.foreign = new Set([...foreign].filter((id) => liveIds.has(id)));
  return mirrors;
}

/** Make a cmux workspace active (used to bounce back to the herdr host on click). */
export function selectWorkspace(cfg, wsUuid) {
  if (wsUuid) cmux(['workspace', 'select', wsUuid], cfg);
}

/**
 * uuid of the cmux workspace hosting the herdr TUI, found by title. Mirror
 * workspaces are excluded so a mirror named "herdr-plugin-cmux" can never be
 * mistaken for the host. Exact title match wins; falls back to a substring
 * match. Null if not found. Pass the current mirrors when available.
 */
export function findHostWorkspace(cfg, title, mirrors = []) {
  const list = listWorkspaces(cfg);
  if (!list || !title) return null;
  const t = String(title).toLowerCase();
  const mirrorIds = new Set((mirrors || []).map((m) => m.wsUuid));
  const candidates = list.filter((w) => {
    const hay = `${w.description || ''} ${w.title || ''}`;
    return !mirrorIds.has(w.id) && !LEGACY_HASH_RE.test(hay) && !LEGACY_KEY_RE.test(hay);
  });
  const titleOf = (w) => String(w.custom_title || w.title || '').toLowerCase();
  const hit =
    candidates.find((w) => titleOf(w) === t) ||
    candidates.find((w) => titleOf(w).includes(t));
  return hit ? hit.id : null;
}

function setStatus(wsUuid, status, cfg) {
  if (!wsUuid) return;
  const p = cfg.pill(status);
  cmux(
    ['set-status', 'agent', p.text, '--icon', p.icon, '--color', p.color, '--priority', String(p.priority), '--workspace', wsUuid],
    cfg,
  );
}

// --- live task line: a second status entry (key "task") under the agent pill ---
export function setTaskStatus(cfg, wsUuid, text) {
  if (!wsUuid || !text) return;
  cmux(
    ['set-status', 'task', text, '--icon', 'text.bubble', '--color', '#8e8e93', '--priority', '40', '--workspace', wsUuid],
    cfg,
  );
}

export function clearTaskStatus(cfg, wsUuid) {
  if (!wsUuid) return;
  cmux(['clear-status', 'task', '--workspace', wsUuid], cfg);
}

// --- workspace grouping (resolve/ensure the sidebar group by NAME, restart-safe) ---
function listGroups(cfg) {
  const r = cmux(['workspace-group', 'list', '--json'], cfg);
  if (!r.ok) return [];
  try {
    const d = JSON.parse(r.stdout);
    return d.groups || (Array.isArray(d) ? d : []);
  } catch {
    return [];
  }
}

export function groupRefByName(cfg, name) {
  const g = listGroups(cfg).find((x) => x.name === name);
  return g ? g.ref : null;
}

// Ensure wsUuid is a member of the group named `name`, creating it (with a fresh
// dedicated anchor header) on first use. `add` re-parents a workspace already in
// another group. Best-effort; never throws.
export function ensureMemberOfGroup(cfg, wsUuid, name) {
  if (!name || !wsUuid) return;
  const ref = groupRefByName(cfg, name);
  if (ref) cmux(['workspace-group', 'add', '--group', ref, '--workspace', wsUuid], cfg);
  else cmux(['workspace-group', 'create', '--name', name, '--from', wsUuid], cfg);
}

/**
 * Apply one reconcile Action. Returns a patch describing how to update state.byKey:
 *   { key, patch:{wsUuid,status} } | { key, remove:true } | { error } | {}
 */
export function applyAction(action, cfg) {
  switch (action.type) {
    case 'create': {
      const attach = cfg.clickMode === 'attach';
      const args = [
        'new-workspace',
        '--name', action.label,
        '--focus', 'false',
        '--env', `HPCX_KEY=${action.key}`, // row identity — invisible, read back via `workspace env`
      ];
      if (attach && action.terminalId) args.push('--env', `HPCX_TERM=${action.terminalId}`);
      if (action.cwd) args.push('--cwd', action.cwd);
      if (cfg.window) args.push('--window', cfg.window);
      if (attach) {
        args.push('--command', attachRowCommand(action.key));
      } else {
        // Focus mode: the row is a button, not a terminal — show identity, not a shell.
        args.push('--command', thinRowCommand(action.key, action.label));
      }
      const r = cmux(args, cfg);
      if (!r.ok) return { error: r.stderr || 'new-workspace failed' };
      // new-workspace prints "OK workspace:N" — that short ref resolves to the UUID.
      const ref = (r.stdout.match(/workspace:\d+/) || [])[0];
      const wsUuid = ref ? uuidByRef(cfg, ref) : null;
      if (!wsUuid) return { error: `created workspace but could not resolve its id (${r.stdout})` };
      setStatus(wsUuid, action.status, cfg);
      // Grouping is handled by the driver's ensureGroups pass (covers new + existing mirrors).
      const patch = { wsUuid, status: action.status };
      if (attach && action.terminalId) patch.attachedTerm = action.terminalId;
      return { key: action.key, patch };
    }
    case 'status': {
      setStatus(action.wsUuid, action.status, cfg);
      return { key: action.key, patch: { wsUuid: action.wsUuid, status: action.status } };
    }
    case 'close': {
      cmux(['close-workspace', '--workspace', action.wsUuid], cfg);
      return { key: action.key, remove: true };
    }
    case 'reseed': {
      // The seeded terminal went stale (or its attach PTY died with the daemon),
      // or the row is a legacy description-marker one: replace the workspace.
      // cmux has no "replace command" API, so close+create.
      cmux(['close-workspace', '--workspace', action.wsUuid], cfg);
      const res = applyAction({ ...action, type: 'create' }, cfg);
      // Group membership and the task line belong to the old workspace — clear
      // the caches so the follow-up passes re-apply them to the new one.
      if (res.patch) res.patch = { ...res.patch, group: '', task: '' };
      return res;
    }
    case 'notify': {
      if (action.wsUuid) {
        cmux(['notify', '--title', `${action.label}: ${cfg.pill(action.status).text}`, '--workspace', action.wsUuid], cfg);
      }
      return {};
    }
    default:
      return {};
  }
}

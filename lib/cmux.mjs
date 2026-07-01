// cmux write layer.
//
// Talks to the cmux control socket via the `cmux` CLI. Requires cmux running with
// automation.socketControlMode = "automation" (admits same-user local processes,
// no password) or "password" (see README / `doctor`); this plugin runs under the
// herdr daemon, not under cmux, so the default "cmuxOnly" ancestry gate rejects it.
//
// Command shapes below are VERIFIED live against cmux 0.64.17 (M1):
//   - JSON output is a single whole-document (array or object), NOT NDJSON.
//   - `cmux workspace list --json --id-format uuids` → workspaces with {id,title,description,...}.
//   - `cmux new-workspace ...` prints "OK workspace:N" (no --json); recover the UUID by
//     looking the workspace up via our description marker.
//   - `cmux set-status <key> <text> --icon --color --priority --workspace <uuid>` updates in place.
//   - `cmux close-workspace --workspace <uuid>` / `cmux clear-status <key> --workspace <uuid>`.

import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

// Each mirror workspace's description ends with a compact identity marker
// (`hpcx:<12-hex hash of the herdr key>`), so the mapping is reconstructable from
// cmux alone (state map.json is only an optimization) while the description stays
// human-readable. Full keys are recovered by hashing the live roster's keys;
// a hash with no roster match is by definition a stale mirror (its agent is gone).
// Attach-mode rows extend the marker with the terminal they were seeded against
// (`hpcx:<hash>+<terminal_id>`) so a terminal change can be detected → reseed.
const MARKER_RE = /hpcx:([0-9a-f]{12})(?:\+([\w.-]+))?/;
const LEGACY_MARKER_RE = /\[hpcx:key=([^\]]+)\]/; // pre-hash rows; adopted, not duplicated
export const keyHash = (key) => createHash('sha256').update(String(key)).digest('hex').slice(0, 12);
export const marker = (key) => `hpcx:${keyHash(key)}`;

/**
 * The identity tag a row is created with: `hpcx:<hash>` — with `withTerm`
 * (attach mode) extended to `hpcx:<hash>+<terminal_id>` so a later terminal
 * change is detectable. This is the row's entire initial description; the first
 * reconcile pass replaces it with "<agent's latest output line> · <tag>"
 * (live-updated via the workspace.action set_description rpc).
 */
export function rowTag(action, withTerm = false) {
  return withTerm && action.terminalId
    ? `${marker(action.key)}+${action.terminalId}`
    : marker(action.key);
}

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
  const r = cmux(['workspace', 'list', '--json', '--id-format', 'uuids'], cfg);
  if (!r.ok) return null; // socket unreachable → caller HOLDs
  return toArray(r.stdout);
}

/** id of the workspace whose description/title carries our marker for `key`, or null. */
export function findWorkspaceId(cfg, key) {
  const list = listWorkspaces(cfg);
  if (!list) return null;
  const want = marker(key);
  const hit = list.find(
    (w) => String(w.description || '').includes(want) || String(w.title || '').includes(want),
  );
  return hit ? hit.id : null;
}

/**
 * Read the mirror workspaces WE own, recovering each herdr key from the marker.
 * `roster` (normalized agents) supplies the hash → full-key mapping; a marker
 * whose hash matches no roster key gets `unknown:<hash>`, which never matches an
 * agent and therefore reconciles to close — exactly right for a stale mirror.
 * Returns null if the socket is unreachable (caller should HOLD).
 */
export function readMirrors(cfg, state, roster = []) {
  const list = listWorkspaces(cfg);
  if (list === null) return null;
  const keyByHash = new Map((roster || []).map((a) => [keyHash(a.key), a.key]));
  const mirrors = [];
  for (const w of list) {
    const hay = `${w.description || ''} ${w.title || ''}`;
    const legacy = hay.match(LEGACY_MARKER_RE);
    const m = legacy ? null : hay.match(MARKER_RE);
    if (!legacy && !m) continue;
    const key = legacy ? legacy[1] : keyByHash.get(m[1]) || `unknown:${m[1]}`;
    mirrors.push({
      key,
      wsUuid: w.id,
      title: w.title,
      attachedTerm: (m && m[2]) || undefined, // terminal this attach row was seeded with
      // The marker exactly as written — description rewrites MUST append this
      // verbatim (rebuilding it from the roster would erase a stale seeded
      // terminal and blind the reseed detection).
      markerText: legacy ? legacy[0] : m[0],
      status: (state && state.byKey && state.byKey[key] && state.byKey[key].status) || 'unknown',
    });
  }
  return mirrors;
}

/** Make a cmux workspace active (used to bounce back to the herdr host on click). */
export function selectWorkspace(cfg, wsUuid) {
  if (wsUuid) cmux(['workspace', 'select', wsUuid], cfg);
}

/**
 * uuid of the cmux workspace hosting the herdr TUI, found by title. Mirror
 * workspaces (ours carry the marker) are excluded so a mirror named
 * "herdr-plugin-cmux" can never be mistaken for the host. Exact title match
 * wins; falls back to a substring match. Null if not found.
 */
export function findHostWorkspace(cfg, title) {
  const list = listWorkspaces(cfg);
  if (!list || !title) return null;
  const t = String(title).toLowerCase();
  const candidates = list.filter((w) => {
    const hay = `${w.description || ''} ${w.title || ''}`;
    return !MARKER_RE.test(hay) && !LEGACY_MARKER_RE.test(hay);
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

/**
 * Live-update a workspace's description. The CLI has no command for this, but
 * the v2 rpc `workspace.action` with action=set_description does it (verified
 * live on cmux 0.64.17; `workspace.rename` silently ignores a description).
 */
export function setDescription(cfg, wsUuid, text) {
  if (!wsUuid) return;
  cmux(
    ['rpc', 'workspace.action', JSON.stringify({ workspace_id: wsUuid, action: 'set_description', description: text })],
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
        '--description', rowTag(action, attach),
        '--focus', 'false',
      ];
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
      // new-workspace prints "OK workspace:N" (no UUID) — recover it by our marker.
      const wsUuid = findWorkspaceId(cfg, action.key);
      if (!wsUuid) return { error: 'created workspace but could not locate it by marker' };
      setStatus(wsUuid, action.status, cfg);
      // Grouping is handled by the driver's ensureGroups pass (covers new + existing mirrors).
      return { key: action.key, patch: { wsUuid, status: action.status } };
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
      // The seeded terminal went stale (or its attach PTY died with the daemon):
      // replace the workspace. cmux has no "replace command" API, so close+create.
      cmux(['close-workspace', '--workspace', action.wsUuid], cfg);
      const res = applyAction({ ...action, type: 'create' }, cfg);
      // Group membership, task line, and description belong to the old workspace —
      // clear the caches so the follow-up passes re-apply them to the new one.
      if (res.patch) res.patch = { ...res.patch, group: '', task: '', desc: '' };
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

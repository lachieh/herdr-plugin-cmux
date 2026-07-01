// Pure reconcile engine for herdr-plugin-cmux.
//
// This module has NO side effects and NO I/O. It takes the authoritative herdr
// roster and the set of cmux mirror rows we currently own, and returns a typed
// list of Actions to converge cmux onto the roster. Everything about the design's
// robustness (idempotency, self-healing across restarts and missed events) lives
// here and is exercised by test/reconcile.test.mjs.
//
// Types (informal):
//   NormAgent = { key, source, sessionId, status, label, cwd, terminalId, ... }
//   Mirror    = { key, wsUuid, status, attachedTerm?, label? } // a cmux workspace we created
//   Action    =
//       | { type: 'create', key, label, agent, cwd, terminalId, status }
//       | { type: 'status', key, wsUuid, label, status }
//       | { type: 'reseed', key, wsUuid, label, agent, cwd, terminalId, status }
//       | { type: 'close',  key, wsUuid }
//       | { type: 'notify', key, wsUuid?, label, status }
//
// Config:
//   { removeOnExit=true, holdUnknown=true, notifyOn=Set|[], suppress=Set|[], clickMode }

const KNOWN_STATUSES = new Set(['idle', 'working', 'blocked', 'done', 'unknown']);

/**
 * Compute the idempotent set of actions to make cmux reflect the herdr roster.
 *
 * @param {Array<object>|null} roster  Normalized herdr agents, or null on read failure.
 * @param {Array<object>} mirrors      cmux mirror rows we own (decoded from cmux state).
 * @param {object} [cfg]
 * @returns {Array<object>} actions
 */
export function reconcile(roster, mirrors = [], cfg = {}) {
  // HOLD: on a transient herdr read failure (null) or an empty roster, do nothing.
  // Never wipe the sidebar because of a blip — rows are only removed when the
  // roster is non-empty AND a specific agent is genuinely gone.
  if (!Array.isArray(roster) || roster.length === 0) return [];

  const suppress = toSet(cfg.suppress);
  const notifyOn = toSet(cfg.notifyOn);
  const removeOnExit = cfg.removeOnExit !== false; // default true
  const holdUnknown = cfg.holdUnknown !== false;   // default true

  const actions = [];
  const mirrorByKey = new Map((mirrors || []).map((m) => [m.key, m]));
  const rosterByKey = new Map(roster.map((a) => [a.key, a]));

  // 1) Every agent in the roster should have a matching, up-to-date mirror row.
  for (const a of roster) {
    const m = mirrorByKey.get(a.key);
    if (!m) {
      // The user explicitly closed this row while the agent still lives — respect
      // that and do not resurrect it (the suppress-list is managed by the driver).
      if (suppress.has(a.key)) continue;
      actions.push({
        type: 'create',
        key: a.key,
        label: a.label,
        agent: a.agent,
        cwd: a.cwd,
        terminalId: a.terminalId,
        status: normStatus(a.status),
      });
      if (notifyOn.has(a.status)) {
        actions.push({ type: 'notify', key: a.key, label: a.label, status: normStatus(a.status) });
      }
      continue;
    }
    // Replace (close + recreate) a row whose workspace is out of date:
    //   - legacyDesc: a row from an older plugin version that carried identity in
    //     the description — replaced once so identity moves to workspace env;
    //   - attach mode with a moved terminal (pane compaction, herdr daemon
    //     restart): the hosted attach is stale or dead.
    if (
      m.legacyDesc ||
      (cfg.clickMode === 'attach' &&
        m.attachedTerm &&
        a.terminalId &&
        m.attachedTerm !== a.terminalId)
    ) {
      actions.push({
        type: 'reseed',
        key: a.key,
        wsUuid: m.wsUuid,
        label: a.label,
        agent: a.agent,
        cwd: a.cwd,
        terminalId: a.terminalId,
        status: normStatus(a.status),
      });
      if (a.status !== m.status && notifyOn.has(a.status)) {
        actions.push({ type: 'notify', key: a.key, label: a.label, status: normStatus(a.status) });
      }
      continue; // the recreate carries the fresh status — no separate status action
    }
    if (a.status !== m.status) {
      // Don't flap the pill to "?" on a momentary unknown; keep the last real pill.
      if (holdUnknown && a.status === 'unknown') continue;
      actions.push({
        type: 'status',
        key: a.key,
        wsUuid: m.wsUuid,
        label: a.label,
        status: normStatus(a.status),
      });
      if (notifyOn.has(a.status)) {
        actions.push({ type: 'notify', key: a.key, wsUuid: m.wsUuid, label: a.label, status: normStatus(a.status) });
      }
    }
  }

  // 2) Every mirror whose agent is no longer in the roster is stale → remove/gray.
  for (const m of mirrors || []) {
    if (rosterByKey.has(m.key)) continue;
    if (removeOnExit) {
      actions.push({ type: 'close', key: m.key, wsUuid: m.wsUuid });
    } else if (m.status !== 'exited') {
      actions.push({ type: 'status', key: m.key, wsUuid: m.wsUuid, label: m.label, status: 'exited' });
    }
  }

  return actions;
}

function toSet(v) {
  return v instanceof Set ? v : new Set(v || []);
}

function normStatus(s) {
  return KNOWN_STATUSES.has(s) ? s : 'unknown';
}

#!/usr/bin/env node
// Driver for every [[events]] hook and the `sync` action.
//
// One pass: read the authoritative herdr roster → read the authoritative cmux side
// → compute idempotent actions with the pure engine → apply them. HOLDs (does
// nothing) on any transient read failure so a blip never wipes the sidebar.
//
// Flags:
//   --dry-run   print the actions/commands that WOULD run; touch nothing
//   --full      (accepted for parity; the pass is always a full reconcile)

import { readRoster, readSpaces, spaceGroupName, readTaskLine, readLastOutput } from '../lib/herdr.mjs';
import { reconcile } from '../lib/reconcile.mjs';
import { loadConfig } from '../lib/config.mjs';
import { loadState, saveState } from '../lib/state.mjs';
import * as cmuxlib from '../lib/cmux.mjs';

const argv = process.argv.slice(2);
const dryRun = argv.includes('--dry-run');
const log = (msg) => console.error(`[cmux-bridge] ${msg}`);

const cfg = loadConfig();
const state = loadState();

const roster = readRoster();
if (roster === null) {
  log('HOLD: herdr roster unavailable');
  process.exit(0);
}

// Read the authoritative cmux side.
let mirrors = [];
const probe = cmuxlib.ping(cfg);
if (probe.ok) {
  const m = cmuxlib.readMirrors(cfg, state, roster);
  if (m === null) {
    log('HOLD: cmux socket returned no workspace data');
    process.exit(0);
  }
  mirrors = m;
} else if (dryRun) {
  // No live socket: reconstruct the mirror set from state so the preview is useful.
  mirrors = Object.entries(state.byKey).map(([key, v]) => ({ key, wsUuid: v.wsUuid, status: v.status }));
  log(`(dry-run) cmux socket not reachable; previewing against ${mirrors.length} cached mirror(s)`);
} else {
  if (probe.denied) {
    log('cmux socket DENIED — password mode not active on the running cmux. Run `doctor` (a full cmux restart is required).');
    process.exit(3);
  }
  log(`cmux socket unavailable: ${probe.stderr}`);
  process.exit(1);
}

const actions = reconcile(roster, mirrors, { ...cfg, suppress: state.suppress });

if (dryRun) {
  console.log(`# ${actions.length} action(s) for ${roster.length} agent(s), ${mirrors.length} existing mirror(s)`);
  for (const a of actions) console.log(JSON.stringify(a));
  process.exit(0);
}

const wsByKey = new Map(mirrors.map((m) => [m.key, m.wsUuid]));
let applied = 0;
for (const a of actions) {
  const res = cmuxlib.applyAction(a, cfg);
  if (res.error) {
    log(`action ${a.type} ${a.key} failed: ${res.error}`);
    continue;
  }
  if (res.remove) {
    delete state.byKey[res.key];
    wsByKey.delete(res.key);
  } else if (res.key && res.patch) {
    state.byKey[res.key] = { ...(state.byKey[res.key] || {}), ...res.patch };
    if (res.patch.wsUuid) wsByKey.set(res.key, res.patch.wsUuid);
  }
  applied++;
}

ensureGroups(cfg, roster, wsByKey, state);
ensureTasks(cfg, roster, wsByKey, state);
ensureDescriptions(cfg, roster, wsByKey, state, mirrors);
// Suppression only makes sense while the closed agent still lives; once it is
// gone from the roster the entry is stale — prune so state doesn't grow forever.
const rosterKeys = new Set(roster.map((a) => a.key));
for (const k of [...state.suppress]) if (!rosterKeys.has(k)) state.suppress.delete(k);
saveState(state);
log(`applied ${applied}/${actions.length} action(s) across ${roster.length} agent(s)`);

// Ensure each agent's mirror sits in the right sidebar group (per-space by default).
// Tracked in state so we only call cmux when an agent's group actually changes.
function groupNameForAgent(agent, spaces) {
  if (cfg.groupBy === 'flat') return cfg.groupName;
  return spaceGroupName(spaces, agent.workspaceId);
}
// Live task line: a second status entry (key "task") showing what the agent is
// doing right now, sourced from `herdr agent explain`. Set for working/blocked
// agents, cleared on idle; the last shown text is cached in state so no-op
// updates cost nothing. One `explain` call per active agent per pass.
function ensureTasks(config, agents, wsMap, st) {
  if (!config.taskLine) return;
  for (const a of agents) {
    const wsUuid = wsMap.get(a.key);
    if (!wsUuid) continue;
    const prev = (st.byKey[a.key] && st.byKey[a.key].task) || '';
    if (a.status === 'working' || a.status === 'blocked') {
      const task = readTaskLine(a.terminalId);
      if (!task || task === prev) continue; // keep the last line over a blank read
      cmuxlib.setTaskStatus(config, wsUuid, task);
      st.byKey[a.key] = { ...(st.byKey[a.key] || {}), wsUuid, task };
    } else if (prev) {
      cmuxlib.clearTaskStatus(config, wsUuid);
      st.byKey[a.key] = { ...(st.byKey[a.key] || {}), wsUuid, task: '' };
    }
  }
}

// Live description: replace the static row description with the agent's newest
// output line, keeping the identity marker VERBATIM at the end (rebuilding it
// would erase a stale seeded terminal and blind the M6 reseed detection).
// Reads output for working/blocked agents, on a status transition (captures the
// final answer when an agent settles to idle), and once per row (migration).
function ensureDescriptions(config, agents, wsMap, st, mirrorList) {
  if (!config.liveDescription) return;
  const markerByKey = new Map(mirrorList.map((m) => [m.key, m.markerText]));
  const oldStatusByKey = new Map(mirrorList.map((m) => [m.key, m.status]));
  for (const a of agents) {
    const wsUuid = wsMap.get(a.key);
    const tag = markerByKey.get(a.key);
    if (!wsUuid || !tag) continue; // row created this pass — it has its tag; next pass adds output
    const rec = st.byKey[a.key] || {};
    const active = a.status === 'working' || a.status === 'blocked';
    const settled = oldStatusByKey.has(a.key) && oldStatusByKey.get(a.key) !== a.status;
    if (!active && !settled && rec.desc) continue;
    const line = readLastOutput(a.terminalId);
    if (!line || line === rec.desc) continue;
    cmuxlib.setDescription(config, wsUuid, `${line} · ${tag}`);
    st.byKey[a.key] = { ...rec, wsUuid, desc: line };
  }
}

function ensureGroups(config, agents, wsMap, st) {
  if (config.groupBy === 'none') return;
  const spaces = config.groupBy === 'space' ? readSpaces() || [] : [];
  for (const a of agents) {
    const wsUuid = wsMap.get(a.key);
    if (!wsUuid) continue;
    const desired = groupNameForAgent(a, spaces);
    if (!desired) continue;
    const prev = st.byKey[a.key] && st.byKey[a.key].group;
    if (prev === desired) continue;
    cmuxlib.ensureMemberOfGroup(config, wsUuid, desired);
    st.byKey[a.key] = { ...(st.byKey[a.key] || {}), wsUuid, group: desired };
  }
}

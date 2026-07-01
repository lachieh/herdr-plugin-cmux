#!/usr/bin/env node
// Optional long-lived [[panes]] process. Two jobs:
//   1. Run a full reconcile every RECONCILE_INTERVAL_MS — covers fully-idle
//      sessions and cmux-restart-while-idle, which the event hooks alone miss.
//   2. Tail `cmux events` for workspace selection/close to implement:
//        - focus click-through: workspace.selected on a mirror row →
//          `herdr agent focus <terminal>`, then select the herdr host workspace in
//          cmux so the user actually lands on the (now focused) agent
//        - user-close suppression: workspace.closed → add key to the suppress-list
//
// ⚠️ M1/M4-GATED: the events tail needs a live cmux password socket. Fails soft
// (retries) until the socket is available.

import { spawn, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { loadConfig } from '../lib/config.mjs';
import { loadState, saveState } from '../lib/state.mjs';
import { readRoster } from '../lib/herdr.mjs';
import { ping, readMirrors, findHostWorkspace, selectWorkspace } from '../lib/cmux.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const reconcileBin = join(here, 'reconcile.mjs');
const cfg = loadConfig();
const log = (m) => console.error(`[cmux-bridge:bridge] ${m}`);

function runReconcile() {
  const r = spawnSync(process.execPath, [reconcileBin], { encoding: 'utf8' });
  if (r.stderr) process.stderr.write(r.stderr);
}

let events = null;
startEvents(); // connect the cmux events tail first so click-through works from the start
runReconcile();
const timer = setInterval(runReconcile, cfg.reconcileIntervalMs);

function startEvents() {
  if (!ping(cfg).ok) {
    setTimeout(startEvents, 5000); // socket not ready yet (e.g. password mode not live)
    return;
  }
  const env = { ...process.env };
  if (cfg.password) env.CMUX_SOCKET_PASSWORD = cfg.password;
  events = spawn('cmux', ['events', '--category', 'workspace', '--reconnect'], { env });
  let buf = '';
  events.stdout.on('data', (d) => {
    buf += d.toString();
    let nl;
    while ((nl = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, nl);
      buf = buf.slice(nl + 1);
      handleEvent(line.trim());
    }
  });
  events.on('exit', () => { events = null; setTimeout(startEvents, 3000); });
}

function handleEvent(line) {
  if (!line) return;
  let ev;
  try { ev = JSON.parse(line); } catch { return; }
  if (ev.type !== 'event') return; // skip ack / heartbeat frames
  const name = ev.name || '';
  const wsUuid = ev.workspace_id || (ev.payload && ev.payload.workspace_id);
  if (!wsUuid) return;
  const roster = readRoster() || [];
  const mirrors = readMirrors(cfg, loadState(), roster) || [];
  const hit = mirrors.find((m) => m.wsUuid === wsUuid);
  if (!hit) return; // not one of our mirror rows
  const key = hit.key;

  if (/workspace\.selected/i.test(name) && cfg.clickMode === 'focus') {
    const agent = roster.find((x) => x.key === key);
    const term = agent && agent.terminalId;
    if (term) {
      spawnSync(process.env.HERDR_BIN_PATH || 'herdr', ['agent', 'focus', term]);
      log(`click-through: ${key} → herdr agent focus ${term}`);
    }
    // Bounce cmux back to the herdr host workspace — staying parked on the thin
    // mirror pane would show nothing useful. Never bounce to another mirror
    // (previous_workspace_id can be one when stepping through rows → ping-pong).
    const prev = ev.payload && ev.payload.previous_workspace_id;
    const prevIsMirror = mirrors.some((m) => m.wsUuid === prev);
    const host =
      cfg.hostWorkspace ||
      findHostWorkspace(cfg, cfg.hostTitle) ||
      (prevIsMirror ? null : prev);
    if (host && host !== wsUuid) selectWorkspace(cfg, host);
  } else if (/workspace\.closed/i.test(name)) {
    const state = loadState();
    // `unknown:<hash>` means the agent is already gone — nothing to suppress.
    if (!key.startsWith('unknown:')) state.suppress.add(key);
    delete state.byKey[key];
    saveState(state);
    log(`user closed mirror for ${key} → suppressing`);
  }
}

const shutdown = () => { clearInterval(timer); if (events) events.kill(); process.exit(0); };
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
log(`up: reconcile every ${cfg.reconcileIntervalMs}ms, clickMode=${cfg.clickMode}`);

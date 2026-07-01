#!/usr/bin/env node
// Setup validator. The LIVE socket probe is the only real gate — everything else
// is advisory. Prints the exact fix on denial, including the finding that
// socketControlMode only rebinds on a FULL cmux restart, not a live reload.
//
//   node bin/doctor.mjs           diagnose
//   node bin/doctor.mjs --dock    print the read-only roster fallback (no socket)

import { readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { readRoster } from '../lib/herdr.mjs';
import { loadConfig } from '../lib/config.mjs';
import { loadState } from '../lib/state.mjs';
import * as cmuxlib from '../lib/cmux.mjs';

const cfg = loadConfig();
const argv = process.argv.slice(2);
const line = (s = '') => console.log(s);

if (argv.includes('--dock')) {
  // Zero-socket fallback: render the herdr roster as text. (A full cmux Dock
  // integration is future work; this at least gives a socket-free roster view.)
  const roster = readRoster() || [];
  line(`herdr agents (${roster.length}) — read-only, no cmux socket:`);
  for (const a of roster) line(`  ${a.status.padEnd(8)} ${a.label}  (${a.terminalId})`);
  process.exit(0);
}

let ok = true;
line('herdr-plugin-cmux · doctor');
line('==========================');

// 1) herdr reachable?
const roster = readRoster();
if (roster) line(`✓ herdr: ${roster.length} agent(s) visible via \`herdr agent list\``);
else {
  ok = false;
  line(`✗ herdr: \`herdr agent list\` failed (HERDR_ENV=${process.env.HERDR_ENV || 'unset'}) — run inside herdr`);
}

// 2) socketControlMode on disk — informational only; the live probe below is the
//    real gate. (Ignore commented-out JSONC template lines.)
const cfgPath = join(process.env.HOME || '', '.config/cmux/cmux.json');
let modeOnDisk = null;
if (existsSync(cfgPath)) {
  for (const raw of readFileSync(cfgPath, 'utf8').split('\n')) {
    const t = raw.trim();
    if (t.startsWith('//')) continue; // JSONC comment
    const m = t.match(/"socketControlMode"\s*:\s*"([^"]+)"/);
    if (m) { modeOnDisk = m[1]; break; }
  }
}
line(`· cmux.json: socketControlMode = ${modeOnDisk ? `"${modeOnDisk}"` : 'unset (default "cmuxOnly")'}`);

// 3) live socket connection — THE gate. In "automation" mode same-user processes
//    are admitted with no password; in "password" mode the cmux CLI auto-reads the
//    saved token, so no plugin-side config is needed for that either.
const probe = cmuxlib.ping(cfg);
if (probe.ok) {
  line('✓ cmux socket: connection ACCEPTED — the bridge can drive cmux');
} else if (probe.denied) {
  ok = false;
  line(`✗ cmux socket: DENIED — ${probe.stderr.replace(/\s+/g, ' ')}`);
  if (modeOnDisk === 'automation' || modeOnDisk === 'password') {
    line('     cmux.json already opts in, but the RUNNING cmux still enforces the old');
    line('     mode. socketControlMode only rebinds when the socket is recreated at');
    line('     launch — a live reload is NOT enough. FULLY QUIT and REOPEN cmux.');
  }
} else {
  ok = false;
  line(`✗ cmux socket: error — ${probe.stderr || 'unknown'}`);
}

// 4) click-through: can the bridge resolve the herdr host workspace to bounce
//    back to after a row click?
if (probe.ok) {
  const mirrors = cmuxlib.readMirrors(cfg, loadState(), roster || []) || [];
  const host = cfg.hostWorkspace || cmuxlib.findHostWorkspace(cfg, cfg.hostTitle, mirrors);
  if (host) line(`✓ click-through: herdr host workspace resolved (${host})`);
  else {
    line(`! click-through: no cmux workspace titled "${cfg.hostTitle}" — set CMUX_HOST_WORKSPACE`);
    line('     (or CMUX_HOST_TITLE) in the plugin .env; falling back to bounce-to-previous.');
  }
}

line('');
if (ok) {
  line('ALL GOOD ✓  — run: herdr plugin action invoke lachieh.cmux-bridge.sync');
} else {
  line('SETUP NEEDED:');
  line('  1. Edit ~/.config/cmux/cmux.json → add inside the top-level object:');
  line('       "automation": { "socketControlMode": "automation" }');
  line('     ("automation" admits local processes running as YOUR user — no password.');
  line('      "password" mode also works but adds token setup for no practical gain.)');
  line('  2. FULLY QUIT and REOPEN cmux (⌘Q, then relaunch). A reload will NOT switch the socket.');
  line('  3. Re-run this doctor. (No socket access at all? Use `doctor --dock` for a read-only roster.)');
}
process.exit(ok ? 0 : 1);

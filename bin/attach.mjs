#!/usr/bin/env node
// Resolve a herdr session key to the agent's CURRENT terminal id (stdout).
//
// Attach-mode mirror workspaces run:
//   t=$(node bin/attach.mjs <key>); exec herdr agent attach "$t"
// so the volatile terminal id is looked up at spawn time, not baked in at
// workspace-creation time — a (re)spawned pane always attaches to the right
// terminal. Exits 1 (prints nothing) if the agent is gone.

import { readRoster } from '../lib/herdr.mjs';

const key = process.argv[2] || '';
const agent = (readRoster() || []).find((a) => a.key === key);
if (agent && agent.terminalId) {
  console.log(agent.terminalId);
  process.exit(0);
}
process.exit(1);

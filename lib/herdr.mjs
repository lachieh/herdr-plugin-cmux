// herdr read layer: turn `herdr agent list` into a normalized roster.
//
// `herdr agent list` prints a single-line JSON object on stdout (no --json flag):
//   {"id":"cli:agent:list","result":{"agents":[ { ...agent... }, ... ]}}
// Each agent (verified live):
//   { agent, agent_session:{agent,kind,source,value}, agent_status, cwd,
//     focused, foreground_cwd, pane_id, tab_id, terminal_id, workspace_id, revision }
//
// The dedupe key is `${source}:${value}` — source namespaces the agent's native
// session UUID (e.g. "herdr:claude:3506f631-...") so keys are stable across pane
// close/reopen and unique across agent types.

import { spawnSync } from 'node:child_process';
import { basename } from 'node:path';

/** Parse raw `herdr agent list` stdout into the agents array. Throws on error/shape. */
export function parseAgentList(text) {
  const d = JSON.parse(text);
  if (d && d.error) throw new Error(d.error.message || 'herdr returned an error');
  const agents = d && d.result && d.result.agents;
  if (!Array.isArray(agents)) throw new Error('unexpected `herdr agent list` shape');
  return agents;
}

/** Normalize one raw herdr agent into the shape the reconcile engine consumes. */
export function normalizeAgent(a) {
  const sess = a.agent_session || {};
  const sessionId = sess.value || a.terminal_id || a.pane_id || '';
  const source = sess.source || `herdr:${a.agent || 'agent'}`;
  const key = `${source}:${sessionId}`;
  const fg = a.foreground_cwd || a.cwd || '';
  const worktree = fg ? basename(fg) : '';
  const label = worktree || `${a.agent || 'agent'}:${String(a.pane_id || '').split(':').pop()}`;
  return {
    key,
    source,
    sessionId,
    agent: a.agent || 'agent',
    status: a.agent_status || 'unknown',
    label,
    cwd: a.cwd || fg || undefined,
    worktree,
    terminalId: a.terminal_id,
    paneId: a.pane_id,
    tabId: a.tab_id,
    workspaceId: a.workspace_id,
    focused: !!a.focused,
  };
}

/** Normalize the full roster and disambiguate duplicate labels. */
export function normalizeRoster(agents) {
  // Only real agents have an agent_session with a value. `herdr agent list` also
  // surfaces non-agent panes (e.g. this plugin's own bridge pane running node),
  // which report agent/agent_session undefined — never mirror those.
  const real = (agents || []).filter((a) => a && a.agent_session && a.agent_session.value);
  const norm = real.map(normalizeAgent);
  const counts = new Map();
  for (const n of norm) counts.set(n.label, (counts.get(n.label) || 0) + 1);
  for (const n of norm) {
    if (counts.get(n.label) > 1 && n.sessionId) {
      n.label = `${n.label}·${String(n.sessionId).slice(0, 4)}`;
    }
  }
  return norm;
}

/** Parse `herdr workspace list` stdout into the spaces array. */
export function parseWorkspaceList(text) {
  const d = JSON.parse(text);
  if (d && d.error) throw new Error(d.error.message || 'herdr returned an error');
  const ws = d && d.result && d.result.workspaces;
  if (!Array.isArray(ws)) throw new Error('unexpected `herdr workspace list` shape');
  return ws;
}

/** Read herdr spaces (workspaces): [{ workspaceId, label, number }]. Null on failure. */
export function readSpaces(bin = process.env.HERDR_BIN_PATH || 'herdr') {
  const r = spawnSync(bin, ['workspace', 'list'], { encoding: 'utf8' });
  if (r.status !== 0 || !r.stdout) return null;
  try {
    return parseWorkspaceList(r.stdout).map((w) => ({
      workspaceId: w.workspace_id,
      label: w.label,
      number: w.number,
    }));
  } catch {
    return null;
  }
}

/**
 * Pure: the cmux group name for an agent's herdr space. Uses the space label,
 * disambiguating duplicate labels by their herdr number (e.g. "buildy #4").
 * Falls back to the raw workspace id if the space isn't found.
 */
export function spaceGroupName(spaces, workspaceId) {
  const byId = new Map((spaces || []).map((s) => [s.workspaceId, s]));
  const counts = new Map();
  for (const s of spaces || []) counts.set(s.label, (counts.get(s.label) || 0) + 1);
  const s = byId.get(workspaceId);
  if (!s) return workspaceId;
  return counts.get(s.label) > 1 ? `${s.label} #${s.number}` : s.label;
}

/**
 * Pure: turn a raw task-evidence string (agent terminal title / detection region
 * preview) into a display-ready one-liner. Strips spinner glyphs and leading
 * symbols, rejects bare shell prompts, and truncates. '' means "nothing useful".
 */
export function cleanTaskEvidence(evidence) {
  if (!evidence) return '';
  let t = String(evidence)
    .replace(/[\u2800-\u28ff]/g, ' ') // braille spinner frames
    .replace(/[\u00a0\s]+/g, ' ') // nbsp + whitespace runs
    .trim();
  if (/^[❯>$%#]/.test(t)) return '';  // a shell prompt, not a task
  t = t.replace(/^[^\p{L}\p{N}]+\s*/u, ''); // leading glyph runs (✳, ·, …)
  if (t.length > 80) t = `${t.slice(0, 79)}…`;
  return t;
}

/**
 * The agent's current task line, from `herdr agent explain --json`: the
 * `osc_title` detection region holds the agent's terminal title (for claude,
 * "✳ <what it is doing>"). Falls back to the matched rule's preview.
 * '' on any failure — the caller just keeps the previous task line.
 */
export function readTaskLine(terminalId, bin = process.env.HERDR_BIN_PATH || 'herdr') {
  const r = spawnSync(bin, ['agent', 'explain', terminalId, '--json'], { encoding: 'utf8' });
  if (r.status !== 0 || !r.stdout) return '';
  try {
    const d = JSON.parse(r.stdout);
    const rules = d.evaluated_rules || [];
    const title = rules.find((x) => x.region === 'osc_title' && x.evidence && x.evidence.region_preview);
    const matched = rules.find((x) => x.id === d.matched_rule && x.evidence && x.evidence.region_preview);
    return cleanTaskEvidence(
      (title && title.evidence.region_preview) || (matched && matched.evidence.region_preview) || '',
    );
  } catch {
    return '';
  }
}

/**
 * Pure: the newest meaningful content line of a TUI screen dump (newest line
 * last). Walks upward past the terminal furniture — prompt box, separators,
 * status bar, spinner/timing lines — to the last thing the agent actually said.
 * '' when nothing qualifies.
 */
export function lastOutputLine(text) {
  const lines = String(text || '').split('\n');
  for (let i = lines.length - 1; i >= 0; i--) {
    const t = (lines[i] || '').trim();
    if (!t) continue;
    if (/^[❯>$%#]/.test(t)) continue;                        // prompt box
    if (!/[\p{L}\p{N}]/u.test(t)) continue;                  // separators / borders / glyph runs
    if (/^(⏵⏵|󱑏)/.test(t)) continue;                        // status bar / hint lines
    if (/\bctx \d+%/.test(t)) continue;                       // status bar (leading glyph varies)
    if (/\/clear to save|shift\+tab to cycle|ctrl\+[a-z] to |esc to interrupt|\? for shortcuts|to edit queued/i.test(t))
      continue;                                               // claude hint vocabulary
    if (/^[^\p{L}\p{N}]\s/u.test(t) && /(…|\b\d+m?s\b)/.test(t)) continue; // spinner / "Cooked for 3m 9s"
    let out = t
      .replace(/^[^\p{L}\p{N}]+\s*/u, '') // leading bullet/glyph runs (⏺, ·, …)
      .replace(/\(disable recaps in \/config\)\s*$/, '') // trailing claude recap hint
      .replace(/\s+/g, ' ')
      .replace(/hpcx:/g, 'hpcx ') // output must never fake a row identity marker
      .trim();
    if (!out) continue;
    if (out.length > 110) out = `${out.slice(0, 109)}…`;
    return out;
  }
  return '';
}

/** The agent's newest meaningful output line; '' on any failure (caller keeps the old one). */
export function readLastOutput(terminalId, bin = process.env.HERDR_BIN_PATH || 'herdr') {
  const r = spawnSync(
    bin,
    ['agent', 'read', terminalId, '--source', 'recent-unwrapped', '--lines', '40', '--format', 'text'],
    { encoding: 'utf8' },
  );
  if (r.status !== 0 || !r.stdout) return '';
  try {
    return lastOutputLine(JSON.parse(r.stdout).result.read.text);
  } catch {
    return '';
  }
}

/**
 * Read the live roster by shelling `herdr agent list`.
 * Returns a normalized array, or null on ANY failure — null means HOLD (the
 * reconcile engine treats null as "do nothing", never a wipe).
 */
export function readRoster(bin = process.env.HERDR_BIN_PATH || 'herdr') {
  const r = spawnSync(bin, ['agent', 'list'], { encoding: 'utf8' });
  if (r.status !== 0 || !r.stdout) return null;
  try {
    return normalizeRoster(parseAgentList(r.stdout));
  } catch {
    return null;
  }
}

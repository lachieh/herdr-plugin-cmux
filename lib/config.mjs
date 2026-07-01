// Plugin configuration: env vars override values in $HERDR_PLUGIN_CONFIG_DIR/.env.
// Also holds the status → cmux status-pill presentation table.

import { readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';

// herdr status → cmux `set-status` pill (SF Symbol icon + hex color + sort priority).
// Higher priority sorts toward the top of the sidebar; blocked is highest so agents
// that need you jump to the top.
export const PILLS = {
  working: { text: 'Working',      icon: 'hammer',                   color: '#ff9500', priority: 50 },
  blocked: { text: 'Needs input',  icon: 'exclamationmark.triangle', color: '#ff3b30', priority: 100 },
  idle:    { text: 'Idle',         icon: 'moon',                     color: '#8e8e93', priority: 10 },
  done:    { text: 'Done',         icon: 'bell.badge',               color: '#34c759', priority: 90 },
  unknown: { text: '?',            icon: 'questionmark.circle',      color: '#8e8e93', priority: 5 },
  exited:  { text: 'Exited',       icon: 'xmark.circle',             color: '#8e8e93', priority: 1 },
};

function parseEnvFile(path) {
  const out = {};
  if (!path || !existsSync(path)) return out;
  for (const raw of readFileSync(path, 'utf8').split('\n')) {
    const t = raw.trim();
    if (!t || t.startsWith('#')) continue;
    const eq = t.indexOf('=');
    if (eq < 0) continue;
    const k = t.slice(0, eq).trim();
    let v = t.slice(eq + 1).trim();
    if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) v = v.slice(1, -1);
    out[k] = v;
  }
  return out;
}

export function loadConfig(env = process.env) {
  const dir = env.HERDR_PLUGIN_CONFIG_DIR;
  const file = dir ? parseEnvFile(join(dir, '.env')) : {};
  const get = (k, d) => (env[k] != null ? env[k] : file[k] != null ? file[k] : d);
  const notifyOn = String(get('NOTIFY_ON', 'blocked'))
    .split(',').map((s) => s.trim()).filter(Boolean);
  return {
    password: get('CMUX_SOCKET_PASSWORD', ''),
    window: get('CMUX_WINDOW', ''),
    groupBy: get('GROUP_BY', 'space'),            // 'space' (one group per herdr space) | 'flat' | 'none'
    groupName: get('CMUX_GROUP', 'herdr agents'), // group name used when groupBy='flat'
    removeOnExit: String(get('REMOVE_ON_EXIT', 'true')) !== 'false',
    holdUnknown: String(get('HOLD_UNKNOWN', 'true')) !== 'false',
    clickMode: get('CLICK_MODE', 'focus'), // 'focus' (herdr agent focus) | 'attach'
    // Where to bounce cmux back to after a focus click: explicit workspace (uuid/ref)
    // wins; otherwise the bridge finds the workspace whose title matches hostTitle.
    hostWorkspace: get('CMUX_HOST_WORKSPACE', ''),
    hostTitle: get('CMUX_HOST_TITLE', 'herdr'),
    reconcileIntervalMs: parseInt(get('RECONCILE_INTERVAL_MS', '4000'), 10) || 4000,
    // Live "task" line under the agent pill (from `herdr agent explain`).
    taskLine: String(get('TASK_LINE', 'true')) !== 'false',
    // Keep each row's description updated to the agent's newest output line.
    liveDescription: String(get('LIVE_DESCRIPTION', 'true')) !== 'false',
    notifyOn: new Set(notifyOn),
    pill(status) { return PILLS[status] || PILLS.unknown; },
  };
}

# herdr-plugin-cmux

Mirror every [herdr](https://herdr.dev)-managed agent into the [cmux](https://cmux.dev) sidebar
as its own live row — a status pill, a "what is it doing right now" task line, and a click that
drops you straight into the agent.

herdr runs *inside a single cmux tab*, so out of the box all of your agents collapse into one
sidebar entry. This plugin gives each agent its own row:

```
 ▾ buildy                       ← one cmux group per herdr space
   adaptive-waddling-wirth
     ● Working                  ← live status pill
     ▸ Refactor token refresh   ← live task line (what the agent is doing)
   golden-strolling-pinwheel
     ● Needs input              ← blocked sorts to the top, optional notification
 ▾ tambo
   binary-brewing-zebra
     ● Idle
```

## Features

- **One sidebar row per agent**, grouped by herdr space (or one flat group, or ungrouped).
- **Live status pill** — working / needs input / idle / done — updated within a second of the
  agent changing state, driven by herdr's `pane.agent_status_changed` event hooks.
- **Live task line** — the agent's current task (from its terminal title via
  `herdr agent explain`), shown while working or blocked, cleared when idle.
- **Live description** — each row's description tracks the agent's newest output line, so
  hovering a row shows the last thing the agent said.
- **Click-through** — selecting a row shows the agent live in that row (`attach` mode) or
  focuses it back in herdr (`focus` mode).
- **Optional notifications** when an agent needs input.
- **Self-healing by construction** — survives cmux restarts, herdr restarts, missed events,
  and plugin crashes without duplicating or orphaning rows.

## How it works

Every trigger — herdr event hook, manual sync, or the bridge pane's periodic tick — runs one
pure, idempotent pass:

```
herdr agent status change ─▶ [[events]] hook ─▶ reconcile
        herdr agent list ───────────────────────┤ (source of truth)
        cmux workspace list ────────────────────┤ (existing mirror rows)
                                                ▼
                           pure reconcile() ─▶ create / set-status / close / notify
                                                ▼
                                    cmux sidebar row + pills
```

`reconcile(roster, mirrors, cfg)` diffs the authoritative `herdr agent list` against the cmux
workspaces the plugin owns and emits the actions needed to converge. Both sides are re-derived
from live state on every pass, so correctness never depends on caches or event delivery:

- Agents are keyed on the stable `agent_session.source + value` (the agent's native session id,
  namespaced by source, e.g. `herdr:claude:3506f631-…`). Pane/tab/terminal ids are treated as
  volatile.
- Each mirror row's description ends with a compact marker (`hpcx:<12-hex hash of the key>`),
  so the session → workspace mapping is reconstructable from cmux alone. Attach rows also
  record the terminal they were seeded against (`+<terminal_id>`); if the agent's terminal
  moves (pane compaction, herdr daemon restart), the row is replaced automatically, and the
  pane itself resolves the current terminal at spawn time (`bin/attach.mjs`).
- The rest of the description is live: each pass rewrites it to the agent's newest output
  line (via the `workspace.action set_description` rpc — the only description-update path;
  the CLI and `workspace.rename` can't), always re-appending the identity marker verbatim.
- On any transient read failure the pass **HOLDs** (does nothing) — a blip never wipes the
  sidebar. Rows are only removed when the roster is healthy and a specific agent is gone.
- If cmux restarts, every row is recreated from the roster on the next pass. If the user closes
  a row by hand while the agent lives, the bridge records it and the row stays closed.

## Requirements

- macOS, [herdr](https://herdr.dev) ≥ 0.7, [cmux](https://cmux.dev) ≥ 0.64, Node ≥ 18.
- The plugin is dependency-free (`node:` built-ins only).

## Install

```bash
herdr plugin install lachieh/herdr-plugin-cmux
```

or for development:

```bash
git clone https://github.com/lachieh/herdr-plugin-cmux && cd herdr-plugin-cmux
herdr plugin link .        # live-edit; no build step
```

Then complete the one-time cmux setup below and verify:

```bash
herdr plugin action invoke lachieh.cmux-bridge.doctor
herdr plugin action invoke lachieh.cmux-bridge.sync
```

For click-through and idle-time freshness, also open the bridge pane once per herdr session:

```bash
herdr plugin pane open --plugin lachieh.cmux-bridge --entrypoint bridge --placement tab --no-focus
```

## One-time cmux setup

cmux's control socket rejects processes that weren't spawned inside cmux
(`socketControlMode: "cmuxOnly"`, enforced by process ancestry). The plugin runs under the herdr
daemon, so cmux must be opted in to same-user automation:

1. Back up `~/.config/cmux/cmux.json`, then add inside the top-level object:
   ```jsonc
   "automation": { "socketControlMode": "automation" }
   ```
2. **Fully quit and reopen cmux** (⌘Q, then relaunch). A live config reload is *not* enough —
   the socket mode only rebinds when the socket is recreated at launch.
3. Re-run `doctor` — it should report `connection ACCEPTED`.

> **Security note:** `automation` mode admits every local process running as your user (no
> ancestry check, no password). `password` mode is not meaningfully stricter: the cmux CLI
> auto-reads the saved token from `~/.local/state/cmux/socket-control-password`, which your
> processes can read anyway. Both reduce to "trust local same-user code" — `automation` just
> skips the token ceremony. `password` mode also works with this plugin (set
> `CMUX_SOCKET_PASSWORD` only if `doctor` asks). Avoid `allowAll`, which admits other users.
>
> No socket access at all? `node bin/doctor.mjs --dock` prints a read-only roster instead.

## Click modes

| `CLICK_MODE` | Selecting a row… | Trade-off |
|---|---|---|
| `attach` | shows the agent **live in the row** (`herdr agent attach`) — fully interactive | one PTY per agent |
| `focus` (default) | focuses the agent in herdr and bounces cmux back to the herdr host workspace | lightest; rows show a small identity card |

In `focus` mode the bridge finds the herdr host workspace via `CMUX_HOST_WORKSPACE`, or by
title match on `CMUX_HOST_TITLE` (default `herdr`), falling back to the workspace you came from.

## Configuration

Values live in `$(herdr plugin config-dir lachieh.cmux-bridge)/.env`; environment variables
override. See [`config/.env.example`](config/.env.example).

| Variable | Default | Meaning |
|---|---|---|
| `CLICK_MODE` | `focus` | `attach` = live agent view in the row; `focus` = jump back to herdr |
| `GROUP_BY` | `space` | `space` = one cmux group per herdr space · `flat` = one group · `none` |
| `CMUX_GROUP` | `herdr agents` | group name when `GROUP_BY=flat` |
| `TASK_LINE` | `true` | live "current task" line under the status pill |
| `LIVE_DESCRIPTION` | `true` | row description tracks the agent's newest output line |
| `NOTIFY_ON` | `blocked` | statuses that raise a cmux notification (comma-separated) |
| `REMOVE_ON_EXIT` | `true` | remove the row when the agent exits (`false` = gray it out) |
| `HOLD_UNKNOWN` | `true` | keep the last real pill through a momentary `unknown` |
| `CMUX_HOST_WORKSPACE` | — | focus mode: explicit workspace (uuid/ref) to bounce back to |
| `CMUX_HOST_TITLE` | `herdr` | focus mode: find the host workspace by title |
| `CMUX_WINDOW` | — | cmux window to create rows in (default: cmux decides) |
| `RECONCILE_INTERVAL_MS` | `4000` | bridge pane's periodic reconcile interval |
| `CMUX_SOCKET_PASSWORD` | — | only for `password` mode, and only if `doctor` asks |

Status → pill presentation (icon, color, priority) lives in [`lib/config.mjs`](lib/config.mjs):
`blocked` sorts to the top (priority 100), then `done`, `working`, `idle`.

## Troubleshooting

`herdr plugin action invoke lachieh.cmux-bridge.doctor` checks each link in the chain and
prints the exact fix — the live socket probe is the source of truth. Common cases:

- **`DENIED — only processes started inside cmux can connect`** — the running cmux still
  enforces the old socket mode. Fully quit and reopen cmux (a reload won't rebind the socket).
- **Rows exist but clicking does nothing** — the bridge pane isn't running; open it (see
  Install). In `focus` mode also check the host-workspace line in `doctor`.
- **A row was closed by hand and won't come back** — that's the user-close suppression working;
  it clears when the agent exits, or delete `suppress` from the state file
  (`~/.local/state/herdr/plugins/lachieh.cmux-bridge/map.json`).

Per-invocation logs: `herdr plugin log list --plugin lachieh.cmux-bridge`.

## Development

```bash
node --test                        # pure engine + normalization tests (no I/O)
node bin/reconcile.mjs --dry-run   # print the actions a pass would take, touch nothing
node bin/doctor.mjs                # validate the full chain
```

| Path | Purpose |
|---|---|
| `herdr-plugin.toml` | manifest: 4 `[[events]]` hooks, `sync`/`doctor` actions, the `bridge` pane |
| `lib/reconcile.mjs` | **pure** `reconcile()` — the tested core, no I/O |
| `lib/herdr.mjs` | roster + task-line reads (`null`/`''` on failure → HOLD) |
| `lib/cmux.mjs` | cmux CLI wrapper: mirror discovery, row create/status/close, groups |
| `lib/config.mjs` · `lib/state.mjs` | config + pill table; optimization-only state cache |
| `bin/reconcile.mjs` | driver: read → reconcile → apply (+ groups, task lines) |
| `bin/bridge.mjs` | long-lived pane: periodic reconcile + `cmux events` tail (click-through, suppression) |
| `bin/attach.mjs` | resolves a session key → current terminal id at pane-spawn time (attach mode) |
| `bin/doctor.mjs` | setup validator (+ `--dock` read-only fallback) |

Design history and post-build findings live in [`PLAN.md`](PLAN.md).

## License

[MIT](LICENSE)

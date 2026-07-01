# herdr-plugin-cmux — Implementation Plan

> A **herdr plugin** that mirrors every herdr-managed agent into the **cmux sidebar** as a
> live status row (🟠 working / 🔴 needs-input / ⚪ idle), with click-through that focuses the
> agent's pane back in herdr. Reconcile-by-construction: idempotent, self-healing across
> restarts and missed events.

**Status:** built and live (see the 2026-07-01 addendum below for what changed vs this plan).
The M1 gate passed; agents mirror end-to-end on cmux 0.64.17.

---

## 0. Addendum — post-build corrections (2026-07-01)

Findings from building, running live, and researching cmux upstream. Where the addendum
conflicts with the sections below, the addendum wins:

1. **`automation` socket mode supersedes the password decision (§3–§4, §13).** cmux's
   `socketControlMode: "automation"` admits *same-user* local clients with **no ancestry check
   and no password** (the ancestry walk only applies to `cmuxOnly`). Password mode was also not
   buying anything: the cmux CLI auto-reads the saved token from
   `~/.local/state/cmux/socket-control-password` (mode 0644), so any same-user process could
   authenticate anyway. The plugin now recommends `automation` mode; the full-restart-to-rebind
   requirement still applies.
2. **The click event is `workspace.selected`, not `workspace.focused`** (§5, §8). Payload
   carries `workspace_id` (uuid) and `previous_workspace_id`.
3. **Click-through needs a bounce-back.** `herdr agent focus` alone leaves cmux parked on the
   mirror workspace, so it *looks* like the click did nothing. The bridge now selects the herdr
   host workspace (config `CMUX_HOST_WORKSPACE`, else title match `CMUX_HOST_TITLE`, default
   `herdr`) after focusing.
4. **UUID recovery via description marker, not title marker / create output** (§7).
   `new-workspace` prints `OK workspace:N` (no `--json`, no uuid); the plugin ends the
   workspace *description* with a compact marker — `hpcx:<12-hex sha256 of the key>` — and
   looks the uuid up from `workspace list`. The description itself is human-first
   (`claude agent · ~/Projects/x · hpcx:1a2b3c4d5e6f`); full keys are recovered by hashing
   the live roster's keys (an unmatched hash ⇒ stale mirror ⇒ close, which is correct).
5. **`bin/row.mjs` was replaced by an inline `--command` one-liner** (printf + `exec cat`) —
   thinner than both a login shell and a node process (§8, §10).
6. **cmux extensions researched and rejected for now** (updates §17): cmux 0.64.11+ ships
   `CmuxExtensionKit` sidebar extensions (compiled Swift/ExtensionKit appexes). Not a fit:
   beta-gated off by default, replaces the *whole* sidebar rather than injecting rows, appex
   sandbox can't exec `herdr` or reach `$HOME` unix sockets, and it requires a signed containing
   app. Revisit if it leaves beta and gains row injection into the native list.
7. **CLICK_MODE=attach is what the user actually runs** (revises decision §4.2). Each mirror
   workspace hosts `exec herdr agent attach <terminal_id>` — the agent's live view shows
   directly in the row. Focus+bounce-back stays the code default; attach is set in the user's
   plugin `.env`. Verified: 8 attach panes, no phantom agents in the roster.

## 0.1 M6 (planned) — attach re-seed on terminal change

**Problem.** Attach-mode mirrors bake the agent's `terminal_id` into the workspace command at
create time. `terminal_id` is volatile (pane compaction, herdr daemon restart), and a stale id
leaves a dead or wrong attach view while the roster still lists the agent — reconcile sees no
status diff, so today nothing heals it.

**Design (two layers, both reconcile-by-construction):**

1. **Resolve at spawn, not at create.** Seed the workspace command as
   `exec node <plugin>/bin/attach.mjs <key>` instead of a literal terminal id. `attach.mjs`
   resolves key → *current* `terminal_id` via `herdr agent list` at spawn time, then
   `exec herdr agent attach <term>` (prints a clear message and parks if the key is gone).
   This makes every (re)spawn self-correcting; the create path no longer embeds volatile state.
   (`herdr agent attach` also accepts *unique agent names* — attaching by a plugin-assigned
   `herdr agent rename` name was considered and rejected: it mutates user-visible labels.)
2. **Reseed action in the pure engine.** Extend the description marker to
   `hpcx:<hash12>+<terminal_id>`, written at create. `readMirrors()` decodes
   `attachedTerm`; in attach mode, `roster.terminalId !== mirror.attachedTerm` → new action
   `{type:'reseed', key, wsUuid, ...}` → `applyAction` = close + recreate (cmux has no
   "replace workspace command" API). This restarts the dead PTY after daemon restarts, which
   layer 1 alone can't do (the old process is already dead inside a live workspace).

**Guards:** markers without `;term=` (pre-M6 rows) are treated as current — no reseed storm on
upgrade; at most one reseed per key per pass; focus mode never reseeds; HOLD semantics unchanged.

**Tests:** term-change → reseed; same-term → no action; focus mode → never; legacy marker →
no action; reseed carries the fields create needs.

---

## 1. Context & problem

- You run **herdr** (a terminal workspace manager / multiplexer for AI coding agents) *inside a
  single cmux terminal tab*. herdr manages many agents; cmux only sees the one terminal running
  the herdr TUI.
- **Result today:** all N herdr agents collapse into a single cmux sidebar entry. You can't see
  per-agent status or jump to a specific agent from cmux.
- **Goal:** every herdr agent shows up as its own cmux sidebar entry, with live status, and
  clicking it takes you to that agent.

Environment confirmed on this machine:
- Running inside herdr: `HERDR_ENV=1`, socket at `HERDR_SOCKET_PATH=~/.config/herdr/herdr.sock`,
  herdr v0.7.1.
- cmux installed (`/Applications/cmux.app`, CLI `/opt/homebrew/bin/cmux`, **v0.64.17**), config
  at `~/.config/cmux/cmux.json`, control socket auto-discovered (`~/.local/state/cmux/cmux.sock`,
  also recorded in `~/.local/state/cmux/last-socket-path`).
- Target repo: `~/Projects/lachieh/herdr-plugin-cmux` (currently empty except `.git`).

---

## 2. What the two extension systems offer (investigation summary)

The two tools have **asymmetric** extension surfaces:

| | herdr | cmux |
|---|---|---|
| **Plugin model** | `herdr-plugin.toml` manifest + argv commands (any language). "The entire herdr CLI is the plugin API." `herdr plugin link <path>` (dev) / `install <owner>/<repo>` (prod). | Agent **hooks**, a **feed**, **notifications**, **custom SwiftUI sidebars** (beta), a **socket RPC/CLI**, and a **Vault** agent registry. |
| **Reading the agent roster** | ✅ **Fully open.** `herdr agent list` → live JSON roster; `[[events]] on="pane.agent_status_changed"` fires on *every* agent transition. | — |
| **Writing to the sidebar** | — | ⚠️ **Gated by process ancestry** (see §3). |

### herdr side (the source of truth — all open)
- Plugin = a directory with `herdr-plugin.toml` + argv commands. No SDK; the herdr CLI (via
  injected `HERDR_BIN_PATH`) and the raw unix socket (`HERDR_SOCKET_PATH`) *are* the API.
- Manifest extension points: `[[actions]]`, `[[events]]`, `[[panes]]`, `[[link_handlers]]`,
  `[[build]]`. Required top-level keys: `id`, `name`, `version`, `min_herdr_version`.
- **Event push:** a manifest `[[events]] on = "pane.agent_status_changed"` hook spawns the
  plugin's command on *every* agent status change across *all* panes (proven by the official
  `agent-telegram-notify` example). Fire-and-forget, one process per event, cwd = plugin dir.
- Event vocabulary includes: `pane.created/closed/focused/exited/agent_detected/agent_status_changed`,
  `workspace.*`, `worktree.*`. There is **no** `agent.started/stopped` — agents are panes.
- **Roster read:** `herdr agent list` returns per-agent `{agent, agent_session:{kind,source,value}, agent_status, cwd, foreground_cwd, focused, pane_id, tab_id, terminal_id, workspace_id, revision}`.
- Injected env for plugin commands: `HERDR_BIN_PATH`, `HERDR_PLUGIN_ROOT`, `HERDR_PLUGIN_CONFIG_DIR`,
  `HERDR_PLUGIN_STATE_DIR`, `HERDR_PLUGIN_EVENT`, `HERDR_PLUGIN_EVENT_JSON`, etc.
- Prior art (topic `herdr-plugin`, ~55 repos): `agent-telegram-notify`, `herdr-remote`,
  `herdr-push`, `herdr-ntfy-notify`, `herdr-token-dashboard` — all "mirror agents to an external
  surface", the exact pattern we need.

### cmux side (the sink — has a security gate)
- Ways to put rows in the sidebar: create **workspaces** (`cmux new-workspace`) + **status pills**
  (`cmux set-status`); a **feed**; **notifications**; a **custom SwiftUI sidebar**; the **Vault**
  agent registry (`vault.agents` in cmux.json — registers JSONL-backed agents cmux can detect/resume).
- `automation.socketControlMode` config ∈ `{cmuxOnly (default), automation, password, allowAll}`;
  `automation.socketPassword` is the shared token for password mode.
- CLI auth precedence: `--password` flag → `CMUX_SOCKET_PASSWORD` env → password saved in Settings.
- `cmux reload-config` reloads cmux.json live (no app restart).

Reference docs (raw):
- herdr plugins: https://herdr.dev/docs/plugins/
- cmux config/schema: https://raw.githubusercontent.com/manaflow-ai/cmux/main/web/data/cmux.schema.json
- cmux docs: `agent-hooks.md`, `feed.md`, `notifications.md`, `custom-sidebars.md` under
  `https://raw.githubusercontent.com/manaflow-ai/cmux/main/docs/`
- cmux skill: `https://raw.githubusercontent.com/manaflow-ai/cmux/main/skills/cmux/SKILL.md`

---

## 3. The critical constraint (load-bearing)

**cmux gates its control socket by process ancestry.** Default `socketControlMode="cmuxOnly"`
rejects every process not spawned inside cmux with *"only processes started inside cmux can
connect."* Our herdr plugin runs under the **launchd-reparented herdr daemon** — it is **not** a
cmux descendant. Verified live: every `cmux` socket write from this context fails with
`Broken pipe, errno 32`.

**Consequence:** to let the plugin drive cmux we must widen `socketControlMode` to `password`
(a one-time cmux setting change) and have the plugin authenticate with `CMUX_SOCKET_PASSWORD`.
This is the single biggest risk and is gated by milestone **M1**.

> **Build-time correction (confirmed live):** the config change alone isn't enough, and
> `cmux reload-config` is **not** enough either — `socketControlMode` only rebinds when the socket
> is (re)created at **cmux launch**. Enabling password mode requires a **full quit + reopen of
> cmux**. Verified: after editing cmux.json, the registered `~/.local/state/cmux/socket-control-password`
> updated but the running socket (mtime unchanged, app PID unchanged) kept rejecting us with the
> `cmuxOnly` message. `doctor` now detects this exact state and tells the user to restart.

> ⚠️ **Not yet proven end-to-end:** only the `cmuxOnly` *failure* is proven. That password mode
> actually *admits* the non-descendant plugin is the M1 gate — must be confirmed before building
> the rest. If it fails, fall back to the read-only Dock roster (§9 fallback).

Security trade-off (accepted by decision, see §4): password mode lets any local process holding
the token drive cmux. We use the narrowest mode (`password`, not `allowAll`) and a random token
stored only in the plugin's private config dir.

---

## 4. Decisions locked in

1. **Sidebar mechanism → enable cmux password mode.** Real per-agent cmux workspaces + live
   status pills. (We still ship `doctor` + the read-only Dock fallback for portability.)
2. **Click-through → focus in herdr.** Clicking an agent row focuses that agent's pane in herdr
   (`herdr agent focus <terminal_id>`), rather than attaching a live PTY per agent. Lighter, no
   feedback-loop risk, verified correct. (`attach` remains available as an optional config toggle.)

---

## 5. Architecture: reconcile-by-construction

A herdr plugin living entirely in this repo. Three short-lived Node entrypoints + one optional
long-lived pane, all spawned by herdr (argv arrays, no shell, cwd = plugin dir). Dependency-free
`.mjs` (Node built-ins only).

Every trigger runs **one pure function**:

```
reconcile(herdrRoster, cmuxMirrors, config) -> Action[]     // create | set-status | close | notify
```

- **Read** the authoritative roster: `herdr agent list` (prints single-line JSON; no `--json` flag).
- **Read** the authoritative cmux side: `cmux list-workspaces --json --id-format uuids`, keeping
  only workspaces this plugin created (identified by a session-key marker in the workspace title).
- **Diff** → emit idempotent actions. Both sides are re-derived from live state every run, so
  missed events, rapid flaps, herdr restart, cmux restart, and plugin crashes all converge on the
  next trigger. No fragile pane-id tracking; no lock files.

**Triggers:**
- (a) herdr `[[events]]` hooks — sub-second push during active sessions.
- (b) `sync` action — manual / keybindable full reconcile.
- (c) optional `[[panes]]` bridge — a long-lived loop that reconciles every N seconds (covers
  fully-idle sessions & cmux-restart-while-idle) **and** tails `cmux events` for click-through
  focus + user-closed-row suppression.

State file `$HERDR_PLUGIN_STATE_DIR/map.json` is a pure optimization (last-seen status to skip
no-op pill writes + a suppress-list); correctness never depends on it because the
session→workspace mapping is reconstructed from the cmux workspace title marker every run.

### Data flow
```
herdr agent status change ──► [[events]] hook ──► bin/reconcile.mjs
                                                     │
                          herdr agent list ──────────┤ read roster (source of truth)
                          cmux list-workspaces ──────┤ read existing mirror rows
                                                     ▼
                                     lib/reconcile.mjs  (pure)  ──► Action[]
                                                     │
             cmux new-workspace / set-status / close / notify  (password-authed CLI)
                                                     ▼
                                        cmux sidebar row + pill

click a row in cmux sidebar ──► cmux emits workspace.focused ──► bin/bridge.mjs tail
                                                     │ map workspace→sessionId→terminal_id
                                                     ▼
                                  herdr agent focus <terminal_id>  (jump to agent in herdr)
```

---

## 6. herdr read design

- Pull the roster with `herdr agent list` (prints single-line JSON; no `--json` flag) via `$HERDR_BIN_PATH` (the CLI is itself the
  framed socket client — no hand-written protocol). On non-zero exit or zero agents → **HOLD**
  (return null; never wipe rows on a transient blip).
- Verified live shape (trimmed):
  ```json
  {"result":{"agents":[{
    "agent":"claude",
    "agent_session":{"kind":"claude","source":"herdr:claude","value":"31a8d840-..."},
    "agent_status":"idle",           // idle | working | blocked | unknown
    "cwd":"/Users/lachlan/Projects/lachieh/herdr-plugin-cmux",
    "foreground_cwd":"/Users/lachlan/Projects/lachieh/herdr-plugin-cmux",
    "focused":true,
    "pane_id":"w...:p1", "tab_id":"w...:t1", "terminal_id":"...",
    "workspace_id":"w655008d4e60e19", "revision":42
  }]}}
  ```
- **Identity / dedupe key = `source` + `agent_session.value`.** `value` is stable & unique per
  session (verified, incl. surviving pane close/reopen). Namespaced by `source`
  (e.g. `herdr:claude`) because `value` is the agent's *native* session UUID, not herdr-minted, so
  different agent types could theoretically collide. `pane_id`/`tab_id`/`workspace_id`/`terminal_id`
  are treated as **volatile** — re-read every reconcile, used only as the current focus target.
- Row label = `basename(foreground_cwd)` (every agent is literally named `claude`; the worktree
  basename disambiguates, e.g. `adaptive-waddling-wirth`). Fallback: `claude:<paneTail>`.

---

## 7. cmux write design

Shell the public `cmux` CLI over its socket, authenticated by `CMUX_SOCKET_PASSWORD` injected from
the plugin's config. Socket auto-discovered (no `--socket` needed). All commands use `--json` and
parse each output line as `{"ok":true,"result":{...}}`.

**Verified field names:** workspace `id` (uuid), `ref` (short ref), **`title`** (the display name —
*not* `name`). Get the UUID **directly** from create output — do **not** string-match titles
(racy: two workspaces can share a title):

| Action | Command |
|---|---|
| **Create row** | `cmux new-workspace --name "<label> · k<key8>" --description "herdr agent (<status>)" --cwd <cwd> --window <winId> --focus false --group <groupRef> --json --id-format uuids` → read `result.id` |
| **Set/refresh pill** | `cmux set-status agent "<label>" --icon <sf> --color <hex> --priority <n> --workspace <wsUuid>` (fixed key `agent` → updates in place) |
| **Remove** | `cmux close-workspace --workspace <wsUuid>` (or `cmux clear-status agent --workspace <wsUuid>` when `REMOVE_ON_EXIT=false`) |
| **Attention** | `cmux notify --title "<label>: needs input" --workspace <wsUuid>` (blocked/done, if `NOTIFY_ON` set) |

- `--window <winId>`: `new-workspace` creates "in the caller's window" but the plugin has no
  window, so resolve `<winId>` from `cmux list-windows` (or config `CMUX_WINDOW`). `doctor` warns
  if zero windows exist.
- `--group <groupRef>`: cluster all mirror rows under one group so they don't scatter the user's
  real workspaces. N agents ⇒ N mirror workspaces (9 live agents in this session — document the
  footprint).
- Title marker `k<key8>` = short hash of `source+value`, letting `readMirrors()` reconstruct the
  session→workspace map from `cmux list-workspaces` alone.
- Escape hatch for anything the CLI lacks: `cmux rpc <method> <json>`.

### Status → pill mapping

| herdr status | cmux pill |
|---|---|
| `working` | `set-status agent "Working" --icon hammer --color #ff9500 --priority 50` |
| `blocked` | `set-status agent "Needs input" --icon exclamationmark.triangle --color #ff3b30 --priority 100` (sorts to top) + optional `notify` |
| `idle` | `set-status agent "Idle" --icon moon --color #8e8e93 --priority 10` |
| `done`* | `set-status agent "Done" --icon bell.badge --color #34c759 --priority 90` + optional `notify` |
| `unknown` | `set-status agent "?" --icon questionmark.circle --color #8e8e93 --priority 5` — HELD, never deleted (a detection blip must not remove the row) |
| gone (exited/closed) | `REMOVE_ON_EXIT=true` → `close-workspace`; else `set-status agent "Exited" --color #8e8e93` |

\* `done` rarely appears in `herdr agent list` (surfaces via `herdr wait` / events), so a
finished-unviewed agent usually renders as `idle`. Documented, not silently wrong.

---

## 8. Click-through (focus in herdr)

The mirror workspace's terminal is **thin** (no per-agent attach PTY): it runs `bin/row.mjs
<key>` which prints the agent's identity + a "focused in herdr on select" hint (optionally tailing
`herdr agent read <id>` for a preview).

The actual focus happens **event-driven**: `bin/bridge.mjs` tails `cmux events --category workspace`;
on `workspace.focused` for one of our mirror workspaces it maps workspace → `key` → current
`terminal_id` (re-read from the roster) and runs `herdr agent focus <terminal_id>` (verified to
focus the exact herdr split), plus focuses the herdr host surface in cmux. This keeps the target
correct across pane compaction.

Optional config `CLICK_MODE=attach` instead seeds the workspace command with
`exec herdr agent attach <terminal_id>` for a live interactive view (heavier: 1 PTY/agent + a
feedback-loop guard keyed on session UUID). Default is `focus`.

---

## 9. Lifecycle, cleanup & restart recovery

- **Agent added:** roster has a key with no matching mirror → create + initial pill.
- **Agent removed** (`pane.exited`/`pane.closed`, or simply absent from roster): mirror exists but
  key not in roster → close (or gray, per `REMOVE_ON_EXIT`). Stale mirrors whose decoded key is
  gone are closed every reconcile.
- **HOLD guard:** `herdr agent list` fails or returns zero → do nothing (never wipe on a blip).
- **cmux restart:** all mirror workspaces vanish → next trigger's `cmux list-workspaces` returns
  none → every row recreated from the roster. (This is the property a naive event-only design lacks.)
- **herdr restart:** roster re-reads; rows rebind by session key.
- **Plugin crash mid-create:** a workspace with a title marker but no map entry is re-adopted from
  the marker next reconcile (no duplicate).
- **User manually closes a mirror row while the agent lives:** naive reconcile would resurrect it.
  Mitigation: `bin/bridge.mjs` tails `cmux events` for `workspace.closed` → records the key in a
  suppress-list; plus a heuristic — *all* mirrors absent at once ⇒ cmux restart ⇒ recreate; a
  *single* mirror absent while siblings persist ⇒ user close ⇒ suppress.
- **`pane.exited` vs `pane.closed`:** mutually exclusive per gesture — both wired as triggers; both
  just run a full reconcile, so it doesn't matter which fires.

---

## 10. Repo layout

```
herdr-plugin-cmux/
├── herdr-plugin.toml        # manifest: 4 [[events]], 2 [[actions]] (sync, doctor), 1 [[panes]] (bridge)
├── bin/
│   ├── reconcile.mjs        # driver for all [[events]] hooks + `sync` action: read→reconcile→apply; HOLD on read failure; --dry-run/--full
│   ├── doctor.mjs           # validate cmux password auth; print exact cmux.json fix; --dock writes zero-socket fallback
│   ├── bridge.mjs           # optional [[panes]] loop: periodic reconcile + tail `cmux events` (focus click-through + user-close suppress)
│   └── row.mjs              # thin per-mirror-workspace terminal content (identity + hint)
├── lib/
│   ├── reconcile.mjs        # PURE reconcile(roster, mirrors, cfg) -> Action[]  (the unit-tested core, no I/O)
│   ├── herdr.mjs            # readRoster(): `herdr agent list` (prints single-line JSON; no `--json` flag) → normalized agents; null on failure
│   ├── cmux.mjs             # cmux() spawnSync wrapper (injects CMUX_SOCKET_PASSWORD); readMirrors(); applyAction() w/ UUID read-back
│   ├── config.mjs           # reads $HERDR_PLUGIN_CONFIG_DIR/.env; status→pill table; label helper; NOTIFY_ON; REMOVE_ON_EXIT; CMUX_WINDOW; group; CLICK_MODE
│   └── state.mjs            # load/save $HERDR_PLUGIN_STATE_DIR/map.json (last-status cache + suppress-list) — optimization only
├── test/
│   ├── reconcile.test.mjs   # node:test fixtures: add/remove/status-change/hold-on-empty/restart-recreate/user-close-suppress
│   └── fixtures/            # captured `herdr agent list` + `cmux list-workspaces` JSON
├── config/.env.example      # CMUX_SOCKET_PASSWORD, CMUX_WINDOW, colors/icons, REMOVE_ON_EXIT, NOTIFY_ON, GROUP_REF, RECONCILE_INTERVAL_MS, CLICK_MODE
└── README.md                # install, the one-time cmux password setup, doctor usage, Dock fallback, click-through explanation
```

## 11. Manifest (`herdr-plugin.toml`)

```toml
id = "lachieh.cmux-bridge"
name = "cmux agent sidebar bridge"
version = "0.1.0"
min_herdr_version = "0.7.0"
description = "Mirror each herdr agent into the cmux sidebar with a live idle/working/blocked status pill and click-through."
platforms = ["macos"]

# lifecycle triggers: every hook just runs a full idempotent reconcile
[[events]]
on = "pane.agent_status_changed"
command = ["node", "bin/reconcile.mjs"]
[[events]]
on = "pane.agent_detected"
command = ["node", "bin/reconcile.mjs"]
[[events]]
on = "pane.exited"
command = ["node", "bin/reconcile.mjs"]
[[events]]
on = "pane.closed"
command = ["node", "bin/reconcile.mjs"]

# manual / keybindable actions
[[actions]]
id = "sync"
title = "cmux bridge: sync agents to sidebar"
command = ["node", "bin/reconcile.mjs", "--full"]
[[actions]]
id = "doctor"
title = "cmux bridge: check setup"
command = ["node", "bin/doctor.mjs"]

# optional long-lived reconcile + events loop (idle staleness, cmux restart, click-through focus)
[[panes]]
id = "bridge"
title = "cmux bridge (live)"
placement = "overlay"
command = ["node", "bin/bridge.mjs"]
```

---

## 12. Milestones

- **M1 — verification gate + smallest e2e proof.** Back up `cmux.json`; set
  `automation.socketControlMode="password"` + a random `socketPassword`; `cmux reload-config`;
  **prove a socket write succeeds from a herdr-spawned (non-descendant) shell** with
  `CMUX_SOCKET_PASSWORD`. Then a minimal `sync` creates ONE cmux workspace for the focused herdr
  agent and sets its pill; flip that agent idle↔working → pill updates in place.
  *Proves the entire critical path.* **If auth is refused → the socket approach is invalid; fall
  back to the Dock roster and revisit.**
- **M2 — pure reconcile engine + full roster.** `lib/reconcile.mjs` + `node:test` fixtures; mirror
  ALL agents; title markers; `--dry-run` prints exact cmux commands.
- **M3 — live via `[[events]]`.** Wire the 4 hooks; `map.json` dedupe; measure status-flip latency.
- **M4 — lifecycle, cleanup & restart recovery.** exit/close removal, cmux-restart recreation,
  user-close suppression + `bridge.mjs` events tail, HOLD-on-empty.
- **M5 — click-through, polish & publish.** `bridge.mjs` focus-on-`workspace.focused`, `--group`
  clustering, notify on blocked, README + `doctor --dock` fallback; publish with GitHub topic
  `herdr-plugin` (`herdr plugin install lachieh/herdr-plugin-cmux`).

---

## 13. Install & dev loop

**Dev:**
1. `herdr plugin link .` (skips `[[build]]`; live dev).
2. One-time cmux setup: back up `~/.config/cmux/cmux.json`, set
   `automation.socketControlMode="password"` + `automation.socketPassword="<token>"`, then
   **fully quit and reopen cmux** (⌘Q + relaunch — a `reload-config` does NOT rebind the socket).
3. Write the same token into `$(herdr plugin config-dir lachieh.cmux-bridge)/.env` as
   `CMUX_SOCKET_PASSWORD`.
4. Iterate: edit `.mjs` → `herdr plugin action invoke lachieh.cmux-bridge.sync` or flip a real
   agent's status.
5. Debug: `herdr plugin log list --plugin lachieh.cmux-bridge` (per-invocation stdout/stderr/exit);
   `node bin/reconcile.mjs --dry-run` (print cmux commands, no side effects); `node bin/doctor.mjs`.

**Test:** `node --test test/`.

**Prod:** push to GitHub `lachieh/herdr-plugin-cmux` with topic `herdr-plugin`; users run
`herdr plugin install lachieh/herdr-plugin-cmux` then `... action invoke lachieh.cmux-bridge.doctor`.

**Fallback (no password mode):** `node bin/doctor.mjs --dock` writes a `~/.config/cmux` control that
renders `herdr agent list` as a read-only cmux roster with zero socket writes.

---

## 14. Edge cases

- `herdr agent list` fails / empty → **HOLD** (never wipe rows).
- Rapid status flaps → `map.json` last-status dedupe; reconcile idempotent even without the cache.
- `pane_id`/`tab_id`/`workspace_id` compaction & reuse → never used as keys; identity is `source+value`.
- cmux restart → all mirrors gone → recreated from roster.
- User closes a mirror row while agent lives → suppress-list + all-absent-vs-single-absent heuristic.
- `new-workspace` needs a target window but plugin has none → resolve from `cmux list-windows` /
  `CMUX_WINDOW`; `doctor` warns if zero windows.
- `done` rarely in `herdr agent list` → finished-unviewed agent renders `idle` (documented).
- Every agent literally named `claude` → label from `basename(foreground_cwd)`.
- N agents = N mirror workspaces (+N thin PTYs) → cluster via `--group`; document footprint.
- `CMUX_SOCKET_PASSWORD` in the plugin config `.env` is a local secret → recommend narrowest
  `password` mode (not `allowAll`); document the trust implication.

---

## 15. Open questions / risks

1. **[M1 GATE]** Does `password` mode actually admit the non-descendant plugin? Only the `cmuxOnly`
   *failure* is proven. **Blocks everything else.**
2. Exact JSON field for the workspace title in `cmux list-workspaces --json` (expected `title`;
   confirm) and the `new-workspace --json` create-output UUID field (`id`).
3. Do `pane.exited` AND `pane.closed` both fire the plugin argv when an agent goes away, and what
   are their payloads? (Both wired as triggers regardless.)
4. Can a mirror workspace be created "thin" (no heavy shell) to reduce the N-PTY footprint, or does
   every workspace spawn a full terminal?
5. Reliability of the user-closed vs cmux-restart heuristic (all-absent vs single-absent).
6. `done` — does it ever appear in `herdr agent list` on a version-matched server, or only via
   `herdr wait` / events?
7. `attach` feedback loop (only relevant if `CLICK_MODE=attach`): does attach in a cmux PTY
   register a new herdr agent? Mitigated by keying on session UUID; confirm if used.

---

## 16. Verification results (from the research workflow)

Load-bearing claims were re-checked **by execution**. Tally: **2 confirmed, 1 refuted, 5 partial.**

- ✅ **Confirmed:** `herdr agent attach <terminal_id>` renders a live agent without stealing it from
  herdr's UI and without registering a new herdr agent.
- ✅ **Confirmed:** `agent_session.value` is a stable, unique per-session UUID — safe dedupe key
  (namespace by `source`).
- ❌ **Refuted → corrected:** a herdr plugin **cannot** shell `cmux <socket-command>` under default
  `cmuxOnly` (Broken pipe / errno 32, reproduced live). *Correction:* requires `password` mode (§3).
- 🟨 **Partial:** password mode is the right architecture and the gate is password-keyed (not
  ancestry) at the contract level, but end-to-end write success is **not yet observed** → M1.
- 🟨 **Partial:** `[[events]]` hooks fire per transition for the four events (confirmed first-class),
  but exit/close are mutually exclusive per gesture → handled by reconcile.
- 🟨 **Partial:** `set-status`/`close-workspace` target an arbitrary workspace (no per-workspace
  ACL — true at the contract level; couldn't execute-prove due to the connection gate).
- 🟨 **Partial:** recover the UUID via `cmux new-workspace --json --id-format uuids` (not by
  title-matching — racy); title field is `title`, uuid `id`.
- 🟨 **Partial:** cmux auto-discovers its socket (true), but a password alone is insufficient until
  `socketControlMode` is widened from `cmuxOnly`.

---

## 17. Alternatives considered (not chosen)

- **Standalone launchd bridge daemon** — best code testability, but non-plugin identity regresses
  install/debug and loses repo/blessed-pattern fit. We adopt its *pure reconcile internals* inside
  the plugin instead.
- **cmux custom SwiftUI sidebar** rendering the herdr roster — best native UX + correct focus, but
  the external-agent-injection capability it needs is **absent** in cmux 0.64.17 (would require an
  unmerged upstream PR / fork of a GPL app). Revisit if cmux ships it.
- **cmux Vault `vault.agents` registry** — registers JSONL-backed agents cmux can detect/resume in
  its own terminals; oriented at session-restore, not mirroring external herdr agents. Possible
  future complement.
- **cmux feed / notifications only** — transient; doesn't produce persistent per-agent sidebar rows.

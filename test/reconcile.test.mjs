import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

import { reconcile } from '../lib/reconcile.mjs';
import { parseAgentList, normalizeRoster, normalizeAgent, spaceGroupName, cleanTaskEvidence } from '../lib/herdr.mjs';
import { keyHash, marker, describeRow } from '../lib/cmux.mjs';

const here = dirname(fileURLToPath(import.meta.url));

// Small helpers to build fake agents/mirrors.
const agent = (key, status, over = {}) => ({
  key,
  status,
  label: over.label || key.split(':').pop().slice(0, 6),
  cwd: over.cwd || '/tmp',
  terminalId: over.terminalId || 'term_' + key.slice(-4),
  ...over,
});
const mirror = (key, status, wsUuid = 'ws-' + key.slice(-4)) => ({ key, status, wsUuid });
const types = (actions) => actions.map((a) => a.type);

// ---------------------------------------------------------------------------
// HOLD semantics — never wipe on a blip.
// ---------------------------------------------------------------------------
test('null roster (read failure) → HOLD, no actions even if mirrors exist', () => {
  assert.deepEqual(reconcile(null, [mirror('a', 'idle')]), []);
});

test('empty roster → HOLD, does not close existing mirrors', () => {
  assert.deepEqual(reconcile([], [mirror('a', 'idle'), mirror('b', 'working')]), []);
});

// ---------------------------------------------------------------------------
// Create / update / remove.
// ---------------------------------------------------------------------------
test('new agent with no mirror → create', () => {
  const actions = reconcile([agent('k1', 'working')], []);
  assert.deepEqual(types(actions), ['create']);
  assert.equal(actions[0].key, 'k1');
  assert.equal(actions[0].status, 'working');
});

test('agent with matching mirror, same status → no-op (idempotent)', () => {
  const actions = reconcile([agent('k1', 'idle')], [mirror('k1', 'idle')]);
  assert.deepEqual(actions, []);
});

test('agent status changed → single status action carrying the wsUuid', () => {
  const actions = reconcile([agent('k1', 'working')], [mirror('k1', 'idle', 'ws-1')]);
  assert.deepEqual(types(actions), ['status']);
  assert.equal(actions[0].wsUuid, 'ws-1');
  assert.equal(actions[0].status, 'working');
});

test('agent gone from roster (roster non-empty) → close by default', () => {
  const actions = reconcile([agent('k1', 'idle')], [mirror('k1', 'idle'), mirror('gone', 'working', 'ws-x')]);
  assert.deepEqual(types(actions), ['close']);
  assert.equal(actions[0].wsUuid, 'ws-x');
});

test('agent gone with removeOnExit=false → gray it instead of closing', () => {
  const actions = reconcile(
    [agent('k1', 'idle')],
    [mirror('k1', 'idle'), mirror('gone', 'working', 'ws-x')],
    { removeOnExit: false },
  );
  assert.deepEqual(types(actions), ['status']);
  assert.equal(actions[0].status, 'exited');
  assert.equal(actions[0].wsUuid, 'ws-x');
});

// ---------------------------------------------------------------------------
// Self-healing.
// ---------------------------------------------------------------------------
test('cmux restart (all mirrors vanished) → recreate every row from roster', () => {
  const roster = [agent('a', 'idle'), agent('b', 'working'), agent('c', 'blocked')];
  const actions = reconcile(roster, []);
  assert.deepEqual(types(actions), ['create', 'create', 'create']);
  assert.deepEqual(actions.map((x) => x.key), ['a', 'b', 'c']);
});

test('user-closed row is suppressed → not recreated', () => {
  const roster = [agent('a', 'idle'), agent('b', 'working')];
  const actions = reconcile(roster, [], { suppress: ['a'] });
  assert.deepEqual(types(actions), ['create']);
  assert.equal(actions[0].key, 'b');
});

// ---------------------------------------------------------------------------
// Notifications + unknown handling.
// ---------------------------------------------------------------------------
test('notifyOn=blocked → transition into blocked emits status + notify', () => {
  const actions = reconcile([agent('k1', 'blocked')], [mirror('k1', 'working')], { notifyOn: ['blocked'] });
  assert.deepEqual(types(actions), ['status', 'notify']);
});

test('notifyOn=blocked → new blocked agent emits create + notify', () => {
  const actions = reconcile([agent('k1', 'blocked')], [], { notifyOn: new Set(['blocked']) });
  assert.deepEqual(types(actions), ['create', 'notify']);
});

test('holdUnknown (default) → transition to unknown keeps the existing pill', () => {
  const actions = reconcile([agent('k1', 'unknown')], [mirror('k1', 'working')]);
  assert.deepEqual(actions, []);
});

test('new agent reporting unknown still gets a row (create with "?" )', () => {
  const actions = reconcile([agent('k1', 'unknown')], []);
  assert.deepEqual(types(actions), ['create']);
  assert.equal(actions[0].status, 'unknown');
});

// ---------------------------------------------------------------------------
// Real herdr fixture wiring.
// ---------------------------------------------------------------------------
test('normalizes the real captured herdr roster', () => {
  const raw = readFileSync(join(here, 'fixtures', 'herdr-agent-list.json'), 'utf8');
  const roster = normalizeRoster(parseAgentList(raw));
  assert.ok(roster.length >= 1, 'has agents');
  for (const a of roster) {
    assert.match(a.key, /^herdr:/, 'key is source-namespaced');
    assert.ok(a.sessionId, 'has a session id');
    assert.ok(['idle', 'working', 'blocked', 'done', 'unknown'].includes(a.status));
    assert.ok(a.label && a.label.length > 0, 'has a label');
    assert.ok(a.terminalId, 'has a terminal id for focus/attach');
  }
  // keys are unique across the roster
  const keys = new Set(roster.map((a) => a.key));
  assert.equal(keys.size, roster.length, 'keys are unique');
});

test('normalizeRoster drops non-agent panes (no agent_session.value)', () => {
  const raw = [
    { agent: 'claude', agent_session: { source: 'herdr:claude', value: 'abc' }, agent_status: 'idle', terminal_id: 't1' },
    { agent: undefined, agent_session: undefined, agent_status: 'unknown', terminal_id: 't2' }, // the bridge pane
    { agent: 'claude', agent_session: { value: '' }, agent_status: 'idle', terminal_id: 't3' }, // empty session
  ];
  const roster = normalizeRoster(raw);
  assert.equal(roster.length, 1);
  assert.equal(roster[0].sessionId, 'abc');
});

test('normalizeAgent derives label from foreground worktree basename', () => {
  const a = normalizeAgent({
    agent: 'claude',
    agent_session: { source: 'herdr:claude', value: 'abc-123' },
    agent_status: 'working',
    cwd: '/Users/x/proj',
    foreground_cwd: '/Users/x/proj/.claude/worktrees/adaptive-waddling-wirth',
    terminal_id: 'term_1',
    pane_id: 'w1:p6',
  });
  assert.equal(a.label, 'adaptive-waddling-wirth');
  assert.equal(a.key, 'herdr:claude:abc-123');
  assert.equal(a.status, 'working');
});

test('spaceGroupName uses the space label, disambiguating duplicates by number', () => {
  const spaces = [
    { workspaceId: 'w1', label: 'buildy', number: 1 },
    { workspaceId: 'w2', label: 'tambo', number: 2 },
    { workspaceId: 'w3', label: 'buildy', number: 4 },
  ];
  assert.equal(spaceGroupName(spaces, 'w2'), 'tambo');       // unique → bare label
  assert.equal(spaceGroupName(spaces, 'w1'), 'buildy #1');   // duplicate → label + number
  assert.equal(spaceGroupName(spaces, 'w3'), 'buildy #4');
  assert.equal(spaceGroupName(spaces, 'nope'), 'nope');      // unknown → falls back to id
});

// ---------------------------------------------------------------------------
// Attach re-seed on terminal change (M6).
// ---------------------------------------------------------------------------
test('attach mode + seeded-terminal mismatch → reseed carrying the create fields', () => {
  const roster = [agent('k1', 'working', { terminalId: 'term_new', cwd: '/w' })];
  const mirrors = [{ ...mirror('k1', 'working', 'ws-1'), attachedTerm: 'term_old' }];
  const actions = reconcile(roster, mirrors, { clickMode: 'attach' });
  assert.deepEqual(types(actions), ['reseed']);
  assert.equal(actions[0].wsUuid, 'ws-1');
  assert.equal(actions[0].terminalId, 'term_new');
  assert.equal(actions[0].status, 'working');
  assert.ok(actions[0].label && actions[0].cwd, 'reseed carries what create needs');
});

test('attach mode + matching terminal → no reseed', () => {
  const roster = [agent('k1', 'idle', { terminalId: 'term_a' })];
  const mirrors = [{ ...mirror('k1', 'idle'), attachedTerm: 'term_a' }];
  assert.deepEqual(reconcile(roster, mirrors, { clickMode: 'attach' }), []);
});

test('focus mode never reseeds, even on a mismatch', () => {
  const roster = [agent('k1', 'idle', { terminalId: 'term_new' })];
  const mirrors = [{ ...mirror('k1', 'idle'), attachedTerm: 'term_old' }];
  assert.deepEqual(reconcile(roster, mirrors, { clickMode: 'focus' }), []);
});

test('mirror without a seeded terminal (legacy row) never reseeds', () => {
  const roster = [agent('k1', 'idle', { terminalId: 'term_new' })];
  assert.deepEqual(reconcile(roster, [mirror('k1', 'idle')], { clickMode: 'attach' }), []);
});

test('reseed replaces the status action and still notifies on a watched transition', () => {
  const roster = [agent('k1', 'blocked', { terminalId: 'term_new' })];
  const mirrors = [{ ...mirror('k1', 'working', 'ws-1'), attachedTerm: 'term_old' }];
  const actions = reconcile(roster, mirrors, { clickMode: 'attach', notifyOn: ['blocked'] });
  assert.deepEqual(types(actions), ['reseed', 'notify']);
});

test('describeRow embeds the seeded terminal only when asked', () => {
  const a = { agent: 'claude', cwd: '/tmp', key: 'k1', terminalId: 'term_x' };
  assert.ok(describeRow(a, true).endsWith('+term_x'));
  assert.ok(!describeRow(a, false).includes('+term_x'));
});

// ---------------------------------------------------------------------------
// Task-line evidence cleaning.
// ---------------------------------------------------------------------------
test('cleanTaskEvidence strips spinner glyphs and leading symbols', () => {
  assert.equal(cleanTaskEvidence('⠂ Review GitHub issue #2173'), 'Review GitHub issue #2173');
  assert.equal(cleanTaskEvidence('✳ Evaluate cmux extensions'), 'Evaluate cmux extensions');
});

test('cleanTaskEvidence rejects bare shell prompts and empty input', () => {
  assert.equal(cleanTaskEvidence('❯\n'), '');
  assert.equal(cleanTaskEvidence('❯ typed but not a task\n'), '');
  assert.equal(cleanTaskEvidence(''), '');
  assert.equal(cleanTaskEvidence(null), '');
});

test('cleanTaskEvidence collapses whitespace and truncates long lines', () => {
  assert.equal(cleanTaskEvidence('fix the   thing\n'), 'fix the thing');
  const long = cleanTaskEvidence(`do ${'x'.repeat(200)}`);
  assert.equal(long.length, 80);
  assert.ok(long.endsWith('…'));
});

// ---------------------------------------------------------------------------
// Row identity marker + description.
// ---------------------------------------------------------------------------
test('marker is a compact stable hash, distinct across keys', () => {
  assert.match(marker('herdr:claude:abc'), /^hpcx:[0-9a-f]{12}$/);
  assert.equal(marker('herdr:claude:abc'), marker('herdr:claude:abc'));
  assert.notEqual(marker('herdr:claude:abc'), marker('herdr:claude:abd'));
  assert.equal(keyHash('herdr:claude:abc').length, 12);
});

test('describeRow is human-first (agent · ~cwd · marker)', () => {
  const d = describeRow({
    agent: 'claude',
    cwd: `${process.env.HOME}/Projects/x`,
    key: 'herdr:claude:abc',
  });
  assert.match(d, /^claude agent · ~\/Projects\/x · hpcx:[0-9a-f]{12}$/);
});

test('a full reconcile against the real roster from an empty cmux → all creates', () => {
  const raw = readFileSync(join(here, 'fixtures', 'herdr-agent-list.json'), 'utf8');
  const roster = normalizeRoster(parseAgentList(raw));
  const actions = reconcile(roster, []);
  assert.equal(actions.filter((a) => a.type === 'create').length, roster.length);
});

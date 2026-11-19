import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import vm from 'node:vm';

const load = (file) => {
  const path = fileURLToPath(new URL(`../../../roamies/${file}`, import.meta.url));
  const ctx = { window: {} };
  ctx.globalThis = ctx;
  vm.createContext(ctx);
  vm.runInContext(readFileSync(path, 'utf8'), ctx, { filename: file });
  return ctx.window.Roamie.orbState;
};

const S = load('orb-state.js');
console.log('orb state tests: start');

// A chain of events, each applied to the last state, as the page does.
const run = (...events) => {
  let s = { name: 'idle', since: 0, until: 0, reason: null, seq: 0 };
  for (const [i, e] of events.entries()) s = S.reduce(s, e, i * 100);
  return s;
};
const nameOf = (...events) => run(...events).name;

// ---- the states exist, and idle is what nothing does ----
assert.equal(S.STATES.length, 9);
for (const n of ['idle', 'listening', 'thinking', 'tool_execution', 'speaking', 'success', 'error', 'offline', 'sleeping']) assert.ok(S.isState(n), n);
assert.equal(S.reduce(null, { type: 'nothing' }, 0).name, 'idle', 'no state and no event is idle');
assert.equal(nameOf({ type: 'unknown' }), 'idle', 'an unknown event changes nothing');
assert.equal(nameOf({}), 'idle', 'an event with no type changes nothing');
assert.equal(nameOf(null), 'idle');
assert.equal(S.reduce({ name: 'banana' }, { type: 'turn_start' }, 0).name, 'thinking', 'a corrupt current state is replaced, not trusted');

// ---- the turn ----
assert.equal(nameOf({ type: 'turn_start' }), 'thinking');
assert.equal(nameOf({ type: 'turn_start' }, { type: 'speech_start' }), 'speaking');
assert.equal(nameOf({ type: 'turn_start' }, { type: 'speech_start' }, { type: 'speech_end' }, { type: 'x' }), 'success');
assert.equal(nameOf({ type: 'turn_start' }, { type: 'speech_start' }, { type: 'clear' }), 'idle');

// ---- tools win over the voice while they run ----
assert.equal(nameOf({ type: 'turn_start' }, { type: 'tool_start' }, { type: 'speech_start' }), 'tool_execution',
  'a tool running is what matters, even while it talks');
assert.equal(nameOf({ type: 'turn_start' }, { type: 'tool_start' }, { type: 'tool_end' }), 'thinking', 'the turn goes on after a tool');
assert.equal(nameOf({ type: 'tool_end' }), 'idle', 'a tool ending out of nowhere changes nothing');

// ---- listening ----
assert.equal(nameOf({ type: 'listen_start' }), 'listening');
assert.equal(nameOf({ type: 'listen_start' }, { type: 'listen_end' }), 'idle');
assert.equal(nameOf({ type: 'listen_end' }), 'idle', 'a cancelled listen that never started is not an error');

// ---- success and error are momentary, and settle by themselves ----
{
  const done = S.reduce(S.reduce({ name: 'idle', seq: 0 }, { type: 'speech_start' }, 0), { type: 'speech_end' }, 100);
  assert.equal(done.name, 'success');
  assert.equal(done.until, 100 + S.HOLD.success, 'it holds for a moment');
  assert.equal(S.reduce(done, { type: 'nothing' }, done.until - 1).name, 'success', 'and is still success just before');
  assert.equal(S.reduce(done, { type: 'nothing' }, done.until).name, 'idle', 'and settles on its own after, with no event');
}
{
  const bad = S.reduce({ name: 'idle', seq: 0 }, { type: 'failure', reason: 'tool failed' }, 10);
  assert.equal(bad.name, 'error');
  assert.equal(bad.reason, 'tool failed', 'why it failed travels with the state');
  assert.equal(S.reduce(bad, { type: 'nothing' }, bad.until).name, 'idle');
  const long = S.reduce({ name: 'idle', seq: 0 }, { type: 'failure', reason: 'x'.repeat(400) }, 0);
  assert.equal(long.reason.length, 120, 'a reason is bounded');
}

// ---- offline is sticky: only the provider coming back clears it ----
{
  assert.equal(nameOf({ type: 'provider', status: 'unavailable', offline: true }), 'offline');
  assert.equal(nameOf({ type: 'provider', status: 'unavailable', offline: true }, { type: 'speech_start' }), 'offline',
    'a queued voice does not pretend the app is online');
  assert.equal(nameOf({ type: 'provider', status: 'unavailable', offline: true }, { type: 'provider', status: 'ready' }), 'idle');
  assert.equal(nameOf({ type: 'provider', status: 'unavailable' }), 'idle',
    'an unavailable provider that is not "no model at all" is not offline (a rate limit, say)');
}

// ---- sleeping: the pointer has been still a while; only a quiet entity dozes, and any activity wakes it ----
{
  assert.equal(nameOf({ type: 'sleep' }), 'sleeping');
  assert.equal(nameOf({ type: 'sleep' }, { type: 'wake' }), 'idle', 'a moved pointer wakes it');
  assert.equal(nameOf({ type: 'sleep' }, { type: 'sleep' }), 'sleeping', 'dozing twice is dozing once');
  assert.equal(nameOf({ type: 'turn_start' }, { type: 'sleep' }), 'thinking', 'a turn going on never dozes');
  assert.equal(nameOf({ type: 'listen_start' }, { type: 'sleep' }), 'listening', 'nor does listening');
  assert.equal(nameOf({ type: 'failure', reason: 'x' }, { type: 'sleep' }), 'error', 'nor an error still showing');
  assert.equal(nameOf({ type: 'sleep' }, { type: 'clear' }), 'idle', 'and a new chat brings it back');
  assert.equal(nameOf({ type: 'sleep' }, { type: 'provider', status: 'ready' }), 'sleeping', 'a provider tick is not a wake');
  assert.equal(S.fromFrame({ sleepy: 1 }), 'sleeping');
  assert.equal(S.fromFrame({ sleepy: 0.2 }), 'idle', 'a pointer that just moved is not asleep');
  assert.equal(S.fromFrame({ sleepy: 1, mode: 'listen' }), 'listening', 'listening outranks dozing');
  // A dozing entity is stronger than a resting one, so an event-driven sleep is not washed out by an idle frame.
  assert.equal(S.strongest('sleeping', 'idle'), 'sleeping');
  assert.equal(S.strongest('sleeping', 'listening'), 'listening');
  assert.equal(S.strongest('sleeping', 'error'), 'error');
}

// ---- duplicates never re-render ----
{
  const once = S.reduce({ name: 'idle', seq: 0 }, { type: 'turn_start' }, 5);
  const twice = S.reduce(once, { type: 'turn_start' }, 6);
  assert.equal(twice, once, 'the same event twice returns the very same object (no new seq, no new since)');
  const speck = S.reduce({ name: 'idle', seq: 0 }, { type: 'speech_start' }, 5);
  assert.equal(S.reduce(speck, { type: 'speech_start' }, 6), speck);
  assert.equal(S.reduce({ name: 'idle', seq: 0 }, { type: 'listen_start' }, 1).since, 1, 'a new state stamps when it began');
  assert.equal(twice.since, 5, 'and a repeat keeps the original stamp');
}

// ---- what a frame knows, for the renderer ----
assert.equal(S.fromFrame(null), 'idle');
assert.equal(S.fromFrame({ offline: true, mode: 'talk' }), 'offline', 'offline outranks everything');
assert.equal(S.fromFrame({ tooling: true, mode: 'talk' }), 'tool_execution', 'a tool outranks the voice');
assert.equal(S.fromFrame({ mode: 'think' }), 'thinking');
assert.equal(S.fromFrame({ mode: 'talk' }), 'speaking');
assert.equal(S.fromFrame({ speaking: true }), 'speaking');
assert.equal(S.fromFrame({ mode: 'listen' }), 'listening');
assert.equal(S.strongest('thinking', 'tool_execution'), 'tool_execution');
assert.equal(S.strongest('idle', 'success'), 'success');

console.log('orb state tests: all passed');

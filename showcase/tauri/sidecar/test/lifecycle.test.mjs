import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { lifecycleLog, lifecycleStages, parseLifecycleLine, readStartup, stageLabel, startupReport } from '../lifecycle.mjs';

console.log('lifecycle tests: start');

// A line as main.rs writes it (epoch ms), and one from the old seconds format.
const T = 1794789783000;
const L = (ms, desktop, ui, menu, provider = 'unknown', detail = '-') =>
  `${ms} desktop=${desktop} ui_ready=${ui} menu_ready=${menu} provider=${provider} detail=${detail}`;

{
  const s = parseLifecycleLine(L(1794789783123, 'starting', false, false));
  assert.equal(s.at, 1794789783123, 'milliseconds are read as they are');
  assert.equal(s.desktop, 'starting');
  assert.equal(s.uiReady, false);
  assert.equal(s.detail, null, '- is no detail');
}

{
  const s = parseLifecycleLine('1794789783 desktop=starting ui_ready=false menu_ready=false provider=unknown detail=-');
  assert.equal(s.at, 1794789783000, 'whole seconds (older builds) become milliseconds');
}

{
  const s = parseLifecycleLine(L(1794789785000, 'error', false, false, 'unknown', 'Sidecar handshake timeout'));
  assert.equal(s.detail, 'Sidecar handshake timeout', 'a detail with spaces is the rest of the line');
}

assert.equal(parseLifecycleLine(''), null);
assert.equal(parseLifecycleLine('not a record'), null);
assert.equal(parseLifecycleLine('12 desktop='), null, 'a state is required');

{
  // The real order, with the duplicate lines the shell writes when two signals land in the same tick.
  const text = [
    L(T + 1000, 'starting', false, false),
    L(T + 1000, 'starting', false, false),
    L(T + 2600, 'starting', true, false),
    L(T + 3000, 'starting', true, true),
    L(T + 3000, 'starting', true, true),
    L(T + 3150, 'desktop_ready', true, true, 'ready'),
  ].join('\n');
  const stages = lifecycleStages(text);
  assert.deepEqual(stages.map((s) => s.desktop), ['starting', 'starting', 'starting', 'desktop_ready'], 'repeats fold into the step they repeat');
  assert.equal(stages[0].repeats, 2);
  assert.deepEqual(stages.map((s) => s.sinceStart), [0, 1600, 2000, 2150], 'timing is from the first recorded step');
  assert.deepEqual(stages.map((s) => s.sincePrev), [0, 1600, 400, 150], 'and from the step before');
  assert.equal(stages[1].uiReady, true, 'the interface step is the ui_ready one');
}

{
  const text = [L(T + 1000, 'starting', false, false), L(T + 1600, 'starting', true, false), L(T + 1800, 'starting', true, true), L(T + 2200, 'desktop_ready', true, true, 'ready')].join('\n');
  const r = startupReport(text, { bootAt: T - 500, now: T + 3000 });
  assert.equal(r.current, true, 'written after this launch started');
  assert.equal(r.readyMs, 1200, 'to ready, from the first step');
  assert.deepEqual(r.stages.map((s) => s.label), ['Starting', 'Interface ready', 'Tray menu ready', 'Desktop ready']);
  assert.equal(r.failed, false);
  assert.equal(r.path, null, 'the pure report carries no path');
}

{
  // A log from an earlier launch: the panel must say so rather than pass it off as this one.
  const r = startupReport(L(T + 1000, 'desktop_ready', true, true, 'ready'), { bootAt: T + 9_000_000, now: T + 9_100_000 });
  assert.equal(r.current, false);
  assert.equal(r.stale, true, 'and it is old');
}

{
  // What went wrong is the step's own name and detail: stopped, then starting again.
  const text = [
    L(T + 1000, 'starting', false, false),
    L(T + 2000, 'starting', true, true),
    L(T + 2500, 'desktop_ready', true, true),
    L(T + 9000, 'starting', false, false, 'unknown', 'Sidecar stopped'),
  ].join('\n');
  const r = startupReport(text, { bootAt: T - 500, now: T + 9500 });
  assert.equal(r.failed, false);
  assert.equal(r.stages.at(-1).label, 'Starting again');
  assert.equal(r.stages.at(-1).detail, 'Sidecar stopped');
  assert.equal(r.stages.at(-1).bad, true, 'shown as a problem, not as progress');
  assert.equal(r.readyMs, 1500, 'the launch did become ready once');
}

{
  const text = [L(T + 1000, 'starting', false, false), L(T + 16000, 'error', false, false, 'unknown', 'Sidecar handshake timeout')].join('\n');
  const r = startupReport(text, { bootAt: T - 500, now: T + 17000 });
  assert.equal(r.failed, true);
  assert.equal(r.stages.at(-1).label, 'Startup failed');
  assert.equal(r.stages.at(-1).failed, true);
}

assert.equal(stageLabel({ desktop: 'sidecar_ready', uiReady: true, menuReady: false }), 'Interface ready');
assert.equal(stageLabel({ desktop: 'sidecar_ready', uiReady: false, menuReady: false }), 'Sidecar ready');

{
  // The provider reporting in after everything else is its own step, not a second "Desktop ready".
  const text = [
    L(T + 1000, 'starting', false, false),
    L(T + 2000, 'desktop_ready', true, true),
    L(T + 3500, 'desktop_ready', true, true, 'ready'),
    L(T + 4000, 'desktop_ready', true, true, 'unavailable', 'rate_limited'),
  ].join('\n');
  const r = startupReport(text, { bootAt: T - 500, now: T + 5000 });
  assert.deepEqual(r.stages.map((s) => s.label), ['Starting', 'Desktop ready', 'AI provider ready', 'AI provider unavailable']);
  assert.equal(r.stages[-1 + r.stages.length].detail, 'rate_limited', 'why it is unavailable travels with the step');
  assert.equal(r.stages.at(-1).bad, false, 'an AI outage is not a startup failure');
  assert.equal(r.failed, false);
}

{
  // The reader: a missing file is nothing yet, not an error; a real one is reported with its path.
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'jarvis-lifecycle-'));
  const file = path.join(dir, 'lifecycle.log');
  const missing = readStartup(file);
  assert.deepEqual(missing.stages, []);
  assert.equal(missing.error, null, 'no log yet is not a failure');
  assert.equal(missing.path, file);

  fs.writeFileSync(file, [L(T + 1000, 'starting', false, false), L(T + 2100, 'desktop_ready', true, true, 'ready')].join('\n') + '\n');
  const read = readStartup(file, { bootAt: T - 500, now: T + 2200 });
  assert.equal(read.stages.length, 2);
  assert.equal(read.readyMs, 1100);
  assert.equal(read.path, file);
  assert.equal(lifecycleLog(dir), path.join(dir, '.gg', 'lifecycle.log'));
  fs.rmSync(dir, { recursive: true, force: true });
}

console.log('lifecycle tests: all passed');

import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createDesktop } from '../desktop/index.mjs';

// A recording fake: every backend call is appended to calls, and returns a canned value.
function fakeBackends() {
  const calls = [];
  const rec = (name) => async (...args) => { calls.push({ name, args }); return { ok: true, name, args }; };
  const input = {
    move: rec('move'), click: rec('click'),
    // no doubleClick: adapter falls back to two clicks
    down: rec('down'), up: rec('up'),
    // no drag: adapter falls back to move/down/move/up
    scroll: rec('scroll'), type: rec('type'), press: rec('press'), hotkey: rec('hotkey'),
    relative: rec('relative'),
  };
  const windows = {
    list: rec('list'), focus: rec('focus'), minimize: rec('minimize'), maximize: rec('maximize'),
    restore: rec('restore'), move: rec('move'), resize: rec('resize'), monitors: rec('monitors'),
    isWindowFocused: async (t) => calls.push({ name: 'isWindowFocused', args: [t] }) && true,
    getWindow: async (t) => { calls.push({ name: 'getWindow', args: [t] }); return { title: 'Docs - Browser' }; },
    getVisibleText: async (t) => { calls.push({ name: 'getVisibleText', args: [t] }); return 'hello world'; },
    findElements: async (c) => { calls.push({ name: 'findElements', args: [c] }); return [{ name: 'Save' }]; },
    captureHash: async (t) => { calls.push({ name: 'captureHash', args: [t] }); return 'hash-1'; },
  };
  const apps = { list: rec('apps.list'), find: rec('apps.find'), launch: rec('apps.launch'), quit: rec('apps.quit'), front: rec('apps.front') };
  let clip = '';
  const clipboard = {
    read: async () => { calls.push({ name: 'clipboard.read' }); return clip; },
    write: async (t) => { calls.push({ name: 'clipboard.write', args: [t] }); clip = String(t); return { ok: true }; },
  };
  return { calls, input, windows, apps, clipboard };
}

const { calls, input, windows, apps, clipboard } = fakeBackends();
const desk = createDesktop({ name: 'fake', input, windows, apps, clipboard });

// --- input ---
await desk.input.move(10, 20, { durationMs: 100 });
assert.deepEqual(calls.at(-1), { name: 'move', args: [10, 20, { durationMs: 100 }] });

await desk.input.click(3, 4, { button: 'right' });
assert.deepEqual(calls.at(-1), { name: 'click', args: [3, 4, { button: 'right' }] });

// doubleClick falls back to two clicks (fake has no doubleClick)
await desk.input.doubleClick(5, 6);
assert.deepEqual(calls.at(-2), { name: 'click', args: [5, 6, {}] });
assert.deepEqual(calls.at(-1), { name: 'click', args: [5, 6, {}] });

// drag falls back to move/down/move/up
await desk.input.drag(1, 2, 3, 4);
assert.deepEqual(calls.slice(-4).map(c => c.name), ['move', 'down', 'move', 'up']);

await desk.input.scroll(7, 8, 0, -3);
assert.deepEqual(calls.at(-1), { name: 'scroll', args: [7, 8, 0, -3] });

await desk.input.type('abc', { delayMs: 5 });
assert.deepEqual(calls.at(-1), { name: 'type', args: ['abc', { delayMs: 5 }] });

await desk.input.key('Enter');
assert.deepEqual(calls.at(-1), { name: 'press', args: ['Enter'] });

await desk.input.key('c', ['Control']);
assert.deepEqual(calls.at(-1), { name: 'hotkey', args: [['Control'], 'c'] });

await desk.input.relative(2, 3);
assert.deepEqual(calls.at(-1), { name: 'relative', args: [2, 3, {}] });

// input backend that lacks relative must error, not silently succeed
const limited = createDesktop({ input: { move: async () => {} } });
await assert.rejects(() => limited.input.relative(1, 1), /does not implement relative/);

// --- windows ---
await desk.windows.list();
assert.equal(calls.at(-1).name, 'list');
await desk.windows.move('Docs', 100, 200);
assert.deepEqual(calls.at(-1), { name: 'move', args: ['Docs', 100, 200] });
await desk.windows.resize('Docs', 800, 600);
assert.deepEqual(calls.at(-1), { name: 'resize', args: ['Docs', 800, 600] });

// --- apps ---
await desk.apps.quit('Firefox');
assert.deepEqual(calls.at(-1), { name: 'apps.quit', args: ['Firefox', {}] });

// --- clipboard preserve/restore ---
await desk.clipboard.write('first');
assert.equal(await desk.clipboard.read(), 'first');
await desk.clipboard.preserve();
await desk.clipboard.write('second');
assert.equal(await desk.clipboard.read(), 'second');
const restored = await desk.clipboard.restore();
assert.equal(restored, 'first');
assert.equal(await desk.clipboard.read(), 'first');

// --- verify: real conditions, no fake success ---
const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'jarvis-desktop-'));
const file = path.join(tmp, 'note.txt');
await fs.writeFile(file, 'needle in haystack');

let res = await desk.verify.verify([{ type: 'file_exists', target: file }]);
assert.equal(res[0].ok, true);
res = await desk.verify.verify([{ type: 'file_exists', target: path.join(tmp, 'missing.txt') }]);
assert.equal(res[0].ok, false);
res = await desk.verify.verify([{ type: 'file_contains', target: file, expected: 'needle' }]);
assert.equal(res[0].ok, true);
res = await desk.verify.verify([{ type: 'file_contains', target: file, expected: 'absent' }]);
assert.equal(res[0].ok, false);

res = await desk.verify.verify([{ type: 'window_focused', target: 'Browser' }]);
assert.equal(res[0].ok, true);
res = await desk.verify.verify([{ type: 'window_title', target: 'Browser', expected: 'Docs' }]);
assert.equal(res[0].ok, true);
res = await desk.verify.verify([{ type: 'element_present', target: 'Save' }]);
assert.equal(res[0].ok, true);
res = await desk.verify.verify([{ type: 'text_present', target: 'world' }]);
assert.equal(res[0].ok, true);

await desk.clipboard.write('copy-me');
res = await desk.verify.verify([{ type: 'clipboard_equals', expected: 'copy-me' }]);
assert.equal(res[0].ok, true);
res = await desk.verify.verify([{ type: 'clipboard_equals', expected: 'other' }]);
assert.equal(res[0].ok, false);

res = await desk.verify.verify([{ type: 'image_changed', baseline: 'hash-1' }]);
assert.equal(res[0].ok, false, 'unchanged image is not a success');
res = await desk.verify.verify([{ type: 'image_changed', baseline: 'hash-0' }]);
assert.equal(res[0].ok, true);

// an unknown condition must fail, never report ok
res = await desk.verify.verify([{ type: 'nonsense' }]);
assert.equal(res[0].ok, false);

// verifyAll aggregates
assert.equal(await desk.verify.verifyAll([{ type: 'file_exists', target: file }]), true);
assert.equal(await desk.verify.verifyAll([{ type: 'nonsense' }]), false);

// A backend that cannot answer must fail closed
const bare = createDesktop({});
res = await bare.verify.verify([{ type: 'window_focused', target: 'x' }]);
assert.equal(res[0].ok, false);
assert.match(res[0].error, /backend missing/);

await fs.rm(tmp, { recursive: true, force: true });
console.log('desktop tests: passed');

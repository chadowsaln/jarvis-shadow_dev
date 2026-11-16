import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import vm from 'node:vm';

// The pages load these as classic scripts; the tests run them the same way, with no document (so no WebGL canvas)
// and one fake window. That is exactly the machine the fallback is for: no picture from the GPU, so the LED orb.
const load = (...files) => {
  const ctx = { window: {}, performance: { now: () => 0 }, matchMedia: () => ({ matches: false, addEventListener() {} }) };
  ctx.globalThis = ctx;
  vm.createContext(ctx);
  for (const file of files) {
    const path = fileURLToPath(new URL(`../../../roamies/${file}`, import.meta.url));
    vm.runInContext(readFileSync(path, 'utf8'), ctx, { filename: file });
  }
  return ctx.window.Roamie;
};

const R = load('theme.js', 'orb-state.js', 'hybrid.js');
const H = R.hybrid;
const theme = R.theme;

console.log('hybrid tests: start');

// A stand-in for the dither kit: records the cells the look lights.
const kit = (L = 6) => {
  const cells = new Map();
  return {
    L, P: 4,
    put(x, y, lvl = 0) {
      const gx = Math.round(x), gy = Math.round(y);
      const key = `${gx},${gy}`;
      if ((cells.get(key) ?? -1) < lvl) cells.set(key, lvl);
    },
    th: () => 0.2, // an easy threshold: the shading is what's under test, not the dither pattern
    cells,
  };
};

// ---- no WebGL: the LED orb, and nothing asked of a renderer ----
assert.equal(H.renderer, null, 'no renderer without a document');
assert.equal(H.extent(4), null, 'no 3D patch to widen for');
assert.equal(H.animated, false, 'nothing animating on its own');
const k = kit();
H.body(k, 40, 30, 10, { t: 1.2, mode: 'idle', level: 0 });
assert.ok(k.cells.size > 40, `the fallback lights cells (${k.cells.size})`);
// Everything it lights is on the orb, its rings or its floor: no cells out in the corners.
for (const key of k.cells.keys()) {
  const [x, y] = key.split(',').map(Number);
  assert.ok(Math.hypot(x - 40, y - 30) <= 16, `cell ${key} is near the orb`);
}
assert.ok([...k.cells.values()].every((v) => v <= 6 && v >= 0), 'levels stay inside the palette');

// Louder: more cells (the voice adds energy to the plasma and the heart).
const loud = kit();
H.body(loud, 40, 30, 10, { t: 1.2, mode: 'speaking', level: 1 });
assert.ok(loud.cells.size >= k.cells.size, 'a loud voice never draws less than silence');

// Animation off: still the LED orb (the 3D render would only show one frame, so it is not used at all).
const still = kit();
H.body(still, 40, 30, 10, { t: 2, mode: 'idle', level: 0 });
assert.ok(still.cells.size > 0);

// ---- the cursor form: a reticle that fits the pointer slot ----
const c = kit();
H.cursor(c, 20, 20, 15, 17, { t: 0, mode: 'idle' });
assert.ok(c.cells.size > 8, 'the cursor form draws a reticle');
assert.ok(c.cells.get('20,20') >= 3, 'and a lit heart where the body is');

// ---- over(): nothing to composite without a renderer ----
const ctx = { save() {}, restore() {}, drawImage() {}, translate() {}, scale() {}, globalCompositeOperation: '', globalAlpha: 1 };
H.body(k, 40, 30, 10, { t: 1, mode: 'idle' });
assert.equal(H.over(ctx, { dpr: 1 }, { t: 1, level: 0, mode: 'idle' }), false);

// ---- the frame the renderer is handed: real app state, never invented ----
// fromFrame is the reducer's reading of one frame; the hybrid uses the stronger of it and the event-driven state.
const f = R.orbState.fromFrame;
assert.equal(f({ mode: 'listen' }), 'listening');
assert.equal(f({ tooling: true }), 'tool_execution');
assert.equal(f({ mode: 'think' }), 'thinking');
assert.equal(f({ mode: 'talk' }), 'speaking');
assert.equal(f({}), 'idle');
assert.equal(f({ offline: true }), 'offline');
assert.equal(R.orbState.strongest('idle', 'error'), 'error');
assert.equal(R.orbState.strongest('speaking', 'tool_execution'), 'tool_execution');

// ---- the theme the renderer reads: no color is baked into the look ----
const before = theme.current.core;
theme.apply({ core: '#112233' });
assert.equal(theme.current.core, '#112233', 'a theme change is live on the next frame');
const drawn = kit();
H.body(drawn, 20, 20, 6, { t: 0.4, mode: 'idle' });
assert.ok(drawn.cells.size > 0, 'and the fallback still draws with it');
theme.apply({ core: before });

// dispose() is safe with nothing to dispose.
H.dispose();
assert.equal(H.renderer, null);

console.log('hybrid tests: ok');

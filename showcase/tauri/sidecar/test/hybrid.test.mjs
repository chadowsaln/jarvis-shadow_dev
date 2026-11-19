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

const R = load('theme.js', 'orb-state.js', 'hybrid3d.js', 'hybrid.js');
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
// Creating one where there is no page reports it instead of throwing (the module is loaded by the tests too).
assert.equal(R.hybrid3d.create().error, 'no document', 'a renderer with no page fails politely');
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

// ---- the cursor form carries the structure too: six glyphs, one per style ----
// The style is resolved the way the 3D renderer resolves it (the cursor form is drawn by the same look), so each
// style's pointer is a small signature of it: a bezel, loops, a burst, spines, broken arcs.
{
  const glyph = (st, t = st) => {
    const k2 = kit();
    H.cursor(k2, 20, 20, 14, 16, t);
    return { cells: k2.cells, text: [...k2.cells.keys()].sort().join(' ') };
  };
  const before = theme.current;
  const seen = new Map();
  for (const id of theme.STYLE_IDS) {
    theme.apply({ ...theme.withStyle(id, theme.fromPreset('jarvis-blue')), styleMode: 'fixed' });
    const { cells, text } = glyph({ t: 1, mode: 'idle', level: 0 });
    assert.ok(cells.size > 8, `${id}: the cursor form still draws`);
    assert.equal(cells.get('20,20') > 0 || cells.get('14,16') > 0, true, `${id}: it marks the body or the pointer`);
    // Inside the pointer slot: nothing strays further than the glyph's own radius from the body.
    for (const key of cells.keys()) {
      const [x, y] = key.split(',').map(Number);
      assert.ok(Math.hypot(x - 20, y - 20) <= 9, `${id}: ${key} stays in the pointer slot`);
    }
    assert.ok(!seen.has(text), `${id} draws its own glyph (same as ${seen.get(text)})`);
    seen.set(text, id);
  }
  assert.equal(seen.size, theme.STYLE_IDS.length, 'six distinct pointer glyphs');
  // Following the state picks the pointer's glyph the same way it picks the structure: idle is arcs, thinking is burst.
  const IDLE = { t: 1, mode: 'idle', level: 0 }, THINK = { t: 1, mode: 'think', level: 0 };
  const pin = (id, st) => {
    theme.apply({ ...theme.withStyle(id, theme.fromPreset('jarvis-blue')), styleMode: 'fixed' });
    return glyph(st).text;
  };
  const pins = { arcs: pin('arcs', IDLE), ring: pin('ring', IDLE), burst: pin('burst', THINK) };
  assert.notEqual(pins.arcs, pins.ring);
  theme.apply({ ...theme.withStyle('ring', theme.fromPreset('jarvis-blue')), styleMode: 'auto' });
  assert.equal(glyph(IDLE).text, pins.arcs, 'following the state, idle draws the arcs glyph');
  assert.equal(glyph(THINK).text, pins.burst, 'and thinking draws the burst glyph');
  theme.apply(before);
}

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

// ---- the six styles: the settings and the renderer agree ----
// theme.js owns the list the panel shows; hybrid3d.js owns what each one draws. A style in one and not the other is a
// dead chip or a black orb, so the two lists are checked against each other here.
{
  const H3 = R.hybrid3d;
  const ids = theme.STYLES.map(([id]) => id);
  // JSON, not deepEqual: the loaded copy lives in another realm, so its arrays are not this realm's Array.
  assert.equal(JSON.stringify(Object.keys(H3.LOOKS)), JSON.stringify(ids), 'every style the settings offer has a look in the renderer');
  for (const id of ids) {
    const l = H3.lookOf(id);
    assert.equal(l, H3.LOOKS[id], `${id} is its own look`);
    for (const part of ['orb', 'field']) {
      const nums = Object.values(l[part]);
      assert.ok(nums.length > 0 && nums.every((v) => Number.isFinite(v)), `${id} ${part} gains are numbers`);
    }
    for (const k of ['n', 'r0', 'r1', 'spread', 'gain', 'alpha']) assert.ok(Number.isFinite(l.fil[k]), `${id} fil.${k}`);
    for (const k of ['n', 'r', 'bead', 'node', 'breakN', 'gap', 'gain']) assert.ok(Number.isFinite(l.rings[k]), `${id} rings.${k}`);
    assert.ok(l.orbits >= 0 && l.orbits <= 5, `${id} orbits fit the five curves`);
    assert.ok(l.sat >= 0 && l.sat <= 12, `${id} satellites fit the buffer`);
    // Up to four: the torus reference's loops are a heavy stroke, and a 1 px GL line needs the extra passes.
    assert.ok(l.thick >= 1 && l.thick <= 4, `${id} has a sane number of line passes`);
  }
  assert.equal(H3.lookOf('nope'), H3.LOOKS.hybrid, 'an unknown style draws the merged orb');
  // Following the state: whatever the theme maps a state to must be a structure this renderer has.
  for (const [state, id] of Object.entries(theme.STATE_STYLE)) assert.ok(H3.LOOKS[id], `${state} maps to a built style (${id})`);
  // The morph between structures: eased numbers, and the tables themselves are never written to.
  {
    const snapshot = JSON.stringify(H3.LOOKS.arcs);
    const eased = JSON.parse(JSON.stringify(H3.LOOKS.arcs));
    H3.mixLook(eased, H3.LOOKS.burst, 0.5);
    assert.notEqual(eased.orb.body, H3.LOOKS.arcs.orb.body, 'halfway is a blend of both');
    const [lo, hi] = [H3.LOOKS.arcs.orb.body, H3.LOOKS.burst.orb.body].sort((x, y) => x - y);
    assert.ok(eased.orb.body > lo && eased.orb.body < hi, 'and it sits between the two');
    assert.equal(JSON.stringify(H3.LOOKS.arcs), snapshot, 'the tables are read only');
    H3.mixLook(eased, H3.LOOKS.burst, 1);
    for (const [key, bv] of Object.entries(H3.LOOKS.burst)) {
      if (bv && typeof bv === 'object') for (const [k2, v2] of Object.entries(bv)) assert.equal(eased[key][k2], v2, `all the way to ${key}.${k2}`);
      else assert.equal(eased[key], bv, `all the way to ${key}`);
    }
  }
  // Every style names exactly the same fields. mixLook only walks the keys of the table it's easing toward, so a key
  // a style leaves out keeps whatever the style before it had: a burst's filament tone would tint the weave after it,
  // and its three line passes would still cost three draws.
  {
    const fields = (o, d = '') => Object.entries(o)
      .flatMap(([k, v]) => (v && typeof v === 'object' ? fields(v, `${d}${k}.`) : [`${d}${k}`]))
      .sort();
    const want = JSON.stringify(fields(H3.LOOKS.hybrid));
    for (const id of ids) assert.equal(JSON.stringify(fields(H3.LOOKS[id])), want, `${id} names every field the morph eases`);
  }
  // The filament controls the styles lean on: reach variance (a ragged burst vs an even scale), extra passes (1 px
  // lines), and which of the theme's tones they're drawn in.
  for (const id of ids) {
    const f = H3.LOOKS[id].fil;
    assert.ok(Number.isFinite(f.var) && f.var > 0, `${id} fil.var`);
    assert.ok(Number.isInteger(f.passes) && f.passes >= 1 && f.passes <= 3, `${id} fil.passes`);
    assert.ok([0, 1, 2].includes(f.tone), `${id} fil.tone is one of the theme's three`);
    assert.ok(H3.LOOKS[id].tone >= -1 && H3.LOOKS[id].tone <= 2, `${id} loop tone`);
    assert.ok(Number.isFinite(H3.LOOKS[id].field.break) && H3.LOOKS[id].field.break >= 0 && H3.LOOKS[id].field.break <= 1, `${id} bezel gap`);
  }
  // Every style is a real difference, not a copy that happens to have a name.
  const seen = new Set(Object.values(H3.LOOKS).map((l) => JSON.stringify(l)));
  assert.equal(seen.size, ids.length, 'no two styles are the same table');
}

// dispose() is safe with nothing to dispose.
H.dispose();
assert.equal(H.renderer, null);

console.log('hybrid tests: ok');

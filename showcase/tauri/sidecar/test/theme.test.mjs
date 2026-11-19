import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import vm from 'node:vm';

// The pages load the renderer's modules as classic scripts, so the tests run them the same way: one fake window.
const load = (file) => {
  const path = fileURLToPath(new URL(`../../../roamies/${file}`, import.meta.url));
  const ctx = { window: {}, matchMedia: () => ({ matches: false, addEventListener() {} }) };
  ctx.globalThis = ctx;
  vm.createContext(ctx);
  vm.runInContext(readFileSync(path, 'utf8'), ctx, { filename: file });
  return ctx.window.Roamie.theme;
};

const T = load('theme.js');
const plain = (v) => JSON.parse(JSON.stringify(v ?? null));
const ok = (a, b, m) => assert.deepEqual(plain(a), plain(b), m);

console.log('theme tests: start');

// ---- colors ----
ok(T.parseColor('#7ff3ff'), [127, 243, 255]);
ok(T.parseColor('#fff'), [255, 255, 255], 'three-digit hex');
ok(T.parseColor('rgb(12, 34, 56)'), [12, 34, 56]);
ok(T.parseColor('rgba(12,34,56,0.5)'), [12, 34, 56], 'alpha is not part of the color');
assert.equal(T.parseColor('blue'), null);
assert.equal(T.parseColor('#12345'), null);
assert.equal(T.parseColor('rgb(300,0,0)'), null, 'out of range is not a color');
assert.equal(T.parseColor(12), null);
assert.equal(T.toHex([127, 243, 255]), '#7ff3ff');
assert.equal(T.css('#7ff3ff'), 'rgb(127,243,255)');
assert.equal(T.css('#7ff3ff', 0.5), 'rgba(127,243,255,0.5)');

// ---- presets ----
assert.equal(T.PRESETS.length, 4, 'the four presets the settings offer');
ok(T.PRESETS.map(([id]) => id), ['jarvis-blue', 'neural-purple', 'quantum-green', 'reactor-red']);
for (const [id, label, colors] of T.PRESETS) {
  const t = T.fromPreset(id);
  assert.ok(label, `${id} has a label`);
  assert.equal(t.preset, id);
  for (const part of T.PARTS) assert.equal(t[part], colors[part], `${id} sets ${part}`);
  ok(T.normalize(t).problems, [], `${id} needs no repairs`);
}
assert.equal(T.fromPreset('nope').preset, null, 'an unknown preset is the defaults');

// Blue must never be baked in: another preset really is a different theme.
assert.notEqual(T.fromPreset('reactor-red').core, T.fromPreset('jarvis-blue').core);

// ---- the six orb styles ----
ok(T.STYLES.map(([id]) => id), ['hybrid', 'ring', 'weave', 'torus', 'burst', 'spokes', 'arcs'], 'the styles the settings offer');
assert.equal(T.DEFAULTS.style, 'hybrid', 'the merged orb is the default');
for (const [id, label, palette] of T.STYLES) {
  assert.ok(label, `${id} has a label`);
  const t = T.withStyle(id, T.fromPreset('jarvis-blue'));
  assert.equal(t.style, id, `${id} is applied`);
  if (palette) for (const part of T.PARTS) assert.equal(t[part], palette[part], `${id} brings its ${part}`);
  ok(T.normalize(t).problems, [], `${id} needs no repairs`);
}
{
  // A style is a structure, not a lock: colors stay editable, and a style with a palette can be given new ones.
  const red = T.withStyle('burst', T.fromPreset('jarvis-blue'));
  const edited = T.normalize({ ...red, core: '#ff0000' }).theme;
  assert.equal(edited.core, '#ff0000');
  assert.equal(edited.style, 'burst', 'editing a color keeps the structure');
  assert.equal(T.stylePalette('hybrid'), null, 'Hybrid keeps the colors already set');
  const kept = T.withStyle('hybrid', red);
  assert.equal(kept.core, red.core, 'switching back to Hybrid does not repaint it');
  assert.equal(kept.style, 'hybrid');
}
{
  const { theme, problems } = T.normalize({ style: 'spiral' });
  ok(problems, ['style: not one of the orb styles']);
  assert.equal(theme.style, 'hybrid', 'an unknown style falls back to the merged orb');
}
// The style survives a trip through the theme file and a restart.
{
  const t = T.withStyle('arcs');
  assert.equal(T.parse(T.serialize(t)).theme.style, 'arcs');
}

// ---- following the work: a state draws its own structure ----
const STATES = ['idle', 'listening', 'thinking', 'tool_execution', 'speaking', 'success', 'error', 'offline', 'sleeping'];
assert.equal(T.DEFAULTS.styleMode, 'auto', 'following the state is what the orb does unless told otherwise');
assert.equal(JSON.stringify(Object.keys(T.STATE_STYLE)), JSON.stringify(STATES), 'every state has a structure');
for (const [state, id] of Object.entries(T.STATE_STYLE)) {
  assert.ok(T.STYLE_IDS.includes(id), `${state} draws a style that exists`);
}
{
  const auto = T.normalize({ styleMode: 'auto', style: 'torus' }).theme;
  assert.equal(T.styleFor('thinking', auto), T.STATE_STYLE.thinking, 'thinking gets its own structure');
  assert.equal(T.styleFor('listening', auto), 'weave');
  assert.equal(T.styleFor('speaking', auto), 'torus');
  assert.equal(T.styleFor('nope', auto), 'torus', 'a state nobody mapped falls back to the picked style');
  assert.notEqual(T.STATE_STYLE.error, T.STATE_STYLE.success, 'an error does not look like a success');
  const fixed = T.normalize({ styleMode: 'fixed', style: 'torus' }).theme;
  assert.equal(T.styleFor('thinking', fixed), 'torus', 'off means one structure, whatever the state');
  assert.equal(T.styleFor('thinking', fixed), fixed.style);
}
{
  const { theme, problems } = T.normalize({ styleMode: 'sometimes' });
  ok(problems, ['styleMode: not fixed or auto']);
  assert.equal(theme.styleMode, 'auto');
}
{
  const t = T.normalize({ styleMode: 'fixed', style: 'burst' }).theme;
  const back = T.parse(T.serialize(t)).theme;
  assert.equal(back.styleMode, 'fixed', 'the mode is saved with the theme');
  assert.equal(back.style, 'burst');
}

// ---- validation ----
{
  const { theme, problems } = T.normalize({ core: 'blue', glowIntensity: 99, particles: 1e9, quality: 'ultra', animate: 'yes' });
  ok(problems, ['core: not a color', 'animate: not true or false', 'quality: not auto, high or low'], 'each bad value is reported once, in the key order they are read');
  assert.equal(theme.core, T.DEFAULTS.core, 'a bad color falls back instead of blanking the entity');
  assert.equal(theme.glowIntensity, 2, 'out of range numbers are clamped');
  assert.equal(theme.particles, T.MAX_PARTICLES, 'and the particle count is bounded');
  assert.equal(theme.quality, T.DEFAULTS.quality);
  assert.equal(theme.animate, T.DEFAULTS.animate);
}
{
  const { theme } = T.normalize({ core: '#ABC', 'not a key': 1, $evil: true });
  assert.equal(theme.core, '#aabbcc', 'three-digit hex is expanded and lowercased');
  assert.equal(theme['not a key'], undefined, 'unknown keys are dropped, not stored');
  assert.equal(theme.$evil, undefined);
}
{
  const { theme, problems } = T.normalize('nope');
  ok(problems, ['a theme must be an object']);
  ok(theme, T.DEFAULTS, 'garbage is the defaults');
}
ok(T.normalize(null).problems, [], 'nothing saved yet is not a problem');
{
  // A number saved as a string (an old config, a hand-edited file) still works.
  const { theme } = T.normalize({ glowIntensity: '0.4', particles: '64', audioReactive: 'false' });
  assert.equal(theme.glowIntensity, 0.4);
  assert.equal(theme.particles, 64);
  assert.equal(theme.audioReactive, false);
}

// ---- presets as a starting point, not a lock ----
{
  const blue = T.fromPreset('jarvis-blue');
  const edited = T.normalize({ ...blue, core: '#ff0000' }).theme;
  assert.equal(edited.preset, null, 'editing a color drops the preset name');
  assert.equal(edited.core, '#ff0000');
  const same = T.normalize({ ...blue, core: '#7FF3FF' }).theme;
  assert.equal(same.preset, 'jarvis-blue', 'the same color written differently still matches');
}

// ---- export / import ----
{
  const red = T.fromPreset('reactor-red');
  const text = T.serialize(red);
  assert.equal(JSON.parse(text).v, T.VERSION, 'the file is versioned');
  const back = T.parse(text);
  ok(back.problems, []);
  ok(back.theme, red, 'export then import is the same theme');
}
ok(T.parse('{oops').problems, ['not JSON']);
ok(T.parse('{"core":"#fff"}').problems, ['the file has no core, reactor, neural and glow colors'],
  'a file missing the parts is refused, not half applied');

// ---- live apply ----
{
  const seen = [];
  const off = T.on((t) => seen.push(t.core));
  T.apply({ core: '#00ff00' });
  assert.equal(T.current.core, '#00ff00', 'live at once');
  ok(seen, ['#00ff00']);
  T.apply({ core: '#00ff00' });
  assert.equal(seen.length, 1, 'the same theme again is not a change (no needless re-render)');
  const { problems } = T.apply({ core: 'nope' });
  ok(problems, ['core: not a color']);
  assert.equal(T.current.core, '#00ff00', 'a bad edit leaves the current color alone');
  off();
  T.apply({ core: '#123456' });
  assert.equal(seen.length, 1, 'a removed listener stops hearing');
  T.reset();
  assert.equal(T.current.preset, 'jarvis-blue', 'reset is the default preset');
  assert.equal(T.current.core, T.DEFAULTS.core);
}

console.log('theme tests: all passed');

// The visual theme of the hybrid entity: one place that owns its colors, glow, particles and animation switches.
// The renderer reads Roamie.theme.current every frame and never keeps colors of its own, so a change applies on the
// next frame (and a preset never has to know how the orb is drawn).
//
// A theme is plain JSON, which is what gets saved in the sidecar's config and what Export/Import copies:
//   { core, reactor, neural, glow, glowIntensity, particleOpacity, particles, quality, audioReactive, animate, transparency }
// Colors accept '#rgb', '#rrggbb' and 'rgb(r, g, b)' on the way in and are stored as '#rrggbb'.
// Classic script (the pages load with <script>), also readable from Node for the tests: window.Roamie.theme.
(() => {
  const R = (window.Roamie = window.Roamie || {});
  const clamp = (v, a, b) => (v < a ? a : v > b ? b : v);
  const VERSION = 1;

  // The four presets the settings offer, in the order they're shown.
  const PRESETS = [
    ['jarvis-blue', 'JARVIS Blue', { core: '#7ff3ff', reactor: '#2bb8ff', neural: '#9fd8ff', glow: '#7ff3ff' }],
    ['neural-purple', 'Neural Purple', { core: '#c9a4ff', reactor: '#7a5cff', neural: '#e6d4ff', glow: '#a17bff' }],
    ['quantum-green', 'Quantum Green', { core: '#9dffc8', reactor: '#22e08a', neural: '#c6ffe0', glow: '#54ffa8' }],
    ['reactor-red', 'Reactor Red', { core: '#ffc39d', reactor: '#ff4d3d', neural: '#ffd0c2', glow: '#ff6a4d' }],
  ];

  const DEFAULTS = {
    preset: 'jarvis-blue',
    core: '#7ff3ff', reactor: '#2bb8ff', neural: '#9fd8ff', glow: '#7ff3ff',
    glowIntensity: 0.85, // 0–2: how far the bloom reaches
    particleOpacity: 0.75, // 0–1
    particles: 160, // the neural field's point count at full quality (bounded; see MAX_PARTICLES)
    quality: 'auto', // 'auto' | 'high' | 'low'
    audioReactive: true,
    animate: true,
    transparency: 0, // 0–1: how see-through the orb's body is
  };
  const MAX_PARTICLES = 600;
  const PARTS = ['core', 'reactor', 'neural', 'glow'];

  // ---- colors ----
  const hex2 = (n) => clamp(Math.round(n), 0, 255).toString(16).padStart(2, '0');
  function parseColor(v) {
    if (typeof v !== 'string') return null;
    const s = v.trim().toLowerCase();
    let m = /^#([0-9a-f]{3})$/.exec(s);
    if (m) return [0, 1, 2].map((i) => parseInt(m[1][i] + m[1][i], 16));
    m = /^#([0-9a-f]{6})$/.exec(s);
    if (m) return [0, 2, 4].map((i) => parseInt(m[1].slice(i, i + 2), 16));
    m = /^rgba?\(\s*(\d{1,3})\s*[, ]\s*(\d{1,3})\s*[, ]\s*(\d{1,3})\s*(?:[,/]\s*[\d.]+%?\s*)?\)$/.exec(s);
    if (m) {
      const rgb = [1, 2, 3].map((i) => Number(m[i]));
      return rgb.every((n) => n >= 0 && n <= 255) ? rgb : null;
    }
    return null;
  }
  const toHex = (rgb) => `#${rgb.map(hex2).join('')}`;
  const toRgb = (hex) => parseColor(hex) ?? [255, 255, 255];
  /** The same color as CSS rgba, for canvases. */
  const css = (hex, alpha = 1) => {
    const [r, g, b] = toRgb(hex);
    return alpha >= 1 ? `rgb(${r},${g},${b})` : `rgba(${r},${g},${b},${clamp(alpha, 0, 1)})`;
  };
  /** Blended toward black or white: used for the dimmer of two LED levels. */
  const shade = (hex, k) => toHex(toRgb(hex).map((c) => (k >= 0 ? c + (255 - c) * k : c * (1 + k))));

  // ---- validation ----
  const NUM = {
    glowIntensity: [0, 2], particleOpacity: [0, 1], particles: [8, MAX_PARTICLES], transparency: [0, 1],
  };
  const BOOL = ['audioReactive', 'animate'];
  const QUALITY = ['auto', 'high', 'low'];

  /**
   * A complete, valid theme from anything (saved config, an imported file, a preset, a partial edit). Unknown keys
   * are dropped and bad values fall back to the current theme (or the defaults), with a note in `problems`, so a
   * corrupt setting can never blank the entity.
   */
  function normalize(input, base = DEFAULTS) {
    const out = { ...DEFAULTS, ...pickTheme(base) };
    const problems = [];
    if (input == null || typeof input !== 'object' || Array.isArray(input)) {
      return { theme: out, problems: input == null ? [] : ['a theme must be an object'] };
    }
    for (const part of PARTS) {
      if (input[part] === undefined) continue;
      const rgb = parseColor(input[part]);
      if (rgb) out[part] = toHex(rgb);
      else problems.push(`${part}: not a color`);
    }
    for (const [key, [lo, hi]] of Object.entries(NUM)) {
      if (input[key] === undefined) continue;
      const n = Number(input[key]);
      if (Number.isFinite(n)) out[key] = clamp(key === 'particles' ? Math.round(n) : Math.round(n * 100) / 100, lo, hi);
      else problems.push(`${key}: not a number`);
    }
    for (const key of BOOL) {
      if (input[key] === undefined) continue;
      if (typeof input[key] === 'boolean') out[key] = input[key];
      else if (input[key] === 'true' || input[key] === 'false') out[key] = input[key] === 'true';
      else problems.push(`${key}: not true or false`);
    }
    if (input.quality !== undefined) {
      if (QUALITY.includes(input.quality)) out.quality = input.quality;
      else problems.push('quality: not auto, high or low');
    }
    if (input.preset !== undefined) out.preset = PRESETS.some(([id]) => id === input.preset) ? input.preset : null;
    // A preset is a starting point, not a lock: editing a color keeps the name only while it still matches it.
    if (out.preset && !matchesPreset(out)) out.preset = null;
    return { theme: out, problems };
  }
  function pickTheme(v) {
    const out = {};
    if (!v || typeof v !== 'object') return out;
    for (const k of Object.keys(DEFAULTS)) if (v[k] !== undefined) out[k] = v[k];
    return out;
  }
  const matchesPreset = (t) => PRESETS.some(([id, , p]) => id === t.preset && PARTS.every((c) => toHex(toRgb(t[c])) === toHex(toRgb(p[c]))));
  const isTheme = (v) => !!v && typeof v === 'object' && PARTS.every((p) => !!parseColor(v[p]));

  /** A fresh theme from a preset's id (or the defaults for an unknown one). */
  function fromPreset(id) {
    const p = PRESETS.find(([pid]) => pid === id);
    return normalize({ ...DEFAULTS, ...(p ? p[2] : {}), preset: p ? p[0] : null }, DEFAULTS).theme;
  }

  // ---- export / import ----
  const serialize = (t) => JSON.stringify({ v: VERSION, ...pickTheme(t ?? DEFAULTS) }, null, 2);
  function parse(text) {
    let data;
    try { data = JSON.parse(String(text ?? '')); } catch { return { theme: null, problems: ['not JSON'] } }
    if (!isTheme(data)) return { theme: null, problems: ['the file has no core, reactor, neural and glow colors'] };
    return normalize(data);
  }

  // ---- the live theme ----
  const listeners = new Set();
  const state = { current: { ...DEFAULTS } };
  const notify = () => { for (const fn of listeners) { try { fn(state.current) } catch { /* a bad listener must not blank the entity */ } } };

  /** Applies a partial theme (or a whole one) at once: validated, saved by the caller, live before the next frame. */
  function apply(patch, { silent = false } = {}) {
    const { theme, problems } = normalize(patch, state.current);
    const changed = JSON.stringify(theme) !== JSON.stringify(state.current);
    state.current = theme;
    if (changed && !silent) notify();
    return { theme, problems, changed };
  }
  function reset() { const t = fromPreset('jarvis-blue'); state.current = t; notify(); return t; }

  R.theme = {
    VERSION, PRESETS, DEFAULTS, PARTS, MAX_PARTICLES, QUALITY,
    get current() { return state.current; },
    on(fn) { listeners.add(fn); return () => listeners.delete(fn); },
    apply, reset, normalize, fromPreset, parse, serialize,
    parseColor, toHex, toRgb, css, shade, isTheme, matchesPreset,
  };
})();

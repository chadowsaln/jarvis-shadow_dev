// The visual theme of the hybrid entity: one place that owns its colors, glow, particles and animation switches.
// The renderer reads Roamie.theme.current every frame and never keeps colors of its own, so a change applies on the
// next frame (and a preset never has to know how the orb is drawn).
//
// A theme is plain JSON, which is what gets saved in the sidecar's config and what Export/Import copies:
//   { style, styleMode, core, reactor, neural, glow, glowIntensity, particleOpacity, particles, quality,
//     audioReactive, animate, transparency }
// `style` is the structure the orb keeps when `styleMode` is 'fixed'. With 'auto' the structure follows the agent
// state instead, through STATE_STYLE (idle, listening, thinking, ...), and `style` is only the fallback for a state
// nobody mapped.
//
// The styles themselves (see STYLES): the colors are free with any of them.
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

  // The six orb structures, in the order the settings show them, each with the palette of the reference it comes
  // from: `null` keeps whatever colors are already set (the merged orb has no palette of its own). A style is a
  // structure, not a lock: its palette is a starting point, and every color stays editable afterwards.
  const STYLES = [
    ['hybrid', 'Hybrid', null],
    ['ring', 'Engraved Ring', { core: '#ffcf8a', reactor: '#ff7a1e', neural: '#ffb066', glow: '#ff5a12' }],
    ['weave', 'Woven', { core: '#e6fffb', reactor: '#37c8bc', neural: '#c4f5ee', glow: '#4fe0d0' }],
    ['torus', 'Torus', { core: '#ffe2a6', reactor: '#ffab2e', neural: '#ffd7a0', glow: '#ff9d2b' }],
    ['burst', 'Burst', { core: '#eaffff', reactor: '#22d3e0', neural: '#b6f7ff', glow: '#4ff0ff' }],
    ['spokes', 'Spokes', { core: '#dceeff', reactor: '#3f8fd0', neural: '#ffab5e', glow: '#8fd6ff' }],
    ['arcs', 'Arcs', { core: '#e9fdff', reactor: '#2fb6d8', neural: '#a8e8ff', glow: '#39d7f5' }],
  ];
  const STYLE_IDS = STYLES.map(([id]) => id);

  // Which structure goes with which state, when the orb follows the work. Chosen for what each one is: tracks at
  // rest, woven loops while listening, a burst while thinking, spines while a tool runs, rings while speaking, the
  // engraved instrument for a success, jagged spines for an error, dim tracks offline, the quiet weave when dozing.
  const STATE_STYLE = {
    idle: 'arcs',
    listening: 'weave',
    thinking: 'burst',
    tool_execution: 'spokes',
    speaking: 'torus',
    success: 'ring',
    error: 'spokes',
    offline: 'arcs',
    sleeping: 'weave',
  };
  const STYLE_MODES = ['fixed', 'auto'];

  const DEFAULTS = {
    preset: 'jarvis-blue',
    style: 'hybrid',
    styleMode: 'auto',
    customColor: '#78ffe2',
    colorShade: 0, // -50 to +50: darker/deep to lighter/glowing
    colorSaturation: 1.0, // 0.1 to 2.0: saturation factor
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

  function rgbToHsl(r, g, b) {
    const max = Math.max(r, g, b), min = Math.min(r, g, b);
    let h = 0, s = 0, l = (max + min) / 510;
    const d = max - min;
    if (d !== 0) {
      s = l > 0.5 ? d / (510 - max - min) : d / (max + min);
      switch (max) {
        case r: h = (g - b) / d + (g < b ? 6 : 0); break;
        case g: h = (b - r) / d + 2; break;
        case b: h = (r - g) / d + 4; break;
      }
      h /= 6;
    }
    return [h, s, l];
  }

  function hslToRgb(h, s, l) {
    const q = l < 0.5 ? l * (1 + s) : l + s - l * s;
    const p = 2 * l - q;
    const hue2rgb = (t) => {
      let v = t;
      if (v < 0) v += 1;
      if (v > 1) v -= 1;
      if (v < 1 / 6) return p + (q - p) * 6 * v;
      if (v < 1 / 2) return q;
      if (v < 2 / 3) return p + (q - p) * (2 / 3 - v) * 6;
      return p;
    };
    return [
      clamp(Math.round(hue2rgb(h + 1 / 3) * 255), 0, 255),
      clamp(Math.round(hue2rgb(h) * 255), 0, 255),
      clamp(Math.round(hue2rgb(h - 1 / 3) * 255), 0, 255)
    ];
  }

  /**
   * Generates a complete harmonious 5-tier LED & glass palette from any base color and shade/saturation degree.
   * Controls both the color and its degree (depth/brightness and vibrancy).
   */
  function paletteFrom(baseColor, shadeOffset = 0, satMult = 1.0) {
    const [r, g, b] = toRgb(baseColor || DEFAULTS.customColor);
    const [h, baseS, baseL] = rgbToHsl(r, g, b);
    const s = clamp(baseS * (Number(satMult) || 1.0), 0.1, 1.0);
    const sh = clamp((Number(shadeOffset) || 0) / 100, -0.4, 0.4);

    const c0 = hslToRgb(h, clamp(s * 0.4, 0.05, 0.8), clamp(0.04 + sh * 0.03, 0.015, 0.12));
    const c1 = hslToRgb(h, clamp(s * 0.8, 0.15, 0.95), clamp(0.22 + sh * 0.1, 0.1, 0.38));
    const c2 = hslToRgb(h, clamp(s * 0.9, 0.2, 1.0), clamp(0.48 + sh * 0.14, 0.28, 0.65));
    const c3 = hslToRgb(h, s, clamp(baseL + sh * 0.2, 0.45, 0.88));
    const c4 = hslToRgb(h, clamp(s * 0.25, 0.05, 0.4), clamp(0.95 + sh * 0.04, 0.88, 0.99));

    const hex0 = toHex(c0), hex1 = toHex(c1), hex2_ = toHex(c2), hex3 = toHex(c3), hex4 = toHex(c4);
    const [r0, g0, b0] = c0;
    const [r1, g1, b1] = c1;

    const textRgb = hslToRgb(h, clamp(s * 0.2, 0.02, 0.3), clamp(0.93 + sh * 0.04, 0.85, 0.98));
    const dimRgb = hslToRgb(h, clamp(s * 0.35, 0.05, 0.5), clamp(0.68 + sh * 0.08, 0.5, 0.8));
    const inkdarkRgb = hslToRgb(h, clamp(s * 0.5, 0.1, 0.7), 0.08);

    return {
      ACC: hex3,
      HOT: hex4,
      MID: hex2_,
      DEEP: hex1,
      EDGE: `rgba(${r1},${g1},${b1},0.6)`,
      GLASS: `rgba(${r0},${g0},${b0},0.94)`,
      TEXT: toHex(textRgb),
      DIM: toHex(dimRgb),
      INKDARK: toHex(inkdarkRgb),
      LED: [hex0, hex1, hex2_, hex3, hex4],
      TONES: {
        accent: hex3,
        teal: hex3,
        amber: '#ffcf5c',
        coral: '#ff8a7a',
        lilac: '#b9a4ff',
        sky: '#7cc8ff',
        lime: '#b6f36b',
        red: '#ff6b6b',
        white: hex4,
      },
    };
  }

  // ---- validation ----
  const NUM = {
    glowIntensity: [0, 2], particleOpacity: [0, 1], particles: [8, MAX_PARTICLES], transparency: [0, 1],
    colorShade: [-50, 50], colorSaturation: [0.1, 2.0],
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
    if (input.customColor !== undefined) {
      if (input.customColor === null || input.customColor === '') out.customColor = null;
      else {
        const rgb = parseColor(input.customColor);
        if (rgb) out.customColor = toHex(rgb);
        else problems.push('customColor: not a color');
      }
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
    if (input.style !== undefined) {
      if (STYLE_IDS.includes(input.style)) out.style = input.style;
      else problems.push('style: not one of the orb styles');
    }
    if (input.styleMode !== undefined) {
      if (STYLE_MODES.includes(input.styleMode)) out.styleMode = input.styleMode;
      else problems.push('styleMode: not fixed or auto');
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
    const baseColor = p ? p[2].glow || p[2].core : DEFAULTS.customColor;
    return normalize({ ...DEFAULTS, ...(p ? p[2] : {}), customColor: baseColor, colorShade: 0, colorSaturation: 1.0, preset: p ? p[0] : null }, DEFAULTS).theme;
  }

  /**
   * The current theme with another orb structure, and that structure's palette when it has one: picking a style is
   * one step, and the colors it brings can be edited afterwards like any others.
   */
  function withStyle(id, base = state.current) {
    const s = STYLES.find(([sid]) => sid === id) ?? STYLES[0];
    return normalize({ ...pickTheme(base), ...(s[2] ?? {}), style: s[0], preset: base?.preset ?? null }, base).theme;
  }
  /** The colors a style would bring, or null for Hybrid (which keeps the theme's own). */
  const stylePalette = (id) => STYLES.find(([sid]) => sid === id)?.[2] ?? null;
  /**
   * Which structure to draw for a state: the theme's own choice, or (when it follows the work) that state's style,
   * falling back to the theme's style for a state nobody mapped.
   */
  const styleFor = (stateName, t = state.current) =>
    (t?.styleMode === 'auto' ? STATE_STYLE[stateName] : null) ?? t?.style ?? DEFAULTS.style;

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
  const state = {
    current: { ...DEFAULTS },
    palette: paletteFrom(DEFAULTS.customColor, DEFAULTS.colorShade, DEFAULTS.colorSaturation),
  };
  const notify = () => { for (const fn of listeners) { try { fn(state.current) } catch { /* a bad listener must not blank the entity */ } } };

  /** Applies a partial theme (or a whole one) at once: validated, saved by the caller, live before the next frame. */
  function apply(patch, { silent = false } = {}) {
    const { theme, problems } = normalize(patch, state.current);
    const changed = JSON.stringify(theme) !== JSON.stringify(state.current);
    state.current = theme;
    state.palette = paletteFrom(theme.customColor || theme.glow || theme.core, theme.colorShade, theme.colorSaturation);
    if (changed && !silent) notify();
    return { theme, problems, changed };
  }
  function reset() {
    const t = fromPreset('jarvis-blue');
    state.current = t;
    state.palette = paletteFrom(t.customColor || t.glow || t.core, t.colorShade, t.colorSaturation);
    notify();
    return t;
  }

  R.theme = {
    VERSION, PRESETS, STYLES, STYLE_IDS, STYLE_MODES, STATE_STYLE, DEFAULTS, PARTS, MAX_PARTICLES, QUALITY,
    get current() { return state.current; },
    get palette() { return state.palette; },
    on(fn) { listeners.add(fn); return () => listeners.delete(fn); },
    apply, reset, normalize, fromPreset, withStyle, stylePalette, styleFor, parse, serialize,
    parseColor, toHex, toRgb, css, shade, isTheme, matchesPreset,
    paletteFrom, hslToRgb, rgbToHsl,
  };
})();

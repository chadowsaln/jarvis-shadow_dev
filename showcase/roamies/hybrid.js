// The hybrid entity's look: a true 3D orb (WebGL 2, roamies/hybrid3d.js) composited over the overlay canvas, with
// three reactor rings and a neural field around it. Two things keep it honest:
//   - the 2D look underneath (LED cells, like every other look) is drawn whenever WebGL 2 isn't there or has been
//     lost for good, so the entity never disappears on a machine whose GPU can't keep a context
//   - it only reads: the state comes from the app (the agent's pose and the voice meter, see orb-state.js), the
//     colors from Roamie.theme. Nothing here starts, stops or reports anything.
// 10-dither.js calls body()/cursor() like any other look, then over() to lay the 3D render on top.
(() => {
  const R = (window.Roamie = window.Roamie || {});
  const clamp = (v, a, b) => (v < a ? a : v > b ? b : v);
  const TAU = Math.PI * 2;
  const HOOKS = 1.45;            // the 3D canvas is 1.45× the orb's radius each way (the rings reach 1.26)

  // One instance per creature: the page can show several (the desktop's, the panel's tiles), each at its own place
  // and size, so neither the renderer nor the last drawn position can be shared between them.
  function make() {
  let api = null;                // this instance's WebGL renderer, made on the first frame it's needed

  const engine = () => {
    if (api && api.disposed) api = null;
    if (!api) api = R.hybrid3d?.create() ?? null;
    return api;
  };

  // ---------- the 3D composite ----------
  // Cells → the orb's screen box. Recorded by body() each frame, because over() is called without it.
  const view = { on: false, x: 0, y: 0, r: 0, px: 4, st: null };

  function paint(ctx, env, st, theme) {
    const e = engine();
    if (!e || !e.ok) return false;
    const r = view.r * view.px;
    if (!(r > 2)) return false;
    const size = Math.ceil(2 * HOOKS * r);
    const now = (st.t ?? 0) * 1000;
    // The frame's own reading (a tool running, the mic on, the voice meter) plus whatever the app's events left
    // standing (a success flash, an error, no provider at all): the stronger of the two wins.
    const frame = R.orbState?.fromFrame({ mode: st.mode, tooling: st.tooling, speaking: st.voice != null && st.voice > 0, sleepy: st.sleepy }, now) ?? 'idle';
    const seen = R.orb?.name?.() ?? 'idle';
    const state = R.orbState?.strongest?.(frame, seen) ?? frame;
    e.resize(size, size, Math.min(1.5, env.dpr || 1));
    const drew = e.render({
      t: st.t ?? 0, level: st.level ?? 0, state, theme, now,
      fps: env.reduced ? 24 : 60,
    });
    if (!drew) return false;
    const x = view.x, y = view.y;
    ctx.save();
    // The shader's y points up; the canvas's points down. Flipping keeps the rings' rotation honest.
    ctx.translate(x, y);
    ctx.scale(1, -1);
    ctx.drawImage(e.canvas, -HOOKS * r, -HOOKS * r, 2 * HOOKS * r, 2 * HOOKS * r);
    ctx.restore();
    // Bloom: the same frame again, wider and faint, added on top (a cheap glow that follows the theme's intensity).
    const glow = clamp(theme?.glowIntensity ?? 0.85, 0, 2);
    if (glow > 0.05) {
      ctx.save();
      ctx.globalCompositeOperation = 'lighter';
      ctx.globalAlpha = 0.1 + glow * 0.12;
      ctx.translate(x, y);
      ctx.scale(1, -1);
      const b = HOOKS * 1.14;
      ctx.drawImage(e.canvas, -b * r, -b * r, 2 * b * r, 2 * b * r);
      ctx.restore();
    }
    return true;
  }

  // ---------- the 2D look: the fallback, and what sits under the 3D ----------
  const ringAt = (cx, cy, rr, a, tilt) => [
    cx + Math.cos(a) * rr,
    cy + Math.sin(a) * rr * tilt,
  ];

  // Which structure this frame wants, resolved the same way the 3D renderer resolves it (the cursor form uses it to
  // pick its glyph): the strongest state the app reports, then the theme's own style or the state's.
  const styleNow = (st, theme) => {
    const now = (st?.t ?? 0) * 1000;
    const frame = R.orbState?.fromFrame({ mode: st?.mode, tooling: st?.tooling, speaking: st?.voice != null && st.voice > 0, sleepy: st?.sleepy }, now) ?? 'idle';
    const seen = R.orb?.name?.() ?? 'idle';
    const name = R.orbState?.strongest?.(frame, seen) ?? frame;
    return R.theme?.styleFor ? R.theme.styleFor(name, theme) : 'hybrid';
  };

  return {
    id: 'hybrid',

    // Called by the kit every frame with the body's position in cells. Remembers where the 3D render goes, then draws
    // the LED version only when WebGL isn't available.
    body(k, cx, cy, rad, st) {
      const P = k.P || 4;
      view.on = true; view.x = cx * P; view.y = cy * P; view.r = rad; view.px = P; view.st = st;
      const e = engine();
      const theme = R.theme?.current;
      // With a live 3D render, the cells are left clear: a second orb underneath would only muddy it. With animation
      // off there is no live render to show, so the LED orb is what stays on screen.
      if (e?.ok && theme?.animate !== false) {
        // A faint floor ring: what a projector leaves under a hologram.
        for (let i = 0; i < 40; i++) {
          const a = (i / 40) * TAU;
          const x = cx + Math.cos(a) * rad * 1.05, y = cy + rad * 1.32 + Math.sin(a) * rad * 0.1;
          if (k.th(Math.round(x), Math.round(y)) < 0.22) k.put(x, y, 1);
        }
        return;
      }
      this.led(k, cx, cy, rad, st, theme);
    },

    // The LED orb: a plasma core, three rings at their own angles, and the neural dots. Slow on purpose: it is the
    // safety net, not the show.
    led(k, cx, cy, rad, st, theme) {
      const P = k.P || 4, L = k.L;
      // Dozing: the same orb, barely alight, moving at a crawl (the 3D renderer does the same in its own way).
      const asleep = (st?.sleepy ?? 0) > 0.5;
      const t = (st?.t ?? 0) * (asleep ? 0.18 : 1);
      const level = clamp(st?.level ?? st?.voice ?? 0, 0, 1) * (asleep ? 0.15 : 1);
      const dim = asleep ? 0.35 : 1;
      const lvl = (v) => clamp(Math.round(v * dim), 0, L);
      // The shell: dithered plasma.
      const r0 = Math.round(rad);
      for (let y = -r0; y <= r0; y++) for (let x = -r0; x <= r0; x++) {
        const d = Math.hypot(x, y) / rad;
        if (d > 1) continue;
        const n = Math.sin(x * 0.7 + t * 1.3) * Math.cos(y * 0.6 - t) * 0.5 + Math.sin((x + y) * 0.4 + t * 2) * 0.5;
        const rim = Math.pow(1 - Math.sqrt(Math.max(0, 1 - d * d)), 2);
        const v = n * 0.5 + 0.5 + rim * 0.8 + level * 0.5;
        const cell = Math.round(cx) + x + 0.5, row = Math.round(cy) + y + 0.5;
        if (v * 0.9 > k.th(Math.round(cell), Math.round(row)) + 0.25) k.put(cell, row, lvl(1 + v * 1.6));
      }
      // Three rings, each tilted and turning at its own speed.
      const spins = [0.7, -1.1, 0.45], tilts = [0.55, 0.32, 0.75], radii = [1.06, 1.18, 1.3];
      for (let i = 0; i < 3; i++) {
        const a0 = t * spins[i] + i * 1.7;
        for (let n = 0; n < 48; n++) {
          const a = a0 + (n / 48) * TAU;
          const [x, y] = ringAt(cx, cy, rad * radii[i], a, tilts[i]);
          if (k.th(Math.round(x), Math.round(y)) < 0.35) k.put(x, y, lvl(L - 1));
        }
      }
      // The neural field: a few dots on a shell that twinkle, brighter with a voice.
      const count = Math.min(140, Math.round((theme?.particles ?? 160) * 0.6));
      for (let i = 0; i < count; i++) {
        const a = i * 2.39996 + t * 0.08, y = 1 - (2 * (i + 0.5)) / count, rr = Math.sqrt(Math.max(0, 1 - y * y));
        const d = 0.9 + ((i * 37) % 100) / 400;
        const x = cx + Math.cos(a) * rr * rad * d, yy = cy + y * rad * d;
        if (Math.sin(t * 2.1 + i) < -0.6) continue;
        if (k.th(Math.round(x), Math.round(yy)) < 0.4 + level * 0.2) k.put(x, yy, lvl(L - 1));
      }
      // The heart: a bright core that swells with the voice.
      const hr = Math.max(1, Math.round(rad * (0.16 + level * 0.08)));
      for (let y = -hr; y <= hr; y++) for (let x = -hr; x <= hr; x++) {
        if (Math.hypot(x, y) <= hr) k.put(cx + x, cy + y, Math.hypot(x, y) < hr * 0.55 ? L : L - 1);
      }
    },

    /**
     * Cursor form: the structure, reduced to the few marks that still read at this size (a glyph of nine cells or so),
     * plus the tick at the hotspot. Each style keeps its own signature here, so the cursor says what the orb is doing
     * even when the widget itself is hidden behind the pointer.
     */
    cursor(k, cx, cy, hx, hy, st) {
      const L = k.L, t = st?.t ?? 0, level = clamp(st?.level ?? st?.voice ?? 0, 0, 1);
      const spin = t * (st?.mode === 'think' ? 2.4 : 0.9);
      const r = 4.8 + level * 1.1;
      const style = styleNow(st, R.theme?.current);
      const dot = (x, y, l = L - 1) => k.put(Math.round(x), Math.round(y), l);
      // A ring of cells on an ellipse, drawn as points (the LED grid has nothing thinner).
      const arc = (rx, ry, a0, a1, n, l = L - 1) => {
        for (let i = 0; i < n; i++) {
          const a = a0 + ((a1 - a0) * i) / (n - 1 || 1);
          dot(cx + Math.cos(a) * rx, cy + Math.sin(a) * ry, l);
        }
      };
      if (style === 'ring') {
        // A machined bezel with three gaps, a smaller broken track inside it, and a dark middle with a pin in it.
        for (let i = 0; i < 40; i++) {
          if ((i % 13) > 9) continue;
          const a = (i / 40) * TAU + spin * 0.35;
          dot(cx + Math.cos(a) * r, cy + Math.sin(a) * r, 4);
        }
        arc(r * 0.62, r * 0.62, Math.PI * 0.15 - spin * 0.6, Math.PI * 1.5 - spin * 0.6, 26, 3);
        dot(cx, cy, L);
      } else if (style === 'arcs') {
        // Two heavy broken tracks at their own radii, a few hairlines out of the middle, a bright pin.
        arc(r, r, 0.15 + spin * 0.2, 2.1 + spin * 0.2, 30, 4);
        arc(r * 0.66, r * 0.66, 2.6 - spin * 0.3, 4.9 - spin * 0.3, 24, 3);
        for (const a of [0.7, 2.4, 3.9, 5.5]) {
          for (let s = 0.3; s <= 1; s += 0.35) dot(cx + Math.cos(a) * r * s, cy + Math.sin(a) * r * s, 2);
        }
        dot(cx, cy, L);
      } else if (style === 'weave') {
        // Three loops crossing in different planes: the tangle, shrunk to what fits.
        arc(r, r * 0.55, 0, TAU, 34, 4);
        arc(r * 0.86, r * 0.86, spin * -0.8, spin * -0.8 + TAU, 30, 3);
        arc(r * 0.95, r * 0.32, spin * 1.4, spin * 1.4 + TAU, 26, 3);
        dot(cx, cy, 2);
      } else if (style === 'torus') {
        // Two smooth enclosing rings and the sweep of light running round the outer one.
        arc(r, r * 0.72, 0, TAU, 36, 3);
        arc(r * 0.55, r * 0.55, 0, TAU, 24, 2);
        const head = -spin * 1.2;
        arc(r * 0.92, r * 0.66, head - 0.5, head + 0.5, 9, L);
        dot(cx, cy, L);
      } else if (style === 'burst') {
        // Short radial streaks in every direction, dashed, out of a tight hot middle.
        for (let i = 0; i < 15; i++) {
          const a = (i / 15) * TAU + spin * 0.25;
          const far = 0.72 + ((i * 7) % 5) / 16;
          dot(cx + Math.cos(a) * r * 0.22, cy + Math.sin(a) * r * 0.22, 3);
          dot(cx + Math.cos(a) * r * (far - 0.22), cy + Math.sin(a) * r * (far - 0.22), 3);
          dot(cx + Math.cos(a) * r * far, cy + Math.sin(a) * r * far, 2);
        }
        dot(cx, cy, L);
      } else if (style === 'spokes') {
        // Fan clusters: three short spines in each of five directions, with a bead strung at their ends.
        for (let f = 0; f < 5; f++) {
          const base = (f / 5) * TAU + spin * 0.3;
          for (let j = -1; j <= 1; j++) {
            const a = base + j * 0.16;
            for (let s = 0.35; s <= 1.01; s += 0.3) dot(cx + Math.cos(a) * r * s, cy + Math.sin(a) * r * s, j === 0 ? 4 : 3);
          }
          dot(cx + Math.cos(base) * r * 1.08, cy + Math.sin(base) * r * 1.08, 4);
        }
        dot(cx, cy, 3);
      } else {
        // Hybrid: the reticle it has always been — an open bezel and the heart in the middle.
        for (let i = 0; i < 64; i++) {
          if (((i + 4) % 16) < 3) continue;
          const a = (i / 64) * TAU + spin;
          dot(cx + Math.cos(a) * r, cy + Math.sin(a) * r, 3);
        }
        dot(cx, cy, L);
        for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
          dot(cx + dx * (r + 1), cy + dy * (r + 1), 2);
        }
      }
      // The hotspot tick: from the pointer's own position to the body, so it's always clear what it's attached to.
      const dx = cx - hx, dy = cy - hy, n = Math.hypot(dx, dy) || 1;
      for (let i = 0; i <= 2; i++) dot(hx + (dx / n) * i, hy + (dy / n) * i, i === 0 ? L : L - 1);
    },

    // The patch the 3D render needs, in CSS px: the kit widens its drawing area to hold all of it, so the rings and
    // the glow aren't cropped at the edge of the lit cells.
    extent(P) {
      if (!view.on || !api?.ok) return null;
      // The bloom is the same frame drawn 1.14× wider, so the patch has to hold that too, or the glow is cut off
      // at its edge by the kit's rectangle.
      const r = view.r * view.px * HOOKS * 1.15;
      return [view.x - r, view.y - r, view.x + r, view.y + r];
    },

    // The render changes every frame, so the kit must not reuse a cached patch for it.
    get animated() { return !!view.on && !!api && api.ok && R.theme?.current?.animate !== false; },

    // The 3D layer, over the grid. Returns true when it drew (the kit uses that to know the frame is alive).
    over(ctx, env, st) {
      if (!view.on) return false;
      // While listening, the level is the microphone's (what was heard); otherwise it's the voice's.
      const level = st.level ?? (st.mode === 'listen' ? st.heard ?? 0 : st.voice ?? 0);
      return paint(ctx, env, { ...st, level }, R.theme?.current);
    },

    // Tests and diagnostics: the live renderer (null when WebGL 2 isn't there at all).
    get renderer() { return api; },
    dispose() { api?.dispose?.(); api = null; },
  };
  }

  // The look as the kit sees it (one shared instance for simple callers), and create() for a kit that wants its own.
  // instances: what each creature actually made, for diagnostics and tests.
  const instances = [];
  const create = () => { const part = make(); instances.push(part); return part; };
  R.hybrid = Object.assign(make(), { create, instances });
})();

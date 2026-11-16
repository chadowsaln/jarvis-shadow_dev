// The hybrid entity's renderer: WebGL 2, no libraries. Three parts, each drawn and animated on its own:
//   OrbCore       a plasma sphere: a ray-sphere in the fragment shader, value-noise plasma, Fresnel rim, energy
//                 waves running out of its middle; loudness (the voice or the microphone) drives their strength
//   ReactorRings  three mechanical rings, each on its own axis at its own speed, projected in 3D
//   NeuralField   a drifting shell of points with short links between neighbours, twinkling as they move
// Nothing here knows a color: every color, glow, opacity and count comes from Roamie.theme, so a theme change shows
// on the next frame and no preset is baked in. Nothing here knows what the app is doing either: it is handed a
// state name and a level.
//
// Cheap on purpose (an integrated GPU is the target): one full-screen quad, ~600 line vertices and up to 600 points
// per frame, no depth buffer, no render targets, additive blending. Quality steps down on its own when frames run
// long; a lost context is rebuilt, and if it can't be, `ok` goes false so the caller draws its 2D fallback.
// Classic script: window.Roamie.hybrid3d.
(() => {
  const R = (window.Roamie = window.Roamie || {});
  const clamp = (v, a, b) => (v < a ? a : v > b ? b : v);

  // The canvas holds 1.45 × the orb's radius each way (the rings reach 1.26), so clip space is squeezed by that:
  // without it the sphere would fill the whole canvas and the rings would fall outside it.
  const FIT = (1 / 1.45).toFixed(8);
  const VS_QUAD = `#version 300 es
in vec2 a_p;
out vec2 v_p;
void main() { v_p = a_p; gl_Position = vec4(a_p * ${FIT}, 0.0, 1.0); }`;

  // A sphere seen head on, and inside it plasma. p is the point on the sphere's disc (-1..1, y up), z the depth.
  const FS_ORB = `#version 300 es
precision mediump float;
in vec2 v_p;
out vec4 o;
uniform float u_time;
uniform float u_level;    // 0..1: the voice or the microphone
uniform float u_state;    // 0 idle, 1 listening, 2 thinking, 3 tool, 4 speaking, 5 success, 6 error, 7 offline
uniform vec3 u_core;
uniform vec3 u_reactor;
uniform vec3 u_neural;
uniform vec3 u_glow;
uniform float u_intensity;
uniform float u_transparency;

float hash(vec3 p) { return fract(sin(dot(p, vec3(12.9898, 78.233, 45.164))) * 43758.5453); }
float noise(vec3 p) {
  vec3 i = floor(p), f = fract(p);
  f = f * f * (3.0 - 2.0 * f);
  float a = mix(mix(mix(hash(i), hash(i + vec3(1,0,0)), f.x), mix(hash(i + vec3(0,1,0)), hash(i + vec3(1,1,0)), f.x), f.y),
                mix(mix(hash(i + vec3(0,0,1)), hash(i + vec3(1,0,1)), f.x), mix(hash(i + vec3(0,1,1)), hash(i + vec3(1,1,1)), f.x), f.y), f.z);
  return a;
}
float fbm(vec3 p) {
  float v = 0.0, a = 0.55;
  for (int i = 0; i < 2; i++) { v += a * noise(p); p *= 2.03; a *= 0.5; }
  return v;
}

void main() {
  float d2 = dot(v_p, v_p);
  if (d2 > 1.0) discard;
  float z = sqrt(max(0.0, 1.0 - d2));
  // The thinking orb runs faster; a listening one breathes; an error holds still and cuts its glow.
  float busy = (u_state > 1.5 && u_state < 2.5) ? 1.9 : (u_state > 2.5 && u_state < 3.5) ? 1.35 : 1.0;
  float calm = u_state > 5.5 ? 0.35 : 1.0;
  vec3 p = vec3(v_p, z);
  float plasma = fbm(p * 2.6 + vec3(0.0, 0.0, u_time * 0.55 * busy));
  plasma = smoothstep(0.18, 0.95, plasma + u_level * 0.35 + (u_state > 3.5 && u_state < 4.5 ? 0.12 : 0.0));
  // Energy waves: bright bands travelling out from the middle, stronger with the voice.
  float wave = 0.5 + 0.5 * sin(d2 * 16.0 - u_time * (2.2 + u_level * 5.0));
  float rim = pow(1.0 - z, 2.2);
  vec3 col = u_core * (0.22 + plasma * 0.95) + u_glow * wave * (0.10 + u_level * 0.30) + u_reactor * rim * 0.85 + u_neural * plasma * rim * 0.5;
  col *= calm;
  float a = (0.42 + rim * 0.5 + plasma * 0.18) * (1.0 - clamp(u_transparency, 0.0, 0.9));
  if (u_state > 6.5) a *= 0.45;                     // offline: a dim shell
  o = vec4(col * u_intensity, clamp(a, 0.0, 1.0) * (u_state > 6.5 ? 0.8 : 1.0));
}`;

  const VS_LINE = `#version 300 es
in vec3 a_p;
in float a_a;
out float v_a;
void main() { v_a = a_a; gl_Position = vec4(a_p.xy * ${FIT}, 0.0, 1.0); }`;
  const FS_LINE = `#version 300 es
precision mediump float;
in float v_a;
out vec4 o;
uniform vec3 u_color;
uniform float u_fade;
void main() { o = vec4(u_color * u_fade, v_a); }`;

  const VS_DOT = `#version 300 es
in vec3 a_p;
in float a_a;
in float a_s;
out float v_a;
uniform float u_scale;
void main() { v_a = a_a; gl_Position = vec4(a_p.xy * ${FIT}, 0.0, 1.0); gl_PointSize = max(1.0, a_s * u_scale); }`;
  const FS_DOT = `#version 300 es
precision mediump float;
in float v_a;
out vec4 o;
uniform vec3 u_color;
void main() {
  vec2 q = gl_PointCoord * 2.0 - 1.0;
  float d = dot(q, q);
  if (d > 1.0) discard;
  o = vec4(u_color, v_a * (1.0 - d) * 0.9);
}`;

  const RINGS = 3;
  const STATES = { idle: 0, listening: 1, thinking: 2, tool_execution: 3, speaking: 4, success: 5, error: 6, offline: 7 };

  const program = (gl, vs, fs) => {
    const mk = (type, src) => {
      const s = gl.createShader(type);
      gl.shaderSource(s, src);
      gl.compileShader(s);
      if (!gl.getShaderParameter(s, gl.COMPILE_STATUS)) {
        const log = gl.getShaderInfoLog(s);
        gl.deleteShader(s);
        throw new Error(`shader: ${log}`);
      }
      return s;
    };
    const p = gl.createProgram();
    const v = mk(gl.VERTEX_SHADER, vs), f = mk(gl.FRAGMENT_SHADER, fs);
    gl.attachShader(p, v); gl.attachShader(p, f); gl.linkProgram(p);
    gl.deleteShader(v); gl.deleteShader(f);
    if (!gl.getProgramParameter(p, gl.LINK_STATUS)) {
      const log = gl.getProgramInfoLog(p);
      gl.deleteProgram(p);
      throw new Error(`program: ${log}`);
    }
    return p;
  };
  const locs = (gl, p, names) => Object.fromEntries(names.map((n) => [n, gl.getUniformLocation(p, n)]));

  /**
   * A renderer over a canvas of its own. `ok` is false when WebGL 2 isn't there at all (the caller keeps its 2D
   * look); `stats.quality` says which step the automatic one settled on.
   */
  function create(opts = {}) {
    const api = {
      canvas: null, ok: false, failed: false, lost: 0,
      stats: { frames: 0, ms: 0, quality: 'high', points: 0, rings: 0 },
      dispose, resize, render, setQuality,
    };
    let gl = null, canvas = null, progs = null, bufs = null, quad = null;
    let w = 1, h = 1, dpr = 1, lostAt = 0, lost = false;
    let quality = 'high', frames = 0, slow = 0, fast = 0, ema = 16, lastDraw = 0, drewAny = 0;
    // Ring and neural geometry: built on the CPU (a few hundred points) and uploaded once per frame.
    const SEG = 72;           // segments per ring at full quality (half at low)
    const ringPts = new Float32Array(RINGS * SEG * 3);   // one bead per segment
    const ringA = new Float32Array(RINGS * SEG);
    const ringS = new Float32Array(RINGS * SEG);         // bead size, for the sweeper
    const MAXP = 600;
    const neuP = new Float32Array(MAXP * 3), neuA = new Float32Array(MAXP), neuS = new Float32Array(MAXP);
    const base = new Float32Array(MAXP * 4);                  // per point: dir.xyz + drift phase
    let pairs = new Int32Array(0), pairA = new Float32Array(0), pairV = new Float32Array(0);
    let built = 0;                                            // how many points the buffers hold

    api.canvas = canvas = document.createElement('canvas');
    const fail = (why) => { api.ok = false; api.failed = true; api.error = why; };

    function init() {
      try {
        gl = canvas.getContext('webgl2', { alpha: true, premultipliedAlpha: true, antialias: false, depth: false, stencil: false, powerPreference: 'low-power' });
      } catch (e) { gl = null; fail(String(e)); return false }
      if (!gl) { fail('no webgl2'); return false }
      try {
        progs = {
          orb: program(gl, VS_QUAD, FS_ORB),
          line: program(gl, VS_LINE, FS_LINE),
          dot: program(gl, VS_DOT, FS_DOT),
        };
      } catch (e) { fail(String(e?.message ?? e)); return false }
      progs.orbU = locs(gl, progs.orb, ['u_time', 'u_level', 'u_state', 'u_core', 'u_reactor', 'u_neural', 'u_glow', 'u_intensity', 'u_transparency']);
      progs.lineU = locs(gl, progs.line, ['u_color', 'u_fade']);
      progs.dotU = locs(gl, progs.dot, ['u_color', 'u_scale']);
      progs.orbA = gl.getAttribLocation(progs.orb, 'a_p');
      progs.lineA = { p: gl.getAttribLocation(progs.line, 'a_p'), a: gl.getAttribLocation(progs.line, 'a_a') };
      progs.dotA = { p: gl.getAttribLocation(progs.dot, 'a_p'), a: gl.getAttribLocation(progs.dot, 'a_a'), s: gl.getAttribLocation(progs.dot, 'a_s') };
      quad = gl.createBuffer();
      gl.bindBuffer(gl.ARRAY_BUFFER, quad);
      gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 1, -1, -1, 1, 1, 1]), gl.STATIC_DRAW);
      bufs = {
        ringP: gl.createBuffer(), ringA: gl.createBuffer(), ringS: gl.createBuffer(),
        neuP: gl.createBuffer(), neuA: gl.createBuffer(), neuS: gl.createBuffer(),
        linkP: gl.createBuffer(), linkA: gl.createBuffer(),
      };
      gl.disable(gl.DEPTH_TEST);
      gl.enable(gl.BLEND);
      gl.blendFunc(gl.SRC_ALPHA, gl.ONE);   // additive: light on light
      gl.clearColor(0, 0, 0, 0);
      api.ok = true; api.failed = false; api.error = null;
      lost = false;
      return true;
    }

    // A lost context (a GPU reset, a driver update, a tab suspended too long) is rebuilt once; a second loss in a
    // minute means this machine can't keep it, and the 2D look takes over for good.
    canvas.addEventListener('webglcontextlost', (e) => {
      e.preventDefault();
      lost = true; api.lost++;
      if (api.lost > 2 || (lostAt && Date.now() - lostAt < 60_000)) fail('context lost twice');
      else lostAt = Date.now();
      api.ok = false;
    });
    canvas.addEventListener('webglcontextrestored', () => { lost = false; if (!api.failed) init() });

    function setQuality(q) {
      const next = q === 'low' || q === 'high' ? q : quality;
      if (next === quality) return;
      quality = next;
    }

    function resize(width, height, scale = 1) {
      const nw = Math.max(1, Math.round(width)), nh = Math.max(1, Math.round(height)), nd = clamp(scale, 1, 2);
      if (nw === w && nh === h && nd === dpr && canvas.width) return;   // every frame calls this: resizing reallocates
      w = nw; h = nh; dpr = nd;
      canvas.width = Math.round(w * dpr);
      canvas.height = Math.round(h * dpr);
      if (gl) gl.viewport(0, 0, canvas.width, canvas.height);
    }

    // Closest point pairs on the shell: links only where they won't turn the field into a mesh. Recomputed when the
    // count changes (a quality step, a new particle setting), never per frame.
    function build(count) {
      if (count === built) return;
      built = count;
      // The shell's points are spread over the count in use, not over the maximum: slicing the first few of a full
      // sphere would leave every point on the top cap instead of all around it.
      for (let i = 0; i < count; i++) {
        const y = 1 - (2 * (i + 0.5)) / count, r = Math.sqrt(Math.max(0, 1 - y * y)), a = i * 2.39996;
        const shell = 0.86 + seeded(i, 1) * 0.28;
        base[i * 4] = Math.cos(a) * r * shell;
        base[i * 4 + 1] = y * shell;
        base[i * 4 + 2] = Math.sin(a) * r * shell;
        base[i * 4 + 3] = seeded(i, 2) * Math.PI * 2;
      }
      pairs = new Int32Array(count * 3);
      pairV = new Float32Array(count * 3 * 2 * 3);
      pairA = new Float32Array(count * 3 * 2);
      for (let i = 0; i < count; i++) {
        const a = base[i * 4], b = base[i * 4 + 1], c = base[i * 4 + 2];
        let best = [-1, -1, -1], bd = [4, 4, 4];
        for (let j = 0; j < count; j++) {
          if (j === i) continue;
          const d = (base[j * 4] - a) ** 2 + (base[j * 4 + 1] - b) ** 2 + (base[j * 4 + 2] - c) ** 2;
          if (d < bd[0]) { bd[2] = bd[1]; best[2] = best[1]; bd[1] = bd[0]; best[1] = best[0]; bd[0] = d; best[0] = j; }
          else if (d < bd[1]) { bd[2] = bd[1]; best[2] = best[1]; bd[1] = d; best[1] = j; }
          else if (d < bd[2]) { bd[2] = d; best[2] = j; }
        }
        for (let k = 0; k < 3; k++) pairs[i * 3 + k] = best[k];
      }
    }

    const seeded = (i, k) => {
      const x = Math.sin(i * 12.9898 + k * 78.233) * 43758.5453;
      return x - Math.floor(x);
    };

    /**
     * Draws one frame into the canvas. level: 0..1 loudness, state: one of Roamie.orbState.STATES (or a number),
     * theme: Roamie.theme.current, now: ms. Returns false when nothing was drawn (not ready, too soon, hidden).
     */
    function render({ t = 0, dt = 1 / 60, level = 0, state = 'idle', theme, now = 0, fps = 60 } = {}) {
      if (!api.ok && !api.failed) init();
      if (!api.ok) return false;
      if (lost) { init(); return false; }
      const th = theme || R.theme?.current || {};
      if (!th.animate && drewAny) return false;                 // animation off: the last frame stays
      // Frame-rate control: never more than the budget, and nothing at all when the page is hidden (the host's draw
      // loop stops then anyway; this is the belt and braces).
      const budget = quality === 'high' ? 1000 / Math.max(24, Math.min(fps, 60)) : 1000 / 30;
      if (now - lastDraw < budget) return false;
      const frameMs = lastDraw ? now - lastDraw : 16;
      lastDraw = now;
      // Auto quality: long frames step down, comfortable ones step back up slowly.
      if (th.quality === 'auto') {
        ema = ema * 0.9 + frameMs * 0.1;
        slow = ema > 28 ? slow + 1 : 0;
        fast = ema < 13 ? fast + 1 : 0;
        if (slow > 20 && quality === 'high') { setQuality('low'); slow = fast = 0; }
        else if (fast > 180 && quality === 'low') { setQuality('high'); slow = fast = 0; }
      } else setQuality(th.quality);

      const points = clamp(Math.round((th.particles ?? 160) * (quality === 'high' ? 1 : 0.5)), 0, MAXP);
      const seg = quality === 'high' ? SEG : SEG >> 1;
      const lvl = th.audioReactive === false ? 0 : clamp(level, 0, 1);
      const st = typeof state === 'number' ? state : (STATES[state] ?? 0);
      const core = R.theme.toRgb(th.core), reactor = R.theme.toRgb(th.reactor), neural = R.theme.toRgb(th.neural), glow = R.theme.toRgb(th.glow);
      const n3 = (c) => [c[0] / 255, c[1] / 255, c[2] / 255];

      gl.clear(gl.COLOR_BUFFER_BIT);
      // ---- the orb ----
      gl.useProgram(progs.orb);
      gl.bindBuffer(gl.ARRAY_BUFFER, quad);
      gl.enableVertexAttribArray(progs.orbA);
      gl.vertexAttribPointer(progs.orbA, 2, gl.FLOAT, false, 0, 0);
      gl.uniform1f(progs.orbU.u_time, t);
      gl.uniform1f(progs.orbU.u_level, lvl);
      gl.uniform1f(progs.orbU.u_state, st);
      gl.uniform3fv(progs.orbU.u_core, n3(core));
      gl.uniform3fv(progs.orbU.u_reactor, n3(reactor));
      gl.uniform3fv(progs.orbU.u_neural, n3(neural));
      gl.uniform3fv(progs.orbU.u_glow, n3(glow));
      gl.uniform1f(progs.orbU.u_intensity, 1 + (th.glowIntensity ?? 0.85) * 0.35);
      gl.uniform1f(progs.orbU.u_transparency, clamp(th.transparency ?? 0, 0, 0.9));
      gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);

      // ---- the rings: three, each on its own two axes, tilt fixed so they read as one machine ----
      let v = 0, ai = 0;
      const spin = [0.7, -1.1, 0.45], tiltX = [0.35, 1.15, -0.55], tiltY = [0.2, -0.6, 1.0];
      const rad = [0.98, 1.12, 1.26];
      const speed = st === 2 ? 1.9 : st === 3 ? 1.35 : st === 4 ? 1.15 : 1;
      for (let i = 0; i < RINGS; i++) {
        const a = t * spin[i] * speed + i * 1.7;
        const tx = tiltX[i] + Math.sin(t * 0.21 + i) * 0.12, ty = tiltY[i] + Math.cos(t * 0.17 + i) * 0.1;
        const cA = Math.cos(tx), sA = Math.sin(tx), cB = Math.cos(ty), sB = Math.sin(ty);
        const rr = rad[i] * (1 + lvl * 0.03 * (i + 1));
        // The ring is a chain of glowing beads, not a hairline: a 1px line reads as a scratch across the orb, a
        // chain reads as something built. Two beads a turn are left dark (a machined break), the rest get brighter
        // where the ring's own sweeper passes.
        const TICKS = 24;
        for (let k = 0; k < seg; k++) {
          const u = k / seg, th2 = a + u * Math.PI * 2;
          // A circle in its own plane, then tilted: two rotations about different axes (the multi-axis part).
          const x0 = Math.cos(th2) * rr, y0 = Math.sin(th2) * rr, z0 = 0;
          const y1 = y0 * cA - z0 * sA, z1 = y0 * sA + z0 * cA;
          const x2 = x0 * cB + z1 * sB, z2 = -x0 * sB + z1 * cB;
          const depth = clamp(0.55 + y1 * 0.35 + z1 * 0.15, 0.2, 1);
          const sweep = Math.pow(Math.max(0, Math.sin(u * Math.PI * 2 * (i + 1) - t * 2.2)), 6);
          if (u * TICKS % 1 < 0.2) continue;
          ringPts[v] = x2; ringPts[v + 1] = y1; ringPts[v + 2] = z2; v += 3;
          ringA[ai] = clamp(depth * (0.35 + sweep * 0.8), 0, 1);
          ringS[ai] = (quality === 'high' ? 2.6 : 2.2) * (0.75 + sweep * 0.9);
          ai++;
        }
      }
      gl.useProgram(progs.dot);
      gl.bindBuffer(gl.ARRAY_BUFFER, bufs.ringP);
      gl.bufferData(gl.ARRAY_BUFFER, ringPts.subarray(0, v), gl.DYNAMIC_DRAW);
      gl.enableVertexAttribArray(progs.dotA.p);
      gl.vertexAttribPointer(progs.dotA.p, 3, gl.FLOAT, false, 0, 0);
      gl.bindBuffer(gl.ARRAY_BUFFER, bufs.ringA);
      gl.bufferData(gl.ARRAY_BUFFER, ringA.subarray(0, ai), gl.DYNAMIC_DRAW);
      gl.enableVertexAttribArray(progs.dotA.a);
      gl.vertexAttribPointer(progs.dotA.a, 1, gl.FLOAT, false, 0, 0);
      gl.bindBuffer(gl.ARRAY_BUFFER, bufs.ringS);
      gl.bufferData(gl.ARRAY_BUFFER, ringS.subarray(0, ai), gl.DYNAMIC_DRAW);
      gl.enableVertexAttribArray(progs.dotA.s);
      gl.vertexAttribPointer(progs.dotA.s, 1, gl.FLOAT, false, 0, 0);
      gl.uniform3fv(progs.dotU.u_color, n3(reactor));
      gl.uniform1f(progs.dotU.u_scale, dpr);
      gl.drawArrays(gl.POINTS, 0, ai);

      // ---- the neural field: drifting points and the links between close ones ----
      if (points > 0) {
        build(points);
        const drift = st === 0 ? 0.06 : 0.12 + lvl * 0.14;
        const breathe = 1 + Math.sin(t * 1.3) * 0.02 + lvl * 0.05;
        for (let i = 0; i < points; i++) {
          const ph = base[i * 4 + 3];
          const wob = Math.sin(t * 0.9 + ph) * drift, wob2 = Math.cos(t * 0.7 + ph * 1.3) * drift;
          const x = base[i * 4] * breathe + wob, y = base[i * 4 + 1] * breathe + wob2, z = base[i * 4 + 2] * breathe;
          neuP[i * 3] = x; neuP[i * 3 + 1] = y; neuP[i * 3 + 2] = z;
          // Points twinkle out of step; quieter while idle, bright with a voice.
          neuA[i] = clamp(0.25 + (th.particleOpacity ?? 0.75) * (0.55 + 0.45 * Math.sin(t * 2.1 + ph)) + lvl * 0.4, 0, 1);
          neuS[i] = (quality === 'high' ? 3.2 : 2.4) * (0.7 + 0.5 * Math.sin(t * 3 + ph));
        }
        let pv = 0, pa = 0;
        for (let i = 0; i < points; i++) {
          for (let k = 0; k < 3; k++) {
            const j = pairs[i * 3 + k];
            if (j < 0 || j < i) continue;
            const dx = neuP[j * 3] - neuP[i * 3], dy = neuP[j * 3 + 1] - neuP[i * 3 + 1], dz = neuP[j * 3 + 2] - neuP[i * 3 + 2];
            const d2 = dx * dx + dy * dy + dz * dz;
            if (d2 > 0.09) continue;   // only neighbours
            pairV[pv] = neuP[i * 3]; pairV[pv + 1] = neuP[i * 3 + 1]; pairV[pv + 2] = neuP[i * 3 + 2]; pv += 3;
            pairV[pv] = neuP[j * 3]; pairV[pv + 1] = neuP[j * 3 + 1]; pairV[pv + 2] = neuP[j * 3 + 2]; pv += 3;
            const a2 = (1 - d2 / 0.09) * 0.5 * (th.particleOpacity ?? 0.75);
            pairA[pa++] = a2; pairA[pa++] = a2;
          }
        }
        if (pv) {
          // The rings above left the dot program bound: the links need the line program (its uniforms and attributes).
          gl.useProgram(progs.line);
          gl.bindBuffer(gl.ARRAY_BUFFER, bufs.linkP);
          gl.bufferData(gl.ARRAY_BUFFER, pairV.subarray(0, pv), gl.DYNAMIC_DRAW);
          gl.enableVertexAttribArray(progs.lineA.p);
          gl.vertexAttribPointer(progs.lineA.p, 3, gl.FLOAT, false, 0, 0);
          gl.bindBuffer(gl.ARRAY_BUFFER, bufs.linkA);
          gl.bufferData(gl.ARRAY_BUFFER, pairA.subarray(0, pa), gl.DYNAMIC_DRAW);
          gl.enableVertexAttribArray(progs.lineA.a);
          gl.vertexAttribPointer(progs.lineA.a, 1, gl.FLOAT, false, 0, 0);
          gl.uniform3fv(progs.lineU.u_color, n3(neural));
          gl.uniform1f(progs.lineU.u_fade, 0.6);
          gl.drawArrays(gl.LINES, 0, pv / 3);
        }
        gl.useProgram(progs.dot);
        gl.bindBuffer(gl.ARRAY_BUFFER, bufs.neuP);
        gl.bufferData(gl.ARRAY_BUFFER, neuP.subarray(0, points * 3), gl.DYNAMIC_DRAW);
        gl.enableVertexAttribArray(progs.dotA.p);
        gl.vertexAttribPointer(progs.dotA.p, 3, gl.FLOAT, false, 0, 0);
        gl.bindBuffer(gl.ARRAY_BUFFER, bufs.neuA);
        gl.bufferData(gl.ARRAY_BUFFER, neuA.subarray(0, points), gl.DYNAMIC_DRAW);
        gl.enableVertexAttribArray(progs.dotA.a);
        gl.vertexAttribPointer(progs.dotA.a, 1, gl.FLOAT, false, 0, 0);
        gl.bindBuffer(gl.ARRAY_BUFFER, bufs.neuS);
        gl.bufferData(gl.ARRAY_BUFFER, neuS.subarray(0, points), gl.DYNAMIC_DRAW);
        gl.enableVertexAttribArray(progs.dotA.s);
        gl.vertexAttribPointer(progs.dotA.s, 1, gl.FLOAT, false, 0, 0);
        gl.uniform3fv(progs.dotU.u_color, n3(neural));
        gl.uniform1f(progs.dotU.u_scale, dpr * (quality === 'high' ? 1 : 0.8));
        gl.drawArrays(gl.POINTS, 0, points);
      }

      frames++;
      drewAny = now;
      api.stats = { frames, ms: Math.round(ema * 10) / 10, quality, points, rings: RINGS };
      return true;
    }

    /** Frees every GL object and drops the context: called when the look is replaced or the page goes away. */
    function dispose() {
      try {
        if (gl) {
          for (const p of progs ? [progs.orb, progs.line, progs.dot] : []) gl.deleteProgram(p);
          if (quad) gl.deleteBuffer(quad);
          for (const b of bufs ? Object.values(bufs) : []) gl.deleteBuffer(b);
          gl.getExtension('WEBGL_lose_context')?.loseContext();
        }
      } catch { /* already gone */ }
      gl = null; progs = null; bufs = null; quad = null;
      api.ok = false;
      drewAny = 0;
      frames = 0;
    }

    init();
    return api;
  }

  R.hybrid3d = { create, STATES };
})();

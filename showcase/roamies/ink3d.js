// 3D models for drawings: a tiny WebGL renderer (boxes, spheres, cylinders, cones, tori with their own transforms,
// Lambert light plus a rim light, a slow turn), read back at a small size and dithered into the Sidekick's five LED
// levels, so a model looks like the rest of it. A part can move (spin, orbit, slide, pulse) to show how a thing works.
// A part can also carry its own colour (the model's `color`), and a sphere can be a planet: the countries of
// world.js go on it as a mask, sampled by the sphere's own latitude and longitude, so they turn with it.
// ink.js draws the cells inside a card. No dependencies.
(() => {
  const R = window.Roamie;
  if (!R || typeof document === 'undefined') return;
  const B4 = [0, 8, 2, 10, 12, 4, 14, 6, 3, 11, 1, 9, 15, 7, 13, 5];
  const TONE_K = { white: 1.08, accent: 1, teal: 1, sky: 0.95, lime: 0.95, amber: 0.92, lilac: 0.88, coral: 0.85, red: 0.8 };
  // A world's sea and land, when the model doesn't say.
  const SEA = '#2f6fd0', LAND = '#3f9e4f';

  // ---------------------------------------------------------------- meshes: [positions, normals] as flat triangle lists
  function mesh(fn, nu, nv) {
    const pos = [], nor = [];
    for (let i = 0; i < nu; i++) for (let j = 0; j < nv; j++) {
      const q = [[i, j], [i + 1, j], [i + 1, j + 1], [i, j], [i + 1, j + 1], [i, j + 1]];
      for (const [a, b] of q) { const [p, n] = fn(a / nu, b / nv); pos.push(...p); nor.push(...n); }
    }
    return [pos, nor];
  }
  const TAU = Math.PI * 2;
  const SHAPES = {
    sphere: () => mesh((u, v) => { const t = u * TAU, f = v * Math.PI, n = [Math.sin(f) * Math.cos(t), Math.cos(f), Math.sin(f) * Math.sin(t)]; return [n.map((x) => x * 0.5), n]; }, 24, 14),
    torus: () => mesh((u, v) => { const t = u * TAU, f = v * TAU, R0 = 0.36, r = 0.14, c = [Math.cos(t), 0, Math.sin(t)], n = [Math.cos(f) * c[0], Math.sin(f), Math.cos(f) * c[2]]; return [[c[0] * R0 + n[0] * r, n[1] * r, c[2] * R0 + n[2] * r], n]; }, 28, 12),
    // Sides plus caps: cone is a cylinder whose top radius is 0.
    cylinder: (top = 0.5) => {
      const side = mesh((u, v) => { const t = u * TAU, rr = 0.5 + (top - 0.5) * v, k = 0.5 - top, n = [Math.cos(t), k, Math.sin(t)], l = Math.hypot(...n); return [[Math.cos(t) * rr, v - 0.5, Math.sin(t) * rr], n.map((x) => x / l)]; }, 24, 1);
      const pos = [...side[0]], nor = [...side[1]];
      for (const [y, r, ny] of [[-0.5, 0.5, -1], [0.5, top, 1]]) {
        if (r <= 0) continue;
        for (let i = 0; i < 24; i++) { const a = (i / 24) * TAU, b = ((i + 1) / 24) * TAU; pos.push(0, y, 0, Math.cos(a) * r, y, Math.sin(a) * r, Math.cos(b) * r, y, Math.sin(b) * r); nor.push(0, ny, 0, 0, ny, 0, 0, ny, 0); }
      }
      return [pos, nor];
    },
    cone: () => SHAPES.cylinder(0),
    box: () => {
      const pos = [], nor = [];
      for (const [ax, s] of [[0, 1], [0, -1], [1, 1], [1, -1], [2, 1], [2, -1]]) {
        const u = (ax + 1) % 3, v = (ax + 2) % 3, c = (a, b) => { const p = [0, 0, 0]; p[ax] = 0.5 * s; p[u] = a * 0.5; p[v] = b * 0.5 * s; return p; }, n = [0, 0, 0]; n[ax] = s;
        for (const [a, b] of [[-1, -1], [1, -1], [1, 1], [-1, -1], [1, 1], [-1, 1]]) { pos.push(...c(a, b)); nor.push(...n); }
      }
      return [pos, nor];
    },
  };

  // ---------------------------------------------------------------- the world's countries, as a mask for a planet
  // One equirectangular canvas (x: longitude -180…180, y: latitude 90…-90) from the outlines already shipped for map
  // cards (world.js). Drawn once, kept. null when that file isn't there: the sphere is then plain sea.
  let landCv;
  function landCanvas() {
    if (landCv !== undefined) return landCv;
    const world = R.world;
    if (!world?.countries?.length) return (landCv = null);
    const W = 512, H = 256, cv = document.createElement('canvas');
    cv.width = W; cv.height = H;
    const g = cv.getContext('2d', { willReadFrequently: false });
    g.fillStyle = '#000'; g.fillRect(0, 0, W, H);
    g.fillStyle = '#fff';
    const q = world.q || 50;
    for (const [, rings] of world.countries) for (const ring of rings) {
      if (ring.length < 6) continue;
      g.beginPath();
      // Flat [x, y, dx, dy, …] in 1/q of a degree: the first point, then steps from the one before.
      let x = ring[0], y = ring[1];
      g.moveTo(((x / q + 180) / 360) * W, ((90 - y / q) / 180) * H);
      for (let i = 2; i < ring.length; i += 2) {
        x += ring[i]; y += ring[i + 1];
        g.lineTo(((x / q + 180) / 360) * W, ((90 - y / q) / 180) * H);
      }
      g.closePath();
      g.fill();
    }
    return (landCv = cv);
  }

  // ---------------------------------------------------------------- 4×4 matrices (column-major, as GL wants)
  const mul = (a, b) => { const o = new Array(16).fill(0); for (let c = 0; c < 4; c++) for (let r = 0; r < 4; r++) for (let k = 0; k < 4; k++) o[c * 4 + r] += a[k * 4 + r] * b[c * 4 + k]; return o; };
  const T = (x, y, z) => [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, x, y, z, 1];
  const S = (x, y, z) => [x, 0, 0, 0, 0, y, 0, 0, 0, 0, z, 0, 0, 0, 0, 1];
  const RX = (a) => { const c = Math.cos(a), s = Math.sin(a); return [1, 0, 0, 0, 0, c, s, 0, 0, -s, c, 0, 0, 0, 0, 1]; };
  const RY = (a) => { const c = Math.cos(a), s = Math.sin(a); return [c, 0, -s, 0, 0, 1, 0, 0, s, 0, c, 0, 0, 0, 0, 1]; };
  const RZ = (a) => { const c = Math.cos(a), s = Math.sin(a); return [c, s, 0, 0, -s, c, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1]; };
  const persp = (fov, asp, n, f) => { const t = 1 / Math.tan(fov / 2); return [t / asp, 0, 0, 0, 0, t, 0, 0, 0, 0, (f + n) / (n - f), -1, 0, 0, (2 * f * n) / (n - f), 0]; };
  const apply = (m, [x, y, z]) => [0, 1, 2, 3].map((r) => m[r] * x + m[4 + r] * y + m[8 + r] * z + m[12 + r]);

  const VS = `attribute vec3 p; attribute vec3 n; uniform mat4 mvp; uniform mat4 model; varying vec3 vn; varying vec3 vp; varying vec3 vo;
    void main(){ vec4 w = model * vec4(p, 1.0); vp = w.xyz; vn = (model * vec4(n, 0.0)).xyz; vo = n; gl_Position = mvp * vec4(p, 1.0); }`;
  // glass: a casing with parts inside it is drawn as every other cell, so what moves inside shows through.
  // The green channel carries the part's colour (its index), the blue one says land: the cells are read back and
  // painted in that colour, so a part keeps its own hue instead of the Sidekick's teal.
  const FS = `precision mediump float; varying vec3 vn; varying vec3 vp; varying vec3 vo; uniform float k; uniform vec3 eye; uniform float glass;
    uniform float id; uniform float planet; uniform sampler2D land;
    void main(){ if (glass > 0.5 && mod(floor(gl_FragCoord.x / 2.0) + floor(gl_FragCoord.y / 2.0), 2.0) < 0.5) discard; vec3 N = normalize(vn); vec3 L = normalize(vec3(-0.45, 0.75, 0.55)); vec3 Vd = normalize(eye - vp);
      float lam = max(dot(N, L), 0.0), rim = pow(1.0 - max(dot(N, Vd), 0.0), 2.2);
      float land1 = 0.0;
      if (planet > 0.5) {
        // The part's own space, so the continents turn with it rather than staying put on screen.
        vec3 o = normalize(vo);
        vec2 uv = vec2(atan(o.z, o.x) / 6.2831853 + 0.5, acos(clamp(o.y, -1.0, 1.0)) / 3.1415927);
        land1 = step(0.5, texture2D(land, uv).r);
      }
      float v = clamp((0.16 + 0.72 * lam + 0.42 * rim) * k, 0.0, 1.0);
      // Sea sits well below land (and stays dark, like deep water), so a world shows its continents even in one colour.
      if (planet > 0.5) v = clamp(v * (land1 > 0.5 ? 1.06 : 0.6) + (land1 > 0.5 ? 0.06 : 0.0), 0.0, 1.0);
      gl_FragColor = vec4(v, id / 255.0, land1, 1.0); }`;

  // How a part moves, each a loop of `secs` seconds: spin turns it in place about a world axis, orbit carries it round a
  // point (turning with it, like a blade on a hub), slide takes it to `to` and back, pulse swells and shrinks it.
  const ROT = { x: RX, y: RY, z: RZ }, CYCLE = { spin: 4, orbit: 6, slide: 2, pulse: 1.6 };
  function moved(it, t) {
    const mo = it.motion;
    let at = it.at, size = it.size, turn = null;
    if (mo) {
      const ph = (t / Math.max(0.3, Math.min(60, mo.secs ?? CYCLE[mo.do]))) * TAU;
      if (mo.do === 'spin') turn = ROT[mo.axis ?? 'y'](ph);
      else if (mo.do === 'orbit') { const c = mo.around ?? [0, 0, 0]; turn = ROT[mo.axis ?? 'y'](ph); at = apply(turn, at.map((v, i) => v - c[i])).slice(0, 3).map((v, i) => v + c[i]); }
      else if (mo.do === 'slide') { const k = (1 - Math.cos(ph)) / 2, to = mo.to ?? at; at = at.map((v, i) => v + (to[i] - v) * k); }
      else if (mo.do === 'pulse') size = size.map((v) => v * (1 + 0.14 * Math.sin(ph)));
    }
    const own = mul(it.turn, S(size[0], size[1], size[2]));
    return { at, local: mul(T(at[0], at[1], at[2]), turn ? mul(turn, own) : own) };
  }

  /**
   * A model from parts [{shape, at, size, rot (degrees), tone, color, label, motion, planet, land}], drawn into a cell
   * grid (3 px cells) w × h px.
   * frame(t) → { gw, gh, lv: levels 0 (empty) … 4, pal: colour index per cell (0: the app's palette), st: 1 where that
   * part's land shows, tints: [{sea, land} | null] by pal, labels: [{x, y, text}] in px within the area }. null without WebGL.
   */
  function create(parts, w, h) {
    const gw = Math.max(8, Math.floor(w / 3)), gh = Math.max(8, Math.floor(h / 3)), SS = 2;
    const cv = document.createElement('canvas'); cv.width = gw * SS; cv.height = gh * SS;
    const gl = cv.getContext('webgl', { antialias: false, preserveDrawingBuffer: true, alpha: true });
    if (!gl) return null;
    const sh = (type, src) => { const s = gl.createShader(type); gl.shaderSource(s, src); gl.compileShader(s); if (!gl.getShaderParameter(s, gl.COMPILE_STATUS)) throw new Error(gl.getShaderInfoLog(s)); return s; };
    const prog = gl.createProgram();
    try { gl.attachShader(prog, sh(gl.VERTEX_SHADER, VS)); gl.attachShader(prog, sh(gl.FRAGMENT_SHADER, FS)); gl.linkProgram(prog); } catch (e) { console.error('ink3d', e); return null; }
    if (!gl.getProgramParameter(prog, gl.LINK_STATUS)) return null;
    gl.useProgram(prog);
    const at = { p: gl.getAttribLocation(prog, 'p'), n: gl.getAttribLocation(prog, 'n'), mvp: gl.getUniformLocation(prog, 'mvp'), model: gl.getUniformLocation(prog, 'model'), k: gl.getUniformLocation(prog, 'k'), eye: gl.getUniformLocation(prog, 'eye'), glass: gl.getUniformLocation(prog, 'glass'), id: gl.getUniformLocation(prog, 'id'), planet: gl.getUniformLocation(prog, 'planet'), land: gl.getUniformLocation(prog, 'land') };
    const cache = {};
    const buf = (data) => { const b = gl.createBuffer(); gl.bindBuffer(gl.ARRAY_BUFFER, b); gl.bufferData(gl.ARRAY_BUFFER, new Float32Array(data), gl.STATIC_DRAW); return b; };
    // Each colour a part asks for is one entry (0 is "no colour": the app's own LED palette).
    const tints = [null];
    const tintOf = (sea, land) => {
      const i = tints.findIndex((t) => t && t.sea === sea && t.land === (land ?? null));
      if (i > 0) return i;
      tints.push({ sea, land: land ?? null });
      return tints.length - 1;
    };
    const items = parts.slice(0, 40).map((q) => {
      const g = (cache[q.shape] ??= (() => { const [p, n] = SHAPES[q.shape](); return { p: buf(p), n: buf(n), count: p.length / 3 }; })());
      const [x, y, z] = q.at ?? [0, 0, 0], [sx, sy, sz] = q.size ?? [0.5, 0.5, 0.5], [rx, ry, rz] = (q.rot ?? [0, 0, 0]).map((d) => (d * Math.PI) / 180);
      const planet = !!q.planet && q.shape === 'sphere';
      return { g, turn: mul(RZ(rz), mul(RY(ry), RX(rx))), size: [sx, sy, sz], motion: q.motion, planet,
        pal: planet || q.color ? tintOf(q.color || SEA, planet ? q.land || LAND : null) : 0,
        k: q.color || planet ? 1 : TONE_K[q.tone] ?? 1, label: q.label, at: [x, y, z], r: Math.max(sx, sy, sz) * (q.motion?.do === 'pulse' ? 1.14 : 1) };
    });
    // The world's outlines, as a texture, only when some part is a planet.
    const landTex = (() => {
      if (!items.some((it) => it.planet)) return null;
      const lcv = landCanvas();
      if (!lcv) return null;
      const t = gl.createTexture();
      gl.bindTexture(gl.TEXTURE_2D, t);
      gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, false);
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, lcv);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.REPEAT); // longitude wraps at the antimeridian
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
      return t;
    })();
    // Fit the whole model in view, wherever its parts move to: centre it and scale its bounding sphere to about one unit.
    const reach = items.map((it) => (it.motion ? Array.from({ length: 8 }, (_, k) => moved(it, (k / 8) * Math.max(0.3, Math.min(60, it.motion.secs ?? CYCLE[it.motion.do]))).at) : [it.at]));
    // A still part that holds smaller ones inside it, wherever they move (a cylinder round its piston): see-through.
    const within = (it, q) => { const d = q.map((v, i) => v - it.at[i]), m = it.turn; return [0, 4, 8].every((c, i) => Math.abs((m[c] * d[0] + m[c + 1] * d[1] + m[c + 2] * d[2]) / (it.size[i] || 1e-6)) < 0.5); };
    for (const it of items) it.glass = !it.motion && items.some((o, n) => o !== it && o.r < it.r && reach[n].every((q) => within(it, q)));
    // Each part counts once, at the middle of where it goes.
    const c = reach.reduce((a, qs) => a.map((v, i) => v + qs.reduce((s2, q) => s2 + q[i], 0) / qs.length / items.length), [0, 0, 0]);
    // Unit shapes reach about 0.5 from their centre (a box's corner a little more), times their size.
    const rad = Math.max(0.3, ...items.flatMap((it, n) => reach[n].map((q) => Math.hypot(...q.map((v, i) => v - c[i])) + it.r * 0.6)));
    const fit = mul(S(1 / rad, 1 / rad, 1 / rad), T(-c[0], -c[1], -c[2]));
    const px = new Uint8Array(gw * SS * gh * SS * 4), lv = new Uint8Array(gw * gh), pal = new Uint8Array(gw * gh), st = new Uint8Array(gw * gh);
    let lastT = -1, out = { gw, gh, lv, pal, st, tints, labels: [] };
    gl.enable(gl.DEPTH_TEST); gl.viewport(0, 0, gw * SS, gh * SS);
    return {
      frame(t) {
        // A slow turn, redrawn about 30 times a second.
        if (lastT >= 0 && Math.abs(t - lastT) < 1 / 30) return out;
        lastT = t;
        const view = mul(T(0, 0, -3.4), mul(RX(0.38), RY(t * 0.45 + 0.6))), proj = persp(0.62, gw / gh, 0.1, 20), vp = mul(proj, view);
        gl.clearColor(0, 0, 0, 0); gl.clear(gl.COLOR_BUFFER_BIT | gl.DEPTH_BUFFER_BIT);
        gl.uniform3fv(at.eye, [0, 0, 3.4]);
        // The mask lives on texture unit 0, so the sampler must read unit 0 (unit 1 has no texture: sampling it is black).
        gl.activeTexture(gl.TEXTURE0);
        gl.uniform1i(at.land, 0);
        if (landTex) gl.bindTexture(gl.TEXTURE_2D, landTex);
        const now = items.map((it) => moved(it, t));
        for (const [n, it] of items.entries()) {
          const model = mul(view, mul(fit, now[n].local));
          gl.uniformMatrix4fv(at.model, false, new Float32Array(model));
          gl.uniformMatrix4fv(at.mvp, false, new Float32Array(mul(proj, model)));
          gl.uniform1f(at.k, it.k); gl.uniform1f(at.glass, it.glass ? 1 : 0);
          gl.uniform1f(at.id, it.pal); gl.uniform1f(at.planet, it.planet && landTex ? 1 : 0);
          gl.bindBuffer(gl.ARRAY_BUFFER, it.g.p); gl.enableVertexAttribArray(at.p); gl.vertexAttribPointer(at.p, 3, gl.FLOAT, false, 0, 0);
          gl.bindBuffer(gl.ARRAY_BUFFER, it.g.n); gl.enableVertexAttribArray(at.n); gl.vertexAttribPointer(at.n, 3, gl.FLOAT, false, 0, 0);
          gl.drawArrays(gl.TRIANGLES, 0, it.g.count);
        }
        gl.readPixels(0, 0, gw * SS, gh * SS, gl.RGBA, gl.UNSIGNED_BYTE, px);
        const W2 = gw * SS;
        for (let gy = 0; gy < gh; gy++) for (let gx = 0; gx < gw; gx++) {
          let v = 0, cov = 0, id = 0, land = 0;
          for (let j = 0; j < SS; j++) for (let i = 0; i < SS; i++) {
            const o = (((gh - 1 - gy) * SS + j) * W2 + gx * SS + i) * 4;
            if (!px[o + 3]) continue;
            v += px[o];
            if (!cov) { id = px[o + 1]; land = px[o + 2] > 127 ? 1 : 0; } // parts don't blend: the nearest one wins
            cov++;
          }
          if (cov < SS * SS * 0.4) { lv[gy * gw + gx] = 0; pal[gy * gw + gx] = 0; st[gy * gw + gx] = 0; continue; }
          // A colour's own shading runs smoother than the LED dither: a lit ball, not static.
          const lum = v / (255 * cov) + (B4[(gy % 4) * 4 + (gx % 4)] / 16 - 0.5) * (id ? 0.10 : 0.24);
          lv[gy * gw + gx] = Math.max(1, Math.min(4, Math.floor(clamp01(lum) * 4.999)));
          pal[gy * gw + gx] = id;
          st[gy * gw + gx] = land;
        }
        // Labels follow their part's centre on screen.
        const labels = [];
        for (const [n, it] of items.entries()) {
          if (!it.label) continue;
          const q = apply(mul(vp, fit), now[n].at);
          if (q[3] <= 0) continue;
          labels.push({ x: ((q[0] / q[3]) * 0.5 + 0.5) * gw * 3, y: (1 - ((q[1] / q[3]) * 0.5 + 0.5)) * gh * 3, text: it.label });
        }
        out = { gw, gh, lv, pal, st, tints, labels };
        return out;
      },
    };
  }
  const clamp01 = (v) => Math.max(0, Math.min(1, v));
  R.ink3d = { create, SEA, LAND };
})();

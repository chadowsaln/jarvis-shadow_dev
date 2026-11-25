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
  const mul = (a, b, out = null) => {
    const o = out || new Float32Array(16);
    for (let c = 0; c < 4; c++) {
      const c4 = c * 4;
      for (let r = 0; r < 4; r++) {
        o[c4 + r] = a[r] * b[c4] + a[4 + r] * b[c4 + 1] + a[8 + r] * b[c4 + 2] + a[12 + r] * b[c4 + 3];
      }
    }
    return o;
  };
  const T = (x, y, z) => [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, x, y, z, 1];
  const S = (x, y, z) => [x, 0, 0, 0, 0, y, 0, 0, 0, 0, z, 0, 0, 0, 0, 1];
  const RX = (a) => { const c = Math.cos(a), s = Math.sin(a); return [1, 0, 0, 0, 0, c, s, 0, 0, -s, c, 0, 0, 0, 0, 1]; };
  const RY = (a) => { const c = Math.cos(a), s = Math.sin(a); return [c, 0, -s, 0, 0, 1, 0, 0, s, 0, c, 0, 0, 0, 0, 1]; };
  const RZ = (a) => { const c = Math.cos(a), s = Math.sin(a); return [c, s, 0, 0, -s, c, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1]; };
  const persp = (fov, asp, n, f) => { const t = 1 / Math.tan(fov / 2); return [t / asp, 0, 0, 0, 0, t, 0, 0, 0, 0, (f + n) / (n - f), -1, 0, 0, (2 * f * n) / (n - f), 0]; };
  const apply = (m, [x, y, z]) => [0, 1, 2, 3].map((r) => m[r] * x + m[4 + r] * y + m[8 + r] * z + m[12 + r]);

  const VS = `attribute vec3 p; attribute vec3 n; uniform mat4 mvp; uniform mat4 model; varying vec3 vn; varying vec3 vp; varying vec3 vo;
    void main(){ vec4 w = model * vec4(p, 1.0); vp = w.xyz; vn = (model * vec4(n, 0.0)).xyz; vo = n; gl_Position = mvp * vec4(p, 1.0); }`;
  const FS = `precision mediump float; varying vec3 vn; varying vec3 vp; varying vec3 vo; uniform float k; uniform vec3 eye; uniform float glass;
    uniform float id; uniform float planet; uniform sampler2D land; uniform vec3 uColor; uniform vec3 uLandColor; uniform vec3 uRimColor;
    void main(){
      vec3 N = normalize(vn); vec3 L = normalize(vec3(-0.45, 0.75, 0.65)); vec3 Vd = normalize(eye - vp);
      float lam = max(dot(N, L), 0.0); vec3 H = normalize(L + Vd);
      float spec = pow(max(dot(N, H), 0.0), 16.0);
      float rim = pow(1.0 - max(dot(N, Vd), 0.0), 2.4);
      vec3 rimCol = uRimColor;
      if (planet > 0.5) {
        vec3 o = normalize(vo);
        vec2 uv = vec2(atan(o.z, o.x) / 6.2831853 + 0.5, acos(clamp(o.y, -1.0, 1.0)) / 3.1415927);
        float land1 = step(0.48, texture2D(land, uv).r);
        vec3 seaCol = vec3(0.12, 0.38, 0.78);
        vec3 landCol = vec3(0.22, 0.60, 0.30);
        vec3 surface = mix(seaCol, landCol, land1);
        vec3 lit = surface * (0.24 + 0.82 * lam) + (1.0 - land1) * spec * 0.45 + rim * rimCol * 0.65;
        gl_FragColor = vec4(lit, 1.0);
      } else {
        vec3 base = (id > 0.0) ? uColor : uRimColor;
        vec3 lit = base * (0.25 + 0.80 * lam) + spec * 0.35 + rim * rimCol * 0.45;
        float alpha = glass > 0.5 ? 0.65 : 1.0;
        gl_FragColor = vec4(lit, alpha);
      }
    }`;

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

  const hexToRgb = (hexStr, def = [0.16, 0.77, 0.72]) => {
    if (!hexStr || typeof hexStr !== 'string' || hexStr[0] !== '#') return def;
    const hex = hexStr.slice(1);
    if (hex.length === 3) return [parseInt(hex[0] + hex[0], 16) / 255, parseInt(hex[1] + hex[1], 16) / 255, parseInt(hex[2] + hex[2], 16) / 255];
    return [parseInt(hex.slice(0, 2), 16) / 255, parseInt(hex.slice(2, 4), 16) / 255, parseInt(hex.slice(4, 6), 16) / 255];
  };

  /**
   * A model from parts [{shape, at, size, rot (degrees), tone, color, label, motion, planet, land}].
   * Returns a renderer with .frame(t) exposing .canvas for direct smooth drawing.
   */
  function create(parts, w, h) {
    const rw = Math.round(w * 1.5), rh = Math.round(h * 1.5);
    const cv = document.createElement('canvas'); cv.width = rw; cv.height = rh;
    const gl = cv.getContext('webgl', { antialias: true, preserveDrawingBuffer: true, alpha: true });
    if (!gl) return null;
    const sh = (type, src) => { const s = gl.createShader(type); gl.shaderSource(s, src); gl.compileShader(s); if (!gl.getShaderParameter(s, gl.COMPILE_STATUS)) throw new Error(gl.getShaderInfoLog(s)); return s; };
    const prog = gl.createProgram();
    try { gl.attachShader(prog, sh(gl.VERTEX_SHADER, VS)); gl.attachShader(prog, sh(gl.FRAGMENT_SHADER, FS)); gl.linkProgram(prog); } catch (e) { console.error('ink3d', e); return null; }
    if (!gl.getProgramParameter(prog, gl.LINK_STATUS)) return null;
    gl.useProgram(prog);
    const at = {
      p: gl.getAttribLocation(prog, 'p'), n: gl.getAttribLocation(prog, 'n'),
      mvp: gl.getUniformLocation(prog, 'mvp'), model: gl.getUniformLocation(prog, 'model'),
      k: gl.getUniformLocation(prog, 'k'), eye: gl.getUniformLocation(prog, 'eye'),
      glass: gl.getUniformLocation(prog, 'glass'), id: gl.getUniformLocation(prog, 'id'),
      planet: gl.getUniformLocation(prog, 'planet'), land: gl.getUniformLocation(prog, 'land'),
      uColor: gl.getUniformLocation(prog, 'uColor'), uLandColor: gl.getUniformLocation(prog, 'uLandColor'),
      uRimColor: gl.getUniformLocation(prog, 'uRimColor')
    };
    const cache = {};
    const buf = (data) => { const b = gl.createBuffer(); gl.bindBuffer(gl.ARRAY_BUFFER, b); gl.bufferData(gl.ARRAY_BUFFER, new Float32Array(data), gl.STATIC_DRAW); return b; };
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
      return {
        g, turn: mul(RZ(rz), mul(RY(ry), RX(rx))), size: [sx, sy, sz], motion: q.motion, planet,
        pal: planet || q.color ? tintOf(q.color || SEA, planet ? q.land || LAND : null) : 0,
        colorRgb: hexToRgb(q.color || (planet ? SEA : '#28c4b8'), [0.16, 0.77, 0.72]),
        landRgb: hexToRgb(q.land || LAND, [0.22, 0.60, 0.30]),
        k: q.color || planet ? 1 : TONE_K[q.tone] ?? 1, label: q.label, at: [x, y, z], r: Math.max(sx, sy, sz) * (q.motion?.do === 'pulse' ? 1.14 : 1)
      };
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
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.REPEAT);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
      return t;
    })();
    // Fit the whole model in view, wherever its parts move to: centre it and scale its bounding sphere to about one unit.
    const reach = items.map((it) => (it.motion ? Array.from({ length: 8 }, (_, k) => moved(it, (k / 8) * Math.max(0.3, Math.min(60, it.motion.secs ?? CYCLE[it.motion.do]))).at) : [it.at]));
    const within = (it, q) => { const d = q.map((v, i) => v - it.at[i]), m = it.turn; return [0, 4, 8].every((c, i) => Math.abs((m[c] * d[0] + m[c + 1] * d[1] + m[c + 2] * d[2]) / (it.size[i] || 1e-6)) < 0.5); };
    for (const it of items) it.glass = !it.motion && items.some((o, n) => o !== it && o.r < it.r && reach[n].every((q) => within(it, q)));
    const c = reach.reduce((a, qs) => a.map((v, i) => v + qs.reduce((s2, q) => s2 + q[i], 0) / qs.length / items.length), [0, 0, 0]);
    const rad = Math.max(0.3, ...items.flatMap((it, n) => reach[n].map((q) => Math.hypot(...q.map((v, i) => v - c[i])) + it.r * 0.6)));
    const fit = mul(S(1 / rad, 1 / rad, 1 / rad), T(-c[0], -c[1], -c[2]));
    const gw = Math.max(8, Math.floor(w / 3)), gh = Math.max(8, Math.floor(h / 3));
    const lv = new Uint8Array(gw * gh), pal = new Uint8Array(gw * gh), st = new Uint8Array(gw * gh);
    let lastT = -1, out = { gw, gh, lv, pal, st, tints, labels: [], canvas: cv };
    const scratchModel = new Float32Array(16);
    const scratchMvp = new Float32Array(16);
    const scratchTemp = new Float32Array(16);
    let cachedRimHex = null;
    let cachedRimRgb = new Float32Array([120 / 255, 255 / 255, 226 / 255]);

    gl.enable(gl.DEPTH_TEST);
    return {
      frame(t) {
        if (lastT >= 0 && Math.abs(t - lastT) < 1 / 30) return out;
        lastT = t;
        const view = mul(T(0, 0, -3.4), mul(RX(0.38), RY(t * 0.45 + 0.6))), proj = persp(0.62, w / h, 0.1, 20), vp = mul(proj, view);
        gl.viewport(0, 0, rw, rh);
        gl.clearColor(0, 0, 0, 0); gl.clear(gl.COLOR_BUFFER_BIT | gl.DEPTH_BUFFER_BIT);
        gl.uniform3fv(at.eye, [0, 0, 3.4]);
        const curAcc = R.theme?.palette?.ACC || '#78ffe2';
        if (curAcc !== cachedRimHex) {
          cachedRimHex = curAcc;
          const rgb = (R.theme?.toRgb?.(curAcc) || [120, 255, 226]).map((x) => x / 255);
          cachedRimRgb = new Float32Array(rgb);
        }
        gl.uniform3fv(at.uRimColor, cachedRimRgb);
        gl.activeTexture(gl.TEXTURE0);
        gl.uniform1i(at.land, 0);
        if (landTex) gl.bindTexture(gl.TEXTURE_2D, landTex);
        const now = items.map((it) => moved(it, t));
        for (const [n, it] of items.entries()) {
          mul(fit, now[n].local, scratchTemp);
          mul(view, scratchTemp, scratchModel);
          mul(proj, scratchModel, scratchMvp);
          gl.uniformMatrix4fv(at.model, false, scratchModel);
          gl.uniformMatrix4fv(at.mvp, false, scratchMvp);
          gl.uniform1f(at.k, it.k); gl.uniform1f(at.glass, it.glass ? 1 : 0);
          gl.uniform1f(at.id, it.pal); gl.uniform1f(at.planet, it.planet && landTex ? 1 : 0);
          gl.uniform3fv(at.uColor, it.colorRgb);
          gl.uniform3fv(at.uLandColor, it.landRgb);
          gl.bindBuffer(gl.ARRAY_BUFFER, it.g.p); gl.enableVertexAttribArray(at.p); gl.vertexAttribPointer(at.p, 3, gl.FLOAT, false, 0, 0);
          gl.bindBuffer(gl.ARRAY_BUFFER, it.g.n); gl.enableVertexAttribArray(at.n); gl.vertexAttribPointer(at.n, 3, gl.FLOAT, false, 0, 0);
          gl.drawArrays(gl.TRIANGLES, 0, it.g.count);
        }
        // Labels follow their part's centre on screen.
        const labels = [];
        for (const [n, it] of items.entries()) {
          if (!it.label) continue;
          const q = apply(mul(vp, fit), now[n].at);
          if (q[3] <= 0) continue;
          labels.push({ x: ((q[0] / q[3]) * 0.5 + 0.5) * w, y: (1 - ((q[1] / q[3]) * 0.5 + 0.5)) * h, text: it.label });
        }
        out = { gw, gh, lv, pal, st, tints, labels, canvas: cv };
        return out;
      },
    };
  }
  const clamp01 = (v) => Math.max(0, Math.min(1, v));
  R.ink3d = { create, SEA, LAND };
})();

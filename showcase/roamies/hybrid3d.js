// The hybrid entity's renderer: WebGL 2, no libraries. One structure, built from the six references, and six styles
// that each lean on a different part of it (theme.current.style picks one; see LOOKS below):
//   OrbCore        a plasma sphere with a hot nucleus, thin energy veins and concentric shells; energy waves run
//                  out of its middle, and loudness (the voice or the microphone) drives their strength
//   Orbits         five woven Lissajous loops, each on its own axis at its own speed, with a bright node running
//                  along it: the crossing hand-drawn curves of the references, not clean mechanical rings
//   Bezel          the engraved instrument ring: three segmented concentric arcs and a fine tick scale, turning
//                  in opposite directions, with a faint radial filament burst inside it
//   Satellites     small elliptical orbits scattered through the volume, like the hand-drawn ellipses
//   Rings          five inclined structural rings of glowing beads, at different angles, radii and directions
//   NeuralField    a drifting shell of points with short links between neighbours, twinkling as they move
//   Pulses         rings of light emitted from the middle, rhythmic with the voice when it speaks
// Nothing here knows a color: every color, glow, opacity and count comes from Roamie.theme, so a theme change shows
// on the next frame and no preset is baked in. Nothing here knows what the app is doing either: it is handed a
// state name and a level.
//
// Cheap on purpose (an integrated GPU is the target): one full-screen quad for the sphere, one for the field,
// ~2000 line vertices and up to 600 points per frame, no depth buffer, no render targets, additive blending.
// Geometry is rebuilt into preallocated arrays each frame (no allocation in the loop). Quality steps down on its
// own when frames run long; a lost context is rebuilt, and if it can't be, `ok` goes false so the caller draws its
// 2D fallback.
// Classic script: window.Roamie.hybrid3d.
(() => {
  const R = (window.Roamie = window.Roamie || {});
  const clamp = (v, a, b) => (v < a ? a : v > b ? b : v);
  const TAU = Math.PI * 2;

  // The canvas holds 1.45 × the orb's radius each way (the bezel reaches 1.44), so clip space is squeezed by that:
  // without it the sphere would fill the whole canvas and the orbits would fall outside it.
  const FIT = (1 / 1.45).toFixed(8);
  const VS_QUAD = `#version 300 es
in vec2 a_p;
out vec2 v_p;
void main() { v_p = a_p; gl_Position = vec4(a_p * ${FIT}, 0.0, 1.0); }`;

  // The core: a sphere seen head on, with plasma, veins, shells and a hot nucleus. p is the point on its disc
  // (-1..1, y up); z is the depth of that point on the sphere.
  const FS_ORB = `#version 300 es
precision mediump float;
in vec2 v_p;
out vec4 o;
uniform float u_time;
uniform float u_level;    // 0..1: the voice or the microphone
uniform float u_state;    // 0 idle, 1 listening, 2 thinking, 3 tool, 4 speaking, 5 success, 6 error, 7 offline, 8 sleeping
uniform vec3 u_core;
uniform vec3 u_reactor;
uniform vec3 u_neural;
uniform vec3 u_glow;
uniform float u_intensity;
uniform float u_transparency;
// How much of each motif this style shows (the six styles share this shader, not one copy each).
uniform float u_body;
uniform float u_rim;
uniform float u_nucleus;
uniform float u_vein;
uniform float u_shell;
uniform float u_wave;
uniform float u_ntight;   // how sharp the hot centre is (a tight point, or a soft ball)

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
  // Each state changes the speed of the plasma, not just its brightness.
  float busy = (u_state > 1.5 && u_state < 2.5) ? 2.0 : (u_state > 2.5 && u_state < 3.5) ? 1.45 : (u_state > 7.5) ? 0.25 : 1.0;
  float calm = 1.0;
  if (u_state > 4.5 && u_state < 5.5) calm = 1.16;             // success: a short bloom
  else if (u_state > 5.5 && u_state < 6.5) calm = 0.8;        // error: dimmer, but visibly wrong
  else if (u_state > 6.5 && u_state < 7.5) calm = 0.42;       // offline: a dim shell
  else if (u_state > 7.5) calm = 0.16;                        // sleeping: almost out

  vec3 p = vec3(v_p, z);
  float plasma = fbm(p * 2.6 + vec3(0.0, 0.0, u_time * 0.55 * busy));
  plasma = smoothstep(0.16, 0.95, plasma + u_level * 0.35 + (u_state > 3.5 && u_state < 4.5 ? 0.14 : 0.0));

  // Energy veins: thin bright filaments over the surface, drifting at their own rate.
  float vein = 1.0 - abs(noise(p * 6.5 + vec3(u_time * 0.18, 0.0, u_time * 0.26)) - 0.5) * 2.0;
  vein = pow(max(vein, 0.0), 12.0);

  // Concentric shells: fine latitude rings that slide outwards, deeper than the surface.
  float shell = pow(0.5 + 0.5 * sin(z * 26.0 - u_time * (2.0 + u_level * 4.0)), 18.0);

  // Energy waves: bright bands travelling out from the middle. Listening pulls them inwards instead.
  float dir = (u_state > 0.5 && u_state < 1.5) ? -1.0 : 1.0;
  float wave = 0.5 + 0.5 * sin(d2 * 16.0 - dir * u_time * (2.2 + u_level * 5.0));

  float rim = pow(1.0 - z, 2.2);
  // A small, hot centre: sharp enough that the core stays a point of light with structure around it, not a white
  // disc. It swells with the voice.
  float nucleus = exp(-d2 * u_ntight) * (0.85 + u_level * 1.2);
  vec3 col = u_core * (0.07 + plasma * 0.50) * u_body
           + u_core * nucleus * 2.2 * u_nucleus
           + u_reactor * vein * 0.38 * u_vein
           + u_glow * shell * 0.26 * u_shell
           + u_glow * wave * (0.05 + u_level * 0.18) * u_wave
           + u_reactor * rim * 0.50 * u_rim
           + u_neural * plasma * rim * 0.28 * u_body;
  col *= calm;
  // A controlled warning: a hard flicker over the body, never a strobe.
  if (u_state > 5.5 && u_state < 6.5) {
    float warn = 0.72 + 0.28 * sin(u_time * 17.0 + d2 * 5.0);
    col *= warn;
  }
  // The disc's own light fades out before its edge, so a style with a dim body has no hard circle drawn round it;
  // the edge is the rim term's job (and a style can turn that off).
  float bodyA = (0.12 * u_body + plasma * 0.12 * u_body + nucleus * 0.60 * u_nucleus) * smoothstep(1.0, 0.93, d2);
  float a = (bodyA + rim * 0.40 * u_rim) * (1.0 - clamp(u_transparency, 0.0, 0.9));
  if (u_state > 6.5) a *= 0.45;
  o = vec4(col * u_intensity, clamp(a, 0.0, 1.0) * (u_state > 6.5 ? 0.8 : 1.0));
}`;

  // The outer energy field: the engraved bezel, the radial filament burst and the pulses. Drawn over the space
  // between the sphere's edge and the canvas, so the entity has an outer structure instead of a bare disc.
  // The field reaches the canvas edge (1.45 × the orb's radius): its quad covers the whole frame, and the point it
  // hands the shader is in orb radii, so the bezel's radii are the same numbers as the sphere's.
  const VS_FIELD = `#version 300 es
in vec2 a_p;
out vec2 v_p;
void main() { v_p = a_p * 1.45; gl_Position = vec4(a_p, 0.0, 1.0); }`;
  const FS_FIELD = `#version 300 es
precision mediump float;
in vec2 v_p;
out vec4 o;
uniform float u_time;
uniform float u_level;
uniform float u_state;
uniform float u_pulse;    // 0..1: how far the current pulse has travelled out
uniform float u_intensity;
uniform vec3 u_reactor;
uniform vec3 u_glow;
uniform vec3 u_neural;
uniform float u_band;      // how much of the engraved bezel this style shows
uniform float u_bandw;     // how thick its arcs are
uniform float u_break;     // how much of the bezel is missing: a rim with a gap cut out of it
uniform float u_tick;
uniform float u_spoke;
uniform float u_pulseg;

void main() {
  float d = length(v_p);
  if (d > 1.45 || d < 0.995) discard;
  float ang = atan(v_p.y, v_p.x);
  float fade = smoothstep(1.45, 1.34, d);

  // Three segmented concentric arcs at their own radii, each turning its own way (the engraved bezel).
  float band = 0.0;
  for (int i = 0; i < 3; i++) {
    float fi = float(i);
    float r = 1.045 + fi * 0.105;
    float w = (0.0052 + fi * 0.0016) * u_bandw;
    float ring = smoothstep(w * 2.2, 0.0, abs(d - r));
    float dir = mod(fi, 2.0) < 0.5 ? 1.0 : -1.0;
    float seg = sin(ang * (3.0 + fi * 2.0) + u_time * (0.42 + fi * 0.28) * dir + fi * 1.7);
    band += ring * (0.22 + 0.78 * smoothstep(0.1, 0.85, seg));
  }

  // The tick scale on the outermost bezel: fine, regular marks with a sector that's left dark.
  float sector = smoothstep(-0.45, 0.55, sin(ang * 2.0 + u_time * 0.12));
  float tick = pow(max(0.0, sin(ang * 120.0)), 26.0) * smoothstep(0.035, 0.0, abs(d - 1.365)) * (0.25 + 0.75 * sector);

  // The radial filaments: a faint burst of rays running from the sphere's edge to the bezel.
  float spokes = pow(max(0.0, sin(ang * 27.0 + sin(u_time * 0.21) * 0.9)), 16.0)
               * smoothstep(1.33, 1.02, d) * smoothstep(0.99, 1.05, d);

  // The pulse: a ring of light leaving the middle, brightest just after it starts.
  float pr = 1.0 + u_pulse * 0.40;
  float pulse = smoothstep(0.020, 0.0, abs(d - pr)) * (1.0 - u_pulse);

  // A style can cut a sector out of the bezel (the reference's cast rims are not complete circles).
  float gapW = smoothstep(0.30, 0.95, cos(ang - u_time * 0.07));
  band *= u_band * (1.0 - gapW * u_break);
  tick *= u_tick; spokes *= u_spoke; pulse *= u_pulseg;
  float alpha = band * 0.66 + tick * 0.55 + spokes * (0.26 + u_level * 0.30) + pulse * 0.85;
  vec3 col = u_reactor * band + u_neural * (tick * 0.85 + spokes * 0.6) + u_glow * pulse * 1.6;

  // A controlled warning state: the bezel flickers hard, still in the theme's own colors.
  if (u_state > 5.5 && u_state < 6.5) { float w = 0.55 + 0.45 * sin(u_time * 21.0); alpha *= w; col *= w; }
  // Sleeping: almost no light, and only the bezel's dimmest parts.
  if (u_state > 7.5) alpha *= 0.22;
  // Offline: no pulses go out.
  if (u_state > 6.5 && u_state < 7.5) alpha *= 0.55;

  o = vec4(col * u_intensity, clamp(alpha * fade, 0.0, 1.0));
}`;

  const VS_LINE = `#version 300 es
in vec3 a_p;
in float a_a;
out float v_a;
uniform float u_fit;
void main() { v_a = a_a; gl_Position = vec4(a_p.xy * u_fit, 0.0, 1.0); }`;
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
uniform float u_fit;
void main() { v_a = a_a; gl_Position = vec4(a_p.xy * u_fit, 0.0, 1.0); gl_PointSize = max(1.0, a_s * u_scale); }`;
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

  // How fast each part of the machine runs, by state: sleeping is a crawl, thinking races.
  const PACE = { idle: 1, listening: 1.15, thinking: 1.9, tool_execution: 1.4, speaking: 1.18, success: 1, error: 0.55, offline: 0.45, sleeping: 0.16 };
  const STATES = { idle: 0, listening: 1, thinking: 2, tool_execution: 3, speaking: 4, success: 5, error: 6, offline: 7, sleeping: 8 };

  // ---- the six styles ----
  // One shader pair and one geometry budget serve all of them; a style is a table of how much of each motif it shows,
  // so switching is a settings change, not another renderer. The palettes live in theme.js (STYLES).
  //   orbits  woven Lissajous loops (count, size, how far from a circle: 1 = as authored, 0 = a ring)
  //   thick   extra passes of the same loop, scaled a hair: a drawn line several pixels wide
  //   sat     the scattered mini-ellipses (count, how far out, how big)
  //   fil     the radial burst (rays, where they start and end, how ragged, gain, how many fans, dashed)
  //   rings   structural bead rings (count, size, bead and node size, how many breaks, how wide a break)
  //   tick    the bezel's tick scale; poly the inner wire solids; particles the point shell
  const LOOKS = {
    hybrid: {
      orbits: 5, orbitR: 1, smooth: 1, thick: 1, line: 1, sat: 12, satR: 1, satSize: 1, tone: -1,
      fil: { n: 140, r0: 0.30, r1: 1.10, spread: 0.14, var: 1, gain: 1, cluster: 0, dashes: 1, gap: 0, alpha: 1, passes: 1, tone: 1 },
      rings: { n: 5, r: 1, bead: 1, node: 1, breakN: 24, gap: 0.2, gain: 1 },
      tick: 1, poly: 1, particles: 1,
      orb: { body: 1, rim: 1, nucleus: 1, vein: 1, shell: 1, wave: 1, n: 26 },
      field: { band: 1, bandw: 1, break: 0, tick: 1, spoke: 1, pulse: 1 },
    },
    // The engraved instrument: a heavy segmented bezel under a dense hatch scale, with dendrites reaching into it.
    ring: {
      orbits: 0, orbitR: 1, smooth: 1, thick: 1, line: 0.8, sat: 6, satR: 0.95, satSize: 2.2, tone: 0,
      fil: { n: 220, r0: 0.34, r1: 1.08, spread: 0.95, var: 2.6, gain: 1.7, cluster: 0, dashes: 3, gap: 0.26, alpha: 4.6, passes: 1, tone: 0 },
      rings: { n: 1, r: 0.70, bead: 2.6, node: 0, breakN: 2, gap: 0.55, gain: 0.22 },
      tick: 2.0, poly: 0, particles: 0.18,
      orb: { body: 0.14, rim: 0.10, nucleus: 0.32, vein: 0.45, shell: 0.16, wave: 0.18, n: 62 },
      field: { band: 2.2, bandw: 2.6, break: 0.55, tick: 1.8, spoke: 1.25, pulse: 0.22 },
    },
    // Hand-drawn chaos: many thin loops crossing every which way, ellipse doodles drifting through them, and a hollow
    // middle — the loops are the picture, so the core is almost all substrate.
    weave: {
      orbits: 5, orbitR: 1.42, smooth: 0.88, thick: 3, line: 0.95, sat: 12, satR: 1.18, satSize: 2.6, tone: -1,
      fil: { n: 40, r0: 0.55, r1: 1.18, spread: 1.4, var: 3, gain: 0.4, cluster: 0, dashes: 1, gap: 0, alpha: 2.0, passes: 1, tone: 1 },
      rings: { n: 0, r: 1, bead: 1, node: 1, breakN: 24, gap: 0.2, gain: 1 },
      tick: 0, poly: 0.12, particles: 0.5,
      orb: { body: 0.03, rim: 0.03, nucleus: 0.04, vein: 0.02, shell: 0.03, wave: 0.04, n: 12 },
      field: { band: 0, bandw: 1, break: 0, tick: 0, spoke: 0, pulse: 0.22 },
    },
    // Smooth colliding rings: five large, nearly circular loops in their own planes, over a hot bright core.
    torus: {
      orbits: 3, orbitR: 1.16, smooth: 0.22, thick: 4, line: 2.6, sat: 2, satR: 0.55, satSize: 1.1, tone: -1,
      fil: { n: 30, r0: 0.4, r1: 1.2, spread: 1.2, var: 3, gain: 0.5, cluster: 0, dashes: 1, gap: 0, alpha: 2.0, passes: 1, tone: 1 },
      rings: { n: 2, r: 1.02, bead: 1.7, node: 0.6, breakN: 1, gap: 0, gain: 0.4 },
      tick: 0, poly: 0.1, particles: 0.14,
      orb: { body: 0.22, rim: 0.14, nucleus: 0.55, vein: 0.12, shell: 0.18, wave: 0.28, n: 44 },
      field: { band: 0.06, bandw: 1, break: 0, tick: 0.05, spoke: 0, pulse: 0.38 },
    },
    // A detonation: hundreds of short dotted streaks streaming out of a tight core, with two thin ellipses through it.
    burst: {
      orbits: 2, orbitR: 1.05, smooth: 0.55, thick: 1, line: 0.85, tone: 2, sat: 4, satR: 0.45, satSize: 0.9,
      fil: { n: 220, r0: 0.18, r1: 1.42, spread: 0.03, var: 3.6, gain: 1.7, cluster: 0, dashes: 3, gap: 0.50, alpha: 6.5, passes: 2, tone: 0 },
      rings: { n: 1, r: 0.52, bead: 1.3, node: 0.5, breakN: 3, gap: 0.35, gain: 0.3 },
      tick: 0, poly: 0, particles: 0.25,
      orb: { body: 0.05, rim: 0.03, nucleus: 1.10, vein: 0.10, shell: 0.05, wave: 0.12, n: 92 },
      field: { band: 0, bandw: 1, break: 0, tick: 0, spoke: 0, pulse: 0.35 },
    },
    // Narrow fan clusters of parallel spines, their far ends strung with bead loops, round a small dense nucleus.
    spokes: {
      orbits: 0, orbitR: 1.35, smooth: 0.75, thick: 1, line: 1.0, sat: 12, satR: 1.15, satSize: 3.6, tone: 2,
      fil: { n: 220, r0: 0.30, r1: 1.30, spread: 1.05, var: 2.0, gain: 2.0, cluster: 5, dashes: 3, gap: 0.28, alpha: 6.5, passes: 3, tone: 0 },
      rings: { n: 1, r: 0.72, bead: 2.0, node: 0, breakN: 5, gap: 0.4, gain: 0.55 },
      tick: 0.1, poly: 0, particles: 0.15,
      orb: { body: 0.06, rim: 0.05, nucleus: 0.22, vein: 0.08, shell: 0.05, wave: 0.10, n: 34 },
      field: { band: 0.10, bandw: 1, break: 0, tick: 0.12, spoke: 0.25, pulse: 0.26 },
    },
    // Broken orbital tracks under a hard segmented bezel: long dendrites out to the rim, dotted rings inside them.
    arcs: {
      orbits: 2, orbitR: 0.70, smooth: 0.3, thick: 1, line: 0.45, sat: 9, satR: 0.60, satSize: 1.5, tone: -1,
      fil: { n: 220, r0: 0.14, r1: 1.24, spread: 1.2, var: 3, gain: 1.6, cluster: 0, dashes: 2, gap: 0.14, alpha: 3.6, passes: 2, tone: 0 },
      rings: { n: 1, r: 0.88, bead: 1.7, node: 0.4, breakN: 5, gap: 0.42, gain: 0.45 },
      tick: 0.55, poly: 0, particles: 0.3,
      orb: { body: 0.04, rim: 0.04, nucleus: 0.38, vein: 0.05, shell: 0.05, wave: 0.10, n: 78 },
      field: { band: 1.15, bandw: 1.55, break: 0.85, tick: 0.5, spoke: 0.7, pulse: 0.3 },
    },
  };
  const lookOf = (style) => LOOKS[style] ?? LOOKS.hybrid;
  // Eases the numbers of one look toward another (the tables are never written to), so switching structure while the
  // orb works is a morph instead of a cut.
  function mixLook(a, b, k) {
    for (const key in b) {
      const bv = b[key], av = a[key];
      // All the way: assign, don't interpolate — `av + (bv - av) * 1` is not bv in floating point.
      if (typeof bv === 'number') a[key] = k >= 1 ? bv : typeof av === 'number' ? av + (bv - av) * k : bv;
      else if (bv && typeof bv === 'object') mixLook(a[key] && typeof a[key] === 'object' ? a[key] : (a[key] = {}), bv, k);
    }
    return a;
  }

  // ---- the geometry ----
  // Five woven loops: (a, b) set the weave, R the size, sp its own turn, tilt its plane, ph where it starts.
  const CURVES = [
    { a: 3, b: 2, R: 0.94, sp: 0.30, ph: 0.0, tilt: 0.34, tone: 0 },
    { a: 5, b: 3, R: 0.82, sp: -0.22, ph: 1.7, tilt: -0.52, tone: 1 },
    { a: 4, b: 3, R: 1.03, sp: 0.17, ph: 3.1, tilt: 0.92, tone: 2 },
    { a: 7, b: 4, R: 0.70, sp: -0.34, ph: 4.4, tilt: -0.88, tone: 0 },
    { a: 2, b: 3, R: 0.58, sp: 0.44, ph: 2.2, tilt: 0.55, tone: 1 },
  ];
  // Point counts are set for the largest size the entity is drawn at (dpr included), so a curve reads as a line
  // and not a row of dots: one point every couple of pixels around the loop.
  const CURVE_N = 340;
  const RINGS = 5;
  const RING_SEG = 200;
  const SEG = 200;          // beads per structural ring
  const MAXP = 600;
  const SATS = 12;          // scattered mini-ellipses
  const SAT_SEG = 16;
  const FIL = 220;          // radial filaments (the busiest style draws all of them)
  const TICKS = 220;        // the bezel's tick scale
  const RING_CFG = [
    { sp: 0.70, tx: 0.35, ty: 0.20, r: 0.96 },
    { sp: -1.10, tx: 1.15, ty: -0.60, r: 1.06 },
    { sp: 0.45, tx: -0.55, ty: 1.00, r: 1.15 },
    { sp: -0.30, tx: 0.95, ty: 0.55, r: 1.24 },
    { sp: 0.20, tx: -1.25, ty: -0.35, r: 1.32 },
  ];

  const hash1 = (i, k) => {
    const x = Math.sin(i * 12.9898 + k * 78.233) * 43758.5453;
    return x - Math.floor(x);
  };

  // Icosahedron and octahedron, for the inner geometry: vertices and their edges, built once.
  const ICO_T = (1 + Math.sqrt(5)) / 2;
  const ICO_V = [
    [-1, ICO_T, 0], [1, ICO_T, 0], [-1, -ICO_T, 0], [1, -ICO_T, 0],
    [0, -1, ICO_T], [0, 1, ICO_T], [0, -1, -ICO_T], [0, 1, -ICO_T],
    [ICO_T, 0, -1], [ICO_T, 0, 1], [-ICO_T, 0, -1], [-ICO_T, 0, 1],
  ];
  const ICO_E = [
    [0, 11], [0, 5], [0, 1], [0, 7], [0, 10], [1, 5], [1, 7], [1, 3], [1, 9], [3, 7],
    [3, 9], [3, 11], [3, 10], [2, 10], [2, 11], [2, 4], [2, 6], [4, 11], [4, 5], [4, 9],
    [5, 9], [6, 7], [6, 8], [6, 10], [7, 8], [8, 9], [8, 10], [2, 8], [0, 2], [1, 2],
  ];
  const OCT_V = [[1, 0, 0], [-1, 0, 0], [0, 1, 0], [0, -1, 0], [0, 0, 1], [0, 0, -1]];
  const OCT_E = [[0, 2], [0, 3], [0, 4], [0, 5], [1, 2], [1, 3], [1, 4], [1, 5], [2, 4], [2, 5], [3, 4], [3, 5]];

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
      stats: { frames: 0, ms: 0, quality: 'high', points: 0, rings: RINGS, orbits: CURVES.length, style: 'hybrid' },
      dispose, resize, render, setQuality, snapshot,
    };
    let gl = null, canvas = null, progs = null, bufs = null, quad = null;
    let w = 1, h = 1, dpr = 1, lostAt = 0, lost = false;
    let quality = 'high', frames = 0, slow = 0, fast = 0, ema = 16, lastDraw = 0, drewAny = 0;
    let anim = 0, pulse = 0; // the machine's own clock (state-paced) and the pulse's progress
    // The structure on screen, eased toward the one the state wants: a state change is a short morph, never a cut.
    const shown = JSON.parse(JSON.stringify(LOOKS.hybrid));
    let target = LOOKS.hybrid, targetId = 'hybrid', started = false;

    // Preallocated geometry: every array is written in place each frame, never rebuilt.
    const curveP = new Float32Array(CURVES.length * CURVE_N * 3);
    const curveA = new Float32Array(CURVES.length * CURVE_N);
    const ringPts = new Float32Array(RINGS * RING_SEG * 3);
    const ringA = new Float32Array(RINGS * RING_SEG);
    const ringS = new Float32Array(RINGS * RING_SEG);
    const nodeP = new Float32Array(RINGS * 2 * 3), nodeA = new Float32Array(RINGS * 2), nodeS = new Float32Array(RINGS * 2);
    const satP = new Float32Array(SATS * SAT_SEG * 2 * 3), satA = new Float32Array(SATS * SAT_SEG * 2);
    const filP = new Float32Array(FIL * 8 * 3), filA = new Float32Array(FIL * 8);
    const tickP = new Float32Array(TICKS * 2 * 3), tickA = new Float32Array(TICKS * 2);
    const geoP = new Float32Array((ICO_E.length + OCT_E.length) * 2 * 3);
    const geoA = new Float32Array((ICO_E.length + OCT_E.length) * 2);
    const neuP = new Float32Array(MAXP * 3), neuA = new Float32Array(MAXP), neuS = new Float32Array(MAXP);
    const base = new Float32Array(MAXP * 4);                  // per point: dir.xyz + drift phase
    let pairs = new Int32Array(0), pairA = new Float32Array(0), pairV = new Float32Array(0);
    let built = 0;                                            // how many points the buffers hold

    // No page, no canvas: the caller keeps its 2D look (this is also how the tests run the module).
    if (typeof document === 'undefined' || typeof document.createElement !== 'function') {
      api.failed = true; api.error = 'no document';
      return api;
    }
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
          field: program(gl, VS_FIELD, FS_FIELD),
          line: program(gl, VS_LINE, FS_LINE),
          dot: program(gl, VS_DOT, FS_DOT),
        };
      } catch (e) { fail(String(e?.message ?? e)); return false }
      progs.orbU = locs(gl, progs.orb, ['u_time', 'u_level', 'u_state', 'u_core', 'u_reactor', 'u_neural', 'u_glow', 'u_intensity', 'u_transparency', 'u_body', 'u_rim', 'u_nucleus', 'u_vein', 'u_shell', 'u_wave', 'u_ntight']);
      progs.fieldU = locs(gl, progs.field, ['u_time', 'u_level', 'u_state', 'u_pulse', 'u_intensity', 'u_reactor', 'u_glow', 'u_neural', 'u_band', 'u_bandw', 'u_break', 'u_tick', 'u_spoke', 'u_pulseg']);
      progs.lineU = locs(gl, progs.line, ['u_color', 'u_fade', 'u_fit']);
      progs.dotU = locs(gl, progs.dot, ['u_color', 'u_scale', 'u_fit']);
      progs.orbA = gl.getAttribLocation(progs.orb, 'a_p');
      progs.fieldA = gl.getAttribLocation(progs.field, 'a_p');
      progs.lineA = { p: gl.getAttribLocation(progs.line, 'a_p'), a: gl.getAttribLocation(progs.line, 'a_a') };
      progs.dotA = { p: gl.getAttribLocation(progs.dot, 'a_p'), a: gl.getAttribLocation(progs.dot, 'a_a'), s: gl.getAttribLocation(progs.dot, 'a_s') };
      quad = gl.createBuffer();
      gl.bindBuffer(gl.ARRAY_BUFFER, quad);
      // Two triangles: the disc and the field are both full-screen passes.
      gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 1, -1, -1, 1, -1, 1, 1, -1, 1, 1]), gl.STATIC_DRAW);
      bufs = {
        curveP: gl.createBuffer(), curveA: gl.createBuffer(),
        ringP: gl.createBuffer(), ringA: gl.createBuffer(), ringS: gl.createBuffer(),
        nodeP: gl.createBuffer(), nodeA: gl.createBuffer(), nodeS: gl.createBuffer(),
        satP: gl.createBuffer(), satA: gl.createBuffer(),
        filP: gl.createBuffer(), filA: gl.createBuffer(),
        tickP: gl.createBuffer(), tickA: gl.createBuffer(),
        geoP: gl.createBuffer(), geoA: gl.createBuffer(),
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
      for (let i = 0; i < count; i++) {
        const y = 1 - (2 * (i + 0.5)) / count, r = Math.sqrt(Math.max(0, 1 - y * y)), a = i * 2.39996;
        const shell = 0.86 + hash1(i, 1) * 0.28;
        base[i * 4] = Math.cos(a) * r * shell;
        base[i * 4 + 1] = y * shell;
        base[i * 4 + 2] = Math.sin(a) * r * shell;
        base[i * 4 + 3] = hash1(i, 2) * TAU;
      }
      pairs = new Int32Array(count * 3);
      pairV = new Float32Array(count * 3 * 2 * 3);
      pairA = new Float32Array(count * 3 * 2);
      for (let i = 0; i < count; i++) {
        const a = base[i * 4], b = base[i * 4 + 1], c = base[i * 4 + 2];
        const best = [-1, -1, -1], bd = [4, 4, 4];
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

    // One structural ring's point: a circle in its own plane, tilted about two axes, so it stands at its own angle.
    function ringPoint(cfg, ang, lvl, i, out) {
      const tx = cfg.tx + Math.sin(anim * 0.21 + i) * 0.12, ty = cfg.ty + Math.cos(anim * 0.17 + i) * 0.1;
      const cA = Math.cos(tx), sA = Math.sin(tx), cB = Math.cos(ty), sB = Math.sin(ty);
      const rr = cfg.r * (1 + lvl * 0.02 * (i + 1));
      const x0 = Math.cos(ang) * rr, y0 = Math.sin(ang) * rr, z0 = 0;
      const y1 = y0 * cA - z0 * sA, z1 = y0 * sA + z0 * cA;
      out[0] = x0 * cB + z1 * sB;
      out[1] = y1;
      out[2] = -x0 * sB + z1 * cB;
      return out;
    }
    const tmp = [0, 0, 0];

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

      const st = typeof state === 'number' ? state : (STATES[state] ?? 0);
      const name = typeof state === 'string' ? state : Object.keys(STATES).find((k) => STATES[k] === st) ?? 'idle';
      const pace = PACE[name] ?? 1;
      const secs = Math.min(0.25, Math.max(0, (now - (render.last || now)) / 1000)) || 1 / 60;
      render.last = now;
      anim += secs * pace;
      const lvl = th.audioReactive === false ? 0 : clamp(level, 0, 1);
      const speaking = st === 4;
      // Pulses: rhythmic with the voice while it speaks, occasional otherwise, almost never asleep.
      pulse += secs * (speaking ? 0.85 + lvl * 2.4 : st === 8 ? 0.10 : st === 6 ? 0 : 0.40);
      if (pulse >= 1) pulse -= 1;

      // Which structure this state wants: the one that was picked, or (when the orb follows the work) the state's own.
      const wantId = (R.theme?.styleFor ? R.theme.styleFor(name, th) : null) ?? th.style ?? 'hybrid';
      const want = lookOf(wantId);
      if (want !== target) { target = want; targetId = wantId; }
      // The first frame is the structure itself, not a morph out of the default; after that, ~0.2 s time constant,
      // frame-rate independent, and it survives being interrupted by the next state.
      mixLook(shown, target, started ? 1 - Math.exp(-secs / 0.2) : 1);
      started = true;
      const look = shown;
      const high = quality === 'high';
      // How much fine detail the canvas can actually show. The same geometry on a 120 px orb would be a smear, so the
      // element budget follows the backing size: everything at full size, the strongest motifs only when small.
      const dLevel = canvas.width >= 420 ? 0 : canvas.width >= 260 ? 1 : 2;
      const stepF = [1, 2, 4][dLevel];
      const seg = high ? [SEG, 150, 80][dLevel] : SEG >> 1;
      const curveN = Math.round(CURVE_N * [1, 0.65, 0.35][dLevel]);
      const orbits = Math.min(Math.round(look.orbits), [CURVES.length, 4, 3][dLevel]);
      const sats = Math.min(Math.round(look.sat), [SATS, 8, 4][dLevel]);
      const points = clamp(Math.round((th.particles ?? 160) * look.particles * (high ? 1 : 0.5) * [1, 0.7, 0.4][dLevel]), 0, MAXP);
      const core = R.theme.toRgb(th.core), reactor = R.theme.toRgb(th.reactor), neural = R.theme.toRgb(th.neural), glow = R.theme.toRgb(th.glow);
      const n3 = (c) => [c[0] / 255, c[1] / 255, c[2] / 255];
      const intensity = 1 + (th.glowIntensity ?? 0.85) * 0.35;

      gl.clear(gl.COLOR_BUFFER_BIT);
      gl.useProgram(progs.line);
      gl.uniform1f(progs.lineU.u_fit, 1 / 1.45);

      // ---- the core ----
      gl.useProgram(progs.orb);
      gl.bindBuffer(gl.ARRAY_BUFFER, quad);
      gl.enableVertexAttribArray(progs.orbA);
      gl.vertexAttribPointer(progs.orbA, 2, gl.FLOAT, false, 0, 0);
      const U = progs.orbU;
      gl.uniform1f(U.u_time, anim);
      gl.uniform1f(U.u_level, lvl);
      gl.uniform1f(U.u_state, st);
      gl.uniform3fv(U.u_core, n3(core));
      gl.uniform3fv(U.u_reactor, n3(reactor));
      gl.uniform3fv(U.u_neural, n3(neural));
      gl.uniform3fv(U.u_glow, n3(glow));
      gl.uniform1f(U.u_intensity, intensity);
      gl.uniform1f(U.u_transparency, clamp(th.transparency ?? 0, 0, 0.9));
      gl.uniform1f(U.u_body, look.orb.body);
      gl.uniform1f(U.u_rim, look.orb.rim);
      gl.uniform1f(U.u_nucleus, look.orb.nucleus);
      gl.uniform1f(U.u_vein, look.orb.vein);
      gl.uniform1f(U.u_shell, look.orb.shell);
      gl.uniform1f(U.u_wave, look.orb.wave);
      gl.uniform1f(U.u_ntight, look.orb.n ?? 26);
      gl.drawArrays(gl.TRIANGLES, 0, 6);

      // ---- the outer field: bezel, ticks, filaments, pulses ----
      gl.useProgram(progs.field);
      gl.bindBuffer(gl.ARRAY_BUFFER, quad);
      gl.enableVertexAttribArray(progs.fieldA);
      gl.vertexAttribPointer(progs.fieldA, 2, gl.FLOAT, false, 0, 0);
      const F = progs.fieldU;
      gl.uniform1f(F.u_time, anim);
      gl.uniform1f(F.u_level, lvl);
      gl.uniform1f(F.u_state, st);
      gl.uniform1f(F.u_pulse, pulse);
      gl.uniform1f(F.u_intensity, intensity);
      gl.uniform3fv(F.u_reactor, n3(reactor));
      gl.uniform3fv(F.u_glow, n3(glow));
      gl.uniform3fv(F.u_neural, n3(neural));
      gl.uniform1f(F.u_band, look.field.band);
      gl.uniform1f(F.u_bandw, look.field.bandw ?? 1);
      gl.uniform1f(F.u_break, look.field.break ?? 0);
      gl.uniform1f(F.u_tick, look.field.tick);
      gl.uniform1f(F.u_spoke, look.field.spoke);
      gl.uniform1f(F.u_pulseg, look.field.pulse);
      gl.drawArrays(gl.TRIANGLES, 0, 6);

      // ---- the lines: orbits, satellites, filaments, ticks, inner geometry ----
      gl.useProgram(progs.line);
      gl.uniform1f(progs.lineU.u_fit, 1 / 1.45);
      // Every call uploads its own slice: writing into the Float32Array is not drawing. `offset` counts vertices
      // (and alpha entries) into the shared arrays, so several curves can live in one pair of buffers.
      const line = (pBuf, pData, aBuf, aData, count, mode, color, fade, offset = 0) => {
        gl.bindBuffer(gl.ARRAY_BUFFER, pBuf);
        gl.bufferData(gl.ARRAY_BUFFER, pData.subarray(offset * 3, (offset + count) * 3), gl.DYNAMIC_DRAW);
        gl.enableVertexAttribArray(progs.lineA.p);
        gl.vertexAttribPointer(progs.lineA.p, 3, gl.FLOAT, false, 0, 0);
        gl.bindBuffer(gl.ARRAY_BUFFER, aBuf);
        gl.bufferData(gl.ARRAY_BUFFER, aData.subarray(offset, offset + count), gl.DYNAMIC_DRAW);
        gl.enableVertexAttribArray(progs.lineA.a);
        gl.vertexAttribPointer(progs.lineA.a, 1, gl.FLOAT, false, 0, 0);
        gl.uniform3fv(progs.lineU.u_color, n3(color));
        gl.uniform1f(progs.lineU.u_fade, fade);
        gl.drawArrays(mode, 0, count);
      };

      // The woven orbits: five Lissajous loops in 3D, projected, each with a brightness sweep running round it.
      const tones = [reactor, neural, glow];
      const lineGain = look.line ?? 1;
      const orbitGain = st === 6 ? 0.55 : st === 8 ? 0.25 : 1;
      for (let c = 0; c < orbits; c++) {
        const cfg = CURVES[c];
        const tw = anim * cfg.sp + cfg.ph * 0.1;
        const cw = Math.cos(tw), sw = Math.sin(tw);
        const ct = Math.cos(cfg.tilt), stl = Math.sin(cfg.tilt);
        const baseIdx = c * CURVE_N;
        // The weave at full strength, or a smooth ellipse when a style wants one (torus, burst, spokes).
        const aF = 1 + (cfg.a - 1) * look.smooth, bF = 1 + (cfg.b - 1) * look.smooth;
        const R0 = cfg.R * look.orbitR;
        for (let k = 0; k < curveN; k++) {
          const u = (k / curveN) * TAU;
          const x0 = Math.cos(aF * u + cfg.ph) * R0;
          const y0 = Math.sin(bF * u) * R0;
          const z0 = Math.sin(aF * u) * R0 * 0.55;
          // Turn about Y, then tilt about X: the loop is a wire in space, not a flat drawing.
          const x1 = x0 * cw + z0 * sw, z1 = -x0 * sw + z0 * cw;
          const y1 = y0 * ct - z1 * stl, z2 = y0 * stl + z1 * ct;
          const persp = 1 + z2 * 0.055;
          const i = baseIdx + k;
          curveP[i * 3] = x1 * persp;
          curveP[i * 3 + 1] = y1 * persp;
          curveP[i * 3 + 2] = z2;
          // Depth sets the base brightness; a travelling sweep makes light run along the wire.
          const depth = clamp(0.5 + z2 * 0.5, 0, 1);
          const sweep = 0.5 + 0.5 * Math.sin(u * 2 - anim * 1.7 + cfg.ph);
          curveA[i] = (0.07 + depth * 0.40 + sweep * 0.22 + lvl * 0.14) * orbitGain * lineGain;
        }
        // A drawn line is a few passes of the same wire, each scaled a hair: GL lines are one pixel wide, and these
        // loops are the whole picture in some styles.
        for (let p = 0; p < look.thick; p++) {
          gl.uniform1f(progs.lineU.u_fit, (1 / 1.45) * (1 + p * 0.006));
          const tone = look.tone >= 0 ? look.tone : cfg.tone;
          line(bufs.curveP, curveP, bufs.curveA, curveA, curveN, gl.LINE_STRIP, tones[tone] ?? reactor, 1, c * CURVE_N);
        }
        gl.uniform1f(progs.lineU.u_fit, 1 / 1.45);
      }

      // The satellites: little ellipses drifting on their own orbits, like the drawn ellipses in the reference.
      // Each is written as its own ring of segments into one buffer, so all twelve are a single draw call.
      let sv = 0;
      for (let i = 0; i < sats; i++) {
        const oa = i * 1.71 + anim * (0.09 + hash1(i, 3) * 0.10);
        const orbR = (0.52 + hash1(i, 4) * 0.72) * look.satR;
        const incl = hash1(i, 5) * Math.PI;
        const cx = Math.cos(oa) * orbR, cy = Math.sin(oa) * orbR * Math.cos(incl) * 0.9 + Math.sin(oa * 2.3) * 0.08;
        const cz = Math.sin(oa) * orbR * Math.sin(incl) * 0.5;
        const spin = anim * (0.7 + hash1(i, 6)) + i;
        const rx = (0.030 + hash1(i, 7) * 0.022) * look.satSize, ry = rx * (0.42 + hash1(i, 8) * 0.3);
        const cs = Math.cos(spin), sn = Math.sin(spin);
        const alpha = (0.22 + clamp(0.5 + cz, 0, 1) * 0.32) * orbitGain * lineGain;
        const px = (k) => {
          const a2 = (k / SAT_SEG) * TAU;
          const ex = Math.cos(a2) * rx, ey = Math.sin(a2) * ry;
          return [cx + ex * cs - ey * sn, cy + (ex * sn + ey * cs) * 0.9];
        };
        for (let k = 0; k < SAT_SEG; k++) {
          const A = px(k), B = px(k + 1);
          satP[sv * 3] = A[0]; satP[sv * 3 + 1] = A[1]; satP[sv * 3 + 2] = cz;
          satA[sv] = alpha; sv++;
          satP[sv * 3] = B[0]; satP[sv * 3 + 1] = B[1]; satP[sv * 3 + 2] = cz;
          satA[sv] = alpha; sv++;
        }
      }
      if (sv) line(bufs.satP, satP, bufs.satA, satA, sv, gl.LINES, neural, 1);

      // The radial filaments: a burst from the core out to the bezel, breathing with the voice. Each style says how
      // far they reach, how ragged they are, whether they come in fans (spokes) and whether they are dashed (burst).
      const FS = look.fil;
      const filGain = (0.5 + lvl * 0.9) * (st === 8 ? 0.25 : 1) * FS.gain;
      let fv = 0;
      const fan = FS.cluster;
      for (let i = 0; i < FS.n && fv < filA.length / 2; i += stepF) {
        const base = fan > 0 ? (i % fan) * (TAU / fan) : (i / Math.max(1, FS.n)) * TAU;
        const a2 = base + anim * 0.06 + (hash1(i, 9) - 0.5) * FS.spread;
        const r0 = FS.r0 + hash1(i, 10) * 0.10;
        // The reach varies per ray: a burst's streaks all end somewhere different, an instrument's scale does not.
        const r1 = FS.r1 + (hash1(i, 11) - 0.35) * 0.26 * (FS.var ?? 1);
        const dashes = Math.max(1, FS.dashes), span = (r1 - r0) / dashes;
        for (let d = 0; d < dashes; d++) {
          if (fv >= filA.length / 2) break;
          const s0 = r0 + d * span, s1 = s0 + span * (1 - FS.gap);
          const j = fv * 6;
          filP[j] = Math.cos(a2) * s0; filP[j + 1] = Math.sin(a2) * s0; filP[j + 2] = 0;
          filP[j + 3] = Math.cos(a2) * s1; filP[j + 4] = Math.sin(a2) * s1; filP[j + 5] = 0;
          filA[fv * 2] = (d === 0 ? 0.10 : 0.075) * filGain * (FS.alpha ?? 1); filA[fv * 2 + 1] = 0.005 * (FS.alpha ?? 1);
          fv++;
        }
      }
      // A style can put its filaments in another of the theme's tones (a burst is near-white, a hatch is the reactor).
      if (fv) {
        const fp = Math.max(1, Math.round(FS.passes ?? 1));
        for (let p = 0; p < fp; p++) {
          gl.uniform1f(progs.lineU.u_fit, (1 / 1.45) * (1 + p * 0.008));
          line(bufs.filP, filP, bufs.filA, filA, fv * 2, gl.LINES, tones[FS.tone] ?? neural, 1);
        }
        gl.uniform1f(progs.lineU.u_fit, 1 / 1.45);
      }

      // The bezel's tick scale: short radial marks on the outermost band, in two rings of alternating length.
      let tv = 0;
      if (look.tick > 0.02) {
        for (let i = 0; i < TICKS; i += stepF) {
          const a2 = (i / TICKS) * TAU + anim * 0.03;
          const r1 = 1.36 + (i % 2 ? 0.015 : 0.03);
          const j = tv * 6;
          tickP[j] = Math.cos(a2) * 1.325; tickP[j + 1] = Math.sin(a2) * 1.325; tickP[j + 2] = 0;
          tickP[j + 3] = Math.cos(a2) * r1; tickP[j + 4] = Math.sin(a2) * r1; tickP[j + 5] = 0;
          tickA[tv * 2] = 0.34 * orbitGain * look.tick; tickA[tv * 2 + 1] = 0.05 * orbitGain * look.tick;
          tv++;
        }
        if (tv) line(bufs.tickP, tickP, bufs.tickA, tickA, tv * 2, gl.LINES, reactor, 1);
      }

      // The inner geometry: a wire icosahedron turning one way, a smaller octahedron the other, inside the sphere.
      let gv = 0;
      const poly = (verts, edges, scale, spinA, spinB, spinC, gain) => {
        const ca = Math.cos(spinA), sa = Math.sin(spinA);
        const cb = Math.cos(spinB), sb = Math.sin(spinB);
        const cc = Math.cos(spinC), sc = Math.sin(spinC);
        const proj = verts.map(([x, y, z]) => {
          const x1 = x * ca + z * sa, z1 = -x * sa + z * ca;
          const y1 = y * cb - z1 * sb, z2 = y * sb + z1 * cb;
          const x2 = x1 * cc + y1 * sc, y2 = -x1 * sc + y1 * cc;
          return [x2 * scale, y2 * scale, z2];
        });
        for (const [a2, b2] of edges) {
          const A = proj[a2], B = proj[b2];
          geoP[gv * 3] = A[0]; geoP[gv * 3 + 1] = A[1]; geoP[gv * 3 + 2] = A[2];
          geoA[gv] = gain * clamp(0.45 + A[2] * 0.5, 0, 1);
          gv++;
          geoP[gv * 3] = B[0]; geoP[gv * 3 + 1] = B[1]; geoP[gv * 3 + 2] = B[2];
          geoA[gv] = gain * clamp(0.45 + B[2] * 0.5, 0, 1);
          gv++;
        }
      };
      const geoGain = (st === 2 ? 0.62 : 0.40) * (1 + lvl * 0.5) * look.poly;
      if (look.poly > 0.02) {
        poly(ICO_V, ICO_E, 0.44, anim * 0.35, anim * 0.22, anim * 0.1, geoGain);
        poly(OCT_V, OCT_E, 0.27, -anim * 0.5, anim * 0.62, -anim * 0.3, geoGain * 0.8);
        if (gv) line(bufs.geoP, geoP, bufs.geoA, geoA, gv, gl.LINES, glow, 1);
      }

      // ---- the structural rings: each on its own two axes, each turning its own way. A style picks how many, how
      // big, and how much of each chain is missing: a machined bead chain, or the broken arcs of the last reference.
      let v = 0, ai = 0;
      const speed = st === 2 ? 1.9 : st === 3 ? 1.35 : st === 4 ? 1.15 : 1;
      const R0 = look.rings;
      const nRings = Math.min(RINGS, R0.n);
      for (let i = 0; i < nRings; i++) {
        const cfg = RING_CFG[i];
        const a = anim * cfg.sp * speed + i * 1.7;
        const cA = Math.cos(cfg.tx + Math.sin(anim * 0.21 + i) * 0.12), sA = Math.sin(cfg.tx + Math.sin(anim * 0.21 + i) * 0.12);
        const cB = Math.cos(cfg.ty + Math.cos(anim * 0.17 + i) * 0.1), sB = Math.sin(cfg.ty + Math.cos(anim * 0.17 + i) * 0.1);
        const rr = cfg.r * R0.r * (1 + lvl * 0.02 * (i + 1));
        for (let k = 0; k < seg; k++) {
          const u = k / seg, th2 = a + u * TAU;
          const x0 = Math.cos(th2) * rr, y0 = Math.sin(th2) * rr, z0 = 0;
          const y1 = y0 * cA - z0 * sA, z1 = y0 * sA + z0 * cA;
          const x2 = x0 * cB + z1 * sB, z2 = -x0 * sB + z1 * cB;
          const depth = clamp(0.55 + y1 * 0.35 + z1 * 0.15, 0.2, 1);
          const sweep = Math.pow(Math.max(0, Math.sin(u * TAU * (i + 1) - anim * 2.2)), 6);
          if (R0.gap > 0 && (u * R0.breakN) % 1 < R0.gap) continue;   // a break in the chain: beads, or arcs
          ringPts[v] = x2; ringPts[v + 1] = y1; ringPts[v + 2] = z2; v += 3;
          ringA[ai] = clamp(depth * (0.30 + sweep * 0.65), 0, 1) * (st === 8 ? 0.3 : 1) * R0.gain;
          ringS[ai] = (high ? 2.6 : 2.2) * (0.75 + sweep * 0.9) * R0.bead;
          ai++;
        }
        // Two luminous nodes running along each ring: the bright beads the references carry.
        for (let k = 0; k < 2; k++) {
          const ang = a * 1.0 + k * Math.PI + anim * 0.6;
          ringPoint(cfg, ang, lvl, i, tmp);
          const ni = (i * 2 + k) * 3;
          nodeP[ni] = tmp[0]; nodeP[ni + 1] = tmp[1]; nodeP[ni + 2] = tmp[2];
          nodeA[i * 2 + k] = clamp(0.55 + tmp[2] * 0.4 + lvl * 0.5, 0, 1) * (st === 8 ? 0.3 : 1) * R0.gain * (R0.node > 0.02 ? 1 : 0);
          nodeS[i * 2 + k] = (high ? 5.2 : 4.2) * (1 + lvl * 0.5) * R0.node;
        }
      }

      // ---- the vanishing points: the ring beads, then the nodes, then the neural shell ----
      gl.useProgram(progs.dot);
      gl.uniform1f(progs.dotU.u_fit, 1 / 1.45);
      // Same as line(): upload the slice, then draw it (arrays that were filled but never uploaded drew nothing).
      const dots = (pBuf, pData, aBuf, aData, sBuf, sData, count, color) => {
        gl.bindBuffer(gl.ARRAY_BUFFER, pBuf);
        gl.bufferData(gl.ARRAY_BUFFER, pData.subarray(0, count * 3), gl.DYNAMIC_DRAW);
        gl.enableVertexAttribArray(progs.dotA.p);
        gl.vertexAttribPointer(progs.dotA.p, 3, gl.FLOAT, false, 0, 0);
        gl.bindBuffer(gl.ARRAY_BUFFER, aBuf);
        gl.bufferData(gl.ARRAY_BUFFER, aData.subarray(0, count), gl.DYNAMIC_DRAW);
        gl.enableVertexAttribArray(progs.dotA.a);
        gl.vertexAttribPointer(progs.dotA.a, 1, gl.FLOAT, false, 0, 0);
        gl.bindBuffer(gl.ARRAY_BUFFER, sBuf);
        gl.bufferData(gl.ARRAY_BUFFER, sData.subarray(0, count), gl.DYNAMIC_DRAW);
        gl.enableVertexAttribArray(progs.dotA.s);
        gl.vertexAttribPointer(progs.dotA.s, 1, gl.FLOAT, false, 0, 0);
        gl.uniform3fv(progs.dotU.u_color, n3(color));
        gl.uniform1f(progs.dotU.u_scale, dpr * (high ? 1 : 0.8));
        gl.drawArrays(gl.POINTS, 0, count);
      };
      if (ai) dots(bufs.ringP, ringPts, bufs.ringA, ringA, bufs.ringS, ringS, ai, reactor);
      if (nRings && R0.node > 0.02) dots(bufs.nodeP, nodeP, bufs.nodeA, nodeA, bufs.nodeS, nodeS, nRings * 2, glow);

      // ---- the neural field: drifting points and the links between close ones ----
      if (points > 0) {
        build(points);
        const drift = st === 8 ? 0.02 : st === 0 ? 0.06 : 0.12 + lvl * 0.14;
        const breathe = 1 + Math.sin(anim * 1.3) * 0.02 + lvl * 0.05;
        for (let i = 0; i < points; i++) {
          const ph = base[i * 4 + 3];
          const wob = Math.sin(anim * 0.9 + ph) * drift, wob2 = Math.cos(anim * 0.7 + ph * 1.3) * drift;
          const x = base[i * 4] * breathe + wob, y = base[i * 4 + 1] * breathe + wob2, z = base[i * 4 + 2] * breathe;
          neuP[i * 3] = x; neuP[i * 3 + 1] = y; neuP[i * 3 + 2] = z;
          neuA[i] = clamp(0.12 + (th.particleOpacity ?? 0.75) * (0.42 + 0.42 * Math.sin(anim * 2.1 + ph)) + lvl * 0.3, 0, 1) * (st === 8 ? 0.3 : 1);
          neuS[i] = (high ? 3.0 : 2.2) * (0.7 + 0.5 * Math.sin(anim * 3 + ph));
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
            const a2 = (1 - d2 / 0.09) * 0.30 * (th.particleOpacity ?? 0.75);
            pairA[pa++] = a2; pairA[pa++] = a2;
          }
        }
        if (pv) {
          gl.useProgram(progs.line);
          gl.uniform1f(progs.lineU.u_fit, 1 / 1.45);
          gl.bindBuffer(gl.ARRAY_BUFFER, bufs.linkP);
          gl.bufferData(gl.ARRAY_BUFFER, pairV.subarray(0, pv), gl.DYNAMIC_DRAW);
          gl.enableVertexAttribArray(progs.lineA.p);
          gl.vertexAttribPointer(progs.lineA.p, 3, gl.FLOAT, false, 0, 0);
          gl.bindBuffer(gl.ARRAY_BUFFER, bufs.linkA);
          gl.bufferData(gl.ARRAY_BUFFER, pairA.subarray(0, pa), gl.DYNAMIC_DRAW);
          gl.enableVertexAttribArray(progs.lineA.a);
          gl.vertexAttribPointer(progs.lineA.a, 1, gl.FLOAT, false, 0, 0);
          gl.uniform3fv(progs.lineU.u_color, n3(neural));
          gl.uniform1f(progs.lineU.u_fade, 0.5);
          gl.drawArrays(gl.LINES, 0, pv / 3);
          gl.useProgram(progs.dot);
          gl.uniform1f(progs.dotU.u_fit, 1 / 1.45);
        }
        dots(bufs.neuP, neuP, bufs.neuA, neuA, bufs.neuS, neuS, points, neural);
      }

      frames++;
      drewAny = now;
      api.stats = { frames, ms: Math.round(ema * 10) / 10, quality, points, rings: nRings, orbits, style: targetId, mode: th.styleMode ?? 'fixed' };
      return true;
    }

    /**
     * The frame as the GPU actually drew it: composited light on black, RGBA, top row first. For diagnostics and
     * for checking the render where there is no compositor to look at it (a headless browser).
     */
    function snapshot() {
      if (!api.ok || !gl) return null;
      const w2 = canvas.width, h2 = canvas.height;
      const raw = new Uint8Array(w2 * h2 * 4);
      gl.readPixels(0, 0, w2, h2, gl.RGBA, gl.UNSIGNED_BYTE, raw);
      const out = new Uint8Array(raw.length);
      for (let y = 0; y < h2; y++) out.set(raw.subarray((h2 - 1 - y) * w2 * 4, (h2 - y) * w2 * 4), y * w2 * 4);
      return { width: w2, height: h2, data: out };
    }

    /** Frees every GL object and drops the context: called when the look is replaced or the page goes away. */
    function dispose() {
      try {
        if (gl) {
          for (const p of progs ? [progs.orb, progs.field, progs.line, progs.dot] : []) if (p) gl.deleteProgram(p);
          if (quad) gl.deleteBuffer(quad);
          for (const b of bufs ? Object.values(bufs) : []) gl.deleteBuffer(b);
          gl.getExtension('WEBGL_lose_context')?.loseContext();
        }
      } catch { /* already gone */ }
      gl = null; progs = null; bufs = null; quad = null;
      api.ok = false;
      drewAny = 0;
      frames = 0;
      started = false;
    }

    init();
    return api;
  }

  R.hybrid3d = { create, STATES, PACE, LOOKS, lookOf, mixLook };
})();

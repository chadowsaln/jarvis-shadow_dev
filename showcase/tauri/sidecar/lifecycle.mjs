// The shell's startup log, read back: one line per readiness change in ~/.gg/lifecycle.log, written by main.rs
// (refresh_lifecycle_ui):
//
//   1794789783 desktop=starting ui_ready=false menu_ready=false provider=unknown detail=-
//   1794789785 desktop=desktop_ready ui_ready=true menu_ready=true provider=ready detail=-
//
// The first field is the time (epoch milliseconds; whole seconds in builds from before that, and both are read).
// The panel's About page shows the steps with their timings, so "it sat on Starting" becomes "the tray menu came
// 40 seconds after the interface" without anyone rebuilding with logging on.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

/** Where the shell writes it: always the app's own log folder, whatever data dir the sidecar was given. */
export const lifecycleLog = (home = os.homedir()) => path.join(home, '.gg', 'lifecycle.log');

const FIELDS = ['desktop', 'ui_ready', 'menu_ready', 'provider'];
// A line from an older format (seconds) is below this; a millisecond one is far above it.
const MS_FLOOR = 1e11;

/** One log line as a stage, or null for anything that isn't one. */
export function parseLifecycleLine(line) {
  const text = String(line ?? '').trim();
  if (!text || text.startsWith('#')) return null;
  const [stamp, ...rest] = text.split(/\s+/);
  const n = Number(stamp);
  if (!Number.isFinite(n) || n <= 0) return null;
  const at = Math.round(n < MS_FLOOR ? n * 1000 : n);
  const fields = {};
  for (const pair of rest) {
    const i = pair.indexOf('=');
    if (i <= 0) continue;
    const key = pair.slice(0, i), value = pair.slice(i + 1);
    if (!FIELDS.includes(key)) continue;
    fields[key] = value === 'true' ? true : value === 'false' ? false : value;
  }
  if (!fields.desktop) return null;
  // detail is free text ("Sidecar stopped") and so can hold spaces: it is always the rest of the line.
  const detail = /(?:^|\s)detail=(.*)$/.exec(text)?.[1]?.trim();
  return {
    at,
    desktop: String(fields.desktop),
    uiReady: fields.ui_ready === true,
    menuReady: fields.menu_ready === true,
    provider: String(fields.provider ?? 'unknown'),
    detail: detail && detail !== '-' ? detail : null,
  };
}

const same = (a, b) => a && b && a.desktop === b.desktop && a.uiReady === b.uiReady
  && a.menuReady === b.menuReady && a.provider === b.provider && a.detail === b.detail;

/** The log's stages in order, repeats of one state folded into it (a redraw is not a step), with timings. */
export function lifecycleStages(text, { limit = 40 } = {}) {
  const rows = [];
  for (const line of String(text ?? '').split('\n')) {
    const stage = parseLifecycleLine(line);
    if (!stage) continue;
    const last = rows[rows.length - 1];
    if (last && same(last, stage)) { last.repeats++; last.at = stage.at; continue; }
    rows.push({ ...stage, repeats: 1 });
  }
  const recent = rows.slice(-limit);
  const start = recent[0]?.at ?? 0;
  return recent.map((r, i) => ({
    ...r,
    sinceStart: i ? r.at - start : 0,
    sincePrev: i ? r.at - recent[i - 1].at : 0,
  }));
}

/** What a stage is called in the panel, in the user's terms: the milestone it reached, not the raw state. */
export function stageLabel(stage, prev = null) {
  if (stage.desktop === 'error') return 'Startup failed';
  // A step that changed nothing but the AI provider's state is that, not another "Desktop ready" in the list.
  if (prev && stage.desktop === prev.desktop && stage.uiReady === prev.uiReady && stage.menuReady === prev.menuReady
    && stage.provider !== prev.provider) {
    if (stage.provider === 'ready') return 'AI provider ready';
    if (stage.provider === 'unavailable') return 'AI provider unavailable';
    return 'AI provider';
  }
  if (stage.desktop === 'desktop_ready') return 'Desktop ready';
  // The shell's own names, in the order they are earned. Every signal counts on its own, so a step can be named
  // after the interface even while the sidecar's ready line is still on its way.
  if (stage.desktop === 'sidecar_ready' && !stage.uiReady && !stage.menuReady) return 'Sidecar ready';
  if (stage.menuReady) return 'Tray menu ready';
  if (stage.uiReady) return 'Interface ready';
  if (stage.desktop === 'sidecar_ready') return 'Sidecar ready';
  return stage.detail ? 'Starting again' : 'Starting';
}

/** What the About page shows: the steps of this launch (or the last one), how long each took, and the total. */
export function startupReport(text, { bootAt = null, now = Date.now(), limit = 12, freshMs = 30 * 60e3 } = {}) {
  const stages = lifecycleStages(text, { limit });
  if (!stages.length) return { stages: [], readyMs: null, current: false, stale: false, failed: false, path: null };
  const first = stages[0], last = stages[stages.length - 1];
  const ready = stages.find((s) => s.desktop === 'desktop_ready');
  const failed = stages.some((s) => s.desktop === 'error');
  // "This launch": the log's first line is after the app came up. Nothing newer ever is (the log is per launch,
  // and the shell rewrites states as they change).
  const current = bootAt != null ? first.at >= bootAt - 5000 : now - last.at < freshMs;
  return {
    stages: stages.map((s, i) => ({
      label: stageLabel(s, stages[i - 1] ?? null), at: s.at, sinceStart: s.sinceStart, sincePrev: s.sincePrev,
      provider: s.provider, detail: s.detail, repeated: s.repeats, failed: s.desktop === 'error',
      bad: s.desktop === 'error' || (s.desktop === 'starting' && !!s.detail),
    })),
    readyMs: ready ? ready.sinceStart : null,
    provider: last.provider,
    providerDetail: last.detail,
    failed,
    current,
    stale: now - last.at > freshMs,
    startedAt: first.at,
    path: null,
  };
}

/** Reads the shell's log and reports on it. A missing file is not an error: nothing has started yet. */
export function readStartup(file = lifecycleLog(), opts = {}) {
  let text = '';
  let error = null;
  try {
    // The last lines are all that's wanted: a long-lived app can append for days.
    const size = fs.statSync(file).size;
    const from = Math.max(0, size - 64 * 1024);
    const fd = fs.openSync(file, 'r');
    try {
      const buf = Buffer.alloc(size - from);
      fs.readSync(fd, buf, 0, buf.length, from);
      text = buf.toString('utf8');
      if (from) text = text.slice(text.indexOf('\n') + 1); // the first line is probably cut
    } finally { fs.closeSync(fd) }
  } catch (e) {
    if (e?.code !== 'ENOENT') error = String(e?.message ?? e);
  }
  const report = startupReport(text, opts);
  return { ...report, path: file, error };
}

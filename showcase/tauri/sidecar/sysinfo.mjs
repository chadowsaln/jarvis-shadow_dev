// Linux system status: CPU, memory, swap, disks, battery, temperature, uptime and the busiest processes.
// Read-only: everything comes from /proc, /sys and os/fs stats. No shell, no commands, no writes.
import os from 'node:os';
import fs from 'node:fs/promises';
import path from 'node:path';

const LINUX = process.platform === 'linux';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const clamp = (n, a, b) => Math.max(a, Math.min(b, n));
const round1 = (n) => Math.round(n * 10) / 10;

function bytes(n) {
  if (!Number.isFinite(n) || n < 0) return 'n/a';
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  let i = 0, v = n;
  while (v >= 1024 && i < units.length - 1) { v /= 1024; i++; }
  const d = i === 0 ? 0 : v < 10 ? 1 : 0;
  return `${v.toFixed(d)} ${units[i]}`;
}

function duration(sec) {
  if (!Number.isFinite(sec) || sec < 0) return 'n/a';
  let s = Math.floor(sec);
  const d = Math.floor(s / 86400); s %= 86400;
  const h = Math.floor(s / 3600); s %= 3600;
  const m = Math.floor(s / 60);
  const parts = [];
  if (d) parts.push(`${d}d`);
  if (h || d) parts.push(`${h}h`);
  parts.push(`${m}m`);
  return parts.join(' ');
}

async function readText(file, { fsApi = fs } = {}) {
  try { return await fsApi.readFile(file, 'utf8'); } catch { return null; }
}

// ---------- CPU ----------
function parseStat(text) {
  if (!text) return null;
  for (const line of text.split('\n')) {
    if (!line.startsWith('cpu ')) continue;
    const p = line.trim().split(/\s+/).slice(1).map(Number);
    if (p.length < 4 || p.some((n) => !Number.isFinite(n))) return null;
    const [user, nice, system, idle, iowait = 0, irq = 0, softirq = 0, steal = 0] = p;
    const total = user + nice + system + idle + iowait + irq + softirq + steal;
    const idleAll = idle + iowait;
    return { total, idleAll };
  }
  return null;
}

export async function cpuUsage({ fsApi = fs, wait = sleep, sampleMs = 250 } = {}) {
  const a = parseStat(await readText('/proc/stat', { fsApi }));
  if (!a) return { percent: null, reason: 'CPU statistics unavailable' };
  await wait(sampleMs);
  const b = parseStat(await readText('/proc/stat', { fsApi }));
  if (!b) return { percent: null, reason: 'CPU statistics unavailable' };
  const dt = b.total - a.total;
  const di = b.idleAll - a.idleAll;
  if (!(dt > 0)) return { percent: null, reason: 'CPU usage could not be measured' };
  const pct = clamp((1 - di / dt) * 100, 0, 100);
  return { percent: round1(pct) };
}

async function cpuTemperature({ fsApi = fs } = {}) {
  // Try thermal zones (type/name hints) then hwmon; report the hottest sensible reading found.
  let best = null;
  const consider = (c, label) => {
    if (!Number.isFinite(c) || c < 0 || c > 130) return;
    if (!best || c > best.c) best = { c: round1(c), label: label || 'temperature' };
  };
  const zones = await fsApi.readdir('/sys/class/thermal').catch(() => []);
  for (const z of zones) {
    if (!/^thermal_zone\d+$/.test(z)) continue;
    const base = path.join('/sys/class/thermal', z);
    const t = Number(String(await readText(path.join(base, 'temp'), { fsApi }) ?? '').trim());
    if (!Number.isFinite(t)) continue;
    const type = String(await readText(path.join(base, 'type'), { fsApi }) ?? '').trim() || z;
    consider(t > 1000 ? t / 1000 : t, type);
  }
  if (!best) {
    const hwmons = await fsApi.readdir('/sys/class/hwmon').catch(() => []);
    for (const h of hwmons) {
      const base = path.join('/sys/class/hwmon', h);
      const files = await fsApi.readdir(base).catch(() => []);
      for (const f of files) {
        if (!/^temp\d+_input$/.test(f)) continue;
        const t = Number(String(await readText(path.join(base, f), { fsApi }) ?? '').trim());
        const label = String(await readText(path.join(base, f.replace('_input', '_label')), { fsApi }) ?? '').trim();
        const name = String(await readText(path.join(base, 'name'), { fsApi }) ?? '').trim();
        consider(t > 1000 ? t / 1000 : t, label || name || h);
      }
    }
  }
  return best ? { celsius: best.c, label: best.label } : null;
}

// ---------- Memory & swap ----------
function meminfo(text) {
  const out = {};
  for (const line of String(text ?? '').split('\n')) {
    const m = /^(\w+):\s+(\d+)/.exec(line);
    if (m) out[m[1]] = Number(m[2]) * 1024; // kB -> bytes
  }
  return out;
}

export async function memoryStatus({ fsApi = fs } = {}) {
  const m = meminfo(await readText('/proc/meminfo', { fsApi }));
  if (!m.MemTotal) return { ram: null, swap: null, reason: 'Memory information unavailable' };
  const total = m.MemTotal;
  const available = Number.isFinite(m.MemAvailable) ? m.MemAvailable : (m.MemFree ?? 0) + (m.Buffers ?? 0) + (m.Cached ?? 0);
  const used = Math.max(0, total - available);
  const swapTotal = m.SwapTotal ?? 0;
  const swapFree = m.SwapFree ?? 0;
  const swapUsed = Math.max(0, swapTotal - swapFree);
  return {
    ram: { total, used, available, percent: total ? round1((used / total) * 100) : null },
    swap: { total: swapTotal, used: swapUsed, free: swapFree, percent: swapTotal ? round1((swapUsed / swapTotal) * 100) : null },
  };
}

// ---------- Disks ----------
async function mounts({ fsApi = fs } = {}) {
  const text = await readText('/proc/mounts', { fsApi });
  if (text == null) return null;
  const out = [];
  for (const line of text.split('\n')) {
    const [dev, mp, fstype] = line.split(/\s+/);
    if (!dev || !mp) continue;
    // real filesystems only (skip proc/sys/tmpfs overlays except tmpfs roots people care little about; keep common ones)
    if (!/^(ext\d|xfs|btrfs|vfat|ntfs|f2fs|zfs|apfs|exfat|hfs)/.test(fstype)) continue;
    out.push({ dev, mount: mp.replace(/\\040/g, ' '), fstype });
  }
  return out;
}

export async function diskStatus({ fsApi = fs, statfs = fs.statfs } = {}) {
  const ms = await mounts({ fsApi });
  // Fallback: at least root
  const targets = ms ? [...new Map(ms.map((m) => [m.mount, m])).values()] : [{ mount: '/', fstype: '' }];
  const seenDev = new Set();
  const disks = [];
  for (const m of targets) {
    // de-duplicate bind mounts of same device/mount pairs crudely by mount
    try {
      if (typeof statfs !== 'function') throw new Error('no statfs');
      const s = await statfs(m.mount);
      const bsize = s.bsize || s.frsize || 4096;
      const total = s.blocks * bsize;
      const free = (s.bavail ?? s.bfree) * bsize;
      const used = Math.max(0, total - s.bfree * bsize);
      if (!Number.isFinite(total) || total <= 0) continue;
      const key = `${m.dev}:${total}`;
      if (seenDev.has(key)) continue;
      seenDev.add(key);
      disks.push({ mount: m.mount, fs: m.fstype, total, used, free, percent: total ? round1((used / total) * 100) : null });
    } catch {
      // ignore mounts we can't stat
    }
  }
  disks.sort((a, b) => b.total - a.total);
  return disks.length ? disks : null;
}

// ---------- Battery ----------
export async function batteryStatus({ fsApi = fs } = {}) {
  const base = '/sys/class/power_supply';
  const entries = await fsApi.readdir(base).catch(() => []);
  for (const name of entries) {
    const dir = path.join(base, name);
    const type = String(await readText(path.join(dir, 'type'), { fsApi }) ?? '').trim();
    if (type.toLowerCase() !== 'battery') continue;
    const cap = Number(String(await readText(path.join(dir, 'capacity'), { fsApi }) ?? '').trim());
    const status = String(await readText(path.join(dir, 'status'), { fsApi }) ?? '').trim() || 'Unknown';
    return { name, percent: Number.isFinite(cap) ? clamp(cap, 0, 100) : null, status };
  }
  return null;
}

// ---------- Uptime & system ----------
export async function systemBasics({ fsApi = fs, osApi = os } = {}) {
  let uptimeSec = osApi.uptime?.();
  const upText = await readText('/proc/uptime', { fsApi });
  if (upText) {
    const n = Number(upText.trim().split(/\s+/)[0]);
    if (Number.isFinite(n)) uptimeSec = n;
  }
  const pretty = String(await readText('/etc/os-release', { fsApi }) ?? '')
    .split('\n').find((l) => l.startsWith('PRETTY_NAME='));
  const osName = pretty ? pretty.slice('PRETTY_NAME='.length).replace(/^"|"$/g, '') : [osApi.type?.(), osApi.release?.()].filter(Boolean).join(' ');
  return {
    os: osName || 'Linux',
    hostname: osApi.hostname?.() || 'unknown',
    kernel: osApi.release?.() || '',
    arch: osApi.arch?.() || '',
    uptimeSec: Number.isFinite(uptimeSec) ? uptimeSec : null,
    uptime: Number.isFinite(uptimeSec) ? duration(uptimeSec) : 'n/a',
  };
}

// ---------- Top processes (by CPU over a sample, and by memory) ----------
function procTotal(stat) {
  // /proc/[pid]/stat: fields after comm are space separated; utime stime cutime cstime
  const m = /^\d+ \(.+\) \S(?:.*)$/.exec(stat); // just to be sure it's a stat line
  void m;
  const rparen = stat.lastIndexOf(')');
  if (rparen < 0) return null;
  const rest = stat.slice(rparen + 2).trim().split(/\s+/);
  // rest[0]=state, rest[11]=utime(index 13 overall), rest[12]=stime
  const utime = Number(rest[11]);
  const stime = Number(rest[12]);
  if (!Number.isFinite(utime) || !Number.isFinite(stime)) return null;
  return utime + stime;
}

export async function topProcesses({ fsApi = fs, wait = sleep, sampleMs = 250, limit = 8, memTotalBytes = null } = {}) {
  const readProcs = async () => {
    const entries = await fsApi.readdir('/proc').catch(() => []);
    const list = [];
    for (const pid of entries) {
      if (!/^\d+$/.test(pid)) continue;
      const [stat, status, cmdline] = await Promise.all([
        readText(path.join('/proc', pid, 'stat'), { fsApi }),
        readText(path.join('/proc', pid, 'status'), { fsApi }),
        readText(path.join('/proc', pid, 'cmdline'), { fsApi }),
      ]);
      if (!stat) continue;
      const ticks = procTotal(stat);
      let rssBytes = 0, name = '';
      if (status) {
        const rss = /^VmRSS:\s+(\d+)/m.exec(status);
        if (rss) rssBytes = Number(rss[1]) * 1024;
        const nm = /^Name:\s+(.+)/m.exec(status);
        if (nm) name = nm[1].trim();
      }
      if (cmdline != null) {
        const argv0 = String(cmdline).split('\0').filter(Boolean)[0] || '';
        const base = argv0 ? path.basename(argv0) : '';
        if (base) name = base;
      }
      list.push({ pid: Number(pid), name: name || String(pid), ticks: ticks ?? 0, rssBytes });
    }
    return list;
  };
  const a = await readProcs();
  const aTotal = parseStat(await readText('/proc/stat', { fsApi }));
  await wait(sampleMs);
  const b = await readProcs();
  const bTotal = parseStat(await readText('/proc/stat', { fsApi }));
  const byPidA = new Map(a.map((p) => [p.pid, p]));
  const dt = aTotal && bTotal ? (bTotal.total - aTotal.total) : 0;
  const procs = b.map((p) => {
    const prev = byPidA.get(p.pid);
    const dTicks = prev ? (p.ticks - prev.ticks) : 0;
    const cpu = dt > 0 && dTicks > 0 ? clamp((dTicks / dt) * 100, 0, 100) : 0;
    const mem = memTotalBytes ? clamp((p.rssBytes / memTotalBytes) * 100, 0, 100) : null;
    return { pid: p.pid, name: p.name, cpu: round1(cpu), rssBytes: p.rssBytes, mem: mem != null ? round1(mem) : null };
  });
  const byCpu = [...procs].sort((x, y) => y.cpu - x.cpu || y.rssBytes - x.rssBytes).slice(0, limit);
  const byMem = [...procs].sort((x, y) => y.rssBytes - x.rssBytes || y.cpu - x.cpu).slice(0, limit);
  return { byCpu, byMem };
}

// ---------- aggregate + format ----------
export async function collectSystemStatus({ fsApi = fs, osApi = os, wait = sleep, sampleMs = 250, top = 5 } = {}) {
  if (process.platform !== 'linux') {
    return { supported: false, reason: 'System monitoring is available on Linux only.', at: Date.now() };
  }
  const [cpu, temp, mem, disks, battery, sys, cpuInfo] = await Promise.all([
    cpuUsage({ fsApi, wait, sampleMs }),
    cpuTemperature({ fsApi }),
    memoryStatus({ fsApi }),
    diskStatus({ fsApi }),
    batteryStatus({ fsApi }),
    systemBasics({ fsApi, osApi }),
    Promise.resolve({ cores: osApi.cpus?.()?.length ?? null, model: osApi.cpus?.()?.[0]?.model ?? '' }),
  ]);
  const tops = await topProcesses({ fsApi, wait: async () => {}, sampleMs: 0, limit: top, memTotalBytes: mem?.ram?.total ?? null })
    .catch(() => ({ byCpu: [], byMem: [] }));
  // note: CPU sample already waited; top processes sampled over same window by calling readProcs twice with no extra wait is cheap but
  // better to get consistent CPU - do a dedicated short sample for processes if needed. We already did cpuUsage which waited; reuse approach:
  // Instead, compute processes with its own small sample only when needed is heavier. Simpler: sample processes across sampleMs separately.
  // To keep one wait total: we sampled CPU above (waited). We'll do a fresh quick sample for processes reusing that timing is complex;
  // easier: do processes sampling in parallel-ish by structuring differently. But keep simple and correct: collect again with proper sampling.
  void tops;
  const proc = await topProcesses({ fsApi, wait, sampleMs, limit: top, memTotalBytes: mem?.ram?.total ?? null })
    .catch(() => ({ byCpu: [], byMem: [] }));
  // cpuUsage above already consumed ~sampleMs; we did another sampleMs in proc - total ~500ms, fine for a status read.
  return { supported: true, at: Date.now(), cpu, cpuInfo, temp, mem, disks, battery, sys, top: proc };
}

export function formatSystemStatus(d) {
  if (!d) return 'System status unavailable.';
  if (d.supported === false) return d.reason || 'System monitoring is not available here.';
  const lines = [];
  lines.push(`System status · ${new Date(d.at).toLocaleString()}`);
  // System
  const s = d.sys || {};
  lines.push('', 'System');
  lines.push(`  OS: ${s.os || 'n/a'}${s.kernel ? ` (kernel ${s.kernel})` : ''}`);
  lines.push(`  Host: ${s.hostname || 'n/a'}${s.arch ? ` · ${s.arch}` : ''}`);
  lines.push(`  Uptime: ${s.uptime || 'n/a'}`);
  // CPU
  lines.push('', 'CPU');
  const cpuPct = d.cpu?.percent;
  const cores = d.cpuInfo?.cores;
  lines.push(`  Usage: ${cpuPct != null ? `${cpuPct}%` : (d.cpu?.reason || 'n/a')}${cores ? ` · ${cores} cores` : ''}`);
  if (d.cpuInfo?.model) lines.push(`  Model: ${String(d.cpuInfo.model).trim()}`);
  if (d.temp) lines.push(`  Temperature: ${d.temp.celsius} °C${d.temp.label ? ` (${d.temp.label})` : ''}`);
  else lines.push('  Temperature: not available');
  // Memory
  lines.push('', 'Memory');
  const ram = d.mem?.ram;
  if (ram) lines.push(`  RAM: ${bytes(ram.used)} / ${bytes(ram.total)} used (${ram.percent}%) · ${bytes(ram.available)} available`);
  else lines.push(`  RAM: ${d.mem?.reason || 'n/a'}`);
  const swap = d.mem?.swap;
  if (swap && swap.total > 0) lines.push(`  Swap: ${bytes(swap.used)} / ${bytes(swap.total)} used (${swap.percent}%)`);
  else if (swap) lines.push('  Swap: none configured');
  else lines.push('  Swap: n/a');
  // Disks
  lines.push('', 'Disks');
  if (Array.isArray(d.disks) && d.disks.length) {
    for (const k of d.disks.slice(0, 8)) {
      lines.push(`  ${k.mount}: ${bytes(k.used)} / ${bytes(k.total)} used (${k.percent}%) · ${bytes(k.free)} free${k.fs ? ` [${k.fs}]` : ''}`);
    }
  } else lines.push('  Disk information unavailable');
  // Battery
  lines.push('', 'Battery');
  if (d.battery) {
    const b = d.battery;
    lines.push(`  ${b.percent != null ? `${b.percent}%` : 'level n/a'} · ${b.status}${b.name ? ` (${b.name})` : ''}`);
  } else lines.push('  No battery detected');
  // Top processes
  const procs = d.top || {};
  const fmtP = (p, kind) => {
    const mem = p.mem != null ? `${p.mem}%` : bytes(p.rssBytes);
    const val = kind === 'cpu' ? `${p.cpu}% CPU` : `${mem} RAM`;
    return `  ${p.pid}\t${val}\t${p.name}`;
  };
  if ((procs.byCpu && procs.byCpu.length) || (procs.byMem && procs.byMem.length)) {
    lines.push('', 'Top processes (by CPU)');
    if (procs.byCpu?.length) for (const p of procs.byCpu) lines.push(fmtP(p, 'cpu'));
    else lines.push('  n/a');
    lines.push('', 'Top processes (by memory)');
    if (procs.byMem?.length) for (const p of procs.byMem) lines.push(fmtP(p, 'mem'));
    else lines.push('  n/a');
  } else {
    lines.push('', 'Top processes: unavailable');
  }
  return lines.join('\n');
}

export async function getSystemStatus(opts = {}) {
  const data = await collectSystemStatus(opts);
  return { data, text: formatSystemStatus(data) };
}

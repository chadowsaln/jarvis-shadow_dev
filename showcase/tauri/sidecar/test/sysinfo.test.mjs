// Batch 7: Linux system monitoring - read-only, no shell, graceful on missing sensors/data. Run: npm test
import assert from 'node:assert/strict';
import os from 'node:os';
import {
  cpuUsage, memoryStatus, diskStatus, batteryStatus, systemBasics, topProcesses,
  formatSystemStatus, getSystemStatus,
} from '../sysinfo.mjs';

const wait0 = async () => {};

function memFs(files) {
  const map = new Map(Object.entries(files));
  return {
    async readFile(p) {
      if (!map.has(p)) throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' });
      return map.get(p);
    },
    async readdir(p) {
      if (!map.has(p)) throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' });
      const v = map.get(p);
      if (!Array.isArray(v)) throw Object.assign(new Error('ENOTDIR'), { code: 'ENOTDIR' });
      return v;
    },
    async statfs() { throw new Error('no statfs'); },
  };
}

// --- CPU ---
{
  const fsApi = memFs({
    '/proc/stat': 'cpu  100 0 50 850 0 0 0 0\n',
  });
  // second read with more total/jiffies
  let reads = 0;
  const fs2 = { ...fsApi, async readFile(p) { reads++; const base = reads === 1 ? 'cpu  100 0 50 850 0 0 0 0\n' : 'cpu  150 0 70 930 0 0 0 0\n'; if (p === '/proc/stat') return base; throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' }); } };
  const r = await cpuUsage({ fsApi: fs2, wait: wait0, sampleMs: 0 });
  assert.equal(typeof r.percent, 'number');
  assert.ok(r.percent >= 0 && r.percent <= 100, `percent in range: ${r.percent}`);
  // dt=150, busy=70 => 46.7%
  assert.equal(r.percent, 46.7);
}
{
  const r = await cpuUsage({ fsApi: memFs({}), wait: wait0, sampleMs: 0 });
  assert.equal(r.percent, null);
  assert.match(r.reason, /unavailable/i);
}

// --- Memory & swap ---
{
  const meminfo = 'MemTotal:       8000000 kB\nMemFree:        1000000 kB\nMemAvailable:   3000000 kB\nBuffers:         200000 kB\nCached:          800000 kB\nSwapTotal:      2000000 kB\nSwapFree:       1500000 kB\n';
  const r = await memoryStatus({ fsApi: memFs({ '/proc/meminfo': meminfo }) });
  assert.ok(r.ram);
  assert.equal(r.ram.total, 8000000 * 1024);
  assert.equal(r.ram.available, 3000000 * 1024);
  assert.equal(r.ram.used, 5000000 * 1024);
  assert.ok(Math.abs(r.ram.percent - 62.5) < 0.2);
  assert.ok(r.swap);
  assert.equal(r.swap.total, 2000000 * 1024);
  assert.equal(r.swap.used, 500000 * 1024);
}
{
  const r = await memoryStatus({ fsApi: memFs({}) });
  assert.equal(r.ram, null);
  assert.match(r.reason, /unavailable/i);
}
{
  const meminfo = 'MemTotal:       1000000 kB\nMemAvailable:    500000 kB\nSwapTotal:             0 kB\nSwapFree:              0 kB\n';
  const r = await memoryStatus({ fsApi: memFs({ '/proc/meminfo': meminfo }) });
  assert.equal(r.swap.total, 0);
  assert.equal(r.swap.percent, null);
}

// --- Battery ---
{
  const fsApi = memFs({
    '/sys/class/power_supply': ['BAT0', 'AC'],
    '/sys/class/power_supply/BAT0/type': 'Battery\n',
    '/sys/class/power_supply/BAT0/capacity': '73\n',
    '/sys/class/power_supply/BAT0/status': 'Discharging\n',
    '/sys/class/power_supply/AC/type': 'Mains\n',
  });
  const r = await batteryStatus({ fsApi });
  assert.deepEqual(r, { name: 'BAT0', percent: 73, status: 'Discharging' });
}
{
  const r = await batteryStatus({ fsApi: memFs({ '/sys/class/power_supply': [] }) });
  assert.equal(r, null);
}
{
  const r = await batteryStatus({ fsApi: memFs({}) });
  assert.equal(r, null);
}

// --- System basics & uptime ---
{
  const fsApi = memFs({
    '/proc/uptime': '12345.67 99999.00\n',
    '/etc/os-release': 'NAME="Ubuntu"\nPRETTY_NAME="Ubuntu 24.04"\n',
  });
  const fakeOs = { hostname: () => 'box', release: () => '6.8.0', arch: () => 'x64', uptime: () => 10 };
  const r = await systemBasics({ fsApi, osApi: fakeOs });
  assert.equal(r.uptimeSec, 12345.67);
  assert.equal(r.os, 'Ubuntu 24.04');
  assert.equal(r.hostname, 'box');
  assert.equal(r.kernel, '6.8.0');
  assert.match(r.uptime, /d|h|m/);
}

// --- Disks ---
{
  const mounts = '/dev/sda1 / ext4 rw 0 0\nproc /proc proc rw 0 0\n/dev/sdb1 /home ext4 rw 0 0\n';
  const fsApi = {
    ...memFs({ '/proc/mounts': mounts }),
    async statfs(mount) {
      if (mount === '/') return { bsize: 4096, blocks: 1000, bfree: 400, bavail: 350 };
      if (mount === '/home') return { bsize: 4096, blocks: 2000, bfree: 1000, bavail: 900 };
      throw new Error('no');
    },
  };
  const r = await diskStatus({ fsApi, statfs: fsApi.statfs });
  assert.ok(Array.isArray(r) && r.length === 2);
  const root = r.find((d) => d.mount === '/');
  assert.ok(root);
  assert.equal(root.total, 1000 * 4096);
  assert.equal(root.percent, 60);
}
{
  const r = await diskStatus({ fsApi: memFs({}), statfs: async () => { throw new Error('x'); } });
  assert.equal(r, null);
}

// --- Top processes (graceful empty) ---
{
  const fsApi = memFs({ '/proc': [], '/proc/stat': 'cpu  1 0 1 10 0 0 0 0\n' });
  const r = await topProcesses({ fsApi, wait: wait0, sampleMs: 0, limit: 5, memTotalBytes: 1000 });
  assert.deepEqual(r.byCpu, []);
  assert.deepEqual(r.byMem, []);
}

// --- Formatting & missing data ---
{
  const txt = formatSystemStatus({
    supported: true, at: Date.UTC(2026, 10, 14),
    cpu: { percent: 12.3 }, cpuInfo: { cores: 8, model: 'Test CPU' },
    temp: { celsius: 55.5, label: 'pkg' },
    mem: { ram: { total: 8e9, used: 4e9, available: 4e9, percent: 50 }, swap: { total: 0, used: 0, free: 0, percent: null } },
    disks: [{ mount: '/', fs: 'ext4', total: 100e9, used: 40e9, free: 60e9, percent: 40 }],
    battery: null,
    sys: { os: 'Linux', hostname: 'h', kernel: '6.1', arch: 'x64', uptime: '1d 2h 3m' },
    top: { byCpu: [{ pid: 1, name: 'init', cpu: 1.2, rssBytes: 1000, mem: 0.1 }], byMem: [{ pid: 2, name: 'app', cpu: 0.1, rssBytes: 2e9, mem: 25 }] },
  });
  assert.match(txt, /CPU/);
  assert.match(txt, /12\.3%/);
  assert.match(txt, /Temperature: 55\.5/);
  assert.match(txt, /RAM:/);
  assert.match(txt, /Swap: none configured/);
  assert.match(txt, /No battery detected/);
  assert.match(txt, /Top processes \(by CPU\)/);
  assert.match(txt, /init/);
  assert.match(txt, /Top processes \(by memory\)/);
  assert.match(txt, /app/);
}
{
  const txt = formatSystemStatus({ supported: false, reason: 'Linux only' });
  assert.match(txt, /Linux only/);
}
{
  const txt = formatSystemStatus(null);
  assert.match(txt, /unavailable/i);
}

// --- getSystemStatus on non-Linux reports clearly (read-only) ---
if (process.platform !== 'linux') {
  const out = await getSystemStatus();
  assert.equal(out.data.supported, false);
  assert.match(out.text, /Linux/i);
}

console.log('sysinfo: ok');

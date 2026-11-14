// A real microphone, on this machine (not part of `npm test`: it needs hardware and a desktop session).
// It lists the microphones the voice helper offers, records a second from the default and from a picked one, and says
// which device captured and how loud it was. Run it when "it didn't hear me" needs facts:
//   npm run test:audio                 (the helper next to a debug or release build, or ROAMIES_VOICE)
//   npm run test:audio -- --mic "Pro 10s"
// Exit 0 when the input path works (silence is reported, not failed: a quiet room is not a bug). Exit 1 when the
// helper can't open a microphone at all. With no helper or no microphone it skips, so CI can run it.
import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, '../../../..');
const argPick = (() => {
  const i = process.argv.indexOf('--mic');
  return i > 0 ? process.argv[i + 1] : null;
})();

// Where build.sh puts it (target/<triple>/release) and where a plain cargo build does (voice-win/target/debug).
const helper = [
  process.env.ROAMIES_VOICE,
  path.join(root, 'showcase/tauri/src-tauri/voice-win/target/debug/roamies-voice'),
  path.join(root, 'showcase/tauri/src-tauri/voice-win/target/release/roamies-voice'),
  path.join(root, 'showcase/tauri/src-tauri/target/debug/roamies-voice'),
  path.join(root, 'showcase/tauri/src-tauri/target/release/roamies-voice'),
].find((p) => p && existsSync(p));

const skip = (why) => {
  console.log(`audio check skipped: ${why}`);
  process.exit(0);
};
if (!helper) skip('no roamies-voice binary (build it first, or set ROAMIES_VOICE)');

// The helper prints one JSON line; diagnostics may print more than one.
const run = (args) => {
  const r = spawnSync(helper, args, { encoding: 'utf8', timeout: 30_000 });
  const line = (r.stdout ?? '').trim().split('\n').reverse().find((l) => l.trim().startsWith('{'));
  let json = null;
  try { json = line ? JSON.parse(line) : null; } catch { /* reported below */ }
  return { status: r.status, json, stderr: (r.stderr ?? '').trim() };
};

const listed = run(['--devices']);
const devices = listed.json;
if (!devices || devices.type !== 'devices') skip(`the helper couldn't list devices${listed.stderr ? `: ${listed.stderr.split('\n').at(-1)}` : ''}`);
const inputs = (devices.inputs ?? []).filter((d) => d?.name && !d.monitor);
if (!inputs.length) skip('the system lists no microphone');
const def = devices.default?.name ?? null;
console.log(`microphones (${devices.host ?? '?'}${devices.capture ? ` / ${devices.capture}` : ''})` + (devices.why ? ` — ${devices.why}` : ''));
for (const d of inputs) console.log(`  ${d.name === def ? '*' : ' '} ${d.description ?? d.name}${d.error ? ` (can't open: ${d.reason})` : ''}`);

const tmp = mkdtempSync(path.join(os.tmpdir(), 'roamies-mic-'));
const check = (label, extra = []) => {
  const out = path.join(tmp, `${label.replace(/\W+/g, '-')}.wav`);
  const r = run(['--record', '1.5', '--out', out, ...extra]);
  if (!r.json || r.json.type !== 'record') {
    console.log(`${label}: failed (${r.json?.error ?? r.stderr.split('\n').at(-1) ?? `exit ${r.status}`})`);
    return false;
  }
  const { device, samples, peak_db, verdict } = r.json;
  const how = verdict === 'ok' ? 'ok' : verdict === 'silent' ? 'silent (muted, or a very quiet room)' : 'STUCK (a constant signal: the device is muted or the driver is confused)';
  console.log(`${label}: ${device.used}${device.fallback ? ` (fell back from ${device.wanted})` : ''} — ${samples} samples, peak ${peak_db} dB, ${how}`);
  return samples > 8000;
};

let ok = check('default');
if (argPick ?? (inputs.length > 1 ? inputs.find((d) => d.name !== def)?.name : null)) {
  ok = check('picked', ['--mic', argPick ?? inputs.find((d) => d.name !== def).name]) && ok;
}
rmSync(tmp, { recursive: true, force: true });
if (!ok) {
  console.log('audio check failed: no usable samples (see `roamies-voice --devices` above)');
  process.exit(1);
}
console.log('audio check passed');

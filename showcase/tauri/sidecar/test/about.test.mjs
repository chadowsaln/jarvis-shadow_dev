import assert from 'node:assert/strict';
import { aboutLittleBoy } from '../about.mjs';

// The app's manual for about_littleboy: each platform's own wording, and only the features this copy has.
const base = { name: 'Hybrid', looks: ['Hybrid'], mac: false, linux: false, snap: false, pointer: false, voice: false, hotkeys: false };
const mac = aboutLittleBoy({ ...base, mac: true, snap: true, pointer: true, voice: true, hotkeys: true });
const win = aboutLittleBoy(base);
const linux = aboutLittleBoy({ ...base, linux: true, voice: true });
assert.match(mac, /lives in the menu bar at the top of the screen/);
assert.match(mac, /Show Hybrid, Ask Hybrid…, Ask About an Area…, Stop, Quit JARVIS V2/);
assert.match(mac, /Appearance \(pick your look and its size: Hybrid/);
assert.match(mac, /wake word: say "Hey JARVIS"/);
assert.match(mac, /Voice \(pick the voice provider and model/);
assert.match(win, /bottom right of the taskbar/);
assert.ok(!/Ask About an Area|Wake word|Voice Control|Cursor, a little arrow/.test(win), 'features this copy lacks are left out');
assert.match(linux, /AppIndicator extension/);
assert.match(linux, /bind keys in your desktop settings for littleboy/);
assert.ok(!/Wake word/.test(linux), 'the wake word is Mac only');
for (const t of [mac, win, linux]) {
  assert.match(t, /Save Diagnostics/);
  assert.match(t, /github\.com\/KenKaiii\/LittleBoy/);
  assert.ok(!/\$\{|undefined/.test(t), 'every part is filled in');
}
console.log('about tests: passed');

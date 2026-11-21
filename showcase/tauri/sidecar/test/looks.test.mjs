import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { DEFAULT_VOICE } from '../fish.mjs';

// Every look the app offers has a drawing and its voice; the setup guide offers the same looks.
const src = (p) => readFileSync(fileURLToPath(new URL(p, import.meta.url)), 'utf8');
const side = src('../sidekick.mjs'), guide = src('../../../onboarding/onboarding.js');
const looks = [...side.slice(side.indexOf('const LOOKS = ['), side.indexOf('];', side.indexOf('const LOOKS = ['))).matchAll(/\['(\w+)', '([^']+)', (DEFAULT_VOICE|'(\w+)')\]/g)];
assert.deepEqual(looks.map((m) => m[1]), ['hybrid']);
const voices = Object.fromEntries(looks.map((m) => [m[1], m[4] ?? null]));
assert.equal(DEFAULT_VOICE, '2680da81de8348a68e1f4dbaa79272f1');
assert.equal(voices.hybrid, 'e13fa398a7f445a685316a3de6089ce7');
// Regression: Roamie spoke with JARVIS's voice (the default was JARVIS's ID).
assert.equal(new Set([DEFAULT_VOICE, ...Object.values(voices).filter(Boolean)]).size, 2, 'only the hybrid look remains');
assert.ok(!/config\.fishVoice/.test(side), 'a saved fishVoice (the old JARVIS default) is never used');
for (const [, id, label] of looks) assert.ok(guide.includes(`['${id}', '${label}']`), `the setup guide offers ${label}`);
// Each look greets you in its voice when picked, with the words Settings and the setup guide show.
{
  const obj = (text, name) => new Function(`return ${text.match(new RegExp(`const ${name} = (\\{[^}]*\\})`))[1]}`)();
  const said = obj(side, 'LOOK_GREETINGS');
  assert.deepEqual(Object.keys(said), looks.map((m) => m[1]), 'a greeting for every look');
  assert.deepEqual(obj(src('../../../panel/panel.js'), 'QUIPS'), said, 'Settings shows the spoken greeting');
  assert.deepEqual(obj(guide, 'LOOK_QUIPS'), said, 'the setup guide shows the spoken greeting');
  const set = side.slice(side.indexOf('function setLook('), side.indexOf('\n}\n', side.indexOf('function setLook(')));
  assert.match(set, /if \(changed && VOICE_ON\(\) && !busy\)/, 'only for a new look, with voice on, and not over a reply');
  assert.match(set, /v\.say\(LOOK_GREETINGS\[l\]\)/);
}

// The characters draw at every size without throwing, inside their area, and the sprites are well formed.
// people.js removed; no pixel characters remain.
console.log('looks tests: passed');

// Regression: a selected stage canvas showed as a grey box around the Roamie (WebKit tints selected canvases).
assert.match(src('../../../desktop.html'), /canvas \{[^}]*-webkit-user-select: none; user-select: none;[^}]*\}/);

// Regression: after a drawing the Sidekick stopped following the cursor and hopped away from it instead.
{
  const agent = src('../../../roamies/agent.js'), rel = agent.slice(agent.indexOf('async release()'), agent.indexOf('place: (x, y) =>'));
  assert.match(agent, /pen\.follow = !!station\.byCursor/, 'take() remembers whether it was following the cursor');
  assert.match(rel, /if \(pen\.follow && presence\.ptr\) station\.byCursor = presence\.ptr\.slice\(\)/, 'release() goes back to following');
}

// The bubbles, tags and step list draw with glass.js, so the overlay loads it before them.
{
  const page = src('../../../desktop.html'), at = (f) => page.indexOf(`roamies/${f}`);
  assert.ok(at('glass.js') > 0 && at('glass.js') < at('agent.js') && at('glass.js') < at('agent-cards.js'), 'desktop.html loads glass.js before agent.js and agent-cards.js');
}

// JARVIS is a reactor orb, not a character. Gesture anchors may drive motion internally, but detached
// pixel mitts must never be painted beside the orb where they read as two extra speech bubbles.
{
  const kit = src('../../../roamies/10-dither.js');
  assert.match(kit, /spring\(h\.o, tg\[0\] \* R, tg\[1\] \* R/, 'gesture anchors remain in the body\'s own space');
  assert.match(kit, /h\.y = m\.y \+ oy \+ h\.o\.y/, 'and ride its hop once');
  assert.doesNotMatch(kit, /const drawHands\s*=/, 'no detached pixel hands are rendered');
}


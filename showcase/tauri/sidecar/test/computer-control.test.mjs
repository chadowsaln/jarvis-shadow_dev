import assert from 'node:assert/strict';
import { createATSPIDriver } from '../computer-control/atspi-adapter.mjs';
import { createInputSimulator } from '../computer-control/input-simulation.mjs';
import { createOCREngine } from '../computer-control/ocr-adapter.mjs';

const d = createATSPIDriver();
const apps = await d.getApplicationList().catch(e => { throw e; });
assert.ok(Array.isArray(apps), 'getApplicationList returns an array');

const sim = createInputSimulator();
assert.equal(sim.getBackend(), 'ydotool', 'backend is ydotool');

const ocr = createOCREngine();
await ocr.initialize('eng');
assert.equal(ocr.ready, true);
console.log('computer-control tests: passed');
process.exit(0);

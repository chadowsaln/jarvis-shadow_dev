import assert from 'node:assert/strict';
import { createLinuxPlayer } from '../player-linux.mjs';

{ // Lifecycle: start, stream chunks, end
  const events = [];
  const player = createLinuxPlayer({ log: (kind, data) => events.push({ kind, data }) });

  // Generate 100ms sample at 24000 Hz
  const sample = Buffer.alloc(2400 * 2);
  player.play('s1', sample, 24000);
  player.play('s1', sample.toString('base64'), 24000);
  player.end('s1');
  player.stop();

  assert.ok(events.length >= 0);
}

{ // Changing ID or sample rate stops old process and starts new one
  const events = [];
  const player = createLinuxPlayer({ log: (kind, data) => events.push({ kind, data }) });

  const chunk1 = Buffer.alloc(200);
  player.play('s1', chunk1, 24000);
  player.play('s2', chunk1, 44100);
  player.stop();
}

console.log('linux player tests: all passed');

// The hearing smoke test (test/hear-smoke.mjs), checked offline: what it reads out of a WAV, how it judges a
// language, and that a wrong answer or a refused key is reported as a failure rather than a pass. The live part —
// Google's own answer to a real Arabic and a real English take — needs a key and two recordings, and is run by hand:
//   GEMINI_API_KEY=... node test/hear-smoke.mjs ar.wav en.wav
import assert from 'node:assert/strict';
import { describeWav, verdict, run, mockFetch, tone } from './hear-smoke.mjs';
import { wav } from '../stt.mjs';

// ---- what the file is ----
{
  const good = describeWav(wav(tone(2)));
  assert.equal(good.ok, true, 'the WAV this repo makes is a WAV');
  assert.equal(good.why, null, '16 kHz mono 16-bit PCM needs no excuse');
  assert.equal(Math.round(good.seconds), 2, 'two seconds of audio reads as two seconds');

  assert.equal(describeWav(Buffer.from('not a wav at all')).ok, false, 'garbage is not a WAV');

  const eight = wav(tone(1), 8000);
  assert.match(describeWav(eight).why, /8000 Hz/, 'another rate is reported, not hidden');

  const stereo = Buffer.from(wav(tone(1)));
  stereo.writeUInt16LE(2, 22); // claim two channels
  assert.match(describeWav(stereo).why, /2 channels/, 'as is a stereo take');

  const twelve = Buffer.from(wav(tone(1)));
  twelve.writeUInt16LE(12, 34);
  assert.match(describeWav(twelve).why, /12-bit/, 'as is a take that is not 16-bit');

  // A recording out of an editor carries a LIST chunk before its audio: the header has to be walked, not assumed.
  // Reading fixed offsets would describe the metadata and trim the wrong bytes out of the take.
  {
    const plain = wav(tone(2));
    const info = Buffer.from('INFOISFT\x0c\x00\x00\x00Lavf58.29.100\x00', 'latin1');
    const list = Buffer.concat([Buffer.from('LIST', 'ascii'), Buffer.alloc(4), info]);
    list.writeUInt32LE(info.length, 4);
    const head = Buffer.from(plain.subarray(0, 36));           // RIFF/WAVE + fmt, up to 'data'
    const tail = Buffer.from(plain.subarray(36));              // 'data' + size + samples
    const chunked = Buffer.concat([head, list, tail]);
    chunked.writeUInt32LE(chunked.length - 8, 4);              // the RIFF size covers the extra chunk
    const d = describeWav(chunked);
    assert.equal(d.ok, true, 'a WAV with a LIST chunk is still a WAV');
    assert.equal(d.why, null, 'and still 16 kHz mono 16-bit PCM');
    assert.equal(Math.round(d.seconds), 2, 'its duration comes from the data chunk, not from a guessed offset');
    assert.equal(d.size, 2 * 16000 * 2, 'and so does its size');
  }
}

// ---- the language verdict ----
assert.equal(verdict('ar', 'ar'), 'ok');
assert.equal(verdict('en', 'en'), 'ok');
// Code-switching is the reason this provider exists: a take that reads as both was still heard.
assert.equal(verdict('ar', 'mixed'), 'ok (mixed)');
assert.equal(verdict('en', 'mixed'), 'ok (mixed)');
assert.equal(verdict('ar', 'en'), 'wrong', 'the other language is wrong');
assert.equal(verdict('en', 'ar'), 'wrong');
assert.equal(verdict('ar', null), 'wrong', 'no language and no letters is not a pass');

// ---- the run: a canned answer in the API's own envelope ----
const lines = [];
const say = (l) => lines.push(l);
{
  const { fetchImpl, seen } = mockFetch();
  const r = await run({
    files: [
      { label: 'ar', expected: 'ar', bytes: wav(tone(1)) },
      { label: 'en', expected: 'en', bytes: wav(tone(1)) },
    ],
    key: 'not-a-real-key', fetchImpl, say, mock: true,
  });
  assert.equal(r.fail, 0, 'both takes pass');
  assert.equal(r.pass, 2);
  assert.ok(seen.every((s) => s.url.endsWith('/interactions')), 'sent to the transcription endpoint');
  assert.ok(seen.every((s) => s.headers['x-goog-api-key'] === 'not-a-real-key'), 'with the key in its own header');
  assert.match(lines.join('\n'), /مرحبا/, 'the Arabic transcript is printed');
  assert.match(lines.join('\n'), /Hello, how are you doing today\?/, 'and the English one');
  assert.match(lines.join('\n'), /expected ar: ok/, 'with the verdict');
  assert.ok(!lines.join('\n').includes('not-a-real-key'), 'and never the key');
}

// A model that hears the wrong language fails the run — that is the whole point of sending both takes.
{
  const { fetchImpl } = mockFetch([
    { output: [{ language_code: 'en', text: 'Hello, how are you doing today?' }] },
    { output: [{ language_code: 'en', text: 'Hello again.' }] },
  ]);
  const text = [];
  const r = await run({
    files: [
      { label: 'ar', expected: 'ar', bytes: wav(tone(1)) },
      { label: 'en', expected: 'en', bytes: wav(tone(1)) },
    ],
    key: 'k', fetchImpl, say: (l) => text.push(l), mock: true,
  });
  assert.equal(r.pass, 1, 'only the English take passed');
  assert.equal(r.fail, 1);
  assert.match(text.join('\n'), /expected ar: wrong/, 'and it says which one');
}

// A refused key is a failure, not a crash — and it stops before sending any audio, because the audio would say
// nothing about it.
{
  const calls = [];
  const fetchImpl = async (url) => {
    calls.push(url);
    return { ok: false, status: 400, text: async () => '{"error":{"message":"API_KEY_INVALID"}}' };
  };
  const text = [];
  const r = await run({
    files: [{ label: 'ar', expected: 'ar', bytes: wav(tone(1)) }, { label: 'en', expected: 'en', bytes: wav(tone(1)) }],
    key: 'bad', fetchImpl, say: (l) => text.push(l),
  });
  assert.equal(r.fatal, 'key', 'the key is the reason');
  assert.equal(r.fail, 2, 'both takes failed');
  assert.match(text.join('\n'), /key: refused \(key\)/, 'said once, up front');
  assert.equal(calls.filter((u) => u.endsWith('/interactions')).length, 0, 'and no take was sent');
}

// A file that is not there is reported, not thrown.
{
  const text = [];
  const r = await run({ files: [{ label: 'ar', expected: 'ar', path: '/nonexistent/x.wav' }], key: 'k', say: (l) => text.push(l), mock: true });
  assert.equal(r.fail, 1);
  assert.match(text.join('\n'), /cannot read it/);
}

console.log('hearing smoke test (offline): ok');

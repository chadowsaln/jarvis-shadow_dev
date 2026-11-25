// Plays spoken replies directly to the system audio server (PipeWire, PulseAudio, or ALSA) on Linux.
// Bypasses WebKitGTK WebAudio restrictions (autoplay policies, suspended AudioContext, transparent click-through
// window activation requirements) and prevents competing multi-webview audio streams.
import { spawn } from 'node:child_process';

export function createLinuxPlayer({ log = () => {} } = {}) {
  let proc = null;
  let currentId = null;
  let currentRate = 0;
  let currentBin = null;

  function stop() {
    if (proc) {
      try { proc.stdin?.destroy(); } catch {}
      try { proc.kill('SIGKILL'); } catch {}
      proc = null;
    }
    currentId = null;
    currentRate = 0;
    currentBin = null;
  }

  function spawnPlayer(rate) {
    const candidates = [
      { bin: 'pw-play', args: ['--raw', '--rate', String(rate), '--channels', '1', '--format', 's16', '-'] },
      { bin: 'paplay', args: ['--raw', `--rate=${rate}`, '--channels=1', '--format=s16le'] },
      { bin: 'aplay', args: ['-t', 'raw', '-r', String(rate), '-c', '1', '-f', 'S16_LE', '-'] },
    ];
    for (const c of candidates) {
      try {
        const p = spawn(c.bin, c.args, { stdio: ['pipe', 'ignore', 'pipe'] });
        p.stdin.on('error', () => {});
        p.stderr?.on('data', (d) => {
          log('player_stderr', { bin: c.bin, err: d.toString().slice(0, 100) });
        });
        p.on('error', (err) => {
          log('player_error', { bin: c.bin, err: err.message });
        });
        currentBin = c.bin;
        return p;
      } catch (err) {
        log('player_spawn_error', { bin: c.bin, err: err.message });
      }
    }
    return null;
  }

  function play(id, pcm, rate = 24000) {
    if (!pcm) return;
    const buf = Buffer.isBuffer(pcm) ? pcm : Buffer.from(pcm, 'base64');
    if (!buf.length) return;

    if (currentId !== id || currentRate !== rate || !proc || proc.killed || proc.exitCode !== null) {
      stop();
      currentId = id;
      currentRate = rate;
      proc = spawnPlayer(rate);
      if (proc) log('player_started', { id, bin: currentBin, rate });
    }

    if (proc?.stdin && proc.stdin.writable) {
      try {
        proc.stdin.write(buf);
      } catch (err) {
        log('player_write_error', { id, err: err.message });
      }
    }
  }

  function end(id) {
    if (currentId === id && proc?.stdin) {
      try { proc.stdin.end(); } catch {}
    }
  }

  return { play, end, stop };
}

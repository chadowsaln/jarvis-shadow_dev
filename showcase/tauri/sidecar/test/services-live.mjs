// Optional live check of the two outside services, for a person with their own keys. Not part of `npm test`:
// `npm run test:services` (add --research to also run a paid Exa research run).
//
//   RESPAN_API_KEY=rsp-… EXA_API_KEY=… npm run test:services
//
// What it can and cannot prove: a flush that does not throw means the SDK built and sent a batch, not that Respan
// stored it (check the dashboard). A search that returns results means the Exa key, network and quota all work.
// Nothing here prints a key.
import { initRespan, startRequestTrace, endRequestTrace, recordLlmTurn, recordToolCall, flushRespan, shutdownRespan, respanStatus } from '../respan.mjs';
import { exaSearch, setExaKey } from '../exa.mjs';

const research = process.argv.includes('--research');
const out = [];
const fail = (what, why) => { out.push(`✗ ${what}: ${why}`); return false; };

const respanKey = String(process.env.RESPAN_API_KEY || '').trim();
const exaKey = String(process.env.EXA_API_KEY || '').trim();
if (!respanKey) out.push('· Respan: skipped (no RESPAN_API_KEY)');
if (!exaKey) out.push('· Exa: skipped (no EXA_API_KEY)');

let ok = true;

if (respanKey) {
  const st = await initRespan({ enabled: true, apiKey: respanKey, environment: 'development', capturePayloads: false });
  if (!st.ready) ok = fail('Respan', st.reason || st.status) && ok;
  else {
    const t = startRequestTrace({ sessionId: 'live-check', turn: 1, provider: 'jarvis', model: 'live-check' });
    recordLlmTurn(t, { provider: 'jarvis', model: 'live-check', usage: { inputTokens: 5, outputTokens: 2 }, ms: 1 });
    recordToolCall(t, { name: 'live_check', ms: 1 });
    endRequestTrace(t, { ok: true });
    const sent = await flushRespan({ timeoutMs: 8000 });
    const s = respanStatus();
    if (!sent) ok = fail('Respan', 'the SDK built but the batch was not flushed (offline?)') && ok;
    else out.push(`✓ Respan: sent 1 trace (${s.stats.spans + 1} spans). Check the dashboard; a flush cannot confirm storage.`);
  }
  await shutdownRespan({ quiet: true });
}

if (exaKey) {
  setExaKey(exaKey);
  const r = await exaSearch({ query: 'latest humanoid robotics', numResults: 3 }, {});
  if (!r.ok) ok = fail('Exa search', r.error || r.status) && ok;
  else out.push(`✓ Exa: ${r.count} result${r.count === 1 ? '' : 's'}, first: ${r.results[0]?.url ?? 'none'}`);

  if (research) {
    const { exaResearch } = await import('../exa.mjs');
    const rr = await exaResearch({ query: 'What changed in humanoid robotics this year?', effort: 'minimal', maxDurationMs: 120000 }, {});
    if (!rr.ok) ok = fail('Exa research', rr.error || rr.status) && ok;
    else out.push(`✓ Exa research: ${rr.sources.length} source${rr.sources.length === 1 ? '' : 's'}, ${String(rr.answer).length} characters of answer`);
  } else {
    out.push('· Exa research: skipped (add --research; it is billed per run)');
  }
  setExaKey(null);
}

console.log(out.join('\n'));
if (!respanKey && !exaKey) console.log('Nothing ran: set RESPAN_API_KEY and/or EXA_API_KEY.');
process.exit(ok ? 0 : 1);

// The approval sheet's own rules: what it shows, how the clock runs down, and the one answer it may send.
// The sidecar's side of the same request is tested in agentapproval.test.mjs; this is the panel's.
import assert from 'node:assert/strict';
import { loadPanelModule } from './panel-module.mjs';

const { viewOf, answerFor, argLines, formatLeft, closedWord, parseRequest, DECISION_TEXT } = await loadPanelModule('approval.js');

const at = 1_700_000_000_000;
const request = (extra = {}) => ({
  id: 'apr_1_1', tool: 'list_commitments', fingerprint: 'a'.repeat(64), args: {},
  detail: 'Read the open commitments from memory', reason: 'approval required',
  risk: 'low', permissionLevel: 'observe', expiresAt: at + 47_000, ...extra,
});

// ---------------------------------------------------------------- what it says
{
  const v = viewOf(request(), at);
  assert.equal(v.tool, 'list_commitments');
  assert.equal(v.operation, 'Read the open commitments from memory');
  assert.equal(v.permissionLabel, 'Observe');
  assert.equal(v.riskLabel, 'Low');
  // The risk word itself, so the sheet can make a high one stand out.
  assert.equal(v.risk, 'low');
  assert.equal(viewOf(request({ risk: 'high', permissionLevel: 'sensitive' }), at).risk, 'high');
  assert.equal(viewOf(request({ risk: 'spicy' }), at).risk, 'unknown');
  assert.equal(v.leftLabel, '0:47');
  assert.equal(v.canAnswer, true);
  assert.equal(v.done, false);
  assert.deepEqual(v.args, [], 'no arguments is said, not left blank');
  // Unknown words from a newer sidecar are shown as unstated, never as if they meant less risk.
  assert.equal(viewOf(request({ permissionLevel: 'root', risk: 'spicy' }), at).permissionLabel, 'Unstated');
  assert.equal(viewOf(request({ permissionLevel: 'root', risk: 'spicy' }), at).riskLabel, 'Unknown');
  assert.deepEqual(viewOf(request(), at, { decision: 'approve' }).closing, 'approved', 'an approval is the only ending the sheet says in the accent');
  assert.equal(viewOf(request(), at, { decision: 'reject' }).closing, 'rejected');
  console.log('view: passed');
}

// ---------------------------------------------------------------- the clock
{
  assert.equal(formatLeft(47_000), '0:47');
  assert.equal(formatLeft(60_000), '1:00');
  assert.equal(formatLeft(125_000), '2:05');
  assert.equal(formatLeft(-5), '0:00', 'never below zero');
  assert.equal(viewOf(request(), at + 47_000).canAnswer, false, 'at the deadline it is over');
  assert.equal(viewOf(request(), at + 47_000).expired, true);
  assert.equal(viewOf(request(), at + 60_000).leftLabel, '0:00');
  assert.equal(viewOf(request({ expiresAt: at - 1 }), at).canAnswer, false, 'a request that arrived too late is not answered');
  console.log('clock: passed');
}

// ---------------------------------------------------------------- one answer, and only for that request
{
  const r = request();
  assert.deepEqual(answerFor(r, 'approve', at), { type: 'agentcore_approval', id: 'apr_1_1', decision: 'approve', toolName: 'list_commitments', fingerprint: 'a'.repeat(64) });
  assert.deepEqual(answerFor(r, 'reject', at), { type: 'agentcore_approval', id: 'apr_1_1', decision: 'reject', toolName: 'list_commitments', fingerprint: 'a'.repeat(64) });
  assert.equal(answerFor(r, 'approve', at + 47_000), null, 'nothing is sent for a request that ran out');
  assert.equal(answerFor(r, 'maybe', at), null, 'only the two answers');
  assert.equal(answerFor({ id: 'x', tool: 'y' }, 'approve', at), null, 'and only for a request it can read');
  // Once answered here, the sheet's buttons are dead for good: a second press cannot send a second answer.
  const answered = viewOf(r, at, { decision: 'approve' });
  assert.equal(answered.canAnswer, false);
  assert.equal(answered.done, true);
  assert.equal(answered.closing, 'approved');
  assert.equal(viewOf(r, at, { closed: 'rejected' }).closing, 'rejected');
  assert.equal(viewOf(r, at, { decision: 'reject' }).closing, 'rejected');
  console.log('answer: passed');
}

// ---------------------------------------------------------------- the arguments it shows
{
  assert.deepEqual(argLines({ dir: '~/Documents/notes', pattern: 'launch' }), [{ key: 'dir', value: '~/Documents/notes' }, { key: 'pattern', value: 'launch' }]);
  assert.deepEqual(argLines(['a', 2, null]), [{ key: '0', value: 'a' }, { key: '1', value: '2' }, { key: '2', value: '—' }]);
  assert.deepEqual(argLines({ nested: { a: 1 } }), [{ key: 'nested', value: '{"a":1}' }]);
  assert.deepEqual(argLines({ text: 'x'.repeat(300) })[0].value.length, 300, 'the panel never re-clips what the sidecar sent');
  assert.equal(argLines({ a: 1, b: 2, c: 3, d: 4, e: 5, f: 6, g: 7 }).length, 6, 'six lines at most');
  assert.deepEqual(argLines(null), []);
  const v = viewOf(request({ args: { dir: '~/notes', apiKey: '[hidden]' } }), at);
  assert.deepEqual(v.argsText, ['dir: ~/notes', 'apiKey: [hidden]']);
  console.log('arguments: passed');
}

// ---------------------------------------------------------------- how it ends
{
  for (const k of ['approved', 'rejected', 'expired', 'cancelled', 'mismatch', 'unknown', 'failed']) assert.ok(DECISION_TEXT[k], `${k} has words`);
  assert.equal(closedWord({ kind: 'approval_closed', why: 'approved' }), 'approved');
  assert.equal(closedWord({ why: 'APPROVED' }), 'approved', 'any case');
  assert.equal(closedWord({ why: 'the user rejected it' }), 'unknown', 'a sentence is not a word it knows');
  assert.equal(closedWord(null), 'unknown');
  console.log('ending: passed');
}

// ---------------------------------------------------------------- a request it cannot read is never answered
{
  assert.equal(parseRequest(undefined), null);
  assert.equal(parseRequest({}), null);
  assert.equal(parseRequest({ id: 'i', tool: 't', expiresAt: 'soon' }), null, 'an expiry that is not a time');
  assert.equal(parseRequest({ id: '  ', tool: 't', expiresAt: at }), null, 'a blank id');
  assert.equal(parseRequest({ id: 'i', tool: 't', expiresAt: at }).fingerprint, '', 'no fingerprint is an empty echo, not a guess');
  assert.equal(viewOf({ id: 'i' }, at), null);
  console.log('unreadable: passed');
}

// ---------------------------------------------------------------- it goes away once it is answered
// Regression: the answered sheet stayed on screen until another request replaced it.
{
  const fs = await import('node:fs/promises');
  const url = new URL('../../../panel/panel.js', import.meta.url);
  const src = await fs.readFile(url, 'utf8');
  assert.match(src, /function dismissApproval\(\)/, 'the panel can put the sheet away');
  assert.match(src, /approval = null;\s*drawApproval\(\);/, 'putting it away clears the answer and hides the sheet');
  assert.match(src, /else approveHide = setTimeout\(dismissApproval, 2600\)/, 'an answered sheet leaves by itself');
  assert.match(src, /\$\('approve'\)\.addEventListener\('pointerdown'/, 'a click on it also puts it away');
  assert.match(src, /if \(!v \|\| !v\.canAnswer\) dismissApproval\(\)/, 'but only once it cannot be answered any more');
  assert.match(src, /clearTimeout\(approveHide\)/, 'a new request or a redraw cancels the timer');
  console.log('dismissal: passed');
}

console.log('approval panel: passed');

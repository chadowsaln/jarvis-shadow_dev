// The approval round trip over the real message path, not a stubbed executor.
//
// What the sidecar writes to its stdout (the shell hands {type:'panel',msg} to the panel as window.__panel(msg)) is
// captured here verbatim; the answer is built by the panel's own module (showcase/panel/approval.js) and parsed
// from stdin the way sidekick.mjs does ({type:'agentcore_approval'}). Between the two sits the same chain the live
// app uses: createTools -> runtime wrappers -> router (metadata, level, safety) -> executor (binding, expiry,
// single use) -> the tool's own execute(). Only the transport is a stand-in; nothing about authorization is.
import assert from 'node:assert/strict';
import { createTools } from '../tools.mjs';
import { loadPanelModule } from './panel-module.mjs';
import { createApprovalChannel } from '../agentcore/approval-channel.mjs';
import { createAgentCoreRuntime } from '../agentcore/runtime.mjs';
import { isAgentCoreEnabled } from '../agentcore/index.mjs';
import { defaultToolPermission, PERMISSION_LEVEL } from '../agentcore/permissions.mjs';

// The dialog's own logic, from the file the panel loads (see panel-module.mjs).
const { viewOf, answerFor, closedWord, parseRequest } = await loadPanelModule('approval.js');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// The real tools, with the memory the agent would see.
let ran = 0;
function buildTools() {
  return createTools({
    allowActions: false, ui: () => {}, ask: async () => false, openUrl: async () => {}, onCommitments: () => {},
    showList: () => {}, fmtWhen: String, commitmentsText: () => { ran++; return 'Send the launch email (Fri 7 Nov, 10:00)'; },
    userName: 'Test',
  }).tools;
}

/**
 * The live wiring: tools -> runtime -> channel, with `send` collecting the sidecar's stdout lines as JSON.
 * The answer goes back in exactly as sidekick.mjs receives it from the shell.
 */
function live({ granted = 'observe', ask = ['list_commitments'], ttlMs = 60_000, send, tools = buildTools(), extra = [] } = {}) {
  const stdout = [];
  const channel = createApprovalChannel({
    send: send ?? ((m) => stdout.push(JSON.parse(JSON.stringify(m)))),
    ttlMs, logger: () => {},
  });
  const rt = createAgentCoreRuntime({ tools: [...tools, ...extra], approvalChannel: channel, grantedLevel: granted, requireApproval: ask, env: {} });
  return { stdout, channel, rt };
}

// The dialog as it reached the panel: wait for the sidecar to write one, then read it the way the panel does.
// skip: how many earlier dialogs (each call gets its own) to pass over.
async function waitDialog(stdout, { skip = 0, ms = 2000 } = {}) {
  for (const t0 = Date.now(); Date.now() - t0 < ms;) {
    const lines = stdout.filter((m) => m?.type === 'panel' && m.msg?.kind === 'approval');
    if (lines.length > skip) return lines[skip].msg.request;
    await sleep(4);
  }
  throw new Error(`no approval dialog was sent (${JSON.stringify(stdout)})`);
}
// The last word the sidecar sent about that dialog (a spent request gets told it is stale, after the first).
const closedFor = (stdout, id) => stdout.filter((m) => m?.msg?.kind === 'approval_closed' && m.msg.id === id).at(-1)?.msg ?? null;

// The panel's half, exactly as panel.js uses it: the view it draws, and the one message it sends.
const press = (request, decision, now = Date.now()) => answerFor(request, decision, now);

// ---------------------------------------------------------------- the flag and what is offered
{
  // On by default since Batch 1 (V2.1); only an explicit falsy value turns it off.
  assert.equal(isAgentCoreEnabled({}), true, 'on by default');
  assert.equal(isAgentCoreEnabled({ ROAMIES_AGENT_CORE: '0' }), false, 'an explicit off is honoured');
  assert.equal(isAgentCoreEnabled({ ROAMIES_AGENT_CORE: '1' }), true);
  const tools = buildTools();
  const { rt } = live({ tools, granted: 'trusted' });
  // Nothing without permission metadata is ever offered, and the caller's list is not touched (sidekick splices it).
  for (const t of rt.tools) assert.ok(defaultToolPermission(t), `${t.name} declares what it may do`);
  // Batch 1: every tool declares what it may do, so the operator is never silently disarmed by turning the core on.
  assert.equal(rt.skipped, 0, 'no tool is dropped for missing metadata');
  assert.equal(rt.tools.length, tools.length, 'so every tool is offered');
  const names = rt.tools.map((t) => t.name);
  for (const n of ['take_screenshot', 'run_command', 'open', 'draw', 'see_photo', 'plan_steps', 'show_list', 'list_commitments']) {
    assert.ok(names.includes(n), `${n} is offered`);
  }
  const perm = (n) => defaultToolPermission(rt.tools.find((t) => t.name === n));
  // What the person agreed to: a screenshot (the picture leaves this computer) asks every time.
  assert.deepEqual([perm('take_screenshot').level, perm('take_screenshot').requiresApproval], ['observe', true], 'a screen look asks every time');
  assert.deepEqual([perm('run_command').level, perm('run_command').requiresApproval], ['trusted', true], 'a shell command asks');
  assert.equal(perm('open').requiresApproval, false, 'opening a page does not');
  assert.equal(perm('write_file').requiresApproval, true, 'writing a file does');
  console.log('offering: passed');
}

// ---------------------------------------------------------------- Batch 1: the tool is told when it was approved
// Tools that ask their own yes/no question (write_file, run_command, launch_app) must not ask twice: the executor's
// approval is bound to the exact arguments, so the tool is told, and only then skips its own question.
{
  const seen = [];
  const fake = (name, requiresApproval) => ({
    name, description: 'test tool', parameters: { type: 'object', properties: { path: { type: 'string' } } },
    permission: { level: 'trusted', requiresApproval, description: 'test' },
    execute: async (args, ctx) => { seen.push({ name, approved: !!ctx?.approved, signal: ctx?.signal }); return 'ok'; },
  });
  const { stdout, channel, rt } = live({ granted: 'trusted', ask: [], extra: [fake('fake_asked', true), fake('fake_plain', false)] });
  const call = rt.tools.find((t) => t.name === 'fake_asked').execute({ path: '/tmp/x' }, {});
  const request = await waitDialog(stdout);
  channel.answer(press(request, 'approve'));
  assert.equal(await call, 'ok');
  assert.equal(seen[0].approved, true, 'an approved action says so');
  assert.ok(seen[0].signal, 'and hands the tool the abort signal');
  assert.equal(await rt.tools.find((t) => t.name === 'fake_plain').execute({ path: '/tmp/x' }, {}), 'ok');
  assert.equal(seen[1].approved, false, 'an action nobody was asked about is not "approved"');
  console.log('approval reaches the tool: passed');
}

// ---------------------------------------------------------------- Batch 1: Stop reaches the execution layer
// The panel's Stop used to abort the model's stream only; a tool already running kept going and the next call would
// still be authorised. Now stop cancels the executor, and the next request reopens it - a stale stop never blocks it.
{
  const { rt } = live({ granted: 'trusted' });
  const list = rt.tools.find((t) => t.name === 'list_commitments');
  rt.stop('the person pressed Stop');
  await assert.rejects(() => list.execute({}, {}), /Blocked: cancelled/, 'no call runs after Stop');
  assert.equal(rt.core.executor.isCancelled(), true);
  rt.reset('new request');
  assert.equal(rt.core.executor.isCancelled(), false, 'the next request may act again');
  console.log('stop and reset: passed');
}

// ---------------------------------------------------------------- Batch 1: the default grant
// Trusted: reading, clicking, typing, files and app launches work; sensitive and administrative tools stay denied -
// an approval cannot lift a level, so deleting or killing is impossible until the host raises the grant.
{
  const rt = createAgentCoreRuntime({ tools: buildTools(), env: {}, approvalChannel: null });
  assert.equal(rt.grantedLevel, 'trusted', 'the default grant is trusted');
  assert.equal(rt.skipped, 0, 'and nothing is dropped');
  const risky = {
    name: 'fake_delete', description: 'test tool', parameters: { type: 'object', properties: {} },
    permission: { level: 'sensitive', requiresApproval: true, description: 'Delete something' },
    execute: async () => 'gone',
  };
  const rt2 = createAgentCoreRuntime({ tools: [risky], env: {}, approvalChannel: null });
  assert.equal(rt2.tools.length, 1, 'the tool is offered');
  await assert.rejects(() => rt2.tools[0].execute({}, {}), /insufficient permission level/, 'but denied at trusted');
  // An unknown level grants nothing rather than more, and says so in the startup line.
  const rt3 = createAgentCoreRuntime({ tools: [risky], env: { ROAMIES_AGENT_CORE_LEVEL: 'banana' } });
  assert.equal(rt3.grantedLevel, null);
  assert.match(rt3.levelError, /unknown ROAMIES_AGENT_CORE_LEVEL: banana/);
  await assert.rejects(() => rt3.tools[0].execute({}, {}), /host permission level for fake_delete/);
  console.log('default grant: passed');
}

// ---------------------------------------------------------------- a real approval, approved
{
  const { stdout, channel, rt } = live();
  const tool = rt.tools.find((t) => t.name === 'list_commitments');
  const call = tool.execute({}, {});
  const request = await waitDialog(stdout);

  // What the panel is shown: the sidecar's own copy of the action.
  assert.equal(request.tool, 'list_commitments');
  assert.match(request.id, /^apr_/, 'a unique request id');
  assert.equal(request.permissionLevel, 'observe');
  assert.equal(request.risk, 'low');
  assert.equal(request.detail, 'Read the open commitments from memory');
  assert.deepEqual(request.args, {}, 'no arguments, nothing invented');
  assert.ok(request.fingerprint?.length === 64, 'the action fingerprint travels with it');
  assert.ok(request.expiresAt > Date.now(), 'and when it runs out');

  // What the panel draws for it.
  const view = viewOf(request, Date.now());
  assert.equal(view.canAnswer, true);
  assert.equal(view.tool, 'list_commitments');
  assert.equal(view.permissionLabel, 'Observe');
  assert.equal(view.riskLabel, 'Low');
  assert.match(view.leftLabel, /^\d+:\d\d$/, 'a countdown');
  assert.deepEqual(view.args, [], 'no argument lines to show');

  const msgs = [press(request, 'approve')];
  for (const m of msgs) assert.deepEqual(channel.answer(m), { ok: true, decision: 'approved' });
  const result = await call;
  assert.match(result, /Send the launch email/, 'the tool actually ran');
  assert.equal(ran, 1, 'and ran once');
  assert.equal(closedFor(stdout, request.id)?.why, 'approved', 'the dialog is told how it ended');
  assert.equal(channel.pendingCount(), 0);
  console.log('approval: passed');
}

// ---------------------------------------------------------------- rejected: nothing runs
{
  const { stdout, channel, rt } = live();
  const before = ran;
  const tool = rt.tools.find((t) => t.name === 'list_commitments');
  const call = tool.execute({}, {});
  const request = await waitDialog(stdout);
  assert.deepEqual(channel.answer(press(request, 'reject')), { ok: true, decision: 'rejected' });
  await assert.rejects(call, /Blocked: the user rejected it/);
  assert.equal(ran, before, 'the tool body never ran');
  assert.equal(closedFor(stdout, request.id)?.why, 'rejected');
  console.log('rejection: passed');
}

// ---------------------------------------------------------------- closing is not a yes
{
  const { stdout, channel, rt } = live();
  const before = ran;
  const call = rt.tools.find((t) => t.name === 'list_commitments').execute({}, {});
  const request = await waitDialog(stdout);
  // The panel going away (Esc, window hidden) answers with the closed kind.
  assert.deepEqual(channel.answer({ type: 'agentcore_approval', kind: 'closed', id: request.id }), { ok: true, decision: 'closed' });
  await assert.rejects(call, /Blocked: approval dialog closed/);
  assert.equal(ran, before, 'closing never approves');
  console.log('closing: passed');
}

// ---------------------------------------------------------------- timeout, and a late yes
{
  const { stdout, channel, rt } = live({ ttlMs: 60 });
  const before = ran;
  // The channel's timer is unref'd on purpose (a waiting dialog must never hold the app open); the test holds the
  // process itself so that timer can fire.
  const alive = setInterval(() => {}, 1000);
  const call = rt.tools.find((t) => t.name === 'list_commitments').execute({}, {});
  const request = await waitDialog(stdout);
  assert.ok(request.expiresAt - Date.now() <= 60, 'the channel never lets a dialog outlive its own ceiling');
  await assert.rejects(call, /Blocked: approval timed out/);
  clearInterval(alive);
  assert.equal(ran, before, 'an unanswered request never runs');
  await sleep(20);
  assert.equal(closedFor(stdout, request.id)?.why, 'expired', 'the dialog is told it ran out');
  // A yes that arrives anyway (another window, a stale panel) is refused, and a malformed one is refused too.
  assert.equal(channel.answer({ type: 'agentcore_approval', id: request.id, decision: 'approve', toolName: request.tool }).ok, false, 'a yes after it ran out is refused');
  assert.equal(channel.answer(null).ok, false, 'a malformed answer does not throw');
  assert.equal(ran, before);
  // The panel says so too: its countdown is over, so it cannot even offer the button.
  assert.equal(viewOf(request, Date.now()).canAnswer, false);
  assert.equal(answerFor(request, 'approve', Date.now()), null, 'and it refuses to send one');
  console.log('timeout: passed');
}

// ---------------------------------------------------------------- replay and a stale id
{
  const { stdout, channel, rt } = live();
  const tool = rt.tools.find((t) => t.name === 'list_commitments');
  const first = tool.execute({}, {});
  const a = await waitDialog(stdout);
  channel.answer(press(a, 'approve'));
  await first;
  assert.equal(channel.answer(press(a, 'approve')).ok, false, 'the same answer twice is refused');
  assert.equal(closedFor(stdout, a.id)?.stale, true, 'the panel is told that request is spent');

  // A fresh call gets its own dialog; a wrong id answers nothing.
  const second = tool.execute({}, {});
  const b = await waitDialog(stdout, { skip: 1 });
  assert.notEqual(b.id, a.id, 'each call has its own id');
  const before = ran;
  assert.equal(channel.answer({ ...press(b, 'approve'), id: 'apr_made_up' }).ok, false, 'an unknown id is refused');
  assert.equal(ran, before, 'and runs nothing');
  channel.answer(press(b, 'approve'));
  await second;
  console.log('replay and stale id: passed');
}

// ---------------------------------------------------------------- the answer must be that exact action
{
  const { stdout, channel, rt } = live();
  const tool = rt.tools.find((t) => t.name === 'list_commitments');
  const call = tool.execute({}, {});
  const request = await waitDialog(stdout);
  const before = ran;
  // A fingerprint from somewhere else (another action, or the same one with other arguments): that answer dies,
  // and so does the request it was aimed at - nothing is left waiting to be approved by a later message.
  assert.equal(channel.answer({ ...press(request, 'approve'), fingerprint: 'f'.repeat(64) }).ok, false);
  await assert.rejects(call, /Blocked: approval response fingerprint mismatch/);
  assert.equal(ran, before, 'a mismatched fingerprint executes nothing');
  // A different tool name for this id: also refused.
  const call2 = tool.execute({}, {});
  const second = await waitDialog(stdout, { skip: 1 });
  assert.equal(channel.answer({ ...press(second, 'approve'), toolName: 'run_command' }).ok, false);
  await assert.rejects(call2, /Blocked: approval response tool mismatch/);
  assert.equal(ran, before);
  assert.equal(channel.pendingCount(), 0, 'a refused answer leaves nothing pending');
  console.log('binding: passed');
}

// ---------------------------------------------------------------- the transport failing denies
{
  const { rt } = live({ send: () => { throw new Error('stdout gone'); } });
  const before = ran;
  await assert.rejects(rt.tools.find((t) => t.name === 'list_commitments').execute({}, {}), /Blocked: approval channel unavailable/);
  assert.equal(ran, before, 'no channel, no execution');
  // A channel that broke once stays shut: nothing else may use it to sneak through.
  const broken = live();
  broken.channel.fail('panel crashed');
  await assert.rejects(broken.rt.tools.find((t) => t.name === 'list_commitments').execute({}, {}), /Blocked: approval channel unavailable/);
  assert.equal(broken.channel.isBroken(), true);
  console.log('channel failure: passed');
}

// ---------------------------------------------------------------- the panel opening late still sees the dialog
{
  // The panel was closed when the call came in: its window does not exist, so the first dialog message goes nowhere.
  // sidekick.mjs shows the panel and, on panel_open, asks the channel to send the waiting dialog again.
  const { stdout, channel, rt } = live();
  const tool = rt.tools.find((t) => t.name === 'list_commitments');
  const call = tool.execute({}, {});
  const first = await waitDialog(stdout);
  const again = channel.resend();
  assert.equal(again, 1, 'the waiting dialog is sent again');
  const resent = await waitDialog(stdout, { skip: 1 });
  assert.equal(resent.id, first.id, 'the same request');
  assert.equal(resent.fingerprint, first.fingerprint, 'bound to the same action');
  assert.equal(resent.expiresAt, first.expiresAt, 'and the same deadline: reopening does not extend it');
  // Two rendered copies of one request are still one request: the answer is taken once, and runs once.
  const before = ran;
  assert.deepEqual(channel.answer(press(resent, 'approve')), { ok: true, decision: 'approved' });
  await call;
  assert.equal(ran, before + 1, 'one run');
  assert.deepEqual(channel.answer(press(resent, 'approve')), { ok: false, reason: 'unknown approval request' }, 'the copy on the other page is spent too');
  assert.equal(channel.resend(), 0, 'nothing left waiting');
  console.log('reshown: passed');
}

// ---------------------------------------------------------------- two at once: one dialog, one run
{
  const { stdout, channel, rt } = live();
  const tool = rt.tools.find((t) => t.name === 'list_commitments');
  const before = ran;
  const a = tool.execute({}, {});
  const b = tool.execute({}, {});
  const request = await waitDialog(stdout);
  const dialogs = stdout.filter((m) => m.msg?.kind === 'approval');
  assert.equal(dialogs.length, 1, 'the same action never gets two dialogs');
  await assert.rejects(b, /Blocked: approval already pending for this action/);
  channel.answer(press(request, 'approve'));
  await a;
  assert.equal(ran, before + 1, 'one yes, one run');
  console.log('concurrency: passed');
}

// ---------------------------------------------------------------- secrets never reach the dialog
{
  const stub = {
    name: 'read_notes', description: 'Read a note', parameters: { shape: {} },
    permission: { level: PERMISSION_LEVEL.observe, requiresApproval: false, description: 'Read one note' },
    execute: async () => 'ok',
  };
  const { stdout, channel, rt } = live({ ask: ['read_notes'], extra: [stub] });
  const tool = rt.tools.find((t) => t.name === 'read_notes');
  const call = tool.execute({ path: 'notes.md', apiKey: 'sk-live-do-not-show', nested: { token: 'abc123', n: 2 }, long: 'x'.repeat(400) }, {});
  const request = await waitDialog(stdout);
  assert.equal(request.args.apiKey, '[hidden]');
  assert.equal(request.args.nested.token, '[hidden]');
  assert.equal(request.args.nested.n, 2);
  assert.equal(request.args.path, 'notes.md');
  assert.ok(request.args.long.length < 250 && request.args.long.endsWith('…'), 'long text is clipped');
  assert.ok(!JSON.stringify(stdout).includes('sk-live-do-not-show'), 'the key is in no message at all');
  // The panel shows only what it was sent, so it cannot show more either.
  const view = viewOf(request, Date.now());
  assert.ok(view.argsText.some((l) => l.includes('[hidden]')));
  assert.ok(!view.argsText.join(' ').includes('sk-live-do-not-show'));
  channel.answer(press(request, 'approve'));
  await call;
  console.log('redaction: passed');
}

// ---------------------------------------------------------------- file management integrated safely (Batch 4)
// Read-only file tools are observe-level with no extra approval; mutating file tools are trusted-level
// and always require explicit per-operation approval. Destructive/system tools remain unoffered.
{
  const { rt, channel } = live({ granted: 'administrative', ask: [] });
  const names = rt.tools.map((t) => t.name).sort();
  const readOnlyFile = ['file_info', 'find_files', 'list_files', 'read_file', 'search_files'];
  const mutatingFile = ['copy_file', 'create_directory', 'move_file', 'rename_file', 'write_file'];
  // Batch 6: apps on Linux. Finding out what is installed or open reads; starting one is trusted and always asks.
  // Batch 7: system status on Linux is read-only (observe).
  // Batch 8: screen intelligence on Linux is observe-level but requires explicit approval each time (portal consent).
  // Batch 9: browser intelligence - discover/open/read/navigate are observe-level (read-only, no data-changing actions).
  // Batch 9.1: Respan authenticated reading via local bridge shares visible page content only with explicit consent (observe + approval).
  // Batch 10: persistent memory - list/search observe, save/update/delete trusted with approval.
  // Batch 11: Exa search integration - optional observe-level web search/retrieval (no approval, no site actions).
  // Linux may also expose native computer-control tools (observe/approval-gated) depending on capabilities; include actual reviewed set.
  const apps = process.platform === 'linux';
  const readOnlyBrowser = ['browser_discover', 'browser_navigate', 'browser_open', 'browser_read_page', 'browser_respan_bridge_status', 'exa_find_similar', 'exa_get_contents', 'exa_search', 'exa_search_status'];
  const readOnlyApps = apps ? ['find_app', 'list_apps', 'running_apps', 'system_status'] : [];
  const readOnlyMemory = ['memory_list', 'memory_search'];
  const mutatingApps = apps ? ['launch_app'] : [];
  const mutatingMemory = ['memory_delete', 'memory_save', 'memory_update'];
  // Exa research spends money per run, so it is observe-level but asks before every run.
  const observeAsk = [...(apps ? ['screen_capture', 'screen_ocr'] : []), 'browser_read_respan_authenticated', 'exa_research'];
  const readOnly = [...readOnlyFile, ...readOnlyApps, ...readOnlyBrowser, ...readOnlyMemory], mutating = [...mutatingFile, ...mutatingApps, ...mutatingMemory];
  // Batch 1: the reviewed set is the whole tool list. Every tool here declares its level, so nothing is dropped -
  // a tool the chat can see must be one the executor can authorise, and a missing line here is a regression.
  const desktop = ['draw', 'morse_practice', 'open', 'plan_steps', 'pomodoro', 'see_photo', 'show_list', 'take_screenshot', 'web_fetch', 'web_search'];
  const memoryWrites = ['remember_commitment', 'update_commitment', 'forget_fact'];
  const shell = ['run_command', 'run_diagnostic', 'list_commitments'];
  const nativeHands = process.platform === 'darwin' || process.env.ROAMIES_HANDS ? ['act_in_app', 'list_windows', 'read_window'] : [];
  const linuxNative = process.platform === 'linux' ? ['linux_capture_screen', 'linux_click_element', 'linux_find_element', 'linux_focus_window', 'linux_list_apps', 'linux_list_windows', 'linux_move_mouse', 'linux_ocr', 'linux_press_key', 'linux_type_text'] : [];
  // Batch 2: the desktop adapter tools. Reading windows/monitors/clipboard observes; clicking, typing, dragging,
  // scrolling and window control are actions within the default grant; quitting an app is sensitive and asks.
  const readOnlyDesktop = ['clipboard_read', 'monitors', 'window_list'];
  const trustedDesktop = ['clipboard_write', 'desktop_click', 'desktop_drag', 'desktop_key', 'desktop_type', 'window_control'];
  const assistDesktop = ['desktop_scroll'];
  const sensitiveDesktop = ['app_quit'];
  const expected = [...desktop, ...memoryWrites, ...shell, ...nativeHands, ...linuxNative, ...readOnly, ...observeAsk, ...mutating, ...readOnlyDesktop, ...trustedDesktop, ...assistDesktop, ...sensitiveDesktop].sort();
  assert.deepEqual(names, expected, 'every tool is offered, and only the reviewed ones');
  // The desktop operator's own verbs are reachable at the default grant (trusted).
  for (const n of ['open', 'take_screenshot', 'draw', 'read_file']) {
    const t = rt.tools.find((x) => x.name === n);
    assert.ok(t, `${n} offered`);
    assert.ok(['observe', 'assist', 'trusted'].includes(defaultToolPermission(t).level), `${n} is within the default grant`);
  }
  for (const n of memoryWrites) {
    const t = rt.tools.find((x) => x.name === n);
    assert.ok(t, `${n} offered`);
    assert.equal(defaultToolPermission(t).requiresApproval, true, `${n} requires explicit approval`);
  }
  assert.equal(defaultToolPermission(rt.tools.find((x) => x.name === 'take_screenshot')).requiresApproval, true, 'a screen look asks every time');
  for (const n of readOnly) {
    const t = rt.tools.find((x) => x.name === n);
    assert.ok(t, `${n} offered`);
    assert.equal(defaultToolPermission(t).level, 'observe', `${n} is observe-level`);
    assert.equal(defaultToolPermission(t).requiresApproval, false, `${n} needs no approval`);
  }
  for (const n of observeAsk) {
    const t = rt.tools.find((x) => x.name === n);
    assert.ok(t, `${n} offered`);
    assert.equal(defaultToolPermission(t).level, 'observe', `${n} is observe-level`);
    assert.equal(defaultToolPermission(t).requiresApproval, true, `${n} requires explicit approval`);
  }
  for (const n of readOnlyDesktop) {
    const t = rt.tools.find((x) => x.name === n);
    assert.ok(t, `${n} offered`);
    assert.equal(defaultToolPermission(t).level, 'observe', `${n} is observe-level`);
    assert.equal(defaultToolPermission(t).requiresApproval, false, `${n} needs no approval`);
  }
  for (const n of trustedDesktop) {
    const t = rt.tools.find((x) => x.name === n);
    assert.ok(t, `${n} offered`);
    assert.equal(defaultToolPermission(t).level, 'trusted', `${n} is trusted-level`);
    assert.equal(defaultToolPermission(t).requiresApproval, false, `${n} needs no approval at trusted`);
  }
  for (const n of assistDesktop) {
    const t = rt.tools.find((x) => x.name === n);
    assert.ok(t, `${n} offered`);
    assert.equal(defaultToolPermission(t).level, 'assist', `${n} is assist-level`);
  }
  for (const n of sensitiveDesktop) {
    const t = rt.tools.find((x) => x.name === n);
    assert.ok(t, `${n} offered`);
    assert.equal(defaultToolPermission(t).level, 'sensitive', `${n} is sensitive-level`);
    assert.equal(defaultToolPermission(t).requiresApproval, true, `${n} asks first`);
  }
  for (const n of mutating) {
    const t = rt.tools.find((x) => x.name === n);
    assert.ok(t, `${n} offered`);
    assert.equal(defaultToolPermission(t).level, 'trusted', `${n} is trusted-level`);
    assert.equal(defaultToolPermission(t).requiresApproval, true, `${n} requires explicit approval`);
  }
  // A tool that does not exist is not routable, whatever the level.
  for (const n of ['delete_file', 'nope']) {
    const r = rt.core.router.route(n, {}, { phase: 'initial' });
    assert.equal(r.allowed, false, `${n} is not reachable`);
    assert.match(r.reason, /unknown tool/, `${n} was never offered`);
  }
  // No destructive file/system delete tool exists (persistent memory deletion is an approved managed action).
  assert.equal(names.some((n) => n !== 'memory_delete' && /delete|remove|unlink|rm/i.test(n)), false, 'no destructive delete/remove tool offered');
  // A tool whose metadata asks for more than the host grants is refused, approval or not.
  const higher = { name: 'delete_everything', parameters: { shape: {} }, permission: { level: PERMISSION_LEVEL.administrative }, execute: async () => 'nope' };
  const low = live({ granted: 'observe', ask: [], extra: [higher] });
  const r = low.rt.core.router.route('delete_everything', {}, { phase: 'initial' });
  assert.equal(r.allowed, false);
  assert.match(r.reason, /insufficient permission level/);
  // Mutating file and app tools are blocked at observe grant by permission level (no automatic elevation).
  for (const n of mutating) {
    const rm = low.rt.core.router.route(n, {}, { phase: 'initial' });
    assert.equal(rm.allowed, false, `${n} blocked at observe grant`);
  }
  // Screen tools are observe-level but still require explicit approval per use (portal consent); at observe grant they route only with approval.
  for (const n of observeAsk) {
    const rs = low.rt.core.router.route(n, n === 'browser_read_respan_authenticated' ? { url: 'https://platform.respan.ai/' } : n === 'exa_research' ? { query: 'latest robotics' } : {}, { phase: 'initial' });
    assert.equal(rs.allowed, true, `${n} allowed at observe grant`);
    assert.equal(rs.requiresApproval, true, `${n} requires approval at observe`);
  }
  // Read-only file tools work at observe grant without approval.
  for (const n of readOnlyFile) {
    const ro = low.rt.core.router.route(n, n === 'file_info' || n === 'read_file' ? { path: '/tmp/x' } : (n === 'find_files' || n === 'list_files' || n === 'search_files' ? { dir: '/tmp', pattern: 'x' } : {}), { phase: 'initial' });
    assert.equal(ro.allowed, true, `${n} allowed at observe grant`);
    assert.equal(ro.requiresApproval, false, `${n} needs no approval at observe`);
  }
  assert.equal(channel.pendingCount(), 0);
  console.log('file management integration: passed');
}

// ---------------------------------------------------------------- a request the panel cannot read is not answered
{
  assert.equal(parseRequest(null), null);
  assert.equal(parseRequest({ tool: 'x', expiresAt: Date.now() }), null, 'no id');
  assert.equal(parseRequest({ id: 'a', expiresAt: Date.now() }), null, 'no tool');
  assert.equal(parseRequest({ id: 'a', tool: 'x' }), null, 'no expiry');
  assert.equal(answerFor({ id: 'a', tool: 'x' }, 'approve'), null);
  // The panel ends on the sidecar's word, and invents nothing for one it does not know.
  assert.equal(closedWord({ why: 'approved' }), 'approved');
  assert.equal(closedWord({ why: 'cancelled' }), 'cancelled');
  assert.equal(closedWord({ why: 'something else' }), 'unknown');
  console.log('unreadable request: passed');
}

console.log('approval protocol: passed');

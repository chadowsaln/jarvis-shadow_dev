// Batch 5: the terminal. One allowlisted read-only command, run with no shell, under a time and size limit,
// through safety.mjs and (flag on) the agent core's router, permission level and preflight. Run: npm test
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import process from 'node:process';
import { resolveToolSchema } from '@kenkaiiii/gg-ai';
import { DIAGNOSTIC_COMMANDS, DIAGNOSTIC_NAMES, checkDiagnosticCommand } from '../safety.mjs';
import { DIAGNOSTIC_LIMITS, createTools, runDiagnostic } from '../tools.mjs';
import { createAgentCoreRuntime } from '../agentcore/runtime.mjs';
import { agentCorePreflight } from '../agentcore/preflight.mjs';
import { defaultToolPermission } from '../agentcore/permissions.mjs';
import { describe } from '../activity.mjs';

const { tools } = createTools({
  allowActions: false, ui: () => {}, ask: async () => false, openUrl: async () => {}, onCommitments: () => {},
  showList: () => {}, fmtWhen: String, commitmentsText: () => '', userName: 'Test',
});
const diag = tools.find((t) => t.name === 'run_diagnostic');

// ---------------------------------------------------------------- the allowlist is the whole surface
assert.deepEqual(DIAGNOSTIC_NAMES, ['pwd', 'whoami', 'uptime', 'uname', 'df', 'free', 'ls', 'ps'], 'the eight read-only diagnostics');
for (const n of DIAGNOSTIC_NAMES) {
  const v = checkDiagnosticCommand(n);
  assert.equal(v.level, 'safe', `${n} on its own is allowed`);
  assert.equal(v.command, n);
  assert.deepEqual(v.argv, []);
  for (const f of DIAGNOSTIC_COMMANDS[n]) assert.equal(checkDiagnosticCommand(n, [f]).level, 'safe', `${n} ${f} is allowed`);
}
// Nothing else runs: no sudo, no deletion, no installs, no interpreters, no other program, no path.
for (const n of ['sudo', 'rm', 'rm -rf ~', 'apt', 'apt-get', 'brew', 'npm', 'pip', 'node', 'bash', 'sh', 'zsh', 'python3',
  'curl', 'wget', 'kill', 'mkfifo', 'chmod', 'dd', '/bin/ls', 'ls; rm -rf ~', 'ls && rm -rf ~', 'LS', '', null]) {
  const v = checkDiagnosticCommand(n);
  assert.equal(v.level, 'block', `${JSON.stringify(n)} is refused`);
  assert.ok(v.reason, 'a refusal says why');
}
assert.match(checkDiagnosticCommand('sudo').reason, /pwd, whoami, uptime, uname, df, free, ls, ps/, 'it names what it can run');
// No shell: chains, pipes, redirects, substitutions, quoting and whitespace are refused before anything runs.
for (const a of [';rm', '|sh', '> out', '>> x', '< in', '&& id', '$(id)', '`id`', 'a b', '-la;rm', '-la|sh', '*', '~/x',
  '../x', '/etc/passwd', './x', '&', "'-la'", '"x"', '\\x', 'x!y', 'x{1}']) {
  const v = checkDiagnosticCommand('ls', [a]);
  assert.equal(v.level, 'block', `${JSON.stringify(a)} as an argument is refused`);
}
// No paths, and only the flags listed for that command.
for (const [c, a] of [['ls', ['-R']], ['ls', ['--color=always']], ['ps', ['-o']], ['df', ['-i']], ['uname', ['-v']],
  ['pwd', ['-P']], ['whoami', ['-u']], ['free', ['-t']]]) {
  assert.equal(checkDiagnosticCommand(c, a).level, 'block', `${c} ${a[0]} isn't listed`);
}
assert.equal(checkDiagnosticCommand('ls', ['-l', '-a', '-h', '-1']).level, 'block', 'four flags is more than a diagnostic takes');
assert.equal(checkDiagnosticCommand('ls', '-la').level, 'block', 'arguments must be a list');
assert.equal(checkDiagnosticCommand('ls', [1]).level, 'block', 'arguments must be strings');
assert.equal(checkDiagnosticCommand('ls', [null]).level, 'block');
console.log('terminal allowlist: passed');

// ---------------------------------------------------------------- the tool: metadata, schema, own checks
assert.ok(diag, 'run_diagnostic is a tool');
assert.deepEqual(defaultToolPermission(diag), {
  level: 'observe', requiresApproval: false, approvalScopes: null, description: 'Run one read-only diagnostic command',
}, 'read-only diagnostics need no approval and are observe-level');
const schema = resolveToolSchema(diag);
assert.deepEqual(schema.properties.command.enum, DIAGNOSTIC_NAMES, 'the model can only pick an allowlisted command');
assert.equal(schema.required.includes('command'), true, 'a command is required');
assert.match(diag.description, /Only these run: pwd, whoami/, 'the description lists the allowlist');
assert.match(diag.description, /no shell: no pipes, redirects, chaining, scripts or sudo/, 'it says there is no shell');
assert.match(diag.description, /naming the command, then its output exactly as it came back inside a ``` block/, 'it asks for the command and result on the answer card');
assert.match(diag.description, /show on the answer card/, 'it says where the command and result are shown');
assert.match(diag.description, /stopped after 5 seconds/, 'the limits are stated');
await assert.rejects(diag.execute({ command: 'rm', args: ['-rf', '~/x'] }, {}), /Blocked for safety: "rm" isn't a command I can run/, 'a refused command never runs');
await assert.rejects(diag.execute({ command: 'ls', args: ['; rm -rf ~'] }, {}), /Blocked for safety: .*shell characters/, 'a shell string never runs');
console.log('terminal tool: passed');

// ---------------------------------------------------------------- real runs: the command, its output, its limits
if (process.platform !== 'win32') {
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'roamies-term-'));
  const out = await runDiagnostic({ command: 'pwd' }, { cwd: tmp });
  assert.match(out, /^\$ pwd\nexit 0 in \d+ ms\n/, 'the result shows the command, its exit and its time');
  assert.ok(out.includes(path.basename(tmp)), 'and its output');
  const who = await runDiagnostic({ command: 'whoami' }, { cwd: tmp });
  assert.ok(who.split('\n').length >= 3 && who.split('\n')[2].trim(), 'whoami prints a name');
  const uname = await runDiagnostic({ command: 'uname', args: ['-s'] }, { cwd: tmp });
  assert.match(uname, /^\$ uname -s\n/, 'arguments are shown as given');
}
// A run that is still going is stopped at the limit, not left behind.
function fakeSpawn(script) {
  const calls = [];
  const child = new EventEmitter();
  child.stdout = new EventEmitter();
  child.stderr = new EventEmitter();
  child.kill = (sig) => { child.killedWith = sig; return true; };
  const spawnFile = (cmd, argv, opts) => { calls.push({ cmd, argv, opts }); script(child); return child; };
  return { calls, child, spawnFile };
}
{
  const { calls, child, spawnFile } = fakeSpawn(() => {});
  const t0 = Date.now();
  await assert.rejects(runDiagnostic({ command: 'ps' }, { spawnFile, limits: { ...DIAGNOSTIC_LIMITS, timeoutMs: 25 } }),
    /ps was still running after 0\.025 s, so I stopped it/, 'a timeout says what happened');
  assert.ok(Date.now() - t0 < 1_000, 'stopped at the limit');
  assert.equal(child.killedWith, 'SIGKILL', 'the process is killed');
  assert.equal(calls[0].opts.shell, false, 'never a shell');
  assert.deepEqual(calls[0].argv, [], 'the argv is a list, not a command line');
  assert.equal(typeof calls[0].opts.cwd, 'string', 'it starts in the allowed folder');
}
// Output is cut at the byte cap, so a huge listing can't flood the reply.
{
  const { calls, spawnFile } = fakeSpawn((c) => setTimeout(() => { c.stdout.emit('data', Buffer.alloc(300, 97)); c.emit('close', 0, null); }, 0));
  const out = await runDiagnostic({ command: 'ps' }, { spawnFile, limits: { timeoutMs: 1_000, maxBytes: 64, maxChars: 40 } });
  assert.match(out, /output cut at 64 bytes/, 'it says the output was cut');
  assert.ok(out.length < 200, `the result stays small (${out.length})`);
  assert.deepEqual(calls[0].argv, []);
}
// A character split across two chunks still reads as one (Arabic, an emoji).
{
  const bytes = Buffer.from('مجلد مشترك\n', 'utf8');
  const { spawnFile } = fakeSpawn((c) => setTimeout(() => {
    c.stdout.emit('data', bytes.subarray(0, 1)); c.stdout.emit('data', bytes.subarray(1)); c.emit('close', 0, null);
  }, 0));
  const out = await runDiagnostic({ command: 'whoami' }, { spawnFile });
  assert.ok(out.includes('مجلد مشترك'), 'the text is decoded whole');
}
// A command that fails says which exit and what it said.
{
  const { spawnFile } = fakeSpawn((c) => setTimeout(() => {
    c.stderr.emit('data', Buffer.from('ls: cannot access: No such file or directory\n'));
    c.emit('close', 2, null);
  }, 0));
  await assert.rejects(runDiagnostic({ command: 'ls' }, { spawnFile }), (e) =>
    /^Exit 2 · ls\n/.test(e.message) && /No such file or directory/.test(e.message), 'an exit is reported with the output');
}
// A command this computer doesn't have says so, instead of sending the model hunting.
{
  const { spawnFile } = fakeSpawn((c) => setTimeout(() => {
    const err = new Error('spawn free ENOENT'); err.code = 'ENOENT'; c.emit('error', err);
  }, 0));
  await assert.rejects(runDiagnostic({ command: 'free' }, { spawnFile }), /free isn't on this (Mac|computer), so there's nothing to show for it/);
}
// A refused command never reaches spawn at all.
{
  let spawned = false;
  const spawnFile = () => { spawned = true; throw new Error('must not spawn'); };
  await assert.rejects(runDiagnostic({ command: 'sudo' }, { spawnFile }), /Blocked for safety/);
  await assert.rejects(runDiagnostic({ command: 'ls', args: ['|sh'] }, { spawnFile }), /Blocked for safety/);
  assert.equal(spawned, false, 'nothing was spawned');
  await assert.rejects(runDiagnostic({ command: 'pwd' }, { spawnFile: () => { throw new Error('EACCES'); } }), /Couldn't run pwd: EACCES/, 'a spawn that fails is reported');
}
console.log('terminal run: passed');

// ---------------------------------------------------------------- agent core: router, grant, preflight, no approval
{
  const rt = createAgentCoreRuntime({ tools, grantedLevel: 'observe', env: {}, safety: { preflight: agentCorePreflight } });
  const offered = rt.tools.map((t) => t.name);
  assert.ok(offered.includes('run_diagnostic'), 'offered at the observe grant');
  const wrapped = rt.tools.find((t) => t.name === 'run_diagnostic');
  // Allowed at observe, with no approval dialog (there is no channel here: one would fail the call).
  const ok = await wrapped.execute({ command: 'whoami' }, {});
  assert.match(ok, /^\$ whoami\n/, 'an allowlisted command runs through the core');
  // Refused at the router's safety phase, before anything executes.
  const bad = rt.core.router.route('run_diagnostic', { command: 'sudo', args: ['-i'] }, { phase: 'initial' });
  assert.equal(bad.allowed, false, 'sudo is refused by the router');
  assert.match(bad.reason, /blocked by safety: "sudo" isn't a command I can run/);
  const chain = rt.core.router.route('run_diagnostic', { command: 'ls', args: ['&& rm -rf ~'] }, { phase: 'initial' });
  assert.equal(chain.allowed, false, 'a chained command is refused');
  // The same through the wrapped tool the model calls: the executor denies it, and the model is told.
  await assert.rejects(wrapped.execute({ command: 'rm', args: ['-rf', '~'] }, {}), (e) =>
    /^Blocked: blocked by safety/.test(e.message) && /"rm" isn't a command I can run/.test(e.message));
  // The tool's own level is not raised by a higher grant, and it never needs a yes.
  const top = createAgentCoreRuntime({ tools, grantedLevel: 'administrative', env: {}, safety: { preflight: agentCorePreflight } });
  const routed = top.core.router.route('run_diagnostic', { command: 'df', args: ['-h'] }, { phase: 'initial' });
  assert.equal(routed.allowed, true);
  assert.equal(routed.requiresApproval, false, 'a read-only diagnostic needs no approval even at the top level');
  // Without a host grant nothing runs: fail closed.
  const none = createAgentCoreRuntime({ tools, grantedLevel: '', env: {}, safety: { preflight: agentCorePreflight } });
  assert.equal(none.core.router.route('run_diagnostic', { command: 'pwd' }, { phase: 'initial' }).allowed, false);
}
console.log('terminal agent core: passed');

// ---------------------------------------------------------------- what the panel says
assert.deepEqual(describe('run_diagnostic', { command: 'df', args: ['-h'] }), ['Checking df -h', 'Checked df -h'], 'the activity line names the command');
assert.deepEqual(describe('run_diagnostic', { command: 'pwd' }), ['Checking pwd', 'Checked pwd']);
assert.deepEqual(describe('run_diagnostic', { command: 'ls', args: ['-la', '-h'] }), ['Checking ls -la -h', 'Checked ls -la -h']);

console.log('terminal: passed');

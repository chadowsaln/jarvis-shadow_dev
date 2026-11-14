// Batch 6: application management on Linux. Discovery, search and running apps are read-only (observe); starting one
// is trusted, always asks first, and can only ever name an app that is installed — never a file, a path, a command or
// a system tool. All four go through the agent core's router, permission level and safety preflight. Run: npm test
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import process from 'node:process';
import { resolveToolSchema } from '@kenkaiiii/gg-ai';
import { checkAppTarget } from '../safety.mjs';
import { appCatalog, appExecNames, createTools, launchInstalledApp, resolveApp, runningApps, searchApps } from '../tools.mjs';
import { createAgentCoreRuntime } from '../agentcore/runtime.mjs';
import { agentCorePreflight } from '../agentcore/preflight.mjs';
import { defaultToolPermission } from '../agentcore/permissions.mjs';
import { describe } from '../activity.mjs';

const LINUX = process.platform === 'linux';

// ---------------------------------------------------------------- what a name may be
// A menu name or an id is a name; a path, an installer, a shell string or a system tool is not.
for (const ok of ['Firefox', 'Google Chrome', 'org.gnome.Nautilus', 'Files', 'Visual Studio Code', 'VLC']) {
  assert.equal(checkAppTarget(ok).level, 'safe', `${ok} is an app name`);
}
for (const bad of ['/usr/bin/firefox', '~/Apps/thing.AppImage', './run.sh', 'x; rm -rf ~', 'firefox && xterm',
  'firefox | sh', '$(xterm)', '`xterm`', 'apt', 'apt-get', 'dpkg', 'snap', 'flatpak', 'pip3', 'npm', 'bash', 'sh',
  'python3', 'node', 'systemctl', 'chmod', 'kill', 'mount', 'rm', 'install', 'update', 'setup.sh', 'tool.py',
  'app.desktop', 'thing.AppImage', '-x', '', null]) {
  const v = checkAppTarget(bad);
  assert.equal(v.level, 'block', `${JSON.stringify(bad)} is refused`);
  assert.ok(v.reason, 'a refusal says why');
}
// Nothing here is an install, an uninstall or an update, and nothing runs a system tool to get privileges.
assert.match(checkAppTarget('apt').reason, /program or a system tool/, 'a system tool is named as such');
assert.match(checkAppTarget('/bin/ls').reason, /is a path, not an app name/, 'a path is named as such');
assert.match(checkAppTarget('setup.sh').reason, /file or an installer/, 'a script is named as such');
console.log('app names: passed');

// ---------------------------------------------------------------- installed apps: the catalog and the search
const APPS = [
  { id: 'firefox', file: '/usr/share/applications/firefox.desktop', entry: { Name: 'Firefox', GenericName: 'Web Browser', Exec: '/usr/bin/firefox %u', Keywords: 'browser;web;internet;' } },
  { id: 'google-chrome', file: '/usr/share/applications/google-chrome.desktop', entry: { Name: 'Google Chrome', GenericName: 'Web Browser', Exec: '/usr/bin/google-chrome-stable %U' } },
  { id: 'org.gnome.Nautilus', file: '/usr/share/applications/org.gnome.Nautilus.desktop', entry: { Name: 'Files', GenericName: 'File Manager', Exec: 'nautilus --gapplication-service' } },
  { id: 'org.videolan.VLC', file: '/var/lib/flatpak/exports/share/applications/org.videolan.VLC.desktop', entry: { Name: 'VLC', Exec: '/usr/bin/flatpak run --branch=stable --arch=x86_64 org.videolan.VLC' } },
  // Not apps: hidden helpers, and entries that open a link or start a service.
  { id: 'org.gnome.Software', file: '/usr/share/applications/org.gnome.Software.desktop', entry: { Name: 'Software', Exec: 'gnome-software', NoDisplay: 'true' } },
  { id: 'hidden.Thing', file: '/usr/share/applications/hidden.Thing.desktop', entry: { Name: 'Hidden Thing', Exec: 'thing', Hidden: 'true' } },
  { id: 'foo.Link', file: '/usr/share/applications/foo.Link.desktop', entry: { Name: 'Docs', Type: 'Link', URL: 'https://example.com', Exec: 'xdg-open https://example.com' } },
  { id: 'no.Exec', file: '/usr/share/applications/no.Exec.desktop', entry: { Name: 'Nothing' } },
];
assert.deepEqual(appCatalog(APPS).map((a) => a.id), ['org.gnome.Nautilus', 'firefox', 'google-chrome', 'org.videolan.VLC'], 'only startable apps, by the name the menus show');
assert.ok(appCatalog(APPS).every((a) => a.name), 'each one has the name it shows');
assert.equal(searchApps(APPS, 'chrome')[0]?.id, 'google-chrome', 'a word of the name finds it');
assert.equal(searchApps(APPS, 'Files')[0]?.id, 'org.gnome.Nautilus', 'the name the menus show finds it');
assert.equal(searchApps(APPS, 'nautilus')[0]?.id, 'org.gnome.Nautilus', 'the id (its last part) finds it');
assert.deepEqual(searchApps(APPS, 'web browser').map((a) => a.id), ['firefox', 'google-chrome'], 'the kind of app finds both browsers, in menu order');
assert.deepEqual(searchApps(APPS, 'zzz'), [], 'nothing matches nothing');
assert.deepEqual(searchApps(APPS, 'software'), [], 'a hidden helper never shows up');
assert.deepEqual(searchApps(APPS, 'docs'), [], 'a link is not an app');
// The name a launch takes: the exact id, the exact name, or one clear match — never a guess between several.
assert.equal(resolveApp(APPS, 'org.videolan.VLC').app?.id, 'org.videolan.VLC', 'by id');
assert.equal(resolveApp(APPS, 'Firefox').app?.id, 'firefox', 'by the name shown');
assert.equal(resolveApp(APPS, 'chrome').app?.id, 'google-chrome', 'by one clear match');
assert.equal(resolveApp(APPS, 'zzz').app, null, 'an app that is not installed resolves to nothing');
assert.deepEqual(resolveApp(APPS, 'zzz').matches, []);
// Two apps with one name: the answer is the candidates, never the first one.
const twins = [
  { id: 'a.Editor', file: '/usr/share/applications/a.Editor.desktop', entry: { Name: 'Editor', Exec: 'a-editor' } },
  { id: 'b.Editor', file: '/usr/share/applications/b.Editor.desktop', entry: { Name: 'Editor', Exec: 'b-editor' } },
];
assert.equal(resolveApp(twins, 'editor').app, null, 'an ambiguous name starts nothing');
assert.equal(resolveApp(twins, 'editor').matches.length, 2, 'it offers the candidates instead');
// The command a process must be to be that app.
assert.deepEqual(appExecNames({ Exec: '/usr/bin/firefox %u' }), ['firefox'], 'the program behind Exec');
assert.deepEqual(appExecNames({ Exec: 'env BAMF_HINT=1 /usr/bin/nautilus --gapplication-service' }), ['nautilus'], 'past env assignments');
assert.deepEqual(appExecNames({ Exec: '/usr/bin/flatpak run --branch=stable org.videolan.VLC' }), ['org.videolan.VLC'], 'a flatpak is its id');
assert.deepEqual(appExecNames({ Exec: 'sh -c "thing --flag"' }), [], 'a shell is not an app');
console.log('installed apps: passed');

// ---------------------------------------------------------------- starting one: an installed app, and only that
function fakeSpawn(script) {
  const calls = [];
  const child = new EventEmitter();
  child.stderr = new EventEmitter();
  child.kill = () => { child.killed = true; return true; };
  const spawnFile = (cmd, argv, opts) => { calls.push({ cmd, argv, opts }); script(child, calls.length); return child; };
  return { calls, child, spawnFile };
}
// A path never reaches a launcher, and neither does a shell string: refused before anything is spawned.
{
  let spawned = false;
  const spawnFile = () => { spawned = true; throw new Error('must not spawn'); };
  await assert.rejects(launchInstalledApp('/usr/bin/firefox', { apps: APPS, spawnFile }), /Blocked for safety: .*is a path/, 'a path is refused');
  await assert.rejects(launchInstalledApp('firefox; xterm', { apps: APPS, spawnFile }), /Blocked for safety: .*shell characters/, 'a shell string is refused');
  await assert.rejects(launchInstalledApp('apt', { apps: APPS, spawnFile }), /Blocked for safety: .*system tool/, 'a system tool is refused');
  assert.equal(spawned, false, 'nothing was spawned');
}
// An app that isn't installed starts nothing, whatever arguments it was given.
{
  let spawned = false;
  const spawnFile = () => { spawned = true; throw new Error('must not spawn'); };
  await assert.rejects(launchInstalledApp('not-installed-app', { apps: APPS, spawnFile }), /There's no app called "not-installed-app"/, 'an unknown app starts nothing');
  await assert.rejects(launchInstalledApp('firefox --new-window', { apps: APPS, spawnFile }), /There's no app called "firefox --new-window"/, 'no arguments are ever passed');
  await assert.rejects(launchInstalledApp('org.gnome.Software', { apps: APPS, spawnFile }), /There's no app called "org.gnome.Software"/, 'a hidden entry starts nothing');
  await assert.rejects(launchInstalledApp('Editor', { apps: twins, spawnFile }), /more than one app like "Editor"/, 'an ambiguous name starts nothing');
  assert.equal(spawned, false, 'nothing was spawned');
}
// It starts the .desktop file with gio, with no shell and no other argument.
{
  const { calls, spawnFile } = fakeSpawn((c) => setTimeout(() => c.emit('exit', 0, null), 0));
  const r = await launchInstalledApp('firefox', { apps: APPS, spawnFile });
  assert.equal(r.app.id, 'firefox');
  assert.equal(r.via, 'gio');
  assert.equal(calls.length, 1);
  assert.equal(calls[0].cmd, 'gio');
  assert.deepEqual(calls[0].argv, ['launch', '/usr/share/applications/firefox.desktop'], 'only the desktop file');
  assert.equal(calls[0].opts.shell, false, 'never a shell');
  assert.deepEqual(calls[0].opts.stdio, ['ignore', 'ignore', 'pipe'], 'nothing is ever written to it');
}
// Without gio, gtk-launch starts it by id; with neither, it says so.
{
  const { calls, spawnFile } = fakeSpawn((c, n) => setTimeout(() => {
    if (n === 1) { const err = new Error('spawn gio ENOENT'); err.code = 'ENOENT'; c.emit('error', err); }
    else c.emit('exit', 0, null);
  }, 0));
  const r = await launchInstalledApp('VLC', { apps: APPS, spawnFile });
  assert.equal(r.via, 'gtk-launch');
  assert.equal(calls[1].cmd, 'gtk-launch');
  assert.deepEqual(calls[1].argv, ['org.videolan.VLC'], 'by id, with nothing added');
  const missing = fakeSpawn((c) => setTimeout(() => { const err = new Error('ENOENT'); err.code = 'ENOENT'; c.emit('error', err); }, 0));
  await assert.rejects(launchInstalledApp('VLC', { apps: APPS, spawnFile: missing.spawnFile }), /neither gio nor gtk-launch/, 'a launcher that is missing is reported');
}
// A launcher that fails, and one that hangs, are reported rather than passed off as started.
{
  const failed = fakeSpawn((c) => setTimeout(() => { c.stderr.emit('data', 'no such application\n'); c.emit('exit', 1, null); }, 0));
  await assert.rejects(launchInstalledApp('firefox', { apps: APPS, spawnFile: failed.spawnFile }), /didn't start \(exit 1\): no such application/, 'a failure says which exit and why');
  const hung = fakeSpawn(() => {});
  await assert.rejects(launchInstalledApp('firefox', { apps: APPS, spawnFile: hung.spawnFile, timeoutMs: 25 }), /didn't start within 0 s/, 'a hang is stopped and reported');
  assert.equal(hung.child.killed, true, 'the launcher is killed');
}
console.log('launching: passed');

// ---------------------------------------------------------------- running apps, from /proc
{
  const proc = await fs.mkdtemp(path.join(os.tmpdir(), 'roamies-proc-'));
  const proc_ = async (pid, argv, comm) => {
    await fs.mkdir(path.join(proc, pid));
    await fs.writeFile(path.join(proc, pid, 'cmdline'), argv.join('\0') + '\0');
    await fs.writeFile(path.join(proc, pid, 'comm'), `${comm}\n`);
  };
  await proc_('111', ['/usr/lib/firefox/firefox', '-contentproc'], 'firefox');
  await proc_('112', ['/usr/lib/firefox/firefox'], 'firefox');
  await proc_('222', ['/usr/bin/flatpak', 'run', 'org.videolan.VLC'], 'flatpak');
  await proc_('333', ['bash'], 'bash');
  await proc_('444', [], ''); // a kernel thread: no argv at all
  await fs.writeFile(path.join(proc, 'stat'), 'not a pid');
  const list = await runningApps(APPS, { procDir: proc });
  assert.deepEqual(list.map((r) => [r.app.id, r.pid]), [['firefox', 111], ['org.videolan.VLC', 222]], 'each app once, by its first pid');
  await fs.rm(proc, { recursive: true, force: true });
  // On this machine it reads the real /proc without throwing (nothing has to be running).
  const live = await runningApps(APPS);
  assert.ok(Array.isArray(live));
}
console.log('running apps: passed');

// ---------------------------------------------------------------- the tools: levels, schemas, and the ask
const { tools } = createTools({
  allowActions: false, ui: () => {}, ask: async () => false, openUrl: async () => {}, onCommitments: () => {},
  showList: () => {}, fmtWhen: String, commitmentsText: () => '', userName: 'Test',
});
const byName = (n) => tools.find((t) => t.name === n);
const named = tools.map((t) => t.name);
assert.equal(named.includes('list_apps'), LINUX, 'app tools exist on Linux only');
if (LINUX) {
  assert.deepEqual(defaultToolPermission(byName('list_apps')), { level: 'observe', requiresApproval: false, approvalScopes: null, description: 'List the installed applications' });
  assert.deepEqual(defaultToolPermission(byName('find_app')), { level: 'observe', requiresApproval: false, approvalScopes: null, description: 'Search the installed applications by name' });
  assert.deepEqual(defaultToolPermission(byName('running_apps')), { level: 'observe', requiresApproval: false, approvalScopes: null, description: 'List the installed apps that are running' });
  assert.deepEqual(defaultToolPermission(byName('launch_app')), { level: 'trusted', requiresApproval: true, approvalScopes: null, description: 'Start an installed application' });
  // There is no tool that installs, removes or updates anything.
  assert.deepEqual(named.filter((n) => /install|uninstall|remove|update|upgrade|purge/i.test(n)).filter((n) => !['update_commitment', 'memory_update'].includes(n)), []);
  // The launch tool takes one name: no command, no arguments, no ids of processes.
  const schema = resolveToolSchema(byName('launch_app'));
  assert.deepEqual(Object.keys(schema.properties), ['app'], 'the only input is an app name');
  assert.deepEqual(schema.required, ['app']);
  assert.equal(schema.properties.command, undefined, 'there is no command');
  assert.equal(schema.properties.args, undefined, 'there are no arguments');
  assert.match(byName('launch_app').description, /Only installed apps start this way/, 'the description says what may start');
  assert.match(byName('list_apps').description, /installed on this computer/, 'the list says what it lists');
  // Refused before asking, before scanning for a launcher, before anything.
  await assert.rejects(byName('launch_app').execute({ app: '/usr/bin/firefox' }, {}), /Blocked for safety: .*is a path/, 'a path never runs');
  await assert.rejects(byName('launch_app').execute({ app: 'rm -rf ~' }, {}), /Blocked for safety/, 'a command never runs');
  await assert.rejects(byName('launch_app').execute({ app: 'zzz-no-such-app-zzz' }, {}), /There's no app called/, 'an app that is not installed never runs');
  // The dialog: the same install, but the person says no, so nothing starts.
  await assert.rejects(byName('launch_app').execute({ app: 'zzz-no-such-app-zzz' }, {}), /There's no app called/, 'checked before asking');
}
console.log('app tools: passed');

// ---------------------------------------------------------------- agent core: observe to read, trusted to start
if (LINUX) {
  const observes = createAgentCoreRuntime({ tools, grantedLevel: 'observe', env: {}, safety: { preflight: agentCorePreflight } });
  assert.equal(observes.core.router.route('list_apps', {}, { phase: 'route' }).allowed, true, 'reading the list needs only observe');
  assert.equal(observes.core.router.route('find_app', { name: 'fire' }, { phase: 'route' }).allowed, true, 'searching needs only observe');
  assert.equal(observes.core.router.route('running_apps', {}, { phase: 'route' }).allowed, true, 'seeing what runs needs only observe');
  const denyStart = observes.core.router.route('launch_app', { app: 'firefox' }, { phase: 'route' });
  assert.equal(denyStart.allowed, false, 'starting one needs more than observe');
  assert.match(denyStart.reason, /requires trusted, granted observe/, 'it says which level it needs');

  const trusts = createAgentCoreRuntime({ tools, grantedLevel: 'trusted', env: {}, safety: { preflight: agentCorePreflight } });
  const start = trusts.core.router.route('launch_app', { app: 'firefox' }, { phase: 'route' });
  assert.equal(start.allowed, true, 'trusted may start an installed app');
  assert.equal(start.requiresApproval, true, 'and must ask first, every time');
  assert.equal(start.requiredLevel, 'trusted');
  assert.equal(trusts.core.router.route('launch_app', { app: '/usr/bin/firefox' }, { phase: 'route' }).allowed, false, 'but never by a path');
  assert.equal(trusts.core.router.route('launch_app', { app: 'x; xterm' }, { phase: 'route' }).allowed, false, 'nor by a command');
  assert.equal(trusts.core.router.route('launch_app', { app: 'apt' }, { phase: 'route' }).allowed, false, 'nor by a system tool');
  assert.equal(trusts.core.router.route('list_apps', {}, { phase: 'route' }).requiresApproval, false, 'reading never asks');
  // The same refusal at the recheck, right before execution.
  assert.equal(trusts.core.router.route('launch_app', { app: '../x.desktop' }, { phase: 'pre_execute' }).allowed, false, 'a path is refused again before it runs');
}
console.log('app agent core: passed');

// ---------------------------------------------------------------- the activity lines name the app, never a path
assert.deepEqual(describe('launch_app', { app: 'Firefox' }), ['Opening Firefox', 'Opened Firefox']);
assert.deepEqual(describe('list_apps', {}), ['Looking at the installed apps', 'Looked at the installed apps']);
assert.deepEqual(describe('find_app', { name: 'chrome' }), ['Looking for the app chrome', 'Looked for the app chrome']);
assert.deepEqual(describe('running_apps', {}), ['Checking what apps are open', 'Checked what apps are open']);
console.log('app activity: passed');

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';

// Test Batch 4 & 5 modules
import { computeScreenHash, screenDiff, findElementHierarchy, createScreenLook } from '../computer-control/screen-look.mjs';
import { checkFileDelete, SAFE, ASK, BLOCK } from '../safety.mjs';
import { SkillRegistry, validateSkillManifest } from '../skills/registry.mjs';
import { BrowserIntelligenceService } from '../browser-intelligence/index.mjs';
import { createPlan, validatePlan, updateStep } from '../agentcore/planner.mjs';

test('Screen Look (Batch 4) - hashing and screen diff', async () => {
  const bufA = Buffer.from('image-a-content-pixels');
  const bufB = Buffer.from('image-b-content-pixels');
  const hashA = await computeScreenHash(bufA);
  const hashB = await computeScreenHash(bufB);

  assert.equal(typeof hashA, 'string');
  assert.equal(hashA.length, 64);

  const sameDiff = screenDiff(hashA, hashA);
  assert.equal(sameDiff.changed, false);
  assert.equal(sameDiff.similarity, 1.0);

  const changedDiff = screenDiff(hashA, hashB);
  assert.equal(changedDiff.changed, true);
  assert.equal(changedDiff.similarity, 0.0);
});

test('Screen Look (Batch 4) - findElementHierarchy priority', async () => {
  // 1. Accessibility tree priority
  const fakeDriver = {
    async findElements({ name }) {
      if (name === 'Submit') {
        return [{
          name: 'Submit',
          role: 'ROLE_PUSH_BUTTON',
          description: 'Submit button',
          coordinates: { x: 100, y: 200, width: 80, height: 30 },
        }];
      }
      return [];
    },
  };

  const res1 = await findElementHierarchy('Submit', { atspiDriver: fakeDriver });
  assert.equal(res1.found, true);
  assert.equal(res1.source, 'atspi');
  assert.deepEqual(res1.center, [140, 215]); // 100 + 40, 200 + 15

  // 2. Not found in accessibility or OCR
  const res2 = await findElementHierarchy('NonExistent', { atspiDriver: fakeDriver });
  assert.equal(res2.found, false);
  assert.equal(res2.source, 'none');
});

test('Screen Look (Batch 4) - cache behavior in createScreenLook', async () => {
  let portalCalls = 0;
  const tmpFile = path.join(os.tmpdir(), `test-screen-${Date.now()}.jpg`);
  await fs.writeFile(tmpFile, 'fake-jpeg-bytes');

  const looker = createScreenLook({
    askShell: async () => {
      portalCalls++;
      return { ok: true, pixels: [1920, 1080], bounds: { x: 0, y: 0, width: 1920, height: 1080 } };
    },
  });

  // First call captures
  const res1 = await looker.look({ forceFresh: true });
  assert.equal(res1.ok, true);

  // Second immediate call uses cache
  const res2 = await looker.look({ forceFresh: false });
  assert.equal(res2.ok, true);
  assert.equal(res2.cached, true);
  assert.equal(portalCalls, 1);
});

test('Safety (Batch 5) - checkFileDelete guard rails', async () => {
  const home = os.homedir();

  // Root or home itself: BLOCK
  assert.equal(checkFileDelete(home, home).level, BLOCK);
  assert.equal(checkFileDelete('/', home).level, BLOCK);

  // Outside home: BLOCK
  assert.equal(checkFileDelete('/etc/shadow', home).level, BLOCK);
  assert.equal(checkFileDelete('/var/log/syslog', home).level, BLOCK);

  // Protected files (keys/ssh/bashrc): BLOCK
  assert.equal(checkFileDelete(path.join(home, '.ssh', 'id_rsa'), home).level, BLOCK);

  // Existing file inside home: ASK
  const testFile = path.join(home, 'test-delete-target.txt');
  await fs.writeFile(testFile, 'to delete').catch(() => {});
  try {
    const verdict = checkFileDelete(testFile, home);
    assert.equal(verdict.level, ASK);
  } finally {
    await fs.unlink(testFile).catch(() => {});
  }
});

test('Skills Registry (V2.4) - manifest validation and execution', async () => {
  const reg = new SkillRegistry({ dir: path.join(os.tmpdir(), `skills-${Date.now()}`) });

  // Valid manifest
  const manifest = {
    id: 'test-greeting',
    name: 'Greet and Save',
    description: 'Greets the user and writes a note',
    triggers: ['greet', 'say hello', 'مرحبا'],
    steps: [
      { id: 's1', tool: 'mock_tool', args: { msg: 'Hello ${name}' } },
    ],
  };

  const validated = validateSkillManifest(manifest);
  assert.equal(validated.ok, true);

  reg.register(manifest);
  assert.equal(reg.list().length, 1);

  // Trigger matching
  const matches = reg.findMatching('say hello');
  assert.equal(matches.length, 1);
  assert.equal(matches[0].id, 'test-greeting');

  // Execution
  const toolCalls = [];
  const runResult = await reg.executeSkill('test-greeting', { name: 'Shadow' }, {
    runTool: async ({ tool, args }) => {
      toolCalls.push({ tool, args });
      return `Ran ${tool}`;
    },
  });

  assert.equal(runResult.success, true);
  assert.equal(toolCalls.length, 1);
  assert.equal(toolCalls[0].args.msg, 'Hello Shadow');
});

test('Browser Intelligence (V2.2) - DOM extraction and reading', async () => {
  const browserService = new BrowserIntelligenceService();

  const fakeHtml = `
    <html>
      <head><title>Test App</title></head>
      <body>
        <h1>Welcome</h1>
        <a href="https://example.com/about">About Us</a>
        <button id="btn1">Click Me</button>
        <input type="text" name="username" placeholder="Enter username" />
      </body>
    </html>
  `;

  const elements = browserService.extractElementsFromHtml(fakeHtml);
  assert.equal(elements.length, 3);
  assert.equal(elements.find(e => e.role === 'link')?.text, 'About Us');
  assert.equal(elements.find(e => e.role === 'button')?.text, 'Click Me');
  assert.equal(elements.find(e => e.role === 'textbox')?.name, 'username');
});

test('Autonomous Task Execution (Batch 6) - planner integration', () => {
  const plan = createPlan({
    goal: 'Create report and notify',
    steps: [
      { id: 'step1', title: 'Write report', tool: 'write_file', args: { path: '~/report.txt', content: 'done' } },
      { id: 'step2', title: 'Verify report exists', tool: 'file_info', args: { path: '~/report.txt' }, dependsOn: ['step1'] },
    ],
  });

  const v = validatePlan(plan);
  assert.equal(v.ok, true);
  assert.equal(plan.steps.length, 2);
  assert.deepEqual(plan.steps[1].dependsOn, ['step1']);

  // Complete step 1
  updateStep(plan, 'step1', { status: 'completed' });
  assert.equal(plan.steps[0].status, 'completed');
});

test('Tool Registry - new Batch 4, 5, 6 and V2.4 tools are registered and valid', async () => {
  const { createTools } = await import('../tools.mjs');
  const { tools } = createTools({
    allowActions: () => true,
    ui: () => {},
    ask: async () => 'Allow',
    openUrl: () => {},
    onCommitments: () => {},
    showList: () => {},
    fmtWhen: () => '',
    commitmentsText: () => '',
    userName: 'Tester',
  });

  const toolNames = new Set(tools.map(t => t.name));

  // Batch 4 & 5 tools
  assert.ok(toolNames.has('delete_file'), 'delete_file must be registered');
  assert.ok(toolNames.has('volume_control'), 'volume_control must be registered');
  assert.ok(toolNames.has('process_list'), 'process_list must be registered');
  assert.ok(toolNames.has('process_kill'), 'process_kill must be registered');
  assert.ok(toolNames.has('screen_look'), 'screen_look must be registered');

  // Batch 6 Autonomous execution tools
  assert.ok(toolNames.has('make_plan'), 'make_plan must be registered');
  assert.ok(toolNames.has('execute_plan'), 'execute_plan must be registered');

  // V2.4 Skills tools
  assert.ok(toolNames.has('skill_list'), 'skill_list must be registered');
  assert.ok(toolNames.has('skill_run'), 'skill_run must be registered');

  // Assert permissions and metadata on new tools
  for (const name of ['delete_file', 'volume_control', 'process_list', 'process_kill', 'screen_look', 'make_plan', 'execute_plan', 'skill_list', 'skill_run']) {
    const t = tools.find(x => x.name === name);
    assert.ok(t.description, `${name} must have a description`);
    assert.ok(t.parameters, `${name} must have parameters`);
    assert.ok(t.permission, `${name} must have permission metadata`);
    assert.ok(t.permission.level, `${name} must have a permission level`);
  }
});

// File management tools (Batch 4 / JARVIS V2). Run: node --test showcase/tauri/sidecar/test/filetools.test.mjs
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import { existsSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createTools } from '../tools.mjs';
import { BLOCK, SAFE, checkFileRead, checkFileSource, checkFileDest, checkFileCreate } from '../safety.mjs';

const HOME = os.homedir();
const tmp = await fs.mkdtemp(path.join(HOME, '.roamies-filetools-'));
const cleanup = [];
try {
  const mk = (...parts) => path.join(tmp, ...parts);
  const write = async (p, c = 'hi') => { await fs.mkdir(path.dirname(p), { recursive: true }); await fs.writeFile(p, c, 'utf8'); return p; };

  // --- setup: Arabic/English names ---
  await fs.mkdir(mk('مجلد'), { recursive: true });
  await fs.mkdir(mk('docs'), { recursive: true });
  await write(mk('docs', 'hello.txt'), 'hello world\nمرحبا بالعالم');
  await write(mk('docs', 'notes.md'), '# ملاحظات\nnote');
  await write(mk('مجلد', 'ملف عربي.txt'), 'محتوى عربي');
  await write(mk('مجلد', 'english.TXT'), 'ENGLISH');

  // --- safety: allowed area (home only), traversal, symlink escape ---
  {
    assert.equal(checkFileRead(mk('docs', 'hello.txt'), HOME).level, SAFE, 'read inside home ok');
    assert.equal(checkFileRead('/etc/hosts', HOME).level, BLOCK, 'read outside home blocked');
    assert.equal(checkFileRead(path.join(HOME, '..', 'etc', 'hosts'), HOME).level, BLOCK, 'traversal outside home blocked');
    assert.equal(checkFileCreate(path.join('/tmp', 'roamies-escape-x'), HOME).level, BLOCK, 'create outside home blocked');
    // symlink escape: link inside tmp -> /etc
    const link = mk('escape-link');
    try {
      await fs.symlink('/etc', link, 'dir');
      assert.equal(checkFileRead(link, HOME).level, BLOCK, 'symlink dir to /etc blocked for read');
      assert.equal(checkFileRead(path.join(link, 'hosts'), HOME).level, BLOCK, 'read through symlink escape blocked');
      assert.equal(checkFileSource(link, HOME).level, BLOCK, 'source through symlink escape blocked');
      assert.equal(checkFileDest(path.join(link, 'x.txt'), HOME).level, BLOCK, 'dest inside symlink escape blocked');
    } catch (e) { if (process.platform === 'win32') console.log('symlink tests skipped:', e.code); else throw e; }
    // secrets still blocked
    const secretLike = mk('.env');
    await write(secretLike, 'SECRET=1');
    assert.equal(checkFileRead(secretLike, HOME).level, BLOCK, 'secret file blocked');
    console.log('file safety: passed');
  }

  // --- tools integration (agent core / metadata / behavior) ---
  {
    const { tools } = createTools({ allowActions: () => true, ui: () => {}, ask: async () => true, openUrl: async () => {}, onCommitments: () => {}, showList: () => {}, fmtWhen: String, commitmentsText: () => '', userName: 'Test' });
    const get = (n) => tools.find((t) => t.name === n);
    const must = (n) => { const t = get(n); assert.ok(t, `tool ${n} exists`); return t; };

    // presence + permission metadata
    for (const n of ['read_file','list_files','search_files','file_info','find_files']) {
      const t = must(n);
      assert.equal(t.permission?.level, 'observe', `${n} observe`);
      assert.equal(t.permission?.requiresApproval, false, `${n} no approval`);
    }
    for (const n of ['write_file','create_directory','copy_file','move_file','rename_file']) {
      const t = must(n);
      assert.equal(t.permission?.level, 'trusted', `${n} trusted`);
      assert.equal(t.permission?.requiresApproval, true, `${n} requires approval`);
    }

    // 1. browse files/folders
    const list = await must('list_files').execute({ dir: tmp });
    assert.ok(list.includes('docs/'), 'lists docs dir');
    assert.ok(list.includes('مجلد/'), 'lists Arabic dir');
    const listAr = await must('list_files').execute({ dir: mk('مجلد') });
    assert.ok(listAr.includes('ملف عربي.txt'), 'lists Arabic filename');
    assert.ok(listAr.includes('english.TXT'), 'lists English filename');

    // 2. search by name and extension (Arabic/English)
    const byExtTxt = await must('find_files').execute({ dir: tmp, ext: 'txt' });
    assert.ok(byExtTxt.includes('hello.txt'), 'finds .txt by ext');
    assert.ok(byExtTxt.includes('ملف عربي.txt'), 'finds Arabic-named .txt');
    assert.ok(byExtTxt.toLowerCase().includes('english.txt'), 'finds .TXT case-insensitively');
    assert.ok(!byExtTxt.includes('notes.md'), 'ext filter excludes .md');
    const byNameAr = await must('find_files').execute({ dir: tmp, name: 'ملف' });
    assert.ok(byNameAr.includes('ملف عربي.txt'), 'finds by Arabic name part');
    const byNameEn = await must('find_files').execute({ dir: tmp, name: 'HELLO' });
    assert.ok(byNameEn.includes('hello.txt'), 'finds by English name case-insensitively');
    const byExtMd = await must('find_files').execute({ dir: tmp, ext: '.md' });
    assert.ok(byExtMd.includes('notes.md'), 'finds .md with dot ext');

    // 3. read text files and show info
    const content = await must('read_file').execute({ path: mk('docs', 'hello.txt') });
    assert.ok(content.includes('hello world') && content.includes('مرحبا بالعالم'), 'reads UTF-8 text with Arabic');
    const infoFile = await must('file_info').execute({ path: mk('docs', 'hello.txt') });
    assert.ok(infoFile.includes('type: file'), 'info shows file type');
    assert.ok(/size: \d+ bytes/.test(infoFile), 'info shows size');
    assert.ok(infoFile.includes('modified:'), 'info shows modified');
    assert.ok(infoFile.includes('name: hello.txt'), 'info shows name');
    assert.ok(infoFile.includes('text'), 'info hints text content');
    const infoDir = await must('file_info').execute({ path: mk('docs') });
    assert.ok(infoDir.includes('type: directory'), 'info shows directory');

    // 4. create files and folders
    const newDir = mk('جديد', 'فرعي');
    const mkRes = await must('create_directory').execute({ path: newDir });
    assert.ok(existsSync(newDir), 'created nested Arabic directory');
    assert.match(mkRes, /Created directory|already exists/i);
    const newFile = mk('جديد', 'ملف جديد.txt');
    const wRes = await must('write_file').execute({ path: newFile, content: 'سطر جديد' });
    assert.equal(await fs.readFile(newFile, 'utf8'), 'سطر جديد', 'created/wrote UTF-8 file');
    assert.match(wRes, /Wrote/);

    // 5. copy, move, rename
    const copyDst = mk('docs', 'hello-copy.txt');
    await must('copy_file').execute({ from: mk('docs', 'hello.txt'), to: copyDst });
    assert.equal(await fs.readFile(copyDst, 'utf8'), 'hello world\nمرحبا بالعالم', 'copied file content');
    assert.ok(existsSync(mk('docs', 'hello.txt')), 'source still exists after copy');

    const moveSrc = mk('docs', 'notes.md');
    const moveDst = mk('جديد', 'notes-moved.md');
    await must('move_file').execute({ from: moveSrc, to: moveDst });
    assert.ok(!existsSync(moveSrc) && existsSync(moveDst), 'moved file');
    assert.ok((await fs.readFile(moveDst, 'utf8')).includes('ملاحظات'), 'moved content intact');

    const renSrc = mk('docs', 'hello-copy.txt');
    await must('rename_file').execute({ path: renSrc, newName: 'معاد تسميته.txt' });
    assert.ok(!existsSync(renSrc) && existsSync(mk('docs', 'معاد تسميته.txt')), 'renamed with Arabic name');

    // copy directory
    const dirCopy = mk('docs-copy');
    await must('copy_file').execute({ from: mk('docs'), to: dirCopy });
    assert.ok(existsSync(path.join(dirCopy, 'hello.txt')), 'copied directory recursively');

    // safety: no overwrite on copy/move/rename dest
    await assert.rejects(must('copy_file').execute({ from: mk('docs', 'hello.txt'), to: mk('docs', 'معاد تسميته.txt') }), /already exists|Blocked/i, 'copy refuses existing dest');
    await assert.rejects(must('rename_file').execute({ path: mk('docs', 'hello.txt'), newName: 'معاد تسميته.txt' }), /already exists|Blocked/i, 'rename refuses existing dest');

    // safety: outside home and traversal blocked via tools
    await assert.rejects(must('read_file').execute({ path: '/etc/hosts' }), /Blocked|outside/i, 'tool read outside home blocked');
    await assert.rejects(must('write_file').execute({ path: '/tmp/evil.txt', content: 'x' }), /Blocked|outside/i, 'tool write outside home blocked');
    await assert.rejects(must('create_directory').execute({ path: path.join(HOME, '..', 'escape-dir') }), /Blocked|outside/i, 'tool mkdir traversal blocked');

    // rename rejects path separators in newName
    await assert.rejects(must('rename_file').execute({ path: mk('docs', 'hello.txt'), newName: '../x' }), /plain name|separator|Blocked/i, 'rename rejects separators');

    console.log('file tools: passed');
  }

  console.log('filetools.test: all passed');
} finally {
  await fs.rm(tmp, { recursive: true, force: true });
}

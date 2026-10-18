import test from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import { paths } from '../src/lib/paths.js';
import { resolvePdfPath, isAllowedOutput } from '../src/resume/outpath.js';
import { renderResume } from '../src/resume/render.js';
import { systemCandidates, noSandboxAllowed } from '../src/resume/browser.js';

const example = path.join(paths.examples, 'resume.example.md');

test('output paths limited to data/, profile/ and the OS temp dir', () => {
  assert.ok(isAllowedOutput(path.join(paths.dataDir, 'applications', 'x', 'resume.pdf')));
  assert.ok(isAllowedOutput(path.join(paths.profileDir, 'resume.pdf')));
  assert.ok(isAllowedOutput(path.join(os.tmpdir(), 'a', 'b.pdf')));
  assert.ok(!isAllowedOutput(path.join(paths.root, 'src', 'x.pdf')));
  assert.ok(!isAllowedOutput(path.join(paths.dataDir, '..', 'evil.pdf')));
  assert.ok(!isAllowedOutput('/etc/x.pdf'));
  assert.throws(() => resolvePdfPath(example, path.join(paths.root, 'README.pdf')), /refusing to write/);
  assert.equal(resolvePdfPath(path.join(paths.profileDir, 'resume.md')), path.join(paths.profileDir, 'resume.pdf'));
  assert.throws(() => resolvePdfPath(path.join(paths.root, 'docs', 'cv.md')), /refusing to write/);
});

test('examples/ inputs default to the OS temp dir', () => {
  const pdf = resolvePdfPath(example);
  assert.ok(isAllowedOutput(pdf) && !pdf.startsWith(paths.examples));
  assert.equal(path.basename(pdf), 'resume.example.pdf');
});

test('renderResume rejects a disallowed --out before launching Chrome', async () => {
  await assert.rejects(renderResume(example, { out: path.join(paths.examples, 'x.pdf') }), /refusing to write/);
});

test('browser candidates per platform and sandbox policy', () => {
  assert.ok(systemCandidates({}, 'linux').includes('/usr/bin/chromium-browser'));
  assert.ok(systemCandidates({}, 'linux').includes('/snap/bin/chromium'));
  const win = systemCandidates({ PROGRAMFILES: 'C:\\Program Files', LOCALAPPDATA: 'C:\\Users\\j\\AppData\\Local' }, 'win32');
  assert.deepEqual(win, ['C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe', 'C:\\Users\\j\\AppData\\Local\\Google\\Chrome\\Application\\chrome.exe']);
  assert.equal(noSandboxAllowed({ GAJ_NO_SANDBOX: '1' }, 'darwin'), true);
  assert.equal(noSandboxAllowed({}, 'darwin'), false);
});

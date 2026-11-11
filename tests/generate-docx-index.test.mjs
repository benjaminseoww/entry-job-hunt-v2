// generate-docx.mjs --report records a Word row in data/pdf-index.tsv without
// importing generate-pdf.mjs. A re-run supersedes the CV row; a cover row for
// the same report survives.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const SCRIPT = join(ROOT, 'generate-docx.mjs');
const MD = `# CV -- Jane Smith

**Location:** Singapore
**Email:** jane@example.com

## Professional Summary

Builds things.

## Work Experience

### Acme Corp -- Toronto, ON

**Software Engineer**
Jan 2026 – Present

- Built parsers
`;

function withWorkspace(fn) {
  const root = mkdtempSync(join(tmpdir(), 'docx-index-'));
  mkdirSync(join(root, 'data'), { recursive: true });
  mkdirSync(join(root, 'output'), { recursive: true });
  writeFileSync(join(root, 'data', 'applications.md'), '# Applications Tracker\n');
  const env = {
    ...process.env,
    CAREER_OPS_ROOT: root,
    CAREER_OPS_DATA_DIR: root,
    CAREER_OPS_TRACKER: '',
    CAREER_OPS_PDF_INDEX: '',
  };
  try {
    return fn({ root, env });
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

function run(root, env, args) {
  return spawnSync(process.execPath, [SCRIPT, ...args], {
    cwd: root,
    env,
    encoding: 'utf8',
    timeout: 60_000,
  });
}

function dataRows(root) {
  const text = readFileSync(join(root, 'data', 'pdf-index.tsv'), 'utf8');
  return text.split('\n').filter((line) => line.trim() && !line.startsWith('#'));
}

test('generate-docx.mjs does not import generate-pdf.mjs', () => {
  const src = readFileSync(SCRIPT, 'utf8');
  assert.doesNotMatch(src, /generate-pdf\.mjs/);
});

test('without --report, generate-docx writes no index row', () => {
  withWorkspace(({ root, env }) => {
    const input = join(root, 'output', 'cv.md');
    const output = join(root, 'output', 'cv.docx');
    writeFileSync(input, MD);
    const r = run(root, env, [input, output, '--json']);
    assert.equal(r.status, 0, r.stderr);
    assert.equal(existsSync(join(root, 'data', 'pdf-index.tsv')), false);
  });
});

test('--report writes a Word CV row; a re-run supersedes it; a cover row survives', () => {
  withWorkspace(({ root, env }) => {
    const input = join(root, 'output', 'cv.md');
    const output = join(root, 'output', 'cv.docx');
    writeFileSync(input, MD);
    writeFileSync(
      join(root, 'data', 'pdf-index.tsv'),
      '# report\tpdf\thtml\tformat\tdate\tkind\n7\toutput/cover-acme.docx\t\tletter\t2026-01-01\tcover\n',
    );

    const first = run(root, env, [input, output, '--report=7', '--json']);
    assert.equal(first.status, 0, first.stderr);
    let rows = dataRows(root);
    assert.equal(rows.length, 2);
    assert.ok(rows.some((row) => row.endsWith('\tcover')));
    assert.ok(rows.some((row) => row.includes('output/cv.docx') && row.endsWith('\tcv')));
    assert.match(readFileSync(join(root, 'data', 'pdf-index.tsv'), 'utf8'), /generate-pdf\.mjs \/ generate-docx\.mjs/);

    const output2 = join(root, 'output', 'cv-2.docx');
    const second = run(root, env, [input, output2, '--report=7', '--json']);
    assert.equal(second.status, 0, second.stderr);
    rows = dataRows(root);
    assert.equal(rows.length, 2, rows.join('\n'));
    assert.ok(rows.some((row) => row.includes('output/cover-acme.docx') && row.endsWith('\tcover')));
    assert.ok(rows.some((row) => row.includes('output/cv-2.docx') && row.endsWith('\tcv')));
    assert.ok(!rows.some((row) => row.includes('\toutput/cv.docx\t')));
  });
});

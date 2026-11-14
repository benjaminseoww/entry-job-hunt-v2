// Auto-detected Word CVs archive as submitted_cv.docx. --clean-output also
// removes the indexed .md companion when it sits inside output/.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));

function withWorkspace(fn) {
  const root = mkdtempSync(join(tmpdir(), 'outcome-docx-'));
  mkdirSync(join(root, 'data'), { recursive: true });
  mkdirSync(join(root, 'output'), { recursive: true });
  mkdirSync(join(root, 'reports'), { recursive: true });
  writeFileSync(join(root, 'cv.md'), '# Master CV\n');
  writeFileSync(
    join(root, 'data', 'applications.md'),
    `# Applications Tracker

| # | Date | Company | Role | Score | Status | Word | Report | Notes |
|---|------|---------|------|-------|--------|------|--------|-------|
| 1 | 2026-01-01 | Acme | Engineer | 4.2/5 | Applied | ✅ | [1](../reports/001-acme-2026-01-01.md) | indexed word |
`,
  );
  writeFileSync(join(root, 'reports', '001-acme-2026-01-01.md'), '**URL:** https://example.test/1\n');
  writeFileSync(join(root, 'output', 'cv-acme.docx'), 'PK-docx-bytes');
  writeFileSync(join(root, 'output', 'cv-acme.md'), '# tailored\n');
  writeFileSync(
    join(root, 'data', 'pdf-index.tsv'),
    '1\toutput/cv-acme.docx\toutput/cv-acme.md\tletter\t2026-01-01\tcv\n',
  );
  const outside = join(root, 'outside.md');
  writeFileSync(outside, '# do not delete\n');
  const env = {
    ...process.env,
    CAREER_OPS_ROOT: root,
    CAREER_OPS_DATA_DIR: root,
    CAREER_OPS_TRACKER: join(root, 'data', 'applications.md'),
    CAREER_OPS_PDF_INDEX: '',
    CAREER_OPS_TRACKER_LOCK_TIMEOUT_MS: '100',
    CAREER_OPS_TRACKER_LOCK_RETRY_MS: '10',
  };
  try {
    return fn({ root, outside, env });
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

function run(root, env, args) {
  return spawnSync(process.execPath, [join(ROOT, 'outcome.mjs'), ...args], {
    env,
    encoding: 'utf8',
    timeout: 60_000,
    cwd: root,
  });
}

test('an auto-detected .docx is archived as submitted_cv.docx', () => {
  withWorkspace(({ root, env }) => {
    const r = run(root, env, ['1', 'rejected', '--json']);
    assert.equal(r.status, 0, r.stderr + r.stdout);
    const result = JSON.parse(r.stdout);
    assert.equal(readFileSync(join(result.outcomeDir, 'submitted_cv.docx'), 'utf8'), 'PK-docx-bytes');
    assert.equal(existsSync(join(result.outcomeDir, 'submitted_cv.pdf')), false);
  });
});

test('Case B resolves a data-relative ../output/ Word link without an index row', () => {
  withWorkspace(({ root, env }) => {
    writeFileSync(
      join(root, 'data', 'applications.md'),
      `# Applications Tracker

| # | Date | Company | Role | Score | Status | Word | Report | Notes |
|---|------|---------|------|-------|--------|------|--------|-------|
| 1 | 2026-01-01 | Acme | Engineer | 4.2/5 | Applied | [Word](../output/cv-acme.docx) | [1](../reports/001-acme-2026-01-01.md) | linked word |
`,
    );
    writeFileSync(join(root, 'data', 'pdf-index.tsv'), '');
    const r = run(root, env, ['1', 'rejected', '--json']);
    assert.equal(r.status, 0, r.stderr + r.stdout);
    const result = JSON.parse(r.stdout);
    assert.equal(readFileSync(join(result.outcomeDir, 'submitted_cv.docx'), 'utf8'), 'PK-docx-bytes');
  });
});

test('--clean-output removes the Word file and its .md companion inside output/, never a path outside', () => {
  withWorkspace(({ root, outside, env }) => {
    const r = run(root, env, ['1', 'rejected', '--clean-output', '--json']);
    assert.equal(r.status, 0, r.stderr + r.stdout);
    const result = JSON.parse(r.stdout);
    assert.equal(existsSync(join(result.outcomeDir, 'submitted_cv.docx')), true);
    assert.equal(existsSync(join(result.outcomeDir, 'submitted_cv.md')), true);
    assert.equal(existsSync(join(root, 'output', 'cv-acme.docx')), false);
    assert.equal(existsSync(join(root, 'output', 'cv-acme.md')), false);
    assert.equal(readFileSync(outside, 'utf8'), '# do not delete\n');
  });
});

// scripts/docx-backfill.mjs only rewrites cells that already link a Word file.
// Unlinked output/*.docx files are ignored. Dry-run writes nothing.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const SCRIPT = join(ROOT, 'scripts', 'docx-backfill.mjs');

const TRACKER = `# Applications Tracker

| # | Date | Company | Role | Score | Status | Word | Report | Notes |
|---|------|---------|------|-------|--------|------|--------|-------|
| 1 | 2026-01-01 | Acme | Engineer | 4.2/5 | Applied | [docx](output/cv-acme.docx) | [1](reports/001-acme-2026-01-01.md) | linked live |
| 2 | 2026-01-02 | Beta | PM | 3.1/5 | Applied | [Word](output/missing.docx) | [2](reports/002-beta-2026-01-02.md) | linked missing |
| 3 | 2026-01-03 | Gamma | SA | 4.0/5 | Applied | ✅ | [3](reports/003-gamma-2026-01-03.md) | already ready |
| 4 | 2026-01-04 | Delta | QA | 3.8/5 | Applied | ❌️ | [4](reports/004-delta-2026-01-04.md) | fe0f placeholder |
`;

function withFixture(fn) {
  const root = mkdtempSync(join(tmpdir(), 'docx-backfill-'));
  mkdirSync(join(root, 'data'), { recursive: true });
  mkdirSync(join(root, 'output'), { recursive: true });
  writeFileSync(join(root, 'data', 'applications.md'), TRACKER);
  writeFileSync(join(root, 'output', 'cv-acme.docx'), 'PK-docx');
  writeFileSync(join(root, 'output', 'cv-acme.md'), '# tailored\n');
  writeFileSync(join(root, 'output', 'unlinked.docx'), 'PK-orphan');
  const env = {
    ...process.env,
    CAREER_OPS_ROOT: root,
    CAREER_OPS_DATA_DIR: root,
    CAREER_OPS_TRACKER: join(root, 'data', 'applications.md'),
    CAREER_OPS_PDF_INDEX: '',
  };
  try {
    return fn({ root, env });
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

function run(root, env, args = []) {
  return spawnSync(process.execPath, [SCRIPT, ...args], {
    cwd: root,
    env,
    encoding: 'utf8',
    timeout: 30_000,
  });
}

test('dry-run prints the linked-cell diff and ignores unlinked .docx files', () => {
  withFixture(({ root, env }) => {
    const r = run(root, env);
    assert.equal(r.status, 0, r.stderr);
    assert.match(r.stdout, /2 linked Word cell/);
    assert.match(r.stdout, /#1: \[docx\]\(output\/cv-acme\.docx\) → ✅/);
    assert.match(r.stdout, /#2: \[Word\]\(output\/missing\.docx\) → ❌/);
    assert.match(r.stdout, /dry-run/);
    assert.doesNotMatch(r.stdout, /unlinked\.docx/);
    assert.equal(readFileSync(join(root, 'data', 'applications.md'), 'utf8'), TRACKER);
    assert.equal(existsSync(join(root, 'data', 'pdf-index.tsv')), false);
  });
});

test('--write normalises linked cells, indexes existing files, and keeps a backup', () => {
  withFixture(({ root, env }) => {
    const r = run(root, env, ['--write']);
    assert.equal(r.status, 0, r.stderr + r.stdout);
    const tracker = readFileSync(join(root, 'data', 'applications.md'), 'utf8');
    assert.match(tracker, /\| 1 \|[\s\S]*?\| ✅ \|/);
    assert.match(tracker, /\| 2 \|[\s\S]*?\| ❌ \|/);
    assert.doesNotMatch(tracker, /\[docx\]/);
    assert.doesNotMatch(tracker, /\[Word\]/);
    assert.match(tracker, /\| 4 \| 2026-01-04 \| Delta \| QA \| 3\.8\/5 \| Applied \| ❌️ \|/);
    assert.equal(readFileSync(join(root, 'data', 'applications.md.bak'), 'utf8'), TRACKER);

    const index = readFileSync(join(root, 'data', 'pdf-index.tsv'), 'utf8');
    assert.match(index, /output\/cv-acme\.docx/);
    assert.match(index, /output\/cv-acme\.md/);
    assert.doesNotMatch(index, /unlinked\.docx/);
    assert.doesNotMatch(index, /missing\.docx/);
    assert.ok(existsSync(join(root, 'output', 'unlinked.docx')));
  });
});

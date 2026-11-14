// scripts/docx-backfill.mjs rewrites existing [docx]/[Word] tracker cells and
// records them in data/pdf-index.tsv. Dry-run by default.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { planBackfill } from '../scripts/docx-backfill.mjs';

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const SCRIPT = join(ROOT, 'scripts', 'docx-backfill.mjs');

function trackerMd(rows) {
  const lines = [
    '# Applications Tracker',
    '',
    '| # | Date | Company | Role | Score | Status | Word | Report | Notes |',
    '|---|------|---------|------|-------|--------|------|--------|-------|',
  ];
  for (const r of rows) {
    lines.push(
      `| ${r.num} | 2026-01-01 | ${r.company} | Engineer | 4.2/5 | Applied | ${r.pdf} | ${r.report} | ${r.notes ?? ''} |`,
    );
  }
  return `${lines.join('\n')}\n`;
}

function withWorkspace(rows, { files = [], index = '' } = {}, fn) {
  const root = mkdtempSync(join(tmpdir(), 'docx-backfill-'));
  mkdirSync(join(root, 'data'), { recursive: true });
  mkdirSync(join(root, 'output'), { recursive: true });
  writeFileSync(join(root, 'data', 'applications.md'), trackerMd(rows));
  for (const rel of files) {
    writeFileSync(join(root, rel), rel.endsWith('.md') ? '# tailored\n' : 'PK-docx');
  }
  if (index) writeFileSync(join(root, 'data', 'pdf-index.tsv'), index);
  const keys = [
    'CAREER_OPS_ROOT',
    'CAREER_OPS_DATA_DIR',
    'CAREER_OPS_TRACKER',
    'CAREER_OPS_PDF_INDEX',
    'CAREER_OPS_TRACKER_LOCK_TIMEOUT_MS',
    'CAREER_OPS_TRACKER_LOCK_RETRY_MS',
  ];
  const prev = Object.fromEntries(keys.map((k) => [k, process.env[k]]));
  process.env.CAREER_OPS_ROOT = root;
  process.env.CAREER_OPS_DATA_DIR = root;
  process.env.CAREER_OPS_TRACKER = join(root, 'data', 'applications.md');
  process.env.CAREER_OPS_PDF_INDEX = '';
  process.env.CAREER_OPS_TRACKER_LOCK_TIMEOUT_MS = '100';
  process.env.CAREER_OPS_TRACKER_LOCK_RETRY_MS = '10';
  try {
    return fn({ root, env: { ...process.env } });
  } finally {
    for (const [k, v] of Object.entries(prev)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
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

function planOf(root, extraIndex = '') {
  const trackerPath = join(root, 'data', 'applications.md');
  const indexPath = join(root, 'data', 'pdf-index.tsv');
  const indexText = extraIndex || (existsSync(indexPath) ? readFileSync(indexPath, 'utf8') : '');
  return planBackfill({
    trackerText: readFileSync(trackerPath, 'utf8'),
    workspaceRoot: root,
    root,
    indexText,
  });
}

test('generate-docx.mjs does not import generate-pdf.mjs', () => {
  const src = readFileSync(join(ROOT, 'generate-docx.mjs'), 'utf8');
  assert.doesNotMatch(src, /generate-pdf\.mjs/);
});

test('placeholder Word cells are not treated as linked files', () => {
  withWorkspace(
    [{ num: 1, company: 'Acme', pdf: '✅', report: '[1](../reports/001-acme-2026-01-01.md)' }],
    {},
    ({ root }) => {
      const { linked, changes } = planOf(root);
      assert.equal(linked, 0);
      assert.equal(changes.length, 0);
    },
  );
});

test('(a) ../output/ Word link with a file becomes ✅ and an index row', () => {
  withWorkspace(
    [{
      num: 1,
      company: 'Acme',
      pdf: '[Word](../output/cv-acme.docx)',
      report: '[1](../reports/001-acme-2026-01-01.md)',
    }],
    { files: ['output/cv-acme.docx', 'output/cv-acme.md'] },
    ({ root, env }) => {
      const planned = planOf(root);
      assert.equal(planned.changes.length, 1);
      assert.equal(planned.changes[0].to, '✅');
      assert.equal(planned.changes[0].index, true);

      const r = run(root, env, ['--write']);
      assert.equal(r.status, 0, r.stderr + r.stdout);
      const tracker = readFileSync(join(root, 'data', 'applications.md'), 'utf8');
      assert.match(tracker, /\| ✅ \|/);
      assert.doesNotMatch(tracker, /\[Word\]\(\.\.\/output\/cv-acme\.docx\)/);
      const index = readFileSync(join(root, 'data', 'pdf-index.tsv'), 'utf8');
      assert.match(index, /1\toutput\/cv-acme\.docx\toutput\/cv-acme\.md\tletter\t.+\tcv/);
    },
  );
});

test('(b) missing ../output/ Word file becomes ❌ and writes no index row', () => {
  withWorkspace(
    [{
      num: 2,
      company: 'Beta',
      pdf: '[Word](../output/cv-missing.docx)',
      report: '[2](../reports/002-beta-2026-01-01.md)',
    }],
    {},
    ({ root, env }) => {
      const planned = planOf(root);
      assert.equal(planned.changes[0].to, '❌');
      assert.equal(planned.changes[0].index, false);

      const r = run(root, env, ['--write']);
      assert.equal(r.status, 0, r.stderr + r.stdout);
      assert.match(readFileSync(join(root, 'data', 'applications.md'), 'utf8'), /\| ❌ \|/);
      assert.equal(existsSync(join(root, 'data', 'pdf-index.tsv')), false);
    },
  );
});

test('(c) existing cv or legacy index row is kept; cell still becomes ✅', () => {
  withWorkspace(
    [
      {
        num: 3,
        company: 'Gamma',
        pdf: '[Word](../output/cv-gamma.docx)',
        report: '[3](../reports/003-gamma-2026-01-01.md)',
      },
      {
        num: 4,
        company: 'Delta',
        pdf: '[Word](../output/cv-delta.docx)',
        report: '[4](../reports/004-delta-2026-01-01.md)',
      },
    ],
    {
      files: [
        'output/cv-gamma.docx',
        'output/cv-gamma.md',
        'output/cv-delta.docx',
        'output/cv-delta.md',
      ],
      index:
        '# report\tpdf\thtml\tformat\tdate\tkind\n'
        + '3\toutput/cv-gamma.docx\toutput/cv-gamma.md\tletter\t2026-01-01\tcv\n'
        + '4\toutput/cv-delta.docx\toutput/cv-delta.md\tletter\t2026-01-01\n',
    },
    ({ root, env }) => {
      const planned = planOf(root);
      assert.equal(planned.changes.length, 2);
      assert.ok(planned.changes.every((c) => c.to === '✅' && c.keepExisting && !c.index));

      const before = readFileSync(join(root, 'data', 'pdf-index.tsv'), 'utf8');
      const r = run(root, env, ['--write']);
      assert.equal(r.status, 0, r.stderr + r.stdout);
      assert.match(r.stdout, /kept existing row/);
      assert.equal(readFileSync(join(root, 'data', 'pdf-index.tsv'), 'utf8'), before);
      const tracker = readFileSync(join(root, 'data', 'applications.md'), 'utf8');
      assert.equal([...tracker.matchAll(/\| ✅ \|/g)].length, 2);
    },
  );
});

test('(d) the same ../output/ file linked from two rows is left unchanged', () => {
  withWorkspace(
    [
      {
        num: 5,
        company: 'Echo',
        pdf: '[Word](../output/cv-shared.docx)',
        report: '[5](../reports/005-echo-2026-01-01.md)',
      },
      {
        num: 6,
        company: 'Foxtrot',
        pdf: '[Word](../output/cv-shared.docx)',
        report: '[6](../reports/006-foxtrot-2026-01-01.md)',
      },
    ],
    { files: ['output/cv-shared.docx', 'output/cv-shared.md'] },
    ({ root, env }) => {
      const planned = planOf(root);
      assert.equal(planned.changes.length, 0);
      assert.equal(planned.warnings.length, 2);

      const before = readFileSync(join(root, 'data', 'applications.md'), 'utf8');
      const r = run(root, env, ['--write']);
      assert.equal(r.status, 0, r.stderr + r.stdout);
      assert.match(r.stderr + r.stdout, /same file linked from 2\+ rows/);
      assert.equal(readFileSync(join(root, 'data', 'applications.md'), 'utf8'), before);
      assert.equal(existsSync(join(root, 'data', 'pdf-index.tsv')), false);
    },
  );
});

test('(e) a Word link with no unique report number is not indexed from the tracker #', () => {
  withWorkspace(
    [{
      num: 9,
      company: 'NoReport',
      pdf: '[Word](../output/cv-noreport.docx)',
      report: '—',
    }],
    { files: ['output/cv-noreport.docx'] },
    ({ root, env }) => {
      const planned = planOf(root);
      assert.equal(planned.changes.length, 0);
      assert.match(planned.warnings[0], /need exactly one report number/);

      const before = readFileSync(join(root, 'data', 'applications.md'), 'utf8');
      const r = run(root, env, ['--write']);
      assert.equal(r.status, 0, r.stderr + r.stdout);
      assert.equal(readFileSync(join(root, 'data', 'applications.md'), 'utf8'), before);
      assert.equal(existsSync(join(root, 'data', 'pdf-index.tsv')), false);
    },
  );
});

test('(f) links that are not a .docx inside output/ are left unchanged', () => {
  withWorkspace(
    [
      {
        num: 7,
        company: 'Host',
        pdf: '[Word](/etc/hostname)',
        report: '[7](../reports/007-host-2026-01-01.md)',
      },
      {
        num: 8,
        company: 'Pass',
        pdf: '[Word](/etc/passwd.docx)',
        report: '[8](../reports/008-pass-2026-01-01.md)',
      },
    ],
    {},
    ({ root, env }) => {
      const planned = planOf(root);
      assert.equal(planned.changes.length, 0);
      assert.equal(planned.warnings.length, 2);

      const before = readFileSync(join(root, 'data', 'applications.md'), 'utf8');
      const r = run(root, env, ['--write']);
      assert.equal(r.status, 0, r.stderr + r.stdout);
      assert.equal(readFileSync(join(root, 'data', 'applications.md'), 'utf8'), before);
    },
  );
});

test('(g) a backslash Word path still resolves into output/', () => {
  withWorkspace(
    [{
      num: 10,
      company: 'Win',
      pdf: '[Word](output\\cv-win.docx)',
      report: '[10](../reports/010-win-2026-01-01.md)',
    }],
    { files: ['output/cv-win.docx', 'output/cv-win.md'] },
    ({ root }) => {
      const planned = planOf(root);
      assert.equal(planned.changes.length, 1);
      assert.equal(planned.changes[0].to, '✅');
      assert.equal(planned.changes[0].index, true);
    },
  );
});

test('--write writes a timestamped .bak and does not overwrite a fixed .bak name', () => {
  withWorkspace(
    [{
      num: 1,
      company: 'Acme',
      pdf: '[Word](../output/cv-acme.docx)',
      report: '[1](../reports/001-acme-2026-01-01.md)',
    }],
    { files: ['output/cv-acme.docx', 'output/cv-acme.md'] },
    ({ root, env }) => {
      writeFileSync(join(root, 'data', 'applications.md.bak'), 'stale\n');
      const r = run(root, env, ['--write']);
      assert.equal(r.status, 0, r.stderr + r.stdout);
      assert.equal(readFileSync(join(root, 'data', 'applications.md.bak'), 'utf8'), 'stale\n');
      const baks = readdirSync(join(root, 'data')).filter((name) => name.startsWith('applications.md.bak-'));
      assert.equal(baks.length, 1, baks.join(','));
      assert.match(readFileSync(join(root, 'data', baks[0]), 'utf8'), /\[Word\]\(\.\.\/output\/cv-acme\.docx\)/);
    },
  );
});

// tests/verify-cv-facts-docx.test.mjs — the fact gate must read a Word
// resume, not its zip bytes.
//
// `.docx` is a zip of XML. Reading it as UTF-8 feeds the gate PK headers and
// deflated runs, so a fabricated metric inside word/document.xml is invisible
// and a truthful CV can look invented. The CLI extracts the document text
// first, the same way it already strips HTML and LaTeX markup.
//
// Run:  node --test tests/verify-cv-facts-docx.test.mjs

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, rmSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { generateDocx } from '../generate-docx.mjs';
import { extractDocxText } from '../lib/docx-text.mjs';
import { readGeneratedText, verifyFacts } from '../verify-cv-facts.mjs';

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));

const resume = (bullet) => `# CV -- Jane Smith

**Email:** jane@example.com

## Work Experience

### Acme Corp -- Toronto, ON

**Software Engineer**
Jan 2026 – Present

- ${bullet}
`;

function writeDocx(dir, name, bullet) {
  const md = join(dir, `${name}.md`);
  const docx = join(dir, `${name}.docx`);
  writeFileSync(md, resume(bullet));
  const result = generateDocx({ input: md, output: docx });
  assert.equal(result.ok, true, result.error ?? 'generateDocx failed');
  return docx;
}

function runCli(docx, { dataRoot, extra = [] } = {}) {
  return spawnSync(process.execPath, [join(ROOT, 'verify-cv-facts.mjs'), docx, ...extra], {
    cwd: dataRoot,
    encoding: 'utf-8',
    timeout: 30_000,
    env: { ...process.env, CAREER_OPS_ROOT: dataRoot, CAREER_OPS_DATA_DIR: '' },
  });
}

test('readGeneratedText returns the resume words, not zip bytes', () => {
  const dir = mkdtempSync(join(tmpdir(), 'career-ops-facts-docx-text-'));
  try {
    const docx = writeDocx(dir, 'cv', 'Led a team of 4 engineers.');
    const text = readGeneratedText(docx);
    assert.match(text, /Led a team of 4 engineers/);
    assert.doesNotMatch(text, /^PK/);
    assert.equal(text, extractDocxText(readFileSync(docx)));
  } finally {
    rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  }
});

test('a claim copied from cv.md into the .docx is not reported as fabricated', () => {
  const dir = mkdtempSync(join(tmpdir(), 'career-ops-facts-docx-pass-'));
  try {
    writeFileSync(join(dir, 'cv.md'), resume('Led a team of 4 engineers.'));
    const docx = writeDocx(dir, 'out', 'Led a team of 4 engineers.');
    const result = verifyFacts(readGeneratedText(docx), {
      sourcePaths: [join(dir, 'cv.md')],
      configPath: join(dir, 'no-such-cv-facts.json'),
    });
    assert.equal(result.verdict, 'pass');
    assert.deepEqual(result.invented, []);
  } finally {
    rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  }
});

test('an inflated metric in the .docx is blocked', () => {
  const dir = mkdtempSync(join(tmpdir(), 'career-ops-facts-docx-block-'));
  try {
    writeFileSync(join(dir, 'cv.md'), resume('Led a team of 4 engineers.'));
    const docx = writeDocx(dir, 'out', 'Led a team of 40 engineers.');
    const result = verifyFacts(readGeneratedText(docx), {
      sourcePaths: [join(dir, 'cv.md')],
      configPath: join(dir, 'no-such-cv-facts.json'),
    });
    assert.equal(result.verdict, 'block');
    assert.ok(result.invented.some((claim) => /40 engineers/.test(claim)), result.invented.join(', '));
  } finally {
    rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  }
});

test('the CLI extracts a .docx and still reads a .md as text', () => {
  const dir = mkdtempSync(join(tmpdir(), 'career-ops-facts-docx-cli-'));
  try {
    writeFileSync(join(dir, 'cv.md'), resume('Led a team of 4 engineers.'));
    const honest = writeDocx(dir, 'honest', 'Led a team of 4 engineers.');
    const inflated = writeDocx(dir, 'inflated', 'Led a team of 40 engineers.');
    const md = join(dir, 'plain.md');
    writeFileSync(md, resume('Led a team of 4 engineers.'));

    const passDocx = runCli(honest, { dataRoot: dir });
    assert.equal(passDocx.status, 0, passDocx.stderr);
    assert.match(`${passDocx.stdout}${passDocx.stderr}`, /fact check passed/i);

    const blockDocx = runCli(inflated, { dataRoot: dir, extra: ['--json'] });
    assert.equal(blockDocx.status, 1, blockDocx.stderr);
    const parsed = JSON.parse(blockDocx.stdout);
    assert.equal(parsed.verdict, 'block');
    assert.ok(parsed.invented.some((claim) => /40 engineers/.test(claim)), parsed.invented.join(', '));

    const passMd = runCli(md, { dataRoot: dir });
    assert.equal(passMd.status, 0, passMd.stderr);
  } finally {
    rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  }
});

test('a file that is not a Word document fails loudly', () => {
  const dir = mkdtempSync(join(tmpdir(), 'career-ops-facts-docx-bad-'));
  try {
    writeFileSync(join(dir, 'cv.md'), resume('Led a team of 4 engineers.'));
    const fake = join(dir, 'fake.docx');
    writeFileSync(fake, 'this is not a zip');
    const r = runCli(fake, { dataRoot: dir });
    assert.equal(r.status, 1);
    assert.match(`${r.stdout}${r.stderr}`, /Not a zip file|ERROR:/i);
  } finally {
    rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  }
});

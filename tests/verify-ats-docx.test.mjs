// tests/verify-ats-docx.test.mjs — verify-ats.mjs scores Word and markdown
// on text-level checks only. Layout checks that need HTML are listed as
// n/a; the HTML path stays the historical scorer.
//
// Run:  node --test tests/verify-ats-docx.test.mjs

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, rmSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { generateDocx } from '../generate-docx.mjs';
import {
  HTML_ONLY_CHECKS,
  auditAts,
  auditAtsFromPath,
  extractPlainHeadings,
  isPass,
  DEFAULT_MIN_SCORE,
} from '../verify-ats.mjs';

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));

const CLEAN_RESUME = `# CV -- Jane Smith

**Email:** jane@example.com
**Phone:** +1 415 555 0100
**Location:** San Francisco, CA

## Professional Summary

Senior backend engineer with a decade of designing reliable, high-throughput
distributed systems. Led platform teams delivering resilient services on
Kubernetes, with a focus on observability, cost efficiency, and clean,
well-tested Python codebases used daily across the organization.

## Work Experience

### Acme Corp -- San Francisco, CA

**Staff Engineer**
Jan 2020 – Present

- Built and operated the core payments platform, reducing incident rates and
  improving deployment cadence across multiple engineering teams.

## Education

### State University -- CA

**B.S. Computer Science**
2018

## Skills

- **Languages:** Python, Kubernetes, Docker, PostgreSQL
- **Tools:** distributed systems, CI/CD pipelines

## Projects

### Tracing toolkit -- open source

**Maintainer**
2022 – Present

- Open-source tracing toolkit adopted by several teams for latency debugging.

## Certifications

Certified Kubernetes Administrator (CNCF), 2022.
`;

const CLEAN_HTML = `<!DOCTYPE html><html lang="en"><head><meta charset="UTF-8">
<style>body{font-family:'Liberation Sans',Arial,sans-serif;} .section-title{font-weight:700;}</style></head><body>
<div class="header"><h1>Jane Smith</h1>
<div class="contact-row"><a href="mailto:jane@example.com">jane@example.com</a> | +1 415 555 0100 | Remote</div></div>
<div class="section"><div class="section-title">Professional Summary</div><p>Senior backend engineer with a
decade building reliable, high-throughput distributed systems on Kubernetes, with a focus on observability,
cost efficiency and clean, well-tested Python services used daily across the organization.</p></div>
<div class="section"><div class="section-title">Work Experience</div><p>Staff Engineer, Acme Corp
(2020-present). Built and operated the core payments platform across multiple engineering teams.</p></div>
<div class="section"><div class="section-title">Education</div><p>B.S. Computer Science, 2018.</p></div>
<div class="section"><div class="section-title">Skills</div><p>Python, Kubernetes, Docker, PostgreSQL.</p></div>
</body></html>`;

function withDir(fn) {
  const dir = mkdtempSync(join(tmpdir(), 'career-ops-ats-docx-'));
  try {
    return fn(dir);
  } finally {
    rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  }
}

function writeDocx(dir, name, markdown = CLEAN_RESUME) {
  const md = join(dir, `${name}.md`);
  const docx = join(dir, `${name}.docx`);
  writeFileSync(md, markdown);
  const result = generateDocx({ input: md, output: docx, skipFactCheck: true });
  assert.equal(result.ok, true, result.error ?? 'generateDocx failed');
  return { md, docx };
}

function runCli(file, extra = []) {
  return spawnSync(process.execPath, [join(ROOT, 'verify-ats.mjs'), file, ...extra], {
    cwd: ROOT,
    encoding: 'utf-8',
    timeout: 60_000,
  });
}

function parseJson(proc) {
  assert.equal(proc.error, undefined, proc.error?.message);
  const json = JSON.parse(proc.stdout);
  return json;
}

test('markdown ATX headings and Word uppercase titles are both recognized', () => {
  const mdHeadings = extractPlainHeadings(CLEAN_RESUME);
  assert.ok(mdHeadings.some((h) => h.includes('work experience')));
  assert.ok(mdHeadings.some((h) => h.includes('education')));
  assert.ok(mdHeadings.some((h) => h.includes('skills')));

  const wordHeadings = extractPlainHeadings('JANE SMITH\nWORK EXPERIENCE\nStaff Engineer\nEDUCATION\nSKILLS\n');
  assert.ok(wordHeadings.some((h) => h.includes('work experience')));
  assert.ok(wordHeadings.some((h) => h.includes('education')));
  assert.ok(wordHeadings.some((h) => h.includes('skills')));
  // Sentence-case body copy containing "experience" is not a heading.
  const body = extractPlainHeadings('Senior engineer with a decade of experience designing systems.\n');
  assert.equal(body.some((h) => h.includes('experience')), false);
});

test('node verify-ats.mjs on a .md fixture scores text checks and lists n/a checks', () => {
  withDir((dir) => {
    const md = join(dir, 'cv-jane-smith.md');
    writeFileSync(md, CLEAN_RESUME);
    const proc = runCli(md, ['--json']);
    const json = parseJson(proc);
    assert.equal(proc.status, 0, proc.stderr || proc.stdout);
    assert.equal(json.pass, true);
    assert.ok(json.score >= 80, `expected a high markdown score, got ${json.score}`);
    assert.deepEqual(json.naChecks, HTML_ONLY_CHECKS);
    for (const check of HTML_ONLY_CHECKS) {
      assert.ok(
        json.issues.some((i) => i.severity === 'info' && i.message === `${check}: n/a for markdown`),
        `missing n/a issue for ${check}`,
      );
    }
    assert.equal(json.issues.some((i) => String(i.message).includes('<table>')), false);
  });
});

test('node verify-ats.mjs on a .docx fixture returns a score that lists n/a for Word', () => {
  withDir((dir) => {
    const { docx } = writeDocx(dir, 'cv-jane-smith');
    const proc = runCli(docx, ['--json', '--keywords', 'python,kubernetes,rust']);
    const json = parseJson(proc);
    assert.equal(proc.status, 0, proc.stderr || proc.stdout);
    assert.equal(json.pass, true);
    assert.ok(json.score >= 80, `expected a high Word score, got ${json.score}`);
    assert.deepEqual(json.naChecks, HTML_ONLY_CHECKS);
    for (const check of HTML_ONLY_CHECKS) {
      assert.ok(
        json.issues.some((i) => i.severity === 'info' && i.message === `${check}: n/a for Word`),
        `missing n/a issue for ${check}`,
      );
    }
    assert.equal(json.keywordCoverage.total, 3);
    assert.equal(json.keywordCoverage.found, 2);
    assert.deepEqual(json.keywordCoverage.missing, ['rust']);
    assert.equal(
      json.issues.some((i) => i.severity !== 'info' && /<table>|multi-column|non-standard font|charset/i.test(i.message)),
      false,
    );
  });
});

test('a markdown CV missing required headings is flagged, and n/a checks still list', () => {
  withDir((dir) => {
    const md = join(dir, 'thin.md');
    writeFileSync(md, `# CV -- Jane Smith

**Email:** jane@example.com

## Professional Summary

${'Reliable systems work. '.repeat(20)}
`);
    const proc = runCli(md, ['--json']);
    const json = parseJson(proc);
    assert.equal(proc.status, 1);
    assert.equal(json.pass, false);
    assert.ok(json.issues.some((i) => /missing standard section/i.test(i.message)));
    assert.ok(json.issues.some((i) => /Education/i.test(i.message) && /Skills/i.test(i.message)));
    assert.deepEqual(json.naChecks, HTML_ONLY_CHECKS);
  });
});

test('HTML path is unchanged: no naChecks field, tables still fail', () => {
  withDir((dir) => {
    const clean = join(dir, 'clean-cv.html');
    const hostile = join(dir, 'hostile-cv.html');
    writeFileSync(clean, CLEAN_HTML);
    writeFileSync(hostile, `<html><head><style>body{font-family:'Comic Sans MS',cursive;}</style></head><body>
<table><tr><td><img src="skills.png"></td><td><h1>John</h1></td></tr>
<tr><td>Experience</td><td>2020</td></tr></table></body></html>`);

    const cleanRes = runCli(clean, ['--json']);
    const cleanJson = parseJson(cleanRes);
    assert.equal(cleanRes.status, 0);
    assert.equal(cleanJson.pass, true);
    assert.ok(cleanJson.score >= 80);
    assert.equal('naChecks' in cleanJson, false);
    assert.equal(cleanJson.issues.some((i) => /n\/a for Word/i.test(i.message)), false);

    const imported = auditAts(CLEAN_HTML);
    assert.equal('naChecks' in imported, false);
    assert.equal(imported.score, cleanJson.score);

    const hostileRes = runCli(hostile, ['--json']);
    const hostileJson = parseJson(hostileRes);
    const messages = hostileJson.issues.map((i) => i.message.toLowerCase());
    assert.equal(hostileRes.status, 1);
    assert.equal(hostileJson.pass, false);
    assert.equal('naChecks' in hostileJson, false);
    assert.ok(messages.some((m) => m.includes('<table>')));
    assert.ok(messages.some((m) => m.includes('education') || m.includes('skills')));
  });
});

test('auditAtsFromPath reads .docx through lib/docx-text.mjs, not as zip bytes', () => {
  withDir((dir) => {
    const { docx } = writeDocx(dir, 'cv-path');
    const raw = readFileSync(docx, 'utf-8');
    assert.ok(raw.startsWith('PK'), 'fixture must be a zip');
    const asHtml = auditAts(raw);
    assert.ok(!isPass(asHtml, DEFAULT_MIN_SCORE), 'zip bytes must not look like a passing HTML CV');
    const fromPath = auditAtsFromPath(docx);
    assert.equal(isPass(fromPath, DEFAULT_MIN_SCORE), true);
    assert.deepEqual(fromPath.naChecks, HTML_ONLY_CHECKS);
  });
});

test('modes/ats.md documents the Word text-level path', () => {
  const mode = readFileSync(join(ROOT, 'modes', 'ats.md'), 'utf-8');
  assert.match(mode, /verify-ats\.mjs output\/cv-jane-smith-acme\.docx --json/);
  assert.match(mode, /n\/a for Word/);
  assert.match(mode, /lib\/docx-text\.mjs/);
  assert.match(mode, /The HTML path is unchanged/);
});

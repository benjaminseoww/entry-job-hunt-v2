// tests/docx-modes-wording.test.mjs — PR 4: format-neutral CV wording, D5
// translated pipeline.md summary headers, and output_format: docx docs.
//
// Run:  node --test tests/docx-modes-wording.test.mjs

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { validateProfile } from '../validate-profile.mjs';

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const read = (rel) => readFileSync(join(ROOT, rel), 'utf8');

// Languages this PR translated, plus English. Do not discover every
// modes/<lang>/pipeline.md — upstream can add e.g. modes/nb whose header
// still says PDF, and that must not fail this fork's tests.
const D5_PIPELINE_HEADERS = [
  'modes/pipeline.md',
  'modes/ar/pipeline.md',
  'modes/da/pipeline.md',
  'modes/de/pipeline.md',
  'modes/es/pipeline.md',
  'modes/fr/pipeline.md',
  'modes/hi/pipeline.md',
  'modes/id/pipeline.md',
  'modes/it/pipeline.md',
  'modes/ja/pipeline.md',
  'modes/ko/pipeline.md',
  'modes/nl/pipeline.md',
  'modes/pl/pipeline.md',
  'modes/pt/pipeline.md',
  'modes/ru/pipeline.md',
  'modes/tr/pipeline.md',
  'modes/ua/pipeline.md',
  'modes/vi/pipeline.md',
  'modes/zh/pipeline.md',
  'modes/zh-TW/pipeline.md',
];

function summaryTableHeader(text) {
  const fences = [...text.matchAll(/```[^\n]*\n([\s\S]*?)```/g)].map((m) => m[1]);
  for (const block of fences) {
    if (/Pending|Processed|- \[/.test(block)) continue;
    const header = block.split('\n').find((line) => line.includes('|') && !/^\s*\|[\s:-]+\|/.test(line));
    if (!header) continue;
    if ((header.match(/\|/g) || []).length >= 5) return header.trim();
  }
  return null;
}

test('pdf.md cross-links the Word path', () => {
  const pdf = read('modes/pdf.md');
  assert.match(pdf, /modes\/docx\.md/);
  assert.match(pdf, /cv\.output_format/);
});

test('auto-pipeline Step 3 heading is format-neutral and still routes docx', () => {
  const auto = read('modes/auto-pipeline.md');
  assert.match(auto, /## Step 3 — Generate CV/);
  assert.doesNotMatch(auto, /## Step 3 — Generate PDF/);
  const step3 = auto.split(/^## Step 3\b/m)[1]?.split(/^## /m)[0] ?? '';
  assert.match(step3, /"docx"/);
  assert.match(step3, /modes\/docx\.md/);
});

test('translated copies that route on output_format include the docx branch', () => {
  const tr = read('modes/tr/auto-pipeline.md');
  const vi = read('modes/vi/pipeline.md');
  assert.match(tr, /"docx"/);
  assert.match(tr, /modes\/docx\.md/);
  assert.match(tr, /"text"/);
  assert.match(tr, /modes\/text\.md/);
  assert.match(vi, /"docx"/);
  assert.match(vi, /modes\/docx\.md/);
});

test('pipeline.md summary table headers say CV, not PDF (D5)', (t) => {
  const pinnedSet = new Set(D5_PIPELINE_HEADERS);
  const discovered = [];
  for (const name of readdirSync(join(ROOT, 'modes'))) {
    const rel = join('modes', name, 'pipeline.md');
    try {
      readFileSync(join(ROOT, rel));
      discovered.push(rel);
    } catch {
      // no pipeline.md in this language dir
    }
  }
  for (const rel of discovered) {
    if (pinnedSet.has(rel)) continue;
    const header = summaryTableHeader(read(rel));
    t.diagnostic(`unpinned ${rel} summary header: ${header ?? '(none)'}`);
  }
  for (const rel of D5_PIPELINE_HEADERS) {
    const header = summaryTableHeader(read(rel));
    assert.ok(header, `${rel} has no summary table header`);
    assert.doesNotMatch(header, /\bPDF\b/, `${rel} summary header still says PDF: ${header}`);
    assert.match(header, /\bCV\b/, `${rel} summary header does not say CV: ${header}`);
  }
});

test('config/profile.example.yml documents output_format docx', () => {
  const line = read('config/profile.example.yml')
    .split(/\r?\n/)
    .find((row) => /^\s*output_format\s*:/.test(row)) ?? '';
  assert.match(line, /"docx"/);
});

test('validate-profile warns on unknown output_format with did-you-mean', () => {
  const example = read('config/profile.example.yml');
  const ok = validateProfile(
    'candidate:\n  full_name: x\ncv:\n  output_format: docx\n',
    example,
  );
  assert.equal(ok.findings.filter((f) => f.code === 'unknown-output-format').length, 0);
  assert.equal(ok.findings.filter((f) => f.level === 'error').length, 0);

  const typo = validateProfile(
    'candidate:\n  full_name: x\ncv:\n  output_format: doxc\n',
    example,
  );
  const warning = typo.findings.find((f) => f.code === 'unknown-output-format');
  assert.ok(warning, 'doxc should warn (this assertion fails on base, which did not check the value)');
  assert.equal(warning.level, 'warn');
  assert.equal(warning.suggestion, 'docx');
  assert.match(warning.message, /did you mean "docx"/);
});

test('docs name generate-docx --report, the backfill script, and the separate plugin', () => {
  const scripts = read('docs/SCRIPTS.md');
  assert.match(scripts, /generate-docx\.mjs[^|\n]*--report=NNN/);
  assert.match(scripts, /Unlike generate-pdf, no row is written without `--report`/);
  assert.match(scripts, /scripts\/docx-backfill\.mjs/);
  assert.match(scripts, /kept existing row/);
  const plugins = read('docs/PLUGINS.md');
  assert.match(plugins, /career-ops-plugin-docx/);
  assert.match(plugins, /separate from this fork's built-in/);
  const tableRow = plugins.split('\n').find((line) => line.includes('career-ops-plugin-docx')) ?? '';
  assert.doesNotMatch(tableRow, /separate from this fork/);
  const readme = read('README.md');
  assert.match(readme, /pdf-index\.tsv/);
  assert.match(readme, /\.docx/);
  assert.match(readme, /The CV's HTML and every PDF must then sit inside that workspace/);
  assert.match(readme, /write check is local \(project, data root or temp dir\)/);
  assert.doesNotMatch(
    readme,
    /generate-pdf\.mjs and generate-docx\.mjs resolve `CAREER_OPS_TRACKER`/,
    'README must not claim generate-docx enforces the tracker workspace',
  );
  const doctor = read('doctor.mjs');
  assert.match(doctor, /Word \(\.docx\) output does not use fonts\//);
});

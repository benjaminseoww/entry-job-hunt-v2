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

test('pipeline.md summary table headers say CV, not PDF (D5)', () => {
  const files = ['modes/pipeline.md'];
  for (const name of readdirSync(join(ROOT, 'modes'))) {
    const rel = join('modes', name, 'pipeline.md');
    try {
      readFileSync(join(ROOT, rel));
      files.push(rel);
    } catch {
      // no pipeline.md in this language dir
    }
  }
  const checked = [];
  for (const rel of files) {
    const header = summaryTableHeader(read(rel));
    if (!header) continue;
    checked.push(rel);
    assert.doesNotMatch(header, /\bPDF\b/, `${rel} summary header still says PDF: ${header}`);
    assert.match(header, /\bCV\b/, `${rel} summary header does not say CV: ${header}`);
  }
  assert.ok(checked.includes('modes/pipeline.md'));
  assert.ok(checked.length >= 15, `expected translated pipeline.md headers, got ${checked.length}: ${checked.join(', ')}`);
});

test('config/profile.example.yml documents output_format docx', () => {
  const line = read('config/profile.example.yml')
    .split(/\r?\n/)
    .find((row) => /^\s*output_format\s*:/.test(row)) ?? '';
  assert.match(line, /"docx"/);
});

test('validate-profile accepts output_format: docx', () => {
  const example = read('config/profile.example.yml');
  const { findings } = validateProfile(
    'candidate:\n  full_name: x\ncv:\n  output_format: docx\n',
    example,
  );
  assert.equal(findings.filter((f) => f.level === 'error').length, 0);
  assert.ok(!findings.some((f) => /docx/i.test(f.message ?? '')));
});

test('docs name generate-docx --report, the backfill script, and the separate plugin', () => {
  const scripts = read('docs/SCRIPTS.md');
  assert.match(scripts, /generate-docx\.mjs[^|\n]*--report=NNN/);
  assert.match(scripts, /scripts\/docx-backfill\.mjs/);
  const plugins = read('docs/PLUGINS.md');
  assert.match(plugins, /career-ops-plugin-docx/);
  assert.match(plugins, /separate from this fork's built-in/);
  const readme = read('README.md');
  assert.match(readme, /pdf-index\.tsv/);
  assert.match(readme, /\.docx/);
  const doctor = read('doctor.mjs');
  assert.match(doctor, /Word \(\.docx\) output does not use fonts\//);
});

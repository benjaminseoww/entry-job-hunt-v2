// tests/docx-mode.test.mjs — modes/docx.md is the Word CV path: it must name
// the output file, run the markdown then .docx fact gates, and run the same
// title/structure checks pdf mode runs against cv.md.
//
// Run:  node --test tests/docx-mode.test.mjs

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const mode = readFileSync(join(ROOT, 'modes', 'docx.md'), 'utf-8');

test('docx mode writes the dated Word file with the report segment', () => {
  assert.match(mode, /output\/cv-\{candidate\}-\{report\}-\{company\}-\{YYYY-MM-DD\}\.docx/);
  assert.match(mode, /output\/cv-\{candidate\}-\{report\}-\{company\}-\{YYYY-MM-DD\}\.md/);
});

test('docx mode fact-gates the markdown, then the .docx', () => {
  const mdGate = mode.indexOf('node verify-cv-facts.mjs output/cv-{candidate}-{report}-{company}-{YYYY-MM-DD}.md');
  const generate = mode.indexOf('node generate-docx.mjs ');
  const docxGate = mode.indexOf('node verify-cv-facts.mjs output/cv-{candidate}-{report}-{company}-{YYYY-MM-DD}.docx');
  assert.ok(mdGate >= 0, 'markdown fact gate is missing');
  assert.ok(generate >= 0, 'generate-docx step is missing');
  assert.ok(docxGate >= 0, '.docx fact gate is missing');
  assert.ok(mdGate < generate && generate < docxGate, 'expected md gate, then generate, then docx gate');
});

test('docx mode runs the title check and structure check against cv.md', () => {
  assert.match(mode, /node cv-title-check\.mjs /);
  assert.match(mode, /node verify-cv-structure\.mjs /);
});

test('docx mode does not write the tracker or the PDF index', () => {
  assert.match(mode, /Leave the tracker's PDF\/Word column alone/);
  assert.match(mode, /does \*\*not\*\* write the tracker CV column or `data\/pdf-index\.tsv`/);
});

test('docx mode shows the markdown shape and a Windows-safe temp path', () => {
  assert.match(mode, /# CV -- Jane Smith/);
  assert.match(mode, /\*\*Email:\*\*/);
  assert.match(mode, /### Acme Corp -- Toronto, ON/);
  assert.match(mode, /\{tmpdir\}/);
});

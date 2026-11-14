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

test('docx mode steps run 18 gate, 19 audit, 20 render, 21 docx gate', () => {
  const s18 = mode.indexOf('\n18. Run the fact gate against the markdown');
  const s19 = mode.indexOf('\n19. **Hiring-manager audit');
  const s20 = mode.indexOf('\n20. Render the Word file');
  const s21 = mode.indexOf('\n21. Run the fact gate against the generated Word file');
  assert.ok(s18 >= 0 && s19 > s18 && s20 > s19 && s21 > s20);
  assert.match(mode, /skip straight to Step 20/);
  assert.doesNotMatch(mode, /skip straight to Step 19/);
});

test('docx mode keeps a single copy of the report template', () => {
  const copies = [...mode.matchAll(/Unmatched \(consider addressing manually\): \{top 3 unmatched\}/g)];
  assert.equal(copies.length, 1);
});

test('docx mode runs the title check and structure check against cv.md', () => {
  assert.match(mode, /node cv-title-check\.mjs /);
  assert.match(mode, /node verify-cv-structure\.mjs /);
});

test('docx mode indexes the Word file and marks the tracker ready', () => {
  assert.match(mode, /--report=\{report number\}/);
  assert.match(mode, /node mark-pdf-ready\.mjs \{report number\}/);
  assert.match(mode, /\*\*PDF:\*\* output\/cv-\{candidate\}-\{report\}-\{company\}-\{YYYY-MM-DD\}\.docx/);
});

test('docx mode shows the markdown shape and a Windows-safe temp path', () => {
  assert.match(mode, /# CV -- Jane Smith/);
  assert.match(mode, /\*\*Email:\*\*/);
  assert.match(mode, /### Acme Corp -- Toronto, ON/);
  assert.match(mode, /\{tmpdir\}/);
});

test('docx mode archives the JD, runs skill-gap, title, structure and keyword coverage', () => {
  assert.match(mode, /jds\/\{slug\}\.md/);
  assert.match(mode, /node jd-skill-gap\.mjs /);
  assert.match(mode, /node cv-title-check\.mjs /);
  assert.match(mode, /node verify-cv-structure\.mjs /);
  assert.match(mode, /node keyword-match\.mjs /);
});

test('docx mode offers a PDF cover letter and never auto-generates it', () => {
  assert.match(mode, /CV \(Word\) generated/);
  assert.match(mode, /modes\/cover\.md/);
  assert.match(mode, /Do not auto-generate the cover letter/);
  assert.match(mode, /may be A4 while the Word CV is always\s+US Letter/);
  assert.doesNotMatch(mode, /Page format: skipped/);
  assert.doesNotMatch(mode, /Detect company location/);
});

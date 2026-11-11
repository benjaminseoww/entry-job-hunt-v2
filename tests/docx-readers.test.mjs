// email.md and apply.md must mention .docx so Word CVs are attached and the
// readable companion (HTML or tailored .md) is what they draft from.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));

test('email.md and apply.md mention .docx', () => {
  const email = readFileSync(join(ROOT, 'modes', 'email.md'), 'utf8');
  const apply = readFileSync(join(ROOT, 'modes', 'apply.md'), 'utf8');
  assert.match(email, /\.docx/);
  assert.match(apply, /\.docx/);
});

test('pipeline.md summary table header is CV', () => {
  const pipeline = readFileSync(join(ROOT, 'modes', 'pipeline.md'), 'utf8');
  assert.match(pipeline, /\| # \| Company \| Role \| Score \| CV \| Recommended action \|/);
});

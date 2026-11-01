#!/usr/bin/env node

/**
 * generate-docx.mjs — render a tailored resume markdown file as a Word
 * document in the Garamond layout of templates/docx/garamond/.
 *
 *   node generate-docx.mjs <tailored.md> <out.docx> [--template=garamond] [--json]
 *
 * Headings and section order come from the markdown exactly as written; the
 * template supplies only the look (see lib/docx-resume.mjs for the three
 * layout-only differences). After writing, the document is read back and its
 * words are compared with the markdown in both directions. Any difference is
 * a failure: the file is removed and the exit code is 1.
 *
 * This script writes the .docx only. It does not touch the tracker, the PDF
 * index or any report; wiring those is a later step.
 *
 * Exit codes: 0 written and verified, 1 failed (bad input, unsupported
 * markdown, content mismatch, unwritable output).
 */

import { mkdirSync, readFileSync, writeFileSync, existsSync, rmSync, realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, extname, join, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { validateFlags } from './lib/cli-flags.mjs';
import { isMainModule } from './lib/is-main-module.mjs';
import { getCareerOpsRoot } from './path-resolver.mjs';
import { buildDocx, compareContent } from './lib/docx-resume.mjs';

const PROJECT_ROOT = dirname(fileURLToPath(import.meta.url));
const KNOWN_FLAGS = ['--template', '--json', '--help', '-h'];
const VALUE_FLAGS = ['--template'];
const USAGE = `Usage:
  node generate-docx.mjs <tailored.md> <out.docx> [--template=garamond] [--json]

Renders a tailored resume markdown file as a Word document. Headings and
section order are taken from the markdown unchanged; the template supplies the
look only. The output is read back and compared with the markdown; any word
gained or lost fails the run and removes the file.

  --template=NAME  template under templates/docx/ (default: garamond)
  --json           print the result as JSON
  --help, -h       show this message`;

function inside(root, target) {
  const r = resolve(root);
  const t = resolve(target);
  return t === r || t.startsWith(r.endsWith(sep) ? r : r + sep);
}

function realOrSelf(p) {
  try { return realpathSync(p); } catch { return resolve(p); }
}

/** Real path of the nearest existing ancestor, so a symlinked parent cannot hide the true target. */
function nearestRealAncestor(p) {
  let dir = resolve(p);
  while (!existsSync(dir) && dirname(dir) !== dir) dir = dirname(dir);
  return realOrSelf(dir);
}

/**
 * Generate and verify one document.
 *
 * @param {{input: string, output: string, template?: string}} args
 * @returns {{ok: true, output: string, bytes: number, sections: number} | {ok: false, error: string, missing?: string[], extra?: string[]}}
 */
export function generateDocx({ input, output, template = 'garamond' }) {
  if (!/^[a-z0-9][a-z0-9-]*$/i.test(template)) return { ok: false, error: `Invalid template name: ${template}` };
  if (extname(output).toLowerCase() !== '.docx') return { ok: false, error: `Output must end in .docx: ${output}` };
  const out = resolve(output);
  const allowed = [PROJECT_ROOT, getCareerOpsRoot(), tmpdir()].map(realOrSelf);
  if (!allowed.some((root) => inside(root, nearestRealAncestor(dirname(out))))) {
    return { ok: false, error: 'Refusing to write the .docx outside the project directory' };
  }
  if (!existsSync(input)) return { ok: false, error: `Input not found: ${input}` };

  const templateDir = join(PROJECT_ROOT, 'templates', 'docx', template);
  if (!existsSync(templateDir)) return { ok: false, error: `Template not found: templates/docx/${template}` };

  const markdown = readFileSync(input, 'utf8');
  let built;
  try {
    built = buildDocx(markdown, {
      readTemplatePart: (p) => {
        const file = join(templateDir, p);
        if (!existsSync(file)) throw new Error(`Template part missing: templates/docx/${template}/${p}`);
        return readFileSync(file);
      },
    });
  } catch (error) {
    return { ok: false, error: error.message };
  }

  let comparison;
  try {
    comparison = compareContent(markdown, built.buffer, built.model);
  } catch (error) {
    return { ok: false, error: `Could not read the generated document back: ${error.message}` };
  }
  if (!comparison.ok) {
    return {
      ok: false,
      error: `Generated document does not match the markdown (${comparison.missing.length} missing, ${comparison.extra.length} extra words); nothing written`,
      missing: comparison.missing.slice(0, 20),
      extra: comparison.extra.slice(0, 20),
    };
  }

  try {
    mkdirSync(dirname(out), { recursive: true });
    writeFileSync(out, built.buffer);
  } catch (error) {
    try { rmSync(out, { force: true }); } catch { /* best effort */ }
    return { ok: false, error: `Could not write ${output}: ${error.message}` };
  }
  return { ok: true, output: out, bytes: built.buffer.length, sections: built.model.sections.length };
}

async function main() {
  const argv = process.argv.slice(2);
  validateFlags(argv, KNOWN_FLAGS, USAGE, { valueFlags: VALUE_FLAGS, requireOperand: true });
  const positional = [];
  let template = 'garamond';
  let json = false;
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--json') json = true;
    else if (a.startsWith('--template=')) template = a.slice('--template='.length);
    else if (a === '--template') template = argv[++i];
    else positional.push(a);
  }
  if (positional.length !== 2) {
    console.error(USAGE);
    process.exitCode = 1;
    return;
  }
  const result = generateDocx({ input: positional[0], output: positional[1], template });
  if (json) console.log(JSON.stringify(result, null, 2));
  else if (result.ok) console.log(`Wrote ${result.output} (${result.bytes} bytes, ${result.sections} sections); content verified against the markdown`);
  else {
    console.error(`generate-docx: ${result.error}`);
    if (result.missing?.length) console.error(`  missing from the document: ${result.missing.join(' ')}`);
    if (result.extra?.length) console.error(`  not in the markdown: ${result.extra.join(' ')}`);
  }
  if (!result.ok) process.exitCode = 1;
}

if (isMainModule(import.meta.url)) {
  main().catch((error) => {
    console.error(`generate-docx: ${error.message}`);
    process.exitCode = 1;
  });
}

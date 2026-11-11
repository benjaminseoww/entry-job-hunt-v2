#!/usr/bin/env node

/**
 * generate-docx.mjs — render a tailored resume markdown file as a Word
 * document in the Garamond layout of templates/docx/garamond/.
 *
 *   node generate-docx.mjs <tailored.md> <out.docx> [--template=garamond] [--report=NNN] [--json] [--skip-fact-check]
 *
 * Headings and section order come from the markdown exactly as written; the
 * template supplies only the look (see lib/docx-resume.mjs for the three
 * layout-only differences). The document is read back and its words are
 * compared with the markdown in both directions before anything is written.
 * Any difference is a failure and the exit code is 1.
 *
 * --report records the .docx in data/pdf-index.tsv after a verified write
 * (pdf = the .docx, html = the input .md, format = letter, kind = cv). Without
 * --report no index row is written. The tracker cell is left to
 * mark-pdf-ready.mjs. US Letter only; there is no --format flag.
 *
 * Writes go to a temp file in the real parent directory (random suffix, wx),
 * then renameSync onto the destination basename. rename replaces a symlink
 * instead of following it, so a dangling link cannot smuggle the bytes outside
 * the allowed roots. A failed write deletes only the temp file this run
 * created, never an existing .docx. An existing destination keeps its mode.
 * If the destination is open in Word (EPERM/EBUSY), the rename is retried
 * briefly and the error asks to close the file and retry.
 *
 * Exit codes: 0 written and verified, 1 failed (bad input, unsupported
 * markdown, content mismatch, unwritable output).
 */

import { randomBytes } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync, existsSync, rmSync, realpathSync, renameSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, dirname, extname, join, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { flagValue, hasFlag, validateFlags } from './lib/cli-flags.mjs';
import { isMainModule } from './lib/is-main-module.mjs';
import { recordIndexRow } from './lib/pdf-index.mjs';
import { getCareerOpsRoot } from './path-resolver.mjs';
import { resolveTrackerPath, resolveWorkspaceRootFor } from './tracker-utils.mjs';
import { assertFacts } from './verify-cv-facts.mjs';
import { buildDocx, compareContent, pageLengthWarning } from './lib/docx-resume.mjs';

const PROJECT_ROOT = dirname(fileURLToPath(import.meta.url));
const KNOWN_FLAGS = ['--template', '--json', '--skip-fact-check', '--help', '-h', '--report'];
const VALUE_FLAGS = ['--template', '--report'];
const OUTSIDE_ERROR = 'Refusing to write the .docx outside the project directory, data root, or temp directory';
const USAGE = `Usage:
  node generate-docx.mjs <tailored.md> <out.docx> [--template=garamond] [--report=NNN] [--json] [--skip-fact-check]

Renders a tailored resume markdown file as a Word document. Headings and
section order are taken from the markdown unchanged; the template supplies the
look only. The output is compared with the markdown before it is written; any
word gained or lost fails the run and writes nothing. The fact gate runs when
the data root has a cv.md; a blocked document is not written.

  --template=NAME       template under templates/docx/ (default: garamond)
  --report=NNN          record the .docx in data/pdf-index.tsv for this report
  --json                print the result as JSON
  --skip-fact-check     write without running the fact gate
  --help, -h            show this message`;

function realNative(p) {
  try { return realpathSync.native(p); } catch { return resolve(p); }
}

function inside(root, target) {
  const r = realNative(root);
  const t = realNative(target);
  return t === r || t.startsWith(r.endsWith(sep) ? r : r + sep);
}

function realOrSelf(p) {
  return realNative(p);
}

function allowedRoots() {
  return [PROJECT_ROOT, getCareerOpsRoot(), tmpdir()].map(realOrSelf);
}

function outsideAllowed(target) {
  return !allowedRoots().some((root) => inside(root, target));
}

/** Real path of the nearest existing ancestor, so a symlinked parent cannot hide the true target. */
function nearestRealAncestor(p) {
  let dir = resolve(p);
  while (!existsSync(dir) && dirname(dir) !== dir) dir = dirname(dir);
  return realOrSelf(dir);
}

function sleepSync(ms) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

function renameDocx(tmpPath, destination) {
  const name = basename(destination);
  let lastError;
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      renameSync(tmpPath, destination);
      return;
    } catch (error) {
      lastError = error;
      if (error.code !== 'EPERM' && error.code !== 'EBUSY') throw error;
      if (attempt < 2) sleepSync(100);
    }
  }
  throw new Error(`close ${name} in Word and retry (${lastError.message})`);
}

function writeDocxAtomically(realParent, name, buffer) {
  const destination = join(realParent, name);
  const mode = existsSync(destination) ? statSync(destination).mode & 0o777 : undefined;
  const writeOpts = mode != null ? { flag: 'wx', mode } : { flag: 'wx' };
  let tmpPath;
  let created = false;
  try {
    for (let attempt = 0; attempt < 8; attempt++) {
      tmpPath = join(realParent, `.${name}.${randomBytes(6).toString('hex')}.tmp`);
      try {
        writeFileSync(tmpPath, buffer, writeOpts);
        created = true;
        break;
      } catch (error) {
        if (error.code === 'EEXIST' && attempt < 7) continue;
        throw error;
      }
    }
    if (!created) throw new Error(`Could not create a unique temp file for ${name}`);
    renameDocx(tmpPath, destination);
  } catch (error) {
    if (created) {
      try { rmSync(tmpPath, { force: true }); } catch { /* never delete the destination */ }
    }
    throw error;
  }
  return destination;
}

/**
 * Generate and verify one document.
 *
 * @param {{input: string, output: string, template?: string, skipFactCheck?: boolean}} args
 * @returns {{ok: true, output: string, bytes: number, sections: number, factCheck: {verdict: 'pass'|'skipped', reason?: string}, warning?: string} | {ok: false, error: string, missing?: string[], extra?: string[]}}
 */
export function generateDocx({ input, output, template = 'garamond', skipFactCheck = false }) {
  if (!/^[a-z0-9][a-z0-9-]*$/i.test(template)) return { ok: false, error: `Invalid template name: ${template}` };
  if (extname(output).toLowerCase() !== '.docx') return { ok: false, error: `Output must end in .docx: ${output}` };
  const out = resolve(output);
  const parent = dirname(out);
  const name = basename(out);
  if (outsideAllowed(nearestRealAncestor(parent))) {
    return { ok: false, error: OUTSIDE_ERROR };
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

  let factCheck;
  if (skipFactCheck) {
    factCheck = { verdict: 'skipped', reason: '--skip-fact-check' };
  } else {
    const root = getCareerOpsRoot();
    const cvPath = join(root, 'cv.md');
    if (!existsSync(cvPath)) {
      factCheck = { verdict: 'skipped', reason: `no cv.md in ${root}` };
    } else {
      try {
        assertFacts(markdown, {
          sourcePaths: [cvPath, join(root, 'article-digest.md')],
          configPath: join(root, 'config', 'cv-facts.json'),
          label: basename(input),
          format: 'text',
        });
        factCheck = { verdict: 'pass' };
      } catch (error) {
        return { ok: false, error: error.message };
      }
    }
  }

  try {
    mkdirSync(parent, { recursive: true });
  } catch (error) {
    return { ok: false, error: `Could not write ${output}: ${error.message}` };
  }
  let realParent;
  try {
    realParent = realpathSync.native(parent);
  } catch (error) {
    return { ok: false, error: `Could not write ${output}: ${error.message}` };
  }
  if (outsideAllowed(realParent)) {
    return { ok: false, error: OUTSIDE_ERROR };
  }

  const warning = pageLengthWarning(built.model);
  try {
    writeDocxAtomically(realParent, name, built.buffer);
    return {
      ok: true,
      output: out,
      bytes: built.buffer.length,
      sections: built.model.sections.length,
      factCheck,
      ...(warning ? { warning } : {}),
    };
  } catch (error) {
    return { ok: false, error: `Could not write ${output}: ${error.message}` };
  }
}

async function main() {
  const argv = process.argv.slice(2);
  validateFlags(argv, KNOWN_FLAGS, USAGE, { valueFlags: VALUE_FLAGS, requireOperand: true });
  const positional = [];
  let template = 'garamond';
  let json = false;
  let skipFactCheck = false;
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--json') json = true;
    else if (a === '--skip-fact-check') skipFactCheck = true;
    else if (a.startsWith('--template=')) template = a.slice('--template='.length);
    else if (a === '--template') template = argv[++i];
    else if (a.startsWith('--report=')) continue;
    else if (a === '--report') i += 1;
    else positional.push(a);
  }
  if (positional.length !== 2) {
    console.error(USAGE);
    process.exitCode = 1;
    return;
  }
  const reportNum = hasFlag(argv, '--report') ? flagValue(argv, '--report') : undefined;
  if (reportNum !== undefined && !/^\d+$/.test(String(reportNum))) {
    console.error(`generate-docx: Invalid --report "${reportNum ?? ''}". Use a numeric report number, e.g. --report=42.`);
    process.exitCode = 1;
    return;
  }
  const result = generateDocx({ input: positional[0], output: positional[1], template, skipFactCheck });
  if (result.factCheck?.verdict === 'skipped') {
    console.error(`fact gate skipped: ${result.factCheck.reason}`);
  }
  if (result.ok && reportNum !== undefined) {
    const root = getCareerOpsRoot();
    await recordIndexRow({
      trackerPath: resolveTrackerPath(root),
      workspaceRoot: resolveWorkspaceRootFor(root),
      reportNum,
      file: result.output,
      companion: resolve(positional[0]),
      format: 'letter',
      kind: 'cv',
    });
  }
  if (json) console.log(JSON.stringify(result, null, 2));
  else if (result.ok) {
    console.log(`Wrote ${result.output} (${result.bytes} bytes, ${result.sections} sections); content verified against the markdown`);
    if (result.warning) console.error(`generate-docx: ${result.warning}`);
  } else {
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

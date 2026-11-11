/**
 * Shared writer for data/pdf-index.tsv.
 *
 * generate-pdf.mjs and generate-docx.mjs both record a CV through this module.
 * The `pdf` column holds the artifact path (`.pdf` or `.docx`); readers tell
 * them apart by extension. The `html` column is the readable companion
 * (`.html` for a PDF, tailored `.md` for a Word file). kind is appended last
 * because find.mjs, outcome.mjs and the web reader parse this file positionally.
 */

import { existsSync, mkdirSync, readFileSync } from 'node:fs';
import { basename, dirname, isAbsolute, relative, resolve, sep } from 'node:path';
import { withPipelineLock } from '../pipeline-lock.mjs';
import { resolvePdfIndexPath, writeFileAtomic } from '../tracker-utils.mjs';

export const ARTIFACT_KINDS = ['cv', 'cover'];

export const PDF_INDEX_HEADER =
  '# report\tpdf\thtml\tformat\tdate\tkind - written by generate-pdf.mjs / generate-docx.mjs, do not edit\n';

/**
 * Decide which artifact a render produces, for the manifest's `kind` column.
 *
 * @param {string|undefined} explicit - A caller-declared kind, if any.
 * @param {string} [outputPath] - Destination path, used for inference.
 * @returns {{kind: 'cv'|'cover'|null, source: 'declared'|'name'|'default'}}
 */
export function resolveArtifactKind(explicit, outputPath) {
  if (explicit !== undefined && explicit !== null && String(explicit).trim() !== '') {
    const declared = String(explicit).trim().toLowerCase();
    return ARTIFACT_KINDS.includes(declared)
      ? { kind: declared, source: 'declared' }
      : { kind: null, source: 'declared' };
  }

  const name = basename(outputPath || '').toLowerCase().replace(/\.[^.]*$/, '');
  if (name.startsWith('cv-')) return { kind: 'cv', source: 'name' };
  if (/^cover([-_]|$)/.test(name) || /[-_]cover$/.test(name)) {
    return { kind: 'cover', source: 'name' };
  }
  return { kind: 'cv', source: 'default' };
}

function toWorkspaceRelative(pathValue, rootDir) {
  if (!pathValue) return '';
  const rel = relative(rootDir, resolve(pathValue));
  if (rel === '' || rel === '..' || rel.startsWith(`..${sep}`) || isAbsolute(rel)) return '';
  return rel.split(sep).join('/');
}

/**
 * Merge one generated-artifact row into the manifest's existing data lines.
 *
 * One row per report number AND artifact kind, so a CV and a cover letter for
 * the same application coexist. A regenerated document supersedes only its
 * own kind's slot.
 *
 * @param {string[]} existingLines - Current manifest lines, comments included.
 * @param {{reportNum: string, pdf: string, html: string, format: string, date: string, kind?: 'cv'|'cover'}} row
 * @returns {string[]} Data lines to write, the incoming row last.
 */
export function applyManifestRow(existingLines, row) {
  const normKey = (s) => (s || '').trim().replace(/^0+(?=\d)/, '');
  const incomingKind = row.kind === 'cover' ? 'cover' : 'cv';

  const kept = existingLines.filter((line) => {
    if (!line.trim() || line.startsWith('#')) return false;
    const fields = line.split('\t');
    if (fields[1] === row.pdf) return false;
    if (!row.reportNum || normKey(fields[0]) !== normKey(row.reportNum)) return true;
    const existingKind = (fields[5] || '').trim();
    return incomingKind === 'cover'
      ? existingKind !== 'cover'
      : existingKind === 'cover';
  });

  kept.push([row.reportNum || '', row.pdf, row.html, row.format, row.date, incomingKind].join('\t'));
  return kept;
}

/**
 * Record one artifact in data/pdf-index.tsv under the shared lock.
 *
 * @param {{
 *   trackerPath: string,
 *   workspaceRoot: string,
 *   reportNum?: string,
 *   file: string,
 *   companion?: string,
 *   format?: string,
 *   kind?: 'cv'|'cover',
 *   date?: string,
 * }} args
 * @returns {Promise<string>} The workspace-relative artifact path that was recorded.
 */
export async function recordIndexRow({
  trackerPath,
  workspaceRoot,
  reportNum = '',
  file,
  companion = '',
  format = 'letter',
  kind,
  date,
}) {
  const manifestPath = resolvePdfIndexPath(trackerPath);
  const relFile = toWorkspaceRelative(file, workspaceRoot) || relative(workspaceRoot, resolve(file)).split(sep).join('/');
  const relCompanion = toWorkspaceRelative(companion, workspaceRoot);
  const day = date || new Date().toISOString().slice(0, 10);

  mkdirSync(dirname(manifestPath), { recursive: true });
  return withPipelineLock(manifestPath, () => {
    const existing = existsSync(manifestPath)
      ? readFileSync(manifestPath, 'utf-8').split('\n')
      : [];
    const lines = applyManifestRow(existing, {
      reportNum,
      pdf: relFile,
      html: relCompanion,
      format,
      date: day,
      kind,
    });
    writeFileAtomic(manifestPath, PDF_INDEX_HEADER + lines.join('\n') + '\n');
    return relFile;
  });
}

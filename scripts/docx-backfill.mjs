#!/usr/bin/env node

/**
 * One-off: normalise tracker cells that already link a Word file (D4).
 *
 * Dry-run by default. `--write` takes a timestamped backup of applications.md
 * first. A `[docx](…)` / `[Word](…)` cell becomes ✅ if the linked file exists
 * inside workspace `output/` and is a `.docx`, ❌ if that path is missing.
 * Links that are not a `.docx` inside `output/`, that lack exactly one report
 * number, or that share a file with another row are left unchanged.
 *
 * Tested on fixtures only. Never run against real data/.
 *
 * Usage:
 *   node scripts/docx-backfill.mjs
 *   node scripts/docx-backfill.mjs --write
 */

import { constants, copyFileSync, existsSync, mkdirSync, readFileSync, statSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { validateFlags } from '../lib/cli-flags.mjs';
import { isMainModule } from '../lib/is-main-module.mjs';
import { recordIndexRow } from '../lib/pdf-index.mjs';
import { getCareerOpsRoot } from '../path-resolver.mjs';
import {
  extractTrackerReportNumbers,
  isPlaceholderPdfCell,
  isReadyPdfCell,
  parseTrackerRow,
  resolveColumns,
  soleMarkdownLink,
} from '../tracker-parse.mjs';
import {
  openTrackerTransaction,
  pathIsInsideCanonical,
  rebuildRow,
  resolvePdfIndexPath,
  resolveTrackerPath,
  resolveWorkspaceRootFor,
  trackerLinkDirsFor,
} from '../tracker-utils.mjs';

const KNOWN_FLAGS = ['--write', '--help', '-h'];
const USAGE = `Usage: node scripts/docx-backfill.mjs [--write]

  Dry-run by default. Prints the cells that would change and the index rows
  that would be added. Unlinked output/*.docx files are ignored.

  --write   backup applications.md, then apply the cell and index changes.`;

function normReport(value) {
  return String(value ?? '').trim().replace(/^0+(?=\d)/, '');
}

function indexedCvReports(indexText) {
  const reports = new Set();
  for (const line of String(indexText ?? '').split(/\r?\n/)) {
    if (!line.trim() || line.startsWith('#')) continue;
    const fields = line.split('\t');
    const report = normReport(fields[0]);
    if (!report) continue;
    const kind = (fields[5] ?? '').trim();
    if (kind === 'cover') continue;
    reports.add(report);
  }
  return reports;
}

function wordLinkTarget(cell) {
  const link = soleMarkdownLink(cell);
  if (!link) return null;
  if (!/^(docx|word)$/i.test(link.label)) return null;
  return String(link.target || '').replace(/^local:/, '').trim() || null;
}

function siblingMarkdown(filePath) {
  const md = filePath.replace(/\.docx$/i, '.md');
  return md !== filePath && existsSync(md) && statSync(md).isFile() ? md : '';
}

function resolveWordAbs(target, { linkDirs, workspaceRoot }) {
  const normalized = String(target ?? '').replace(/\\/g, '/');
  if (!/\.docx$/i.test(normalized)) return null;
  const outputDir = join(workspaceRoot, 'output');
  for (const base of [...linkDirs, workspaceRoot]) {
    const abs = resolve(base, normalized);
    if (pathIsInsideCanonical(abs, outputDir)) return abs;
  }
  return null;
}

/**
 * Plan which Word-linked cells to rewrite.
 *
 * Resolves `../output/` against the tracker directory (then the workspace
 * root) after normalising backslashes. Requires a `.docx` inside `output/`
 * and exactly one report number.
 *
 * @param {{ trackerText: string, workspaceRoot: string, root: string, indexText?: string }} args
 */
export function planBackfill({ trackerText, workspaceRoot, root, indexText = '' }) {
  const lines = String(trackerText).split('\n');
  const colmap = resolveColumns(lines);
  if (colmap.pdf == null) {
    return { ok: false, error: 'Tracker has no PDF column', changes: [], warnings: [], linked: 0, lines, colmap };
  }

  const linkDirs = trackerLinkDirsFor(root);
  const existing = indexedCvReports(indexText);
  const candidates = [];

  for (let i = 0; i < lines.length; i++) {
    const row = parseTrackerRow(lines[i], colmap);
    if (!row) continue;
    if (isPlaceholderPdfCell(row.pdf) || isReadyPdfCell(row.pdf)) continue;
    const target = wordLinkTarget(row.pdf);
    if (!target) continue;
    candidates.push({ lineIdx: i, row, from: row.pdf, target });
  }

  const resolved = [];
  for (const cell of candidates) {
    const abs = resolveWordAbs(cell.target, { linkDirs, workspaceRoot });
    if (!abs) {
      resolved.push({ ...cell, action: 'skip', reason: 'not a .docx inside output/' });
      continue;
    }
    const reports = extractTrackerReportNumbers(cell.row.report);
    if (reports.length !== 1) {
      resolved.push({ ...cell, abs, action: 'skip', reason: 'need exactly one report number' });
      continue;
    }
    const file = existsSync(abs) && statSync(abs).isFile();
    resolved.push({ ...cell, abs, reportNum: String(reports[0]), file });
  }

  const counts = new Map();
  for (const item of resolved) {
    if (item.action === 'skip' || !item.abs) continue;
    counts.set(item.abs, (counts.get(item.abs) || 0) + 1);
  }

  const changes = [];
  const warnings = [];
  for (const item of resolved) {
    if (item.action === 'skip') {
      warnings.push(`#${item.row.num}: ${item.reason}`);
      continue;
    }
    if ((counts.get(item.abs) || 0) >= 2) {
      warnings.push(`#${item.row.num}: same file linked from 2+ rows; left unchanged`);
      continue;
    }
    if (!item.file) {
      changes.push({
        lineIdx: item.lineIdx,
        num: item.row.num,
        reportNum: item.reportNum,
        from: item.from,
        to: '❌',
        target: item.target,
        file: null,
        companion: '',
        index: false,
        keepExisting: false,
      });
      continue;
    }
    const keepExisting = existing.has(normReport(item.reportNum));
    changes.push({
      lineIdx: item.lineIdx,
      num: item.row.num,
      reportNum: item.reportNum,
      from: item.from,
      to: '✅',
      target: item.target,
      file: item.abs,
      companion: siblingMarkdown(item.abs),
      index: !keepExisting,
      keepExisting,
    });
  }

  return { ok: true, error: null, changes, warnings, linked: candidates.length, lines, colmap };
}

export function applyCellChanges(lines, colmap, changes) {
  const next = lines.slice();
  for (const change of changes) {
    const parts = next[change.lineIdx].split('|').map((s) => s.trim());
    while (parts.length <= colmap.pdf) parts.push('');
    parts[colmap.pdf] = change.to;
    next[change.lineIdx] = rebuildRow(parts);
  }
  return next;
}

function backupTracker(trackerPath) {
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const bak = `${trackerPath}.bak-${stamp}`;
  copyFileSync(trackerPath, bak, constants.COPYFILE_EXCL);
  return bak;
}

async function main() {
  const argv = process.argv.slice(2);
  validateFlags(argv, KNOWN_FLAGS, USAGE);
  const write = argv.includes('--write');
  const root = getCareerOpsRoot();
  const trackerPath = resolveTrackerPath(root);
  const workspaceRoot = resolveWorkspaceRootFor(root);

  if (!existsSync(trackerPath)) {
    console.error(`docx-backfill: no tracker at ${trackerPath}`);
    process.exitCode = 1;
    return;
  }

  const indexPath = resolvePdfIndexPath(trackerPath);
  const indexText = existsSync(indexPath) ? readFileSync(indexPath, 'utf8') : '';

  let planned;
  let tx = null;
  if (write) {
    tx = await openTrackerTransaction(trackerPath);
    planned = planBackfill({ trackerText: tx.read(), workspaceRoot, root, indexText });
  } else {
    planned = planBackfill({
      trackerText: readFileSync(trackerPath, 'utf8'),
      workspaceRoot,
      root,
      indexText,
    });
  }

  try {
    if (!planned.ok) {
      console.error(`docx-backfill: ${planned.error}`);
      process.exitCode = 1;
      return;
    }

    console.log(`docx-backfill: ${planned.linked} linked Word cell(s)`);
    for (const change of planned.changes) {
      const note = change.keepExisting
        ? 'kept existing row'
        : change.index
          ? `index report=${change.reportNum}`
          : 'missing file';
      console.log(`  #${change.num}: ${change.from} → ${change.to}  ${note}  ${change.target}`);
    }
    for (const warning of planned.warnings) {
      console.warn(`docx-backfill: skipped ${warning}`);
    }

    if (!write) {
      console.log('dry-run: pass --write to apply (creates a timestamped applications.md.bak-…).');
      return;
    }
    if (!planned.changes.length) {
      console.log('docx-backfill: nothing to write');
      return;
    }

    const bak = backupTracker(tx.path);
    console.log(`docx-backfill: backup ${bak}`);
    mkdirSync(dirname(indexPath), { recursive: true });
    for (const change of planned.changes) {
      if (!change.index || !change.file) continue;
      await recordIndexRow({
        trackerPath,
        workspaceRoot,
        reportNum: change.reportNum,
        file: change.file,
        companion: change.companion,
        format: 'letter',
        kind: 'cv',
      });
    }
    const next = applyCellChanges(planned.lines, planned.colmap, planned.changes);
    tx.replace(next.join('\n'));
    console.log(`docx-backfill: wrote ${tx.path}`);
  } finally {
    tx?.close();
  }
}

if (isMainModule(import.meta.url)) {
  main().catch((error) => {
    console.error(`docx-backfill: ${error.message}`);
    process.exitCode = 1;
  });
}

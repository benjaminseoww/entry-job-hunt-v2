#!/usr/bin/env node

/**
 * One-off: normalise tracker cells that already link a Word file (D4).
 *
 * Dry-run by default. `--write` takes a backup of applications.md first.
 * A `[docx](…)` / `[Word](…)` cell becomes ✅ if the linked file exists, ❌
 * otherwise. For each existing linked file it adds the index row the link
 * names (report number from the row, plus a `.md` sibling as companion if
 * that file is present). Unlinked `output/*.docx` files are not listed or
 * indexed.
 *
 * Tested on fixtures only. Never run against real data/ unless Benjamin
 * says so. If a dry run finds no link cells, skip the script.
 *
 * Usage:
 *   node scripts/docx-backfill.mjs
 *   node scripts/docx-backfill.mjs --write
 */

import { copyFileSync, existsSync, readFileSync, statSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
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
  rebuildRow,
  resolveTrackerPath,
  resolveWorkspaceRootFor,
  openTrackerTransaction,
} from '../tracker-utils.mjs';

const KNOWN_FLAGS = ['--write', '--help', '-h'];
const USAGE = `Usage: node scripts/docx-backfill.mjs [--write]

  Dry-run by default. Prints the cells that would change and the index rows
  that would be added. Unlinked output/*.docx files are ignored.

  --write   backup applications.md, then apply the cell and index changes.`;

function isWordLink(cell) {
  const link = soleMarkdownLink(cell);
  if (!link) return null;
  if (!/^(docx|word)$/i.test(link.label)) return null;
  const target = String(link.target || '').replace(/^local:/, '').trim();
  return target || null;
}

function siblingMarkdown(filePath) {
  const md = filePath.replace(/\.docx$/i, '.md');
  return md !== filePath && existsSync(md) && statSync(md).isFile() ? md : '';
}

export function planBackfill({ trackerText, workspaceRoot }) {
  const lines = trackerText.split('\n');
  const colmap = resolveColumns(lines);
  const changes = [];
  if (colmap.pdf == null) {
    return { ok: false, error: 'Tracker has no PDF column', changes: [] };
  }

  for (let i = 0; i < lines.length; i++) {
    const row = parseTrackerRow(lines[i], colmap);
    if (!row) continue;
    // Placeholders (❌/—/-/empty, FE0F-stripped) and ready ✅ stay for
    // mark-pdf-ready / sync-pdf-flags. Only a [docx]/[Word] link is ours.
    if (isPlaceholderPdfCell(row.pdf) || isReadyPdfCell(row.pdf)) continue;
    const target = isWordLink(row.pdf);
    if (!target) continue;
    const abs = resolve(workspaceRoot, target);
    const exists = existsSync(abs) && statSync(abs).isFile();
    const reports = extractTrackerReportNumbers(row.report);
    const reportNum = reports.length === 1 ? String(reports[0]) : (row.num ? String(row.num) : '');
    changes.push({
      lineIdx: i,
      trackerNum: row.num,
      reportNum,
      from: row.pdf,
      cell: exists ? '✅' : '❌',
      file: exists ? abs : null,
      companion: exists ? siblingMarkdown(abs) : '',
      target,
    });
  }

  return { ok: true, error: null, changes, lines, colmap };
}

export function applyCellChanges(lines, colmap, changes) {
  const next = lines.slice();
  for (const change of changes) {
    const parts = next[change.lineIdx].split('|').map((s) => s.trim());
    while (parts.length <= colmap.pdf) parts.push('');
    parts[colmap.pdf] = change.cell;
    next[change.lineIdx] = rebuildRow(parts);
  }
  return next;
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

  let planned;
  let tx = null;
  if (write) {
    tx = await openTrackerTransaction(trackerPath);
    planned = planBackfill({ trackerText: tx.read(), workspaceRoot });
  } else {
    planned = planBackfill({ trackerText: readFileSync(trackerPath, 'utf8'), workspaceRoot });
  }

  try {
    if (!planned.ok) {
      console.error(`docx-backfill: ${planned.error}`);
      process.exitCode = 1;
      return;
    }
    if (planned.changes.length === 0) {
      console.log('docx-backfill: no [docx]/[Word] tracker cells found; nothing to do.');
      return;
    }

    console.log(`docx-backfill: ${planned.changes.length} linked Word cell(s)`);
    for (const change of planned.changes) {
      const index = change.file
        ? `index report=${change.reportNum || '(none)'} file=${change.target}`
        : 'no index (file missing)';
      console.log(`  #${change.trackerNum}: ${change.from} → ${change.cell}  ${index}`);
    }

    if (!write) {
      console.log('dry-run: pass --write to apply (creates applications.md.bak).');
      return;
    }

    const backup = `${tx.path}.bak`;
    copyFileSync(tx.path, backup);
    const next = applyCellChanges(planned.lines, planned.colmap, planned.changes);
    tx.replace(next.join('\n'));
    console.log(`wrote ${tx.path} (backup ${backup})`);

    for (const change of planned.changes) {
      if (!change.file) continue;
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

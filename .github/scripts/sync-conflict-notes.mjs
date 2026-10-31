#!/usr/bin/env node
// Pull-request section for one Copilot try at a career-ops sync merge.
// User-layer paths (in the before list, absent after the restore) are
// described here. Every path still conflicted after that restore is quoted
// from the agent's report, or marked unknown when the report skips it.

import { readFileSync, realpathSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const INTRO = {
  kept: 'Copilot made one try. That try is on this branch. Lint and tests passed.',
  discarded: 'Copilot made one try. That try is not on this branch. Lint or tests failed, so the original conflict markers were restored.',
  partial: 'Copilot made one try. That try is on this branch. At least one hunk is still marked, so this pull request is a draft.',
  failed: 'Copilot made one try and exited with an error. Its edits were not kept. The original conflict markers are on this branch.',
  'not-run': 'Copilot did not run. Conflict markers are still on this branch.',
  'user-only': 'Copilot was not asked to edit a system file. Every conflict was in a user-layer path and was kept as this fork.',
};

/**
 * @param {string} report
 * @returns {Map<string, { handled: string, how: string }>}
 */
export function parseAgentReport(report) {
  const found = new Map();
  const chunks = String(report || '').split(/^### `/m).slice(1);
  for (const chunk of chunks) {
    const newline = chunk.indexOf('\n');
    const heading = (newline === -1 ? chunk : chunk.slice(0, newline)).replace(/`+\s*$/, '').trim();
    const body = newline === -1 ? '' : chunk.slice(newline + 1);
    let handled = '';
    let how = '';
    for (const line of body.split('\n')) {
      const handledMatch = line.match(/\*\*Handled:\*\*\s*(yes|no|unknown)\b/i);
      const howMatch = line.match(/\*\*How:\*\*\s*(.*)$/);
      if (handledMatch) handled = handledMatch[1].toLowerCase();
      if (howMatch) how = howMatch[1].trim();
    }
    if (heading) found.set(heading, { handled, how });
  }
  return found;
}

/**
 * @param {object} input
 * @param {string[]} input.beforeFiles - Unmerged paths before the user-layer restore.
 * @param {string[]} input.afterFiles - Unmerged paths after that restore.
 * @param {string} [input.agentReport]
 * @param {string} input.disposition - kept | discarded | partial | failed | not-run | user-only
 * @returns {string}
 */
export function buildConflictNotes({ beforeFiles, afterFiles, agentReport = '', disposition }) {
  const intro = INTRO[disposition];
  if (!intro) throw new Error(`unknown disposition: ${disposition}`);
  const after = new Set(afterFiles.filter(Boolean));
  const userLayer = beforeFiles.filter((file) => file && !after.has(file));
  const agent = parseAgentReport(agentReport);
  const lines = ['## Merge conflicts', '', intro, ''];

  const section = (file, handled, how) => {
    lines.push(`### \`${file}\``);
    lines.push(`- **Handled:** ${handled}`);
    lines.push(`- **How:** ${how}`);
    lines.push('');
  };

  for (const file of userLayer) {
    section(file, 'yes', "Kept this fork's copy. The release was not applied to this user-layer file.");
  }

  for (const file of afterFiles.filter(Boolean)) {
    if (disposition === 'not-run') {
      section(file, 'no', 'Copilot did not run. The conflict markers are unchanged.');
      continue;
    }
    const note = agent.get(file);
    if (!note || (!note.handled && !note.how)) {
      section(file, 'unknown', 'Copilot did not say what it did with this file.');
      continue;
    }
    section(file, note.handled || 'unknown', note.how || 'Copilot did not say what it did with this file.');
  }

  return `${lines.join('\n').trimEnd()}\n`;
}

function arg(name) {
  const index = process.argv.indexOf(name);
  return index === -1 ? '' : (process.argv[index + 1] || '');
}

function readList(path) {
  if (!path) return [];
  return readFileSync(path, 'utf8').split('\n').filter(Boolean);
}

const isCli = process.argv[1]
  && realpathSync(resolve(process.argv[1])) === realpathSync(fileURLToPath(import.meta.url));
if (isCli) {
  const reportPath = arg('--agent-report');
  process.stdout.write(buildConflictNotes({
    beforeFiles: readList(arg('--before')),
    afterFiles: readList(arg('--after')),
    agentReport: reportPath ? readFileSync(reportPath, 'utf8') : '',
    disposition: arg('--disposition'),
  }));
}

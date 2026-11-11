// The career-ops sync-merge script must not persist a git identity. A
// `git config user.name` / `user.email` write (and the --local / --worktree
// forms) lands in the checkout's config; later local commits, including from
// worktrees that share that config, are then authored as github-actions[bot].
// Identity for that script is GIT_AUTHOR_* / GIT_COMMITTER_* in-process only.

import { readFileSync } from 'node:fs';
import { join, relative } from 'node:path';
import { pass, fail, ROOT } from './helpers.mjs';
import { walkTree } from '../lib/walk-tree.mjs';

console.log('\ngithub git identity — bot identity is process-scoped, never persisted');

const SCRIPT = '.github/scripts/finish-sync-merge.sh';
const FORBIDDEN = /\bgit\s+config(?:\s+--(?:local|worktree))?\s+user\./;
const EXPORTS = [
  'export GIT_AUTHOR_NAME=',
  'export GIT_AUTHOR_EMAIL=',
  'export GIT_COMMITTER_NAME=',
  'export GIT_COMMITTER_EMAIL=',
];

const posix = (abs) => relative(ROOT, abs).split('\\').join('/');

if (
  FORBIDDEN.test('git config user.name')
  && FORBIDDEN.test('git config --local user.email')
  && FORBIDDEN.test('git config --worktree user.name')
  && !FORBIDDEN.test('git config --global core.autocrlf false')
  && !FORBIDDEN.test('git config --global user.name')
) {
  pass('the forbidden pattern matches local/worktree user identity writes only');
} else {
  fail('the forbidden pattern does not distinguish persisted user identity from other git config');
}

const githubRoot = join(ROOT, '.github');
const files = walkTree(githubRoot);
const rels = files.map(posix);
if (rels.includes(SCRIPT)) pass(`${SCRIPT} is in the .github/ walk`);
else fail(`${SCRIPT} was missing from the .github/ walk — the identity gate did not run`);

const hits = [];
for (const abs of files) {
  const text = readFileSync(abs, 'utf8');
  if (text.includes('\0')) continue;
  const rel = posix(abs);
  for (const [i, line] of text.split(/\r?\n/).entries()) {
    if (FORBIDDEN.test(line)) hits.push(`${rel}:${i + 1}: ${line.trim()}`);
  }
}
if (hits.length === 0) {
  pass(`no git config user. write under .github/ (${rels.length} files)`);
} else {
  fail(`git config user. write under .github/:\n${hits.join('\n')}`);
}

const script = readFileSync(join(ROOT, SCRIPT), 'utf8');
const missing = EXPORTS.filter((line) => !new RegExp(`^${line.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}`, 'm').test(script));
if (missing.length === 0) pass(`all four GIT_AUTHOR/GIT_COMMITTER exports are in ${SCRIPT}`);
else fail(`${SCRIPT} is missing process-scoped identity exports:\n${missing.join('\n')}`);

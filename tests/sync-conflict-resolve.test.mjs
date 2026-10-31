// The sync merge keeps user-layer paths on the fork side, and the pull
// request quotes one Copilot try per remaining conflict.

import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pass, fail, hermeticGitEnv } from './helpers.mjs';
import { restoreForkUserLayer } from '../.github/scripts/restore-fork-user-layer.mjs';
import { buildConflictNotes, parseAgentReport, parseCopilotModel } from '../.github/scripts/sync-conflict-notes.mjs';

console.log('\nsync conflict resolve — user layer stays, PR notes quote the try');

const root = mkdtempSync(join(tmpdir(), 'co-sync-conflict-'));
const gitConfig = join(root, 'gitconfig');
writeFileSync(gitConfig, '[user]\n\tname = Test\n\temail = test@example.com\n[init]\n\tdefaultBranch = main\n');
const env = hermeticGitEnv(gitConfig);
const repo = join(root, 'repo');
mkdirSync(repo);

const git = (...args) => execFileSync('git', args, { cwd: repo, env, encoding: 'utf8' }).trim();

try {
  git('init', '-q');
  writeFileSync(join(repo, 'cv.md'), 'base cv\n');
  writeFileSync(join(repo, 'scan.mjs'), 'base scan\n');
  mkdirSync(join(repo, 'data'));
  writeFileSync(join(repo, 'data', 'kept.txt'), 'base data\n');
  git('add', '.');
  git('commit', '-q', '-m', 'base');

  git('checkout', '-q', '-b', 'fork');
  writeFileSync(join(repo, 'cv.md'), 'fork cv\n');
  writeFileSync(join(repo, 'scan.mjs'), 'fork scan\n');
  writeFileSync(join(repo, 'data', 'kept.txt'), 'fork data\n');
  git('add', '.');
  git('commit', '-q', '-m', 'fork');
  const forkSha = git('rev-parse', 'HEAD');

  git('checkout', '-q', 'main');
  writeFileSync(join(repo, 'cv.md'), 'release cv\n');
  writeFileSync(join(repo, 'scan.mjs'), 'release scan\n');
  writeFileSync(join(repo, 'data', 'kept.txt'), 'release data\n');
  writeFileSync(join(repo, 'data', 'added.txt'), 'release only\n');
  git('add', '.');
  git('commit', '-q', '-m', 'release');

  git('checkout', '-q', 'fork');
  let mergeFailed = false;
  try {
    git('merge', '--no-ff', '--no-commit', 'main');
  } catch (err) {
    if (err?.status !== 1) throw err;
    mergeFailed = true;
  }
  if (!mergeFailed) fail('expected cv.md, data/kept.txt, and scan.mjs to conflict');
  else pass('release merge conflicts on files both sides changed');

  const { restored, removed } = restoreForkUserLayer(repo, forkSha, env);
  const cv = readFileSync(join(repo, 'cv.md'), 'utf8');
  const data = readFileSync(join(repo, 'data', 'kept.txt'), 'utf8');
  const scan = readFileSync(join(repo, 'scan.mjs'), 'utf8');
  if (cv === 'fork cv\n' && data === 'fork data\n' && restored.includes('cv.md') && restored.includes('data/kept.txt')) {
    pass('user-layer conflict files are restored to the fork');
  } else {
    fail(`user-layer restore mismatch: cv=${JSON.stringify(cv)} data=${JSON.stringify(data)} restored=${restored.join(',')}`);
  }
  let addedGone = false;
  try {
    readFileSync(join(repo, 'data', 'added.txt'), 'utf8');
  } catch {
    addedGone = true;
  }
  if (addedGone && removed.includes('data/added.txt')) pass('a user-layer file that exists only in the release is removed');
  else fail(`release-only user-layer file still present, removed=${removed.join(',')}`);
  if (scan.includes('<<<<<<<') && scan.includes('release scan') && scan.includes('fork scan')) {
    pass('a system file conflict is left for Copilot');
  } else {
    fail(`scan.mjs was not left conflicted: ${JSON.stringify(scan)}`);
  }

  const report = [
    '### `scan.mjs`',
    '- **Handled:** yes',
    '- **How:** Kept the release timeout and this fork\'s filter in `fetchJobs`.',
    '',
  ].join('\n');
  const parsed = parseAgentReport(report);
  if (parsed.get('scan.mjs')?.handled === 'yes' && parsed.get('scan.mjs')?.how.includes('filter')) {
    pass('agent report sections parse into handled and how');
  } else {
    fail(`report parse failed: ${JSON.stringify([...parsed])}`);
  }

  const copilotLog = [
    '{"type":"session.start","data":{"selectedModel":"auto"}}',
    '{"type":"session.model_change","data":{"newModel":"gpt-6-luna"}}',
    '{"type":"assistant.message","data":{"content":"done"}}',
    'not json',
    '',
  ].join('\n');
  const twoModels = [
    '{"type":"assistant.message","data":{"model":"gpt-6-luna"}}',
    '{"type":"assistant.message","data":{"model":"claude-sonnet-5.5"}}',
  ].join('\n');
  const sessionEvents = [
    '{"type":"session.start","data":{"selectedModel":"auto"}}',
    '{"type":"session.auto_mode_resolved","data":{"chosenModel":"gpt-6-luna"}}',
    '{"type":"assistant.message","data":{"content":"done"}}',
    '{"type":"session.shutdown","data":{"currentModel":"gpt-6-luna","modelMetrics":{"gpt-6-luna":{}}}}',
  ].join('\n');
  if (parseCopilotModel(copilotLog) === 'gpt-6-luna'
    && parseCopilotModel(twoModels) === 'gpt-6-luna, claude-sonnet-5.5'
    && parseCopilotModel(sessionEvents) === 'gpt-6-luna'
    && parseCopilotModel('{"type":"session.start","data":{"selectedModel":"auto"}}') === '') {
    pass('the Copilot session events yield the model that answered');
  } else {
    fail(`model parse failed: ${JSON.stringify(parseCopilotModel(copilotLog))} / ${JSON.stringify(parseCopilotModel(twoModels))} / ${JSON.stringify(parseCopilotModel(sessionEvents))}`);
  }

  const notes = buildConflictNotes({
    beforeFiles: ['cv.md', 'data/kept.txt', 'data/added.txt', 'scan.mjs'],
    afterFiles: ['scan.mjs'],
    agentReport: report,
    copilotLog,
    disposition: 'kept',
  });
  if (notes.includes('## Merge conflicts')
    && notes.includes('That try is on this branch')
    && notes.includes('**Model:** gpt-6-luna')
    && notes.includes('### `cv.md`')
    && notes.includes('user-layer')
    && notes.includes('### `scan.mjs`')
    && notes.includes('Kept the release timeout')) {
    pass('PR notes name each conflict, the model, and how the try handled it');
  } else {
    fail(`notes missing a conflict account:\n${notes}`);
  }

  const skipped = buildConflictNotes({
    beforeFiles: ['scan.mjs'],
    afterFiles: ['scan.mjs'],
    disposition: 'not-run',
  });
  if (skipped.includes('**Handled:** no') && skipped.includes('Copilot did not run') && !skipped.includes('**Model:**')) {
    pass('a skipped try is reported as not handled');
  } else {
    fail(`skipped try was not reported:\n${skipped}`);
  }
} finally {
  rmSync(root, { recursive: true, force: true });
}

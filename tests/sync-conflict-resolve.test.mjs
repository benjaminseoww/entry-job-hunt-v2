// The sync merge keeps user-layer paths on the fork side, puts back GitHub
// workflows that have stayed disabled before Copilot runs, and the pull
// request quotes one Copilot try per remaining conflict.

import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pass, fail, hermeticGitEnv, ROOT } from './helpers.mjs';
import { restoreForkUserLayer } from '../.github/scripts/restore-fork-user-layer.mjs';
import { buildConflictNotes, parseAgentReport, parseCopilotModel } from '../.github/scripts/sync-conflict-notes.mjs';
import {
  followupCommitMessage,
  forkWorkflowStayedDisabled,
  isDisabledForkWorkflow,
  pathsExceptRestored,
  restoreAlwaysDisabledWorkflows,
} from '../.github/scripts/restore-disabled-workflows.mjs';

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
  const keptConflicts = pathsExceptRestored(
    ['.github/workflows/welcome.yml', 'scan.mjs'],
    ['.github/workflows/welcome.yml'],
  );
  const notesAfterStrip = buildConflictNotes({
    beforeFiles: keptConflicts,
    afterFiles: keptConflicts,
    disposition: 'not-run',
  });
  if (keptConflicts.length === 1 && keptConflicts[0] === 'scan.mjs'
    && notesAfterStrip.includes('### `scan.mjs`')
    && notesAfterStrip.includes('Copilot did not run')
    && !notesAfterStrip.includes('welcome.yml')
    && !notesAfterStrip.includes('disabled')) {
    pass('a restored disabled workflow is left out of the conflict list and the pull request notes');
  } else {
    fail(`disabled workflow still appears as a conflict:\n${keptConflicts.join(',')}\n${notesAfterStrip}`);
  }

  if (followupCommitMessage({ restored: ['cv.md'], removed: [] }, { restored: ['.github/workflows/welcome.yml'] })
      === "chore: keep this fork's user-layer files and disabled workflows"
    && followupCommitMessage({ restored: [], removed: [] }, { restored: ['.github/workflows/welcome.yml'] })
      === "chore: keep this fork's disabled workflows"
    && followupCommitMessage({ restored: ['cv.md'], removed: [] }, { restored: [] })
      === "chore: keep this fork's user-layer files") {
    pass('the follow-up commit names only the groups that were restored');
  } else {
    fail('follow-up commit message did not match the restored groups');
  }
} finally {
  rmSync(root, { recursive: true, force: true });
}

const workflowRoot = mkdtempSync(join(tmpdir(), 'co-sync-workflows-'));
const workflowGitConfig = join(workflowRoot, 'gitconfig');
writeFileSync(workflowGitConfig, '[user]\n\tname = Test\n\temail = test@example.com\n[init]\n\tdefaultBranch = main\n');
const workflowEnv = hermeticGitEnv(workflowGitConfig);
const workflowRepo = join(workflowRoot, 'repo');
mkdirSync(workflowRepo);

const stub = (name) => `# Disabled on this fork. This workflow is for the career-ops-hq community repo.
# The file stays so a later release sync keeps this copy instead of restoring it.
name: ${name} (disabled on this fork)

on:
  workflow_dispatch:

jobs:
  disabled:
    if: false
    runs-on: ubuntu-latest
    steps:
      - run: echo "disabled on this fork"
`;
const live = (name, body) => `name: ${name}

on:
  pull_request:

jobs:
  run:
    runs-on: ubuntu-latest
    steps:
      - run: echo ${body}
`;

const workflowGit = (...args) => execFileSync('git', args, { cwd: workflowRepo, env: workflowEnv, encoding: 'utf8' }).trim();
const workflowFile = (name) => join(workflowRepo, '.github', 'workflows', name);

try {
  workflowGit('init', '-q');
  mkdirSync(join(workflowRepo, '.github', 'workflows'), { recursive: true });
  writeFileSync(workflowFile('welcome.yml'), live('Welcome', 'live-base'));
  writeFileSync(workflowFile('stale.yml'), live('Stale', 'live-base'));
  writeFileSync(workflowFile('test.yml'), live('Tests', 'live-base'));
  writeFileSync(join(workflowRepo, 'scan.mjs'), 'base scan\n');
  workflowGit('add', '.');
  workflowGit('commit', '-q', '-m', 'base');

  workflowGit('checkout', '-q', '-b', 'fork');
  writeFileSync(workflowFile('welcome.yml'), stub('welcome'));
  writeFileSync(workflowFile('stale.yml'), stub('stale'));
  writeFileSync(workflowFile('born.yml'), stub('born'));
  writeFileSync(workflowFile('test.yml'), live('Tests', 'fork-live'));
  writeFileSync(join(workflowRepo, 'scan.mjs'), 'fork scan\n');
  workflowGit('add', '.');
  workflowGit('commit', '-q', '-m', 'fork disables community workflows');

  writeFileSync(workflowFile('stale.yml'), live('Stale', 'fork-reenabled'));
  workflowGit('add', '.');
  workflowGit('commit', '-q', '-m', 'fork turns stale back on');
  const forkSha = workflowGit('rev-parse', 'HEAD');

  if (forkWorkflowStayedDisabled(workflowRepo, forkSha, '.github/workflows/welcome.yml', workflowEnv)
    && forkWorkflowStayedDisabled(workflowRepo, forkSha, '.github/workflows/born.yml', workflowEnv)
    && !forkWorkflowStayedDisabled(workflowRepo, forkSha, '.github/workflows/stale.yml', workflowEnv)
    && !forkWorkflowStayedDisabled(workflowRepo, forkSha, '.github/workflows/test.yml', workflowEnv)) {
    pass('a workflow stays disabled only when every version since it was turned off is still the stub');
  } else {
    fail('disabled-workflow history check misclassified a fixture file');
  }

  workflowGit('checkout', '-q', 'main');
  writeFileSync(workflowFile('welcome.yml'), live('Welcome', 'release'));
  writeFileSync(workflowFile('stale.yml'), live('Stale', 'release'));
  writeFileSync(workflowFile('born.yml'), live('Born', 'release'));
  writeFileSync(workflowFile('test.yml'), live('Tests', 'release'));
  writeFileSync(join(workflowRepo, 'scan.mjs'), 'release scan\n');
  workflowGit('add', '.');
  workflowGit('commit', '-q', '-m', 'release');

  workflowGit('checkout', '-q', 'fork');
  let workflowMergeFailed = false;
  try {
    workflowGit('merge', '--no-ff', '--no-commit', 'main');
  } catch (err) {
    if (err?.status !== 1) throw err;
    workflowMergeFailed = true;
  }
  if (!workflowMergeFailed) fail('expected workflow files and scan.mjs to conflict');
  else pass('release merge conflicts on workflows both sides changed');

  const { restored } = restoreAlwaysDisabledWorkflows(workflowRepo, forkSha, workflowEnv);
  const welcome = readFileSync(workflowFile('welcome.yml'), 'utf8');
  const born = readFileSync(workflowFile('born.yml'), 'utf8');
  const stale = readFileSync(workflowFile('stale.yml'), 'utf8');
  const testsYml = readFileSync(workflowFile('test.yml'), 'utf8');
  const unmerged = workflowGit('diff', '--name-only', '--diff-filter=U').split('\n').filter(Boolean);
  if (welcome === stub('welcome') && born === stub('born')
    && restored.includes('.github/workflows/welcome.yml')
    && restored.includes('.github/workflows/born.yml')
    && !restored.includes('.github/workflows/stale.yml')
    && !restored.includes('.github/workflows/test.yml')
    && !welcome.includes('<<<<<<<') && !born.includes('<<<<<<<')
    && !unmerged.includes('.github/workflows/welcome.yml')
    && !unmerged.includes('.github/workflows/born.yml')) {
    pass('workflows that stayed disabled are restored to the fork stub with no conflict markers');
  } else {
    fail(`disabled workflow restore mismatch: restored=${restored.join(',')} unmerged=${unmerged.join(',')}`);
  }
  if (stale.includes('<<<<<<<') && testsYml.includes('<<<<<<<') && unmerged.includes('scan.mjs')) {
    pass('a re-enabled workflow and a live workflow stay conflicted for Copilot');
  } else {
    fail(`expected stale.yml, test.yml, and scan.mjs to stay conflicted:\n${stale}\n${testsYml}\n${unmerged.join(',')}`);
  }
} finally {
  rmSync(workflowRoot, { recursive: true, force: true });
}

const mergeRoot = mkdtempSync(join(tmpdir(), 'co-sync-workflow-merge-'));
const mergeGitConfig = join(mergeRoot, 'gitconfig');
writeFileSync(mergeGitConfig, '[user]\n\tname = Test\n\temail = test@example.com\n[init]\n\tdefaultBranch = main\n');
const mergeEnv = hermeticGitEnv(mergeGitConfig);
const mergeRepo = join(mergeRoot, 'repo');
mkdirSync(mergeRepo);
const mergeGit = (iso, ...args) => execFileSync('git', args, {
  cwd: mergeRepo,
  env: { ...mergeEnv, GIT_AUTHOR_DATE: iso, GIT_COMMITTER_DATE: iso },
  encoding: 'utf8',
}).trim();
const mergeWorkflow = join(mergeRepo, '.github', 'workflows', 'welcome.yml');

try {
  // Same shape as a release sync. The fork turns the workflow off, the release
  // later edits the live file, and the merge keeps the stub. That live edit is
  // on the second parent and is newer than the disable, so a full history log
  // would treat it as a re-enable.
  mergeGit('2020-01-01T00:00:00Z', 'init', '-q');
  mkdirSync(join(mergeRepo, '.github', 'workflows'), { recursive: true });
  writeFileSync(mergeWorkflow, live('Welcome', 'upstream'));
  mergeGit('2020-01-01T00:00:00Z', 'add', '.');
  mergeGit('2020-01-01T00:00:00Z', 'commit', '-q', '-m', 'live workflow');

  mergeGit('2020-01-01T00:00:00Z', 'checkout', '-q', '-b', 'fork');
  writeFileSync(mergeWorkflow, stub('welcome'));
  mergeGit('2020-06-01T00:00:00Z', 'commit', '-q', '-am', 'disable on the fork');

  mergeGit('2020-06-01T00:00:00Z', 'checkout', '-q', 'main');
  writeFileSync(mergeWorkflow, live('Welcome', 'upstream-later'));
  mergeGit('2021-01-01T00:00:00Z', 'commit', '-q', '-am', 'upstream edits the live workflow');

  mergeGit('2021-01-01T00:00:00Z', 'checkout', '-q', 'fork');
  let releaseConflicted = false;
  try {
    mergeGit('2021-02-01T00:00:00Z', 'merge', '--no-ff', '--no-commit', 'main');
  } catch (err) {
    if (err?.status !== 1) throw err;
    releaseConflicted = true;
  }
  if (!releaseConflicted) fail('expected the newer release edit to conflict with the disabled stub');
  mergeGit('2021-02-01T00:00:00Z', 'checkout', '--ours', '--', '.github/workflows/welcome.yml');
  mergeGit('2021-02-01T00:00:00Z', 'add', '--', '.github/workflows/welcome.yml');
  mergeGit('2021-02-01T00:00:00Z', 'commit', '-q', '-m', 'merge release, keep the disabled stub');

  const mergedSha = mergeGit('2021-02-01T00:00:00Z', 'rev-parse', 'HEAD');
  const mergedText = readFileSync(mergeWorkflow, 'utf8');
  if (mergedText === stub('welcome')
    && forkWorkflowStayedDisabled(mergeRepo, mergedSha, '.github/workflows/welcome.yml', mergeEnv)) {
    pass('a newer live edit on the release side does not count against a workflow this fork kept disabled');
  } else {
    fail(`merge history was treated as a re-enable:\n${mergedText}`);
  }
} finally {
  rmSync(mergeRoot, { recursive: true, force: true });
}

{
  const historyRoot = mkdtempSync(join(tmpdir(), 'co-sync-workflow-history-'));
  const historyConfig = join(historyRoot, 'gitconfig');
  writeFileSync(historyConfig, '[user]\n\tname = Test\n\temail = test@example.com\n');
  const historyEnv = hermeticGitEnv(historyConfig);
  try {
    const mismatches = [];
    for (const name of readdirSync(join(ROOT, '.github', 'workflows'))) {
      if (!name.endsWith('.yml') && !name.endsWith('.yaml')) continue;
      const file = `.github/workflows/${name}`;
      const disabledNow = isDisabledForkWorkflow(readFileSync(join(ROOT, file), 'utf8'));
      const stayed = forkWorkflowStayedDisabled(ROOT, 'HEAD', file, historyEnv);
      if (disabledNow !== stayed) mismatches.push(`${file} disabled=${disabledNow} stayed=${stayed}`);
    }
    if (mismatches.length === 0) {
      pass('every workflow disabled on this fork has stayed disabled, and the live ones have not');
    } else {
      fail(`workflow history does not match the current stub:\n${mismatches.join('\n')}`);
    }
  } finally {
    rmSync(historyRoot, { recursive: true, force: true });
  }
}

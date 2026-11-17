// A literal conflict marker in the running script, or bash rereading an in-place
// rewrite, crashed the scheduled sync before it pushed a branch.

import { execFileSync, spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync, mkdirSync, existsSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pass, fail, getBash, ROOT } from './helpers.mjs';

console.log('\nfinish-sync-merge.sh — self-edit safe, no grep-able conflict marker');

const SCRIPT = '.github/scripts/finish-sync-merge.sh';
const SKILL = '.github/skills/resolve-sync-conflicts/SKILL.md';
const scriptPath = join(ROOT, SCRIPT);
const skillPath = join(ROOT, SKILL);
const script = readFileSync(scriptPath, 'utf8');
const skill = readFileSync(skillPath, 'utf8');
const conflictHead = `${'<'.repeat(7)} HEAD`;

function bashWithEnv(bash, script, extraEnv) {
  return execFileSync(bash, ['-c', script], {
    encoding: 'utf8',
    env: { ...process.env, ...extraEnv },
  });
}

{
  const syntax = spawnSync(getBash(), ['-n', scriptPath], { encoding: 'utf8' });
  if (syntax.status === 0) pass(`${SCRIPT} passes bash -n`);
  else fail(`${SCRIPT} bash -n failed:\n${syntax.stderr || syntax.stdout}`);
}

{
  const shellcheck = spawnSync('shellcheck', ['-x', scriptPath], { encoding: 'utf8' });
  if (shellcheck.error && shellcheck.error.code === 'ENOENT') {
    pass('shellcheck is not installed; bash -n is the syntax gate');
  } else if (shellcheck.status === 0) {
    pass(`${SCRIPT} passes shellcheck`);
  } else {
    fail(`${SCRIPT} shellcheck failed:\n${shellcheck.stdout}${shellcheck.stderr}`);
  }
}

if (!script.includes(conflictHead) && !skill.includes(conflictHead)
  && !skill.includes('='.repeat(7)) && !skill.includes('>'.repeat(7))) {
  pass(`${SCRIPT} and ${SKILL} do not contain a git-grep-able conflict marker`);
} else {
  fail(`${SCRIPT} or ${SKILL} still contains a literal conflict marker Copilot greps for`);
}

{
  const grep = spawnSync('git', ['grep', '-n', '-e', conflictHead, '--', SCRIPT], {
    cwd: ROOT,
    encoding: 'utf8',
  });
  if (grep.status === 1 && !grep.stdout.trim()) {
    pass(`git grep ${conflictHead} does not hit ${SCRIPT}`);
  } else {
    fail(`git grep still finds ${SCRIPT}: status=${grep.status} stdout=${JSON.stringify(grep.stdout)}`);
  }
}

if (script.includes("conflict_head=\"${marker_start} HEAD\"")
  && script.includes('git grep -n -e \'${conflict_head}\'')) {
  pass('the Copilot prompt builds the conflict marker at runtime');
} else {
  fail('the Copilot prompt does not interpolate a runtime-built conflict marker');
}

if (script.includes('Ignore .github/skills/resolve-sync-conflicts/SKILL.md and anything under .github/scripts/')
  && skill.includes('Ignore hits in this skill and under `.github/scripts/`')
  && skill.includes('Do not edit `.github/scripts/**`')) {
  pass('the prompt and skill tell Copilot to ignore .github/scripts/');
} else {
  fail('the prompt or skill is missing the .github/scripts/ ignore');
}

if (/^main\(\) \{/m.test(script) && /main "\$@"; exit\s*$/.test(script.trimEnd())) {
  pass(`${SCRIPT} wraps the body in main() and ends with main "$@"; exit on one line`);
} else {
  fail(`${SCRIPT} is missing the main() wrapper that keeps bash from rereading an edited file`);
}

if (script.includes('restore_pre_agent')
  && script.includes('overlay_agent_files')
  && script.includes('save_agent_files')
  && script.includes('worktree_matches_pre_agent')
  && script.includes('assert_only_conflicted_files_differ_from_pre_agent')) {
  pass('after Copilot, the script restores the snapshot and keeps only conflicted files');
} else {
  fail('the post-Copilot restore/overlay contract is missing a check');
}

{
  // Overwrite $0 mid-run; main() already parsed the rest.
  const root = mkdtempSync(join(tmpdir(), 'co-sync-self-edit-'));
  try {
    const wrapped = join(root, 'wrapped.sh');
    writeFileSync(wrapped, `#!/usr/bin/env bash
set -euo pipefail
main() {
  printf '%s\\n' 'else' > "$0"
  echo survived
}
main "$@"; exit
echo unreachable
`);
    const wrappedOut = execFileSync(getBash(), [wrapped], { encoding: 'utf8' }).trim();
    if (wrappedOut === 'survived' && readFileSync(wrapped, 'utf8').trim() === 'else') {
      pass('a main() wrapper still finishes after the running file is overwritten with else');
    } else {
      fail(`wrapped self-edit did not survive: out=${JSON.stringify(wrappedOut)} file=${JSON.stringify(readFileSync(wrapped, 'utf8'))}`);
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

{
  if (!script.includes('main() {')) {
    fail(`cannot insert a self-edit probe: ${SCRIPT} has no main() {`);
  } else {
    const root = mkdtempSync(join(tmpdir(), 'co-sync-script-probe-'));
    try {
      const copy = join(root, 'finish-sync-merge.sh');
      const patched = script.replace(
        'main() {',
        `main() {
  if [ -n "\${FINISH_SYNC_MERGE_SELF_EDIT_PROBE:-}" ]; then
    printf '%s\\n' 'else' > "\${BASH_SOURCE[0]}"
    echo self-edit-probe-ok
    return 0
  fi`,
      );
      if (patched === script) fail('the self-edit probe was not inserted into the script copy');
      writeFileSync(copy, patched);
      const out = execFileSync(getBash(), [copy], {
        encoding: 'utf8',
        env: { ...process.env, FINISH_SYNC_MERGE_SELF_EDIT_PROBE: '1' },
      }).trim();
      const after = readFileSync(copy, 'utf8').trim();
      if (out === 'self-edit-probe-ok' && after === 'else') {
        pass(`${SCRIPT} survives a self-edit of the file bash is executing`);
      } else {
        fail(`script self-edit probe failed: out=${JSON.stringify(out)} file=${JSON.stringify(after)}`);
      }
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  }
}

{
  const bash = getBash();
  const rsync = spawnSync('rsync', ['--version'], { encoding: 'utf8' });
  if (!bash) {
    pass('restore + overlay real functions: no bash on this platform');
  } else if (rsync.error && rsync.error.code === 'ENOENT') {
    pass('restore + overlay real functions: rsync is not installed');
  } else {
    const root = mkdtempSync(join(tmpdir(), 'co-sync-overlay-'));
    try {
      const runnerTemp = join(root, 'runner');
      const pre = join(runnerTemp, 'pre-agent');
      const work = join(root, 'work');
      const agent = join(runnerTemp, 'agent-files');
      mkdirSync(join(pre, 'lib'), { recursive: true });
      mkdirSync(join(work, 'lib'), { recursive: true });
      mkdirSync(join(agent, 'lib'), { recursive: true });
      mkdirSync(join(pre, 'empty-keep'), { recursive: true });
      writeFileSync(join(pre, 'keep-me.txt'), 'fork\n');
      writeFileSync(join(pre, 'link-target.txt'), 'target\n');
      writeFileSync(join(pre, 'lib', 'schema.mjs'), 'original\n');
      writeFileSync(join(work, 'keep-me.txt'), 'fork\n');
      writeFileSync(join(work, 'lib', 'schema.mjs'), 'conflicted-try\n');
      writeFileSync(join(work, 'sneaky.txt'), 'copilot extra\n');
      writeFileSync(join(agent, 'lib', 'schema.mjs'), 'conflicted-try\n');
      writeFileSync(join(runnerTemp, 'conflicts-after.txt'), 'lib/schema.mjs\n');
      writeFileSync(join(runnerTemp, 'index.before'), 'index-backup\n');
      writeFileSync(join(work, 'git-index'), 'stale-index\n');
      symlinkSync('link-target.txt', join(pre, 'keep-link'));

      const overlayEnv = {
        RUNNER_TEMP: runnerTemp,
        GIT_INDEX: join(work, 'git-index'),
        SCRIPT_PATH: scriptPath,
        WORK: work,
      };
      const out = bashWithEnv(bash, `
        set -euo pipefail
        source "$SCRIPT_PATH"
        cd "$WORK"
        restore_pre_agent
        git init -q
        overlay_agent_files
        assert_only_conflicted_files_differ_from_pre_agent
        echo overlay-ok
      `, overlayEnv).trim();

      const kept = readFileSync(join(work, 'keep-me.txt'), 'utf8');
      const overlay = readFileSync(join(work, 'lib', 'schema.mjs'), 'utf8');
      const link = execFileSync('readlink', [join(work, 'keep-link')], { encoding: 'utf8' }).trim();
      if (out === 'overlay-ok' && kept === 'fork\n' && overlay === 'conflicted-try\n'
        && !existsSync(join(work, 'sneaky.txt')) && link === 'link-target.txt'
        && existsSync(join(work, 'empty-keep'))) {
        pass('restore + overlay real functions keep only the conflicted file, plus symlinks and empty dirs');
      } else {
        fail(`overlay contract mismatch: out=${JSON.stringify(out)} keep=${JSON.stringify(kept)} overlay=${JSON.stringify(overlay)} link=${JSON.stringify(link)}`);
      }

      mkdirSync(join(work, 'empty-extra'));
      writeFileSync(join(work, 'sneaky2.txt'), 'nope\n');
      symlinkSync('keep-me.txt', join(work, 'extra-link'));
      let extraCaught = false;
      try {
        bashWithEnv(bash, `
          set -euo pipefail
          source "$SCRIPT_PATH"
          cd "$WORK"
          assert_only_conflicted_files_differ_from_pre_agent
        `, overlayEnv);
      } catch (err) {
        extraCaught = /not in the conflict list/.test(String(err.stderr || err.stdout || err.message));
      }
      if (extraCaught) pass('assert_only_conflicted_files_differ_from_pre_agent flags extra files, symlinks, and empty dirs');
      else fail('assert did not flag extra files/symlinks/empty dirs');
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  }
}

{
  const bash = getBash();
  if (!bash) {
    pass('separator-marker detection: no bash on this platform');
  } else {
    const root = mkdtempSync(join(tmpdir(), 'co-sync-sep-'));
    try {
      const runnerTemp = join(root, 'runner');
      mkdirSync(join(runnerTemp, 'agent-files', 'lib'), { recursive: true });
      writeFileSync(join(runnerTemp, 'conflicts-after.txt'), 'lib/schema.mjs\n');
      writeFileSync(join(runnerTemp, 'agent-files', 'lib', 'schema.mjs'), `${'='.repeat(7)}\nstill conflicted\n`);
      const out = bashWithEnv(bash, `
        set -euo pipefail
        source "$SCRIPT_PATH"
        if agent_left_markers; then echo markers-yes; else echo markers-no; fi
      `, { RUNNER_TEMP: runnerTemp, SCRIPT_PATH: scriptPath }).trim();
      if (out === 'markers-yes') pass('agent_left_markers detects the seven-equals separator');
      else fail(`separator not detected: ${JSON.stringify(out)}`);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  }
}

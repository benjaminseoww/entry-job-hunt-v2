#!/usr/bin/env node
// After a career-ops release merge, put back every GitHub workflow this fork
// has kept disabled. The release still carries the live community workflow, so
// a merge leaves conflict markers in the YAML. Tests then fail on those
// markers before anyone can read the file. Restoring the fork copy here, before
// Copilot runs, keeps the workflow disabled and leaves Copilot the other files.
//
// "Kept disabled" is first-parent history of the fork commit, not the full
// graph. A release merge brings the live upstream file in through the second
// parent. A full log would treat that live file as a later version and refuse
// the restore, which is the case this step exists to handle. Versions from
// before this fork turned the workflow off are the upstream file and do not
// count. A workflow that was turned back on after that, even once, is left
// for Copilot.

import { execFileSync } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';
import { isMainModule } from '../../lib/is-main-module.mjs';
import { pathsFromStageList } from './restore-fork-user-layer.mjs';

const WORKFLOW_PATH = /^\.github\/workflows\/[^/]+\.ya?ml$/;

/**
 * @param {string} file
 * @returns {boolean}
 */
export function isWorkflowPath(file) {
  return WORKFLOW_PATH.test(file);
}

/**
 * The stub this fork commits in place of a community workflow.
 * A real workflow that merely sets `if: false` on one job does not match.
 * @param {string} text
 * @returns {boolean}
 */
export function isDisabledForkWorkflow(text) {
  const src = String(text ?? '').replace(/^\uFEFF/, '');
  const first = src.split('\n').find((line) => line.trim() !== '');
  if (!first?.startsWith('# Disabled on this fork.')) return false;
  if (!/^name:\s+['"]?\S.*\(disabled on this fork\)['"]?\s*$/m.test(src)) return false;
  if (!/^[\t ]+if:\s+false\s*$/m.test(src)) return false;
  if (!/echo ["']disabled on this fork["']/.test(src)) return false;
  return true;
}

/**
 * @param {string} root
 * @param {string[]} args
 * @param {NodeJS.ProcessEnv} env
 * @param {boolean} [allowFail]
 * @returns {string}
 */
function git(root, args, env, allowFail = false) {
  try {
    return execFileSync('git', ['-C', root, ...args], { env, encoding: 'utf8' });
  } catch (err) {
    if (allowFail) return err.stdout?.toString() || '';
    throw err;
  }
}

/**
 * @param {string} text
 * @returns {string[]}
 */
function nulPaths(text) {
  return text.split('\0').filter(Boolean);
}

/**
 * @param {string} root
 * @param {string} forkSha
 * @param {string} file
 * @param {NodeJS.ProcessEnv} [env]
 * @returns {boolean}
 */
export function forkWorkflowStayedDisabled(root, forkSha, file, env = process.env) {
  if (!isWorkflowPath(file)) return false;
  const atFork = git(root, ['show', `${forkSha}:${file}`], env, true);
  if (!isDisabledForkWorkflow(atFork)) return false;

  const log = git(root, [
    'log', '--first-parent', '--reverse', '--format=%H', forkSha, '--', file,
  ], env, true);
  let seenDisabled = false;
  for (const commit of log.split('\n').map((line) => line.trim()).filter(Boolean)) {
    const disabled = isDisabledForkWorkflow(git(root, ['show', `${commit}:${file}`], env, true));
    if (!seenDisabled) {
      if (disabled) seenDisabled = true;
      continue;
    }
    if (!disabled) return false;
  }
  return seenDisabled;
}

/**
 * Check out the fork blob for every workflow that has stayed disabled.
 * A path whose index already matches that blob is left alone.
 *
 * @param {string} root
 * @param {string} forkSha
 * @param {NodeJS.ProcessEnv} [env]
 * @returns {{ restored: string[] }}
 */
export function restoreAlwaysDisabledWorkflows(root, forkSha, env = process.env) {
  const forkFiles = nulPaths(git(root, ['ls-tree', '-r', '--name-only', '-z', forkSha], env));
  const indexFiles = pathsFromStageList(git(root, ['ls-files', '--stage', '-z'], env));
  const candidates = [...new Set([...forkFiles, ...indexFiles])]
    .filter((file) => isWorkflowPath(file))
    .sort();

  const restored = [];
  for (const file of candidates) {
    if (!forkWorkflowStayedDisabled(root, forkSha, file, env)) continue;
    const forkBlob = git(root, ['rev-parse', '-q', '--verify', `${forkSha}:${file}`], env, true).trim();
    const indexBlob = git(root, ['rev-parse', '-q', '--verify', `:${file}`], env, true).trim();
    if (forkBlob && indexBlob === forkBlob) continue;
    git(root, ['checkout', forkSha, '--', file], env);
    restored.push(file);
  }
  return { restored };
}

/**
 * Drop restored workflow paths from the pre-restore conflict list. The pull
 * request notes and the Copilot prompt are built from what remains.
 *
 * @param {string[]} paths
 * @param {string[]} restored
 * @returns {string[]}
 */
export function pathsExceptRestored(paths, restored) {
  const skip = new Set(restored);
  return paths.filter((file) => file && !skip.has(file));
}

/**
 * Follow-up commit when the merge itself was clean and a restore still staged
 * files. The message names only the groups that actually changed.
 *
 * @param {{ restored?: string[], removed?: string[] }} userLayer
 * @param {{ restored?: string[] }} disabledWorkflows
 * @returns {string}
 */
export function followupCommitMessage(userLayer, disabledWorkflows) {
  const user = (userLayer?.restored?.length || 0) + (userLayer?.removed?.length || 0);
  const disabled = disabledWorkflows?.restored?.length || 0;
  if (user && disabled) return "chore: keep this fork's user-layer files and disabled workflows";
  if (disabled) return "chore: keep this fork's disabled workflows";
  return "chore: keep this fork's user-layer files";
}

const USAGE = `Usage:
  node .github/scripts/restore-disabled-workflows.mjs <fork-sha>
  node .github/scripts/restore-disabled-workflows.mjs --strip-list <restored-json> <paths-file>
  node .github/scripts/restore-disabled-workflows.mjs --followup-message <user-layer-json> <disabled-json>

  <fork-sha>              checkout workflows that stayed disabled on this fork
  --strip-list            drop restored workflow paths from a path list
  --followup-message      print the follow-up commit message
  --help, -h              print this and exit`;

if (isMainModule(import.meta.url)) {
  if (process.argv.slice(2).some((arg) => arg === '--help' || arg === '-h')) {
    console.log(USAGE);
    process.exit(0);
  }
  if (process.argv[2] === '--strip-list') {
    const restored = JSON.parse(readFileSync(process.argv[3], 'utf8')).restored || [];
    const kept = pathsExceptRestored(readFileSync(process.argv[4], 'utf8').split('\n'), restored);
    writeFileSync(process.argv[4], kept.length ? `${kept.join('\n')}\n` : '');
  } else if (process.argv[2] === '--followup-message') {
    const user = JSON.parse(readFileSync(process.argv[3], 'utf8'));
    const disabled = JSON.parse(readFileSync(process.argv[4], 'utf8'));
    process.stdout.write(followupCommitMessage(user, disabled));
  } else {
    const forkSha = process.argv[2];
    if (!forkSha) {
      console.error('usage: restore-disabled-workflows.mjs <fork-sha>');
      process.exit(2);
    }
    console.log(JSON.stringify(restoreAlwaysDisabledWorkflows(process.cwd(), forkSha)));
  }
}

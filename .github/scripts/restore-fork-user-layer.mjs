#!/usr/bin/env node
// After a career-ops release merge, put every user-layer path back to the
// fork commit. A clean auto-merge of those paths is still interference.
// The caller passes the fork SHA (HEAD before `git merge`).

import { execFileSync } from 'node:child_process';
import { isMainModule } from '../../lib/is-main-module.mjs';
import { effectiveUserPaths } from '../../update-system.mjs';

/**
 * @param {string} file
 * @param {string[]} userPaths
 * @returns {boolean}
 */
export function isUserLayerPath(file, userPaths) {
  return userPaths.some((userPath) => (
    userPath.endsWith('/') ? file.startsWith(userPath) : file === userPath
  ));
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
 * @param {string} text - NUL-delimited git output.
 * @returns {string[]}
 */
function nulPaths(text) {
  return text.split('\0').filter(Boolean);
}

/**
 * Paths in the index, including unmerged stages. `ls-files --stage -z` lines
 * are `mode SP hash SP stage TAB path`.
 * @param {string} text
 * @returns {string[]}
 */
export function pathsFromStageList(text) {
  const paths = [];
  for (const entry of nulPaths(text)) {
    const tab = entry.indexOf('\t');
    if (tab !== -1) paths.push(entry.slice(tab + 1));
  }
  return paths;
}

/**
 * Restore user-layer paths to `forkSha`. Files the release added under those
 * paths are removed. Files that already match the fork are left alone.
 *
 * @param {string} root
 * @param {string} forkSha
 * @param {NodeJS.ProcessEnv} [env]
 * @returns {{ restored: string[], removed: string[] }}
 */
export function restoreForkUserLayer(root, forkSha, env = process.env) {
  const userPaths = effectiveUserPaths(root);
  const forkFiles = new Set(nulPaths(git(root, ['ls-tree', '-r', '--name-only', '-z', forkSha], env)));
  const indexFiles = new Set(pathsFromStageList(git(root, ['ls-files', '--stage', '-z'], env)));
  const candidates = [...new Set([...forkFiles, ...indexFiles])]
    .filter((file) => isUserLayerPath(file, userPaths))
    .sort();

  const restored = [];
  const removed = [];
  for (const file of candidates) {
    if (forkFiles.has(file)) {
      const forkBlob = git(root, ['rev-parse', '-q', '--verify', `${forkSha}:${file}`], env, true).trim();
      const indexBlob = git(root, ['rev-parse', '-q', '--verify', `:${file}`], env, true).trim();
      if (forkBlob && indexBlob === forkBlob) continue;
      git(root, ['checkout', forkSha, '--', file], env);
      restored.push(file);
    } else if (indexFiles.has(file)) {
      git(root, ['rm', '-f', '--ignore-unmatch', '--', file], env);
      removed.push(file);
    }
  }
  return { restored, removed };
}

const USAGE = `Usage:
  node .github/scripts/restore-fork-user-layer.mjs <fork-sha>

  <fork-sha>    put user-layer paths back to this commit
  --help, -h    print this and exit`;

if (isMainModule(import.meta.url)) {
  if (process.argv.slice(2).some((arg) => arg === '--help' || arg === '-h')) {
    console.log(USAGE);
    process.exit(0);
  }
  const forkSha = process.argv[2];
  if (!forkSha) {
    console.error('usage: restore-fork-user-layer.mjs <fork-sha>');
    process.exit(2);
  }
  console.log(JSON.stringify(restoreForkUserLayer(process.cwd(), forkSha)));
}

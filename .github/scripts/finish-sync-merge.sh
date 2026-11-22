#!/usr/bin/env bash
# Merge one published career-ops release tag into the branch this run checked
# out (FORK_BRANCH). A schedule run checks out main. A manual run checks out
# the branch selected in workflow_dispatch.
# Keep user-layer paths as this fork has them. Then put back every GitHub
# workflow that has stayed disabled on this fork, so conflict markers never
# land in that YAML. Ask Copilot once to combine whatever conflicts remain.
# Writes $RUNNER_TEMP/conflict-notes.md when any path conflicted, and sets
# GITHUB_OUTPUT conflicted=true|false.

set -euo pipefail

# Built at runtime so this file never contains a git-grep-able conflict marker.
marker_start="$(printf '%.0s<' {1..7})"
marker_end="$(printf '%.0s>' {1..7})"
marker_mid="$(printf '%.0s=' {1..7})"
conflict_head="${marker_start} HEAD"

restore_pre_agent() {
  cp "$RUNNER_TEMP/index.before" "$GIT_INDEX"
  rsync -a --delete --exclude '.git' "$RUNNER_TEMP/pre-agent/" ./
}

overlay_agent_files() {
  local file
  while IFS= read -r file; do
    [ -n "$file" ] || continue
    mkdir -p "$(dirname "$file")"
    cp -a "$RUNNER_TEMP/agent-files/$file" "$file"
  done < "$RUNNER_TEMP/conflicts-after.txt"
  git add --pathspec-from-file="$RUNNER_TEMP/conflicts-after.txt"
}

save_agent_files() {
  local file
  rm -rf "$RUNNER_TEMP/agent-files"
  mkdir -p "$RUNNER_TEMP/agent-files"
  while IFS= read -r file; do
    [ -n "$file" ] || continue
    mkdir -p "$RUNNER_TEMP/agent-files/$(dirname "$file")"
    cp -a "$file" "$RUNNER_TEMP/agent-files/$file"
  done < "$RUNNER_TEMP/conflicts-after.txt"
}

agent_left_markers() {
  local file
  while IFS= read -r file; do
    [ -n "$file" ] || continue
    if grep -q -E "^(${marker_start}|${marker_mid}|${marker_end})" "$RUNNER_TEMP/agent-files/$file"; then
      return 0
    fi
  done < "$RUNNER_TEMP/conflicts-after.txt"
  return 1
}

worktree_matches_pre_agent() {
  diff -qr --exclude '.git' "$RUNNER_TEMP/pre-agent" . >/dev/null || return 1
  return 0
}

# Fail if Copilot left edits outside the conflict list after restore+overlay.
unexpected_agent_paths() {
  local pre="$RUNNER_TEMP/pre-agent"
  local rel abs
  while IFS= read -r rel; do
    [ -n "$rel" ] || continue
    [ "$rel" = "." ] && continue
    if [ ! -e "$pre/$rel" ] && [ ! -L "$pre/$rel" ]; then
      if ! grep -qxF "$rel" "$RUNNER_TEMP/conflicts-after.txt"; then
        printf '%s\n' "$rel"
      fi
    fi
  done < <(find . -path './.git' -prune -o \( \( -type f -o -type l \) -o -type d -empty \) -print | sed 's|^\./||')
  while IFS= read -r abs; do
    rel="${abs#"$pre"/}"
    [ "$rel" = "$abs" ] && continue
    if grep -qxF "$rel" "$RUNNER_TEMP/conflicts-after.txt"; then
      continue
    fi
    if { [ ! -e "$rel" ] && [ ! -L "$rel" ]; } || ! cmp -s "$pre/$rel" "$rel" 2>/dev/null; then
      if [ -L "$pre/$rel" ] || [ -L "$rel" ]; then
        if [ "$(readlink "$pre/$rel" 2>/dev/null || true)" = "$(readlink "$rel" 2>/dev/null || true)" ]; then
          continue
        fi
        printf '%s\n' "$rel"
        continue
      fi
      if [ -d "$pre/$rel" ] && [ -d "$rel" ]; then
        continue
      fi
      printf '%s\n' "$rel"
    fi
  done < <(find "$pre" \( \( -type f -o -type l \) -o -type d -empty \) -print)
}

assert_only_conflicted_files_differ_from_pre_agent() {
  local unexpected
  unexpected="$(unexpected_agent_paths | sort -u)"
  if [ -n "$unexpected" ]; then
    echo "Copilot changed files that were not in the conflict list:" >&2
    printf '%s\n' "$unexpected" >&2
    exit 1
  fi
}

# Sourced by tests: helpers are defined; do not run the merge.
if [ "${BASH_SOURCE[0]}" != "${0}" ]; then
  return 0
fi

# Copilot can rewrite this file while bash is still reading it. Parse the body
# first so a later edit cannot shift the rest of the run.
main() {

if [ "${GITHUB_ACTIONS:-}" != "true" ]; then
  echo "finish-sync-merge.sh only runs in GitHub Actions" >&2
  echo "Set GITHUB_ACTIONS=true to override (e.g. for act)." >&2
  exit 1
fi

: "${REMOTE:?}"
: "${BRANCH:?}"
: "${GITHUB_OUTPUT:?}"
: "${RUNNER_TEMP:?}"
: "${FORK_BRANCH:?}"
: "${UPSTREAM_REPO:?}"

# Scope the bot identity to this process. Do not write user.name / user.email
# into git config — that persists in the repo and later local commits (including
# from worktrees that share that config) would be authored as github-actions[bot].
export GIT_AUTHOR_NAME='github-actions[bot]'
export GIT_AUTHOR_EMAIL='41898282+github-actions[bot]@users.noreply.github.com'
export GIT_COMMITTER_NAME="$GIT_AUTHOR_NAME"
export GIT_COMMITTER_EMAIL="$GIT_AUTHOR_EMAIL"

if [ "$(git rev-parse --abbrev-ref HEAD)" != "$FORK_BRANCH" ]; then
  git checkout "$FORK_BRANCH"
fi
fork_sha="$(git rev-parse HEAD)"
echo "entry-job-hunt-v2 ${FORK_BRANCH}: ${fork_sha}"

tag="career-ops-v${REMOTE}"
git fetch --no-tags "https://github.com/${UPSTREAM_REPO}.git" "+refs/tags/${tag}:refs/tags/${tag}"
echo "career-ops release ${tag}: $(git rev-parse "$tag")"

git checkout -B "$BRANCH"

merge_ok=false
if git merge --no-ff --no-edit -m "chore: merge career-ops v${REMOTE} into entry-job-hunt-v2 ${FORK_BRANCH}" "$tag"; then
  merge_ok=true
fi

if [ "$merge_ok" = false ] && [ ! -f "$(git rev-parse --git-path MERGE_HEAD)" ]; then
  echo "git merge failed without leaving conflicts"
  exit 1
fi

if [ "$merge_ok" = false ]; then
  git diff --name-only --diff-filter=U > "$RUNNER_TEMP/conflicts-before.txt"
else
  : > "$RUNNER_TEMP/conflicts-before.txt"
fi

node .github/scripts/restore-fork-user-layer.mjs "$fork_sha" > "$RUNNER_TEMP/user-layer.json"
echo "user-layer restore: $(cat "$RUNNER_TEMP/user-layer.json")"
node .github/scripts/restore-disabled-workflows.mjs "$fork_sha" > "$RUNNER_TEMP/disabled-workflows.json"
echo "disabled-workflow restore: $(cat "$RUNNER_TEMP/disabled-workflows.json")"
node .github/scripts/restore-disabled-workflows.mjs --strip-list \
  "$RUNNER_TEMP/disabled-workflows.json" "$RUNNER_TEMP/conflicts-before.txt"

write_notes() {
  local disposition="$1"
  local report_args=()
  if [ -n "${2:-}" ] && [ -f "$2" ]; then
    report_args+=(--agent-report "$2")
  fi
  if [ -f "$RUNNER_TEMP/copilot.log" ]; then
    report_args+=(--copilot-log "$RUNNER_TEMP/copilot.log")
  fi
  node .github/scripts/sync-conflict-notes.mjs \
    --before "$RUNNER_TEMP/conflicts-before.txt" \
    --after "$RUNNER_TEMP/conflicts-after.txt" \
    --disposition "$disposition" \
    "${report_args[@]}" \
    > "$RUNNER_TEMP/conflict-notes.md"
}

finish_merge() {
  local message="$1"
  git commit -m "$message"
}

if [ "$merge_ok" = true ]; then
  if ! git diff --cached --quiet; then
    msg="$(node .github/scripts/restore-disabled-workflows.mjs --followup-message \
      "$RUNNER_TEMP/user-layer.json" "$RUNNER_TEMP/disabled-workflows.json")"
    git commit -m "$msg"
  fi
  echo "conflicted=false" >> "$GITHUB_OUTPUT"
  exit 0
fi

git diff --name-only --diff-filter=U > "$RUNNER_TEMP/conflicts-after.txt" || true

if [ ! -s "$RUNNER_TEMP/conflicts-after.txt" ]; then
  finish_merge "chore: merge career-ops v${REMOTE} into entry-job-hunt-v2 ${FORK_BRANCH}"
  if [ -s "$RUNNER_TEMP/conflicts-before.txt" ]; then
    write_notes user-only
  fi
  echo "conflicted=false" >> "$GITHUB_OUTPUT"
  exit 0
fi

echo "conflicted files left for Copilot:"
cat "$RUNNER_TEMP/conflicts-after.txt"

# Exact pre-agent index and worktree, so a bad try can be put back.
GIT_INDEX="$(git rev-parse --git-path index)"
cp "$GIT_INDEX" "$RUNNER_TEMP/index.before"
mkdir -p "$RUNNER_TEMP/pre-agent"
rsync -a --exclude '.git' ./ "$RUNNER_TEMP/pre-agent/"

disposition=not-run
report=""

if [ -z "${COPILOT_GITHUB_TOKEN:-}" ]; then
  echo "COPILOT_GITHUB_TOKEN is not set; leaving conflict markers"
else
  npm install -g @github/copilot
  # A fresh home keeps this run's session events in one place. The model is
  # read from those events after Copilot exits. Standard output stays the
  # CLI's message log.
  copilot_home="$RUNNER_TEMP/copilot-home"
  mkdir -p "$copilot_home"
  prompt="$(cat <<EOF
Read and follow .github/skills/resolve-sync-conflicts/SKILL.md before you edit anything.

You are on a sync branch started from entry-job-hunt-v2 ${FORK_BRANCH}. HEAD is that fork. The other side of each conflict is the career-ops release ${tag}. Do not commit, push, or stage. Write sync-conflict-report.md in the repository root and stop.

Before any edit, run: git grep -n -e '${conflict_head}'
A line containing ${conflict_head} is a merge conflict. Write every hit (path and line) under ## Conflicts found in sync-conflict-report.md. Ignore .github/skills/resolve-sync-conflicts/SKILL.md and anything under .github/scripts/. Do not edit those paths even if grep lists them. Do not edit a conflicted file until that list is written. Then resolve one file at a time, in that list's order, and re-run the search on the file you just edited before starting the next. For each file, remove every conflict marker and keep the functionality already on both sides. Do not leave a hunk marked because the two sides look incompatible. Do not add an optimization, refactor, rename, or any other change. Do not run the tests. This sync keeps your try. The pull request's Tests workflow reports failures, and a person fixes those. A file below that the search does not find is already clear. A hit this list omits is still a conflict: resolve it too, unless the skill says the path is user-layer or under .github/scripts/.

Conflicted files:
$(sed 's/^/- /' "$RUNNER_TEMP/conflicts-after.txt")
EOF
)"
  set +e
  COPILOT_HOME="$copilot_home" copilot --autopilot --max-autopilot-continues 12 --no-ask-user \
    --allow-tool='write,shell(git:diff*),shell(git:status),shell(git:show*),shell(git:log*),shell(git:grep*)' \
    -p "$prompt"
  copilot_status=$?
  set -e
  if [ -d "$copilot_home/session-state" ]; then
    : > "$RUNNER_TEMP/copilot.log"
    find "$copilot_home/session-state" -name events.jsonl -print | sort | while IFS= read -r events; do
      cat "$events" >> "$RUNNER_TEMP/copilot.log"
    done
  fi
  if [ -f sync-conflict-report.md ]; then
    cp sync-conflict-report.md "$RUNNER_TEMP/agent-report.md"
    report="$RUNNER_TEMP/agent-report.md"
    rm -f sync-conflict-report.md
  fi
  save_agent_files
  restore_pre_agent
  if ! worktree_matches_pre_agent; then
    echo "restore_pre_agent did not restore the pre-Copilot worktree" >&2
    diff -qr --exclude '.git' "$RUNNER_TEMP/pre-agent" . >&2 || true
    exit 1
  fi

  if [ "$copilot_status" -ne 0 ]; then
    echo "copilot exited ${copilot_status}"
    disposition=failed
  elif agent_left_markers; then
    disposition=partial
  else
    disposition=kept
  fi
fi

# Keep the try. The pull request's Tests workflow reports failures.
if [ "$disposition" = kept ] || [ "$disposition" = partial ]; then
  overlay_agent_files
  assert_only_conflicted_files_differ_from_pre_agent
fi

if [ "$disposition" = kept ]; then
  finish_merge "chore: merge career-ops v${REMOTE} into entry-job-hunt-v2 ${FORK_BRANCH} (conflicts resolved)"
  echo "conflicted=false" >> "$GITHUB_OUTPUT"
else
  git add --pathspec-from-file="$RUNNER_TEMP/conflicts-after.txt"
  finish_merge "chore: merge career-ops v${REMOTE} into entry-job-hunt-v2 ${FORK_BRANCH} (conflicts unresolved)"
  echo "conflicted=true" >> "$GITHUB_OUTPUT"
fi

write_notes "$disposition" "$report"
echo "conflict disposition: $disposition"

}

main "$@"; exit

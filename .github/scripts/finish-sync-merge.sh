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

: "${REMOTE:?}"
: "${BRANCH:?}"
: "${GITHUB_OUTPUT:?}"
: "${RUNNER_TEMP:?}"
: "${FORK_BRANCH:?}"
: "${UPSTREAM_REPO:?}"

git config user.name "github-actions[bot]"
git config user.email "41898282+github-actions[bot]@users.noreply.github.com"

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

restore_pre_agent() {
  cp "$RUNNER_TEMP/index.before" "$GIT_INDEX"
  rsync -a --delete --exclude '.git' "$RUNNER_TEMP/pre-agent/" ./
}

overlay_agent_files() {
  local file
  while IFS= read -r file; do
    [ -n "$file" ] || continue
    mkdir -p "$(dirname "$file")"
    cp "$RUNNER_TEMP/agent-files/$file" "$file"
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
    cp "$file" "$RUNNER_TEMP/agent-files/$file"
  done < "$RUNNER_TEMP/conflicts-after.txt"
}

agent_left_markers() {
  local file
  while IFS= read -r file; do
    [ -n "$file" ] || continue
    if grep -q -E '^(<<<<<<<|>>>>>>>) ' "$RUNNER_TEMP/agent-files/$file"; then
      return 0
    fi
  done < "$RUNNER_TEMP/conflicts-after.txt"
  return 1
}

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

You are on a sync branch started from entry-job-hunt-v2 ${FORK_BRANCH}. HEAD is that fork. The other side of each conflict is the career-ops release ${tag}. Edit only the files listed below. Do not commit, push, or stage. Write sync-conflict-report.md in the repository root and stop.

Conflicted files:
$(sed 's/^/- /' "$RUNNER_TEMP/conflicts-after.txt")
EOF
)"
  set +e
  COPILOT_HOME="$copilot_home" copilot --autopilot --max-autopilot-continues 12 --no-ask-user \
    --allow-tool='write,shell(git:diff*),shell(git:status),shell(git:show*),shell(git:log*)' \
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

  if [ "$copilot_status" -ne 0 ]; then
    echo "copilot exited ${copilot_status}"
    disposition=failed
  elif agent_left_markers; then
    disposition=partial
  else
    disposition=kept
  fi
fi

if [ "$disposition" = kept ]; then
  overlay_agent_files
  npm install --ignore-scripts
  tests_ok=true
  npm run lint || tests_ok=false
  if [ "$tests_ok" = true ]; then
    node test-all.mjs --quick || tests_ok=false
  fi
  if [ "$tests_ok" = false ]; then
    echo "lint or tests failed; discarding Copilot's edits"
    restore_pre_agent
    disposition=discarded
  fi
elif [ "$disposition" = partial ]; then
  overlay_agent_files
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

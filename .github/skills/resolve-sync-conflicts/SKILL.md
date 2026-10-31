---
name: resolve-sync-conflicts
description: Resolves merge conflicts after a career-ops release is merged into this fork, keeping this fork's features and the upstream release working together. Use when sync-career-ops.yml has conflict markers, when a career-ops sync pull request asks to combine both sides, or when the user says resolve the sync conflicts, keep both features, combine the upstream release with this fork, or handle the merge conflict. Do not use for job search, CV generation, evaluating a posting, scanning portals, or any career-ops mode.
---

# resolve-sync-conflicts

Combine a career-ops release with this fork. One try. Leave a report the sync pull request can quote.

## CRITICAL

- Edit only files that contain a merge conflict, plus any file the prompt lists. Do not commit, push, or `git add`.
- Do not edit a user-layer path (`cv.md`, `config/profile.yml`, `modes/_profile.md`, `modes/_custom.md`, `modes/_brief.md`, `voice-dna.md`, `portals.yml`, `article-digest.md`, `config/plugins.yml`, `plugins.lock`, `opencode.json`, `.claude/settings.json`, or anything under `.career-ops-web/`, `interview-prep/`, `documents/`, `data/`, `reports/`, `output/`, `jds/`, `writing-samples/`, `plugins.local/`, `.claude/hooks/`). The workflow already kept this fork's copy. If one of those files is in the prompt, stop and say so in the report. Do not blend the release into it.
- `<<<<<<< HEAD` is entry-job-hunt-v2 `main`. The other side is the career-ops release tag. Keep both behaviors when a best effort can make them coexist. Do not drop a fork feature to take the release, and do not drop a release change to keep the fork.
- For each file, only remove conflict markers and keep the functionality already on the two sides. Do not add an optimization, refactor, rename, comment, helper, or any other change. A line that was not inside a conflict hunk stays as it was.
- When the same function cannot do both (opposite contracts, or one side deletes an API the other still calls), leave that hunk's `<<<<<<<`, `=======`, and `>>>>>>>` lines in place. Do not invent a third behavior.
- In a file both sides changed, the result is one readable path. No second copy of the same function. No `if (fork)` wrapped around the whole file. A fork-only branch sits next to the release path and is named for what it does. Do not reformat or rewrite lines that were not in conflict.
- `.github/copilot-instructions.md` tells other sessions not to touch control files. That does not apply to a conflict hunk in a file this prompt lists. Do not follow `AGENTS.md` or run a career-ops mode.
- Do not delete or weaken a test to hide a side you dropped. Do not run `npm install` or the test suite. The workflow does that.
- Write `sync-conflict-report.md` in the repository root, then stop. Do not stage that file.

## Workflow

1. **Find every conflict before editing.** Run `git grep -n -e '<<<<<<< HEAD'`. A line containing `<<<<<<< HEAD` is a merge conflict. Write every hit (path and line) into `sync-conflict-report.md` under `## Conflicts found`, then stop and do not edit a conflicted file until that list is in the file. Ignore the hit in this skill. A file the prompt names that is absent from the search is already clear. A hit the prompt omits is still a conflict.
2. **Resolve one file at a time, in the order of that list.** Read both sides of every hunk in that file first. Keep both behaviors, or leave that hunk marked. Do not optimize or otherwise improve the file while you are there. When the file is done, run `git grep -n -e '<<<<<<< HEAD' -- that/file`. Any remaining hit means the file is not done. Do not start the next file while this one still has a hit. Do not touch a file that was not in the list and was not named by the prompt.
3. **Finish** `sync-conflict-report.md`. Leave `## Conflicts found` at the top. Under it, one section per file from that list and per file the prompt named, in that same order. `Handled` is `yes` only when that file contains no `<<<<<<< HEAD`. `How` is one sentence.

## Output

```markdown
## Conflicts found
- `path/from/repo/root:12`

### `path/from/repo/root`
- **Handled:** yes
- **How:** Kept the release's scanner retry and this fork's portal filter as sequential steps in `fetchJobs`.
```

```markdown
### `path/from/repo/root`
- **Handled:** no
- **How:** Both sides replace `scoreOffer` with incompatible return shapes, so the hunk is still marked.
```

## Example

User: the sync job lists `scan.mjs` after merging career-ops v1.38.0.
Agent: searches for `<<<<<<< HEAD`, writes that list under `## Conflicts found`, then combines the release's new request timeout with this fork's extra query param. `Handled: yes` only after a second search of `scan.mjs` finds nothing.
Result: the workflow quotes that sentence in the pull request. The agent does not commit.

## Troubleshooting

- **A listed file has no markers.** Leave it unchanged. Report `Handled: yes` and say it was already clear.
- **You cannot tell what a side does.** Leave the hunk marked. `Handled: no`. Say what was ambiguous. Do not guess.

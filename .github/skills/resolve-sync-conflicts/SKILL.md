---
name: resolve-sync-conflicts
description: Resolves merge conflicts after a career-ops release is merged into this fork, keeping this fork's features and the upstream release working together. Use when sync-career-ops.yml has conflict markers, when a career-ops sync pull request asks to combine both sides, or when the user says resolve the sync conflicts, keep both features, combine the upstream release with this fork, or handle the merge conflict. Do not use for job search, CV generation, evaluating a posting, scanning portals, or any career-ops mode.
---

# resolve-sync-conflicts

Combine a career-ops release with this fork. One try. Leave a report the sync pull request can quote.

## CRITICAL

- Edit only files the prompt lists as still conflicted. Do not commit, push, or `git add`.
- Do not edit a user-layer path (`cv.md`, `config/profile.yml`, `modes/_profile.md`, `modes/_custom.md`, `modes/_brief.md`, `voice-dna.md`, `portals.yml`, `article-digest.md`, `config/plugins.yml`, `plugins.lock`, `opencode.json`, `.claude/settings.json`, or anything under `.career-ops-web/`, `interview-prep/`, `documents/`, `data/`, `reports/`, `output/`, `jds/`, `writing-samples/`, `plugins.local/`, `.claude/hooks/`). The workflow already kept this fork's copy. If one of those files is in the prompt, stop and say so in the report. Do not blend the release into it.
- `<<<<<<< HEAD` is entry-job-hunt-v2 `main`. The other side is the career-ops release tag. Keep both behaviors when a best effort can make them coexist. Do not drop a fork feature to take the release, and do not drop a release change to keep the fork.
- When the same function cannot do both (opposite contracts, or one side deletes an API the other still calls), leave that hunk's `<<<<<<<`, `=======`, and `>>>>>>>` lines in place. Do not invent a third behavior.
- In a file both sides changed, the result is one readable path. No second copy of the same function. No `if (fork)` wrapped around the whole file. A fork-only branch sits next to the release path and is named for what it does. Do not reformat or rewrite lines that were not in conflict.
- `.github/copilot-instructions.md` tells other sessions not to touch control files. That does not apply to a conflict hunk in a file this prompt lists. Do not follow `AGENTS.md` or run a career-ops mode.
- Do not delete or weaken a test to hide a side you dropped. Do not run `npm install` or the test suite. The workflow does that.
- Write `sync-conflict-report.md` in the repository root, then stop. Do not stage that file.

## Workflow

1. **Read** each listed file and the two sides of every hunk. Success looks like: you can name what the fork added and what the release added.
2. **Edit** hunk by hunk. Keep both behaviors, or leave that hunk marked. Do not touch any other file.
3. **Write** `sync-conflict-report.md` with one section per listed file, in the prompt's order. `Handled` is `yes` only when that file contains no conflict markers. `How` is one sentence.

## Output

```markdown
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
Agent: combines the release's new request timeout with this fork's extra query param, and writes `sync-conflict-report.md` with `Handled: yes`.
Result: the workflow quotes that sentence in the pull request. The agent does not commit.

## Troubleshooting

- **A listed file has no markers.** Leave it unchanged. Report `Handled: yes` and say it was already clear.
- **You cannot tell what a side does.** Leave the hunk marked. `Handled: no`. Say what was ambiguous. Do not guess.

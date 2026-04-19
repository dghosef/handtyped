---
name: git-handoff
description: Use when code changes are finished and the work should end with a clean Git handoff. Inspect the diff, stage only intended files, and create a focused commit unless the user says not to use Git.
metadata:
  short-description: Finish changes with a clean git handoff
---

# Git Handoff

Use this skill when a task has been implemented and should be wrapped up cleanly in Git.

## Core rule

At the end of the change set:

1. Check `git status` and the diff.
2. Stage only the files that belong to the task.
3. Create a focused commit with a clear message.
4. Leave unrelated worktree changes alone.

## Constraints

- Do not stage or revert unrelated user changes.
- Do not commit if the user explicitly asked not to use Git.
- Keep the commit message short and specific to the change.
- If the repo is already dirty, isolate the intended files before staging.

## Preferred flow

- Inspect the final diff summary.
- Verify the changed files match the task.
- Stage intended files only.
- Commit once the implementation and tests are done.
- Report the commit hash if a commit was created.

## Good defaults

- Use one commit per coherent task when practical.
- Avoid bundling unrelated cleanup into the same commit.
- If a push is needed, do it only when the user asks.

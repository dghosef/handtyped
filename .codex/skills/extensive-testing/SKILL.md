---
name: extensive-testing
description: Use when making any code change in the Handtyped repo. After each change, add extensive tests around the touched behavior, especially regressions, edge cases, malformed inputs, round trips, persistence, replay reconstruction, and likely failure modes. Do not treat implementation as complete until the relevant focused suites pass.
metadata:
  short-description: Require extensive tests after every code change
---

# Extensive Testing

This skill applies to code changes in Handtyped.

## Core rule

After each code change, add extensive tests for the affected behavior before considering the work done.

That means:
- add regression tests for the bug or feature being changed
- add edge-case tests near the touched logic
- add at least one "likely to fail" case when practical
- prefer tests that exercise persisted formats, replay reconstruction, markdown parsing/rendering, undo/redo behavior, and malformed inputs when those surfaces are involved

## Expectations

- Do not stop at a happy-path test.
- If a parser or transformation changed, test malformed and boundary inputs too.
- If persistence changed, test save/load round trips and on-disk shape.
- If replay/history changed, test reconstruction against final text.
- If editor behavior changed, test undo/redo, cursor movement, and rejected-input paths when relevant.
- If the code already has a nearby suite, extend that suite instead of creating throwaway one-off coverage.

## Preferred verification flow

Choose the smallest relevant set, but always run the suites that cover the changed code.

- Rust editor/core changes:
  - `cargo test`
  - or at minimum the focused Rust suites for the touched modules first, then `cargo test --quiet`
- Replay server/viewer changes:
  - `PATH=/opt/homebrew/bin:/usr/local/bin:$PATH /opt/homebrew/bin/npm --prefix replay-server test -- replay-view.test.js replay-workflow.test.js`
  - add `server.test.js` too when the environment allows socket binding
- Legacy JS/WebView changes:
  - `npm test`
  - `npm run test:e2e` when UI behavior changed

## Bias

When choosing between:
- one shallow test
- or several tests that probe awkward, realistic failure modes

choose the second.

## Handtyped-specific high-yield areas

- markdown preview edge cases
- compact `TextChange` diffs and inverse application
- undo/redo persistence and cursor restoration
- saved `.ht` payload shape
- replay history reconstruction from compact deltas
- malformed replay/session payload handling
- HID-rejected input paths


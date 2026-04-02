# Claude/Codex Compatibility

This repository was actively worked on with Claude Code before the current Codex-driven workflow.

## What To Treat As Shared Project Context

- [CLAUDE.md](/Users/dghosef/editor/CLAUDE.md)
- [AGENTS.md](/Users/dghosef/editor/AGENTS.md)
- [.claude/settings.local.json](/Users/dghosef/editor/.claude/settings.local.json)

## Historical Claude Project Memory

These files contain prior Claude Code project memory for Handtyped:

- `/Users/dghosef/.claude/projects/-Users-dghosef-editor/memory/MEMORY.md`
- the legacy project state note in that same Claude memory directory

Use that memory for:

- implementation history
- prior security decisions
- naming continuity
- understanding why older files exist

Do not treat it as authoritative when it conflicts with the live code. The repo has since shifted toward a Rust-native editor rooted at `Cargo.toml` with source in `src/`.

## Practical Rule

If you are an agent working in this repo:

1. Read `AGENTS.md` and `CLAUDE.md`.
2. Use `.claude/settings.local.json` for local workflow/tooling expectations when relevant.
3. Consult the historical Claude memory only as background context.
4. Prefer the current code over any stale Claude-memory note.

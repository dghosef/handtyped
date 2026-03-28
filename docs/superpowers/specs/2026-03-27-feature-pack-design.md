# HumanProof Feature Pack Design

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Add a comprehensive set of word-processor and text-editor features across four areas: new document elements, productivity polish, vim enhancements, and markdown live preview.

**Architecture:** All changes are frontend-only (`src/`, `index.html`). No Rust/Tauri changes required. One new file: `src/typography.js`. All other work extends existing files. A fourth toolbar row is added for the new document elements.

**Tech Stack:** ProseMirror (schema, inputRules, nodeViews), vanilla JS, existing Tauri IPC bridge.

---

## Section 1 — New Document Elements

### Code Blocks

- New `code_block` schema node in `src/schema.js`: block-level, no inline marks allowed, `language` attr (default `""`).
- Rendered as `<pre><code>` with monospace styling.
- Three entry points:
  1. Toolbar button (row 4) labeled `</>`.
  2. `inputRule`: typing ` ``` ` at the start of a paragraph converts it to a code block.
  3. `Cmd+Shift+K` keyboard shortcut.
- Escape key exits the code block (converts back to paragraph).
- Toolbar `syncToolbar()` shows code block active state.

### Task Lists

- New schema nodes: `task_list` (block group) and `task_item` (block, `checked` bool attr, default `false`).
- `task_item` renders as `<li>` with a `<input type="checkbox">` prepended.
- Clicking the checkbox dispatches a `setNodeMarkup` transaction toggling `checked`.
- Entry: toolbar button (row 4) `☑ Tasks` and `Ctrl+Shift+9`.
- Checked items get a CSS `text-decoration: line-through; opacity: 0.5` style.
- Tab/Shift-Tab indent/outdent works identically to bullet lists.

### Paragraph Spacing

- Add `spaceBefore` (default `0`) and `spaceAfter` (default `0`) attrs to the `paragraph` spec in `src/schema.js`.
- `toDOM` emits `margin-top` / `margin-bottom` inline styles when non-zero.
- Toolbar row 4: two `<select>` dropdowns labeled "↑" and "↓" with options `0 / 6 / 12 / 18 / 24 / 36` pt.
- `syncToolbar()` reads the cursor paragraph's attrs and updates the selects.

### Footnotes

- New schema nodes:
  - `footnote_mark` (inline, atom): renders as `<sup class="footnote-ref">[n]</sup>`. The `n` attr is the footnote number (auto-assigned on insert, not stored — recomputed on render).
  - `footnote_def` (block): renders as `<div class="footnote-def"><sup>[n]</sup> …</div>`. Contains `inline*` content. Has a `ref` attr linking it to its mark.
- Insert command (`Cmd+Shift+F`): finds the next available footnote number, inserts a `footnote_mark` at cursor, then appends a `footnote_def` block at the end of the document and moves cursor there.
- Footnote numbers are recomputed by scanning the doc for `footnote_mark` nodes in order each time the doc changes; `NodeView` for `footnote_mark` updates its displayed number accordingly.
- CSS: `.footnote-def` blocks render at normal flow position (bottom of doc). A CSS rule `hr.footnote-rule` is inserted before the first `footnote_def` (via a plugin decoration).

### 2-Column Layout

- New schema node: `column_block` (block, group `"block"`), contains exactly two `column` nodes. `column` contains `block+`.
- Rendered as a CSS grid: `display: grid; grid-template-columns: 1fr 1fr; gap: 24px`.
- Entry: `Cmd+Shift+2` wraps the current block in a `column_block` with two equal `column` children. `Cmd+Shift+1` lifts back to single column (unwraps).
- Toolbar row 4: `⫿ 2-Col` button and `▭ 1-Col` button.

---

## Section 2 — Productivity Polish

### Smart Typography (`src/typography.js`)

New file exporting a ProseMirror `Plugin` (`typographyPlugin`) using `InputRule`:

| Trigger | Replacement |
|---------|-------------|
| `--` | `—` (em-dash) |
| `...` | `…` (ellipsis) |
| `"` (opening) | `"` (left double quote) |
| `"` (closing, after non-space) | `"` (right double quote) |
| `'` (opening) | `'` (left single quote) |
| `'` (closing, after non-space) | `'` (right single quote) |
| `(c)` | `©` |
| `(r)` | `®` |
| `(tm)` | `™` |

- The plugin is toggled on/off via `window.__typographyEnabled` (default `true`).
- `editor.js` adds the plugin to the plugin list conditionally.
- Edit menu item "Smart Typography" (`Cmd+Shift+'`) toggles it; status bar shows `✓ Smart` or nothing.
- Quote direction is determined by the character before the typed quote.

### Paste as Plain Text

- `Cmd+Shift+V` handler in `wordKeymap`: reads `event.clipboardData.getData('text/plain')`, creates a ProseMirror text node, and inserts it at the cursor, replacing the selection.
- No new commands or bridge calls needed.
- Logs the paste event via `invoke('log_paste_event', ...)` exactly like normal paste.

### Selection Stats

- In `dispatchTransaction`, check `tr.selection`. If the selection is non-empty, compute word count and character count of the selected text.
- Status bar `#word-count` element shows `42 words selected` when selection is non-empty, reverts to `N words` when collapsed.
- `#char-count` similarly shows `87 chars selected`.

### Readability Score

- New function `fleschKincaid(text)` in `src/editor.js`:
  - Counts words, sentences, syllables (heuristic: count vowel groups per word).
  - Returns `{ score, level }` where level is one of: `5th grade / 8th grade / High school / College / Graduate`.
  - Formula: `206.835 - 1.015*(words/sentences) - 84.6*(syllables/words)`.
- Called in `dispatchTransaction` debounced 500ms.
- Status bar element `#readability` shows e.g. `FK 72 · College`.

### Keyboard Shortcut Panel

- `#shortcut-panel` modal overlay in `index.html` (hidden by default): fixed inset 0, dark backdrop, scrollable inner box listing shortcuts in two-column grid.
- Shortcut data is a static array in `editor.js` grouped into categories: Formatting, Structure, Navigation, View, Vim.
- Opens on `Cmd+/` (wordKeymap) or `?` in vim normal mode.
- Closes on Escape or clicking outside.
- A `?` button in toolbar row 4.

---

## Section 3 — Vim Enhancements (`src/vim.js`)

All changes extend the existing `VimPlugin` class.

### Count Prefixes

- In normal mode, digit keys `1-9` (and `0` when a count is already buffered) accumulate into `this._count` (integer).
- Any non-digit command consumes `this._count`, applies the command N times, then resets `_count` to 0.
- `0` alone (no count buffered) still means "go to line start".

### `f`/`F`/`t`/`T` motions

- `f` enters a sub-state `_pendingFind = {dir: 1, till: false}`. Next keypress is the target char.
- `F` same with `dir: -1`.
- `t`/`T` same but `till: true` (stop one before the char).
- `;` repeats last find in same direction; `,` repeats in opposite direction. These are stored in `this._lastFind`.
- Implementation scans the current line text (extracted from ProseMirror doc) for the target char starting from cursor position.

### `%` motion

- On `%`, find the character under the cursor. If it's one of `([{`, scan forward for the matching `)]}`. If it's `)]}`, scan backward for the matching `([{`.
- Moves cursor to the matching bracket.
- Uses ProseMirror `doc.textBetween` to get the line text and scans with a bracket stack.

### `.` repeat

- Store the last "change" as `this._lastChange: { type, payload }`.
- A "change" is any operation that mutates the document: insert sequence (from insert mode), `x`, `dd`, `cc`, `cw`, `r<char>`, `o`/`O` + insert.
- On `.` in normal mode, re-execute `_lastChange`.
- For insert sequences, store the full text that was inserted and replay it.

### `c` operator

- `cw` — delete to end of word, enter insert mode.
- `cb` — delete to start of word, enter insert mode.
- `c$` / `C` — delete to end of line, enter insert mode.
- `c0` — delete to start of line, enter insert mode.
- `cc` — delete entire line content, enter insert mode.
- Uses the same motion helpers already used by `d`.

### `r` replace

- `r` enters sub-state `_pendingReplace = true`. Next keypress replaces the character under cursor (single `setNodeMarkup`-free text replacement via `tr.replaceWith`). Does not enter insert mode.

### `y`/`p` yank/paste

- Internal vim register `this._register` (string, default `""`).
- `yy` copies the current line text (including trailing newline) to `_register`.
- `yw` copies to end of word; `y$` copies to end of line.
- `p` inserts `_register` content after cursor; `P` inserts before.
- Does not interact with OS clipboard (keeping attestation clean).

---

## Section 4 — Markdown Live Preview

### Three-State Toggle

The existing `#btn-markdown` cycles through three states stored in `src/markdown.js`:

1. **Off** — normal ProseMirror editor, markdown textarea hidden.
2. **Split** — editor hidden, split pane shows: left = raw markdown textarea, right = rendered HTML preview. 50/50 via CSS flex.
3. **Source-only** — only markdown textarea visible (existing behavior).

The button label updates: `MD` → `MD ⫿` (split) → `MD src` (source) → `MD` (off).

### Live Preview

- In split and source modes, the markdown textarea fires an `input` event.
- A debounced (150ms) handler serializes the textarea content via `marked` (lightweight markdown-to-HTML library, added to `package.json`) and sets `innerHTML` of `#md-preview`.
- `#md-preview` is a `<div>` in a new `#md-split-pane` wrapper.

### Syntax Highlighting in Source

- The markdown textarea is replaced with a `<div id="md-source" contenteditable="true" spellcheck="false">` that visually appears as a textarea (monospace, dark background).
- On every `input`, the content is re-tokenized and re-highlighted using a minimal hand-written tokenizer that emits `<span class="md-*">` wrappers for: headings (`md-h`), bold (`md-strong`), italic (`md-em`), inline code (`md-code`), fenced code blocks (`md-fence`), links (`md-link`), blockquotes (`md-quote`), and list markers (`md-list`).
- The tokenizer preserves cursor position using `window.getSelection()` save/restore around `innerHTML` assignment.
- CSS classes use muted colors that complement the dark `#1e1e1e` background.

---

## File Structure

| File | Changes |
|------|---------|
| `src/schema.js` | Add `code_block`, `task_list`, `task_item`, `footnote_mark`, `footnote_def`, `column_block`, `column` nodes; add `spaceBefore`/`spaceAfter` to paragraph |
| `src/typography.js` | New file: `typographyPlugin` export |
| `src/markdown.js` | Replace textarea with contenteditable div, add three-state toggle, live preview logic |
| `src/vim.js` | Add count prefix, f/F/t/T/;/,, %, ., c operator, r, y/p |
| `src/editor.js` | Integrate all new features, readability, selection stats, shortcut panel, paste-plain-text, smart typography toggle |
| `index.html` | Toolbar row 4, `#shortcut-panel` modal, `#md-split-pane`, `#md-preview`, new status bar spans, styles |

## Implementation Tasks (summary)

1. Schema additions (code_block, task_list/item, paragraph spacing, footnotes, columns)
2. Toolbar row 4 + CSS for new elements
3. Smart typography plugin (`src/typography.js`)
4. Paste-as-plain-text, selection stats, readability score
5. Keyboard shortcut panel
6. Vim count prefixes
7. Vim f/F/t/T/;/, and % motions
8. Vim . repeat, c operator, r replace, y/p yank-paste
9. Markdown live preview + syntax highlighting

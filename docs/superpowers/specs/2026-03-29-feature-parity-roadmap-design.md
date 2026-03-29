# HumanProof Feature Parity Roadmap

**Goal:** Bring HumanProof to full feature parity with mature markdown editors (Typora, Obsidian, iA Writer, Bear) while maintaining the core constraint: every edit must be fully attested via built-in keyboard HID events.

**Architecture target:** WYSIWYG egui editor — markdown renders inline as you type (Typora model). The attestation layer is purely in the buffer mutation path; the WYSIWYG layer is presentational only.

---

## Phase Overview

| Phase | Name | Outcome |
|-------|------|---------|
| 1 | WYSIWYG Engine + Proof Publishing | Custom egui widget with inline markdown rendering; publish proof to localhost server |
| 2 | Editor Features | Find/replace, formatting shortcuts, vim completion, spellcheck, outline, themes |
| 3 | File Management | Encrypted `.hp` container format, multi-document, tabs, persistent undo |
| 4 | Export & Proof Verification | PDF/HTML/MD export, proof badge, verification CLI, partial proofs |
| 5 | Distribution Polish | Deployed proof server, onboarding, auto-update, notarization, settings |

Each phase is independently shippable.

---

## Phase 1 — WYSIWYG Engine + Proof Publishing

### WYSIWYG Editor Widget

A custom egui `Widget` (`MarkdownEditor`) replaces the current `TextEdit::multiline`. It maintains a string buffer and re-parses with `pulldown-cmark` on every edit. The parsed AST drives layout; each block is a separate egui layout unit.

**Inline rendering model (Typora "source on focus"):**
- When the cursor is **outside** a span, it renders: `**bold**` → **bold**, `# Heading` → large heading text, `` `code` `` → monospace colored span
- When the cursor is **inside** a span, the raw markdown tokens are revealed for editing
- Block elements (headings, lists, blockquotes, code blocks, tables, horizontal rules) always render visually

**Block types supported:**
- Headings H1–H6 (sized and weighted)
- Paragraphs
- Bullet and ordered lists (indented, with markers)
- Blockquotes (left border, muted text)
- Fenced code blocks (monospace, background fill, language label)
- Tables (grid layout)
- Horizontal rules
- Task lists (checkbox rendered, check state toggled via click — click event routed through HID gate)

**Inline spans supported:**
- Bold, italic, bold-italic
- Inline code
- Strikethrough
- Links (rendered as colored underlined text; Cmd+click opens in browser)
- Images (rendered inline from local file paths or data URIs)

**Attestation:** All buffer mutations (character insert, delete, replace) route through the existing `consume_builtin_keydowns` HID gate. The WYSIWYG widget adds no new mutation paths. Formatting shortcuts (Phase 2) inject markdown syntax characters through the same gate.

**Cursor tracking:** The widget tracks byte-offset cursor position and maps it to AST node for the "source on focus" reveal. Cursor movement, selection, and Home/End/PgUp/PgDn all work within the widget.

**Performance:** `pulldown-cmark` re-parse on every keystroke is fast enough for documents up to ~200k characters. For larger documents, re-parse is debounced to 16ms (one frame).

### Proof Publishing

Reuses the existing proof server (`proof-server/`) running on localhost. The "Publish Proof" button in the top bar:
1. Serializes the current session bundle (content + keystroke log + signature)
2. POSTs to `http://localhost:3000/sessions` (existing endpoint)
3. Displays the returned proof URL
4. Copies URL to clipboard (logged as a non-attested action, does not affect proof)

The existing replay viewer at `proof-server/public/replay.html` is unchanged.

---

## Phase 2 — Editor Features

All features work within the WYSIWYG widget. All text mutations route through the HID gate.

### Formatting Shortcuts

| Shortcut | Action |
|----------|--------|
| Cmd+B | Wrap selection in `**...**` or toggle at cursor |
| Cmd+I | Wrap selection in `*...*` |
| Cmd+K | Insert `[selection](url)` or prompt for URL |
| Cmd+` | Wrap selection in `` `...` `` |
| Cmd+Shift+H | Cycle heading level (none → H1 → H2 → H3 → none) |
| Cmd+Shift+. | Indent list item |
| Cmd+Shift+, | Outdent list item |
| Cmd+Enter | Toggle task list checkbox on current line |

All shortcuts insert/remove markdown syntax characters through the HID gate.

### Find & Replace

- Cmd+F opens a floating find bar (top-right of editor pane)
- Cmd+H opens find+replace panel
- All matches highlighted in the rendered view
- Enter / Shift+Enter cycles through matches
- Regex mode toggle
- Case-sensitive toggle
- Replace All replaces all occurrences in the buffer

### Vim Mode (complete)

Extends the current basic vim implementation:

**Motions:** `w`, `b`, `e`, `W`, `B`, `E`, `gg`, `G`, `{`, `}`, `(`, `)`, `f`/`F`/`t`/`T`/`;`/`,`, `%`

**Operators:** `d`, `c`, `y` with all motions; `dd`, `cc`, `yy` for lines

**Other:** count prefixes (`3w`, `5dd`), `.` repeat, `r` replace, `p`/`P` paste from vim register (internal only — OS clipboard not used to preserve attestation), visual mode (`v`, `V`), `o`/`O` open line, `u`/`Ctrl+R` undo/redo

**Insert mode shortcuts:** Ctrl+W (delete word back), Ctrl+U (delete to line start)

### Outline Panel

- Left sidebar listing all headings in document order
- Toggled with Cmd+Shift+O
- Click to jump cursor to that heading
- Highlights the heading containing the current cursor

### Spellcheck

- Uses macOS `NSSpellChecker` via FFI
- Red underlines on misspelled words in the rendered view
- Right-click (or Ctrl+click) shows suggestions
- Accepting a suggestion routes the replacement through the HID gate
- Per-document ignore list stored in the `.hp` file (Phase 3)

### Focus / Typewriter Mode

- Cmd+Shift+F toggles focus mode: all blocks except the one containing the cursor are dimmed to 30% opacity
- Typewriter mode (sub-option): scroll position locked so cursor stays vertically centered

### Themes

- Light, Dark, Sepia
- Follows system appearance by default (auto-switch on macOS `NSAppearanceDidChange`)
- Custom accent color picker
- Font family selector (system fonts via `NSFontManager` FFI)
- Font size slider (12–24pt)
- Line height slider (1.0–2.0)

### Status Bar

- Live word count, character count, estimated reading time
- Selection stats when text is selected: "42 words, 187 chars selected"
- Vim mode indicator when vim is enabled
- Dirty/saved indicator

### Smart Typography

- Em dashes (`--` → `—`), ellipsis (`...` → `…`), curly quotes, `(c)` → `©`
- Togglable via Edit menu; state persisted in app settings

---

## Phase 3 — File Management (Encrypted Container)

### `.hp` Container Format

Files are saved as `.hp` (HumanProof) encrypted containers. Plain `.md` files are never written during normal save — only during export (Phase 4).

**Container structure (binary, length-prefixed fields):**
```
magic:       [4 bytes]  "HPRF"
version:     [2 bytes]  u16 = 1
nonce:       [12 bytes] AES-256-GCM nonce
ciphertext:  [N bytes]  AES-256-GCM encrypted payload
tag:         [16 bytes] GCM authentication tag
```

**Encrypted payload (JSON):**
```json
{
  "markdown": "...",
  "cursor": 42,
  "undo_history": [...],
  "session": { "keystrokes": [...], "signature": "..." },
  "spellcheck_ignores": [...],
  "created_at": "...",
  "modified_at": "..."
}
```

**Encryption key:** AES-256 key derived from the ed25519 private key stored in Keychain via HKDF-SHA256 with info label `"humanproof-file-encryption-v1"`. The same Keychain entry used for signing is used for file encryption — no new secrets to manage.

**Tamper detection:** If the GCM tag fails verification on open, HumanProof refuses to load the file and shows an error. The file cannot be modified by any other application without breaking the authentication tag.

### Persistent Undo

The full edit history (undo stack) is serialized into the encrypted payload on every save. On open, the undo stack is restored. Undo works back to document creation across any number of app restarts.

Undo entries are coalesced: individual character inserts within a 500ms window are merged into one undo step.

### File Operations

| Operation | Shortcut | Behavior |
|-----------|----------|----------|
| New | Cmd+N | Creates untitled document; prompts to save if current doc is dirty |
| Open | Cmd+O | File picker filtered to `.hp` files |
| Save | Cmd+S | Saves to current path; first save triggers Save As |
| Save As | Cmd+Shift+S | File picker to choose new path |
| Close | Cmd+W | Closes tab; prompts to save if dirty |

### Tabs

- Multiple open `.hp` files as tabs in the top bar
- Each tab has its own live session and undo stack
- Dirty indicator (dot) on unsaved tabs
- Cmd+Shift+[ / Cmd+Shift+] cycles tabs

### File Tree Sidebar

- Right sidebar showing `.hp` files in a user-pinned folder
- Toggled with Cmd+Shift+E
- Click to open in new tab
- Right-click: rename, move to trash
- New file button at top of sidebar

### Recent Files

- File menu shows last 10 opened `.hp` files
- Persisted in `~/.config/humanproof/recents.json`

### Auto-save

- Debounced 2s auto-save to current file path after every edit
- Dirty indicator updates in real time

### Session Continuity

Opening an existing `.hp` file resumes the attestation session — new keystrokes append to the existing keystroke history. The proof covers the entire document lifetime from creation.

---

## Phase 4 — Export & Proof Verification

### Export

| Format | Notes |
|--------|-------|
| Markdown (`.md`) | Decrypts `.hp`, writes plain markdown. No keystroke history included. |
| HTML | Self-contained single-file HTML with embedded CSS matching current theme |
| PDF | Native macOS print pipeline (`NSPrintOperation`) — respects theme, fonts |

Export does not affect the `.hp` file or the session.

### Proof Badge

- After publishing a proof (Phase 1), user can copy an embeddable badge:
  `[![HumanProof](https://humanproof.app/badge/<session-id>.svg)](https://humanproof.app/proof/<session-id>)`
- Badge is a small SVG showing "Typed by Human" + WPM + date
- For use in GitHub READMEs, college submissions, cover letters

### Verification CLI

- Standalone binary `humanproof-verify` (distributable without the app)
- `humanproof-verify <proof-url>` or `humanproof-verify <bundle.json>`
- Verifies: ed25519 signature, keystroke timing plausibility, transport filter
- Exits 0 on valid, 1 on invalid; prints human-readable report
- Installable via Homebrew

### Partial Proofs

- User selects a range of text in the editor
- "Export Proof for Selection" generates a bundle covering only the keystrokes that produced that selection
- Useful for proving a specific paragraph or section, not the whole document

---

## Phase 5 — Distribution Polish

### Deploy Proof Server

- Move proof server off localhost to a hosted provider
- Proof URLs (`https://humanproof.app/proof/<id>`) work for anyone, not just the author
- Proof server becomes the canonical verification endpoint for the verification CLI

### Onboarding Flow

First-launch wizard (3 steps):
1. **Input Monitoring** — explains why it's needed, opens System Settings to grant access, detects when granted
2. **Key Generation** — generates ed25519 keypair, stores in Keychain, explains what the key is for
3. **First Document** — creates first `.hp` file, brief tour of the WYSIWYG editor

### Karabiner Detection

- On launch, detect if Karabiner-Elements is running
- If detected, show a one-time banner: "Karabiner intercepts keyboard events. Add HumanProof to Karabiner's excluded applications list."
- Link to setup instructions

### Auto-Update

- `tauri-plugin-updater` checks for updates on launch
- Background download, prompts to install on next launch
- Release notes shown in update dialog

### Notarization & Distribution

- Apple Developer ID code signing
- `xcrun notarytool` notarization for Gatekeeper
- DMG with drag-to-Applications installer
- Mac App Store submission (requires sandboxing audit — Input Monitoring entitlement review)

### Settings Panel

Cmd+, opens a settings window:

| Section | Settings |
|---------|----------|
| Editor | Theme, font family, font size, line height, smart typography on/off |
| Vim | Vim mode on/off by default, relative line numbers |
| Proof | Proof server URL (default: localhost for now, humanproof.app in Phase 5) |
| Privacy | Key management (view public key, rotate key) |
| Advanced | Auto-save interval, undo history limit |

### Help & Documentation

- In-app help (Cmd+Shift+/) with searchable shortcut reference
- "What is a proof?" explainer panel accessible from menu
- Input Monitoring setup guide (already stubbed in menu)

---

## Attestation Integrity Across All Phases

Every phase must uphold the following invariants:

1. **All buffer mutations route through `consume_builtin_keydowns`** — WYSIWYG formatting, spellcheck replacements, find/replace, vim operations, formatting shortcuts all insert/remove characters through the existing HID gate
2. **No external text injection** — paste from OS clipboard is blocked (existing behavior); drag-and-drop text is blocked
3. **The `.hp` file is the proof** — the encrypted container includes the full keystroke session; the signature covers content + keystrokes + timestamps
4. **Session continuity** — opening a file resumes the session; keystrokes are always appended, never rewritten

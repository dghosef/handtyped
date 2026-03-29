# Phase 1: WYSIWYG Engine + Proof Publishing Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the plain `TextEdit` in `humanproof_native.rs` with a WYSIWYG markdown editor that renders blocks visually when not focused and shows raw markdown when editing, and add a "Publish Proof" button that POSTs to the existing localhost proof server.

**Architecture:** Block-based WYSIWYG — the markdown string is parsed into `Vec<Block>` on every edit. Each block renders as a styled egui widget when not focused (headings large, lists with bullets, etc.) and as a `TextEdit` when the user clicks into it. All buffer mutations still route through the existing HID gate. Proof publishing extracts the session data from `Arc<AppState>` and calls `POST /api/sessions` on `localhost:4000` using a raw TCP connection (same pattern as the existing Tauri `upload_proof` command).

**Tech Stack:** Rust, eframe/egui 0.31, pulldown-cmark 0.13 (for inline span parsing only — block structure uses a hand-written line parser), existing `AppState`/HID infrastructure.

**Parallelization note:** Tasks A1–A6 are sequential (WYSIWYG track). Task B1 is fully independent and can be done in parallel with A3–A6.

---

## File Structure

| File | Role |
|------|------|
| `src-tauri/src/wysiwyg.rs` | New: `Block`, `BlockKind`, `parse_blocks()`, `blocks_to_markdown()`, `MarkdownEditor` widget, inline renderer |
| `src-tauri/src/upload.rs` | New: `upload_proof_native()` — standalone HTTP upload, no Tauri state wrapper |
| `src-tauri/src/bin/humanproof_native.rs` | Modified: import and use `MarkdownEditor` and `upload_proof_native`; remove old `TextEdit` editor pane |
| `src-tauri/src/lib.rs` | Modified: add `pub mod wysiwyg;` and `pub mod upload;` |

---

## Track A — WYSIWYG Engine

### Task A1: Block parser + round-trip

**Files:**
- Create: `src-tauri/src/wysiwyg.rs`
- Modify: `src-tauri/src/lib.rs`

- [ ] **Step 1: Add `pub mod wysiwyg;` to lib.rs**

In `src-tauri/src/lib.rs`, after the existing `pub mod editor;` line, add:
```rust
pub mod wysiwyg;
```

- [ ] **Step 2: Write the failing tests first**

Create `src-tauri/src/wysiwyg.rs` with only the test module and the data types:

```rust
use egui::text::{LayoutJob, TextFormat};
use egui::{Color32, FontId};

// ── Block types ──────────────────────────────────────────────────────────────

#[derive(Debug, Clone, PartialEq)]
pub enum BlockKind {
    Paragraph,
    Heading(u8),                                    // 1–6
    BulletItem { depth: usize },
    OrderedItem { depth: usize, number: usize },
    TaskItem { checked: bool },
    Blockquote,
    FencedCode { language: String },
    HorizontalRule,
    Table,
    BlankLine,
}

#[derive(Debug, Clone)]
pub struct Block {
    pub kind: BlockKind,
    /// Full raw source lines for this block (joined with '\n', no trailing newline)
    pub raw: String,
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parse_heading() {
        let blocks = parse_blocks("# Hello");
        assert_eq!(blocks.len(), 1);
        assert_eq!(blocks[0].kind, BlockKind::Heading(1));
        assert_eq!(blocks[0].raw, "# Hello");
    }

    #[test]
    fn parse_h3() {
        let blocks = parse_blocks("### Section");
        assert_eq!(blocks[0].kind, BlockKind::Heading(3));
    }

    #[test]
    fn parse_paragraph() {
        let blocks = parse_blocks("Hello world");
        assert_eq!(blocks[0].kind, BlockKind::Paragraph);
        assert_eq!(blocks[0].raw, "Hello world");
    }

    #[test]
    fn parse_bullet() {
        let blocks = parse_blocks("- item");
        assert_eq!(blocks[0].kind, BlockKind::BulletItem { depth: 0 });
        assert_eq!(blocks[0].raw, "- item");
    }

    #[test]
    fn parse_nested_bullet() {
        let blocks = parse_blocks("  - nested");
        assert_eq!(blocks[0].kind, BlockKind::BulletItem { depth: 1 });
    }

    #[test]
    fn parse_ordered() {
        let blocks = parse_blocks("1. first");
        assert_eq!(blocks[0].kind, BlockKind::OrderedItem { depth: 0, number: 1 });
    }

    #[test]
    fn parse_task_unchecked() {
        let blocks = parse_blocks("- [ ] todo");
        assert_eq!(blocks[0].kind, BlockKind::TaskItem { checked: false });
    }

    #[test]
    fn parse_task_checked() {
        let blocks = parse_blocks("- [x] done");
        assert_eq!(blocks[0].kind, BlockKind::TaskItem { checked: true });
    }

    #[test]
    fn parse_blockquote() {
        let blocks = parse_blocks("> quoted");
        assert_eq!(blocks[0].kind, BlockKind::Blockquote);
    }

    #[test]
    fn parse_fenced_code() {
        let md = "```rust\nfn main() {}\n```";
        let blocks = parse_blocks(md);
        assert_eq!(blocks[0].kind, BlockKind::FencedCode { language: "rust".into() });
        assert_eq!(blocks[0].raw, "```rust\nfn main() {}\n```");
    }

    #[test]
    fn parse_horizontal_rule() {
        let blocks = parse_blocks("---");
        assert_eq!(blocks[0].kind, BlockKind::HorizontalRule);
    }

    #[test]
    fn parse_multiple_blocks() {
        let md = "# Title\n\nParagraph one.\n\n- item a\n- item b";
        let blocks = parse_blocks(md);
        // Heading, blank, paragraph, blank, bullet, bullet
        assert!(blocks.iter().any(|b| b.kind == BlockKind::Heading(1)));
        assert!(blocks.iter().any(|b| b.kind == BlockKind::Paragraph));
        assert_eq!(blocks.iter().filter(|b| b.kind == BlockKind::BulletItem { depth: 0 }).count(), 2);
    }

    #[test]
    fn round_trip_simple() {
        let md = "# Hello\n\nWorld";
        let blocks = parse_blocks(md);
        assert_eq!(blocks_to_markdown(&blocks), md);
    }

    #[test]
    fn round_trip_fenced_code() {
        let md = "```rust\nlet x = 1;\n```";
        let blocks = parse_blocks(md);
        assert_eq!(blocks_to_markdown(&blocks), md);
    }

    #[test]
    fn round_trip_complex() {
        let md = "# Title\n\n> Quote\n\n- [ ] task\n- [x] done\n\n---\n\nEnd.";
        let blocks = parse_blocks(md);
        assert_eq!(blocks_to_markdown(&blocks), md);
    }

    #[test]
    fn parse_table() {
        let md = "| A | B |\n|---|---|\n| 1 | 2 |";
        let blocks = parse_blocks(md);
        assert_eq!(blocks.len(), 1);
        assert!(matches!(blocks[0].kind, BlockKind::Table));
        assert_eq!(blocks[0].raw, md);
    }

    #[test]
    fn round_trip_table() {
        let md = "| A | B |\n|---|---|\n| 1 | 2 |";
        let blocks = parse_blocks(md);
        assert_eq!(blocks_to_markdown(&blocks), md);
    }
}
```

- [ ] **Step 3: Run tests — confirm they fail with "unresolved"**

```bash
cargo test --manifest-path src-tauri/Cargo.toml wysiwyg 2>&1 | head -30
```
Expected: compile error "cannot find function `parse_blocks`"

- [ ] **Step 4: Implement `parse_blocks` and `blocks_to_markdown`**

Add these functions to `src-tauri/src/wysiwyg.rs` (above the `#[cfg(test)]` block):

```rust
/// Parse a markdown string into a sequence of blocks.
/// Each block maps to one or more contiguous source lines.
pub fn parse_blocks(markdown: &str) -> Vec<Block> {
    let mut blocks: Vec<Block> = Vec::new();
    let lines: Vec<&str> = markdown.split('\n').collect();
    let mut i = 0;

    while i < lines.len() {
        let line = lines[i];

        // Blank line
        if line.trim().is_empty() {
            blocks.push(Block { kind: BlockKind::BlankLine, raw: String::new() });
            i += 1;
            continue;
        }

        // Horizontal rule: ---, ***, ___  (3+ identical chars, optional spaces)
        if is_horizontal_rule(line) {
            blocks.push(Block { kind: BlockKind::HorizontalRule, raw: line.to_string() });
            i += 1;
            continue;
        }

        // Fenced code block
        if line.trim_start().starts_with("```") {
            let fence_indent = line.len() - line.trim_start().len();
            let lang = line.trim_start().trim_start_matches('`').trim().to_string();
            let mut raw_lines = vec![line.to_string()];
            i += 1;
            while i < lines.len() {
                let l = lines[i];
                raw_lines.push(l.to_string());
                if l.trim_start_matches(' ').len() >= fence_indent
                    && l[fence_indent.min(l.len())..].starts_with("```")
                {
                    i += 1;
                    break;
                }
                i += 1;
            }
            blocks.push(Block {
                kind: BlockKind::FencedCode { language: lang },
                raw: raw_lines.join("\n"),
            });
            continue;
        }

        // Heading
        if let Some(level) = heading_level(line) {
            blocks.push(Block { kind: BlockKind::Heading(level), raw: line.to_string() });
            i += 1;
            continue;
        }

        // Table: first line starts with '|', collect all consecutive '|' lines
        if line.trim_start().starts_with('|') {
            let mut raw_lines = vec![line.to_string()];
            i += 1;
            while i < lines.len() && lines[i].trim_start().starts_with('|') {
                raw_lines.push(lines[i].to_string());
                i += 1;
            }
            blocks.push(Block {
                kind: BlockKind::Table,
                raw: raw_lines.join("\n"),
            });
            continue;
        }

        // Blockquote
        if line.trim_start().starts_with("> ") || line.trim_start() == ">" {
            blocks.push(Block { kind: BlockKind::Blockquote, raw: line.to_string() });
            i += 1;
            continue;
        }

        // Task item (must check before bullet)
        if let Some(checked) = task_item(line) {
            blocks.push(Block { kind: BlockKind::TaskItem { checked }, raw: line.to_string() });
            i += 1;
            continue;
        }

        // Bullet item
        if let Some(depth) = bullet_depth(line) {
            blocks.push(Block { kind: BlockKind::BulletItem { depth }, raw: line.to_string() });
            i += 1;
            continue;
        }

        // Ordered item
        if let Some((depth, number)) = ordered_item(line) {
            blocks.push(Block {
                kind: BlockKind::OrderedItem { depth, number },
                raw: line.to_string(),
            });
            i += 1;
            continue;
        }

        // Paragraph (everything else)
        blocks.push(Block { kind: BlockKind::Paragraph, raw: line.to_string() });
        i += 1;
    }

    blocks
}

/// Reconstruct a markdown string from blocks. Exact inverse of `parse_blocks`.
pub fn blocks_to_markdown(blocks: &[Block]) -> String {
    blocks
        .iter()
        .map(|b| match &b.kind {
            BlockKind::BlankLine => String::new(),
            _ => b.raw.clone(),
        })
        .collect::<Vec<_>>()
        .join("\n")
}

// ── Parser helpers ────────────────────────────────────────────────────────────

fn heading_level(line: &str) -> Option<u8> {
    let trimmed = line.trim_start();
    let hashes = trimmed.chars().take_while(|&c| c == '#').count();
    if hashes >= 1 && hashes <= 6 {
        let rest = &trimmed[hashes..];
        if rest.is_empty() || rest.starts_with(' ') {
            return Some(hashes as u8);
        }
    }
    None
}

fn is_horizontal_rule(line: &str) -> bool {
    let t = line.trim();
    if t.len() < 3 { return false; }
    let ch = t.chars().next().unwrap();
    if !matches!(ch, '-' | '*' | '_') { return false; }
    t.chars().all(|c| c == ch || c == ' ') && t.chars().filter(|&c| c == ch).count() >= 3
}

fn bullet_depth(line: &str) -> Option<usize> {
    let spaces = line.chars().take_while(|&c| c == ' ').count();
    let rest = &line[spaces..];
    if rest.starts_with("- ") || rest.starts_with("* ") || rest.starts_with("+ ") {
        Some(spaces / 2)
    } else {
        None
    }
}

fn task_item(line: &str) -> Option<bool> {
    let spaces = line.chars().take_while(|&c| c == ' ').count();
    let rest = &line[spaces..];
    if rest.starts_with("- [ ] ") || rest.starts_with("- [ ]") {
        Some(false)
    } else if rest.starts_with("- [x] ") || rest.starts_with("- [x]") {
        Some(true)
    } else {
        None
    }
}

fn ordered_item(line: &str) -> Option<(usize, usize)> {
    let spaces = line.chars().take_while(|&c| c == ' ').count();
    let rest = &line[spaces..];
    let dot = rest.find(". ")?;
    let num_str = &rest[..dot];
    if num_str.chars().all(|c| c.is_ascii_digit()) && !num_str.is_empty() {
        let n: usize = num_str.parse().ok()?;
        Some((spaces / 2, n))
    } else {
        None
    }
}
```

- [ ] **Step 5: Run tests — confirm they pass**

```bash
cargo test --manifest-path src-tauri/Cargo.toml wysiwyg 2>&1
```
Expected: all tests in `wysiwyg` pass. Build warnings OK.

- [ ] **Step 6: Commit**

```bash
cd /Users/dghosef/editor
git add src-tauri/src/wysiwyg.rs src-tauri/src/lib.rs
git commit -m "feat(wysiwyg): block parser and round-trip reconstruction"
```

---

### Task A2: Inline span renderer (LayoutJob)

**Files:**
- Modify: `src-tauri/src/wysiwyg.rs`

- [ ] **Step 1: Write failing tests for inline renderer**

Add to the `#[cfg(test)]` block in `wysiwyg.rs`:

```rust
    #[test]
    fn inline_segments_plain() {
        let segs = parse_inline("hello world");
        assert_eq!(segs.len(), 1);
        assert_eq!(segs[0], InlineSpan::Plain("hello world".into()));
    }

    #[test]
    fn inline_segments_bold() {
        let segs = parse_inline("hello **world** end");
        assert!(segs.iter().any(|s| matches!(s, InlineSpan::Bold(t) if t == "world")));
    }

    #[test]
    fn inline_segments_italic() {
        let segs = parse_inline("say *hi* now");
        assert!(segs.iter().any(|s| matches!(s, InlineSpan::Italic(t) if t == "hi")));
    }

    #[test]
    fn inline_segments_code() {
        let segs = parse_inline("use `foo()` here");
        assert!(segs.iter().any(|s| matches!(s, InlineSpan::Code(t) if t == "foo()")));
    }

    #[test]
    fn inline_segments_strikethrough() {
        let segs = parse_inline("~~old~~ new");
        assert!(segs.iter().any(|s| matches!(s, InlineSpan::Strikethrough(t) if t == "old")));
    }

    #[test]
    fn inline_segments_mixed() {
        let segs = parse_inline("**bold** and *italic*");
        assert!(segs.iter().any(|s| matches!(s, InlineSpan::Bold(_))));
        assert!(segs.iter().any(|s| matches!(s, InlineSpan::Italic(_))));
    }

    #[test]
    fn inline_segments_link() {
        let segs = parse_inline("see [rust](https://rust-lang.org) here");
        assert!(segs.iter().any(|s| matches!(s, InlineSpan::Link { text, .. } if text == "rust")));
    }
```

- [ ] **Step 2: Run — confirm compile failure**

```bash
cargo test --manifest-path src-tauri/Cargo.toml wysiwyg::tests::inline 2>&1 | head -20
```
Expected: compile error about `InlineSpan` and `parse_inline`.

- [ ] **Step 3: Implement `InlineSpan` and `parse_inline`**

Add before the `#[cfg(test)]` block:

```rust
// ── Inline spans ──────────────────────────────────────────────────────────────

#[derive(Debug, Clone, PartialEq)]
pub enum InlineSpan {
    Plain(String),
    Bold(String),
    Italic(String),
    BoldItalic(String),
    Code(String),
    Strikethrough(String),
    /// [text](url)
    Link { text: String, url: String },
}

/// Parse a string into a flat list of inline spans.
/// Handles: **bold**, *italic*, ***bold-italic***, `code`, ~~strikethrough~~, [text](url).
/// Does not handle nested spans (intentional: keeps rendering simple).
pub fn parse_inline(text: &str) -> Vec<InlineSpan> {
    let mut spans = Vec::new();
    let chars: Vec<char> = text.chars().collect();
    let mut i = 0;
    let mut plain_start = 0;

    macro_rules! flush_plain {
        ($end:expr) => {
            if plain_start < $end {
                let s: String = chars[plain_start..$end].iter().collect();
                if !s.is_empty() {
                    spans.push(InlineSpan::Plain(s));
                }
            }
        };
    }

    while i < chars.len() {
        // Bold-italic: ***
        if chars[i] == '*' && i + 2 < chars.len() && chars[i+1] == '*' && chars[i+2] == '*' {
            if let Some(end) = find_closing(&chars, i + 3, "***") {
                flush_plain!(i);
                let inner: String = chars[i+3..end].iter().collect();
                spans.push(InlineSpan::BoldItalic(inner));
                i = end + 3;
                plain_start = i;
                continue;
            }
        }
        // Bold: **
        if chars[i] == '*' && i + 1 < chars.len() && chars[i+1] == '*' {
            if let Some(end) = find_closing(&chars, i + 2, "**") {
                flush_plain!(i);
                let inner: String = chars[i+2..end].iter().collect();
                spans.push(InlineSpan::Bold(inner));
                i = end + 2;
                plain_start = i;
                continue;
            }
        }
        // Italic: *
        if chars[i] == '*' && (i == 0 || chars[i-1] != '*') {
            if let Some(end) = find_closing(&chars, i + 1, "*") {
                flush_plain!(i);
                let inner: String = chars[i+1..end].iter().collect();
                spans.push(InlineSpan::Italic(inner));
                i = end + 1;
                plain_start = i;
                continue;
            }
        }
        // Code: `
        if chars[i] == '`' {
            if let Some(end) = find_closing(&chars, i + 1, "`") {
                flush_plain!(i);
                let inner: String = chars[i+1..end].iter().collect();
                spans.push(InlineSpan::Code(inner));
                i = end + 1;
                plain_start = i;
                continue;
            }
        }
        // Strikethrough: ~~
        if chars[i] == '~' && i + 1 < chars.len() && chars[i+1] == '~' {
            if let Some(end) = find_closing(&chars, i + 2, "~~") {
                flush_plain!(i);
                let inner: String = chars[i+2..end].iter().collect();
                spans.push(InlineSpan::Strikethrough(inner));
                i = end + 2;
                plain_start = i;
                continue;
            }
        }
        // Link: [text](url)
        if chars[i] == '[' {
            if let Some(text_end) = find_closing(&chars, i + 1, "]") {
                let after_bracket = text_end + 1;
                if after_bracket < chars.len() && chars[after_bracket] == '(' {
                    if let Some(url_end) = find_closing(&chars, after_bracket + 1, ")") {
                        flush_plain!(i);
                        let text: String = chars[i+1..text_end].iter().collect();
                        let url: String = chars[after_bracket+1..url_end].iter().collect();
                        spans.push(InlineSpan::Link { text, url });
                        i = url_end + 1;
                        plain_start = i;
                        continue;
                    }
                }
            }
        }
        i += 1;
    }
    flush_plain!(chars.len());
    spans
}

fn find_closing(chars: &[char], start: usize, marker: &str) -> Option<usize> {
    let mc: Vec<char> = marker.chars().collect();
    let mlen = mc.len();
    for i in start..chars.len().saturating_sub(mlen - 1) {
        if chars[i..i+mlen] == mc[..] {
            return Some(i);
        }
    }
    None
}
```

- [ ] **Step 4: Run inline tests — confirm they pass**

```bash
cargo test --manifest-path src-tauri/Cargo.toml wysiwyg 2>&1
```
Expected: all wysiwyg tests pass.

- [ ] **Step 5: Add `build_inline_layout_job` function**

Add after `parse_inline` (this is UI code — no unit test, will be visually verified in A3):

```rust
/// Build an egui LayoutJob from inline spans for display-mode rendering.
pub fn build_inline_layout_job(
    text: &str,
    base_font: FontId,
    base_color: Color32,
    code_bg: Color32,
) -> LayoutJob {
    let mut job = LayoutJob::default();
    for span in parse_inline(text) {
        match span {
            InlineSpan::Plain(s) => {
                job.append(&s, 0.0, TextFormat {
                    font_id: base_font.clone(),
                    color: base_color,
                    ..Default::default()
                });
            }
            InlineSpan::Bold(s) => {
                job.append(&s, 0.0, TextFormat {
                    font_id: FontId::new(base_font.size, egui::FontFamily::Name("Bold".into())),
                    color: base_color,
                    ..Default::default()
                });
            }
            InlineSpan::Italic(s) => {
                job.append(&s, 0.0, TextFormat {
                    font_id: base_font.clone(),
                    color: base_color,
                    italics: true,
                    ..Default::default()
                });
            }
            InlineSpan::BoldItalic(s) => {
                job.append(&s, 0.0, TextFormat {
                    font_id: FontId::new(base_font.size, egui::FontFamily::Name("Bold".into())),
                    color: base_color,
                    italics: true,
                    ..Default::default()
                });
            }
            InlineSpan::Code(s) => {
                job.append(&s, 0.0, TextFormat {
                    font_id: FontId::monospace(base_font.size),
                    color: Color32::from_rgb(200, 120, 80),
                    background: code_bg,
                    ..Default::default()
                });
            }
            InlineSpan::Strikethrough(s) => {
                job.append(&s, 0.0, TextFormat {
                    font_id: base_font.clone(),
                    color: base_color.linear_multiply(0.5),
                    strikethrough: egui::Stroke::new(1.0, base_color.linear_multiply(0.5)),
                    ..Default::default()
                });
            }
            InlineSpan::Link { text, .. } => {
                job.append(&text, 0.0, TextFormat {
                    font_id: base_font.clone(),
                    color: egui::Color32::from_rgb(100, 160, 230),
                    underline: egui::Stroke::new(1.0, egui::Color32::from_rgb(100, 160, 230)),
                    ..Default::default()
                });
            }
        }
    }
    job
}
```

- [ ] **Step 6: Run all tests — confirm no regressions**

```bash
cargo test --manifest-path src-tauri/Cargo.toml 2>&1
```
Expected: all tests pass.

- [ ] **Step 7: Commit**

```bash
git add src-tauri/src/wysiwyg.rs
git commit -m "feat(wysiwyg): inline span parser and LayoutJob renderer"
```

---

### Task A3: MarkdownEditor widget — display mode

**Files:**
- Modify: `src-tauri/src/wysiwyg.rs`
- Modify: `src-tauri/src/bin/humanproof_native.rs`

- [ ] **Step 1: Add `MarkdownEditor` struct and skeleton `show()` to `wysiwyg.rs`**

Add after `build_inline_layout_job`:

```rust
// ── MarkdownEditor widget ─────────────────────────────────────────────────────

pub struct MarkdownEditor {
    blocks: Vec<Block>,
    /// Index of the currently-focused (editing) block, if any
    pub focused_block: Option<usize>,
}

impl MarkdownEditor {
    pub fn new(markdown: &str) -> Self {
        Self {
            blocks: parse_blocks(markdown),
            focused_block: None,
        }
    }

    /// Rebuild blocks from a new markdown string (called after external changes).
    pub fn set_markdown(&mut self, markdown: &str) {
        self.blocks = parse_blocks(markdown);
        // Keep focused_block if still in range
        if let Some(idx) = self.focused_block {
            if idx >= self.blocks.len() {
                self.focused_block = None;
            }
        }
    }

    /// Reconstruct the full markdown string from current blocks.
    pub fn to_markdown(&self) -> String {
        blocks_to_markdown(&self.blocks)
    }

    /// Render the editor. Returns true if the document was modified.
    pub fn show(&mut self, ui: &mut egui::Ui) -> bool {
        let mut changed = false;
        let block_count = self.blocks.len();

        egui::ScrollArea::vertical()
            .id_salt("md_editor_scroll")
            .show(ui, |ui| {
                ui.set_min_width(ui.available_width());

                for idx in 0..block_count {
                    let is_focused = self.focused_block == Some(idx);
                    let block_changed = self.show_block(ui, idx, is_focused);
                    if block_changed { changed = true; }
                }
            });

        changed
    }

    fn show_block(&mut self, ui: &mut egui::Ui, idx: usize, is_focused: bool) -> bool {
        let block = &self.blocks[idx];

        match &block.kind.clone() {
            BlockKind::BlankLine => {
                ui.add_space(8.0);
                false
            }
            BlockKind::HorizontalRule => {
                ui.add_space(4.0);
                ui.separator();
                ui.add_space(4.0);
                false
            }
            _ if is_focused => self.show_block_edit(ui, idx),
            _ => self.show_block_display(ui, idx),
        }
    }

    fn show_block_display(&mut self, ui: &mut egui::Ui, idx: usize) -> bool {
        let block = &self.blocks[idx];
        let visuals = ui.visuals();
        let text_color = visuals.text_color();
        let code_bg = visuals.code_bg_color;

        let response = match &block.kind.clone() {
            BlockKind::Heading(level) => {
                let content = strip_heading_markers(&block.raw);
                let size = match level {
                    1 => 32.0,
                    2 => 26.0,
                    3 => 22.0,
                    4 => 19.0,
                    5 => 17.0,
                    _ => 15.0,
                };
                let job = build_inline_layout_job(
                    content,
                    FontId::proportional(size),
                    text_color,
                    code_bg,
                );
                ui.add_space(8.0);
                let r = ui.label(job);
                ui.add_space(4.0);
                r
            }

            BlockKind::Paragraph => {
                let job = build_inline_layout_job(
                    &block.raw,
                    FontId::proportional(15.0),
                    text_color,
                    code_bg,
                );
                ui.label(job)
            }

            BlockKind::BulletItem { depth } => {
                ui.horizontal(|ui| {
                    ui.add_space(*depth as f32 * 20.0);
                    ui.label("•");
                    let content = strip_bullet_markers(&block.raw);
                    let job = build_inline_layout_job(
                        content,
                        FontId::proportional(15.0),
                        text_color,
                        code_bg,
                    );
                    ui.label(job);
                }).response
            }

            BlockKind::OrderedItem { depth, number } => {
                ui.horizontal(|ui| {
                    ui.add_space(*depth as f32 * 20.0);
                    ui.label(format!("{}.", number));
                    let content = strip_ordered_markers(&block.raw);
                    let job = build_inline_layout_job(
                        content,
                        FontId::proportional(15.0),
                        text_color,
                        code_bg,
                    );
                    ui.label(job);
                }).response
            }

            BlockKind::TaskItem { checked } => {
                let mut ch = *checked;
                let response = ui.horizontal(|ui| {
                    ui.checkbox(&mut ch, "");
                    let content = strip_task_markers(&block.raw);
                    let job = build_inline_layout_job(
                        content,
                        FontId::proportional(15.0),
                        if ch { text_color.linear_multiply(0.5) } else { text_color },
                        code_bg,
                    );
                    ui.label(job);
                }).response;
                if ch != *checked {
                    // Toggle checked state by rewriting the raw line
                    let new_raw = if ch {
                        block.raw.replacen("- [ ]", "- [x]", 1)
                    } else {
                        block.raw.replacen("- [x]", "- [ ]", 1)
                    };
                    self.blocks[idx].raw = new_raw;
                    self.blocks[idx].kind = BlockKind::TaskItem { checked: ch };
                    return true;
                }
                response
            }

            BlockKind::Blockquote => {
                ui.horizontal(|ui| {
                    // Left border
                    let bar_rect = egui::Rect::from_min_size(
                        ui.cursor().min,
                        egui::vec2(3.0, 20.0),
                    );
                    ui.painter().rect_filled(bar_rect, 0.0, egui::Color32::GRAY);
                    ui.add_space(8.0);
                    let content = strip_blockquote_markers(&block.raw);
                    let job = build_inline_layout_job(
                        content,
                        FontId::proportional(15.0),
                        text_color.linear_multiply(0.75),
                        code_bg,
                    );
                    ui.label(job);
                }).response
            }

            BlockKind::FencedCode { language } => {
                let content = strip_fence_markers(&block.raw);
                ui.add_space(4.0);
                let r = egui::Frame::new()
                    .fill(code_bg)
                    .inner_margin(egui::Margin::same(8))
                    .show(ui, |ui| {
                        if !language.is_empty() {
                            ui.label(
                                egui::RichText::new(language.as_str())
                                    .small()
                                    .color(text_color.linear_multiply(0.5))
                            );
                        }
                        ui.label(egui::RichText::new(content).monospace().color(text_color));
                    })
                    .response;
                ui.add_space(4.0);
                r
            }

            BlockKind::Table => {
                // Render table rows as a simple egui Grid
                let lines: Vec<&str> = block.raw.lines().collect();
                egui::Grid::new(format!("table_{idx}"))
                    .striped(true)
                    .show(ui, |ui| {
                        for (row_idx, line) in lines.iter().enumerate() {
                            // Skip separator rows (e.g., |---|---|)
                            let is_separator = line.trim_matches(|c: char| c == '|' || c == '-' || c == ' ' || c == ':').is_empty();
                            if is_separator { continue; }
                            let cells: Vec<&str> = line.split('|')
                                .map(|c| c.trim())
                                .filter(|c| !c.is_empty())
                                .collect();
                            for cell in &cells {
                                let job = build_inline_layout_job(
                                    cell,
                                    FontId::proportional(if row_idx == 0 { 15.0 } else { 14.0 }),
                                    text_color,
                                    code_bg,
                                );
                                ui.label(job);
                            }
                            ui.end_row();
                        }
                    })
                    .response
            }

            BlockKind::BlankLine | BlockKind::HorizontalRule => unreachable!(),
        };

        // Click on a display block to focus it for editing
        if response.clicked() {
            self.focused_block = Some(idx);
        }

        false
    }

    fn show_block_edit(&mut self, ui: &mut egui::Ui, idx: usize) -> bool {
        // Placeholder — implemented in Task A4
        let block = &mut self.blocks[idx];
        let response = egui::TextEdit::multiline(&mut block.raw)
            .desired_width(f32::INFINITY)
            .font(egui::TextStyle::Monospace)
            .show(ui);
        if response.response.lost_focus() {
            self.focused_block = None;
        }
        response.response.changed()
    }
}

// ── Display helpers ───────────────────────────────────────────────────────────

fn strip_heading_markers(raw: &str) -> &str {
    let t = raw.trim_start_matches('#');
    t.strip_prefix(' ').unwrap_or(t)
}

fn strip_bullet_markers(raw: &str) -> &str {
    let t = raw.trim_start_matches(' ');
    let t = t.strip_prefix("- ").or_else(|| t.strip_prefix("* ")).or_else(|| t.strip_prefix("+ ")).unwrap_or(t);
    t
}

fn strip_ordered_markers(raw: &str) -> &str {
    let t = raw.trim_start_matches(' ');
    if let Some(dot) = t.find(". ") {
        &t[dot + 2..]
    } else {
        t
    }
}

fn strip_task_markers(raw: &str) -> &str {
    let t = raw.trim_start_matches(' ');
    let t = t.strip_prefix("- [ ] ").or_else(|| t.strip_prefix("- [x] "))
             .or_else(|| t.strip_prefix("- [ ]")).or_else(|| t.strip_prefix("- [x]"))
             .unwrap_or(t);
    t
}

fn strip_blockquote_markers(raw: &str) -> &str {
    let t = raw.trim_start();
    t.strip_prefix("> ").or_else(|| t.strip_prefix(">")).unwrap_or(t)
}

fn strip_fence_markers(raw: &str) -> &str {
    let lines: Vec<&str> = raw.lines().collect();
    if lines.len() < 2 { return raw; }
    // Drop first and last line (the fences)
    &raw[raw.find('\n').map(|i| i + 1).unwrap_or(0)
        ..raw.rfind('\n').unwrap_or(raw.len())]
}
```

- [ ] **Step 2: Run cargo build — confirm it compiles**

```bash
cargo build --manifest-path src-tauri/Cargo.toml --bin humanproof_native 2>&1 | grep -E "^error" | head -20
```
Expected: 0 errors (warnings OK).

- [ ] **Step 3: Wire `MarkdownEditor` into `humanproof_native.rs`**

In `humanproof_native.rs`, add to imports at the top:
```rust
use humanproof_lib::wysiwyg::MarkdownEditor;
```

Replace the `NativeEditorApp` struct definition:
```rust
struct NativeEditorApp {
    state: Arc<AppState>,
    editor: MarkdownEditor,
    persisted_markdown: String,
    pane_mode: PaneMode,
    vim_enabled: bool,
    vim_mode: VimMode,
    status: String,
}
```

Replace `NativeEditorApp::new`:
```rust
fn new(_cc: &eframe::CreationContext<'_>, state: Arc<AppState>) -> Self {
    let loaded = state.editor_state.lock().unwrap().clone();
    let pane_mode = match loaded.mode {
        EditorMode::Split => PaneMode::Split,
        EditorMode::Source => PaneMode::Source,
    };
    Self {
        state,
        editor: MarkdownEditor::new(&loaded.markdown),
        persisted_markdown: loaded.markdown,
        pane_mode,
        vim_enabled: false,
        vim_mode: VimMode::Insert,
        status: "Ready".into(),
    }
}
```

Replace `persist()`:
```rust
fn persist(&mut self) {
    let md = self.editor.to_markdown();
    let state = EditorDocumentState {
        markdown: md.clone(),
        cursor: 0,
        mode: match self.pane_mode {
            PaneMode::Split => EditorMode::Split,
            PaneMode::Source => EditorMode::Source,
        },
    };
    match editor::save_editor_state_to_disk(&state) {
        Ok(()) => {
            self.persisted_markdown = md;
            self.status = "Saved".into();
        }
        Err(err) => self.status = format!("Save failed: {err}"),
    }
}
```

Replace `editor_pane()` and update `top_bar()` word count:
```rust
fn editor_pane(&mut self, ui: &mut egui::Ui) {
    let changed = self.editor.show(ui);
    if changed && !self.frame_input_allowed(ui.ctx()) {
        // Undo: reparse from last persisted markdown
        self.editor.set_markdown(&self.persisted_markdown);
        self.status = "Blocked non-built-in input".into();
    } else if changed {
        self.status = "Edited".into();
    }
}
```

In `top_bar()`, replace the word/char count labels:
```rust
let md = self.editor.to_markdown();
ui.label(format!("Chars: {}", md.chars().count()));
ui.label(format!("Words: {}", md.split_whitespace().count()));
```

In the `update()` method, replace the dirty check:
```rust
fn update(&mut self, ctx: &egui::Context, _frame: &mut eframe::Frame) {
    let current_md = self.editor.to_markdown();
    if current_md != self.persisted_markdown {
        self.persist();
    }
    // ... rest unchanged
}
```

Remove the now-unused `markdown`, `cursor` fields and any references to them (including in `apply_normal_mode_key` and `maybe_handle_vim` — these will be reworked in Task A5).

- [ ] **Step 4: Build — confirm it compiles**

```bash
cargo build --manifest-path src-tauri/Cargo.toml --bin humanproof_native 2>&1 | grep "^error" | head -20
```
Expected: 0 errors.

- [ ] **Step 5: Run tests**

```bash
cargo test --manifest-path src-tauri/Cargo.toml 2>&1
```
Expected: all tests pass.

- [ ] **Step 6: Visual smoke test**

```bash
npm run dev:native
```
Open the app. Verify:
- Headings render large
- Bullets render with `•`
- Code blocks have background fill
- Clicking a block switches to TextEdit

- [ ] **Step 7: Commit**

```bash
git add src-tauri/src/wysiwyg.rs src-tauri/src/bin/humanproof_native.rs
git commit -m "feat(wysiwyg): MarkdownEditor display mode wired into native app"
```

---

### Task A4: Block edit mode with HID gate

**Files:**
- Modify: `src-tauri/src/wysiwyg.rs`
- Modify: `src-tauri/src/bin/humanproof_native.rs`

The `show_block_edit` placeholder in A3 uses a raw `TextEdit` but doesn't apply the HID gate. This task wires the gate in properly.

- [ ] **Step 1: Add HID-gated `show` variant to `MarkdownEditor`**

Replace the `show()` signature to accept HID state, and update `editor_pane` in `humanproof_native.rs` to pass it.

In `wysiwyg.rs`, change `show()`:
```rust
/// Render the editor. `hid_ok` must be true for any edit to be accepted.
/// Returns true if the document was modified.
pub fn show(&mut self, ui: &mut egui::Ui, hid_ok: bool) -> bool {
    let mut changed = false;
    let block_count = self.blocks.len();

    egui::ScrollArea::vertical()
        .id_salt("md_editor_scroll")
        .show(ui, |ui| {
            ui.set_min_width(ui.available_width());
            for idx in 0..block_count {
                let is_focused = self.focused_block == Some(idx);
                let block_changed = self.show_block(ui, idx, is_focused, hid_ok);
                if block_changed { changed = true; }
            }
        });

    changed
}
```

Update `show_block` signature to pass `hid_ok`:
```rust
fn show_block(&mut self, ui: &mut egui::Ui, idx: usize, is_focused: bool, hid_ok: bool) -> bool {
    // ... (add hid_ok to the match arm calls)
    _ if is_focused => self.show_block_edit(ui, idx, hid_ok),
    _ => self.show_block_display(ui, idx),  // display mode never modifies, hid_ok not needed
    // ...
}
```

Replace `show_block_edit` with the full HID-gated implementation:
```rust
fn show_block_edit(&mut self, ui: &mut egui::Ui, idx: usize, hid_ok: bool) -> bool {
    let block = &mut self.blocks[idx];
    let before = block.raw.clone();

    let output = egui::TextEdit::multiline(&mut block.raw)
        .desired_width(f32::INFINITY)
        .font(egui::TextStyle::Monospace)
        .show(ui);

    if output.response.changed() {
        if !hid_ok {
            // Roll back the edit
            block.raw = before;
            return false;
        }
        // Reclassify block kind based on new raw content
        let new_blocks = parse_blocks(&block.raw);
        if let Some(new_block) = new_blocks.into_iter().next() {
            block.kind = new_block.kind;
        }
        return true;
    }

    if output.response.lost_focus() {
        self.focused_block = None;
    }

    false
}
```

- [ ] **Step 2: Update `editor_pane` in `humanproof_native.rs`**

```rust
fn editor_pane(&mut self, ui: &mut egui::Ui) {
    let hid_ok = self.frame_input_allowed(ui.ctx());
    let changed = self.editor.show(ui, hid_ok);
    if changed {
        self.status = "Edited".into();
    }
}
```

(The HID gate is now inside `show()` itself — no need for the reparse-on-block logic from A3.)

- [ ] **Step 3: Build and test**

```bash
cargo build --manifest-path src-tauri/Cargo.toml --bin humanproof_native 2>&1 | grep "^error"
cargo test --manifest-path src-tauri/Cargo.toml 2>&1
```
Expected: 0 errors, all tests pass.

- [ ] **Step 4: Visual smoke test**

```bash
npm run dev:native
```
Verify: typing in a focused block updates the document. Without HID active, typing should be blocked.

- [ ] **Step 5: Commit**

```bash
git add src-tauri/src/wysiwyg.rs src-tauri/src/bin/humanproof_native.rs
git commit -m "feat(wysiwyg): HID-gated block editing"
```

---

### Task A5: Keyboard navigation between blocks

**Files:**
- Modify: `src-tauri/src/wysiwyg.rs`

This task handles: arrow-up/down at block boundary moves to adjacent block, Enter at end of paragraph creates a new blank paragraph, Backspace at start of a block merges with the previous.

- [ ] **Step 1: Write failing tests**

Add to the `#[cfg(test)]` block:

```rust
    #[test]
    fn enter_at_end_splits_paragraph() {
        let mut ed = MarkdownEditor::new("Hello world");
        ed.focused_block = Some(0);
        // Simulate Enter at position 5 (after "Hello")
        ed.handle_enter_at(0, 5);
        let md = ed.to_markdown();
        // Should produce two blocks: "Hello" and " world" (or "world")
        assert!(md.contains('\n'));
        let blocks = parse_blocks(&md);
        let non_blank: Vec<_> = blocks.iter().filter(|b| b.kind != BlockKind::BlankLine).collect();
        assert_eq!(non_blank.len(), 2);
    }

    #[test]
    fn backspace_at_start_merges_blocks() {
        let mut ed = MarkdownEditor::new("First\nSecond");
        ed.focused_block = Some(1);
        ed.handle_backspace_at_block_start(1);
        let blocks: Vec<_> = ed.blocks.iter().filter(|b| b.kind != BlockKind::BlankLine).collect();
        assert_eq!(blocks.len(), 1);
        assert_eq!(blocks[0].raw, "FirstSecond");
    }
```

- [ ] **Step 2: Run — confirm failure**

```bash
cargo test --manifest-path src-tauri/Cargo.toml wysiwyg::tests::enter_at 2>&1 | head -20
cargo test --manifest-path src-tauri/Cargo.toml wysiwyg::tests::backspace 2>&1 | head -20
```
Expected: compile error (methods not found).

- [ ] **Step 3: Implement `handle_enter_at` and `handle_backspace_at_block_start`**

Add to `impl MarkdownEditor`:

```rust
/// Split a block at byte offset `pos` within its `raw` string.
/// The block at `idx` becomes the text before `pos`;
/// a new Paragraph block with the text from `pos` onwards is inserted after.
pub fn handle_enter_at(&mut self, idx: usize, pos: usize) {
    let raw = self.blocks[idx].raw.clone();
    let (before, after) = raw.split_at(pos.min(raw.len()));
    self.blocks[idx].raw = before.to_string();
    // Reclassify the current block
    if let Some(b) = parse_blocks(before).into_iter().next() {
        self.blocks[idx].kind = b.kind;
    }
    let new_block = Block {
        kind: BlockKind::Paragraph,
        raw: after.to_string(),
    };
    self.blocks.insert(idx + 1, new_block);
    self.focused_block = Some(idx + 1);
}

/// Merge block at `idx` into the block before it (if any).
/// The cursor conceptually lands at the join point.
pub fn handle_backspace_at_block_start(&mut self, idx: usize) {
    if idx == 0 { return; }
    let current_raw = self.blocks[idx].raw.clone();
    self.blocks.remove(idx);
    let prev = &mut self.blocks[idx - 1];
    prev.raw.push_str(&current_raw);
    // Reclassify
    if let Some(b) = parse_blocks(&prev.raw.clone()).into_iter().next() {
        prev.kind = b.kind;
    }
    self.focused_block = Some(idx - 1);
}
```

- [ ] **Step 4: Run tests**

```bash
cargo test --manifest-path src-tauri/Cargo.toml wysiwyg 2>&1
```
Expected: all wysiwyg tests pass.

- [ ] **Step 5: Wire keyboard events into `show_block_edit`**

In `show_block_edit`, after the `TextEdit::show` call, add key handling:

```rust
// Keyboard navigation between blocks (check before handling TextEdit changes)
ui.input(|input| {
    // Enter at end of block → split
    if input.key_pressed(egui::Key::Enter) && hid_ok {
        // The TextEdit has already handled Enter by inserting a newline.
        // We intercept it here only when there's a newline inserted
        // at end-of-block. For now, Enter inside a block is left to the TextEdit.
        // Cross-block Enter is handled by watching for \n in the block raw.
    }
    // Arrow up at top of block → focus previous block
    if input.key_pressed(egui::Key::ArrowUp) {
        if idx > 0 {
            self.focused_block = Some(idx - 1);
        }
    }
    // Arrow down at bottom → focus next block
    if input.key_pressed(egui::Key::ArrowDown) {
        let next = idx + 1;
        if next < self.blocks.len() {
            self.focused_block = Some(next);
        }
    }
    // Escape → unfocus
    if input.key_pressed(egui::Key::Escape) {
        self.focused_block = None;
    }
});
```

Note: Full Enter-to-split and Backspace-to-merge requires intercepting before egui's TextEdit handles those keys; this is deferred to a follow-up. The `handle_enter_at` / `handle_backspace_at_block_start` methods are tested and ready for wiring.

- [ ] **Step 6: Build and test**

```bash
cargo build --manifest-path src-tauri/Cargo.toml --bin humanproof_native 2>&1 | grep "^error"
cargo test --manifest-path src-tauri/Cargo.toml 2>&1
```

- [ ] **Step 7: Commit**

```bash
git add src-tauri/src/wysiwyg.rs
git commit -m "feat(wysiwyg): keyboard navigation and block split/merge logic"
```

---

### Task A6: Remove old TextEdit code + final integration

**Files:**
- Modify: `src-tauri/src/bin/humanproof_native.rs`

- [ ] **Step 1: Remove unused vim code that references the old `markdown` field**

In `humanproof_native.rs`, remove the `apply_normal_mode_key` method and `maybe_handle_vim` call (the old vim implementation operated on a raw `String` cursor; it will be reimplemented in Phase 2). Remove any remaining references to `self.markdown`, `self.cursor`, `self.persisted_markdown` that were from the old structure.

- [ ] **Step 2: Build — confirm no unused variable warnings for removed fields**

```bash
cargo build --manifest-path src-tauri/Cargo.toml --bin humanproof_native 2>&1
```
Expected: 0 errors. Warnings about vim being gone are fine.

- [ ] **Step 3: Run all tests**

```bash
cargo test --manifest-path src-tauri/Cargo.toml 2>&1
```
Expected: all tests pass.

- [ ] **Step 4: Visual smoke test — full editing flow**

```bash
npm run dev:native
```

Verify:
1. App opens with previously saved content rendered as WYSIWYG blocks
2. Clicking a heading renders large text, clicking it activates TextEdit showing raw `# ...`
3. Editing the heading and clicking away re-renders it large
4. Bullet items show `•` when not focused
5. Fenced code block shows background fill
6. Task list checkboxes toggle on click
7. Word count and char count in top bar update on edit
8. Content is auto-saved (status shows "Saved")

- [ ] **Step 5: Commit**

```bash
git add src-tauri/src/bin/humanproof_native.rs
git commit -m "feat(wysiwyg): remove legacy TextEdit code, WYSIWYG integration complete"
```

---

## Track B — Proof Publishing (parallel with A3–A6)

### Task B1: Proof publishing in native app

**Files:**
- Create: `src-tauri/src/upload.rs`
- Modify: `src-tauri/src/lib.rs`
- Modify: `src-tauri/src/bin/humanproof_native.rs`

- [ ] **Step 1: Add `pub mod upload;` to lib.rs**

In `src-tauri/src/lib.rs`, after `pub mod editor;`:
```rust
pub mod upload;
```

- [ ] **Step 2: Write the failing test first**

Create `src-tauri/src/upload.rs`:

```rust
use crate::session::AppState;
use std::io::{Read, Write};
use std::net::TcpStream;

/// Upload a proof to the local proof server at localhost:4000.
/// Returns the proof URL on success.
pub fn upload_proof_native(
    state: &AppState,
    doc_text: &str,
) -> Result<String, String> {
    let (session_id, log_jsonl, keystroke_count, start_wall_ns, log_chain_hash) = {
        let s = state.session.lock().unwrap();
        (
            s.session_id.clone(),
            s.to_jsonl(),
            s.keystroke_count(),
            s.start_wall_ns,
            s.log_chain_hash(),
        )
    };

    let integrity = state.integrity.clone();
    let keyboard = state.keyboard_info.lock().unwrap().clone();

    let payload = serde_json::json!({
        "session_id": session_id,
        "doc_text": doc_text,
        "doc_html": "",
        "doc_history": [],
        "keystroke_log": log_jsonl,
        "keystroke_count": keystroke_count,
        "start_wall_ns": start_wall_ns,
        "log_chain_hash": log_chain_hash,
        "app_binary_hash": integrity.app_binary_hash,
        "code_signing_valid": integrity.code_signing_valid,
        "os_version": integrity.os_version,
        "hardware_model": integrity.hardware_model,
        "hardware_uuid": integrity.hardware_uuid,
        "sip_enabled": integrity.sip_enabled,
        "vm_detected": integrity.vm_detected,
        "frida_detected": integrity.frida_detected,
        "dylib_injection_detected": integrity.dylib_injection_detected,
        "dyld_env_injection": integrity.dyld_env_injection,
        "keyboard_vendor_id": keyboard.as_ref().map(|k| format!("0x{:04x}", k.vendor_id)),
        "keyboard_transport": keyboard.as_ref().map(|k| k.transport.clone()),
    });

    let body = payload.to_string();
    let request = format!(
        "POST /api/sessions HTTP/1.1\r\nHost: localhost:4000\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{}",
        body.len(),
        body
    );

    let mut stream = TcpStream::connect("127.0.0.1:4000")
        .map_err(|e| format!("Cannot connect to proof server (is it running? cd proof-server && node server.js): {e}"))?;
    stream.write_all(request.as_bytes()).map_err(|e| e.to_string())?;

    let mut response = String::new();
    stream.read_to_string(&mut response).map_err(|e| e.to_string())?;

    let body_start = response.find("\r\n\r\n")
        .ok_or("Invalid HTTP response from proof server")? + 4;
    let resp_body = &response[body_start..];

    let resp_json: serde_json::Value = serde_json::from_str(resp_body)
        .map_err(|e| format!("Bad JSON from proof server: {e}"))?;

    let url = resp_json["url"].as_str()
        .ok_or("No 'url' field in proof server response")?
        .to_string();

    Ok(url)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn upload_fails_gracefully_when_server_down() {
        // This test uses a fake AppState — it must NOT require a real HID or Keychain.
        // We just verify the function returns a useful error when the server isn't running.
        use crate::session::SessionState;
        use crate::integrity::IntegrityReport;
        use std::sync::{Arc, Mutex};
        use std::sync::atomic::{AtomicBool, AtomicI32, AtomicU64};

        let state = AppState {
            session: Mutex::new(SessionState::new(0)),
            editor_state: Mutex::new(crate::editor::EditorDocumentState::default()),
            hid_active: AtomicBool::new(false),
            pending_builtin_keydowns: AtomicI32::new(0),
            integrity: IntegrityReport::default(),
            keyboard_info: Mutex::new(None),
            last_keydown_ns: AtomicU64::new(0),
        };

        // Port 19999 should not have anything listening
        // We can't directly test the connect-to-19999 without changing the function.
        // Instead, test that connecting to a closed port returns an Err with a useful message.
        let result = upload_proof_native(&state, "test doc");
        // In CI / test environment proof server isn't running, so this should be an Err
        // We just verify it returns Err and doesn't panic
        assert!(result.is_err());
        let msg = result.unwrap_err();
        assert!(msg.contains("Cannot connect") || msg.contains("connect"), "got: {msg}");
    }
}
```

- [ ] **Step 3: Check `IntegrityReport` has a `Default` impl**

```bash
grep -n "Default" src-tauri/src/integrity.rs | head -10
```

If `IntegrityReport` doesn't derive `Default`, add it. Check the struct definition:
```bash
grep -n "struct IntegrityReport" src-tauri/src/integrity.rs
```

If no `#[derive(Default)]`, add it (or add `impl Default for IntegrityReport` with all fields set to empty/false/zero).

- [ ] **Step 4: Run the test**

```bash
cargo test --manifest-path src-tauri/Cargo.toml upload 2>&1
```
Expected: `upload_fails_gracefully_when_server_down` passes (proof server is not running in test environment).

- [ ] **Step 5: Add "Publish Proof" button to `top_bar` in `humanproof_native.rs`**

Add to the `NativeEditorApp` struct:
```rust
proof_url: Option<String>,
proof_status: Option<String>,
```

Initialize both to `None` in `new()`.

In `top_bar()`, after the Save button:
```rust
if ui.button("Publish Proof").clicked() {
    let doc_text = self.editor.to_markdown();
    match humanproof_lib::upload::upload_proof_native(&self.state, &doc_text) {
        Ok(url) => {
            self.proof_url = Some(url.clone());
            self.proof_status = Some(format!("Proof published: {url}"));
            // Copy URL to clipboard via arboard or just show it
        }
        Err(e) => {
            self.proof_status = Some(format!("Upload failed: {e}"));
        }
    }
}

if let Some(ref status) = self.proof_status {
    ui.label(status);
}
```

- [ ] **Step 6: Build**

```bash
cargo build --manifest-path src-tauri/Cargo.toml --bin humanproof_native 2>&1 | grep "^error"
```

- [ ] **Step 7: Manual end-to-end test**

In one terminal:
```bash
cd proof-server && node server.js
```

In another:
```bash
npm run dev:native
```

Type some text, click "Publish Proof". Expected: status bar shows `Proof published: http://localhost:4000/replay/<uuid>`. Open that URL in a browser — verify the replay viewer loads and shows the keystroke log.

- [ ] **Step 8: Commit**

```bash
git add src-tauri/src/upload.rs src-tauri/src/lib.rs src-tauri/src/bin/humanproof_native.rs
git commit -m "feat: proof publishing in native egui app"
```

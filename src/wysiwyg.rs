use egui::text::{CCursor, CCursorRange};
#[allow(unused_imports)]
use egui::text::{LayoutJob, TextFormat};
use egui::text_edit::TextEditState;
#[allow(unused_imports)]
use egui::{Color32, FontId};
use sha2::{Digest, Sha256};
use std::time::{SystemTime, UNIX_EPOCH};

use crate::editor::{build_text_change_with_cursors, TextChange};

// ── Inline spans ──────────────────────────────────────────────────────────────

#[derive(Copy, Clone, Debug, PartialEq, Eq)]
enum InsertKind {
    Word,
    Separator,
    Newline,
}

#[derive(Debug, Clone, PartialEq)]
pub enum InlineSpan {
    Plain(String),
    Bold(String),
    Italic(String),
    BoldItalic(String),
    Code(String),
    Strikethrough(String),
    /// [text](url)
    Link {
        text: String,
        url: String,
    },
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
        if chars[i] == '*' && i + 2 < chars.len() && chars[i + 1] == '*' && chars[i + 2] == '*' {
            if let Some(end) = find_closing(&chars, i + 3, "***") {
                flush_plain!(i);
                let inner: String = chars[i + 3..end].iter().collect();
                spans.push(InlineSpan::BoldItalic(inner));
                i = end + 3;
                plain_start = i;
                continue;
            }
        }
        // Bold: **
        if chars[i] == '*' && i + 1 < chars.len() && chars[i + 1] == '*' {
            if let Some(end) = find_closing(&chars, i + 2, "**") {
                flush_plain!(i);
                let inner: String = chars[i + 2..end].iter().collect();
                spans.push(InlineSpan::Bold(inner));
                i = end + 2;
                plain_start = i;
                continue;
            }
        }
        // Italic: *
        if chars[i] == '*'
            && (i == 0 || chars[i - 1] != '*')
            && (i + 1 >= chars.len() || chars[i + 1] != '*')
        {
            if let Some(end) = find_closing(&chars, i + 1, "*") {
                flush_plain!(i);
                let inner: String = chars[i + 1..end].iter().collect();
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
                let inner: String = chars[i + 1..end].iter().collect();
                spans.push(InlineSpan::Code(inner));
                i = end + 1;
                plain_start = i;
                continue;
            }
        }
        // Strikethrough: ~~
        if chars[i] == '~' && i + 1 < chars.len() && chars[i + 1] == '~' {
            if let Some(end) = find_closing(&chars, i + 2, "~~") {
                flush_plain!(i);
                let inner: String = chars[i + 2..end].iter().collect();
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
                        let text: String = chars[i + 1..text_end].iter().collect();
                        let url: String = chars[after_bracket + 1..url_end].iter().collect();
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
    if mlen == 0 {
        return None;
    }
    for i in start..chars.len().saturating_sub(mlen - 1) {
        if chars[i..i + mlen] == mc[..] {
            return Some(i);
        }
    }
    None
}

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
                job.append(
                    &s,
                    0.0,
                    TextFormat {
                        font_id: base_font.clone(),
                        color: base_color,
                        ..Default::default()
                    },
                );
            }
            InlineSpan::Bold(s) => {
                job.append(
                    &s,
                    0.0,
                    TextFormat {
                        font_id: base_font.clone(),
                        color: base_color,
                        // egui doesn't have a built-in bold font variant in all setups;
                        // use extra_letter_spacing as a visual indicator until custom fonts added
                        extra_letter_spacing: 0.5,
                        ..Default::default()
                    },
                );
            }
            InlineSpan::Italic(s) => {
                job.append(
                    &s,
                    0.0,
                    TextFormat {
                        font_id: base_font.clone(),
                        color: base_color,
                        italics: true,
                        ..Default::default()
                    },
                );
            }
            InlineSpan::BoldItalic(s) => {
                job.append(
                    &s,
                    0.0,
                    TextFormat {
                        font_id: base_font.clone(),
                        color: base_color,
                        italics: true,
                        extra_letter_spacing: 0.5,
                        ..Default::default()
                    },
                );
            }
            InlineSpan::Code(s) => {
                job.append(
                    &s,
                    0.0,
                    TextFormat {
                        font_id: FontId::monospace(base_font.size),
                        color: Color32::from_rgb(200, 120, 80),
                        background: code_bg,
                        ..Default::default()
                    },
                );
            }
            InlineSpan::Strikethrough(s) => {
                job.append(
                    &s,
                    0.0,
                    TextFormat {
                        font_id: base_font.clone(),
                        color: base_color.linear_multiply(0.5),
                        strikethrough: egui::Stroke::new(1.0, base_color.linear_multiply(0.5)),
                        ..Default::default()
                    },
                );
            }
            InlineSpan::Link { text, .. } => {
                job.append(
                    &text,
                    0.0,
                    TextFormat {
                        font_id: base_font.clone(),
                        color: Color32::from_rgb(100, 160, 230),
                        underline: egui::Stroke::new(1.0, Color32::from_rgb(100, 160, 230)),
                        ..Default::default()
                    },
                );
            }
        }
    }
    job
}

fn build_editor_layout_job(ui: &egui::Ui, text: &str, wrap_width: f32) -> LayoutJob {
    let mut job = LayoutJob::default();
    job.wrap.max_width = wrap_width;
    let blocks = parse_blocks(text);

    let base_font = FontId::monospace(14.0);
    let base_color = ui.visuals().text_color();
    let muted = base_color.linear_multiply(0.6);
    let accent = Color32::from_rgb(0xd3, 0x86, 0x9b);
    let code_color = Color32::from_rgb(0xd0, 0xa8, 0x6e);
    let code_bg = ui.visuals().code_bg_color;

    fn append(job: &mut LayoutJob, text: &str, format: TextFormat) {
        if !text.is_empty() {
            job.append(text, 0.0, format);
        }
    }

    for (idx, block) in blocks.iter().enumerate() {
        match &block.kind {
            BlockKind::Heading(level) => {
                let size = match level {
                    1 => 20.0,
                    2 => 18.0,
                    3 => 16.0,
                    _ => 14.0,
                };
                append(
                    &mut job,
                    &block.raw,
                    TextFormat {
                        font_id: FontId::new(size, egui::FontFamily::Monospace),
                        color: accent,
                        extra_letter_spacing: 0.5,
                        ..Default::default()
                    },
                );
            }
            BlockKind::BulletItem { .. } => {
                let trimmed = block.raw.trim_start();
                let indent_len = block.raw.len().saturating_sub(trimmed.len());
                let body = strip_bullet_markers(&block.raw);
                let marker_len = block.raw.len().saturating_sub(indent_len + body.len());
                append(
                    &mut job,
                    &block.raw[..indent_len + marker_len],
                    TextFormat::simple(base_font.clone(), accent),
                );
                append(
                    &mut job,
                    body,
                    TextFormat::simple(base_font.clone(), base_color),
                );
            }
            BlockKind::OrderedItem { .. } => {
                let trimmed = block.raw.trim_start();
                let indent_len = block.raw.len().saturating_sub(trimmed.len());
                let body = strip_ordered_markers(&block.raw);
                let marker_len = block.raw.len().saturating_sub(indent_len + body.len());
                append(
                    &mut job,
                    &block.raw[..indent_len + marker_len],
                    TextFormat::simple(base_font.clone(), accent),
                );
                append(
                    &mut job,
                    body,
                    TextFormat::simple(base_font.clone(), base_color),
                );
            }
            BlockKind::TaskItem { .. } => {
                let trimmed = block.raw.trim_start();
                let indent_len = block.raw.len().saturating_sub(trimmed.len());
                let body = strip_task_markers(&block.raw);
                let marker_len = block.raw.len().saturating_sub(indent_len + body.len());
                append(
                    &mut job,
                    &block.raw[..indent_len + marker_len],
                    TextFormat::simple(base_font.clone(), accent),
                );
                append(
                    &mut job,
                    body,
                    TextFormat::simple(base_font.clone(), base_color),
                );
            }
            BlockKind::Blockquote => {
                let body = strip_blockquote_markers(&block.raw);
                let marker_len = block.raw.len().saturating_sub(body.len());
                append(
                    &mut job,
                    &block.raw[..marker_len],
                    TextFormat::simple(base_font.clone(), muted),
                );
                append(
                    &mut job,
                    body,
                    TextFormat::simple(base_font.clone(), base_color),
                );
            }
            BlockKind::FencedCode { .. } => {
                append(
                    &mut job,
                    &block.raw,
                    TextFormat {
                        font_id: base_font.clone(),
                        color: code_color,
                        background: code_bg,
                        ..Default::default()
                    },
                );
            }
            BlockKind::HorizontalRule => {
                append(
                    &mut job,
                    &block.raw,
                    TextFormat::simple(base_font.clone(), muted),
                );
            }
            BlockKind::Table => {
                append(
                    &mut job,
                    &block.raw,
                    TextFormat {
                        font_id: base_font.clone(),
                        color: Color32::from_rgb(0x7f, 0xbb, 0xa3),
                        ..Default::default()
                    },
                );
            }
            BlockKind::BlankLine | BlockKind::Paragraph => {
                append(
                    &mut job,
                    &block.raw,
                    TextFormat::simple(base_font.clone(), base_color),
                );
            }
        }

        if idx + 1 < blocks.len() {
            append(
                &mut job,
                "\n",
                TextFormat::simple(base_font.clone(), base_color),
            );
        }
    }

    if job.text.is_empty() && text.is_empty() {
        job.text = String::new();
    }

    job
}

// ── Block types ──────────────────────────────────────────────────────────────

/// Parse a markdown string into a sequence of blocks.
pub fn parse_blocks(markdown: &str) -> Vec<Block> {
    let mut blocks: Vec<Block> = Vec::new();
    let lines: Vec<&str> = markdown.split('\n').collect();
    let mut i = 0;

    while i < lines.len() {
        let line = lines[i];

        // Blank line
        if line.trim().is_empty() {
            blocks.push(Block {
                kind: BlockKind::BlankLine,
                raw: String::new(),
            });
            i += 1;
            continue;
        }

        // Horizontal rule: ---, ***, ___  (3+ identical chars, optional spaces)
        if is_horizontal_rule(line) {
            blocks.push(Block {
                kind: BlockKind::HorizontalRule,
                raw: line.to_string(),
            });
            i += 1;
            continue;
        }

        // Fenced code block
        if line.trim_start().starts_with("```") {
            let fence_indent = line.bytes().take_while(|&b| b == b' ').count();
            let lang = line.trim_start().trim_start_matches('`').trim().to_string();
            let mut raw_lines = vec![line.to_string()];
            i += 1;
            while i < lines.len() {
                let l = lines[i];
                raw_lines.push(l.to_string());
                // Closing fence: CommonMark allows up to three leading spaces
                // before a closing fence regardless of opener indent.
                let leading_spaces = l.bytes().take_while(|&b| b == b' ').count();
                if leading_spaces <= fence_indent + 3 && l[leading_spaces..].starts_with("```") {
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
            blocks.push(Block {
                kind: BlockKind::Heading(level),
                raw: line.to_string(),
            });
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
            blocks.push(Block {
                kind: BlockKind::Blockquote,
                raw: line.to_string(),
            });
            i += 1;
            continue;
        }

        // Task item (must check before bullet)
        if let Some(checked) = task_item(line) {
            blocks.push(Block {
                kind: BlockKind::TaskItem { checked },
                raw: line.to_string(),
            });
            i += 1;
            continue;
        }

        // Bullet item
        if let Some(depth) = bullet_depth(line) {
            blocks.push(Block {
                kind: BlockKind::BulletItem { depth },
                raw: line.to_string(),
            });
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
        blocks.push(Block {
            kind: BlockKind::Paragraph,
            raw: line.to_string(),
        });
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
        // Safe: '#' is single-byte ASCII, so char count == byte count here
        let byte_offset = hashes; // '#' is always 1 byte
        let rest = &trimmed[byte_offset..];
        if rest.is_empty() || rest.starts_with(' ') {
            return Some(hashes as u8);
        }
    }
    None
}

fn is_horizontal_rule(line: &str) -> bool {
    let t = line.trim();
    if t.len() < 3 {
        return false;
    }
    let ch = t.chars().next().expect("t has at least 3 chars");
    if !matches!(ch, '-' | '*' | '_') {
        return false;
    }
    t.chars().all(|c| c == ch || c == ' ') && t.chars().filter(|&c| c == ch).count() >= 3
}

fn bullet_depth(line: &str) -> Option<usize> {
    // Count leading spaces (ASCII, so byte offset == char count)
    let spaces = line.bytes().take_while(|&b| b == b' ').count();
    let rest = &line[spaces..];
    if rest.starts_with("- ") || rest.starts_with("* ") || rest.starts_with("+ ") {
        Some(spaces / 2)
    } else {
        None
    }
}

fn task_item(line: &str) -> Option<bool> {
    // Count leading spaces (ASCII, so byte offset == char count)
    let spaces = line.bytes().take_while(|&b| b == b' ').count();
    let rest = &line[spaces..];
    if rest.starts_with("- [ ] ") || rest.starts_with("- [ ]") {
        Some(false)
    } else if rest.starts_with("- [x] ")
        || rest.starts_with("- [x]")
        || rest.starts_with("- [X] ")
        || rest.starts_with("- [X]")
    {
        Some(true)
    } else {
        None
    }
}

fn ordered_item(line: &str) -> Option<(usize, usize)> {
    // Count leading spaces (ASCII, so byte offset == char count)
    let spaces = line.bytes().take_while(|&b| b == b' ').count();
    let rest = &line[spaces..];
    // find(". ") is safe because the digit-only guard below rejects non-numeric prefixes
    let dot = rest.find(". ")?;
    let num_str = &rest[..dot];
    if num_str.chars().all(|c| c.is_ascii_digit()) && !num_str.is_empty() {
        let n: usize = num_str.parse().ok()?;
        Some((spaces / 2, n))
    } else {
        None
    }
}

#[derive(Debug, Clone, PartialEq)]
pub enum BlockKind {
    Paragraph,
    Heading(u8), // 1–6
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

// ── MarkdownEditor widget ─────────────────────────────────────────────────────

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum EditorResponse {
    None,
    Changed,
    SaveRequested,
    PasteBlocked,
}

/// Per-mode background/foreground colors for the vim statusline pill.
#[derive(Debug, Clone, Copy)]
pub struct ModeColors {
    pub normal_bg: egui::Color32,
    pub insert_bg: egui::Color32,
    pub visual_bg: egui::Color32,
    pub command_bg: egui::Color32,
    /// Text drawn on top of every mode pill (dark enough to contrast against all bg colors).
    pub pill_fg: egui::Color32,
}

impl Default for ModeColors {
    fn default() -> Self {
        // Gruvbox dark defaults
        Self {
            normal_bg: egui::Color32::from_rgb(0x45, 0x85, 0x88), // gruvbox blue
            insert_bg: egui::Color32::from_rgb(0xb8, 0xbb, 0x26), // gruvbox bright-green
            visual_bg: egui::Color32::from_rgb(0xfa, 0xbd, 0x2f), // gruvbox bright-yellow
            command_bg: egui::Color32::from_rgb(0xd3, 0x86, 0x9b), // gruvbox bright-purple
            pill_fg: egui::Color32::from_rgb(0x1d, 0x20, 0x21),   // gruvbox hard-bg (near-black)
        }
    }
}

pub struct MarkdownEditor {
    content: String,
    pub vim: crate::vim::VimState,
    pub vim_enabled: bool,
    pub mode_colors: ModeColors,
    /// Persistent undo log across sessions.
    /// `undo_index` is the number of applied changes from the initial state.
    undo_changes: Vec<TextChange>,
    undo_index: usize,
    /// When we apply undo/redo ourselves, we don't want to create an additional snapshot.
    suppress_undo_snapshot: bool,
    last_recorded_content: String,
    last_edit_at_ms: u64,
    trusted_clipboard_text: Option<String>,
    trusted_clipboard_mac: Option<[u8; 32]>,
}

impl MarkdownEditor {
    pub fn new(markdown: &str) -> Self {
        let initial = markdown.to_string();
        Self {
            content: initial.clone(),
            vim: crate::vim::VimState::new(),
            vim_enabled: false,
            mode_colors: ModeColors::default(),
            undo_changes: Vec::new(),
            undo_index: 0,
            suppress_undo_snapshot: false,
            last_recorded_content: initial,
            last_edit_at_ms: 0,
            trusted_clipboard_text: None,
            trusted_clipboard_mac: None,
        }
    }

    pub fn to_markdown(&self) -> String {
        self.content.clone()
    }

    pub fn set_undo_state(&mut self, changes: Vec<TextChange>, index: usize) {
        self.undo_changes = changes;
        self.undo_index = index.min(self.undo_changes.len());
        self.suppress_undo_snapshot = false;
        self.last_recorded_content = self.content.clone();
        self.last_edit_at_ms = 0;
    }

    pub fn get_undo_state(&self) -> (Vec<TextChange>, usize) {
        (self.undo_changes.clone(), self.undo_index)
    }

    fn now_ms() -> u64 {
        SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap_or_default()
            .as_millis() as u64
    }

    fn caret_index(te_state: &TextEditState) -> usize {
        te_state
            .cursor
            .char_range()
            .map(|range| range.primary.index)
            .unwrap_or(0)
    }

    fn set_caret(te_state: &mut TextEditState, index: usize) {
        let cursor = CCursor::new(index);
        te_state
            .cursor
            .set_char_range(Some(CCursorRange::one(cursor)));
    }

    fn clipboard_mac(text: &str) -> Option<[u8; 32]> {
        let key = crate::signing::derive_document_store_key().ok()?;
        let mut hasher = Sha256::new();
        hasher.update(b"handtyped-editor-clipboard-v1");
        hasher.update(key);
        hasher.update(text.as_bytes());
        Some(hasher.finalize().into())
    }

    fn trust_clipboard_text(&mut self, text: String) {
        if text.is_empty() {
            return;
        }
        self.trusted_clipboard_mac = Self::clipboard_mac(&text);
        self.trusted_clipboard_text = Some(text);
    }

    fn trusted_clipboard_text(&self) -> Option<String> {
        let text = self.trusted_clipboard_text.as_ref()?;
        let mac = self.trusted_clipboard_mac?;
        if Self::clipboard_mac(text) == Some(mac) {
            Some(text.clone())
        } else {
            None
        }
    }

    fn apply_undo(&mut self, te_state: &mut TextEditState) {
        if self.undo_index == 0 {
            return;
        }
        let change = self.undo_changes[self.undo_index - 1].clone();
        self.content = change.apply_inverse_to(&self.content);
        self.undo_index -= 1;
        self.last_recorded_content = self.content.clone();
        Self::set_caret(te_state, change.cursor_before);
        self.suppress_undo_snapshot = true;
    }

    fn apply_redo(&mut self, te_state: &mut TextEditState) {
        if self.undo_index >= self.undo_changes.len() {
            return;
        }
        let change = self.undo_changes[self.undo_index].clone();
        self.content = change.apply_to(&self.content);
        self.undo_index += 1;
        self.last_recorded_content = self.content.clone();
        Self::set_caret(te_state, change.cursor_after);
        self.suppress_undo_snapshot = true;
    }

    fn insert_tail_kind(text: &str) -> Option<InsertKind> {
        text.chars().last().map(Self::insert_kind)
    }

    fn insert_kind(ch: char) -> InsertKind {
        if ch == '\n' || ch == '\r' {
            InsertKind::Newline
        } else if ch.is_alphanumeric() || matches!(ch, '_' | '\'' | '-') {
            InsertKind::Word
        } else {
            InsertKind::Separator
        }
    }

    fn should_merge_change(previous: &TextChange, next: &TextChange, elapsed_ms: u64) -> bool {
        const GROUP_MS: u64 = 1_200;
        let prev_ins = previous.ins.chars().count();
        let next_ins = next.ins.chars().count();
        let prev_del = previous.del.chars().count();
        let next_del = next.del.chars().count();

        let both_insert = prev_del == 0 && next_del == 0;
        let both_backspace =
            prev_ins == 0 && next_ins == 0 && next.pos == previous.pos.saturating_sub(prev_del);
        let inserted_contiguously = previous.pos + prev_ins == next.pos;

        if both_backspace {
            return true;
        }

        if !both_insert || !inserted_contiguously {
            return false;
        }

        if next_ins == 1 {
            let prev_kind = Self::insert_tail_kind(&previous.ins);
            let next_kind = next.ins.chars().next().map(Self::insert_kind);
            match (prev_kind, next_kind) {
                (Some(InsertKind::Word), Some(InsertKind::Word))
                | (Some(InsertKind::Word), Some(InsertKind::Separator))
                | (Some(InsertKind::Separator), Some(InsertKind::Separator)) => {
                    return true;
                }
                _ => {}
            }
        }

        elapsed_ms <= GROUP_MS && (prev_ins > 1 || next_ins > 1)
    }

    fn record_forward_edit_snapshot(&mut self, cursor_before: usize, cursor_after: usize) {
        // Clear redo history on forward edit.
        if self.undo_index < self.undo_changes.len() {
            self.undo_changes.truncate(self.undo_index);
        }
        let now = Self::now_ms();
        if let Some(change) = build_text_change_with_cursors(
            &self.last_recorded_content,
            &self.content,
            cursor_before,
            cursor_after,
        ) {
            let elapsed_ms = now.saturating_sub(self.last_edit_at_ms);
            let can_merge = self.undo_index == self.undo_changes.len();
            if let Some(previous) = self.undo_changes.last_mut() {
                if can_merge && Self::should_merge_change(previous, &change, elapsed_ms) {
                    let merged_after = change.apply_to(&self.last_recorded_content);
                    if let Some(merged) = build_text_change_with_cursors(
                        &previous.apply_inverse_to(&self.last_recorded_content),
                        &merged_after,
                        previous.cursor_before,
                        change.cursor_after,
                    ) {
                        *previous = merged;
                    } else {
                        *previous = change.clone();
                    }
                } else {
                    self.undo_changes.push(change);
                    self.undo_index = self.undo_changes.len();
                }
            } else {
                self.undo_changes.push(change);
                self.undo_index = self.undo_changes.len();
            }
            self.last_recorded_content = self.content.clone();
            self.last_edit_at_ms = now;
        }
    }

    fn undo_cmd_from_event(event: &egui::Event) -> Option<bool> {
        // Returns Some(true) for Undo, Some(false) for Redo.
        let egui::Event::Key {
            key,
            pressed,
            modifiers,
            ..
        } = event
        else {
            return None;
        };
        if !*pressed {
            return None;
        }

        // Undo: Cmd+Z
        if *key == egui::Key::Z && modifiers.mac_cmd && !modifiers.shift {
            return Some(true);
        }
        // Redo: Cmd+Shift+Z or Cmd+Y
        if *key == egui::Key::Z && modifiers.mac_cmd && modifiers.shift {
            return Some(false);
        }
        if *key == egui::Key::Y && modifiers.mac_cmd {
            return Some(false);
        }

        None
    }

    /// Simulate one event through the vim pipeline without an egui UI context.
    /// Returns the events that would be forwarded on to the TextEdit.
    /// Used in tests to verify vim integration behaviour without spinning up egui.
    pub fn sim_vim_event(&mut self, event: &egui::Event) -> Vec<egui::Event> {
        if !self.vim_enabled {
            return vec![event.clone()];
        }
        let mut te_state = egui::widgets::text_edit::TextEditState::default();
        self.vim
            .handle_event(event, &mut self.content, &mut te_state)
    }

    /// Render the editor as a single full-document TextEdit.
    /// `hid_ok` must be true for any edit to be accepted; edits are rolled back otherwise.
    pub fn show(&mut self, ui: &mut egui::Ui, hid_ok: bool) -> EditorResponse {
        let before = self.content.clone();
        let mut paste_blocked = false;

        // Stable ID so load_state/store_state and TextEdit use the same key.
        let editor_id = egui::Id::new("handtyped_md_editor");

        let mut te_state = egui::TextEdit::load_state(ui.ctx(), editor_id)
            .unwrap_or_else(|| egui::widgets::text_edit::TextEditState::default());
        let cursor_before = Self::caret_index(&te_state);

        if self.vim_enabled {
            ui.input_mut(|i| {
                let mut unhandled = Vec::new();
                for event in i.events.drain(..) {
                    if let egui::Event::Paste(_) = &event {
                        if hid_ok {
                            if let Some(text) = self.trusted_clipboard_text() {
                                unhandled.push(egui::Event::Paste(text));
                            } else {
                                paste_blocked = true;
                            }
                        } else {
                            paste_blocked = true;
                        }
                        continue;
                    }
                    let mut produced =
                        self.vim
                            .handle_event(&event, &mut self.content, &mut te_state);
                    if hid_ok {
                        // Consume persistent undo commands so egui's own undo stack
                        // doesn't fight with our persisted revision log.
                        for ev in produced.drain(..) {
                            if let egui::Event::Paste(_) = ev {
                                if let Some(text) = self.trusted_clipboard_text() {
                                    unhandled.push(egui::Event::Paste(text));
                                } else {
                                    paste_blocked = true;
                                }
                                continue;
                            }
                            if let Some(is_undo) = Self::undo_cmd_from_event(&ev) {
                                if is_undo {
                                    self.apply_undo(&mut te_state);
                                } else {
                                    self.apply_redo(&mut te_state);
                                }
                            } else {
                                unhandled.push(ev);
                            }
                        }
                    }
                    // When hid_ok is false, all key events are swallowed (only undo/redo
                    // would be consumed but we've already handled those above).
                }
                i.events = unhandled;
                // Consume Escape so egui's TextEdit never sees it and cannot
                // surrender keyboard focus. Ctrl+[ is consumed by vim above.
                i.consume_key(egui::Modifiers::NONE, egui::Key::Escape);
            });
        } else {
            // Non-vim mode: swallow undo/redo so we can persist across sessions.
            ui.input_mut(|i| {
                let mut unhandled = Vec::new();
                for event in i.events.drain(..) {
                    if let egui::Event::Paste(_) = &event {
                        if hid_ok {
                            if let Some(text) = self.trusted_clipboard_text() {
                                unhandled.push(egui::Event::Paste(text));
                            } else {
                                paste_blocked = true;
                            }
                        } else {
                            paste_blocked = true;
                        }
                        continue;
                    }
                    if let Some(is_undo) = Self::undo_cmd_from_event(&event) {
                        if hid_ok {
                            if is_undo {
                                self.apply_undo(&mut te_state);
                            } else {
                                self.apply_redo(&mut te_state);
                            }
                        }
                        continue; // swallow key event
                    }
                    // Block events if no pending builtin keydown
                    if !hid_ok {
                        continue;
                    }
                    unhandled.push(event);
                }
                i.events = unhandled;
            });
        }

        // If vim changed the cursor or selection, persist that state before
        // rendering so TextEdit picks up the updated position this frame.
        te_state.clone().store(ui.ctx(), editor_id);

        // Mode indicator at the bottom (vim-style statusline).
        // Declared before the ScrollArea so egui reserves space at the bottom
        // and the text area fills the remaining height.
        if self.vim_enabled {
            egui::TopBottomPanel::bottom("vim_mode_bar")
                .exact_height(24.0)
                .frame(egui::Frame::NONE.inner_margin(egui::Margin::symmetric(4, 2)))
                .show_inside(ui, |ui| {
                    ui.horizontal_centered(|ui| {
                        let mc = self.mode_colors;
                        match self.vim.mode {
                            crate::vim::VimMode::Normal => {
                                ui.label(
                                    egui::RichText::new(" NORMAL ")
                                        .strong()
                                        .color(mc.pill_fg)
                                        .background_color(mc.normal_bg),
                                );
                            }
                            crate::vim::VimMode::Insert => {
                                ui.label(
                                    egui::RichText::new(" INSERT ")
                                        .strong()
                                        .color(mc.pill_fg)
                                        .background_color(mc.insert_bg),
                                );
                            }
                            crate::vim::VimMode::Visual => {
                                ui.label(
                                    egui::RichText::new(" VISUAL ")
                                        .strong()
                                        .color(mc.pill_fg)
                                        .background_color(mc.visual_bg),
                                );
                            }
                            crate::vim::VimMode::CommandLine => {
                                let cmd_str = format!(
                                    " {}{} ",
                                    self.vim.command_prefix,
                                    self.vim.command_buffer.replace('\n', "")
                                );
                                ui.label(
                                    egui::RichText::new(cmd_str)
                                        .monospace()
                                        .strong()
                                        .color(mc.pill_fg)
                                        .background_color(mc.command_bg),
                                );
                            }
                        }
                    });
                });
        }

        egui::ScrollArea::vertical()
            .id_salt("md_editor_scroll")
            .show(ui, |ui| {
                let mut layouter = |ui: &egui::Ui, string: &str, wrap_width: f32| {
                    let layout_job = build_editor_layout_job(ui, string, wrap_width);
                    ui.fonts(|fonts| fonts.layout_job(layout_job))
                };
                let output = egui::TextEdit::multiline(&mut self.content)
                    .id(editor_id)
                    .desired_width(f32::INFINITY)
                    .desired_rows(40)
                    .font(egui::TextStyle::Monospace)
                    .layouter(&mut layouter)
                    .lock_focus(true)
                    .frame(false)
                    .margin(egui::vec2(0.0, 0.0))
                    .show(ui);
                te_state = output.state;
                self.vim.flush_pending_visual_exit(&mut te_state);

                if self.vim_enabled {
                    // egui 0.31 processes Escape in its memory module *before* our
                    // ui.input_mut runs, clearing focused_widget = None whenever
                    // EventFilter::escape is false (the default). Override the filter
                    // here so egui never steals Escape away from the TextEdit while
                    // vim mode is active — our vim code consumes it instead.
                    ui.memory_mut(|mem| {
                        mem.set_focus_lock_filter(
                            editor_id,
                            egui::EventFilter {
                                horizontal_arrows: true,
                                vertical_arrows: true,
                                tab: true,
                                escape: true,
                            },
                        )
                    });
                }
            });

        let copied_text = ui.ctx().output(|o| {
            o.commands.iter().rev().find_map(|cmd| match cmd {
                egui::output::OutputCommand::CopyText(text) => Some(text.clone()),
                _ => None,
            })
        });
        if let Some(copied_text) = copied_text {
            self.trust_clipboard_text(copied_text);
        }

        let changed = self.content != before;
        let cursor_after = Self::caret_index(&te_state);
        te_state.store(ui.ctx(), editor_id);
        if changed && !hid_ok {
            self.content = before;
            // If hid_ok is false, we didn't apply persistent undo, so skip any snapshot updates.
            self.suppress_undo_snapshot = false;
            return EditorResponse::None;
        }

        if paste_blocked {
            return EditorResponse::PasteBlocked;
        }

        // Persist undo snapshots when the editor content changes due to normal editing.
        if changed && hid_ok {
            if self.suppress_undo_snapshot {
                self.suppress_undo_snapshot = false;
            } else {
                self.record_forward_edit_snapshot(cursor_before, cursor_after);
            }
        }

        let save = self.vim.save_requested;
        self.vim.save_requested = false; // consume the flag

        if save {
            EditorResponse::SaveRequested
        } else if changed {
            EditorResponse::Changed
        } else {
            EditorResponse::None
        }
    }
}

// ── Display helpers ───────────────────────────────────────────────────────────

fn strip_bullet_markers(raw: &str) -> &str {
    let t = raw.trim_start_matches(' ');
    t.strip_prefix("- ")
        .or_else(|| t.strip_prefix("* "))
        .or_else(|| t.strip_prefix("+ "))
        .unwrap_or(t)
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
    t.strip_prefix("- [ ] ")
        .or_else(|| t.strip_prefix("- [x] "))
        .or_else(|| t.strip_prefix("- [X] "))
        .or_else(|| t.strip_prefix("- [ ]"))
        .or_else(|| t.strip_prefix("- [x]"))
        .or_else(|| t.strip_prefix("- [X]"))
        .unwrap_or(t)
}

fn strip_blockquote_markers(raw: &str) -> &str {
    let t = raw.trim_start();
    t.strip_prefix("> ")
        .or_else(|| t.strip_prefix(">"))
        .unwrap_or(t)
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
        assert_eq!(
            blocks[0].kind,
            BlockKind::OrderedItem {
                depth: 0,
                number: 1
            }
        );
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
    fn parse_task_checked_uppercase() {
        let blocks = parse_blocks("- [X] done");
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
        assert_eq!(
            blocks[0].kind,
            BlockKind::FencedCode {
                language: "rust".into()
            }
        );
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
        assert!(blocks.iter().any(|b| b.kind == BlockKind::Heading(1)));
        assert!(blocks.iter().any(|b| b.kind == BlockKind::Paragraph));
        assert_eq!(
            blocks
                .iter()
                .filter(|b| b.kind == BlockKind::BulletItem { depth: 0 })
                .count(),
            2
        );
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

    #[test]
    fn inline_segments_plain() {
        let segs = parse_inline("hello world");
        assert_eq!(segs.len(), 1);
        assert_eq!(segs[0], InlineSpan::Plain("hello world".into()));
    }

    #[test]
    fn inline_segments_bold() {
        let segs = parse_inline("hello **world** end");
        assert!(segs
            .iter()
            .any(|s| matches!(s, InlineSpan::Bold(t) if t == "world")));
    }

    #[test]
    fn inline_segments_italic() {
        let segs = parse_inline("say *hi* now");
        assert!(segs
            .iter()
            .any(|s| matches!(s, InlineSpan::Italic(t) if t == "hi")));
    }

    #[test]
    fn inline_segments_code() {
        let segs = parse_inline("use `foo()` here");
        assert!(segs
            .iter()
            .any(|s| matches!(s, InlineSpan::Code(t) if t == "foo()")));
    }

    #[test]
    fn inline_segments_strikethrough() {
        let segs = parse_inline("~~old~~ new");
        assert!(segs
            .iter()
            .any(|s| matches!(s, InlineSpan::Strikethrough(t) if t == "old")));
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
        assert!(segs
            .iter()
            .any(|s| matches!(s, InlineSpan::Link { text, .. } if text == "rust")));
    }

    #[test]
    fn inline_segments_unclosed_markers_fall_back_to_plain_text() {
        let segs = parse_inline("**bold and *italic");
        assert_eq!(segs, vec![InlineSpan::Plain("**bold and *italic".into())]);
    }

    #[test]
    fn inline_segments_bold_italic_parses_as_single_span() {
        let segs = parse_inline("***very***");
        assert_eq!(segs, vec![InlineSpan::BoldItalic("very".into())]);
    }

    #[test]
    fn parse_blocks_preserves_blockquote_marker_only_line() {
        let blocks = parse_blocks(">\n> next");
        assert_eq!(blocks.len(), 2);
        assert_eq!(blocks[0].kind, BlockKind::Blockquote);
        assert_eq!(blocks[0].raw, ">");
        assert_eq!(blocks[1].kind, BlockKind::Blockquote);
    }

    #[test]
    fn parse_blocks_keeps_lazy_blockquote_continuation_as_paragraph() {
        let blocks = parse_blocks("> quote\nstill quote?");
        assert_eq!(blocks.len(), 2);
        assert_eq!(blocks[0].kind, BlockKind::Blockquote);
        assert_eq!(blocks[1].kind, BlockKind::Paragraph);
        assert_eq!(blocks[1].raw, "still quote?");
    }

    #[test]
    fn parse_blocks_collects_indented_fence_closer() {
        let md = "```rust\nfn main() {}\n  ```\nnext";
        let blocks = parse_blocks(md);
        assert_eq!(blocks.len(), 2);
        assert_eq!(
            blocks[0].kind,
            BlockKind::FencedCode {
                language: "rust".into()
            }
        );
        assert_eq!(blocks[1].kind, BlockKind::Paragraph);
        assert_eq!(blocks[1].raw, "next");
    }

    #[test]
    fn markdown_editor_new_and_roundtrip() {
        let md = "# Hello\n\nWorld";
        let ed = MarkdownEditor::new(md);
        assert_eq!(ed.to_markdown(), md);
    }

    #[test]
    fn markdown_editor_content_updated() {
        let mut ed = MarkdownEditor::new("# Old");
        ed.content = "# New\n\nContent".to_string();
        assert_eq!(ed.to_markdown(), "# New\n\nContent");
    }

    #[test]
    fn hid_rollback_preserves_content() {
        // Simulate the rollback path in MarkdownEditor::show when hid_ok=false:
        // content is changed then restored to `before`.
        let mut ed = MarkdownEditor::new("original content");
        let before = ed.content.clone();
        ed.content = "injected content".to_string();
        // HID not active → rollback
        ed.content = before;
        assert_eq!(ed.to_markdown(), "original content");
    }

    #[test]
    fn persistent_undo_does_not_apply_when_hid_false() {
        let mut ed = MarkdownEditor::new("two");
        ed.set_undo_state(
            vec![TextChange {
                pos: 0,
                del: "one".into(),
                ins: "two".into(),
                cursor_before: 0,
                cursor_after: 3,
            }],
            1,
        );

        let ctx = egui::Context::default();
        let mut raw = egui::RawInput::default();
        raw.events.push(egui::Event::Key {
            key: egui::Key::Z,
            pressed: true,
            repeat: false,
            modifiers: egui::Modifiers::MAC_CMD,
            physical_key: None,
        });

        let _ = ctx.run(raw, |ctx| {
            egui::CentralPanel::default().show(ctx, |ui| {
                let _ = ed.show(ui, false);
            });
        });

        let (revs, idx) = ed.get_undo_state();
        assert_eq!(idx, 1);
        assert_eq!(
            revs,
            vec![TextChange {
                pos: 0,
                del: "one".into(),
                ins: "two".into(),
                cursor_before: 0,
                cursor_after: 3,
            }]
        );
        assert_eq!(ed.to_markdown(), "two");
    }

    #[test]
    fn persistent_undo_applies_when_hid_true() {
        let mut ed = MarkdownEditor::new("two");
        ed.set_undo_state(
            vec![TextChange {
                pos: 0,
                del: "one".into(),
                ins: "two".into(),
                cursor_before: 0,
                cursor_after: 3,
            }],
            1,
        );

        let ctx = egui::Context::default();
        let mut raw = egui::RawInput::default();
        raw.events.push(egui::Event::Key {
            key: egui::Key::Z,
            pressed: true,
            repeat: false,
            modifiers: egui::Modifiers::MAC_CMD,
            physical_key: None,
        });

        let _ = ctx.run(raw, |ctx| {
            egui::CentralPanel::default().show(ctx, |ui| {
                let _ = ed.show(ui, true);
            });
        });

        let (revs, idx) = ed.get_undo_state();
        assert_eq!(idx, 0);
        assert_eq!(
            revs,
            vec![TextChange {
                pos: 0,
                del: "one".into(),
                ins: "two".into(),
                cursor_before: 0,
                cursor_after: 3,
            }]
        );
        assert_eq!(ed.to_markdown(), "one");
    }

    #[test]
    fn persistent_redo_restores_cursor_position() {
        let mut ed = MarkdownEditor::new("one");
        ed.set_undo_state(
            vec![TextChange {
                pos: 3,
                del: "".into(),
                ins: "!".into(),
                cursor_before: 3,
                cursor_after: 4,
            }],
            0,
        );

        let ctx = egui::Context::default();
        let mut raw = egui::RawInput::default();
        raw.events.push(egui::Event::Key {
            key: egui::Key::Z,
            pressed: true,
            repeat: false,
            modifiers: egui::Modifiers::MAC_CMD | egui::Modifiers::SHIFT,
            physical_key: None,
        });

        let _ = ctx.run(raw, |ctx| {
            egui::CentralPanel::default().show(ctx, |ui| {
                let _ = ed.show(ui, true);
            });
        });

        let (revs, idx) = ed.get_undo_state();
        assert_eq!(idx, 1);
        assert_eq!(ed.to_markdown(), "one!");
        assert_eq!(revs[0].cursor_after, 4);
    }

    fn run_editor_frame(
        ed: &mut MarkdownEditor,
        hid_ok: bool,
        events: Vec<egui::Event>,
    ) -> EditorResponse {
        let ctx = egui::Context::default();
        let mut raw = egui::RawInput::default();
        raw.events = events;

        let mut response = EditorResponse::None;
        let _ = ctx.run(raw, |ctx| {
            egui::CentralPanel::default().show(ctx, |ui| {
                response = ed.show(ui, hid_ok);
            });
        });
        response
    }

    #[test]
    fn persistent_redo_applies_when_hid_true() {
        let mut ed = MarkdownEditor::new("two");
        ed.set_undo_state(
            vec![
                TextChange {
                    pos: 0,
                    del: "one".into(),
                    ins: "two".into(),
                    cursor_before: 0,
                    cursor_after: 3,
                },
                TextChange {
                    pos: 0,
                    del: "two".into(),
                    ins: "three".into(),
                    cursor_before: 3,
                    cursor_after: 5,
                },
            ],
            1,
        );

        let response = run_editor_frame(
            &mut ed,
            true,
            vec![egui::Event::Key {
                key: egui::Key::Z,
                pressed: true,
                repeat: false,
                modifiers: egui::Modifiers::MAC_CMD | egui::Modifiers::SHIFT,
                physical_key: None,
            }],
        );

        assert_eq!(response, EditorResponse::Changed);
        let (revs, idx) = ed.get_undo_state();
        assert_eq!(idx, 2);
        assert_eq!(
            revs,
            vec![
                TextChange {
                    pos: 0,
                    del: "one".into(),
                    ins: "two".into(),
                    cursor_before: 0,
                    cursor_after: 3,
                },
                TextChange {
                    pos: 0,
                    del: "two".into(),
                    ins: "three".into(),
                    cursor_before: 3,
                    cursor_after: 5,
                },
            ]
        );
        assert_eq!(ed.to_markdown(), "three");
    }

    #[test]
    fn forward_edit_clears_redo_branch() {
        let mut ed = MarkdownEditor::new("two");
        ed.set_undo_state(
            vec![
                TextChange {
                    pos: 0,
                    del: "one".into(),
                    ins: "two".into(),
                    cursor_before: 0,
                    cursor_after: 3,
                },
                TextChange {
                    pos: 0,
                    del: "two".into(),
                    ins: "three".into(),
                    cursor_before: 3,
                    cursor_after: 5,
                },
            ],
            1,
        );

        ed.content = "two plus".into();
        ed.record_forward_edit_snapshot(3, 8);
        let (revs, idx) = ed.get_undo_state();
        assert_eq!(idx, 2);
        assert_eq!(revs.len(), 2);
        assert_eq!(
            revs[0],
            TextChange {
                pos: 0,
                del: "one".into(),
                ins: "two".into(),
                cursor_before: 0,
                cursor_after: 3,
            }
        );
        assert_eq!(
            revs[1],
            TextChange {
                pos: 3,
                del: String::new(),
                ins: " plus".into(),
                cursor_before: 3,
                cursor_after: 8,
            }
        );
    }

    #[test]
    fn set_undo_state_clamps_out_of_range_index() {
        let mut ed = MarkdownEditor::new("second");
        ed.set_undo_state(
            vec![TextChange {
                pos: 0,
                del: "first".into(),
                ins: "second".into(),
                cursor_before: 0,
                cursor_after: 6,
            }],
            99,
        );

        let (revs, idx) = ed.get_undo_state();
        assert_eq!(
            revs,
            vec![TextChange {
                pos: 0,
                del: "first".into(),
                ins: "second".into(),
                cursor_before: 0,
                cursor_after: 6,
            }]
        );
        assert_eq!(idx, 1);
        assert_eq!(ed.to_markdown(), "second");
    }

    #[test]
    fn grouped_typing_merges_adjacent_insertions() {
        let mut ed = MarkdownEditor::new("");
        ed.content = "h".into();
        ed.record_forward_edit_snapshot(0, 1);
        ed.last_edit_at_ms = 0;
        ed.content = "he".into();
        ed.record_forward_edit_snapshot(1, 2);
        ed.last_edit_at_ms = 0;
        ed.content = "hey".into();
        ed.record_forward_edit_snapshot(2, 3);

        let (revs, idx) = ed.get_undo_state();
        assert_eq!(idx, 1);
        assert_eq!(revs.len(), 1);
        assert_eq!(
            revs[0],
            TextChange {
                pos: 0,
                del: String::new(),
                ins: "hey".into(),
                cursor_before: 0,
                cursor_after: 3,
            }
        );
    }

    #[test]
    fn grouped_typing_merges_word_characters_even_with_pause() {
        let mut ed = MarkdownEditor::new("");
        ed.content = "h".into();
        ed.record_forward_edit_snapshot(0, 1);
        ed.last_edit_at_ms = 0;
        ed.content = "he".into();
        ed.record_forward_edit_snapshot(1, 2);
        ed.last_edit_at_ms = 0;
        ed.content = "hey".into();
        ed.record_forward_edit_snapshot(2, 3);

        let (revs, idx) = ed.get_undo_state();
        assert_eq!(idx, 1);
        assert_eq!(revs.len(), 1);
        assert_eq!(
            revs[0],
            TextChange {
                pos: 0,
                del: String::new(),
                ins: "hey".into(),
                cursor_before: 0,
                cursor_after: 3,
            }
        );
    }

    #[test]
    fn separator_creates_new_undo_group_after_word() {
        let mut ed = MarkdownEditor::new("");
        ed.content = "h".into();
        ed.record_forward_edit_snapshot(0, 1);
        ed.last_edit_at_ms = 0;
        ed.content = "he".into();
        ed.record_forward_edit_snapshot(1, 2);
        ed.last_edit_at_ms = 0;
        ed.content = "he ".into();
        ed.record_forward_edit_snapshot(2, 3);
        ed.last_edit_at_ms = 0;
        ed.content = "he w".into();
        ed.record_forward_edit_snapshot(3, 4);

        let (revs, idx) = ed.get_undo_state();
        assert_eq!(idx, 2);
        assert_eq!(revs.len(), 2);
        assert_eq!(revs[0].ins, "he ");
        assert_eq!(revs[1].ins, "w");
    }

    #[test]
    fn undo_restores_caret_position() {
        let mut ed = MarkdownEditor::new("hello");
        ed.set_undo_state(
            vec![TextChange {
                pos: 5,
                del: String::new(),
                ins: "!".into(),
                cursor_before: 5,
                cursor_after: 6,
            }],
            1,
        );

        let ctx = egui::Context::default();
        let mut raw = egui::RawInput::default();
        raw.events.push(egui::Event::Key {
            key: egui::Key::Z,
            pressed: true,
            repeat: false,
            modifiers: egui::Modifiers::MAC_CMD,
            physical_key: None,
        });

        let _ = ctx.run(raw, |ctx| {
            egui::CentralPanel::default().show(ctx, |ui| {
                let _ = ed.show(ui, true);
            });
        });

        let editor_id = egui::Id::new("handtyped_md_editor");
        let te_state = egui::TextEdit::load_state(&ctx, editor_id).unwrap();
        let caret = te_state.cursor.char_range().unwrap().primary.index;
        assert_eq!(caret, 5);
    }

    // -----------------------------------------------------------------------
    // Vim integration tests
    // These tests expose bugs reported by the user and guard against regression.
    // -----------------------------------------------------------------------

    use crate::vim::VimMode;
    use egui::{Event, Key, Modifiers};

    fn key_ev(key: Key, pressed: bool) -> Event {
        Event::Key {
            key,
            pressed,
            repeat: false,
            modifiers: Modifiers::NONE,
            physical_key: None,
        }
    }

    /// BUG: "need to press i twice to get to insert mode"
    /// Root cause: vim was consuming the 'i' event globally (even without editor
    /// focus), leaving the TextEdit unfocused when the user pressed 'i' a second
    /// time while it DID have focus - making it look like two presses were needed.
    /// This test verifies the logic: ONE Event::Text("i") must switch to Insert.
    #[test]
    fn vim_one_i_press_enters_insert_mode() {
        let mut ed = MarkdownEditor::new("hello");
        ed.vim_enabled = true;
        assert_eq!(ed.vim.mode, VimMode::Normal, "should start in Normal");
        ed.sim_vim_event(&Event::Text("i".into()));
        assert_eq!(
            ed.vim.mode,
            VimMode::Insert,
            "vim must enter Insert mode after exactly one 'i' press; \
             if this fails, the mode transition requires more than one press"
        );
    }

    /// After entering Insert mode via 'i', text events must be forwarded to
    /// the TextEdit (not silently consumed by vim).
    #[test]
    fn vim_insert_mode_forwards_text_to_textedit() {
        let mut ed = MarkdownEditor::new("hello");
        ed.vim_enabled = true;
        ed.sim_vim_event(&Event::Text("i".into())); // enter Insert
        let forwarded = ed.sim_vim_event(&Event::Text("x".into()));
        assert!(
            forwarded
                .iter()
                .any(|e| matches!(e, Event::Text(t) if t == "x")),
            "text typed in Insert mode must be forwarded to the TextEdit"
        );
    }

    /// Normal-mode text commands must NOT be forwarded to the TextEdit.
    /// If 'i' were forwarded, the letter 'i' would appear in the document
    /// instead of switching modes — the classic "i typed in editor" bug.
    #[test]
    fn vim_normal_mode_command_not_typed_in_editor() {
        let mut ed = MarkdownEditor::new("hello");
        ed.vim_enabled = true;
        let forwarded = ed.sim_vim_event(&Event::Text("i".into()));
        assert!(
            !forwarded
                .iter()
                .any(|e| matches!(e, Event::Text(t) if t == "i")),
            "the 'i' command must be consumed by vim, not forwarded as a typed character"
        );
    }

    /// BUG: "pressing Escape defocuses the editor"
    /// Root cause: Escape was leaking through vim to egui's TextEdit, which
    /// surrenders keyboard focus on Escape (even with lock_focus).
    /// This test verifies Escape is consumed (returns empty event list) in Normal mode.
    #[test]
    fn vim_escape_in_normal_mode_consumed_not_forwarded() {
        let mut ed = MarkdownEditor::new("hello");
        ed.vim_enabled = true;
        let forwarded = ed.sim_vim_event(&key_ev(Key::Escape, true));
        assert!(
            forwarded.is_empty(),
            "Escape in Normal mode must be consumed by vim; \
             if forwarded, egui's TextEdit surrenders focus (defocuses editor)"
        );
    }

    /// Same requirement in Insert mode: Escape must switch back to Normal
    /// without leaking the event to egui (which would defocus the editor).
    #[test]
    fn vim_escape_in_insert_mode_consumed_and_returns_to_normal() {
        let mut ed = MarkdownEditor::new("hello");
        ed.vim_enabled = true;
        ed.sim_vim_event(&Event::Text("i".into())); // enter Insert
        assert_eq!(ed.vim.mode, VimMode::Insert);

        let forwarded = ed.sim_vim_event(&key_ev(Key::Escape, true));
        assert!(
            forwarded.is_empty(),
            "Escape in Insert mode must be consumed; if forwarded, editor loses focus"
        );
        assert_eq!(
            ed.vim.mode,
            VimMode::Normal,
            "Escape from Insert must return to Normal mode"
        );
    }

    /// Key-release events for Escape must also not be forwarded (egui may
    /// act on the release in some versions).
    #[test]
    fn vim_escape_release_consumed_in_normal_and_insert() {
        let mut ed = MarkdownEditor::new("hello");
        ed.vim_enabled = true;

        let fwd_normal = ed.sim_vim_event(&key_ev(Key::Escape, false));
        assert!(
            fwd_normal.is_empty(),
            "Escape release in Normal must be consumed"
        );

        ed.sim_vim_event(&Event::Text("i".into())); // enter Insert
        let fwd_insert = ed.sim_vim_event(&key_ev(Key::Escape, false));
        assert!(
            fwd_insert.is_empty(),
            "Escape release in Insert must be consumed"
        );
    }

    /// BUG: "Ctrl+[ should switch to Normal mode like Escape"
    /// Ctrl+[ is the standard terminal/vim Escape alias. It was not handled in
    /// handle_insert, so it was forwarded to the TextEdit instead of triggering
    /// a mode transition.
    #[test]
    fn vim_ctrl_bracket_in_insert_switches_to_normal() {
        let mut ed = MarkdownEditor::new("hello");
        ed.vim_enabled = true;
        ed.sim_vim_event(&Event::Text("i".into())); // enter Insert
        assert_eq!(ed.vim.mode, VimMode::Insert);

        let ctrl_bracket = Event::Key {
            key: Key::OpenBracket,
            pressed: true,
            repeat: false,
            modifiers: Modifiers::CTRL,
            physical_key: None,
        };
        let forwarded = ed.sim_vim_event(&ctrl_bracket);
        assert!(
            forwarded.is_empty(),
            "Ctrl+[ in Insert mode must be consumed (not forwarded to TextEdit)"
        );
        assert_eq!(
            ed.vim.mode,
            VimMode::Normal,
            "Ctrl+[ must switch from Insert to Normal mode"
        );
    }

    #[test]
    fn vim_ctrl_bracket_in_visual_switches_to_normal() {
        let mut ed = MarkdownEditor::new("hello");
        ed.vim_enabled = true;
        ed.sim_vim_event(&Event::Text("v".into())); // enter Visual
        assert_eq!(ed.vim.mode, VimMode::Visual);

        let ctrl_bracket = Event::Key {
            key: Key::OpenBracket,
            pressed: true,
            repeat: false,
            modifiers: Modifiers::CTRL,
            physical_key: None,
        };
        ed.sim_vim_event(&ctrl_bracket);
        assert_eq!(ed.vim.mode, VimMode::Normal, "Ctrl+[ must exit Visual mode");
    }

    #[test]
    fn vim_ctrl_bracket_in_command_line_switches_to_normal() {
        let mut ed = MarkdownEditor::new("hello");
        ed.vim_enabled = true;
        ed.sim_vim_event(&Event::Text(":".into())); // enter CommandLine
        assert_eq!(ed.vim.mode, VimMode::CommandLine);

        let ctrl_bracket = Event::Key {
            key: Key::OpenBracket,
            pressed: true,
            repeat: false,
            modifiers: Modifiers::CTRL,
            physical_key: None,
        };
        ed.sim_vim_event(&ctrl_bracket);
        assert_eq!(
            ed.vim.mode,
            VimMode::Normal,
            "Ctrl+[ must exit CommandLine mode"
        );
    }

    /// egui 0.31 clears focused_widget = None on Escape in its memory module
    /// BEFORE ui.input_mut runs, unless the focused widget registers an
    /// EventFilter with escape: true.
    ///
    /// set_focus_lock_filter only works when the widget IS the current
    /// focused_widget. So the test needs two frames: frame 1 establishes focus
    /// (processes the request_focus queue), frame 2 tests Escape behavior.
    fn escape_key_raw() -> egui::RawInput {
        let mut raw = egui::RawInput::default();
        raw.events.push(egui::Event::Key {
            key: egui::Key::Escape,
            pressed: true,
            repeat: false,
            modifiers: egui::Modifiers::NONE,
            physical_key: None,
        });
        raw
    }

    #[test]
    fn egui_escape_clears_focus_without_escape_event_filter() {
        let ctx = egui::Context::default();
        let id = egui::Id::new("test_editor");

        // Frame 1: queue and establish focus (empty frame processes the request)
        ctx.memory_mut(|m| m.request_focus(id));
        let _ = ctx.run(egui::RawInput::default(), |_| {});
        // Set filter WITHOUT escape:true (the bug state)
        ctx.memory_mut(|m| m.set_focus_lock_filter(id, egui::EventFilter::default()));

        // Frame 2: press Escape — egui should clear focus
        let _ = ctx.run(escape_key_raw(), |_| {});

        assert!(
            !ctx.memory(|m| m.has_focus(id)),
            "without escape:true in EventFilter, egui clears focus on Escape"
        );
    }

    #[test]
    fn egui_escape_preserves_focus_with_escape_event_filter() {
        let ctx = egui::Context::default();
        let id = egui::Id::new("test_te_focus");
        let mut text = String::new();

        // Frame 1: render a TextEdit and request focus via Response.
        // request_focus directly sets focused_widget; recently_gained_focus=true in end_pass
        // so the dead-man's switch is skipped and focus survives.
        let _ = ctx.run(egui::RawInput::default(), |ctx| {
            egui::CentralPanel::default().show(ctx, |ui| {
                let resp = egui::TextEdit::singleline(&mut text)
                    .id(id)
                    .show(ui)
                    .response;
                resp.request_focus();
            });
        });

        // Frame 2: render again so the widget stays in used_ids (dead-man's switch won't fire)
        // and id_previous_frame becomes Some(id), satisfying had_focus_last_frame.
        let _ = ctx.run(egui::RawInput::default(), |ctx| {
            egui::CentralPanel::default().show(ctx, |ui| {
                egui::TextEdit::singleline(&mut text).id(id).show(ui);
            });
        });

        // set_focus_lock_filter requires had_focus_last_frame(id) && has_focus(id) — both true now.
        ctx.memory_mut(|m| {
            m.set_focus_lock_filter(
                id,
                egui::EventFilter {
                    horizontal_arrows: true,
                    vertical_arrows: true,
                    tab: true,
                    escape: true,
                },
            )
        });

        // Frame 3: press Escape — begin_pass reads escape:true from the filter and does NOT
        // clear focused_widget.
        let _ = ctx.run(escape_key_raw(), |ctx| {
            egui::CentralPanel::default().show(ctx, |ui| {
                egui::TextEdit::singleline(&mut text).id(id).show(ui);
            });
        });

        assert!(
            ctx.memory(|m| m.has_focus(id)),
            "with escape:true in EventFilter, egui leaves focus intact on Escape"
        );
    }

    /// Vim should not change mode when disabled.
    #[test]
    fn vim_disabled_passes_all_events_through() {
        let mut ed = MarkdownEditor::new("hello");
        ed.vim_enabled = false;
        let forwarded = ed.sim_vim_event(&Event::Text("i".into()));
        assert!(
            forwarded
                .iter()
                .any(|e| matches!(e, Event::Text(t) if t == "i")),
            "when vim is disabled, all events must pass through unchanged"
        );
        assert_eq!(
            ed.vim.mode,
            VimMode::Normal,
            "vim mode must not change when vim is disabled"
        );
    }

    #[test]
    fn trusted_clipboard_round_trips_when_untampered() {
        let mut ed = MarkdownEditor::new("hello");
        ed.trust_clipboard_text("copied from handtyped".into());
        assert_eq!(
            ed.trusted_clipboard_text().as_deref(),
            Some("copied from handtyped")
        );
    }

    #[test]
    fn trusted_clipboard_rejects_tampered_text() {
        let mut ed = MarkdownEditor::new("hello");
        ed.trust_clipboard_text("safe".into());
        ed.trusted_clipboard_text = Some("tampered".into());
        assert!(ed.trusted_clipboard_text().is_none());
    }

    #[test]
    fn editor_layouter_preserves_exact_text() {
        egui::__run_test_ui(|ui| {
            let source = "# Title\n- item\n> quote\n```rs\nlet x = 1;\n```";
            let job = build_editor_layout_job(ui, source, 400.0);
            assert_eq!(job.text, source);
            assert!(job.sections.len() >= 4);
        });
    }
}

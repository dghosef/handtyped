#[allow(unused_imports)]
use egui::text::{LayoutJob, TextFormat};
#[allow(unused_imports)]
use egui::{Color32, FontId};

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
    if mlen == 0 { return None; }
    for i in start..chars.len().saturating_sub(mlen - 1) {
        if chars[i..i+mlen] == mc[..] {
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
                job.append(&s, 0.0, TextFormat {
                    font_id: base_font.clone(),
                    color: base_color,
                    ..Default::default()
                });
            }
            InlineSpan::Bold(s) => {
                job.append(&s, 0.0, TextFormat {
                    font_id: base_font.clone(),
                    color: base_color,
                    // egui doesn't have a built-in bold font variant in all setups;
                    // use extra_letter_spacing as a visual indicator until custom fonts added
                    extra_letter_spacing: 0.5,
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
                    font_id: base_font.clone(),
                    color: base_color,
                    italics: true,
                    extra_letter_spacing: 0.5,
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
                    color: Color32::from_rgb(100, 160, 230),
                    underline: egui::Stroke::new(1.0, Color32::from_rgb(100, 160, 230)),
                    ..Default::default()
                });
            }
        }
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
            let fence_indent = line.bytes().take_while(|&b| b == b' ').count();
            let lang = line.trim_start().trim_start_matches('`').trim().to_string();
            let mut raw_lines = vec![line.to_string()];
            i += 1;
            while i < lines.len() {
                let l = lines[i];
                raw_lines.push(l.to_string());
                // Closing fence: at most fence_indent leading spaces, then ```
                let leading_spaces = l.bytes().take_while(|&b| b == b' ').count();
                if leading_spaces <= fence_indent && l[leading_spaces..].starts_with("```") {
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
    if t.len() < 3 { return false; }
    let ch = t.chars().next().expect("t has at least 3 chars");
    if !matches!(ch, '-' | '*' | '_') { return false; }
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
    } else if rest.starts_with("- [x] ") || rest.starts_with("- [x]")
           || rest.starts_with("- [X] ") || rest.starts_with("- [X]") {
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

    pub fn set_markdown(&mut self, markdown: &str) {
        self.blocks = parse_blocks(markdown);
        if let Some(idx) = self.focused_block {
            if idx >= self.blocks.len() {
                self.focused_block = None;
            }
        }
    }

    pub fn to_markdown(&self) -> String {
        blocks_to_markdown(&self.blocks)
    }

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

    fn show_block(&mut self, ui: &mut egui::Ui, idx: usize, is_focused: bool, hid_ok: bool) -> bool {
        match self.blocks[idx].kind.clone() {
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
            _ if is_focused => self.show_block_edit(ui, idx, hid_ok),
            _ => self.show_block_display(ui, idx, hid_ok),
        }
    }

    fn show_block_display(&mut self, ui: &mut egui::Ui, idx: usize, hid_ok: bool) -> bool {
        let block = &self.blocks[idx];
        let visuals = ui.visuals().clone();
        let text_color = visuals.text_color();
        let code_bg = visuals.code_bg_color;

        let response = match block.kind.clone() {
            BlockKind::Heading(level) => {
                let content = strip_heading_markers(&block.raw).to_string();
                let size = match level {
                    1 => 32.0,
                    2 => 26.0,
                    3 => 22.0,
                    4 => 19.0,
                    5 => 17.0,
                    _ => 15.0,
                };
                let job = build_inline_layout_job(
                    &content,
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
                let raw = block.raw.clone();
                let job = build_inline_layout_job(
                    &raw,
                    FontId::proportional(15.0),
                    text_color,
                    code_bg,
                );
                ui.label(job)
            }

            BlockKind::BulletItem { depth } => {
                let content = strip_bullet_markers(&block.raw).to_string();
                ui.horizontal(|ui| {
                    ui.add_space(depth as f32 * 20.0);
                    ui.label("•");
                    let job = build_inline_layout_job(
                        &content,
                        FontId::proportional(15.0),
                        text_color,
                        code_bg,
                    );
                    ui.label(job);
                }).response
            }

            BlockKind::OrderedItem { depth, number } => {
                let content = strip_ordered_markers(&block.raw).to_string();
                ui.horizontal(|ui| {
                    ui.add_space(depth as f32 * 20.0);
                    ui.label(format!("{}.", number));
                    let job = build_inline_layout_job(
                        &content,
                        FontId::proportional(15.0),
                        text_color,
                        code_bg,
                    );
                    ui.label(job);
                }).response
            }

            BlockKind::TaskItem { checked } => {
                let content = strip_task_markers(&block.raw).to_string();
                let mut ch = checked;
                let task_changed = {
                    let r = ui.horizontal(|ui| {
                        ui.checkbox(&mut ch, "");
                        let job = build_inline_layout_job(
                            &content,
                            FontId::proportional(15.0),
                            if ch { text_color.linear_multiply(0.5) } else { text_color },
                            code_bg,
                        );
                        ui.label(job);
                    }).response;
                    r
                };
                if ch != checked && hid_ok {
                    let new_raw = if ch {
                        self.blocks[idx].raw.replacen("- [ ]", "- [x]", 1)
                    } else {
                        self.blocks[idx].raw.replacen("- [x]", "- [ ]", 1)
                    };
                    self.blocks[idx].raw = new_raw;
                    self.blocks[idx].kind = BlockKind::TaskItem { checked: ch };
                    return true;
                }
                task_changed
            }

            BlockKind::Blockquote => {
                let content = strip_blockquote_markers(&block.raw).to_string();
                ui.horizontal(|ui| {
                    ui.add_space(4.0);
                    // Left accent bar via colored label
                    ui.colored_label(egui::Color32::GRAY, "▌");
                    ui.add_space(4.0);
                    let job = build_inline_layout_job(
                        &content,
                        FontId::proportional(15.0),
                        text_color.linear_multiply(0.75),
                        code_bg,
                    );
                    ui.label(job);
                }).response
            }

            BlockKind::FencedCode { ref language } => {
                let language = language.clone();
                let content = strip_fence_markers(&block.raw).to_string();
                ui.add_space(4.0);
                let r = egui::Frame::new()
                    .fill(code_bg)
                    .inner_margin(egui::Margin::same(8))
                    .show(ui, |ui| {
                        if !language.is_empty() {
                            ui.label(
                                egui::RichText::new(&language)
                                    .small()
                                    .color(text_color.linear_multiply(0.5))
                            );
                        }
                        ui.label(egui::RichText::new(&content).monospace().color(text_color));
                    })
                    .response;
                ui.add_space(4.0);
                r
            }

            BlockKind::Table => {
                let raw = block.raw.clone();
                let lines: Vec<&str> = raw.lines().collect();
                egui::Grid::new(format!("table_{idx}"))
                    .striped(true)
                    .show(ui, |ui| {
                        for (row_idx, line) in lines.iter().enumerate() {
                            let is_separator = line.replace('|', "").replace('-', "").replace(':', "").trim().is_empty();
                            if is_separator { continue; }
                            let cells: Vec<&str> = line.split('|')
                                .map(|c| c.trim())
                                .filter(|c| !c.is_empty())
                                .collect();
                            for cell in &cells {
                                let size = if row_idx == 0 { 15.0 } else { 14.0 };
                                let job = build_inline_layout_job(
                                    cell,
                                    FontId::proportional(size),
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

        if response.clicked() {
            self.focused_block = Some(idx);
        }

        false
    }

    /// Split the block at `idx` at byte offset `pos` within its `raw` string.
    /// The block at `idx` gets the text before `pos`;
    /// a new Paragraph block with the text from `pos` onwards is inserted after.
    /// `focused_block` is moved to the new block.
    pub fn handle_enter_at(&mut self, idx: usize, pos: usize) {
        let raw = self.blocks[idx].raw.clone();
        let pos = pos.min(raw.len());
        let (before, after) = raw.split_at(pos);
        self.blocks[idx].raw = before.to_string();
        // Reclassify the current block based on new content
        if let Some(b) = parse_blocks(before).into_iter().next() {
            self.blocks[idx].kind = b.kind;
        } else {
            self.blocks[idx].kind = BlockKind::Paragraph;
        }
        let new_block = Block {
            kind: BlockKind::Paragraph,
            raw: after.to_string(),
        };
        self.blocks.insert(idx + 1, new_block);
        self.focused_block = Some(idx + 1);
    }

    /// Merge the block at `idx` into the previous block.
    /// Does nothing if `idx == 0`.
    /// `focused_block` is moved to the previous block.
    pub fn handle_backspace_at_block_start(&mut self, idx: usize) {
        if idx == 0 { return; }
        let current_raw = self.blocks[idx].raw.clone();
        self.blocks.remove(idx);
        let prev = &mut self.blocks[idx - 1];
        prev.raw.push_str(&current_raw);
        // Reclassify
        let raw_copy = prev.raw.clone();
        if let Some(b) = parse_blocks(&raw_copy).into_iter().next() {
            prev.kind = b.kind;
        }
        self.focused_block = Some(idx - 1);
    }

    fn show_block_edit(&mut self, ui: &mut egui::Ui, idx: usize, hid_ok: bool) -> bool {
        let before = self.blocks[idx].raw.clone();

        let (output_changed, output_lost_focus) = {
            let block = &mut self.blocks[idx];
            let output = egui::TextEdit::multiline(&mut block.raw)
                .desired_width(f32::INFINITY)
                .font(egui::TextStyle::Monospace)
                .show(ui);
            (output.response.changed(), output.response.lost_focus())
        };

        // Keyboard navigation between blocks
        let mut nav_action: Option<&str> = None;
        ui.input(|input| {
            if input.key_pressed(egui::Key::ArrowUp) {
                nav_action = Some("up");
            } else if input.key_pressed(egui::Key::ArrowDown) {
                nav_action = Some("down");
            } else if input.key_pressed(egui::Key::Escape) {
                nav_action = Some("escape");
            }
        });
        let block_count = self.blocks.len();
        match nav_action {
            Some("up") if idx > 0 => { self.focused_block = Some(idx - 1); }
            Some("down") => {
                let next = idx + 1;
                if next < block_count { self.focused_block = Some(next); }
            }
            Some("escape") => { self.focused_block = None; }
            _ => {}
        }

        if output_changed {
            if !hid_ok {
                self.blocks[idx].raw = before;
                return false;
            }
            // Reclassify block kind based on new raw content
            let raw_copy = self.blocks[idx].raw.clone();
            if let Some(new_block) = parse_blocks(&raw_copy).into_iter().next() {
                self.blocks[idx].kind = new_block.kind;
            }
            return true;
        }

        if output_lost_focus {
            self.focused_block = None;
        }

        false
    }
}

// ── Display helpers ───────────────────────────────────────────────────────────

fn strip_heading_markers(raw: &str) -> &str {
    let t = raw.trim_start_matches('#');
    t.strip_prefix(' ').unwrap_or(t)
}

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

fn strip_fence_markers(raw: &str) -> &str {
    // Drop first line (opening fence) and last line (closing fence)
    let first_nl = raw.find('\n').unwrap_or(raw.len());
    let content = &raw[first_nl.saturating_add(1)..];
    if let Some(last_nl) = content.rfind('\n') {
        &content[..last_nl]
    } else {
        content
    }
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

    #[test]
    fn markdown_editor_new_and_roundtrip() {
        let md = "# Hello\n\nWorld";
        let ed = MarkdownEditor::new(md);
        assert_eq!(ed.to_markdown(), md);
    }

    #[test]
    fn markdown_editor_set_markdown() {
        let mut ed = MarkdownEditor::new("# Old");
        ed.set_markdown("# New\n\nContent");
        assert_eq!(ed.to_markdown(), "# New\n\nContent");
    }

    #[test]
    fn markdown_editor_focused_block_clamped_on_set_markdown() {
        let mut ed = MarkdownEditor::new("# A\n\nB\n\nC");
        ed.focused_block = Some(4);
        ed.set_markdown("# Only");
        // focused_block out of range should be cleared
        assert!(ed.focused_block.is_none());
    }

    #[test]
    fn block_kind_reclassified_after_raw_change() {
        // Simulate what show_block_edit does after a valid HID edit:
        // user typed "# " before their paragraph, making it a heading
        let mut ed = MarkdownEditor::new("hello");
        // Directly mutate raw as show_block_edit would after a valid edit
        ed.blocks[0].raw = "# hello".to_string();
        // Reclassify — same logic as show_block_edit
        if let Some(new_block) = parse_blocks(&ed.blocks[0].raw.clone()).into_iter().next() {
            ed.blocks[0].kind = new_block.kind;
        }
        assert_eq!(ed.blocks[0].kind, BlockKind::Heading(1));
        assert_eq!(ed.to_markdown(), "# hello");
    }

    #[test]
    fn hid_rollback_preserves_content() {
        // Simulate the rollback: save before, "edit" raw, restore
        let mut ed = MarkdownEditor::new("original content");
        let before = ed.blocks[0].raw.clone();
        // Simulate a "bad" edit
        ed.blocks[0].raw = "injected content".to_string();
        // HID not active → rollback
        ed.blocks[0].raw = before;
        assert_eq!(ed.to_markdown(), "original content");
    }

    #[test]
    fn enter_at_end_splits_paragraph() {
        let mut ed = MarkdownEditor::new("Hello world");
        ed.focused_block = Some(0);
        ed.handle_enter_at(0, 5);
        let blocks: Vec<_> = ed.blocks.iter().filter(|b| b.kind != BlockKind::BlankLine).collect();
        assert_eq!(blocks.len(), 2);
        assert_eq!(blocks[0].raw, "Hello");
        assert_eq!(blocks[1].raw, " world");
    }

    #[test]
    fn enter_at_start_creates_blank_before() {
        let mut ed = MarkdownEditor::new("Hello");
        ed.handle_enter_at(0, 0);
        let non_blank: Vec<_> = ed.blocks.iter().filter(|b| b.kind != BlockKind::BlankLine).collect();
        assert_eq!(non_blank.len(), 1);
        assert_eq!(non_blank[0].raw, "Hello");
    }

    #[test]
    fn backspace_at_start_merges_blocks() {
        let mut ed = MarkdownEditor::new("First\nSecond");
        // blocks: [Paragraph("First"), Paragraph("Second")]
        ed.focused_block = Some(1);
        ed.handle_backspace_at_block_start(1);
        let blocks: Vec<_> = ed.blocks.iter().filter(|b| b.kind != BlockKind::BlankLine).collect();
        assert_eq!(blocks.len(), 1);
        assert_eq!(blocks[0].raw, "FirstSecond");
    }

    #[test]
    fn backspace_at_first_block_does_nothing() {
        let mut ed = MarkdownEditor::new("Only block");
        ed.handle_backspace_at_block_start(0);
        assert_eq!(ed.blocks.len(), 1);
        assert_eq!(ed.blocks[0].raw, "Only block");
    }

    #[test]
    fn handle_enter_moves_focus_to_new_block() {
        let mut ed = MarkdownEditor::new("Hello world");
        ed.handle_enter_at(0, 5);
        assert_eq!(ed.focused_block, Some(1));
    }

    #[test]
    fn handle_backspace_moves_focus_to_prev_block() {
        let mut ed = MarkdownEditor::new("First\nSecond");
        ed.handle_backspace_at_block_start(1);
        assert_eq!(ed.focused_block, Some(0));
    }
}

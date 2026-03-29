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
}

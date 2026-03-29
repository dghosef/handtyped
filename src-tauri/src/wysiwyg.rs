#[allow(unused_imports)]
use egui::text::{LayoutJob, TextFormat};
#[allow(unused_imports)]
use egui::{Color32, FontId};

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
}

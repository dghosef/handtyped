/// Pure markdown-to-preview-data pipeline.
/// Converts a markdown string into a `Vec<PreviewBlock>` with no egui dependency,
/// so the output can be unit-tested.
use pulldown_cmark::{Event, HeadingLevel, Options, Parser, Tag, TagEnd};

// ── Output types ──────────────────────────────────────────────────────────────

#[derive(Debug, Clone, PartialEq)]
pub struct InlineSeg {
    pub text: String,
    pub bold: bool,
    pub italic: bool,
    pub code: bool,
    pub strike: bool,
}

impl InlineSeg {
    pub fn plain(text: impl Into<String>) -> Self {
        Self {
            text: text.into(),
            bold: false,
            italic: false,
            code: false,
            strike: false,
        }
    }
    pub fn bold(text: impl Into<String>) -> Self {
        Self {
            text: text.into(),
            bold: true,
            italic: false,
            code: false,
            strike: false,
        }
    }
    pub fn italic(text: impl Into<String>) -> Self {
        Self {
            text: text.into(),
            bold: false,
            italic: true,
            code: false,
            strike: false,
        }
    }
    pub fn code(text: impl Into<String>) -> Self {
        Self {
            text: text.into(),
            bold: false,
            italic: false,
            code: true,
            strike: false,
        }
    }
    pub fn strike(text: impl Into<String>) -> Self {
        Self {
            text: text.into(),
            bold: false,
            italic: false,
            code: false,
            strike: true,
        }
    }
}

#[derive(Debug, Clone, PartialEq)]
pub enum PreviewBlock {
    /// Paragraph (or list item body, blockquote body)
    Para {
        segs: Vec<InlineSeg>,
        indent: usize, // list depth
        /// When inside an ordered list item, this contains the item number to display.
        /// If `None` while `indent > 0`, the renderer uses a bullet marker.
        list_number: Option<usize>,
        quote: bool, // inside blockquote
    },
    /// Heading H1–H6
    Heading { level: u8, segs: Vec<InlineSeg> },
    /// Fenced / indented code block
    Code { text: String },
    /// Markdown image
    Image { alt: String, url: String },
    /// Horizontal rule
    Rule,
}

// ── Parser ────────────────────────────────────────────────────────────────────

/// Convert markdown to a flat list of `PreviewBlock`s.
/// This is a pure function with no egui dependency — test it directly.
pub fn parse_markdown_for_preview(markdown: &str) -> Vec<PreviewBlock> {
    let parser = Parser::new_ext(markdown, Options::all());
    let mut blocks: Vec<PreviewBlock> = Vec::new();

    // Accumulator for the current paragraph/heading
    let mut segs: Vec<InlineSeg> = Vec::new();
    let mut heading_level: Option<u8> = None;
    let mut list_depth: usize = 0;
    let mut quote_depth: usize = 0;
    let mut in_code_block = false;
    let mut code_buf = String::new();
    let mut in_image = false;
    let mut image_alt = String::new();
    let mut image_url = String::new();

    #[derive(Debug, Clone)]
    struct ListCtx {
        ordered: bool,
        next_number: usize,
    }
    let mut list_stack: Vec<ListCtx> = Vec::new();
    let mut current_item_number: Option<usize> = None;

    // Inline format state
    let mut bold = false;
    let mut italic = false;
    let mut strike = false;

    let flush = |blocks: &mut Vec<PreviewBlock>,
                 segs: &mut Vec<InlineSeg>,
                 heading_level: Option<u8>,
                 list_depth: usize,
                 list_number: Option<usize>,
                 quote_depth: usize| {
        if segs.is_empty() || segs.iter().all(|s| s.text.is_empty()) {
            segs.clear();
            return;
        }
        let block = match heading_level {
            Some(level) => {
                // Heading text is always bold regardless of inline markers
                let bold_segs = segs
                    .drain(..)
                    .map(|mut s| {
                        s.bold = true;
                        s
                    })
                    .collect();
                PreviewBlock::Heading {
                    level,
                    segs: bold_segs,
                }
            }
            None => PreviewBlock::Para {
                segs: segs.drain(..).collect(),
                indent: list_depth,
                list_number,
                quote: quote_depth > 0,
            },
        };
        blocks.push(block);
        segs.clear();
    };

    for event in parser {
        match event {
            Event::Start(Tag::Heading { level, .. }) => {
                flush(
                    &mut blocks,
                    &mut segs,
                    heading_level,
                    list_depth,
                    current_item_number,
                    quote_depth,
                );
                heading_level = Some(heading_level_to_u8(level));
            }
            Event::End(TagEnd::Heading(_)) => {
                flush(
                    &mut blocks,
                    &mut segs,
                    heading_level,
                    list_depth,
                    current_item_number,
                    quote_depth,
                );
                heading_level = None;
            }
            Event::Start(Tag::Paragraph) => {
                flush(
                    &mut blocks,
                    &mut segs,
                    heading_level,
                    list_depth,
                    current_item_number,
                    quote_depth,
                );
            }
            Event::End(TagEnd::Paragraph) => {
                flush(
                    &mut blocks,
                    &mut segs,
                    heading_level,
                    list_depth,
                    current_item_number,
                    quote_depth,
                );
            }
            Event::Start(Tag::List(start)) => {
                flush(
                    &mut blocks,
                    &mut segs,
                    heading_level,
                    list_depth,
                    current_item_number,
                    quote_depth,
                );
                // pulldown-cmark uses Tag::List(start) to represent ordered lists.
                // When start is `Some(n)`, the list is ordered and starts at `n`.
                let (ordered, next_number) = match start {
                    Some(n) => (true, usize::try_from(n).unwrap_or(1)),
                    None => (false, 1),
                };
                list_stack.push(ListCtx {
                    ordered,
                    next_number,
                });
                list_depth = list_stack.len();
            }
            Event::End(TagEnd::List(_)) => {
                flush(
                    &mut blocks,
                    &mut segs,
                    heading_level,
                    list_depth,
                    current_item_number,
                    quote_depth,
                );
                list_stack.pop();
                list_depth = list_stack.len();
                current_item_number = None;
            }
            Event::Start(Tag::Item) => {
                flush(
                    &mut blocks,
                    &mut segs,
                    heading_level,
                    list_depth,
                    current_item_number,
                    quote_depth,
                );
                current_item_number = list_stack.last().and_then(|ctx| {
                    if ctx.ordered {
                        Some(ctx.next_number)
                    } else {
                        None
                    }
                });
            }
            Event::End(TagEnd::Item) => {
                flush(
                    &mut blocks,
                    &mut segs,
                    heading_level,
                    list_depth,
                    current_item_number,
                    quote_depth,
                );
                if let Some(ctx) = list_stack.last_mut() {
                    if ctx.ordered {
                        ctx.next_number = ctx.next_number.saturating_add(1);
                    }
                }
                current_item_number = None;
            }
            Event::Start(Tag::BlockQuote(_)) => {
                flush(
                    &mut blocks,
                    &mut segs,
                    heading_level,
                    list_depth,
                    current_item_number,
                    quote_depth,
                );
                quote_depth += 1;
            }
            Event::End(TagEnd::BlockQuote(_)) => {
                flush(
                    &mut blocks,
                    &mut segs,
                    heading_level,
                    list_depth,
                    current_item_number,
                    quote_depth,
                );
                quote_depth = quote_depth.saturating_sub(1);
            }
            Event::Start(Tag::CodeBlock(_)) => {
                flush(
                    &mut blocks,
                    &mut segs,
                    heading_level,
                    list_depth,
                    current_item_number,
                    quote_depth,
                );
                in_code_block = true;
                code_buf.clear();
            }
            Event::End(TagEnd::CodeBlock) => {
                blocks.push(PreviewBlock::Code {
                    text: code_buf.trim_end().to_string(),
                });
                in_code_block = false;
                code_buf.clear();
            }
            Event::Start(Tag::Image { dest_url, .. }) => {
                flush(
                    &mut blocks,
                    &mut segs,
                    heading_level,
                    list_depth,
                    current_item_number,
                    quote_depth,
                );
                in_image = true;
                image_alt.clear();
                image_url = dest_url.to_string();
            }
            Event::End(TagEnd::Image) => {
                blocks.push(PreviewBlock::Image {
                    alt: image_alt.trim().to_string(),
                    url: image_url.clone(),
                });
                in_image = false;
                image_alt.clear();
                image_url.clear();
            }
            Event::Rule => {
                flush(
                    &mut blocks,
                    &mut segs,
                    heading_level,
                    list_depth,
                    current_item_number,
                    quote_depth,
                );
                blocks.push(PreviewBlock::Rule);
            }
            Event::Start(Tag::Strong) => {
                bold = true;
            }
            Event::End(TagEnd::Strong) => {
                bold = false;
            }
            Event::Start(Tag::Emphasis) => {
                italic = true;
            }
            Event::End(TagEnd::Emphasis) => {
                italic = false;
            }
            Event::Start(Tag::Strikethrough) => {
                strike = true;
            }
            Event::End(TagEnd::Strikethrough) => {
                strike = false;
            }
            Event::Start(Tag::Link { .. }) | Event::End(TagEnd::Link) => {}
            Event::Text(text) => {
                if in_image {
                    image_alt.push_str(&text);
                } else if in_code_block {
                    code_buf.push_str(&text);
                } else {
                    segs.push(InlineSeg {
                        text: text.to_string(),
                        bold,
                        italic,
                        code: false,
                        strike,
                    });
                }
            }
            Event::Code(code) => {
                if in_image {
                    image_alt.push_str(&code);
                } else {
                    segs.push(InlineSeg {
                        text: code.to_string(),
                        bold,
                        italic,
                        code: true,
                        strike,
                    });
                }
            }
            Event::SoftBreak => {
                segs.push(InlineSeg::plain(" "));
            }
            Event::HardBreak => {
                flush(
                    &mut blocks,
                    &mut segs,
                    heading_level,
                    list_depth,
                    current_item_number,
                    quote_depth,
                );
            }
            Event::TaskListMarker(done) => {
                segs.push(InlineSeg::plain(if done { "☑ " } else { "☐ " }));
            }
            _ => {}
        }
    }
    flush(
        &mut blocks,
        &mut segs,
        heading_level,
        list_depth,
        current_item_number,
        quote_depth,
    );
    blocks
}

fn heading_level_to_u8(level: HeadingLevel) -> u8 {
    match level {
        HeadingLevel::H1 => 1,
        HeadingLevel::H2 => 2,
        HeadingLevel::H3 => 3,
        HeadingLevel::H4 => 4,
        HeadingLevel::H5 => 5,
        HeadingLevel::H6 => 6,
    }
}

// ── Tests ─────────────────────────────────────────────────────────────────────

#[cfg(test)]
mod tests {
    use super::*;

    fn plain_para(text: &str) -> PreviewBlock {
        PreviewBlock::Para {
            segs: vec![InlineSeg::plain(text)],
            indent: 0,
            list_number: None,
            quote: false,
        }
    }

    fn heading(level: u8, text: &str) -> PreviewBlock {
        PreviewBlock::Heading {
            level,
            segs: vec![InlineSeg::bold(text)],
        }
    }

    #[test]
    fn image_is_emitted_as_its_own_block() {
        let blocks = parse_markdown_for_preview("![Handtyped](assets/handtyped-logo.svg)");
        assert_eq!(
            blocks,
            vec![PreviewBlock::Image {
                alt: "Handtyped".to_string(),
                url: "assets/handtyped-logo.svg".to_string(),
            }]
        );
    }

    // ── Structural separation ─────────────────────────────────────────────────

    #[test]
    fn two_paragraphs_are_separate_blocks() {
        let blocks = parse_markdown_for_preview("Hello\n\nWorld");
        assert_eq!(
            blocks.len(),
            2,
            "two paragraphs must produce two blocks, got: {blocks:?}"
        );
        assert_eq!(blocks[0], plain_para("Hello"));
        assert_eq!(blocks[1], plain_para("World"));
    }

    #[test]
    fn heading_and_paragraph_are_separate_blocks() {
        let blocks = parse_markdown_for_preview("# Title\n\nBody");
        assert_eq!(
            blocks.len(),
            2,
            "heading + paragraph must be separate blocks, got: {blocks:?}"
        );
        assert_eq!(blocks[0], heading(1, "Title"));
        assert_eq!(blocks[1], plain_para("Body"));
    }

    #[test]
    fn heading_text_is_bold() {
        for md in ["# H1", "## H2", "### H3"] {
            let blocks = parse_markdown_for_preview(md);
            let PreviewBlock::Heading { segs, .. } = &blocks[0] else {
                panic!("expected Heading for {md:?}");
            };
            assert!(
                segs.iter().all(|s| s.bold),
                "all heading segs must be bold for {md:?}, got: {segs:?}"
            );
        }
    }

    #[test]
    fn heading_levels_h1_through_h3() {
        for (md, expected_level) in [("# H", 1u8), ("## H", 2), ("### H", 3)] {
            let blocks = parse_markdown_for_preview(md);
            match &blocks[0] {
                PreviewBlock::Heading { level, .. } => assert_eq!(*level, expected_level),
                other => panic!("expected Heading, got {other:?}"),
            }
        }
    }

    #[test]
    fn soft_break_within_paragraph_is_not_a_new_block() {
        // "line1\nline2" with no blank line is ONE paragraph
        let blocks = parse_markdown_for_preview("line1\nline2");
        assert_eq!(blocks.len(), 1, "soft-break must stay in same block");
    }

    // ── Inline formatting ─────────────────────────────────────────────────────

    #[test]
    fn bold_text_flagged_bold() {
        let blocks = parse_markdown_for_preview("**bold**");
        let PreviewBlock::Para { segs, .. } = &blocks[0] else {
            panic!("expected Para")
        };
        assert!(
            segs.iter().any(|s| s.bold && s.text == "bold"),
            "bold segment missing: {segs:?}"
        );
    }

    #[test]
    fn italic_text_flagged_italic() {
        let blocks = parse_markdown_for_preview("*italic*");
        let PreviewBlock::Para { segs, .. } = &blocks[0] else {
            panic!("expected Para")
        };
        assert!(
            segs.iter().any(|s| s.italic && s.text == "italic"),
            "italic segment missing: {segs:?}"
        );
    }

    #[test]
    fn strikethrough_text_flagged() {
        let blocks = parse_markdown_for_preview("~~gone~~");
        let PreviewBlock::Para { segs, .. } = &blocks[0] else {
            panic!("expected Para")
        };
        assert!(
            segs.iter().any(|s| s.strike && s.text == "gone"),
            "strike segment missing: {segs:?}"
        );
    }

    #[test]
    fn inline_code_flagged_code() {
        let blocks = parse_markdown_for_preview("`snippet`");
        let PreviewBlock::Para { segs, .. } = &blocks[0] else {
            panic!("expected Para")
        };
        assert!(
            segs.iter().any(|s| s.code && s.text == "snippet"),
            "code segment missing: {segs:?}"
        );
    }

    #[test]
    fn mixed_inline_within_paragraph() {
        let blocks = parse_markdown_for_preview("plain **bold** plain");
        let PreviewBlock::Para { segs, .. } = &blocks[0] else {
            panic!("expected Para")
        };
        let bold_seg = segs.iter().find(|s| s.bold);
        assert!(
            bold_seg.is_some(),
            "no bold segment in mixed para: {segs:?}"
        );
        assert_eq!(bold_seg.unwrap().text, "bold");
        // plain segments should not be bold
        let plain_segs: Vec<_> = segs.iter().filter(|s| !s.bold).collect();
        assert!(!plain_segs.is_empty());
        for s in plain_segs {
            assert!(!s.bold);
        }
    }

    #[test]
    fn bold_and_italic_do_not_bleed_across_paragraphs() {
        let blocks = parse_markdown_for_preview("**bold**\n\nnormal");
        let PreviewBlock::Para { segs, .. } = &blocks[1] else {
            panic!("expected Para for second block")
        };
        assert!(
            !segs.iter().any(|s| s.bold),
            "bold leaked into next paragraph: {segs:?}"
        );
        assert!(
            !segs.iter().any(|s| s.italic),
            "italic leaked into next paragraph: {segs:?}"
        );
    }

    // ── Block types ───────────────────────────────────────────────────────────

    #[test]
    fn fenced_code_block_is_code_block() {
        let blocks = parse_markdown_for_preview("```\nlet x = 1;\n```");
        assert_eq!(blocks.len(), 1);
        assert!(
            matches!(&blocks[0], PreviewBlock::Code { .. }),
            "expected Code block"
        );
    }

    #[test]
    fn fenced_code_block_text_preserved() {
        let blocks = parse_markdown_for_preview("```\nfn foo() {}\n```");
        let PreviewBlock::Code { text } = &blocks[0] else {
            panic!("expected Code")
        };
        assert!(text.contains("fn foo()"), "code text missing: {text:?}");
    }

    #[test]
    fn horizontal_rule_produces_rule_block() {
        let blocks = parse_markdown_for_preview("---");
        assert!(
            blocks.iter().any(|b| matches!(b, PreviewBlock::Rule)),
            "no Rule block found: {blocks:?}"
        );
    }

    #[test]
    fn bullet_list_items_have_indent() {
        let blocks = parse_markdown_for_preview("- item one\n- item two");
        let list_blocks: Vec<_> = blocks
            .iter()
            .filter(|b| matches!(b, PreviewBlock::Para { indent, .. } if *indent > 0))
            .collect();
        assert_eq!(
            list_blocks.len(),
            2,
            "expected 2 indented list items: {blocks:?}"
        );
    }

    #[test]
    fn ordered_list_items_have_list_numbers() {
        let blocks = parse_markdown_for_preview("1. first\n2. second");
        let numbers: Vec<usize> = blocks
            .iter()
            .filter_map(|b| {
                if let PreviewBlock::Para {
                    indent,
                    list_number: Some(n),
                    ..
                } = b
                {
                    if *indent > 0 {
                        Some(*n)
                    } else {
                        None
                    }
                } else {
                    None
                }
            })
            .collect();

        assert!(
            numbers.contains(&1),
            "missing 1 in {numbers:?} from {blocks:?}"
        );
        assert!(
            numbers.contains(&2),
            "missing 2 in {numbers:?} from {blocks:?}"
        );
    }

    #[test]
    fn blockquote_flagged_quote() {
        let blocks = parse_markdown_for_preview("> quoted");
        assert!(
            blocks
                .iter()
                .any(|b| matches!(b, PreviewBlock::Para { quote: true, .. })),
            "no quoted block found: {blocks:?}"
        );
    }

    #[test]
    fn empty_document_produces_no_blocks() {
        let blocks = parse_markdown_for_preview("");
        assert!(blocks.is_empty());
    }

    #[test]
    fn whitespace_only_document_produces_no_blocks() {
        let blocks = parse_markdown_for_preview("   \n\n   ");
        assert!(
            blocks.is_empty(),
            "whitespace-only should produce no blocks: {blocks:?}"
        );
    }
}

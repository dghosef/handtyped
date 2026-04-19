/// Pure markdown-to-preview-data pipeline.
/// Converts a markdown string into a `Vec<PreviewBlock>` with no egui dependency,
/// so the output can be unit-tested.
use pulldown_cmark::{Event, HeadingLevel, Options, Parser, Tag, TagEnd};

// ── Output types ──────────────────────────────────────────────────────────────

#[derive(Debug, Clone, PartialEq)]
pub struct InlineSeg {
    pub text: String,
    pub link_url: Option<String>,
    pub bold: bool,
    pub italic: bool,
    pub code: bool,
    pub strike: bool,
}

impl InlineSeg {
    pub fn plain(text: impl Into<String>) -> Self {
        Self {
            text: text.into(),
            link_url: None,
            bold: false,
            italic: false,
            code: false,
            strike: false,
        }
    }
    pub fn bold(text: impl Into<String>) -> Self {
        Self {
            text: text.into(),
            link_url: None,
            bold: true,
            italic: false,
            code: false,
            strike: false,
        }
    }
    pub fn italic(text: impl Into<String>) -> Self {
        Self {
            text: text.into(),
            link_url: None,
            bold: false,
            italic: true,
            code: false,
            strike: false,
        }
    }
    pub fn code(text: impl Into<String>) -> Self {
        Self {
            text: text.into(),
            link_url: None,
            bold: false,
            italic: false,
            code: true,
            strike: false,
        }
    }
    pub fn strike(text: impl Into<String>) -> Self {
        Self {
            text: text.into(),
            link_url: None,
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
    Heading {
        level: u8,
        segs: Vec<InlineSeg>,
        quote: bool,
    },
    /// Fenced / indented code block
    Code {
        text: String,
        quote: bool,
        indent: usize,
    },
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
    let mut current_link_url: Option<String> = None;

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
                    quote: quote_depth > 0,
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
                    text: code_buf.clone(),
                    quote: quote_depth > 0,
                    indent: list_depth,
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
            Event::Start(Tag::Link { dest_url, .. }) => {
                current_link_url = Some(dest_url.to_string());
            }
            Event::End(TagEnd::Link) => {
                current_link_url = None;
            }
            Event::Text(text) => {
                if in_image {
                    image_alt.push_str(&text);
                } else if in_code_block {
                    code_buf.push_str(&text);
                } else {
                    segs.push(InlineSeg {
                        text: text.to_string(),
                        link_url: current_link_url.clone(),
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
                        link_url: current_link_url.clone(),
                        bold,
                        italic,
                        code: true,
                        strike,
                    });
                }
            }
            Event::SoftBreak => {
                if quote_depth > 0 {
                    flush(
                        &mut blocks,
                        &mut segs,
                        heading_level,
                        list_depth,
                        current_item_number,
                        quote_depth,
                    );
                } else {
                    segs.push(InlineSeg::plain(" "));
                }
            }
            Event::HardBreak => {
                segs.push(InlineSeg::plain("\n"));
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
            quote: false,
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

    #[test]
    fn hard_break_within_paragraph_is_not_a_new_block() {
        let blocks = parse_markdown_for_preview("line1  \nline2");
        assert_eq!(blocks.len(), 1, "hard-break must stay in same block");
        let PreviewBlock::Para { segs, .. } = &blocks[0] else {
            panic!("expected Para")
        };
        assert_eq!(
            segs.iter().map(|seg| seg.text.as_str()).collect::<String>(),
            "line1\nline2"
        );
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
    fn link_text_retains_destination() {
        let blocks = parse_markdown_for_preview("[Handtyped](https://handtyped.app)");
        let PreviewBlock::Para { segs, .. } = &blocks[0] else {
            panic!("expected Para")
        };
        assert_eq!(segs.len(), 1);
        assert_eq!(segs[0].text, "Handtyped");
        assert_eq!(segs[0].link_url.as_deref(), Some("https://handtyped.app"));
    }

    #[test]
    fn plain_text_around_link_stays_plain() {
        let blocks = parse_markdown_for_preview("see [docs](https://example.com) now");
        let PreviewBlock::Para { segs, .. } = &blocks[0] else {
            panic!("expected Para")
        };
        assert_eq!(segs[0].text, "see ");
        assert_eq!(segs[0].link_url, None);
        assert_eq!(segs[1].text, "docs");
        assert_eq!(segs[1].link_url.as_deref(), Some("https://example.com"));
        assert_eq!(segs[2].text, " now");
        assert_eq!(segs[2].link_url, None);
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
        let PreviewBlock::Code { text, .. } = &blocks[0] else {
            panic!("expected Code")
        };
        assert!(text.contains("fn foo()"), "code text missing: {text:?}");
    }

    #[test]
    fn fenced_code_block_preserves_blank_lines_inside() {
        let blocks = parse_markdown_for_preview("```\nfn foo() {}\n\nreturn 1;\n```");
        let PreviewBlock::Code { text, .. } = &blocks[0] else {
            panic!("expected Code")
        };
        assert_eq!(text, "fn foo() {}\n\nreturn 1;\n");
    }

    #[test]
    fn fenced_code_block_inside_list_keeps_list_indent() {
        let blocks = parse_markdown_for_preview("- item\n\n    ```\n    let x = 1;\n    ```");
        assert!(
            blocks.iter().any(|b| matches!(
                b,
                PreviewBlock::Code {
                    indent: 1,
                    quote: false,
                    ..
                }
            )),
            "expected indented code block inside list, got: {blocks:?}"
        );
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
    fn blockquote_softbreak_stays_on_separate_preview_lines() {
        let blocks = parse_markdown_for_preview("> testhjhkjhjkh\n> tjkhej");
        let quoted_blocks: Vec<_> = blocks
            .iter()
            .filter_map(|b| match b {
                PreviewBlock::Para {
                    segs, quote: true, ..
                } => Some(segs.iter().map(|seg| seg.text.as_str()).collect::<String>()),
                _ => None,
            })
            .collect();

        assert_eq!(
            quoted_blocks,
            vec!["testhjhkjhjkh".to_string(), "tjkhej".to_string()]
        );
    }

    #[test]
    fn blockquote_with_blank_line_stays_as_two_quoted_paragraphs() {
        let blocks = parse_markdown_for_preview("> first\n>\n> second");
        let quoted_blocks: Vec<_> = blocks
            .iter()
            .filter_map(|b| match b {
                PreviewBlock::Para {
                    segs, quote: true, ..
                } => Some(segs.iter().map(|seg| seg.text.as_str()).collect::<String>()),
                _ => None,
            })
            .collect();

        assert_eq!(
            quoted_blocks,
            vec!["first".to_string(), "second".to_string()]
        );
    }

    #[test]
    fn blockquote_code_block_should_keep_quote_context() {
        let blocks = parse_markdown_for_preview("> ```\n> let x = 1;\n> ```");
        assert!(
            blocks
                .iter()
                .any(|b| matches!(b, PreviewBlock::Code { quote: true, .. })),
            "expected quoted code block in quoted markdown: {blocks:?}"
        );
    }

    #[test]
    fn blockquote_preserves_inline_formatting() {
        let blocks = parse_markdown_for_preview("> **bold** and `code`");
        let PreviewBlock::Para {
            segs, quote: true, ..
        } = &blocks[0]
        else {
            panic!("expected quoted paragraph")
        };

        assert!(segs.iter().any(|seg| seg.bold && seg.text == "bold"));
        assert!(segs.iter().any(|seg| seg.code && seg.text == "code"));
    }

    #[test]
    fn blockquote_preserves_links() {
        let blocks = parse_markdown_for_preview("> [docs](https://example.com)");
        let PreviewBlock::Para {
            segs, quote: true, ..
        } = &blocks[0]
        else {
            panic!("expected quoted paragraph")
        };

        assert_eq!(segs.len(), 1);
        assert_eq!(segs[0].text, "docs");
        assert_eq!(segs[0].link_url.as_deref(), Some("https://example.com"));
    }

    #[test]
    fn blockquote_followed_by_plain_paragraph_does_not_leak_quote_state() {
        let blocks = parse_markdown_for_preview("> quoted\n\nplain");

        assert!(matches!(&blocks[0], PreviewBlock::Para { quote: true, .. }));
        assert_eq!(blocks[1], plain_para("plain"));
    }

    #[test]
    fn nested_bullet_inside_blockquote_keeps_quote_and_indent() {
        let blocks = parse_markdown_for_preview("> - first\n>   - nested");
        let quoted_list_blocks: Vec<_> = blocks
            .iter()
            .filter_map(|b| match b {
                PreviewBlock::Para {
                    quote,
                    indent,
                    segs,
                    ..
                } if *quote => Some((
                    *indent,
                    segs.iter().map(|seg| seg.text.as_str()).collect::<String>(),
                )),
                _ => None,
            })
            .collect();

        assert_eq!(
            quoted_list_blocks,
            vec![(1, "first".to_string()), (2, "nested".to_string())]
        );
    }

    #[test]
    fn image_between_paragraphs_stays_its_own_block() {
        let blocks = parse_markdown_for_preview("before\n\n![alt](img.png)\n\nafter");
        assert_eq!(blocks.len(), 3);
        assert_eq!(blocks[0], plain_para("before"));
        assert!(matches!(
            &blocks[1],
            PreviewBlock::Image { alt, url } if alt == "alt" && url == "img.png"
        ));
        assert_eq!(blocks[2], plain_para("after"));
    }

    #[test]
    fn heading_with_inline_code_and_emphasis_preserves_inline_flags() {
        let blocks = parse_markdown_for_preview("# `cmd` and *note*");
        let PreviewBlock::Heading { segs, .. } = &blocks[0] else {
            panic!("expected Heading")
        };

        assert!(segs.iter().any(|seg| seg.code && seg.text == "cmd"));
        assert!(segs.iter().any(|seg| seg.italic && seg.text == "note"));
        assert!(segs.iter().all(|seg| seg.bold));
    }

    #[test]
    fn blockquote_heading_keeps_quote_context() {
        let blocks = parse_markdown_for_preview("> # Title");
        assert!(
            matches!(&blocks[0], PreviewBlock::Heading { quote: true, .. }),
            "expected quoted heading, got: {blocks:?}"
        );
    }

    #[test]
    fn ordered_list_start_number_is_preserved() {
        let blocks = parse_markdown_for_preview("3. third\n4. fourth");
        let numbers: Vec<usize> = blocks
            .iter()
            .filter_map(|b| match b {
                PreviewBlock::Para {
                    indent,
                    list_number: Some(n),
                    ..
                } if *indent > 0 => Some(*n),
                _ => None,
            })
            .collect();

        assert_eq!(numbers, vec![3, 4]);
    }

    #[test]
    fn task_list_markers_stay_in_paragraph_text() {
        let blocks = parse_markdown_for_preview("- [x] done\n- [ ] todo");
        let lines: Vec<String> = blocks
            .iter()
            .filter_map(|b| match b {
                PreviewBlock::Para { segs, indent, .. } if *indent > 0 => {
                    Some(segs.iter().map(|seg| seg.text.as_str()).collect::<String>())
                }
                _ => None,
            })
            .collect();

        assert_eq!(lines, vec!["☑ done".to_string(), "☐ todo".to_string()]);
    }

    #[test]
    fn nested_blockquote_and_list_keeps_both_quote_and_indent() {
        let blocks = parse_markdown_for_preview("> - first\n> - second");
        let quoted_list_blocks: Vec<(usize, bool, String)> = blocks
            .iter()
            .filter_map(|b| match b {
                PreviewBlock::Para {
                    segs,
                    indent,
                    quote,
                    ..
                } if *indent > 0 => Some((
                    *indent,
                    *quote,
                    segs.iter().map(|seg| seg.text.as_str()).collect::<String>(),
                )),
                _ => None,
            })
            .collect();

        assert_eq!(
            quoted_list_blocks,
            vec![
                (1, true, "first".to_string()),
                (1, true, "second".to_string())
            ]
        );
    }

    #[test]
    fn lazy_blockquote_continuation_stays_quoted_across_lines() {
        let blocks = parse_markdown_for_preview("> first line\nsecond line");
        let quoted_blocks: Vec<String> = blocks
            .iter()
            .filter_map(|b| match b {
                PreviewBlock::Para {
                    segs, quote: true, ..
                } => Some(segs.iter().map(|seg| seg.text.as_str()).collect::<String>()),
                _ => None,
            })
            .collect();

        assert_eq!(
            quoted_blocks,
            vec!["first line".to_string(), "second line".to_string()]
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

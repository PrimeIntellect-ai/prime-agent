use super::*;
use std::fmt::Write as FmtWrite;

#[test]
fn review_markdown_escaped_delimiters_keep_their_emphasis() {
    let style = MarkdownStyle::default();
    for (text, shown, modifier) in [
        (r"*a\*b*", "a*b", Modifier::ITALIC),
        (r"**a\*b**", "a*b", Modifier::BOLD),
        (r"***a\*b***", "a*b", Modifier::BOLD | Modifier::ITALIC),
        (r"~~a\~~b~~", "a~~b", Modifier::CROSSED_OUT),
    ] {
        let spans = render_inline(text, &style);
        assert_eq!(
            spans
                .iter()
                .map(|span| span.content.as_str())
                .collect::<String>(),
            shown
        );
        assert!(
            spans
                .iter()
                .all(|span| span.style.add_modifier.contains(modifier)),
            "{text}"
        );
    }
    // Two backslashes escape each other; the following star closes emphasis.
    let spans = render_inline(r"*a\\* tail", &style);
    assert_eq!(
        spans
            .iter()
            .map(|span| span.content.as_str())
            .collect::<String>(),
        "a\\ tail"
    );
    assert!(spans[0].style.add_modifier.contains(Modifier::ITALIC));
    assert_eq!(spans.last().unwrap().style.add_modifier, Modifier::empty());
}

#[test]
fn review_markdown_destinations_balance_before_a_title() {
    let style = MarkdownStyle::default();
    // The pinned real TS frame accepts this destination before a quoted title.
    let permissive = "[t](foo(bar \"title\")";
    let spans = super::render_inline(permissive, &style);
    assert_eq!(
        spans,
        vec![
            Span::styled(
                format!(
                    "{}t{}",
                    crate::hyperlinks::osc8_open("foo(bar"),
                    crate::hyperlinks::OSC8_CLOSE
                ),
                style.body.add_modifier(Modifier::UNDERLINED)
            ),
            Span::styled(" (foo(bar)", style.link_url)
        ],
    );
    for capability in [false, true] {
        crate::hyperlinks::set_hyperlinks_override(Some(capability));
        for text in ["[t](foo(bar) \"title\")", r#"[t](foo\(bar\) "a \"b\"")"#] {
            let mut spans = super::render_inline(text, &style);
            let ranges = crate::hyperlinks::frame_link_ranges(&[spans.clone()]);
            assert_eq!(ranges.len(), 1);
            assert_eq!(ranges[0].url, "foo(bar)");
            // Visible text excludes zero-width metadata under either capability.
            crate::hyperlinks::strip_osc8(&mut spans);
            assert_eq!(
                spans,
                vec![
                    Span::styled("t", style.body.add_modifier(Modifier::UNDERLINED)),
                    Span::styled(" (foo(bar))", style.link_url)
                ]
            );
        }
    }
    crate::hyperlinks::set_hyperlinks_override(None);
}

#[test]
fn review_markdown_unmatched_single_in_strong_matches_ts_emphasis_pairing() {
    let style = MarkdownStyle::default();
    // Actual TS styled frame: one literal star, then italic a*b; the escaped
    // star is literal while the next star opens a nested emphasis span.
    let spans = render_inline(r"**a\**b**", &style);
    assert_eq!(
        spans
            .iter()
            .map(|span| span.content.as_str())
            .collect::<String>(),
        "*a*b"
    );
    assert_eq!(spans[0], Span::styled("*", style.body));
    assert!(spans
        .iter()
        .skip(1)
        .all(|span| span.style.add_modifier == Modifier::ITALIC));
    let complete = render_inline("**outer *inner* tail**", &style);
    assert_eq!(
        complete
            .iter()
            .map(|span| span.content.as_str())
            .collect::<String>(),
        "outer inner tail"
    );
    assert!(complete
        .iter()
        .all(|span| span.style.add_modifier.contains(Modifier::BOLD)));
    // An intraword single star is both-flanking; marked keeps this strong.
    let intraword = render_inline("**a*b**", &style);
    assert_eq!(
        intraword,
        vec![Span::styled("a*b", style.body.add_modifier(Modifier::BOLD))]
    );
    // Pinned marked18.0.7 tokens also use literal '*' + nested em for the
    // ordinary left-only inner opener; it is not restricted to an escape case.
    let ordinary = render_inline("**a *b**", &style);
    assert_eq!(
        ordinary,
        vec![
            Span::styled("*", style.body),
            Span::styled("a ", style.body.add_modifier(Modifier::ITALIC)),
            Span::styled("b", style.body.add_modifier(Modifier::ITALIC)),
        ]
    );
}

// Visible-text tests discard metadata only in the legacy-capability fixture;
// raw metadata contracts use super::render_inline/render_markdown explicitly.
fn render_inline(text: &str, style: &MarkdownStyle) -> Line {
    let mut line = super::render_inline(text, style);
    if !crate::hyperlinks::hyperlinks_enabled() {
        crate::hyperlinks::strip_osc8(&mut line);
    }
    line
}

fn render_markdown(text: &str, width: usize, style: &MarkdownStyle) -> Vec<Line> {
    let mut rows = super::render_markdown(text, width, style);
    if !crate::hyperlinks::hyperlinks_enabled() {
        for row in &mut rows {
            crate::hyperlinks::strip_osc8(row);
        }
    }
    rows
}

#[test]
fn review_markdown_legacy_links_keep_metadata_and_session_base() {
    crate::hyperlinks::set_hyperlinks_override(Some(false));
    let mut style = MarkdownStyle {
        link_base_url: Some(url::Url::parse("file:///workspace/project/").unwrap()),
        ..MarkdownStyle::default()
    };
    let line = super::render_inline("[link](url)", &style);
    assert_eq!(
        line,
        vec![
            Span::styled(
                format!(
                    "{}link{}",
                    crate::hyperlinks::osc8_open("file:///workspace/project/url"),
                    crate::hyperlinks::OSC8_CLOSE
                ),
                style.body.add_modifier(Modifier::UNDERLINED)
            ),
            Span::styled(" (url)", style.link_url),
        ]
    );
    let mut cache = MarkdownBlockCache::default();
    let text = "[link](url)\n\ntail";
    let before = super::render_markdown_tagged(text, 80, &style, "", &mut cache);
    style.link_base_url = Some(url::Url::parse("file:///workspace/other/").unwrap());
    let after = super::render_markdown_tagged(text, 80, &style, "", &mut cache);
    assert_ne!(before, after);
    assert_eq!(after, super::render_markdown(text, 80, &style));
    crate::hyperlinks::set_hyperlinks_override(None);
}

#[test]
fn review_markdown_outdented_nested_text_matches_captured_ts_frame() {
    let text = "1. parent\n   - child\n     - leaf\n   continuation\n2. sibling";
    let style = MarkdownStyle::default();
    let rows = render_markdown(text, 80, &style);
    let flat: Vec<String> = rows
        .iter()
        .map(|row| row.iter().map(|span| span.content.as_str()).collect())
        .collect();
    assert_eq!(
        flat,
        vec![
            "1. parent",
            "    - child",
            "          - leaf",
            "continuation",
            "2. sibling"
        ]
    );
    for width in [40, 80, 120] {
        assert_eq!(
            markdown_row_count(text, width, &style),
            render_markdown(text, width, &style).len()
        );
    }
}

#[test]
fn review_markdown_adjacent_emphasis_keeps_the_next_opener() {
    let style = MarkdownStyle::default();
    let spans = render_inline("**bold***italic*", &style);
    let actual: Vec<_> = spans
        .iter()
        .map(|s| (s.content.as_str(), s.style.add_modifier))
        .collect();
    assert_eq!(
        actual,
        vec![("bold", Modifier::BOLD), ("italic", Modifier::ITALIC)]
    );
    // A real nested opener still owns the first star of the triple closer.
    let spans = render_inline("**outer *inner***", &style);
    assert_eq!(
        spans.iter().map(|s| s.content.as_str()).collect::<String>(),
        "outer inner"
    );
    assert!(spans
        .last()
        .unwrap()
        .style
        .add_modifier
        .contains(Modifier::BOLD | Modifier::ITALIC));
    for text in ["**outer *inner* tail***next*", "**outer `*` tail***next*"] {
        let spans = render_inline(text, &style);
        let joined: String = spans.iter().map(|s| s.content.as_str()).collect();
        let expected = if text.contains('`') {
            "outer * tailnext"
        } else {
            "outer inner tailnext"
        };
        assert_eq!(joined, expected);
        let next = spans.last().unwrap();
        assert_eq!(next.content, "next");
        assert_eq!(next.style.add_modifier, Modifier::ITALIC);
    }
}

#[test]
fn review_markdown_link_titles_skip_escaped_quotes() {
    let style = MarkdownStyle::default();
    for text in [r#"[t](url "a \"b\"")"#, r"[t](url 'a \'b\'')"] {
        let mut spans = render_inline(text, &style);
        crate::hyperlinks::strip_osc8(&mut spans);
        assert_eq!(
            spans.iter().map(|s| s.content.as_str()).collect::<String>(),
            "t (url)"
        );
        assert!(spans[0].style.add_modifier.contains(Modifier::UNDERLINED));
    }
}

#[test]
fn review_markdown_deep_lists_keep_text_with_a_bounded_tree() {
    let text = (0..96).fold(String::new(), |mut text, n| {
        writeln!(text, "{}- item{n}", "  ".repeat(n)).expect("writing a String cannot fail");
        text
    });
    let blocks = parse_blocks(&text);
    let mut pending = Vec::new();
    for block in &blocks {
        if let BlockKind::List(list) = &block.kind {
            pending.push((list, 0));
        }
    }
    let mut deepest = 0;
    let mut literal_tail = false;
    while let Some((list, depth)) = pending.pop() {
        deepest = deepest.max(depth);
        for item in &list.items {
            for part in &item.parts {
                match part {
                    ListPart::List(child) => pending.push((child, depth + 1)),
                    ListPart::Text(text) | ListPart::LazyText(text) => {
                        literal_tail |= text == "- item95";
                    }
                }
            }
        }
    }
    assert!(deepest <= 64, "nested tree depth was {deepest}");
    assert!(
        literal_tail,
        "overflow nesting must preserve literal content"
    );
    let style = MarkdownStyle::default();
    assert_eq!(
        markdown_row_count(&text, 16_000, &style),
        render_markdown(&text, 16_000, &style).len()
    );
}

/// The pre-fix overlong-word break loop from origin/rust (the quadratic re-measure version): the
/// output oracle for [`wrap_spans_into`]'s arithmetic-tracked rewrite — every corpus below must
/// wrap to byte- and style-identical `Line`s on both algorithms. The oracle stays quadratic, so
/// differential corpora are bounded (~4KiB); the linear rewrite gets its own unbounded stress test.
fn legacy_wrap_spans_into(spans: &[Span], width: usize, out: &mut geometry::WrapOutput<'_>) {
    if width == 0 {
        for span in spans {
            out.push(&span.content, span.style);
        }
        out.finish_row(/*trim*/ false);
        return;
    }
    let joined_width: usize = spans.iter().map(|s| str_width(&s.content)).sum();
    if joined_width <= width {
        for span in spans {
            out.push(&span.content, span.style);
        }
        out.finish_row(/*trim*/ false);
        return;
    }
    let mut tokens: Vec<(String, Style)> = Vec::new();
    for span in spans {
        let mut word = String::new();
        for ch in span.content.chars() {
            if ch == ' ' {
                if !word.is_empty() {
                    tokens.push((std::mem::take(&mut word), span.style));
                }
                match tokens.last_mut() {
                    Some((text, _)) if text.chars().all(|c| c == ' ') => text.push(' '),
                    _ => tokens.push((" ".to_string(), span.style)),
                }
            } else {
                word.push(ch);
            }
        }
        if !word.is_empty() {
            tokens.push((word, span.style));
        }
    }

    let mut col = 0usize;
    let mut i = 0usize;
    while i < tokens.len() {
        let (text, style) = &tokens[i];
        let w = str_width(text);
        if col + w > width && out.has_content {
            out.finish_row(/*trim*/ true);
            col = 0;
            if text.trim().is_empty() {
                i += 1;
                continue;
            }
        }
        let mut rest = text.clone();
        let style = *style;
        while str_width(&rest) + col > width {
            let mut take = String::new();
            let mut tw = 0usize;
            let mut taken = 0usize;
            while taken < rest.len() {
                if let Some(len) = crate::width::escape_len(&rest[taken..]) {
                    take.push_str(&rest[taken..taken + len]);
                    taken += len;
                    continue;
                }
                let c = rest[taken..].chars().next().expect("char at boundary");
                let cw = crate::width::char_width(c);
                if tw + cw + col > width {
                    break;
                }
                take.push(c);
                tw += cw;
                taken += c.len_utf8();
            }
            if take.is_empty() {
                break;
            }
            out.push(&take, style);
            out.finish_row(/*trim*/ false);
            col = 0;
            rest = rest[taken..].to_string();
        }
        col += str_width(&rest);
        out.push(&rest, style);
        i += 1;
    }
    out.finish_row(/*trim*/ false);
}

fn legacy_wrap_spans(spans: &[Span], width: usize, out: &mut Vec<Line>) {
    legacy_wrap_spans_into(spans, width, &mut geometry::WrapOutput::render(out));
}

/// Full-structure parity: every span's content AND style, and the row count the layout caches
/// must equal the rendered rows on both the legacy oracle and the rewrite.
fn assert_wrap_parity(spans: &[Span], widths: &[usize]) {
    for &width in widths {
        let mut legacy: Vec<Line> = Vec::new();
        legacy_wrap_spans(spans, width, &mut legacy);
        let mut current: Vec<Line> = Vec::new();
        wrap_spans(spans, width, &mut current);
        assert_eq!(
            legacy, current,
            "wrap parity (styled spans) broke at width {width}: spans={spans:?}"
        );
        let mut counter = geometry::WrapOutput::count();
        wrap_spans_into(spans, width, &mut counter);
        assert_eq!(
            counter.rows,
            current.len(),
            "row count vs render broke at width {width}: spans={spans:?}"
        );
    }
}

#[test]
fn wrap_parity_ascii_monowords_bounded() {
    // the catastrophic class, bounded for the O(n^2) oracle
    for len in [81usize, 160, 1024, 4096] {
        let spans = vec![Span::styled("x".repeat(len), Style::default())];
        assert_wrap_parity(&spans, &[1, 2, 3, 7, 79, 80, 81, 200]);
    }
    // a monoword behind an ordinary word (a mid-row break: col > 0)
    let spans = vec![Span::styled(
        format!("lead {}", "b".repeat(4000)),
        Style::default(),
    )];
    assert_wrap_parity(&spans, &[3, 7, 20, 80, 81]);
}

#[test]
fn wrap_parity_zwj_family_and_affixes() {
    // the reviewer's cluster-split repro class: the tentative-exit true measure resyncs
    // the arithmetic — the exact token plus prefixes/suffixes across widths
    let family = "\u{1F468}\u{200D}\u{1F469}\u{200D}\u{1F467}";
    for token in [
        format!("aa{family}aaa"),
        family.to_string(),
        format!("a{family}"),
        format!("{family}a"),
        format!("aa{family}aa"),
        format!("\u{200D}{family}"),
        format!("{family}\u{200D}"),
        format!("aaa {family} aaa"),
    ] {
        let spans = vec![Span::styled(token, Style::default())];
        assert_wrap_parity(&spans, &[1, 2, 3, 4, 5, 6, 7, 8, 12, 40]);
    }
}

#[test]
fn wrap_parity_mixed_unicode_escapes_tabs() {
    // ZWJ + skin tone, regional flags, combining and prepending marks, tabs, malformed ANSI, a
    // well-formed OSC 8 hyperlink, and multispan styling at span boundaries.
    let bodies = [
        format!("{}  ", "\u{1F468}\u{1F3FD}\u{200D}\u{1F33E}".repeat(64)),
        format!("{} ", "\u{1F1FA}\u{1F1F8}\u{1F1EB}\u{1F1F7}".repeat(64)),
        format!("{} ", "e\u{0301}".repeat(300)),
        format!("{} a", "\u{0605}".repeat(120)),
        "a\tb c\t\td ".repeat(64),
        format!("\u{1b} lone {}", "y".repeat(300)),
        format!("\u{1b}[31 unterminated {}", "m".repeat(300)),
        format!(
            "\u{1b}]8;;http://x\u{1b}\\link\u{1b}]8;;\u{1b}\\ {}",
            "z".repeat(300)
        ),
    ];
    for body in bodies {
        let spans = vec![Span::styled(body, Style::default())];
        assert_wrap_parity(&spans, &[1, 2, 3, 4, 5, 7, 9, 12, 40, 80]);
    }
    // multispan: distinct styles and a monoword at a span boundary
    let spans = vec![
        Span::styled(
            "intro ".to_string(),
            Style::default().add_modifier(Modifier::BOLD),
        ),
        Span::styled(
            "q".repeat(2000),
            Style::default().add_modifier(Modifier::ITALIC),
        ),
        Span::styled(" tail words here".to_string(), Style::default()),
    ];
    assert_wrap_parity(&spans, &[1, 2, 4, 9, 17, 60, 80]);
}

#[test]
fn wrap_parity_fits_exactly_and_edges() {
    // rows that fit whole, exactly-width tokens, and width 0 (no wrap)
    let spans = vec![Span::styled("abcdefgh".to_string(), Style::default())];
    assert_wrap_parity(&spans, &[0, 1, 7, 8, 9, 100]);
    let spans = vec![Span::styled(String::new(), Style::default())];
    assert_wrap_parity(&spans, &[0, 1, 80]);
}

#[test]
fn wrap_stress_megabyte_monoword_candidate_only() {
    // The rewrite must wrap a 1MiB unbroken token in one linear pass: content round-trips
    // exactly and the ASCII row count is exact. The speed evidence belongs to the recorded
    // benchmark pair, not a wall-clock assert in a deterministic unit test.
    let token = "x".repeat(1 << 20);
    let spans = vec![Span::styled(token.clone(), Style::default())];
    let width = 80usize;
    let mut current: Vec<Line> = Vec::new();
    wrap_spans(&spans, width, &mut current);
    // 1048576 chars at 80 columns: CEIL rows (a floor here fails the 16-char remainder)
    assert_eq!(
        current.len(),
        token.len().div_ceil(width),
        "exact ASCII row count"
    );
    let joined: String = current
        .iter()
        .flat_map(|line| line.iter().map(|span| span.content.as_str()))
        .collect();
    assert_eq!(joined, token, "hard-broken rows round-trip");
}

#[test]
fn heading_and_paragraph() {
    let style = MarkdownStyle::default();
    let lines = render_markdown("# Title\n\nBody text here", 40, &style);
    // Blank line between blocks: the TS `space` token renders one empty row between them.
    assert_eq!(lines.len(), 3);
    assert_eq!(lines[0][0].content, "Title");
    assert!(lines[1].is_empty(), "the space row is empty");
    let joined: String = lines[2].iter().map(|s| s.content.as_str()).collect();
    assert_eq!(joined, "Body text here");
    // Adjacent heading + paragraph: heading pushes a blank line.
    let adjacent = render_markdown("# Title\nBody text here", 40, &style);
    assert_eq!(adjacent.len(), 3);
}

#[test]
fn heading_link_wraps_keeps_the_affordance_and_counts() {
    crate::hyperlinks::set_hyperlinks_override(Some(true));
    let style = MarkdownStyle::default();
    let lines = render_markdown("# [docs](https://x.dev/a)", 40, &style);
    assert_eq!(lines.len(), 1);
    let label = &lines[0][0];
    assert!(label.style.add_modifier.contains(Modifier::UNDERLINED));
    assert_eq!(label.style.fg, style.heading.fg);
    let bracket = lines[0].last().expect("bracket span");
    assert_eq!(bracket.style.fg, style.link_url.fg);
    let visible: String = lines[0]
        .iter()
        .map(|s| crate::hyperlinks::strip_osc8_content(&s.content))
        .collect();
    assert_eq!(visible, "docs (https://x.dev/a)");
    // A narrow heading wraps like any row: the bracket — closing `]` included —
    // lands on its own row instead of clipping (count==paint at every width).
    let rows = render_markdown("# [docs](https://x.dev/a)", 20, &style);
    assert_eq!(rows.len(), 2, "rows: {rows:?}");
    let visible: Vec<String> = rows
        .iter()
        .map(|l| {
            l.iter()
                .map(|s| crate::hyperlinks::strip_osc8_content(&s.content))
                .collect::<String>()
        })
        .collect();
    assert_eq!(
        visible,
        vec!["docs".to_string(), "(https://x.dev/a)".to_string()]
    );
    for width in 1..40 {
        assert_eq!(
            markdown_row_count("# [docs](https://x.dev/a)", width, &style),
            render_markdown("# [docs](https://x.dev/a)", width, &style).len(),
            "count==paint at width {width}"
        );
    }
    let ranges = crate::hyperlinks::frame_link_ranges(&rows);
    assert_eq!(ranges.len(), 1, "one clickable region: {ranges:?}");
    assert_eq!(
        (ranges[0].row, ranges[0].start_col, ranges[0].end_col),
        (0, 0, 4)
    );
    assert_eq!(ranges[0].url, "https://x.dev/a");
    crate::hyperlinks::set_hyperlinks_override(None);
}

#[test]
fn heading_keeps_code_and_bracket_spans_by_origin() {
    // A theme can collide `mdCode`/`mdBody` onto the same color as `mdLinkUrl`; the
    // taper reads the code and bracket spans by origin, not style equality: the
    // codespan keeps its own color while plain text and labels taper to the h1
    // heading style (bold + underline), the label keeping its underline affordance.
    let mut style = MarkdownStyle::default();
    style.code = style.link_url;
    style.body = style.link_url;
    crate::hyperlinks::set_hyperlinks_override(Some(false));
    let lines = render_markdown("# `c` [d](https://x.dev/a)", 40, &style);
    let taper = style
        .heading
        .add_modifier(Modifier::BOLD | Modifier::UNDERLINED);
    assert_eq!(
        lines,
        vec![vec![
            Span::styled("c", style.code),
            Span::styled(" ", taper),
            Span::styled("d", taper),
            Span::styled(" (https://x.dev/a)", style.link_url),
        ]]
    );
    crate::hyperlinks::set_hyperlinks_override(None);
}

#[test]
fn paragraph_keeps_final_line_trailing_whitespace() {
    // The TS lexer's paragraph token carries the block's trailing whitespace (probe vs the TS
    // binary: "stream. " with the space inside the styled span). Soft line breaks render one row
    // per line, so the trailing whitespace rides on the LAST rendered row.
    let style = MarkdownStyle::default();
    let rows = render_markdown("the story\ntail end ", 40, &style);
    let flat: Vec<String> = rows
        .iter()
        .map(|line| line.iter().map(|s| s.content.as_str()).collect())
        .collect();
    assert_eq!(flat, vec!["the story".to_string(), "tail end ".to_string()]);
    // Single-line paragraph: the trailing whitespace stays in the span.
    let joined = render_markdown("a\nb ", 40, &style);
    let last: String = joined[1].iter().map(|s| s.content.as_str()).collect();
    assert_eq!(last, "b ");
}

#[test]
fn paragraph_blank_lines_render_space_rows() {
    let style = MarkdownStyle::default();
    let lines = render_markdown("a\n\nb", 40, &style);
    let flat: Vec<String> = lines
        .iter()
        .map(|line| line.iter().map(|s| s.content.as_str()).collect())
        .collect();
    assert_eq!(flat, vec!["a".to_string(), String::new(), "b".to_string()]);
}

#[test]
fn consecutive_blank_lines_render_one_space_row() {
    let style = MarkdownStyle::default();
    // marked collapses a blank-line run into one `space` token.
    let lines = render_markdown("a\n\n\n\nb", 40, &style);
    assert_eq!(lines.len(), 3);
    assert!(lines[1].is_empty());
}

#[test]
fn soft_breaks_render_one_row_per_line() {
    // TS ground truth (marked + `applyTextWithNewlines`): the soft newlines survive into the
    // paragraph's string and the width pass breaks there — "one\ntwo" is one paragraph, two rows.
    let style = MarkdownStyle::default();
    let lines = render_markdown("one\ntwo", 40, &style);
    assert_eq!(lines.len(), 2);
    let joined: String = lines[0].iter().map(|s| s.content.as_str()).collect();
    assert_eq!(joined, "one");
    let joined: String = lines[1].iter().map(|s| s.content.as_str()).collect();
    assert_eq!(joined, "two");
}

#[test]
fn code_block_keeps_space_rows_around_it() {
    let style = MarkdownStyle::default();
    let lines = render_markdown("para\n\n```rust\nfn a() {}\n```\n\nafter", 40, &style);
    let flat: Vec<String> = lines
        .iter()
        .map(|line| line.iter().map(|s| s.content.as_str()).collect())
        .collect();
    assert_eq!(
        flat,
        vec![
            "para".to_string(),
            String::new(),
            "  fn a() {}".to_string(),
            String::new(),
            "after".to_string(),
        ]
    );
}

#[test]
fn code_block_indented_no_borders() {
    let style = MarkdownStyle::default();
    // TS `renderCodeBlock`: `codeBlockIndent` (default "  ") outside the
    // styled code line, no border rows in the chat markdown.
    let lines = render_markdown("```rust\nfn main() {}\n```", 40, &style);
    assert_eq!(lines.len(), 1);
    assert_eq!(lines[0][0].content, "  ");
    assert_eq!(lines[0][1].content, "fn main() {}");
    // An empty block still renders one indented empty line.
    let empty = render_markdown("```\n```", 40, &style);
    assert_eq!(empty.len(), 1);
    assert_eq!(empty[0][0].content, "  ");
}

#[test]
fn python_fence_renders_the_ts_token_colors() {
    // The TS markdown theme highlights ```python fences through cli-highlight; the fence line's
    // spans carry the syntax palette colors, the indent stays outside them.
    let theme = crate::theme::Theme::builtin("prime", crate::theme::ColorMode::TrueColor);
    let style = MarkdownStyle::from_theme(&theme);
    let keyword = theme.fg_style(crate::theme::ThemeColor::SyntaxKeyword);
    let number = theme.fg_style(crate::theme::ThemeColor::SyntaxNumber);
    let string = theme.fg_style(crate::theme::ThemeColor::SyntaxString);
    let lines = render_markdown("```python\nx = 1\nflag = 'yes'\n```", 40, &style);
    assert_eq!(lines.len(), 2);
    assert_eq!(lines[0][0].content, "  ");
    // `x = 1`: plain identifier and punctuation, then the number.
    assert_eq!(lines[0][1].content, "x = ");
    assert_eq!(lines[0][1].style, Style::default());
    assert_eq!(lines[0][2].content, "1");
    assert_eq!(lines[0][2].style, number);
    assert_eq!(lines[1][2].content, "'yes'");
    assert_eq!(lines[1][2].style, string);
    // The keyword scope lands on a reserved word.
    let keyword_lines = render_markdown("```python\nreturn x\n```", 40, &style);
    assert_eq!(keyword_lines[0][1].content, "return");
    assert_eq!(keyword_lines[0][1].style, keyword);
}

#[test]
fn python_fence_lang_matches_the_hljs_aliases() {
    let style = MarkdownStyle::default();
    // `getLanguage` lowercases; python registers py/gyp/ipython, and marked passes the
    // whole trimmed info string, so an info string with attributes stays uniform.
    for fence in ["py", "PYTHON", "ipython"] {
        let lines = render_markdown(&format!("```{fence}\nx = 'y'\n```"), 40, &style);
        assert!(
            lines[0].iter().any(|s| s.style != Style::default()),
            "{fence} must highlight"
        );
    }
    let uniform = render_markdown("```python foo=1\nx = 'y'\n```", 40, &style);
    assert!(uniform[0]
        .iter()
        .skip(1)
        .all(|s| s.style == style.code_block));
}

#[test]
fn quiet_style_renders_python_fences_uniform() {
    // The thinking theme replaces TS `highlightCode` with dim lines:
    // with no palette the block keeps the uniform code_block color.
    let style = MarkdownStyle {
        syntax: None,
        ..MarkdownStyle::default()
    };
    let lines = render_markdown("```python\nx = 1\n```", 40, &style);
    assert_eq!(lines.len(), 1);
    assert_eq!(lines[0][1].content, "x = 1");
    assert_eq!(lines[0][1].style, style.code_block);
}

/// The TS-parity cacheability rule: a streaming frame caches the SETTLED blocks (every
/// block but the final one) and never the changing final block.
#[test]
fn streaming_frames_cache_only_settled_blocks() {
    let style = MarkdownStyle::default();
    let mut cache = MarkdownBlockCache::default();
    render_markdown_tagged("alpha\n\nbe", 40, &style, "", &mut cache);
    let frame = render_markdown_tagged("alpha\n\nbeta", 40, &style, "", &mut cache);
    assert_eq!(frame, render_markdown("alpha\n\nbeta", 40, &style));
    let cached: Vec<_> = cache.0.into_values().collect();
    assert_eq!(cached, vec![render_markdown("alpha", 40, &style)]);
}

/// The key must cover every `render_block` input: list `ordered`/`start` (the markers are stripped
/// from `block.lines`), the code fence lang, and the following block's trailing-blank decision — a
/// hole would replay one doc's rows under another.
#[test]
fn block_cache_key_covers_every_render_input() {
    let theme = crate::theme::Theme::builtin("prime", crate::theme::ColorMode::TrueColor);
    let style = MarkdownStyle::from_theme(&theme);
    let mut cache = MarkdownBlockCache::default();
    for doc in [
        "- a\n- b\n\nend",
        "1. a\n2. b\n\nend",
        "3. a\n4. b\n\nend",
        "```python\nx = 1\n```\n\nend",
        "```json\nx = 1\n```\n\nend",
        "a\n# h",
        "a\n- h",
    ] {
        assert_eq!(
            render_markdown_tagged(doc, 40, &style, "", &mut cache),
            render_markdown(doc, 40, &style),
            "{doc:?}"
        );
    }
}

#[test]
fn python_fence_multiline_string_carries_across_rows() {
    // One highlight.js pass over the whole block: a triple-quoted
    // string keeps the string color on every row it spans.
    let theme = crate::theme::Theme::builtin("prime", crate::theme::ColorMode::TrueColor);
    let style = MarkdownStyle::from_theme(&theme);
    let string = theme.fg_style(crate::theme::ThemeColor::SyntaxString);
    let lines = render_markdown("```python\ns = '''a\nb'''\n```", 40, &style);
    assert_eq!(lines.len(), 2);
    assert_eq!(lines[0][2].content, "'''a");
    assert_eq!(lines[0][2].style, string);
    assert_eq!(lines[1][1].content, "b'''");
    assert_eq!(lines[1][1].style, string);
}

#[test]
fn long_code_rows_wrap_at_the_width() {
    // TS renderBlock wraps every code row (wrapTextWithAnsi): the indent
    // leads the first row only and no code text is lost.
    let style = MarkdownStyle::default();
    let code = (0..50)
        .map(|i| format!("f({i}, 'x')"))
        .collect::<Vec<_>>()
        .join(" ");
    for fence in ["```", "```python"] {
        let text = format!("intro\n\n{fence}\n{code}\n```\n\nafter");
        let rows: Vec<String> = render_markdown(&text, 40, &style)
            .iter()
            .map(|row| row.iter().map(|s| s.content.as_str()).collect())
            .collect();
        let code_rows = &rows[2..rows.len() - 2];
        assert!(
            code_rows[0].starts_with("  f(0,") && !code_rows[1].starts_with(' '),
            "{rows:?}"
        );
        assert!(code_rows.iter().all(|row| str_width(row) <= 40), "{rows:?}");
        assert_eq!(code_rows.concat().replace(' ', ""), code.replace(' ', ""));
        assert_eq!(markdown_row_count(&text, 40, &style), rows.len());
    }
}

#[test]
fn list_render() {
    let style = MarkdownStyle::default();
    let lines = render_markdown("- one\n- two", 40, &style);
    assert_eq!(lines.len(), 2);
    assert_eq!(lines[0][0].content, "- ");
    assert_eq!(lines[0][1].content, "one");
}

#[test]
fn inline_bold_code_link() {
    // Pin the terminal-capability gate: without OSC 8 support the link
    // renders the legacy `label [url]` observability form (no wrap).
    crate::hyperlinks::set_hyperlinks_override(Some(false));
    let style = MarkdownStyle::default();
    let spans = render_inline("a **b** `c` [d](http://e)", &style);
    let texts: Vec<&str> = spans.iter().map(|s| s.content.as_str()).collect();
    assert_eq!(texts, vec!["a ", "b", " ", "c", " ", "d", " (http://e)"]);
    crate::hyperlinks::set_hyperlinks_override(None);
}

#[test]
fn legacy_link_row_is_underlined_and_shows_the_url() {
    crate::hyperlinks::set_hyperlinks_override(Some(false));
    let style = MarkdownStyle::default();
    let spans = render_inline("see [docs](https://x.dev/a)", &style);
    let texts: Vec<String> = spans.iter().map(|s| s.content.clone()).collect();
    assert_eq!(
        texts,
        vec![
            "see ".to_string(),
            "docs".to_string(),
            " (https://x.dev/a)".to_string()
        ]
    );
    assert!(spans[1].style.add_modifier.contains(Modifier::UNDERLINED));
    assert_eq!(spans[1].style.fg, style.body.fg);
    assert_eq!(spans[2].style.fg, style.link_url.fg);
    // The URL is not repeated when the label is the URL, and mailto
    // labels compare with the prefix stripped (autolinked emails).
    let bare = render_inline("[https://x.dev](https://x.dev)", &style);
    let joined: String = bare.iter().map(|s| s.content.as_str()).collect();
    assert_eq!(joined, "https://x.dev");
    let mail = render_inline("[a@b.dev](mailto:a@b.dev)", &style);
    let joined: String = mail.iter().map(|s| s.content.as_str()).collect();
    assert_eq!(joined, "a@b.dev");
    crate::hyperlinks::set_hyperlinks_override(None);
}

#[test]
fn osc8_gated_link_row_wraps_the_label_in_a_hyperlink_and_shows_the_url() {
    crate::hyperlinks::set_hyperlinks_override(Some(true));
    let style = MarkdownStyle::default();
    let spans = render_inline("see [docs](https://x.dev/a)", &style);
    let joined: String = spans.iter().map(|s| s.content.as_str()).collect();
    assert_eq!(
        joined,
        format!(
            "see {}docs{} (https://x.dev/a)",
            crate::hyperlinks::osc8_open("https://x.dev/a"),
            crate::hyperlinks::OSC8_CLOSE
        )
    );
    assert!(
        spans[1].style.add_modifier.contains(Modifier::UNDERLINED),
        "the label underlines: {joined}"
    );
    assert_eq!(spans[2].style.fg, style.link_url.fg);
    // The sequences are zero-width: the row measures like plain text plus the
    // bracketed URL.
    assert_eq!(str_width(&joined), str_width("see docs (https://x.dev/a)"));
    // Windows drive-letter targets classify as file paths; the label is
    // the URL, so no bracket follows it.
    let drive = render_inline("[c:\\src](c:\\src)", &style);
    let joined: String = drive.iter().map(|s| s.content.as_str()).collect();
    assert!(joined.contains("file:///c:/src"), "drive path: {joined}");
    assert!(
        !joined.contains(" ["),
        "no bracket when the label is the url: {joined}"
    );
    crate::hyperlinks::set_hyperlinks_override(None);
}

#[test]
fn balanced_parens_in_a_link_destination_stay_intact() {
    // CommonMark link destinations keep balanced parentheses: the destination ends
    // at its own `)`, so no stray `)` leaks into the text.
    crate::hyperlinks::set_hyperlinks_override(Some(false));
    let style = MarkdownStyle::default();
    let url = "https://en.wikipedia.org/wiki/Function_(mathematics)";
    let spans = render_inline(&format!("[math]({url})"), &style);
    assert_eq!(
        spans,
        vec![
            Span::styled("math", style.body.add_modifier(Modifier::UNDERLINED)),
            Span::styled(format!(" ({url})"), style.link_url),
        ]
    );
    crate::hyperlinks::set_hyperlinks_override(None);
    crate::hyperlinks::set_hyperlinks_override(Some(true));
    let spans = render_inline(&format!("[math]({url})"), &style);
    assert_eq!(
        spans,
        vec![
            Span::styled(
                format!(
                    "{}math{}",
                    crate::hyperlinks::osc8_open(url),
                    crate::hyperlinks::OSC8_CLOSE
                ),
                style.body.add_modifier(Modifier::UNDERLINED),
            ),
            Span::styled(format!(" ({url})"), style.link_url),
        ]
    );
    crate::hyperlinks::set_hyperlinks_override(None);
}

#[test]
fn escaped_parens_never_open_or_close_the_link_destination() {
    // Marked consumes the escape before publishing token.href. Escaped parens
    // stay literal without affecting balance; the visible URL and OSC8 href
    // both use that unescaped destination. A sole escaped closer is not a link.
    crate::hyperlinks::set_hyperlinks_override(Some(false));
    let style = MarkdownStyle {
        link_base_url: Some(url::Url::parse("file:///fixture/root/").unwrap()),
        ..MarkdownStyle::default()
    };
    let spans = render_inline("[a](b\\(c)", &style);
    assert_eq!(
        spans,
        vec![
            Span::styled("a", style.body.add_modifier(Modifier::UNDERLINED)),
            Span::styled(" (b(c)", style.link_url),
        ]
    );
    for (text, destination, href) in [
        (r"[a](b\(c)", "b(c", "file:///fixture/root/b(c"),
        (r"[a](b\))", "b)", "file:///fixture/root/b)"),
    ] {
        assert_eq!(
            super::render_inline(text, &style),
            vec![
                Span::styled(
                    format!(
                        "{}a{}",
                        crate::hyperlinks::osc8_open(href),
                        crate::hyperlinks::OSC8_CLOSE
                    ),
                    style.body.add_modifier(Modifier::UNDERLINED)
                ),
                Span::styled(format!(" ({destination})"), style.link_url),
            ]
        );
    }
    let plain = render_inline("[a](b\\)", &style);
    assert_eq!(plain.len(), 1);
    // Not a link, but marked's escape rule still processes the backslash.
    assert_eq!(plain[0].content, "[a](b)");
    crate::hyperlinks::set_hyperlinks_override(None);
}

#[test]
fn the_url_bracket_scrubs_terminal_control_bytes() {
    // A raw escape byte smuggled into the url must never re-enter the terminal as a
    // live OSC/CSI sequence: the bracket percent-encodes control bytes like the OSC 8
    // target.
    crate::hyperlinks::set_hyperlinks_override(Some(true));
    let style = MarkdownStyle::default();
    let url = "https://x.dev/\u{1b}]52;c;base64";
    let spans = render_inline(&format!("[a]({url})"), &style);
    let bracket = spans.last().expect("bracket span");
    assert_eq!(bracket.content, " (https://x.dev/%1B]52;c;base64)");
    // The bare-url autolink form hardens the same way (the regex tail only excludes
    // whitespace); the www form's href gains its scheme, so the bracket shows.
    let www = render_inline("www.x.dev/\u{1b}]52;c=base64", &style);
    let bracket = www.last().expect("bracket span");
    assert_eq!(bracket.content, " (http://www.x.dev/%1B]52;c=base64)");
    assert!(
        !bracket.content.contains('\u{1b}'),
        "no raw escape byte in the visible bracket"
    );
    crate::hyperlinks::set_hyperlinks_override(None);
}

#[test]
fn link_url_bracket_wraps_and_counts_like_text() {
    crate::hyperlinks::set_hyperlinks_override(Some(true));
    let style = MarkdownStyle::default();
    let text = "see [docs](https://x.dev/a) tail";
    // The bracketed URL is visible text: the width accounting includes it, so the
    // row count and the painted rows agree at every width (count==paint).
    for width in 1..48 {
        let rows = markdown_row_count(text, width, &style);
        let painted = render_markdown(text, width, &style);
        assert_eq!(painted.len(), rows, "count==paint at width {width}");
    }
    // At width 18 the bracket cannot share the row with "see docs"
    // (8 + 17 > 18), so it wraps onto its own row; the tail follows it.
    let rows = render_markdown(text, 18, &style);
    let visible: Vec<String> = rows
        .iter()
        .map(|l| {
            l.iter()
                .map(|s| crate::hyperlinks::strip_osc8_content(&s.content))
                .collect::<String>()
        })
        .collect();
    assert_eq!(
        visible,
        vec![
            "see docs".to_string(),
            "(https://x.dev/a)".to_string(),
            "tail".to_string()
        ],
        "the bracket wraps like normal text"
    );
    crate::hyperlinks::set_hyperlinks_override(None);
}

#[test]
fn long_link_url_wraps_without_breaking_the_clickable_region() {
    crate::hyperlinks::set_hyperlinks_override(Some(true));
    let style = MarkdownStyle::default();
    let url = format!("https://x.dev/{}", "a".repeat(40));
    let rows = render_markdown(&format!("[docs]({url})"), 12, &style);
    assert!(rows.len() >= 4, "rows: {rows:?}");
    for row in &rows {
        let joined: String = row.iter().map(|s| s.content.as_str()).collect();
        assert!(str_width(&joined) <= 12, "row over the width: {joined:?}");
    }
    // The clickable region survives the wrap intact: exactly the label cells link
    // (the escape bytes never split mid-sequence).
    let ranges = crate::hyperlinks::frame_link_ranges(&rows);
    assert_eq!(ranges.len(), 1, "one clickable region: {ranges:?}");
    assert_eq!(ranges[0].row, 0);
    assert_eq!(ranges[0].start_col, 0);
    assert_eq!(ranges[0].end_col, str_width("docs"));
    assert_eq!(ranges[0].url, url);
    let visible: String = rows
        .iter()
        .flat_map(|l| l.iter())
        .map(|s| crate::hyperlinks::strip_osc8_content(&s.content))
        .collect();
    // The wrap drops the boundary gap (a wrapped row never carries its leading or
    // trailing space), so the visible text is `docs` then the bracketed URL.
    assert_eq!(visible, format!("docs({url})"));
    for width in 1..40 {
        assert_eq!(
            markdown_row_count(&format!("[docs]({url})"), width, &style),
            render_markdown(&format!("[docs]({url})"), width, &style).len(),
            "count==paint at width {width}"
        );
    }
    crate::hyperlinks::set_hyperlinks_override(None);
}

#[test]
fn bare_url_autolinks_osc8() {
    crate::hyperlinks::set_hyperlinks_override(Some(true));
    let style = MarkdownStyle::default();
    let spans = render_inline("see https://x.dev/a?b=1 now", &style);
    let joined: String = spans.iter().map(|s| s.content.as_str()).collect();
    assert_eq!(
        joined,
        format!(
            "see {}https://x.dev/a?b=1{} now",
            crate::hyperlinks::osc8_open("https://x.dev/a?b=1"),
            crate::hyperlinks::OSC8_CLOSE
        )
    );
    // The label is one zero-width-wrapped run; the URL never prints
    // twice and no bracket follows it (the label already is the URL).
    assert_eq!(str_width(&joined), str_width("see https://x.dev/a?b=1 now"));
    assert!(!joined.contains(" ["), "no bracket on a bare url: {joined}");
    // The clickable bare label underlines (the observability ruling's
    // standard link affordance; the bracket part is redundant here).
    assert!(
        spans[1].style.add_modifier.contains(Modifier::UNDERLINED),
        "the bare autolink label underlines: {joined}"
    );
    crate::hyperlinks::set_hyperlinks_override(None);
}

#[test]
fn bare_url_autolink_trims_trailing_punctuation() {
    crate::hyperlinks::set_hyperlinks_override(Some(false));
    let style = MarkdownStyle::default();
    // Trailing punctuation is backpedaled out of the link and stays in the text stream.
    let spans = render_inline("go to https://x.dev/pull/182. now", &style);
    let texts: Vec<&str> = spans.iter().map(|s| s.content.as_str()).collect();
    assert_eq!(texts, vec!["go to ", "https://x.dev/pull/182", ". now"]);
    // Balanced paren groups survive; the peeled trailing run re-renders
    // so the visible row is unchanged.
    let spans = render_inline("(see https://x.dev/a(b)) ok", &style);
    let joined: String = spans.iter().map(|s| s.content.as_str()).collect();
    assert_eq!(joined, "(see https://x.dev/a(b)) ok");
    // A comma separates the link from the sentence tail.
    let spans = render_inline("(visit https://x.dev/page, thanks)", &style);
    let texts: Vec<&str> = spans.iter().map(|s| s.content.as_str()).collect();
    assert_eq!(texts, vec!["(visit ", "https://x.dev/page", ", thanks)"]);
    crate::hyperlinks::set_hyperlinks_override(None);
}

#[test]
fn bare_url_autolink_forms() {
    crate::hyperlinks::set_hyperlinks_override(Some(false));
    let style = MarkdownStyle::default();
    let joined = |md: &str| -> String {
        render_inline(md, &style)
            .iter()
            .map(|s| s.content.as_str())
            .collect()
    };
    // ftp and case-insensitive schemes link; uppercase targets pass
    // through unresolved (target == token href, like TS).
    assert_eq!(joined("ftp://files.x.io/x"), "ftp://files.x.io/x");
    assert_eq!(joined("HTTPS://UPPER.COM/PATH"), "HTTPS://UPPER.COM/PATH");
    // A bare url starts mid-word, like marked's text-rule break.
    assert_eq!(
        joined("midhttps://word.com/break"),
        "midhttps://word.com/break"
    );
    // Entity-ish runs survive the backpedal.
    assert_eq!(joined("https://x.dev/a&#39;b"), "https://x.dev/a&#39;b");
    // Explicit links win over the bare rule at the same position.
    assert_eq!(joined("[https://x.dev](https://x.dev)"), "https://x.dev");
    // Two links in one line tokenize independently.
    assert_eq!(
        joined("https://x.dev, and https://y.dev; done"),
        "https://x.dev, and https://y.dev; done"
    );
    // Not an email: only the domain-shaped tail links.
    assert_eq!(
        joined("not an email: @host, a@b, x@y.z"),
        "not an email: @host, a@b, x@y.z"
    );
    crate::hyperlinks::set_hyperlinks_override(None);
}

#[test]
fn www_autolink_gains_scheme_and_shows_the_url_in_both_forms() {
    // A www autolink's href gains the scheme, so the target differs
    // from the label and the bracket shows in BOTH capability forms.
    let style = MarkdownStyle::default();
    crate::hyperlinks::set_hyperlinks_override(Some(false));
    let spans = render_inline("www.example.com/path", &style);
    let texts: Vec<&str> = spans.iter().map(|s| s.content.as_str()).collect();
    assert_eq!(
        texts,
        vec!["www.example.com/path", " (http://www.example.com/path)"]
    );
    assert!(
        spans[0].style.add_modifier.contains(Modifier::UNDERLINED),
        "the legacy autolink label underlines"
    );
    assert_eq!(spans[1].style.fg, style.link_url.fg);
    crate::hyperlinks::set_hyperlinks_override(None);
    crate::hyperlinks::set_hyperlinks_override(Some(true));
    let spans = render_inline("www.example.com/path", &style);
    let joined: String = spans.iter().map(|s| s.content.as_str()).collect();
    assert_eq!(
        joined,
        format!(
            "{}www.example.com/path{} (http://www.example.com/path)",
            crate::hyperlinks::osc8_open("http://www.example.com/path"),
            crate::hyperlinks::OSC8_CLOSE
        )
    );
    assert!(
        spans[0].style.add_modifier.contains(Modifier::UNDERLINED),
        "the OSC 8 autolink label underlines"
    );
    assert_eq!(spans[1].style.fg, style.link_url.fg);
    crate::hyperlinks::set_hyperlinks_override(None);
}

#[test]
fn email_autolinks_with_mailto_href() {
    // Legacy form: the mailto-stripped href equals the label, so no
    // suffix prints (autolinked emails).
    crate::hyperlinks::set_hyperlinks_override(Some(false));
    let style = MarkdownStyle::default();
    let spans = render_inline("mail foo.bar+baz@example.com ok", &style);
    let joined: String = spans.iter().map(|s| s.content.as_str()).collect();
    assert_eq!(joined, "mail foo.bar+baz@example.com ok");
    // OSC 8 form: the href carries mailto:.
    crate::hyperlinks::set_hyperlinks_override(Some(true));
    let spans = render_inline("mail foo@example.com ok", &style);
    let joined: String = spans.iter().map(|s| s.content.as_str()).collect();
    assert_eq!(
        joined,
        format!(
            "mail {}foo@example.com{} ok",
            crate::hyperlinks::osc8_open("mailto:foo@example.com"),
            crate::hyperlinks::OSC8_CLOSE
        )
    );
    crate::hyperlinks::set_hyperlinks_override(None);
}

#[test]
fn angle_autolinks_become_links() {
    crate::hyperlinks::set_hyperlinks_override(Some(true));
    let style = MarkdownStyle::default();
    // The brackets are consumed; the label is the inner target.
    let spans = render_inline("x <https://angle.dev/a> y", &style);
    let joined: String = spans.iter().map(|s| s.content.as_str()).collect();
    assert_eq!(
        joined,
        format!(
            "x {}https://angle.dev/a{} y",
            crate::hyperlinks::osc8_open("https://angle.dev/a"),
            crate::hyperlinks::OSC8_CLOSE
        )
    );
    // Angle email: href gains mailto:.
    let spans = render_inline("<foo.bar@example.org>", &style);
    let joined: String = spans.iter().map(|s| s.content.as_str()).collect();
    assert_eq!(
        joined,
        format!(
            "{}foo.bar@example.org{}",
            crate::hyperlinks::osc8_open("mailto:foo.bar@example.org"),
            crate::hyperlinks::OSC8_CLOSE
        )
    );
    crate::hyperlinks::set_hyperlinks_override(None);
}

#[test]
fn bare_url_is_not_autolinked_inside_a_link_label() {
    // marked's state.inLink guard: the gfm url rule does not run while
    // a link label is tokenized, so the inner url stays plain text.
    crate::hyperlinks::set_hyperlinks_override(Some(false));
    let style = MarkdownStyle::default();
    let spans = render_inline("[see https://in.dev/x](https://out.dev/y)", &style);
    let texts: Vec<&str> = spans.iter().map(|s| s.content.as_str()).collect();
    assert_eq!(texts, vec!["see https://in.dev/x", " (https://out.dev/y)"]);
    crate::hyperlinks::set_hyperlinks_override(None);
}

#[test]
fn angle_autolink_inside_link_label_yields_the_terminal_ranges() {
    // marked tokenizes angle autolinks even inside an explicit link label, so the byte stream
    // carries the outer wrap around a label that embeds an inner OSC 8 pair. Terminals keep no
    // region stack: the inner close ends the active region, so the outer label's tail is NOT
    // linked.
    crate::hyperlinks::set_hyperlinks_override(Some(true));
    let style = MarkdownStyle::default();
    let spans = render_inline("[pre <https://inner.dev> post](https://outer.dev)", &style);
    let ranges = crate::hyperlinks::frame_link_ranges(&[spans]);
    assert_eq!(
        ranges,
        vec![
            crate::hyperlinks::LinkRange {
                row: 0,
                start_col: 0,
                end_col: 4,
                url: "https://outer.dev/".to_string(),
            },
            crate::hyperlinks::LinkRange {
                row: 0,
                start_col: 4,
                end_col: 21,
                url: "https://inner.dev/".to_string(),
            },
        ]
    );
    crate::hyperlinks::set_hyperlinks_override(None);
}

#[test]
fn table_block_renders_boxed_rows() {
    let style = MarkdownStyle::default();
    let lines = render_markdown("| a | b |\n| --- | --- |\n| 1 | 2 |\n\nafter", 40, &style);
    let flat: Vec<String> = lines
        .iter()
        .map(|line| line.iter().map(|s| s.content.as_str()).collect())
        .collect();
    assert_eq!(
        flat,
        vec![
            "┌───┬───┐".to_string(),
            "│ a │ b │".to_string(),
            "├───┼───┤".to_string(),
            "│ 1 │ 2 │".to_string(),
            "└───┴───┘".to_string(),
            String::new(),
            "after".to_string(),
        ]
    );
}

#[test]
fn styled_span_boundaries_keep_their_spaces() {
    // A gap starting a new span must not be swallowed by the wrap pass.
    let style = MarkdownStyle::default();
    let lines = render_markdown("**Hello.** I can render", 80, &style);
    let joined: String = lines[0].iter().map(|s| s.content.as_str()).collect();
    assert_eq!(joined, "Hello. I can render");
    // Whitespace runs keep their length across spans: TS `splitIntoTokensWithAnsi` holds each run
    // as ONE token and a fitting line passes through unchanged — verified against the TS dist.
    let spans = render_inline("a **b**   c", &style);
    let wrapped = wrap_spans_to_text(&spans, 40);
    assert_eq!(wrapped, "a b   c");
}

fn wrap_spans_to_text(spans: &[Span], width: usize) -> String {
    let mut lines: Vec<Line> = Vec::new();
    wrap_spans(spans, width, &mut lines);
    lines
        .iter()
        .flat_map(|l| l.iter().map(|s| s.content.as_str()))
        .collect()
}

#[test]
fn wrapping() {
    let style = MarkdownStyle::default();
    let lines = render_markdown("word ".repeat(10).trim(), 20, &style);
    assert!(lines.len() >= 3);
    for l in &lines {
        let w: usize = l.iter().map(|s| str_width(&s.content)).sum();
        assert!(w <= 20, "line too wide: {w}");
    }
}

#[test]
fn quote_block() {
    let style = MarkdownStyle::default();
    let lines = render_markdown("> wisdom", 40, &style);
    assert_eq!(lines[0][0].content, "│ ");
    assert_eq!(lines[0][1].content, "wisdom");
}

#[test]
fn emphasis_renders_chalk_modifiers() {
    // TS `theme.bold/italic/strikethrough` are chalk; chalk emits its SGR modifiers in
    // any color terminal (supports-color level >= 1 whenever stdout is a TTY), so
    // `**bold**`, `*italic*`, and `~~strike~~` carry BOLD/ITALIC/CROSSED_OUT.
    let style = MarkdownStyle::default();
    let lines = render_markdown("**b** *i* ~~s~~", 40, &style);
    assert_eq!(lines.len(), 1);
    let spans = &lines[0];
    let find = |content: &str| {
        spans
            .iter()
            .find(|s| s.content == content)
            .unwrap_or_else(|| panic!("no span {content}: {spans:?}"))
    };
    assert_eq!(find("b").style.add_modifier, Modifier::BOLD);
    assert_eq!(find("i").style.add_modifier, Modifier::ITALIC);
    assert_eq!(find("s").style.add_modifier, Modifier::CROSSED_OUT);
    assert_eq!(find("b").style.fg, style.body.fg);
}

#[test]
fn headings_taper_by_level_like_the_theme_functions() {
    // TS heading styleFn: h1 bold+underline, h2/h3 bold, h4 bold+italic, h5/h6 italic —
    // all over the heading color.
    let style = MarkdownStyle::default();
    for (md, expected) in [
        ("# one", Modifier::BOLD | Modifier::UNDERLINED),
        ("## two", Modifier::BOLD),
        ("### three", Modifier::BOLD),
        ("#### four", Modifier::BOLD | Modifier::ITALIC),
        ("##### five", Modifier::ITALIC),
        ("###### six", Modifier::ITALIC),
    ] {
        let lines = render_markdown(md, 40, &style);
        let span = &lines[0][0];
        assert_eq!(span.style.fg, style.heading.fg, "{md}");
        assert_eq!(span.style.add_modifier, expected, "{md}");
    }
    // Seven hashes is not a heading (marked: `#{1,6}`).
    let lines = render_markdown("####### seven", 40, &style);
    assert_eq!(lines[0][0].content, "####### seven");
    assert_eq!(lines[0][0].style.fg, style.body.fg);
}

#[test]
fn heading_keeps_inline_code_color() {
    // TS `renderInlineTokens` codespan: `theme.code(text) + stylePrefix` — the heading
    // modifiers close around the codespan, and it keeps the mdCode color.
    let style = MarkdownStyle::default();
    let lines = render_markdown("# a `c` b", 40, &style);
    let spans = &lines[0];
    let find = |content: &str| {
        spans
            .iter()
            .find(|s| s.content == content)
            .unwrap_or_else(|| panic!("no span {content}: {spans:?}"))
    };
    let code = find("c");
    assert_eq!(code.style.fg, style.code.fg);
    assert_eq!(code.style.add_modifier, Modifier::empty());
    let text = find("a ");
    assert_eq!(text.style.fg, style.heading.fg);
    assert_eq!(
        text.style.add_modifier,
        Modifier::BOLD | Modifier::UNDERLINED
    );
}

#[test]
fn quote_renders_the_ts_style_and_box_border() {
    // TS blockquote: border `│ `; the whole quote content renders in the quote color
    // and italic (`theme.quote(theme.italic(...))` re-applied after every inline reset),
    // with emphasis modifiers riding on top; a codespan keeps its own color.
    let style = MarkdownStyle::default();
    let lines = render_markdown("> q **b** `c`", 40, &style);
    let spans = &lines[0];
    assert_eq!(spans[0].content, "│ ");
    assert_eq!(spans[0].style.fg, style.quote_border.fg);
    let find = |content: &str| {
        spans
            .iter()
            .find(|s| s.content == content)
            .unwrap_or_else(|| panic!("no span {content}: {spans:?}"))
    };
    let q = find("q ");
    assert_eq!(q.style.fg, style.quote.fg);
    assert_eq!(q.style.add_modifier, Modifier::ITALIC);
    let b = find("b");
    assert_eq!(b.style.fg, style.quote.fg);
    assert_eq!(b.style.add_modifier, Modifier::BOLD | Modifier::ITALIC);
    let c = find("c");
    assert_eq!(c.style.fg, style.code.fg);
    assert_eq!(c.style.add_modifier, Modifier::ITALIC);
}

#[test]
fn link_fallback_prints_parens_and_parses_titles() {
    crate::hyperlinks::set_hyperlinks_override(Some(false));
    let style = MarkdownStyle::default();
    let lines = render_markdown("[t](https://x.dev/a)", 40, &style);
    let visible: String = lines[0].iter().map(|s| s.content.as_str()).collect();
    assert_eq!(visible, "t (https://x.dev/a)");
    // marked's link rule: a quoted title after the destination parses out of the URL.
    let lines = render_markdown(r#"[t](https://x.dev/a "Title")"#, 40, &style);
    let visible: String = lines[0].iter().map(|s| s.content.as_str()).collect();
    assert_eq!(visible, "t (https://x.dev/a)");
    crate::hyperlinks::set_hyperlinks_override(None);
}

#[test]
fn hr_caps_at_eighty_columns() {
    // TS hr: `"─".repeat(Math.min(width, 80))`.
    let style = MarkdownStyle::default();
    let lines = render_markdown("---", 120, &style);
    assert_eq!(lines[0][0].content.chars().count(), 80);
    let lines = render_markdown("---", 40, &style);
    assert_eq!(lines[0][0].content.chars().count(), 40);
}

#[test]
fn quote_lazy_continuation_stays_inside_the_quote() {
    // marked's blockquote token lazily consumes following non-blank lines that do
    // not start another block: the paragraph stays inside the quote border.
    let style = MarkdownStyle::default();
    let lines = render_markdown("> quoted\ncontinued", 40, &style);
    assert_eq!(lines.len(), 2, "rows: {lines:?}");
    for row in &lines {
        assert_eq!(row[0].content, "│ ", "border on every quote row");
    }
    let joined: String = lines[1]
        .iter()
        .skip(1)
        .map(|s| s.content.as_str())
        .collect();
    assert_eq!(joined, "continued");
    // A new block still escapes the quote (CommonMark lazy rules).
    let lines = render_markdown("> quoted\n- list", 40, &style);
    assert_eq!(lines[1][0].content, "- ");
    let joined: String = lines[1].iter().map(|s| s.content.as_str()).collect();
    assert_eq!(joined, "- list");
}

#[test]
fn quote_blank_line_renders_a_bare_border_row() {
    let style = MarkdownStyle::default();
    let lines = render_markdown("> a\n>\n> b", 40, &style);
    assert_eq!(lines.len(), 3, "rows: {lines:?}");
    assert_eq!(lines[1], vec![Span::styled("│ ", style.quote_border)]);
    let joined: String = lines[2]
        .iter()
        .skip(1)
        .map(|s| s.content.as_str())
        .collect();
    assert_eq!(joined, "b");
}

#[test]
fn nested_lists_render_indented_and_keep_parent_numbering() {
    // marked nests indented markers; TS `renderList` frames each nesting level
    // (`indent + "  "` per ancestor), giving nested rows their own indent and
    // bullets. The parent's numbering never shifts.
    let style = MarkdownStyle::default();
    let rows = render_markdown("- alpha\n  - beta\n    - gamma\n- delta", 60, &style);
    let flat: Vec<String> = rows
        .iter()
        .map(|r| r.iter().map(|s| s.content.as_str()).collect())
        .collect();
    assert_eq!(
        flat,
        vec![
            "- alpha".to_string(),
            "    - beta".to_string(),
            "          - gamma".to_string(),
            "- delta".to_string(),
        ]
    );
    let rows = render_markdown(
        "1. first\n2. second\n   - nested under second\n3. third",
        60,
        &style,
    );
    let flat: Vec<String> = rows
        .iter()
        .map(|r| r.iter().map(|s| s.content.as_str()).collect())
        .collect();
    assert_eq!(
        flat,
        vec![
            "1. first".to_string(),
            "2. second".to_string(),
            "    - nested under second".to_string(),
            "3. third".to_string(),
        ]
    );
}

#[test]
fn an_ordered_list_after_an_unordered_list_is_its_own_block() {
    // marked ends a list at a same-indent marker of a different type.
    let style = MarkdownStyle::default();
    let rows = render_markdown("- bullet\n1. ordered", 60, &style);
    let flat: Vec<String> = rows
        .iter()
        .map(|r| r.iter().map(|s| s.content.as_str()).collect())
        .collect();
    assert_eq!(flat, vec!["- bullet".to_string(), "1. ordered".to_string()]);
    assert_eq!(rows[1][0].content, "1. ");
    assert_eq!(rows[1][0].style.fg, style.list_bullet.fg);
}

#[test]
fn loose_lists_keep_blank_lines_internal() {
    // A blank line between items does not break the list (marked's loose list):
    // no blank rows render between items.
    let style = MarkdownStyle::default();
    let rows = render_markdown("- item one\n\n- item two\n\n- item three", 60, &style);
    let flat: Vec<String> = rows
        .iter()
        .map(|r| r.iter().map(|s| s.content.as_str()).collect())
        .collect();
    assert_eq!(
        flat,
        vec![
            "- item one".to_string(),
            "- item two".to_string(),
            "- item three".to_string(),
        ]
    );
    // Blank lines before a following block belong to the gap, not the list.
    let rows = render_markdown("- item one\n\nafter", 60, &style);
    let flat: Vec<String> = rows
        .iter()
        .map(|r| r.iter().map(|s| s.content.as_str()).collect())
        .collect();
    assert_eq!(
        flat,
        vec!["- item one".to_string(), String::new(), "after".to_string()]
    );
}

#[test]
fn list_item_continuation_lines_render_as_their_own_rows() {
    // TS `renderList` prefixes each item line beyond the first with `indent + "  "`.
    let style = MarkdownStyle::default();
    let rows = render_markdown("- item\n  continued", 60, &style);
    let flat: Vec<String> = rows
        .iter()
        .map(|r| r.iter().map(|s| s.content.as_str()).collect())
        .collect();
    assert_eq!(flat, vec!["- item".to_string(), "  continued".to_string()]);
    // Long continuation lines wrap; the wrapped rows keep the item-line prefix.
    let rows = render_markdown(
        "- item\n  continued text that is long enough to wrap here",
        22,
        &style,
    );
    let flat: Vec<String> = rows
        .iter()
        .map(|r| r.iter().map(|s| s.content.as_str()).collect())
        .collect();
    assert_eq!(flat[1].trim(), "continued text that");
    for row in &rows {
        let w: usize = row.iter().map(|s| str_width(&s.content)).sum();
        assert!(w <= 22, "row over the width: {w}");
    }
    // count==paint at every width.
    for width in 1..60 {
        assert_eq!(
            markdown_row_count("- item\n  continued", width, &style),
            render_markdown("- item\n  continued", width, &style).len(),
            "count==paint at width {width}"
        );
    }
}

#[test]
fn punctuation_after_a_styled_span_never_wraps_alone() {
    // TS `splitIntoTokensWithAnsi` never splits a word at an ANSI boundary: the
    // text after a bold/code close stays glued to the preceding word when the
    // row wraps, so a trailing period can never land alone on its own row.
    let style = MarkdownStyle::default();
    let rows = render_markdown("alpha beta **gamma**.", 16, &style);
    let flat: Vec<String> = rows
        .iter()
        .map(|r| r.iter().map(|s| s.content.as_str()).collect())
        .collect();
    assert_eq!(flat, vec!["alpha beta".to_string(), "gamma.".to_string()]);
    let rows = render_markdown("alpha beta `code`.", 12, &style);
    let flat: Vec<String> = rows
        .iter()
        .map(|r| r.iter().map(|s| s.content.as_str()).collect())
        .collect();
    assert_eq!(flat, vec!["alpha beta".to_string(), "code.".to_string()]);
    for width in 1..40 {
        for text in ["alpha beta **gamma**.", "alpha beta `code`."] {
            assert_eq!(
                markdown_row_count(text, width, &style),
                render_markdown(text, width, &style).len(),
                "count==paint at width {width}"
            );
        }
    }
}

#[test]
fn backslash_escapes_render_the_punctuation_literally() {
    // marked's escape rule: a backslash before ASCII punctuation consumes the
    // backslash — the punctuation never opens emphasis, code, or a heading.
    let style = MarkdownStyle::default();
    let spans = render_inline(
        r"\*not emphasis\* snake\_case \#five no code via \` here",
        &style,
    );
    let joined: String = spans.iter().map(|s| s.content.as_str()).collect();
    assert_eq!(
        joined,
        r"*not emphasis* snake_case #five no code via ` here"
    );
    for s in &spans {
        assert_eq!(s.style.add_modifier, Modifier::empty(), "{joined}");
    }
    // A trailing unescaped backslash is a hard break: the paragraph consumes it.
    let rows = render_markdown("tail\\\nnext", 40, &style);
    let flat: Vec<String> = rows
        .iter()
        .map(|r| r.iter().map(|s| s.content.as_str()).collect())
        .collect();
    assert_eq!(flat, vec!["tail".to_string(), "next".to_string()]);
}

#[test]
fn intraword_underscores_do_not_emphasize() {
    // CommonMark flanking: `_` between word characters can neither open nor
    // close emphasis, so snake_case prose keeps its underscores.
    let style = MarkdownStyle::default();
    let spans = render_inline("intra_word_underscores and snake_case_name", &style);
    let joined: String = spans.iter().map(|s| s.content.as_str()).collect();
    assert_eq!(joined, "intra_word_underscores and snake_case_name");
    for s in &spans {
        assert_eq!(s.style.add_modifier, Modifier::empty(), "{joined}");
    }
    // Boundary underscores still emphasize.
    let spans = render_inline("_real italic_ tail", &style);
    let joined: String = spans.iter().map(|s| s.content.as_str()).collect();
    assert_eq!(joined, "real italic tail");
    assert!(spans[0].style.add_modifier.contains(Modifier::ITALIC));
    // Doubled underscores keep the same flanking rule.
    let spans = render_inline("__bold__ tail", &style);
    let joined: String = spans.iter().map(|s| s.content.as_str()).collect();
    assert_eq!(joined, "bold tail");
    assert!(spans[0].style.add_modifier.contains(Modifier::BOLD));
}

#[test]
fn a_triple_close_pairs_the_inner_single_delimiter() {
    // `**outer *inner***`: the closer run's extra star closes the inner em and
    // the outer keeps the last two — marked renders bold(outer + italic(inner)).
    let style = MarkdownStyle::default();
    let spans = render_inline("**bold with *nested italic***", &style);
    let joined: String = spans.iter().map(|s| s.content.as_str()).collect();
    assert_eq!(joined, "bold with nested italic");
    for s in &spans {
        assert!(s.style.add_modifier.contains(Modifier::BOLD), "{joined}");
    }
    let inner = spans
        .iter()
        .find(|s| s.content.contains("nested italic"))
        .expect("inner span");
    assert!(inner.style.add_modifier.contains(Modifier::ITALIC));
}

#[test]
fn tilde_fences_render_as_code_blocks() {
    // marked accepts `~~~` fences exactly like ```` ``` ```` (same language rule).
    let style = MarkdownStyle::default();
    let rows = render_markdown("~~~\nplain code\n~~~", 40, &style);
    let flat: Vec<String> = rows
        .iter()
        .map(|r| r.iter().map(|s| s.content.as_str()).collect())
        .collect();
    assert_eq!(flat.len(), 1, "rows: {flat:?}");
    assert_eq!(flat[0].trim(), "plain code");
    // The fence rows render in the code_block style, and count==paint holds.
    let code_spans: Vec<&crate::Span> = rows[0]
        .iter()
        .filter(|s| !s.content.trim().is_empty())
        .collect();
    assert!(code_spans.iter().all(|s| s.style.fg == style.code_block.fg));
    for width in 1..40 {
        assert_eq!(
            markdown_row_count("~~~\nplain code\n~~~", width, &style),
            render_markdown("~~~\nplain code\n~~~", width, &style).len(),
            "count==paint at width {width}"
        );
    }
}

#[test]
fn images_render_their_alt_text_only() {
    // marked's image token: the custom TS renderer falls through to the alt text —
    // no `!`, no link affordance, no URL bracket.
    let style = MarkdownStyle::default();
    let rows = render_markdown("An image ![alt text](https://x.dev/i.png) here", 40, &style);
    let flat: String = rows[0].iter().map(|s| s.content.as_str()).collect();
    assert_eq!(flat, "An image alt text here");
    for s in &rows[0] {
        assert!(
            !s.style.add_modifier.contains(Modifier::UNDERLINED),
            "{flat}"
        );
    }
    let spans = render_markdown("![only](https://x.dev/b.png)", 40, &style);
    let flat: String = spans[0].iter().map(|s| s.content.as_str()).collect();
    assert_eq!(flat, "only");
}

#[test]
fn a_bare_hash_renders_an_empty_heading_row() {
    // marked: `#` alone is an h1 with empty text — a blank row plus the
    // heading's trailing spacing.
    let style = MarkdownStyle::default();
    let rows = render_markdown("#\n\nafter", 40, &style);
    let flat: Vec<String> = rows
        .iter()
        .map(|r| r.iter().map(|s| s.content.as_str()).collect())
        .collect();
    assert_eq!(
        flat,
        vec![String::new(), String::new(), "after".to_string()]
    );
}

#[test]
fn a_glued_word_wider_than_the_row_wraps_to_the_next_row() {
    // A glued unit that cannot START on the current row opens a fresh row
    // instead of overflowing it (`abcd` glued to the code span `ef`).
    let style = MarkdownStyle::default();
    let rows = render_markdown("abcd`ef`", 4, &style);
    let flat: Vec<String> = rows
        .iter()
        .map(|r| r.iter().map(|s| s.content.as_str()).collect())
        .collect();
    assert_eq!(flat, vec!["abcd".to_string(), "ef".to_string()]);
    for row in &rows {
        let w: usize = row.iter().map(|s| str_width(&s.content)).sum();
        assert!(w <= 4, "row over the width: {w}");
    }
    for width in 1..12 {
        assert_eq!(
            markdown_row_count("abcd`ef`", width, &style),
            render_markdown("abcd`ef`", width, &style).len(),
            "count==paint at width {width}"
        );
    }
}

#[test]
fn continuation_after_a_nested_list_keeps_source_order() {
    // marked walks an item's block tokens in source order: text, then the
    // nested list, then the continuation text. The item model keeps that
    // order; a lazy soft continuation resumes at column zero in the TS frame.
    let style = MarkdownStyle::default();
    let rows = render_markdown("- parent\n  - child\n  after", 60, &style);
    let flat: Vec<String> = rows
        .iter()
        .map(|r| r.iter().map(|s| s.content.as_str()).collect())
        .collect();
    assert_eq!(
        flat,
        vec![
            "- parent".to_string(),
            "    - child".to_string(),
            "after".to_string(),
        ]
    );
    for width in 1..60 {
        assert_eq!(
            markdown_row_count("- parent\n  - child\n  after", width, &style),
            render_markdown("- parent\n  - child\n  after", width, &style).len(),
            "count==paint at width {width}"
        );
    }
}

#[test]
fn an_underscore_opener_keeps_searching_for_a_closer() {
    // `_foo_bar_`: the first candidate closer is intraword (cannot close),
    // so the opener keeps searching — marked renders em(`foo_bar`).
    let style = MarkdownStyle::default();
    let spans = render_inline("_foo_bar_", &style);
    let joined: String = spans.iter().map(|s| s.content.as_str()).collect();
    assert_eq!(joined, "foo_bar");
    assert!(spans[0].style.add_modifier.contains(Modifier::ITALIC));
    // The intraword rejection still holds when no closer exists.
    let spans = render_inline("snake_case_name", &style);
    let joined: String = spans.iter().map(|s| s.content.as_str()).collect();
    assert_eq!(joined, "snake_case_name");
    for s in &spans {
        assert_eq!(s.style.add_modifier, Modifier::empty());
    }
}

#[test]
fn an_escaped_bang_before_a_link_is_not_an_image() {
    // The image marker is decided from the SOURCE text: `\!` is an escaped
    // bang (literal), not an image marker — the link still renders as a link.
    let style = MarkdownStyle::default();
    crate::hyperlinks::set_hyperlinks_override(Some(false));
    let spans = render_inline(r"Wow\![docs](https://x.dev/a)", &style);
    let joined: String = spans.iter().map(|s| s.content.as_str()).collect();
    assert_eq!(joined, "Wow!docs (https://x.dev/a)");
    assert!(spans
        .iter()
        .any(|s| s.style.add_modifier.contains(Modifier::UNDERLINED)));
    crate::hyperlinks::set_hyperlinks_override(None);
    // An unescaped bang still marks an image: alt text only.
    let spans = render_inline("![alt](https://x.dev/b)", &style);
    let joined: String = spans.iter().map(|s| s.content.as_str()).collect();
    assert_eq!(joined, "alt");
    // An escaped backslash before the bang stays an image marker.
    let spans = render_inline(r"\\![alt](https://x.dev/c)", &style);
    let joined: String = spans.iter().map(|s| s.content.as_str()).collect();
    assert_eq!(joined, "\\alt");
}

/// Text carrying escape sequences and control characters (a model or a tool can emit any of
/// them) paints only its visible characters, in exactly as many cells as `str_width` measures.
#[test]
fn painted_cells_hold_no_control_characters_and_match_the_measured_width() {
    let text = "a\x07b\x08c\x1b[31md\x0be\u{9b}f\x1b[2Jg\x1bch\x1b[?1049li\x1b]0;title\x07j\x1bPq\x1b\\k\x7fl\u{85}m\tn";
    let line: Line = vec![Span::raw(text)];
    let area = ratatui::layout::Rect::new(0, 0, 30, 1);
    let mut buffer = ratatui::buffer::Buffer::empty(area);
    ratatui::widgets::Widget::render(to_ratatui_line(&line), area, &mut buffer);
    let cells: Vec<&str> = (0..area.width).map(|x| buffer[(x, 0)].symbol()).collect();
    assert!(
        cells.iter().all(|cell| !cell.chars().any(char::is_control)),
        "{cells:?}"
    );
    assert_eq!(cells.concat().trim_end(), "abcdefgchijklm   n");
    assert_eq!(str_width(text), "abcdefgchijklm   n".len());
}

/// Screen-clearing and screen-switching sequences inside message text never reach the terminal:
/// the painted bytes hold only the paint's own cursor moves, colors and cursor visibility.
#[test]
fn screen_clearing_sequences_in_message_text_never_reach_the_terminal() {
    #[derive(Clone, Default)]
    struct Sink(std::rc::Rc<std::cell::RefCell<Vec<u8>>>);
    impl std::io::Write for Sink {
        fn write(&mut self, buf: &[u8]) -> std::io::Result<usize> {
            self.0.borrow_mut().extend_from_slice(buf);
            Ok(buf.len())
        }
        fn flush(&mut self) -> std::io::Result<()> {
            Ok(())
        }
    }
    let text = "keep\x1b[2Jone\x1b[3Jtwo\x1bcthree\x1b[?1049lfour";
    let sink = Sink::default();
    let area = ratatui::layout::Rect::new(0, 0, 40, 1);
    let mut terminal = ratatui::Terminal::with_options(
        ratatui::backend::CrosstermBackend::new(sink.clone()),
        ratatui::TerminalOptions {
            viewport: ratatui::Viewport::Fixed(area),
        },
    )
    .unwrap();
    terminal
        .draw(|frame| frame.render_widget(to_ratatui_line(&vec![Span::raw(text)]), area))
        .unwrap();
    let bytes = String::from_utf8(sink.0.borrow().clone()).unwrap();
    let mut visible = String::new();
    let mut rest = bytes.as_str();
    while let Some(c) = rest.chars().next() {
        if let Some(len) = crate::width::escape_len(rest) {
            let sequence = &rest[..len];
            assert!(
                sequence.ends_with('H')
                    || sequence.ends_with('m')
                    || matches!(sequence, "\x1b[?25l" | "\x1b[?25h"),
                "{sequence:?} reached the terminal"
            );
            rest = &rest[len..];
            continue;
        }
        assert!(!c.is_control(), "{c:?} reached the terminal");
        visible.push(c);
        rest = &rest[c.len_utf8()..];
    }
    assert_eq!(visible.trim_end(), "keeponetwocthreefour");
}

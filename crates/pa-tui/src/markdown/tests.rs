use super::*;

/// The pre-fix overlong-word break loop, verbatim from origin/rust
/// (the quadratic re-measure version): the output oracle for
/// [`wrap_spans_into`]'s arithmetic-tracked rewrite. Every corpus below
/// must wrap to byte- and style-identical `Line`s on both algorithms —
/// the rewrite is a complexity fix, never a layout change. The oracle
/// stays quadratic, so differential corpora are bounded (~4KiB
/// tokens); the linear rewrite gets its own unbounded stress test.
fn legacy_wrap_spans_into(spans: &[Span], width: usize, out: &mut geometry::WrapOutput<'_>) {
    if width == 0 {
        for span in spans {
            out.push(&span.content, span.style);
        }
        out.finish_row(/*trim*/ false);
        return;
    }
    // TS `wrapSingleLine` returns a fitting line UNCHANGED (`visibleLength
    // <= width`), so its spacing never re-tokenizes.
    let joined_width: usize = spans.iter().map(|s| str_width(&s.content)).sum();
    if joined_width <= width {
        for span in spans {
            out.push(&span.content, span.style);
        }
        out.finish_row(/*trim*/ false);
        return;
    }
    // tokens: (text, style); alternating words and whitespace-run gaps. TS
    // `splitIntoTokensWithAnsi` keeps each whitespace RUN whole (a run at a
    // span boundary joins the previous gap token), never collapsing it to a
    // single space.
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
            // A wrapped row never carries its trailing gap: TS
            // wrapTextWithAnsi drops the boundary space, so the styled
            // content ends at the last word and the plain padding follows.
            out.finish_row(/*trim*/ true);
            col = 0;
            // drop leading whitespace at the new line start
            if text.trim().is_empty() {
                i += 1;
                continue;
            }
        }
        // break overlong words; escape sequences copy through atomically
        // at zero width (OSC 8 sequences must never split mid-sequence)
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

/// Full-structure parity: every span's content AND style, and the row
/// count the layout caches must equal the rendered rows on both the
/// legacy oracle and the rewrite.
fn assert_wrap_parity(spans: &[Span], widths: &[usize]) {
    for &width in widths {
        let mut legacy: Vec<Line> = Vec::new();
        legacy_wrap_spans(spans, width, &mut legacy);
        let mut current: Vec<Line> = Vec::new();
        wrap_spans(spans, width, Style::default(), &mut current);
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
    // the reviewer's cluster-split repro class (retracted underflow
    // concern; the tentative-exit true measure resyncs the arithmetic):
    // the exact token plus prefixes/suffixes across widths
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
    // ZWJ + skin tone, regional flags, combining and prepending
    // marks, tabs (char_width expands to 3 like str_width), malformed
    // ANSI (a lone ESC, an unterminated CSI), a well-formed OSC 8
    // hyperlink, and multispan styling at span boundaries.
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
    // The rewrite must wrap a 1MiB unbroken token in one linear pass:
    // content round-trips exactly (hard breaks never trim) and the
    // ASCII row count is exact. This test finishes only because the
    // rewrite is linear — the legacy loop needed ~30s for this input
    // (the first-frame transcript blow-up) — but the speed evidence
    // belongs to the recorded benchmark pair, not a wall-clock assert
    // in a deterministic unit test.
    let token = "x".repeat(1 << 20);
    let spans = vec![Span::styled(token.clone(), Style::default())];
    let width = 80usize;
    let mut current: Vec<Line> = Vec::new();
    wrap_spans(&spans, width, Style::default(), &mut current);
    // 1048576 chars at 80 columns: CEIL rows (a floor here fails the
    // 16-char remainder)
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
    // Blank line between blocks: the TS `space` token renders one empty
    // row between them (markdown.ts `case "space"`).
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
    // A heading that fits: one row, the label underlined in the
    // heading color, the bracket in the dim `link_url` slot.
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
    assert_eq!(visible, "docs [https://x.dev/a]");
    // A narrow heading wraps like any row: the bracket — closing `]`
    // included — lands on its own row instead of clipping, and the
    // count==paint row math holds at every width.
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
        vec!["docs".to_string(), "[https://x.dev/a]".to_string()]
    );
    for width in 1..40 {
        assert_eq!(
            markdown_row_count("# [docs](https://x.dev/a)", width, &style),
            render_markdown("# [docs](https://x.dev/a)", width, &style).len(),
            "count==paint at width {width}"
        );
    }
    // The clickable region survives the wrap: the label cells only.
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
fn heading_tapers_code_and_body_that_merely_match_the_link_url_style() {
    // A theme can collide `mdCode`/`mdBody` onto the same color as
    // `mdLinkUrl`; the taper reads the bracket slots by origin, not by
    // style equality, so such spans take the heading color and only a
    // genuine link's bracket keeps the `link_url` slot.
    let mut style = MarkdownStyle::default();
    style.code = style.link_url;
    style.body = style.link_url;
    crate::hyperlinks::set_hyperlinks_override(Some(false));
    let lines = render_markdown("# `c` [d](https://x.dev/a)", 40, &style);
    assert_eq!(
        lines,
        vec![vec![
            Span::styled("c", style.heading),
            Span::styled(" ", style.heading),
            Span::styled("d", style.heading.add_modifier(Modifier::UNDERLINED)),
            Span::styled(" [https://x.dev/a]", style.link_url),
        ]]
    );
    crate::hyperlinks::set_hyperlinks_override(None);
}

#[test]
fn paragraph_keeps_final_line_trailing_whitespace() {
    // The TS lexer's paragraph token carries the block's trailing
    // whitespace (probe vs the TS binary: the expanded compaction
    // summary's last row ends "stream. " with the space inside the
    // styled span). Soft line breaks render one row per line
    // (`applyTextWithNewlines` + the width pass breaks there), so the
    // trailing whitespace rides on the block's LAST rendered row.
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
    // TS ground truth (marked + `applyTextWithNewlines`): the soft
    // newlines survive into the paragraph's rendered string and the
    // width pass breaks there — "one\ntwo" is one paragraph, two rows
    // (verified against the TS product's `?` quick-shortcut guide).
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
    // The TS markdown theme highlights ```python fences through
    // cli-highlight (the same highlight.js pass the expanded ipython
    // cell uses); the fence line's spans carry the syntax palette
    // colors, the indent stays outside them.
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
    // `getLanguage` lowercases; python registers py/gyp/ipython, and
    // marked passes the whole trimmed info string, so an info string
    // with attributes stays uniform.
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

/// The TS-parity cacheability rule: a streaming frame caches the
/// SETTLED blocks (every block but the final one) and never the
/// changing final block.
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

/// The key must cover every `render_block` input: list `ordered`/
/// `start` (the markers are stripped from `block.lines`), the code
/// fence lang, and the following block's trailing-blank decision —
/// a hole would replay one doc's rows under another. One shared
/// cache across all docs, so a collision can actually serve, and
/// each cached render compared against the uncached one.
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
    assert_eq!(texts, vec!["a ", "b", " ", "c", " ", "d", " [http://e]"]);
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
            " [https://x.dev/a]".to_string()
        ]
    );
    // The label underlines on every link render and keeps the body
    // color; the bracket rides in the dim `link_url` slot.
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
    // The OSC 8 region wraps the label (the escape bytes intact, the
    // label underlined); the URL bracket shows after the region,
    // outside it, in the dim `link_url` slot.
    assert_eq!(
        joined,
        format!(
            "see {}docs{} [https://x.dev/a]",
            crate::hyperlinks::osc8_open("https://x.dev/a"),
            crate::hyperlinks::OSC8_CLOSE
        )
    );
    assert!(
        spans[1].style.add_modifier.contains(Modifier::UNDERLINED),
        "the label underlines: {joined}"
    );
    assert_eq!(spans[2].style.fg, style.link_url.fg);
    // The sequences are zero-width: the row measures like the plain
    // text plus the bracketed URL.
    assert_eq!(str_width(&joined), str_width("see docs [https://x.dev/a]"));
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
    // CommonMark link destinations keep balanced parentheses (TS
    // marked's lexer): the destination ends at its own closing `)`, so
    // a Wikipedia-style url renders whole in the bracket and the OSC 8
    // target, with no stray `)` leaking into the text.
    crate::hyperlinks::set_hyperlinks_override(Some(false));
    let style = MarkdownStyle::default();
    let url = "https://en.wikipedia.org/wiki/Function_(mathematics)";
    let spans = render_inline(&format!("[math]({url})"), &style);
    assert_eq!(
        spans,
        vec![
            Span::styled("math", style.body.add_modifier(Modifier::UNDERLINED)),
            Span::styled(format!(" [{url}]"), style.link_url),
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
            Span::styled(format!(" [{url}]"), style.link_url),
        ]
    );
    crate::hyperlinks::set_hyperlinks_override(None);
}

#[test]
fn escaped_parens_never_open_or_close_the_link_destination() {
    // A backslash-escaped paren rides through the destination verbatim
    // without counting toward the paren balance (CommonMark): `\(` does
    // not swallow the real closer, and `\)` alone never closes —
    // `[a](b\)` is plain text, exactly like the reference parser.
    crate::hyperlinks::set_hyperlinks_override(Some(false));
    let style = MarkdownStyle::default();
    let spans = render_inline("[a](b\\(c)", &style);
    assert_eq!(
        spans,
        vec![
            Span::styled("a", style.body.add_modifier(Modifier::UNDERLINED)),
            Span::styled(" [b\\(c]", style.link_url),
        ]
    );
    let plain = render_inline("[a](b\\)", &style);
    assert_eq!(plain.len(), 1);
    assert_eq!(plain[0].content, "[a](b\\)");
    crate::hyperlinks::set_hyperlinks_override(None);
}

#[test]
fn the_url_bracket_scrubs_terminal_control_bytes() {
    // The bracket renders the destination as visible text; a raw escape
    // byte smuggled into an attacker-chosen url must never re-enter the
    // terminal as a live OSC/CSI sequence. The bracket percent-encodes
    // control bytes, the same hardening the OSC 8 target gets through
    // `resolve_link_href`.
    crate::hyperlinks::set_hyperlinks_override(Some(true));
    let style = MarkdownStyle::default();
    let url = "https://x.dev/\u{1b}]52;c;base64";
    let spans = render_inline(&format!("[a]({url})"), &style);
    let bracket = spans.last().expect("bracket span");
    assert_eq!(bracket.content, " [https://x.dev/%1B]52;c;base64]");
    // The bare-url autolink form hardens the same way: the regex tail
    // only excludes whitespace, so the escape byte rides the token's
    // href (the www form's href gains its scheme, so the bracket shows).
    let www = render_inline("www.x.dev/\u{1b}]52;c=base64", &style);
    let bracket = www.last().expect("bracket span");
    assert_eq!(bracket.content, " [http://www.x.dev/%1B]52;c=base64]");
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
    // The bracketed URL is visible text: the width accounting includes
    // it, so the row count and the painted rows agree at every width
    // (the count==paint invariant, the layout math).
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
            "[https://x.dev/a]".to_string(),
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
    // The bracket word is far over the wrap width: it breaks across
    // rows at the width, every row within it.
    assert!(rows.len() >= 4, "rows: {rows:?}");
    for row in &rows {
        let joined: String = row.iter().map(|s| s.content.as_str()).collect();
        assert!(str_width(&joined) <= 12, "row over the width: {joined:?}");
    }
    // The clickable region survives the wrap intact: exactly the label
    // cells link (the escape bytes never split mid-sequence; the
    // bracket part rides outside the region).
    let ranges = crate::hyperlinks::frame_link_ranges(&rows);
    assert_eq!(ranges.len(), 1, "one clickable region: {ranges:?}");
    assert_eq!(ranges[0].row, 0);
    assert_eq!(ranges[0].start_col, 0);
    assert_eq!(ranges[0].end_col, str_width("docs"));
    assert_eq!(ranges[0].url, url);
    // The full URL shows beside the label, across the wrapped rows.
    let visible: String = rows
        .iter()
        .flat_map(|l| l.iter())
        .map(|s| crate::hyperlinks::strip_osc8_content(&s.content))
        .collect();
    // The wrap drops the boundary gap (a wrapped row never carries its
    // leading/trailing space), so the bracket word begins at the row
    // start: `docs` then the bracketed URL across the rows.
    assert_eq!(visible, format!("docs[{url}]"));
    // Count==paint with the long bracket at every wrap width.
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
    // Trailing punctuation is backpedaled out of the link and stays in
    // the text stream.
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
        vec!["www.example.com/path", " [http://www.example.com/path]"]
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
            "{}www.example.com/path{} [http://www.example.com/path]",
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
    assert_eq!(texts, vec!["see https://in.dev/x", " [https://out.dev/y]"]);
    crate::hyperlinks::set_hyperlinks_override(None);
}

#[test]
fn angle_autolink_inside_link_label_yields_the_terminal_ranges() {
    // marked tokenizes angle autolinks even inside an explicit link
    // label (only the gfm bare rule is inLink-guarded), so the TS byte
    // stream carries the outer wrap around a label that itself embeds
    // an inner OSC 8 pair. Terminals keep no region stack: the inner
    // close ends the active region, so the outer label's tail after
    // it is NOT linked - exactly the ranges the frame scan produces
    // (the outer range closes at the inner open, and never resumes).
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
    // Whitespace runs keep their length across spans: TS
    // `splitIntoTokensWithAnsi` holds each run as ONE token and a
    // fitting line passes through unchanged (wrapSingleLine's
    // visibleLength early return) — verified against the TS dist
    // (wrapTextWithAnsi renders "a b   c ...").
    let spans = render_inline("a **b**   c", &style);
    let wrapped = wrap_spans_to_text(&spans, 40);
    assert_eq!(wrapped, "a b   c");
}

fn wrap_spans_to_text(spans: &[Span], width: usize) -> String {
    let mut lines: Vec<Line> = Vec::new();
    wrap_spans(spans, width, Style::default(), &mut lines);
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
    assert_eq!(lines[0][0].content, "▐ ");
    assert_eq!(lines[0][1].content, "wisdom");
}

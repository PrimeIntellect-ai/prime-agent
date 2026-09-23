use super::*;
use ratatui::style::{Color, Style};

#[test]
fn shared_wrap_matches_original_output_and_counts() {
    let corpus = [
        "",
        "a",
        "   ",
        " leading and trailing ",
        "a\nb\n",
        "one\ttwo",
        "界界界",
        "e\u{301} a\u{200d}b",
        "👨‍👩‍👧‍👦 🇯🇵 👍🏽 #️⃣",
        "\u{feff}a b\u{0085}c",
        "\x1b[31mred text\x1b[0m",
        "\x1b]8;;https://example.com\x07link\x1b]8;;\x07",
        "\x1b[broken",
        "longunbreakabletoken",
    ];
    for text in corpus {
        for width in 0..20 {
            let mut variants = vec![vec![Span::raw(text)], Vec::new()];
            for boundary in text
                .char_indices()
                .map(|(index, _)| index)
                .chain(std::iter::once(text.len()))
            {
                variants.push(vec![
                    Span::raw(&text[..boundary]),
                    Span::styled(&text[boundary..], Style::default().fg(Color::Red)),
                ]);
            }
            for line in variants {
                let reference = reference_wrap_line(&line, width);
                assert_eq!(
                    wrap_line(&line, width),
                    reference,
                    "text {text:?}, width {width}"
                );
                assert_eq!(wrapped_line_count(&line, width), reference.len());
                assert_eq!(
                    wrapped_runs_count(line.iter().map(|span| span.content.as_str()), width),
                    reference.len()
                );
            }
            let reference_count: usize = text
                .split('\n')
                .map(|paragraph| reference_wrap_line(&vec![Span::raw(paragraph)], width).len())
                .sum();
            assert_eq!(wrapped_text_count(text, width), reference_count);
            assert_eq!(wrap_text(text, width).len(), reference_count);
        }
    }
}

// Frozen pre-refactor renderer is the independent output oracle.
fn reference_wrap_line(line: &Line, width: usize) -> Vec<Line> {
    if width == 0 {
        return vec![line.clone()];
    }
    if line_width(line) <= width {
        return vec![line.clone()];
    }

    // Tokenize: whitespace runs and non-whitespace runs (styles split too).
    let tokens = tokenize(line);
    let mut wrapped: Vec<Line> = Vec::new();
    let mut current: Line = Vec::new();
    let mut current_width = 0usize;

    for token in &tokens {
        let token_width = line_width(token);
        let is_ws = token
            .iter()
            .all(|s| s.content.chars().all(is_whitespace_char));
        if token_width > width && !is_ws {
            // Flush current line, then hard-break the token.
            if !current.is_empty() {
                wrapped.push(std::mem::take(&mut current));
            }
            let mut chunk: Line = Vec::new();
            let mut chunk_width = 0usize;
            for span in token.iter() {
                for c in span.content.chars() {
                    let w = char_width(c);
                    if chunk_width + w > width {
                        wrapped.push(std::mem::take(&mut chunk));
                        chunk_width = 0;
                    }
                    push_char(&mut chunk, span.style, c);
                    chunk_width += w;
                }
            }
            current = chunk;
            current_width = chunk_width;
            continue;
        }
        if current_width + token_width > width && current_width > 0 {
            let trimmed = trim_end(&current);
            wrapped.push(trimmed);
            current = Vec::new();
            current_width = 0;
            if is_ws {
                continue;
            }
        }
        current.extend(token.iter().cloned());
        current_width += token_width;
    }
    if !current.is_empty() {
        wrapped.push(current);
    }
    if wrapped.is_empty() {
        wrapped.push(Vec::new());
    }
    wrapped
}

fn trim_end(line: &Line) -> Line {
    let mut out = line.clone();
    while let Some(last) = out.last_mut() {
        let trimmed = last.content.trim_end();
        if trimmed.is_empty() {
            out.pop();
        } else {
            last.content = trimmed.to_string();
            break;
        }
    }
    out
}

fn tokenize(line: &Line) -> Vec<Line> {
    let mut tokens: Vec<Line> = Vec::new();
    for span in line {
        let mut current = String::new();
        let mut current_ws: Option<bool> = None;
        for c in span.content.chars() {
            let ws = is_whitespace_char(c);
            match current_ws {
                Some(prev) if prev == ws => current.push(c),
                Some(_) => {
                    tokens.push(vec![Span::styled(std::mem::take(&mut current), span.style)]);
                    current.push(c);
                    current_ws = Some(ws);
                }
                None => {
                    current.push(c);
                    current_ws = Some(ws);
                }
            }
        }
        if !current.is_empty() {
            tokens.push(vec![Span::styled(current, span.style)]);
        }
    }
    tokens
}

//! Shared wrap boundaries for styled output and counts without output row allocation.
use super::{char_width, is_whitespace_char, str_width};
use crate::{Line, Span};
use ratatui::style::Style;

#[derive(Clone, Copy)]
enum Ending {
    Keep,
    Trim,
}

enum Event<'a> {
    Token(&'a str, Style),
    Character(char, Style),
    End(Ending),
}

// Borrow token slices directly from each input span. Span boundaries remain
// token boundaries, matching the original styled-line wrapping behavior.
fn traverse<'a>(
    runs: impl Iterator<Item = (&'a str, Style)>,
    width: usize,
    mut emit: impl FnMut(Event<'a>),
) -> usize {
    let mut rows = 0;
    let mut current_width = 0;
    let mut occupied = false;
    for (text, style) in runs {
        let mut rest = text;
        while !rest.is_empty() {
            let is_ws = is_whitespace_char(rest.chars().next().expect("nonempty token"));
            let end = rest
                .char_indices()
                .find(|(_, c)| is_whitespace_char(*c) != is_ws)
                .map_or(rest.len(), |(index, _)| index);
            let token = &rest[..end];
            rest = &rest[end..];
            let token_width = str_width(token);
            if token_width > width && !is_ws {
                if occupied {
                    emit(Event::End(Ending::Keep));
                    rows += 1;
                }
                current_width = 0;
                for c in token.chars() {
                    let w = char_width(c);
                    if current_width + w > width {
                        emit(Event::End(Ending::Keep));
                        rows += 1;
                        current_width = 0;
                    }
                    emit(Event::Character(c, style));
                    current_width += w;
                }
                occupied = true;
                continue;
            }
            if current_width + token_width > width && current_width > 0 {
                emit(Event::End(Ending::Trim));
                rows += 1;
                occupied = false;
                current_width = 0;
                if is_ws {
                    continue;
                }
            }
            emit(Event::Token(token, style));
            occupied = true;
            current_width += token_width;
        }
    }
    if occupied || rows == 0 {
        emit(Event::End(Ending::Keep));
        rows += 1;
    }
    rows
}

pub(super) fn render(line: &Line, width: usize) -> Vec<Line> {
    if width == 0 || super::line_width(line) <= width {
        return vec![line.clone()];
    }
    let mut rows = Vec::new();
    let mut current = Vec::new();
    traverse(
        line.iter().map(|span| (span.content.as_str(), span.style)),
        width,
        |event| match event {
            Event::Token(text, style) => current.push(Span::styled(text.to_owned(), style)),
            Event::Character(c, style) => super::push_char(&mut current, style, c),
            Event::End(ending) => {
                if matches!(ending, Ending::Trim) {
                    while let Some(last) = current.last_mut() {
                        let trimmed = last.content.trim_end();
                        if trimmed.is_empty() {
                            current.pop();
                        } else {
                            last.content.truncate(trimmed.len());
                            break;
                        }
                    }
                }
                rows.push(std::mem::take(&mut current));
            }
        },
    );
    rows
}

pub(super) fn count_line(line: &Line, width: usize) -> usize {
    if width == 0 || super::line_width(line) <= width {
        return 1;
    }
    traverse(
        line.iter().map(|span| (span.content.as_str(), span.style)),
        width,
        |_| {},
    )
}

pub(super) fn count_text(text: &str, width: usize) -> usize {
    text.split('\n')
        .map(|paragraph| {
            if width == 0 || str_width(paragraph) <= width {
                1
            } else {
                traverse(
                    std::iter::once((paragraph, Style::default())),
                    width,
                    |_| {},
                )
            }
        })
        .sum()
}

pub(super) fn count_runs<'a>(runs: impl IntoIterator<Item = &'a str>, width: usize) -> usize {
    let runs: Vec<&str> = runs.into_iter().collect();
    if width == 0 || runs.iter().map(|run| str_width(run)).sum::<usize>() <= width {
        return 1;
    }
    traverse(
        runs.into_iter().map(|run| (run, Style::default())),
        width,
        |_| {},
    )
}

//! Geometry uses the same wrapping traversal as painted Markdown rows.
use super::{parse_blocks, render_inline, wrapped_span_count, Block, BlockKind, MarkdownStyle};
use crate::{Line, Span};
use ratatui::style::Style;

pub(super) struct WrapOutput<'a> {
    output: Option<&'a mut Vec<Line>>,
    current: Line,
    pub(super) has_content: bool,
    pub(super) rows: usize,
}

impl<'a> WrapOutput<'a> {
    pub(super) fn render(output: &'a mut Vec<Line>) -> Self {
        Self {
            output: Some(output),
            current: Vec::new(),
            has_content: false,
            rows: 0,
        }
    }

    pub(super) fn count() -> Self {
        Self {
            output: None,
            current: Vec::new(),
            has_content: false,
            rows: 0,
        }
    }

    pub(super) fn push(&mut self, text: &str, style: Style) {
        self.has_content = true;
        if self.output.is_some() {
            self.current.push(Span::styled(text.to_owned(), style));
        }
    }

    pub(super) fn finish_row(&mut self, trim: bool) {
        if let Some(output) = &mut self.output {
            if trim {
                while self
                    .current
                    .last()
                    .is_some_and(|span| span.content.trim().is_empty())
                {
                    self.current.pop();
                }
            }
            output.push(std::mem::take(&mut self.current));
        }
        self.has_content = false;
        self.rows += 1;
    }
}

pub(super) fn blank_after(next: Option<&Block>, exclude_lists: bool) -> bool {
    match next {
        Some(next) => {
            !(next.sep_blank || exclude_lists && matches!(next.kind, BlockKind::List { .. }))
        }
        None => false,
    }
}

/// Count rows without painting output buffers or syntax highlighting.
pub(crate) fn markdown_row_count(text: &str, width: usize, style: &MarkdownStyle) -> usize {
    if text.trim().is_empty() {
        return 0;
    }
    let normalized = text.replace('\t', "   ");
    let blocks = parse_blocks(&normalized);
    let width = width.max(1);
    let mut total = 0;
    for (index, block) in blocks.iter().enumerate() {
        let next = blocks.get(index + 1);
        total += usize::from(block.sep_blank);
        let count = match &block.kind {
            BlockKind::Heading => 1 + usize::from(blank_after(next, false)),
            BlockKind::Hr => 1,
            BlockKind::Code { .. } => {
                block.lines.len().max(1) + usize::from(blank_after(next, false))
            }
            BlockKind::Paragraph => {
                block
                    .lines
                    .iter()
                    .map(|text| wrapped_span_count(&render_inline(text, style), width))
                    .sum::<usize>()
                    + usize::from(blank_after(next, true))
            }
            BlockKind::List { ordered, start } => {
                let mut count = 0;
                for (index, text) in block.lines.iter().enumerate() {
                    let bullet = if *ordered {
                        format!("{}. ", start + index)
                    } else {
                        "- ".to_owned()
                    };
                    let content_width = width
                        .saturating_sub(crate::width::str_width(&bullet))
                        .max(1);
                    count += wrapped_span_count(&render_inline(text, style), content_width);
                }
                count + usize::from(blank_after(next, true))
            }
            BlockKind::Quote => block
                .lines
                .iter()
                .map(|text| {
                    wrapped_span_count(&render_inline(text, style), width.saturating_sub(2).max(1))
                })
                .sum(),
            BlockKind::Table { header, rows } => {
                crate::markdown_table::count_table(header, rows, &block.lines, width, style)
                    + usize::from(blank_after(next, false))
            }
        };
        total += count;
    }
    total
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn count_matches_painted_blocks() {
        let style = MarkdownStyle::default();
        let documents = [
            "",
            "   ",
            "# Heading\nparagraph with **bold** and [link](https://example.com)",
            "one  two\n界界👩‍💻 words\n\nnext",
            "```rust\nfn main() {}\n```\ntext",
            "```\n```",
            "- one long item with words\n- second\n\nend",
            "9. long first item\n10. second item\nparagraph",
            "> quoted words words\n> 界界 text",
            "---\n# heading\n\n```\nline\n\n```",
            "a\tb",
            "`code words` *emphasis*",
            "| a | b |\n| --- | --- |\n| long words 界 | c |\n\nparagraph",
            "| a | b |\n| --- | --- |\n# heading",
            "\x1b]8;;https://example.com\x07link\x1b]8;;\x07 tail",
        ];
        for text in documents {
            for width in [0, 1, 2, 3, 7, 19, 80] {
                assert_eq!(
                    super::super::markdown_row_count(text, width, &style),
                    super::super::render_markdown(text, width, &style).len(),
                    "{text:?} width {width}"
                );
            }
        }
    }

    #[test]
    fn counting_wrap_does_not_collect_output_rows() {
        let spans = vec![Span::raw("alpha  beta 界界 gamma"), Span::raw(" trailing")];
        for width in [0, 1, 2, 8, 80] {
            let mut output = WrapOutput::count();
            super::super::wrap_spans_into(&spans, width, &mut output);
            assert!(output.current.is_empty());
            let mut painted = Vec::new();
            super::super::wrap_spans(&spans, width, Style::default(), &mut painted);
            assert_eq!(output.rows, painted.len());
        }
    }
}

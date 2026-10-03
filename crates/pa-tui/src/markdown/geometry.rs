//! Geometry uses the same wrapping traversal as painted Markdown rows.
use super::{
    block_cache_key, code_rows, heading_spans, parse_blocks, render_inline, wrapped_span_count,
    Block, BlockKind, MarkdownBlockCache, MarkdownStyle,
};
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

/// Count rows without collecting the painted rows; fenced code measures
/// the same (highlighted) rows the paint wraps. A non-empty `cache`
/// replays the block's painted rows: the count==paint invariant holds by
/// construction (the cached rows ARE what the render emits for the same
/// key). The cache is only read — a cold cache costs what
/// [`markdown_row_count`] costs.
pub(crate) fn markdown_row_count_tagged(
    text: &str,
    width: usize,
    style: &MarkdownStyle,
    style_tag: &str,
    cache: &MarkdownBlockCache,
) -> usize {
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
        // The key build clones the block's lines, so an empty cache skips
        // it for the count-only callers.
        let cached = (!cache.0.is_empty())
            .then(|| block_cache_key(style_tag, &blocks, index, width))
            .flatten()
            .and_then(|key| cache.0.get(&key));
        if let Some(rows) = cached {
            total += rows.len();
            continue;
        }
        let count = match &block.kind {
            BlockKind::Heading => {
                let text = block.lines.first().cloned().unwrap_or_default();
                wrapped_span_count(&heading_spans(&text, style), width)
                    + usize::from(blank_after(next, false))
            }
            BlockKind::Hr => 1,
            BlockKind::Code { lang } => {
                code_rows(block, lang.as_deref(), style)
                    .iter()
                    .map(|row| wrapped_span_count(row, width))
                    .sum::<usize>()
                    + usize::from(blank_after(next, false))
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

/// The count-only callers' path: no cache, no replays.
pub(crate) fn markdown_row_count(text: &str, width: usize, style: &MarkdownStyle) -> usize {
    markdown_row_count_tagged(text, width, style, "", &MarkdownBlockCache::default())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn counting_wrap_does_not_collect_output_rows() {
        let spans = vec![Span::raw("alpha  beta 界界 gamma"), Span::raw(" trailing")];
        for width in [0, 1, 2, 8, 80] {
            let mut output = WrapOutput::count();
            super::super::wrap_spans_into(&spans, width, &mut output);
            assert!(output.current.is_empty());
        }
    }
}

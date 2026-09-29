use super::MarkdownStyle;
use crate::{Line, Span};
use ratatui::style::Modifier;
/// Inline rendering: bold, italic, strikethrough, code, links.
pub fn render_inline(text: &str, style: &MarkdownStyle) -> Line {
    render_inline_ctx(text, style, false)
}

/// `in_link` mirrors marked's `lexer.state.inLink`: set while a link
/// label's tokens are produced, and the gfm bare-url rule is skipped
/// inside one (the angle `autolink` rule is not).
fn render_inline_ctx(text: &str, style: &MarkdownStyle, in_link: bool) -> Line {
    let mut spans: Vec<Span> = Vec::new();
    let bytes: Vec<char> = text.chars().collect();
    // Byte offset per char index: the autolink rules run on a slice of the
    // original text (zero-copy) instead of a copy of the remaining tail,
    // so a candidate-heavy line stays linear in its attempts.
    let byte_offsets: Vec<usize> = text.char_indices().map(|(b, _)| b).collect();
    let mut buf = String::new();
    let mut i = 0usize;
    let base = style.body;
    let mut bold = false;
    let mut italic = false;
    let strike = false;
    // The bare-url email alternative only exists when the line carries an
    // `@` at all; the gate keeps the per-position regex attempts rare.
    let line_has_at = bytes.contains(&'@');
    // `bare_candidate` gates every autolink attempt on the literal prefix
    // the marked rules require, so the attempt regexes only ever run on
    // actual urls/emails - plain text (even `history history ...` floods
    // of `h` starts) never reaches the regex or the tail-string copy.

    macro_rules! flush {
        () => {
            if !buf.is_empty() {
                let mut m = Modifier::empty();
                if bold {
                    m |= style.bold;
                }
                if italic {
                    m |= style.italic;
                }
                if strike {
                    m |= style.strikethrough;
                }
                spans.push(Span::styled(std::mem::take(&mut buf), base.add_modifier(m)));
            }
        };
    }

    while i < bytes.len() {
        let c = bytes[i];
        // inline code
        if c == '`' {
            let mut j = i + 1;
            let mut code = String::new();
            while j < bytes.len() && bytes[j] != '`' {
                code.push(bytes[j]);
                j += 1;
            }
            if j < bytes.len() {
                flush!();
                spans.push(Span::styled(code, style.code));
                i = j + 1;
                continue;
            }
        }
        // links [text](url)
        if c == '[' {
            let mut j = i + 1;
            let mut label = String::new();
            while j < bytes.len() && bytes[j] != ']' {
                label.push(bytes[j]);
                j += 1;
            }
            if j + 1 < bytes.len() && bytes[j] == ']' && bytes[j + 1] == '(' {
                let mut k = j + 2;
                let mut url = String::new();
                while k < bytes.len() && bytes[k] != ')' {
                    url.push(bytes[k]);
                    k += 1;
                }
                if k < bytes.len() {
                    flush!();
                    let mut m = Modifier::empty();
                    if bold {
                        m |= style.bold;
                    }
                    if italic {
                        m |= style.italic;
                    }
                    // The observed TS binary output (0.9.5, the parity ground
                    // truth) renders the link label with the body color only:
                    // the link color is shadowed by the body color applied
                    // inside the label, and the underline wrapper never
                    // reaches the wire. `m` carries the emphasis context.
                    let href = crate::hyperlinks::resolve_link_href(&url);
                    let mut label_spans = render_inline_ctx(&label, style, true);
                    for s in &mut label_spans {
                        s.style = s.style.add_modifier(m);
                    }
                    if crate::hyperlinks::hyperlinks_enabled() {
                        // OSC 8: the label is clickable, the URL never
                        // printed inline (TS `hyperlink()`).
                        let open = crate::hyperlinks::osc8_open(&href);
                        if let Some(first) = label_spans.first_mut() {
                            first.content.insert_str(0, &open);
                        }
                        if let Some(last) = label_spans.last_mut() {
                            last.content.push_str(crate::hyperlinks::OSC8_CLOSE);
                        }
                        spans.extend(label_spans);
                    } else {
                        spans.extend(label_spans);
                        // Legacy form: the URL shows after the text unless
                        // the label is the URL (mailto stripped for the
                        // comparison, like autolinked emails).
                        let comparison = url.strip_prefix("mailto:").unwrap_or(url.as_str());
                        if label != url && label != comparison {
                            spans.push(Span::styled(format!(" ({url})"), style.link_url));
                        }
                    }
                    i = k + 1;
                    continue;
                }
            }
        }
        // emphasis
        if (c == '*' || c == '_') && i + 1 < bytes.len() {
            let is_triple = i + 2 < bytes.len() && bytes[i + 1] == c && bytes[i + 2] == c;
            if is_triple {
                if let Some(close) = find_closing(&bytes, i + 3, c, 3) {
                    flush!();
                    bold = !bold;
                    italic = !italic;
                    let inner: String = bytes[i + 3..close].iter().collect();
                    spans.push(Span::styled(
                        inner,
                        base.add_modifier(style.bold | style.italic),
                    ));
                    bold = !bold;
                    italic = !italic;
                    i = close + 3;
                    continue;
                }
            }
            let doubled = i + 1 < bytes.len() && bytes[i + 1] == c;
            let (len, close_search) = if doubled { (2, i + 2) } else { (1, i + 1) };
            if let Some(close) = find_closing(&bytes, close_search, c, len) {
                let inner: String = bytes[close_search..close].iter().collect();
                if inner.trim().is_empty() {
                    buf.push(c);
                    i += 1;
                    continue;
                }
                flush!();
                if doubled {
                    bold = !bold;
                    let mut inner_spans = render_inline_ctx(&inner, style, in_link);
                    for s in &mut inner_spans {
                        s.style = s.style.add_modifier(style.bold);
                    }
                    spans.extend(inner_spans);
                    bold = !bold;
                } else {
                    italic = !italic;
                    let mut inner_spans = render_inline_ctx(&inner, style, in_link);
                    for s in &mut inner_spans {
                        s.style = s.style.add_modifier(style.italic);
                    }
                    spans.extend(inner_spans);
                    italic = !italic;
                }
                i = close + len;
                continue;
            }
        }
        if c == '~' && i + 1 < bytes.len() && bytes[i + 1] == '~' {
            if let Some(close) = find_closing(&bytes, i + 2, '~', 2) {
                let inner: String = bytes[i + 2..close].iter().collect();
                if !inner.trim().is_empty() {
                    flush!();
                    let mut inner_spans = render_inline_ctx(&inner, style, in_link);
                    for s in &mut inner_spans {
                        s.style = s.style.add_modifier(style.strikethrough);
                    }
                    spans.extend(inner_spans);
                    i = close + 2;
                    continue;
                }
            }
        }
        // marked inline `autolink` (angle form) then `url` (gfm bare
        // links): the last two inline rules, tried once every other
        // construct failed at this position. The two rules are disjoint on
        // their first character, so the order collapses to this split.
        let autolink_hit = if c == '<' {
            autolink_token_at(&text[byte_offsets[i]..], true)
        } else if !in_link && crate::autolink::bare_candidate(&bytes, i, line_has_at) {
            autolink_token_at(&text[byte_offsets[i]..], false)
        } else {
            None
        };
        if let Some(token) = autolink_hit {
            flush!();
            // The token carries one plain text token, so the label is a
            // single body-colored run carrying the current emphasis (the
            // theme.link/underline wrapper never reaches the wire in the
            // deployed binary, like explicit link labels).
            let mut m = Modifier::empty();
            if bold {
                m |= style.bold;
            }
            if italic {
                m |= style.italic;
            }
            let label = Span::styled(token.text.clone(), base.add_modifier(m));
            if crate::hyperlinks::hyperlinks_enabled() {
                // OSC 8: the label is clickable, the URL never printed
                // inline (TS `hyperlink()`).
                let href = crate::hyperlinks::resolve_link_href(&token.href);
                let mut content = label.content;
                content.insert_str(0, &crate::hyperlinks::osc8_open(&href));
                content.push_str(crate::hyperlinks::OSC8_CLOSE);
                spans.push(Span::styled(content, label.style));
            } else {
                spans.push(label);
                // Legacy form: the URL shows after the label unless the
                // label already is it (mailto stripped), TS token.href.
                let comparison = token.href.strip_prefix("mailto:").unwrap_or(&token.href);
                if token.text != token.href && token.text != comparison {
                    spans.push(Span::styled(format!(" ({})", token.href), style.link_url));
                }
            }
            i += token.raw.chars().count();
            continue;
        }
        buf.push(c);
        i += 1;
    }
    flush!();
    if spans.is_empty() {
        spans.push(Span::raw(""));
    }
    spans
}

/// Run the marked autolink rules on the text starting at `rest` (the
/// caller's slice of the original line, so no per-candidate tail copy;
/// `angle` selects the `<...>` rule, otherwise the gfm bare-url rule).
/// Returns the token; the caller advances by its `raw` char count.
fn autolink_token_at(rest: &str, angle: bool) -> Option<crate::autolink::AutolinkToken> {
    if angle {
        crate::autolink::angle_token(rest)
    } else {
        crate::autolink::bare_token(rest)
    }
}

fn find_closing(chars: &[char], from: usize, delim: char, len: usize) -> Option<usize> {
    let mut i = from;
    while i + len <= chars.len() {
        if (0..len).all(|k| chars[i + k] == delim) {
            return Some(i);
        }
        i += 1;
    }
    None
}

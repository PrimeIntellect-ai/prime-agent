use super::MarkdownStyle;
use crate::{Line, Span};
use ratatui::style::Modifier;
/// Inline rendering: bold, italic, strikethrough, code, links.
#[must_use]
pub fn render_inline(text: &str, style: &MarkdownStyle) -> Line {
    render_inline_with_url_slots(text, style).0
}

/// The same inline render, plus the `link_url` slot indices: which
/// spans of the returned line carry a link's `[url]` bracket, in
/// ascending span order. Style-tapering callers (headings) preserve
/// those spans by origin — a code or body span that merely renders in
/// the `link_url` style (a theme whose colors collide) is not a slot
/// and tapers like any other span.
#[must_use]
pub(crate) fn render_inline_with_url_slots(
    text: &str,
    style: &MarkdownStyle,
) -> (Line, Vec<usize>) {
    render_inline_ctx(text, style, false)
}

/// `in_link` mirrors marked's `lexer.state.inLink`: set while a link
/// label's tokens are produced, and the gfm bare-url rule is skipped
/// inside one (the angle `autolink` rule is not). The second return
/// half lists the `[url]` bracket indices inside the returned spans,
/// remapped across every recursive extend.
fn render_inline_ctx(text: &str, style: &MarkdownStyle, in_link: bool) -> (Line, Vec<usize>) {
    let mut spans: Vec<Span> = Vec::new();
    let mut url_slots: Vec<usize> = Vec::new();
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
                let mut modifier = Modifier::empty();
                if bold {
                    modifier |= style.bold;
                }
                if italic {
                    modifier |= style.italic;
                }
                if strike {
                    modifier |= style.strikethrough;
                }
                spans.push(Span::styled(
                    std::mem::take(&mut buf),
                    base.add_modifier(modifier),
                ));
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
                // CommonMark link destination: parentheses ride only as
                // a balanced pair (TS marked's lexer), so the destination
                // ends at the `)` that closes it — not at the first `)`
                // inside, which a Wikipedia-style url carries. A
                // backslash-escaped char rides through verbatim and
                // never counts toward the balance either (so `\(` does
                // not swallow the real closer); unescaping stays out of
                // this port's inline subset.
                let mut paren_depth = 0usize;
                while k < bytes.len() {
                    if bytes[k] == ')' && paren_depth == 0 {
                        break;
                    }
                    if bytes[k] == '\\' && k + 1 < bytes.len() {
                        url.push(bytes[k]);
                        k += 1;
                        url.push(bytes[k]);
                        k += 1;
                        continue;
                    }
                    if bytes[k] == '(' {
                        paren_depth += 1;
                    } else if bytes[k] == ')' {
                        paren_depth -= 1;
                    }
                    url.push(bytes[k]);
                    k += 1;
                }
                if k < bytes.len() {
                    flush!();
                    let mut modifier = Modifier::empty();
                    if bold {
                        modifier |= style.bold;
                    }
                    if italic {
                        modifier |= style.italic;
                    }
                    // The label renders underlined (the standard
                    // terminal link affordance); `modifier` carries the
                    // emphasis context.
                    let href = crate::hyperlinks::resolve_link_href(&url);
                    let (mut label_spans, mut label_slots) = render_inline_ctx(&label, style, true);
                    for s in &mut label_spans {
                        s.style = s.style.add_modifier(modifier | Modifier::UNDERLINED);
                    }
                    if crate::hyperlinks::hyperlinks_enabled() {
                        // OSC 8: the label stays clickable (TS `hyperlink()`).
                        let open = crate::hyperlinks::osc8_open(&href);
                        if let Some(first) = label_spans.first_mut() {
                            first.content.insert_str(0, &open);
                        }
                        if let Some(last) = label_spans.last_mut() {
                            last.content.push_str(crate::hyperlinks::OSC8_CLOSE);
                        }
                    }
                    let offset = spans.len();
                    for slot in &mut label_slots {
                        *slot += offset;
                    }
                    url_slots.append(&mut label_slots);
                    spans.extend(label_spans);
                    // The URL rides beside every link, in both the OSC 8
                    // and legacy forms — after the wrap, so the region
                    // covers the label only — in the dim `link_url` slot,
                    // unless the label already is the URL (mailto stripped
                    // for the comparison, like autolinked emails).
                    let comparison = url.strip_prefix("mailto:").unwrap_or(url.as_str());
                    if label != url && label != comparison {
                        // The bracket renders the destination as visible
                        // text, so it gets the same control-byte hardening
                        // the OSC 8 target gets (`resolve_link_href`): an
                        // escape byte smuggled into an attacker-chosen url
                        // can never re-enter the terminal as a live
                        // OSC/CSI sequence.
                        let shown = crate::hyperlinks::sanitize_control_bytes(url.clone());
                        url_slots.push(spans.len());
                        spans.push(Span::styled(format!(" [{shown}]"), style.link_url));
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
                    let (mut inner_spans, mut inner_slots) =
                        render_inline_ctx(&inner, style, in_link);
                    let offset = spans.len();
                    for slot in &mut inner_slots {
                        *slot += offset;
                    }
                    url_slots.append(&mut inner_slots);
                    for s in &mut inner_spans {
                        s.style = s.style.add_modifier(style.bold);
                    }
                    spans.extend(inner_spans);
                    bold = !bold;
                } else {
                    italic = !italic;
                    let (mut inner_spans, mut inner_slots) =
                        render_inline_ctx(&inner, style, in_link);
                    let offset = spans.len();
                    for slot in &mut inner_slots {
                        *slot += offset;
                    }
                    url_slots.append(&mut inner_slots);
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
                    let (mut inner_spans, mut inner_slots) =
                        render_inline_ctx(&inner, style, in_link);
                    let offset = spans.len();
                    for slot in &mut inner_slots {
                        *slot += offset;
                    }
                    url_slots.append(&mut inner_slots);
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
            // theme.link color never reaches the wire, like explicit link
            // labels).
            let mut m = Modifier::empty();
            if bold {
                m |= style.bold;
            }
            if italic {
                m |= style.italic;
            }
            // Every link render underlines (the standard link
            // affordance), both capability forms.
            let mut label = Span::styled(
                token.text.clone(),
                base.add_modifier(m | Modifier::UNDERLINED),
            );
            if crate::hyperlinks::hyperlinks_enabled() {
                let href = crate::hyperlinks::resolve_link_href(&token.href);
                label
                    .content
                    .insert_str(0, &crate::hyperlinks::osc8_open(&href));
                label.content.push_str(crate::hyperlinks::OSC8_CLOSE);
            }
            spans.push(label);
            // The URL rides beside the label in the dim `link_url` slot
            // unless the label already shows it (the mailto-stripped
            // comparison, TS token.href). The bare-url regex tail only
            // excludes whitespace, so an escape byte can ride a bare
            // url token's href into this visible span — the bracket gets
            // the same control-byte hardening the OSC 8 target gets.
            let comparison = token.href.strip_prefix("mailto:").unwrap_or(&token.href);
            if token.text != token.href && token.text != comparison {
                let shown = crate::hyperlinks::sanitize_control_bytes(token.href.clone());
                url_slots.push(spans.len());
                spans.push(Span::styled(format!(" [{shown}]"), style.link_url));
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
    (spans, url_slots)
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

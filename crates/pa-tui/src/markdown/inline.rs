use super::MarkdownStyle;
use crate::{Line, Span};
use ratatui::style::Modifier;
/// Inline rendering: bold, italic, strikethrough, code, links.
#[must_use]
pub fn render_inline(text: &str, style: &MarkdownStyle) -> Line {
    render_inline_tracked(text, style).0
}

/// The same inline render, plus origin tracking: which spans of the returned line
/// carry a link's `(url)` bracket (`url_slots`; the bracket only renders without
/// OSC 8 support) and which are inline-code spans (`code_slots`), in ascending span
/// order. Style-tapering callers (headings, quotes) preserve those spans by origin —
/// a span that merely renders in the same style is not a slot.
#[must_use]
pub(crate) fn render_inline_tracked(
    text: &str,
    style: &MarkdownStyle,
) -> (Line, Vec<usize>, Vec<usize>) {
    render_inline_ctx(text, style, false)
}

/// `in_link` mirrors marked's `lexer.state.inLink`: the gfm bare-url rule is
/// skipped inside a link label's tokens (the angle `autolink` rule is not).
/// Returns the `(url)`-bracket and inline-code span indices, remapped across every
/// recursive extend.
fn render_inline_ctx(
    text: &str,
    style: &MarkdownStyle,
    in_link: bool,
) -> (Line, Vec<usize>, Vec<usize>) {
    let mut spans: Vec<Span> = Vec::new();
    let mut url_slots: Vec<usize> = Vec::new();
    let mut code_slots: Vec<usize> = Vec::new();
    let bytes: Vec<char> = text.chars().collect();
    // Byte offset per char index: the autolink rules run on a slice of the original text, so a
    // candidate-heavy line stays linear in its attempts.
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
    // `bare_candidate` gates every autolink attempt on the literal prefix the marked
    // rules require, so the attempt regexes only ever run on actual urls/emails.

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
        // marked's escape rule: a backslash before ASCII punctuation consumes the
        // backslash, so the punctuation never opens a construct.
        if c == '\\' && i + 1 < bytes.len() && bytes[i + 1].is_ascii_punctuation() {
            buf.push(bytes[i + 1]);
            i += 2;
            continue;
        }
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
                code_slots.push(spans.len());
                spans.push(Span::styled(code, style.code));
                i = j + 1;
                continue;
            }
        }
        // links: [text](url)
        if c == '[' {
            let mut j = i + 1;
            let mut label = String::new();
            while j < bytes.len() && bytes[j] != ']' {
                label.push(bytes[j]);
                j += 1;
            }
            let mut parsed = None;
            if j < bytes.len() && bytes[j] == ']' && j + 1 < bytes.len() && bytes[j + 1] == '(' {
                parsed = link_destination(&bytes, j + 2);
            }
            if let Some((url, k)) = parsed {
                // An image (`![alt](url)`): marked's image token falls through to the
                // alt text in the TS renderer — no `!`, no link affordance, no bracket.
                // The marker is read from the SOURCE: an escaped `\!` is a literal
                // bang, not an image marker (an odd backslash run escapes it).
                let image = image_marker_before(&bytes, i);
                let mut modifier = Modifier::empty();
                if bold {
                    modifier |= style.bold;
                }
                if italic {
                    modifier |= style.italic;
                }
                if image {
                    buf.pop();
                    flush!();
                    spans.push(Span::styled(label, base.add_modifier(modifier)));
                    i = k + 1;
                    continue;
                }
                flush!();
                // The label renders underlined (the standard
                // terminal link affordance); `modifier` carries the
                // emphasis context.
                let href = crate::hyperlinks::resolve_link_href_with_base(
                    &url,
                    style.link_base_url.as_ref(),
                );
                let (label_spans, label_slots, label_codes) =
                    render_inline_ctx(&label, style, true);
                let mut label_spans = label_spans;
                {
                    // OSC 8: the label stays clickable (TS `hyperlink()`).
                    let open = crate::hyperlinks::osc8_open(&href);
                    if let Some(first) = label_spans.first_mut() {
                        first.content.insert_str(0, &open);
                    }
                    if let Some(last) = label_spans.last_mut() {
                        last.content.push_str(crate::hyperlinks::OSC8_CLOSE);
                    }
                }
                append_inner(
                    &mut spans,
                    &mut url_slots,
                    &mut code_slots,
                    (label_spans, label_slots, label_codes),
                    modifier | Modifier::UNDERLINED,
                );
                // Without OSC 8 support the URL rides after the wrap (the OSC 8
                // region covers the label only), in the dim `link_url` slot unless
                // the label already is the URL (mailto stripped for the comparison).
                // A hyperlink-capable terminal shows the clickable label alone.
                let comparison = url.strip_prefix("mailto:").unwrap_or(url.as_str());
                if !crate::hyperlinks::hyperlinks_enabled() && label != url && label != comparison {
                    // The bracket renders the destination as visible text, so it
                    // gets the same control-byte hardening as the OSC 8 target: a
                    // smuggled escape byte can never re-enter the terminal live.
                    let shown = crate::hyperlinks::sanitize_control_bytes(url.clone());
                    url_slots.push(spans.len());
                    spans.push(Span::styled(format!(" ({shown})"), style.link_url));
                }
                i = k + 1;
                continue;
            }
        }
        // emphasis
        if (c == '*' || c == '_') && i + 1 < bytes.len() {
            // CommonMark flanking for `_`: a delimiter between word characters
            // can neither open nor close emphasis (snake_case prose keeps its
            // underscores); `*` has no intraword restriction.
            if c == '_' && !underscore_can_open(&bytes, i) {
                buf.push(c);
                i += 1;
                continue;
            }
            let is_triple = i + 2 < bytes.len() && bytes[i + 1] == c && bytes[i + 2] == c;
            if is_triple {
                if let Some(close) = find_closing(&bytes, i + 3, c, 3) {
                    flush!();
                    bold = !bold;
                    italic = !italic;
                    let inner: String = bytes[i + 3..close].iter().collect();
                    append_inner(
                        &mut spans,
                        &mut url_slots,
                        &mut code_slots,
                        render_inline_ctx(&inner, style, in_link),
                        style.bold | style.italic,
                    );
                    bold = !bold;
                    italic = !italic;
                    i = close + 3;
                    continue;
                }
            }
            let doubled = i + 1 < bytes.len() && bytes[i + 1] == c;
            let (len, close_search) = if doubled { (2, i + 2) } else { (1, i + 1) };
            // An intraword `_` cannot close, but the opener still matches a
            // later one — keep searching instead of giving up.
            let mut close = find_closing(&bytes, close_search, c, len);
            while close.is_some_and(|k| c == '_' && !underscore_can_close(&bytes, k, len)) {
                let resume = close.expect("checked Some") + len;
                close = find_closing(&bytes, resume, c, len);
            }
            if let Some(close) = close {
                if doubled {
                    // A closer run of three (`**outer *inner***`): the extra star
                    // pairs with the inner single delimiter, the outer keeps the
                    // last two — marked renders bold(outer + italic(inner)).
                    let run = run_length(&bytes, close, c);
                    // Only an unmatched inner opener owns that third closer. A
                    // completed *inner* pair (or a star inside code) cannot steal
                    // the opener of the following adjacent emphasis span.
                    let mut nested_opener = false;
                    let mut nested_opener_right_flanking = false;
                    let mut at = close_search;
                    while at < close {
                        if bytes[at] == '\\'
                            && bytes.get(at + 1).is_some_and(char::is_ascii_punctuation)
                        {
                            at += 2;
                            continue;
                        }
                        if bytes[at] == '`' {
                            let end = (at + 1..close).find(|&k| bytes[k] == '`');
                            if let Some(end) = end {
                                at = end + 1;
                                continue;
                            }
                        }
                        if bytes[at] == c {
                            let length = run_length(&bytes, at, c);
                            if length == 1 {
                                let can_open =
                                    bytes.get(at + 1).is_some_and(|next| !next.is_whitespace())
                                        && (c != '_' || underscore_can_open(&bytes, at));
                                let can_close = at > 0
                                    && !bytes[at - 1].is_whitespace()
                                    && (!bytes[at - 1].is_ascii_punctuation()
                                        || bytes.get(at + 1).is_none_or(|next| {
                                            next.is_whitespace() || next.is_ascii_punctuation()
                                        }))
                                    && (c != '_' || underscore_can_close(&bytes, at, 1));
                                if nested_opener && can_close {
                                    nested_opener = false;
                                } else if !nested_opener && can_open {
                                    nested_opener = true;
                                    nested_opener_right_flanking = can_close;
                                }
                            }
                            at += length;
                        } else {
                            at += 1;
                        }
                    }
                    if run == 3 && nested_opener {
                        let inner: String = bytes[close_search..=close].iter().collect();
                        if !inner.trim().is_empty() {
                            flush!();
                            bold = !bold;
                            append_inner(
                                &mut spans,
                                &mut url_slots,
                                &mut code_slots,
                                render_inline_ctx(&inner, style, in_link),
                                style.bold,
                            );
                            bold = !bold;
                            i = close + 3;
                            continue;
                        }
                    }
                    if run == 2 && nested_opener && !nested_opener_right_flanking {
                        // Marked pairs an unmatched inner single opener with the
                        // first closer: the outside becomes literal '*' + em,
                        // not strong. Actual TS: **a\**b** => '*' + italic(a*b).
                        buf.push(c);
                        flush!();
                        let inner: String = bytes[close_search..=close].iter().collect();
                        append_inner(
                            &mut spans,
                            &mut url_slots,
                            &mut code_slots,
                            render_inline_ctx(&inner, style, in_link),
                            style.italic,
                        );
                        i = close + 2;
                        continue;
                    }
                }
                let inner: String = bytes[close_search..close].iter().collect();
                if inner.trim().is_empty() {
                    buf.push(c);
                    i += 1;
                    continue;
                }
                flush!();
                if doubled {
                    bold = !bold;
                    append_inner(
                        &mut spans,
                        &mut url_slots,
                        &mut code_slots,
                        render_inline_ctx(&inner, style, in_link),
                        style.bold,
                    );
                    bold = !bold;
                } else {
                    italic = !italic;
                    append_inner(
                        &mut spans,
                        &mut url_slots,
                        &mut code_slots,
                        render_inline_ctx(&inner, style, in_link),
                        style.italic,
                    );
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
                    append_inner(
                        &mut spans,
                        &mut url_slots,
                        &mut code_slots,
                        render_inline_ctx(&inner, style, in_link),
                        style.strikethrough,
                    );
                    i = close + 2;
                    continue;
                }
            }
        }
        // marked inline `autolink` (angle form) then `url` (gfm bare links): the last two
        // inline rules, tried once every other construct failed. The two rules are
        // disjoint on their first character, so the order collapses to this split.
        let autolink_hit = if c == '<' {
            autolink_token_at(&text[byte_offsets[i]..], true)
        } else if !in_link && crate::autolink::bare_candidate(&bytes, i, line_has_at) {
            autolink_token_at(&text[byte_offsets[i]..], false)
        } else {
            None
        };
        if let Some(token) = autolink_hit {
            flush!();
            // The token is one plain text token, so the label is a single
            // body-colored run carrying the current emphasis (theme.link never
            // reaches the wire).
            let mut m = Modifier::empty();
            if bold {
                m |= style.bold;
            }
            if italic {
                m |= style.italic;
            }
            // Every link render underlines, both capability forms.
            let mut label = Span::styled(
                token.text.clone(),
                base.add_modifier(m | Modifier::UNDERLINED),
            );
            {
                let href = crate::hyperlinks::resolve_link_href_with_base(
                    &token.href,
                    style.link_base_url.as_ref(),
                );
                label
                    .content
                    .insert_str(0, &crate::hyperlinks::osc8_open(&href));
                label.content.push_str(crate::hyperlinks::OSC8_CLOSE);
            }
            spans.push(label);
            // Without OSC 8 support the URL rides beside the label in the dim
            // `link_url` slot unless the label already shows it (mailto-stripped
            // comparison). The bare-url regex tail only excludes whitespace, so the
            // bracket gets the same hardening as the OSC 8 target.
            let comparison = token.href.strip_prefix("mailto:").unwrap_or(&token.href);
            if !crate::hyperlinks::hyperlinks_enabled()
                && token.text != token.href
                && token.text != comparison
            {
                let shown = crate::hyperlinks::sanitize_control_bytes(token.href.clone());
                url_slots.push(spans.len());
                spans.push(Span::styled(format!(" ({shown})"), style.link_url));
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
    (spans, url_slots, code_slots)
}

/// True when the `!` immediately before the `[` at `at` is an image marker:
/// an even run of backslashes precedes it (an escaped `!` is a literal bang).
fn image_marker_before(bytes: &[char], at: usize) -> bool {
    if at == 0 || bytes[at - 1] != '!' {
        return false;
    }
    let mut backslashes = 0usize;
    let mut j = at - 1;
    while j > 0 && bytes[j - 1] == '\\' {
        backslashes += 1;
        j -= 1;
    }
    backslashes.is_multiple_of(2)
}

/// Recurse into one inline construct's inner text and merge the result into the
/// outer span stream: the tracked slots remap across the extend, and the
/// construct's own modifier applies on top of the inner styles.
fn append_inner(
    outer: &mut Vec<Span>,
    url_slots: &mut Vec<usize>,
    code_slots: &mut Vec<usize>,
    inner: (Line, Vec<usize>, Vec<usize>),
    modifier: Modifier,
) {
    let (mut spans, mut slots, mut codes) = inner;
    let offset = outer.len();
    for slot in &mut slots {
        *slot += offset;
    }
    for slot in &mut codes {
        *slot += offset;
    }
    url_slots.append(&mut slots);
    code_slots.append(&mut codes);
    for s in &mut spans {
        s.style = s.style.add_modifier(modifier);
    }
    outer.extend(spans);
}

/// The `CommonMark` inline-link destination after `[label](` (marked's link rule):
/// parens ride as a balanced pair (the destination ends at its own `)`, not the
/// first one inside), escaped punctuation consumes its backslash, and the destination stops at
/// whitespace — a quoted title may follow before the closing paren. Returns the
/// destination and the index of the closing `)`.
fn link_destination(bytes: &[char], from: usize) -> Option<(String, usize)> {
    let mut k = from;
    while k < bytes.len() && (bytes[k] == ' ' || bytes[k] == '\t') {
        k += 1;
    }
    let mut url = String::new();
    let mut paren_depth = 0usize;
    while k < bytes.len() {
        let b = bytes[k];
        if b == ')' && paren_depth == 0 {
            return Some((url, k));
        }
        if b == ' ' || b == '\t' {
            // Pinned TS/marked accepts an unmatched '(' before a quoted title;
            // its actual frame still links foo(bar in [t](foo(bar "title").
            // Preserve that product behavior rather than imposing a stricter parser.
            break;
        }
        if b == '\\' && bytes.get(k + 1).is_some_and(char::is_ascii_punctuation) {
            k += 1;
            url.push(bytes[k]);
            k += 1;
            continue;
        }
        if b == '(' {
            paren_depth += 1;
        } else if b == ')' {
            paren_depth = paren_depth.saturating_sub(1);
        }
        url.push(b);
        k += 1;
    }
    while k < bytes.len() && (bytes[k] == ' ' || bytes[k] == '\t') {
        k += 1;
    }
    if k < bytes.len() && (bytes[k] == '"' || bytes[k] == '\'') {
        let quote = bytes[k];
        k += 1;
        while k < bytes.len() && bytes[k] != quote {
            // An escaped quote belongs to the title, not its closing delimiter.
            k += if bytes[k] == '\\' && k + 1 < bytes.len() {
                2
            } else {
                1
            };
        }
        if k == bytes.len() {
            return None;
        }
        k += 1;
        while k < bytes.len() && (bytes[k] == ' ' || bytes[k] == '\t') {
            k += 1;
        }
    }
    (k < bytes.len() && bytes[k] == ')').then_some((url, k))
}

/// Run the marked autolink rules on the text starting at `rest` (the caller's slice of the original
/// line, so no per-candidate tail copy; `angle` selects the `<...>` rule). Returns the token; the
/// caller advances by its `raw` char count.
fn autolink_token_at(rest: &str, angle: bool) -> Option<crate::autolink::AutolinkToken> {
    if angle {
        crate::autolink::angle_token(rest)
    } else {
        crate::autolink::bare_token(rest)
    }
}

/// `CommonMark` flanking for `_` openers: left-flanking and not intraword (the
/// preceding char is not a word character), so `snake_case` never opens.
fn underscore_can_open(bytes: &[char], at: usize) -> bool {
    let next = bytes.get(at + 1);
    let next_ws = next.is_none_or(|c: &char| c.is_whitespace());
    let prev_word = at > 0 && (bytes[at - 1].is_alphanumeric() || bytes[at - 1] == '_');
    !next_ws && !prev_word
}

/// The `_` closer mirror: right-flanking and not intraword (the char after the
/// closer run is not a word character).
fn underscore_can_close(bytes: &[char], at: usize, len: usize) -> bool {
    let prev = at > 0 && !bytes[at - 1].is_whitespace();
    let next_word = bytes
        .get(at + len)
        .is_some_and(|c| c.is_alphanumeric() || *c == '_');
    prev && !next_word
}

/// The length of the run of `delim` starting at `at`.
fn run_length(bytes: &[char], at: usize, delim: char) -> usize {
    let mut n = 0;
    while bytes.get(at + n) == Some(&delim) {
        n += 1;
    }
    n
}

fn find_closing(chars: &[char], from: usize, delim: char, len: usize) -> Option<usize> {
    let mut i = from;
    while i + len <= chars.len() {
        // Escaped punctuation is literal, including a would-be closer. Walking
        // escape pairs also leaves a delimiter after an even backslash run live.
        if chars[i] == '\\' && chars.get(i + 1).is_some_and(char::is_ascii_punctuation) {
            i += 2;
            continue;
        }
        if (0..len).all(|k| chars[i + k] == delim) {
            return Some(i);
        }
        i += 1;
    }
    None
}

//! marked's GFM inline autolink rules (marked 18.0.7, the TS markdown
//! tokenizer), ported verbatim so bare URLs and angle-form links tokenize
//! exactly like the TS renderer: after every other inline construct fails,
//! marked tries `autolink` (`<scheme:...>` / `<email>`) and then `url`
//! (bare `http(s)://`, `ftp://`, `www.`, and email shapes, the latter only
//! outside a link label - marked's `state.inLink` guard). A match becomes a
//! link token whose text is the visible label and whose href feeds the OSC
//! 8 wrap (`markdown.ts` `case "link"`).

use std::sync::LazyLock;

use fancy_regex::Regex;

/// `rules.inline.autolink`: angle-form link. Group 1 is the link target,
/// group 2 the `@` marking the email alternative.
static ANGLE: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(
        r#"^<([a-zA-Z][a-zA-Z0-9+.-]{1,31}:[^\s\x00-\x1f<>]*|[a-zA-Z0-9.!#$%&'*+/=?^_`{|}~-]+(@)[a-zA-Z0-9](?:[a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?(?:\.[a-zA-Z0-9](?:[a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?)+(?![-_]))>"#,
    )
    .expect("static autolink regex")
});

/// `rules.inline.url` (gfm): bare url/www/email. Group 1 is the scheme
/// (`www.` included), group 2 the `@` marking the email alternative.
static BARE: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(
        r#"^((?:[hH][tT][tT][pP][sS]?|[fF][tT][pP])://|www\.)(?:[a-zA-Z0-9\-]+\.?)+[^\s<]*|^[A-Za-z0-9._+-]+(@)[a-zA-Z0-9-_]+(?:\.[a-zA-Z0-9-_]*[a-zA-Z0-9])+(?![-_])"#,
    )
    .expect("static url regex")
});

/// `rules.inline._backpedal`: trailing-punctuation trim. Balanced paren
/// groups survive; a punctuation run may only be consumed when it does not
/// end the string (the `(?!$)` guard), so the tokenizer's fixpoint loop
/// peels a trailing run one character per pass.
static BACKPEDAL: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(r#"(?:[^?!.,:;*_'"~()&]+|\([^)]*\)|&(?![a-zA-Z0-9]+;$)|[?!.,:;*_'"~)]+(?!$))+"#)
        .expect("static backpedal regex")
});

/// One autolink match: the visible label, the href marked puts on the
/// token (before `markdown.ts` normalizes it with `new URL()`), and the
/// raw text the lexer consumes for it (`markdown.ts` advances by
/// `token.raw`; for bare urls that is the backpedaled match, so a trimmed
/// trailing punctuation run stays in the text stream).
#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct AutolinkToken {
    pub raw: String,
    pub text: String,
    pub href: String,
}

/// The `autolink` rule: `<scheme:...>` or `<email>`. Never backpedaled.
pub(crate) fn angle_token(src: &str) -> Option<AutolinkToken> {
    let caps = ANGLE.captures(src).ok().flatten()?;
    let raw = caps.get(0)?.as_str().to_string();
    let text = caps.get(1)?.as_str().to_string();
    let href = if caps.get(2).is_some() {
        format!("mailto:{text}")
    } else {
        text.clone()
    };
    Some(AutolinkToken { raw, text, href })
}

/// The gfm `url` rule: bare protocol links, `www.` links (href gains a
/// `http://` scheme), and bare emails (href gains `mailto:`). The url/www
/// branch runs the `_backpedal` fixpoint loop; the email branch needs none
/// (its domain grammar cannot end on punctuation).
pub(crate) fn bare_token(src: &str) -> Option<AutolinkToken> {
    let caps = BARE.captures(src).ok().flatten()?;
    if caps.get(2).is_some() {
        let raw = caps.get(0)?.as_str().to_string();
        let href = format!("mailto:{raw}");
        return Some(AutolinkToken {
            text: raw.clone(),
            href,
            raw,
        });
    }
    let scheme = caps.get(1)?.as_str().to_string();
    let matched = caps.get(0)?.as_str();
    // marked's fixpoint (`do .. while r !== t[0]`) re-executed on the
    // shrunk match; the loop here walks the same steps as (start, end)
    // ranges over the one matched slice instead of re-copying the string
    // each pass, so a long trailing-punctuation run peels without an
    // allocation per peeled character.
    let mut start = 0;
    let mut end = matched.len();
    while let Ok(Some(m)) = BACKPEDAL.find(&matched[start..end]) {
        if m.start() == 0 && m.end() == end - start {
            break;
        }
        start += m.start();
        end = start + m.end() - m.start();
    }
    let text = &matched[start..end];
    let href = if scheme == "www." {
        format!("http://{text}")
    } else {
        text.to_string()
    };
    Some(AutolinkToken {
        raw: text.to_string(),
        text: text.to_string(),
        href,
    })
}

/// Cheap per-position gate for the gfm `url` rule: the rule can only match
/// when its literal prefix is present at the position - the schemes
/// case-insensitive (marked's `[hH][tT][tT][pP][sS]?` protocol classes),
/// `www.` literal - or, for the email alternative, when a local-part run
/// leads directly to an `@`. Both tests are bounded char scans with no
/// string copy and no regex, so a plain-text stream full of
/// candidate-shaped starts (every `h` of `history history ...`) stays
/// linear instead of re-copying the remaining text once per position.
pub(crate) fn bare_candidate(bytes: &[char], i: usize, line_has_at: bool) -> bool {
    for (prefix, ci) in [
        ("https://", true),
        ("http://", true),
        ("ftp://", true),
        ("www.", false),
    ] {
        if starts_with(bytes, i, prefix, ci) {
            return true;
        }
    }
    if line_has_at && (i == 0 || !is_local_part(bytes[i - 1])) {
        // Only the first character of a local-part run can start an email
        // match (the local-part grammar ends at the `@`, so a mid-run
        // start faces the identical `@` and domain and cannot succeed
        // where the run start failed), and one scan per run keeps a long
        // local-part run linear instead of quadratic.
        let mut j = i;
        while j < bytes.len() && is_local_part(bytes[j]) {
            j += 1;
        }
        if j < bytes.len() && bytes[j] == '@' {
            return true;
        }
    }
    false
}

fn is_local_part(c: char) -> bool {
    c.is_ascii_alphanumeric() || matches!(c, '.' | '_' | '+' | '-')
}

fn starts_with(bytes: &[char], i: usize, prefix: &str, ignore_case: bool) -> bool {
    prefix.chars().enumerate().all(|(k, pc)| {
        bytes.get(i + k).is_some_and(|&c| {
            if ignore_case {
                c.eq_ignore_ascii_case(&pc)
            } else {
                c == pc
            }
        })
    })
}

//! The path token grammar the prompt editor shares between completion and highlighting: an `@`
//! reference (`@src/main.rs`, `@"my file.txt"`) or, for path completion, the same token without
//! the `@`.
//!
//! A token starts at the start of the line or after a delimiter (whitespace, `"`, `'`, `=`). A
//! `"` opens a quoted token only as the token's first char after the optional `@`; the next `"`
//! closes it, and an unclosed token runs to the end of the line. An unquoted token ends at the
//! next delimiter.

/// How a path token is written.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum Quoting {
    Bare,
    Double,
}

impl Quoting {
    /// `path` written in this quoting; an unquoted path with spaces takes double quotes.
    pub(crate) fn render(self, path: &str) -> String {
        if self == Quoting::Bare && !path.contains(' ') {
            return path.to_string();
        }
        format!("\"{path}\"")
    }

    /// The quote char of a quoted token.
    pub(crate) fn quote(self) -> Option<char> {
        match self {
            Quoting::Double => Some('"'),
            Quoting::Bare => None,
        }
    }
}

/// One path token of a line, in char offsets.
#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct PathToken {
    pub start: usize,
    /// Past the last char, the closing quote included.
    pub end: usize,
    /// The token as typed.
    pub text: String,
    /// Whether the token starts with `@`.
    pub at: bool,
    /// The path without the `@` and quotes.
    pub path: String,
    pub quoting: Quoting,
    /// Whether a quoted token found its closing quote.
    pub closed: bool,
}

fn is_delimiter(c: char) -> bool {
    c.is_whitespace() || matches!(c, '"' | '\'' | '=')
}

/// Whether a token can start at `index`: the line start or after a delimiter.
fn is_token_start(line: &[char], index: usize) -> bool {
    index == 0 || is_delimiter(line[index - 1])
}

/// The `@` tokens of `line`, left to right.
pub(crate) fn at_tokens(line: &[char]) -> Vec<PathToken> {
    tokens(line, true)
}

/// The `@` token the cursor is typing: the open token `before` (the line up to the cursor)
/// ends with.
pub(crate) fn at_token_before(before: &[char]) -> Option<PathToken> {
    open_last(tokens(before, true), before.len())
}

/// The path token, with or without `@`, the cursor is typing; an empty token at the cursor
/// when `before` ends with none.
pub(crate) fn path_token_before(before: &[char]) -> PathToken {
    open_last(tokens(before, false), before.len()).unwrap_or(PathToken {
        start: before.len(),
        end: before.len(),
        text: String::new(),
        at: false,
        path: String::new(),
        quoting: Quoting::Bare,
        closed: false,
    })
}

fn open_last(mut tokens: Vec<PathToken>, len: usize) -> Option<PathToken> {
    tokens
        .pop()
        .filter(|token| token.end == len && !token.closed)
}

/// The tokens of `line` left to right; `at_only` skips tokens without `@`.
fn tokens(line: &[char], at_only: bool) -> Vec<PathToken> {
    let mut found = Vec::new();
    let mut index = 0;
    while index < line.len() {
        let c = line[index];
        if is_token_start(line, index) && (c == '"' || !is_delimiter(c)) && (!at_only || c == '@') {
            let token = scan(line, index);
            index = token.end;
            found.push(token);
        } else {
            index += 1;
        }
    }
    found
}

/// The token starting at `start`.
fn scan(line: &[char], start: usize) -> PathToken {
    let at = line[start] == '@';
    let mut index = start + usize::from(at);
    let mut path = String::new();
    let mut closed = false;
    let quoting = match line.get(index) {
        Some('"') => Quoting::Double,
        _ => Quoting::Bare,
    };
    if let Some(quote) = quoting.quote() {
        index += 1;
        while let Some(&c) = line.get(index).filter(|c| **c != '\n') {
            index += 1;
            if c == quote {
                closed = true;
                break;
            }
            path.push(c);
        }
    } else {
        while let Some(&c) = line.get(index).filter(|c| !is_delimiter(**c)) {
            index += 1;
            path.push(c);
        }
    }
    PathToken {
        start,
        end: index,
        text: line[start..index].iter().collect(),
        at,
        path,
        quoting,
        closed,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn chars(text: &str) -> Vec<char> {
        text.chars().collect()
    }

    /// (start, end, path, quoting, closed)
    type Expected = (usize, usize, &'static str, Quoting, bool);

    #[test]
    fn at_tokens_follow_the_quote_and_delimiter_rules() {
        use Quoting::{Bare, Double};
        let cases: &[(&str, &[Expected])] = &[
            (r#"@"a b" x"#, &[(0, 6, "a b", Double, true)]),
            // The next quote closes; an unclosed quote runs to the end of the line.
            (r#"@"a"b"#, &[(0, 4, "a", Double, true)]),
            ("x @\"open b\nnext", &[(2, 10, "open b", Double, false)]),
            // Every delimiter starts a token and ends an unquoted one.
            (
                r#"cfg=@a.rs '@b' "@c""#,
                &[
                    (4, 9, "a.rs", Bare, false),
                    (11, 13, "b", Bare, false),
                    (16, 18, "c", Bare, false),
                ],
            ),
            (
                "@it's @a=b",
                &[(0, 3, "it", Bare, false), (6, 8, "a", Bare, false)],
            ),
            ("mail a@b.c (@x)", &[]),
            (
                "@a|b @",
                &[(0, 4, "a|b", Bare, false), (5, 6, "", Bare, false)],
            ),
        ];
        for (line, expected) in cases {
            let tokens: Vec<_> = at_tokens(&chars(line))
                .into_iter()
                .map(|t| (t.start, t.end, t.path, t.quoting, t.closed))
                .collect();
            let expected: Vec<_> = expected
                .iter()
                .map(|&(start, end, path, quoting, closed)| {
                    (start, end, path.to_string(), quoting, closed)
                })
                .collect();
            assert_eq!(tokens, expected, "{line}");
        }
    }

    #[test]
    fn only_an_open_token_ending_at_the_cursor_is_typed() {
        assert_eq!(
            at_token_before(&chars(r#"@"a b"#)).map(|t| t.path),
            Some("a b".to_string())
        );
        assert_eq!(at_token_before(&chars(r#"@"a b""#)), None);
        assert_eq!(at_token_before(&chars("@a ")), None);
    }
}

//! The path token grammar the prompt editor shares between completion and highlighting: an `@`
//! reference (`@src/main.rs`, `@"my file.txt"`, `@'my file.txt'`, `@my\ file.txt`) or, for
//! path completion, a plain path token (`./src`, `"my dir/"`).
//!
//! A token starts at the start of the line or after a delimiter and, unquoted, ends at the next
//! delimiter. An `@` token's delimiters are whitespace and `=`. A quote opens a quoted `@` token
//! only as the first char after the `@`; it closes only when followed by whitespace or the end of
//! the line, so any other quote is part of the name. On macOS/Linux a backslash escapes the next
//! char of an unquoted `@` token (`my\ file`); on Windows it is the path separator. A plain
//! token also has the quotes as delimiters; a `"` opens it quoted only as its first char, and the
//! next `"` closes it. An unclosed quoted token runs to the end of the line.

/// Whether a backslash escapes the next char of an unquoted token.
const ESCAPES: bool = !cfg!(windows);

/// How a path token is written.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum Quoting {
    Bare,
    /// Unquoted with at least one backslash escape.
    Escaped,
    Double,
    Single,
}

impl Quoting {
    /// `path` written in this quoting. An `@` path scans back as itself: a quoted token keeps
    /// its quote unless the path holds it (then the other one); an unquoted path that would not
    /// scan back takes double quotes, or backslash escapes when escapes were typed. A plain path
    /// takes double quotes when typed quoted or holding a space.
    pub(crate) fn render(self, path: &str, at: bool) -> String {
        if !at {
            if self == Quoting::Bare && !path.contains(' ') {
                return path.to_string();
            }
            return format!("\"{path}\"");
        }
        let quote = match self {
            Quoting::Bare | Quoting::Escaped
                if !path
                    .chars()
                    .enumerate()
                    .any(|(index, c)| needs_escape(index, c)) =>
            {
                return path.to_string();
            }
            Quoting::Escaped => {
                let mut escaped = String::with_capacity(path.len());
                for (index, c) in path.chars().enumerate() {
                    if needs_escape(index, c) {
                        escaped.push('\\');
                    }
                    escaped.push(c);
                }
                return escaped;
            }
            Quoting::Single => '\'',
            Quoting::Bare | Quoting::Double => '"',
        };
        let quote = match quote {
            '"' if path.contains('"') => '\'',
            '\'' if path.contains('\'') => '"',
            quote => quote,
        };
        format!("{quote}{path}{quote}")
    }

    /// The quote char of a quoted token.
    pub(crate) fn quote(self) -> Option<char> {
        match self {
            Quoting::Double => Some('"'),
            Quoting::Single => Some('\''),
            Quoting::Bare | Quoting::Escaped => None,
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
    /// The path without the `@`, quotes, and escapes.
    pub path: String,
    pub quoting: Quoting,
    /// Whether a quoted token found its closing quote.
    pub closed: bool,
}

/// The delimiters of an `@` token (`at`) or a plain path token.
fn is_delimiter(c: char, at: bool) -> bool {
    c.is_whitespace() || c == '=' || (!at && matches!(c, '"' | '\''))
}

/// Whether an `@` token (`at`) or a plain path token can start at `index`: the line start or
/// after a delimiter.
fn is_token_start(line: &[char], index: usize, at: bool) -> bool {
    index == 0 || is_delimiter(line[index - 1], at)
}

/// Whether `c`, at char `index` of an unquoted `@` path, would not scan back as itself: it ends
/// the token, opens a quote, or (where backslashes escape) is a backslash.
fn needs_escape(index: usize, c: char) -> bool {
    is_delimiter(c, true) || (index == 0 && matches!(c, '"' | '\'')) || (ESCAPES && c == '\\')
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
        let at = c == '@';
        let starts = at || (!at_only && (c == '"' || !is_delimiter(c, false)));
        if starts && is_token_start(line, index, at) {
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
    let mut quoting = match line.get(index) {
        Some('"') => Quoting::Double,
        Some('\'') if at => Quoting::Single,
        _ => Quoting::Bare,
    };
    if let Some(quote) = quoting.quote() {
        index += 1;
        while let Some(&c) = line.get(index).filter(|c| **c != '\n') {
            index += 1;
            if c == quote && (!at || line.get(index).is_none_or(|next| next.is_whitespace())) {
                closed = true;
                break;
            }
            path.push(c);
        }
    } else {
        while let Some(&c) = line.get(index).filter(|c| !is_delimiter(**c, at)) {
            index += 1;
            if at && ESCAPES && c == '\\' {
                if let Some(&escaped) = line.get(index).filter(|next| **next != '\n') {
                    index += 1;
                    path.push(escaped);
                    quoting = Quoting::Escaped;
                    continue;
                }
            }
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
    fn at_tokens_follow_the_quote_and_boundary_rules() {
        use Quoting::{Bare, Double, Single};
        let cases: &[(&str, &[Expected])] = &[
            ("@'a b' x", &[(0, 6, "a b", Single, true)]),
            (r#"@"a b" x"#, &[(0, 6, "a b", Double, true)]),
            // A quote not followed by whitespace or the line end is part of the name.
            (
                "@'/path/to/weird'dir/file with spaces.txt'",
                &[(
                    0,
                    42,
                    "/path/to/weird'dir/file with spaces.txt",
                    Single,
                    true,
                )],
            ),
            // An unclosed quote runs to the end of the line.
            ("x @'open b\nnext", &[(2, 10, "open b", Single, false)]),
            // Apostrophes after the token start are name chars; prose has no tokens.
            ("don't @it's fine", &[(6, 11, "it's", Bare, false)]),
            ("mail a@b.c (@x)", &[]),
            // `=` delimits like whitespace.
            (
                "cfg=@a.rs @a=b",
                &[(4, 9, "a.rs", Bare, false), (10, 12, "a", Bare, false)],
            ),
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
            at_token_before(&chars("@'a b")).map(|t| t.path),
            Some("a b".to_string())
        );
        assert_eq!(at_token_before(&chars("@'a b'")), None);
        assert_eq!(at_token_before(&chars("@a ")), None);
    }

    #[test]
    fn rendered_paths_scan_back_as_themselves() {
        let mut cases = vec![
            (Quoting::Bare, "my file"),
            (Quoting::Bare, "'lead"),
            (Quoting::Bare, "a=b"),
            (Quoting::Single, "it's here"),
            (Quoting::Double, r#"say "hi""#),
        ];
        if ESCAPES {
            cases.extend([
                (Quoting::Bare, r"a\b"),
                (Quoting::Escaped, r"my dir\x"),
                (Quoting::Escaped, "'lead"),
            ]);
        }
        for (quoting, path) in cases {
            let text = format!("@{}", quoting.render(path, true));
            let tokens = at_tokens(&chars(&text));
            assert_eq!(tokens.len(), 1, "{text}");
            assert_eq!(
                (tokens[0].end, tokens[0].path.as_str()),
                (text.chars().count(), path),
                "{text}"
            );
        }
    }
}

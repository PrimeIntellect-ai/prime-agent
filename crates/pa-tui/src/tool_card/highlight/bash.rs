//! Bash syntax highlighting for markdown fences: the highlight.js bash
//! grammar's comments, quoted strings, variables, keywords, literals,
//! built-ins (a trimmed list), and paths (plain, so `/bin/cat` keeps
//! `cat` uncolored), plus whole-word numbers and heredoc bodies. Command
//! substitutions inside `"..."` keep the string color.

use super::{flush_plain, scoped_lines, Scope, SyntaxPalette};
use crate::Line;

/// Reserved words (`keyword` scope).
const KEYWORDS: [&str; 15] = [
    "if", "then", "else", "elif", "fi", "for", "while", "until", "do", "done", "case", "esac",
    "function", "select", "in",
];

/// Built-in value names (`literal` scope).
const LITERALS: [&str; 2] = ["true", "false"];

/// Shell built-ins and common core utilities (`built_in` scope).
const BUILT_INS: [&str; 68] = [
    "alias", "basename", "break", "builtin", "cat", "cd", "chgrp", "chmod", "chown", "command",
    "continue", "cp", "cut", "date", "declare", "df", "dirname", "du", "echo", "env", "eval",
    "exec", "exit", "export", "getopts", "hash", "head", "let", "ln", "local", "ls", "mkdir",
    "mktemp", "mv", "nohup", "printf", "pwd", "read", "readlink", "readonly", "realpath", "return",
    "rm", "rmdir", "seq", "shift", "sleep", "sort", "source", "stat", "sudo", "tail", "tee",
    "test", "timeout", "touch", "tr", "trap", "type", "typeset", "ulimit", "umask", "unalias",
    "uname", "uniq", "unset", "wc", "whoami",
];

/// Highlight bash `code` into per-line spans. The whole block is one
/// pass, so multi-line strings and heredoc bodies carry across lines.
pub(crate) fn highlight_bash(code: &str, palette: &SyntaxPalette) -> Vec<Line> {
    scoped_lines(code, tokenize(code), palette)
}

fn is_word(c: char) -> bool {
    c.is_ascii_alphanumeric() || c == '_'
}

/// Append `text` to the stream: plain text joins the pending buffer.
fn push(text: &str, scope: Scope, plain: &mut String, tokens: &mut Vec<(String, Scope)>) {
    if scope == Scope::Plain {
        plain.push_str(text);
    } else if !text.is_empty() {
        flush_plain(plain, tokens);
        tokens.push((text.to_string(), scope));
    }
}

fn tokenize(code: &str) -> Vec<(String, Scope)> {
    let mut tokens: Vec<(String, Scope)> = Vec::new();
    let mut plain = String::new();
    // The delimiter (and `<<-` tab stripping) of a heredoc whose body
    // starts at the next line break.
    let mut heredoc: Option<(&str, bool)> = None;
    // The paren depth inside `((...))` arithmetic, where `<<` is a shift.
    let mut arith = 0usize;
    let mut i = 0usize;
    while i < code.len() {
        let rest = &code[i..];
        let ch = rest.chars().next().expect("char boundary");
        let prev = code[..i].chars().next_back();
        let word_start = !prev.is_some_and(is_word);
        let (len, scope) = match ch {
            '\n' => {
                if let Some((delimiter, strip_tabs)) = heredoc.take() {
                    push("\n", Scope::Plain, &mut plain, &mut tokens);
                    let body = &rest[1..];
                    let len = heredoc_body_len(body, delimiter, strip_tabs);
                    push(&body[..len], Scope::String, &mut plain, &mut tokens);
                    i += 1 + len;
                    continue;
                }
                (1, Scope::Plain)
            }
            // A comment starts a word: after whitespace or an operator
            // character (`ok;# note`); `a#b` and `$#` stay code.
            '#' if prev.is_none_or(|c| {
                c.is_whitespace() || matches!(c, ';' | '&' | '|' | '(' | ')' | '<' | '>')
            }) =>
            {
                (rest.find('\n').unwrap_or(rest.len()), Scope::Comment)
            }
            '\\' => (
                1 + rest[1..].chars().next().map_or(0, char::len_utf8),
                Scope::Plain,
            ),
            '\'' => (
                rest[1..].find('\'').map_or(rest.len(), |n| n + 2),
                Scope::String,
            ),
            '"' => {
                i += double_quoted(rest, &mut plain, &mut tokens);
                continue;
            }
            '$' => variable_len(rest).map_or((1, Scope::Plain), |n| (n, Scope::Variable)),
            '<' if rest.starts_with("<<<") => (3, Scope::Plain),
            '(' if arith > 0 => {
                arith += 1;
                (1, Scope::Plain)
            }
            '(' if rest.starts_with("((") => {
                arith = 2;
                (2, Scope::Plain)
            }
            ')' if arith > 0 => {
                arith -= 1;
                (1, Scope::Plain)
            }
            '<' if arith == 0 && rest.starts_with("<<") => match heredoc_start(rest) {
                Some((op, end, delimiter, strip_tabs)) => {
                    push(&rest[..op], Scope::Plain, &mut plain, &mut tokens);
                    push(&rest[op..end], Scope::String, &mut plain, &mut tokens);
                    heredoc = Some((delimiter, strip_tabs));
                    i += end;
                    continue;
                }
                None => (2, Scope::Plain),
            },
            '/' => (path_len(rest).unwrap_or(1), Scope::Plain),
            c if word_start && c.is_ascii_digit() => number(rest),
            c if word_start && c.is_ascii_lowercase() => word(rest),
            _ => (ch.len_utf8(), Scope::Plain),
        };
        push(&rest[..len], scope, &mut plain, &mut tokens);
        i += len;
    }
    flush_plain(&mut plain, &mut tokens);
    tokens
}

/// A `"..."` string at the start of `rest`, pushed with its `$VAR` and
/// `${...}` parts in the variable scope; returns its length. An
/// unterminated string runs to the end of the block.
fn double_quoted(rest: &str, plain: &mut String, tokens: &mut Vec<(String, Scope)>) -> usize {
    let mut start = 0usize;
    let mut j = 1usize;
    while j < rest.len() {
        let ch = rest[j..].chars().next().expect("char boundary");
        match ch {
            '\\' => j += 1 + rest[j + 1..].chars().next().map_or(0, char::len_utf8),
            '"' => {
                push(&rest[start..=j], Scope::String, plain, tokens);
                return j + 1;
            }
            '$' => match variable_len(&rest[j..]) {
                Some(len) => {
                    push(&rest[start..j], Scope::String, plain, tokens);
                    push(&rest[j..j + len], Scope::Variable, plain, tokens);
                    j += len;
                    start = j;
                }
                None => j += 1,
            },
            _ => j += ch.len_utf8(),
        }
    }
    push(&rest[start..], Scope::String, plain, tokens);
    rest.len()
}

/// `$NAME`, `$1`, a special parameter (`$?`, `$#`, ...), or a braced
/// `${...}` (nested braces included; unterminated runs to the end).
fn variable_len(rest: &str) -> Option<usize> {
    let after = &rest[1..];
    if after.starts_with('{') {
        let mut depth = 0usize;
        for (index, c) in after.char_indices() {
            match c {
                '{' => depth += 1,
                '}' => {
                    depth -= 1;
                    if depth == 0 {
                        return Some(index + 2);
                    }
                }
                _ => {}
            }
        }
        return Some(rest.len());
    }
    let name = after
        .bytes()
        .take_while(|b| is_word(char::from(*b)))
        .count();
    if name > 0 {
        return Some(1 + name);
    }
    after
        .starts_with(['?', '#', '@', '!', '$', '*', '-'])
        .then_some(2)
}

/// `<<WORD`, `<<-WORD`, `<< 'WORD'`, `<<"WORD"`: the operator length, the
/// end of the (possibly quoted) delimiter, the bare delimiter, and
/// whether `<<-` strips leading tabs from the body lines.
fn heredoc_start(rest: &str) -> Option<(usize, usize, &str, bool)> {
    let strip_tabs = rest[2..].starts_with('-');
    let mut op = 2 + usize::from(strip_tabs);
    op += rest[op..]
        .bytes()
        .take_while(|b| matches!(b, b' ' | b'\t'))
        .count();
    let quote = rest[op..]
        .chars()
        .next()
        .filter(|c| matches!(c, '\'' | '"'));
    let name_start = op + usize::from(quote.is_some());
    // A quoted delimiter runs to its closing quote, a bare one to the end
    // of the shell word.
    let name = &rest[name_start..];
    let name_len = match quote {
        Some(quote) => name.find(quote)?,
        None => name
            .find(|c: char| c.is_whitespace() || "'\";&|()<>".contains(c))
            .unwrap_or(name.len()),
    };
    if name_len == 0 {
        return None;
    }
    let name_end = name_start + name_len;
    let end = name_end + usize::from(quote.is_some());
    Some((op, end, &rest[name_start..name_end], strip_tabs))
}

/// The heredoc body through its terminator line (the line break after the
/// terminator stays outside); an unterminated body runs to the end.
fn heredoc_body_len(body: &str, delimiter: &str, strip_tabs: bool) -> usize {
    let mut end = 0usize;
    for line in body.split_inclusive('\n') {
        let text = line.strip_suffix('\n').unwrap_or(line);
        let bare = if strip_tabs {
            text.trim_start_matches('\t')
        } else {
            text
        };
        if bare == delimiter {
            return end + text.len();
        }
        end += line.len();
    }
    body.len()
}

/// The grammar's path mode `(/[a-z._-]+)+`: a path stays plain.
fn path_len(rest: &str) -> Option<usize> {
    let mut end = 0usize;
    while rest[end..].starts_with('/') {
        let segment = rest[end + 1..]
            .bytes()
            .take_while(|b| matches!(b, b'a'..=b'z' | b'.' | b'_' | b'-'))
            .count();
        if segment == 0 {
            break;
        }
        end += 1 + segment;
    }
    (end > 0).then_some(end)
}

/// `\d+(\.\d+)?` as a whole word; digits glued to a word stay plain.
fn number(rest: &str) -> (usize, Scope) {
    let bytes = rest.as_bytes();
    let digits = |from: usize| {
        bytes[from..]
            .iter()
            .take_while(|b| b.is_ascii_digit())
            .count()
    };
    let mut len = digits(0);
    if bytes.get(len) == Some(&b'.') && bytes.get(len + 1).is_some_and(u8::is_ascii_digit) {
        len += 1 + digits(len + 1);
    }
    if rest[len..].starts_with(is_word) {
        let word = rest.bytes().take_while(|b| is_word(char::from(*b))).count();
        return (word, Scope::Plain);
    }
    (len, Scope::Number)
}

/// The grammar's keyword pattern `\b[a-z][a-z0-9._-]+\b`: a word glued to
/// further word characters (`lsX`) stays plain.
fn word(rest: &str) -> (usize, Scope) {
    let run = rest
        .bytes()
        .take_while(|b| matches!(b, b'a'..=b'z' | b'0'..=b'9' | b'.' | b'_' | b'-'))
        .count();
    let word = rest[..run].trim_end_matches(['.', '-']);
    if rest[run..].starts_with(is_word) {
        return (run, Scope::Plain);
    }
    let scope = if KEYWORDS.contains(&word) {
        Scope::Keyword
    } else if LITERALS.contains(&word) {
        Scope::Literal
    } else if BUILT_INS.contains(&word) {
        Scope::BuiltIn
    } else {
        Scope::Plain
    };
    (word.len(), scope)
}

#[cfg(test)]
mod tests {
    use proptest::prelude::*;

    use super::*;
    use crate::theme::{ColorMode, Theme};

    fn scoped(code: &str, scope: Scope) -> Vec<String> {
        tokenize(code)
            .into_iter()
            .filter(|(_, s)| *s == scope)
            .map(|(text, _)| text)
            .collect()
    }

    #[test]
    fn comment_needs_a_word_boundary() {
        assert_eq!(scoped("echo a#b $# # note", Scope::Comment), vec!["# note"]);
        assert_eq!(
            scoped("#!/bin/bash\nls", Scope::Comment),
            vec!["#!/bin/bash"]
        );
        assert_eq!(scoped("ok;# don't\nls", Scope::Comment), vec!["# don't"]);
    }

    #[test]
    fn scopes_of_a_script() {
        let code = r#"for f in *.txt; do echo "$f: ${SIZE:-0}" '$x' $1 $?; done; exit 2"#;
        assert_eq!(
            scoped(code, Scope::Keyword),
            vec!["for", "in", "do", "done"]
        );
        assert_eq!(scoped(code, Scope::BuiltIn), vec!["echo", "exit"]);
        assert_eq!(scoped(code, Scope::String), vec!["\"", ": ", "\"", "'$x'"]);
        assert_eq!(
            scoped(code, Scope::Variable),
            vec!["$f", "${SIZE:-0}", "$1", "$?"]
        );
        assert_eq!(scoped(code, Scope::Number), vec!["2"]);
        // Paths, escaped quotes, and glued words stay plain.
        let plain = "cat /tmp/test \\\"x lsX file2 && true";
        assert_eq!(scoped(plain, Scope::BuiltIn), vec!["cat"]);
        assert_eq!(scoped(plain, Scope::Literal), vec!["true"]);
        assert!(scoped(plain, Scope::String).is_empty());
        assert!(scoped(plain, Scope::Number).is_empty());
    }

    #[test]
    fn heredoc_body_is_a_string_through_its_terminator() {
        let code = "cat <<-'EOF' > out\n\techo $x\n\tEOF\nls";
        assert_eq!(
            scoped(code, Scope::String),
            vec!["'EOF'", "\techo $x\n\tEOF"]
        );
        assert_eq!(scoped(code, Scope::BuiltIn), vec!["cat", "ls"]);
        assert_eq!(
            scoped("cat <<END-X\nbody\nEND-X\nls", Scope::BuiltIn),
            vec!["cat", "ls"]
        );
        // Arithmetic and subshell parens close back out of arithmetic.
        assert_eq!(
            scoped(
                "echo $(( (a) )) $( (cd b) )\ncat <<EOF\nx\nEOF",
                Scope::String
            ),
            vec!["EOF", "x\nEOF"]
        );
        // Neither a here-string nor an arithmetic shift is a heredoc.
        for code in [
            "cat <<<word\nls",
            "echo $(( (1 + x) << 2 ))\nls",
            "((x <<= 1))\nls",
        ] {
            assert!(scoped(code, Scope::String).is_empty(), "{code}");
            assert_eq!(scoped(code, Scope::BuiltIn).last().unwrap(), "ls", "{code}");
        }
    }

    fn fragment() -> impl Strategy<Value = String> {
        prop_oneof![
            3 => prop::sample::select(vec![
                "'", "\"", "\\", "$", "${", "}", "{", "#", "<<", "<<-", "<<<", "EOF", "'EOF'",
                "/", "/a", "ls", "if", "1", ".5", "\n", "\t", " ", "é", "界", "\u{1f980}",
            ])
            .prop_map(str::to_string),
            1 => any::<char>().prop_map(String::from),
        ]
    }

    proptest! {
        #[test]
        fn highlight_bash_keeps_every_char(parts in prop::collection::vec(fragment(), 0..24)) {
            let code = parts.concat();
            let palette = SyntaxPalette::from_theme(&Theme::builtin("prime", ColorMode::TrueColor));
            let text: Vec<String> = highlight_bash(&code, &palette)
                .iter()
                .map(|line| line.iter().map(|span| span.content.as_str()).collect())
                .collect();
            prop_assert_eq!(text.concat(), code.replace('\n', ""));
        }
    }
}

//! Python syntax highlighting for expanded ipython cells, a display-side
//! port of the TS `highlightCode("python")` path (the highlight.js python
//! grammar through cli-highlight's theme mapping). Cell-level scope coloring
//! only: cli-highlight's parent-scope wrap is invisible once a child token
//! colors the same cells, so the render needs one color per cell, matching
//! the `theme.ts` mapping (keyword -> syntaxKeyword, `built_in/type` ->
//! syntaxType, literal/number -> syntaxNumber, string -> syntaxString,
//! comment -> syntaxComment, title -> syntaxFunction, params ->
//! syntaxVariable, everything else default). F-string substitutions and
//! backslash escapes keep the string color (cli-highlight renders those
//! scopes with the identity function, leaving them in the parent wrap).

use crate::theme::{Theme, ThemeColor};
use crate::{Line, Span};
use ratatui::style::Style;

/// The resolved `syntax*` theme colors the scopes render with (TS
/// `buildCliHighlightTheme`'s mapping of the highlight.js token classes to
/// the theme's `syntax*` keys). Shared by every surface that renders
/// highlighted code (the expanded ipython cell, the fenced markdown block).
#[derive(Debug, Clone, Copy)]
pub(crate) struct SyntaxPalette {
    pub keyword: Style,
    pub type_: Style,
    pub number: Style,
    pub string: Style,
    pub comment: Style,
    pub function: Style,
    pub variable: Style,
}

impl SyntaxPalette {
    pub(crate) fn from_theme(theme: &Theme) -> Self {
        Self {
            keyword: theme.fg_style(ThemeColor::SyntaxKeyword),
            type_: theme.fg_style(ThemeColor::SyntaxType),
            number: theme.fg_style(ThemeColor::SyntaxNumber),
            string: theme.fg_style(ThemeColor::SyntaxString),
            comment: theme.fg_style(ThemeColor::SyntaxComment),
            function: theme.fg_style(ThemeColor::SyntaxFunction),
            variable: theme.fg_style(ThemeColor::SyntaxVariable),
        }
    }
}

/// The scope a token renders with.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum Scope {
    Plain,
    Keyword,
    BuiltIn,
    Type,
    Literal,
    Number,
    String,
    Comment,
    Title,
    Params,
}

impl Scope {
    fn style(self, palette: &SyntaxPalette) -> Option<Style> {
        match self {
            Scope::Plain => None,
            Scope::Keyword => Some(palette.keyword),
            Scope::BuiltIn | Scope::Type => Some(palette.type_),
            Scope::Literal | Scope::Number => Some(palette.number),
            Scope::String => Some(palette.string),
            Scope::Comment => Some(palette.comment),
            Scope::Title => Some(palette.function),
            Scope::Params => Some(palette.variable),
        }
    }
}

/// Flush the pending plain-text buffer into the token list.
fn flush_plain(plain: &mut String, tokens: &mut Vec<(String, Scope)>) {
    if !plain.is_empty() {
        tokens.push((std::mem::take(plain), Scope::Plain));
    }
}

/// Reserved words (`keyword` scope).
const KEYWORDS: [&str; 32] = [
    "and", "as", "assert", "async", "await", "break", "class", "continue", "def", "del", "elif",
    "else", "except", "finally", "for", "from", "global", "if", "import", "in", "is", "lambda",
    "nonlocal", "not", "or", "pass", "raise", "return", "try", "while", "with", "yield",
];

/// Built-in callables (`built_in` scope).
const BUILT_INS: [&str; 69] = [
    "__import__",
    "abs",
    "all",
    "any",
    "ascii",
    "bin",
    "bool",
    "breakpoint",
    "bytearray",
    "bytes",
    "callable",
    "chr",
    "classmethod",
    "compile",
    "complex",
    "delattr",
    "dict",
    "dir",
    "divmod",
    "enumerate",
    "eval",
    "exec",
    "filter",
    "float",
    "format",
    "frozenset",
    "getattr",
    "globals",
    "hasattr",
    "hash",
    "help",
    "hex",
    "id",
    "input",
    "int",
    "isinstance",
    "issubclass",
    "iter",
    "len",
    "list",
    "locals",
    "map",
    "max",
    "memoryview",
    "min",
    "next",
    "object",
    "oct",
    "open",
    "ord",
    "pow",
    "print",
    "property",
    "range",
    "repr",
    "reversed",
    "round",
    "set",
    "setattr",
    "slice",
    "sorted",
    "staticmethod",
    "str",
    "sum",
    "super",
    "tuple",
    "type",
    "vars",
    "zip",
];

/// Built-in value names (`literal` scope).
const LITERALS: [&str; 6] = [
    "__debug__",
    "Ellipsis",
    "False",
    "None",
    "NotImplemented",
    "True",
];

/// Typing names (`type` scope).
const TYPES: [&str; 13] = [
    "Any",
    "Callable",
    "Coroutine",
    "Dict",
    "List",
    "Literal",
    "Generic",
    "Optional",
    "Sequence",
    "Set",
    "Tuple",
    "Type",
    "Union",
];

/// The scope a bare word carries. The grammar's `$pattern` is
/// `[A-Za-z]\w+|__\w+__`: only those shapes can carry a keyword scope.
fn word_scope(word: &str) -> Scope {
    let starts_alpha = word.chars().next().is_some_and(|c| c.is_ascii_alphabetic());
    let all_word = word.chars().all(|c| c.is_ascii_alphanumeric() || c == '_');
    let is_dunder = word.len() > 4
        && word.starts_with("__")
        && word.ends_with("__")
        && word[2..word.len() - 2]
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || c == '_');
    if !(all_word && (starts_alpha || is_dunder)) {
        return Scope::Plain;
    }
    if KEYWORDS.contains(&word) {
        Scope::Keyword
    } else if BUILT_INS.contains(&word) {
        Scope::BuiltIn
    } else if LITERALS.contains(&word) {
        Scope::Literal
    } else if TYPES.contains(&word) {
        Scope::Type
    } else {
        Scope::Plain
    }
}

/// `digitpart = [0-9](_?[0-9])*`: the length of the digit run at `i`.
fn digitpart_at(bytes: &[u8], i: usize) -> Option<usize> {
    if !bytes.get(i)?.is_ascii_digit() {
        return None;
    }
    let mut len = 1usize;
    while let Some(next) = digit_step(bytes, i + len) {
        len += next;
    }
    Some(len)
}

/// One `_digit` or `digit` continuation.
fn digit_step(bytes: &[u8], i: usize) -> Option<usize> {
    if bytes.get(i) == Some(&b'_') && bytes.get(i + 1)?.is_ascii_digit() {
        Some(2)
    } else if bytes.get(i)?.is_ascii_digit() {
        Some(1)
    } else {
        None
    }
}

/// `pointfloat`: `((\\b(digitpart))?\\.(digitpart)|\\b(digitpart)\\.)`;
/// a float must contain a decimal point, so no word boundary is needed.
fn pointfloat_at(text: &str, i: usize) -> Option<usize> {
    let bytes = text.as_bytes();
    if let Some(int_len) = digitpart_at(bytes, i) {
        if bytes.get(i + int_len) == Some(&b'.') {
            let after = i + int_len + 1;
            if let Some(frac) = digitpart_at(bytes, after) {
                return Some(frac + 1 + int_len);
            }
            // `123.` matches the trailing-dot variant.
            return Some(int_len + 1);
        }
    }
    if bytes.get(i) == Some(&b'.') {
        let frac = digitpart_at(bytes, i + 1)?;
        return Some(frac + 1);
    }
    None
}

/// The grammar's number variants, tried in order at the position:
/// exponentfloat, pointfloat, decinteger, binary, octal, hex, imaginary.
fn number_at(text: &str, i: usize) -> Option<usize> {
    let bytes = text.as_bytes();
    let digit = digitpart_at(bytes, i);
    let point = pointfloat_at(text, i);
    // exponentfloat: `(\\b(digitpart)|pointfloat)[eE][+-]?digitpart[jJ]?\\b`.
    if let Some(base) = point.or(digit) {
        let mut end = i + base;
        if matches!(bytes.get(end), Some(b'e' | b'E')) {
            let mut exp = end + 1;
            if matches!(bytes.get(exp), Some(b'+' | b'-')) {
                exp += 1;
            }
            if let Some(exp_digits) = digitpart_at(bytes, exp) {
                end = exp + exp_digits;
                if matches!(bytes.get(end), Some(b'j' | b'J')) {
                    end += 1;
                }
                if !ident_continues(text, end) {
                    return Some(end - i);
                }
            }
        }
    }
    // pointfloat (a float must contain a decimal point).
    if let Some(point) = point {
        let mut end = i + point;
        if matches!(bytes.get(end), Some(b'j' | b'J')) {
            end += 1;
        }
        return Some(end - i);
    }
    // decinteger `\\b([1-9](_?[0-9])*|0+(_?0)*)[lLjJ]?\\b`.
    if let Some(digit) = digit {
        let mut end = i + digit;
        if matches!(bytes.get(end), Some(b'j' | b'J')) {
            return Some(end + 1 - i);
        }
        if matches!(bytes.get(end), Some(b'l' | b'L')) {
            end += 1;
            if matches!(bytes.get(end), Some(b'j' | b'J')) {
                end += 1;
            }
        }
        if !ident_continues(text, end) {
            return Some(end - i);
        }
    }
    // Binary, octal, and hex integers: `0[bBoOxX]` then the digit run.
    let radix_high = match (bytes.get(i).copied(), bytes.get(i + 1).copied()) {
        (Some(b'0'), Some(b'b' | b'B')) => b'1',
        (Some(b'0'), Some(b'o' | b'O')) => b'7',
        (Some(b'0'), Some(b'x' | b'X')) => b'F',
        _ => return None,
    };
    let digit_ok = |c: u8, high: u8| -> bool {
        if c == b'_' {
            return true;
        }
        match high {
            b'1' => matches!(c, b'0' | b'1'),
            b'7' => c.is_ascii_digit() && c <= b'7',
            _ => c.is_ascii_hexdigit(),
        }
    };
    let mut end = i + 2;
    let mut digits = 0usize;
    while let Some(c) = bytes.get(end) {
        let c = *c;
        let high = radix_high;
        if digit_ok(c, high) {
            if c != b'_' {
                digits += 1;
            }
            end += 1;
        } else {
            break;
        }
    }
    if digits == 0 || ident_continues(text, end) {
        return None;
    }
    if matches!(bytes.get(end), Some(b'l' | b'L')) {
        end += 1;
        if ident_continues(text, end) {
            return None;
        }
    }
    Some(end - i)
}

/// True when a word char continues at `i` (would break the `\\b` anchors).
fn ident_continues(text: &str, i: usize) -> bool {
    text[i..]
        .chars()
        .next()
        .is_some_and(|c| c.is_ascii_alphanumeric() || c == '_')
}

/// A python string starting at `i`: prefix and body form one `string`
/// token. Substitutions and escapes keep the string color.
fn string_at(text: &str, i: usize) -> Option<usize> {
    let bytes = text.as_bytes();
    let mut end = i;
    while end < bytes.len()
        && matches!(
            bytes[end],
            b'u' | b'U' | b'b' | b'B' | b'r' | b'R' | b'f' | b'F'
        )
    {
        end += 1;
    }
    let quote = bytes.get(end)?;
    if quote != &b'\'' && quote != &b'"' {
        return None;
    }
    let triple = bytes.get(end + 1) == Some(quote) && bytes.get(end + 2) == Some(quote);
    let mut cursor = end + if triple { 3 } else { 1 };
    while cursor < text.len() {
        let rest = &text[cursor..];
        if rest.starts_with('\\') {
            // Backslash escape: consumed inside the string.
            let escaped = rest.char_indices().nth(1).map_or(1, |(idx, _)| idx + 1);
            cursor += escaped;
            continue;
        }
        let ch = rest.chars().next()?;
        if triple {
            let closing = [quote_char(quote); 3].iter().collect::<String>();
            if rest.starts_with(&closing) {
                return Some(cursor + 3 - i);
            }
        } else if ch == quote_char(quote) {
            return Some(cursor + ch.len_utf8() - i);
        }
        // Single-quoted strings never cross a line break; an unterminated
        // triple-quoted string runs to the end of the block.
        if ch == '\n' && !triple {
            return None;
        }
        cursor += ch.len_utf8();
    }
    if triple {
        Some(text.len() - i)
    } else {
        None
    }
}

fn quote_char(byte: &u8) -> char {
    if byte == &b'\'' {
        '\''
    } else {
        '"'
    }
}

/// Highlight python `code` into per-line spans. The whole block is one
/// highlight.js pass, so multi-line strings carry across lines.
pub(crate) fn highlight_python(code: &str, palette: &SyntaxPalette) -> Vec<Line> {
    let mut lines: Vec<Line> = Vec::new();
    let mut current: Line = Vec::new();
    for (text, scope) in tokenize(code) {
        let style = scope.style(palette);
        // A token carries at most one line break (comments stop at it).
        for (index, part) in text.split('\n').enumerate() {
            if index > 0 {
                lines.push(std::mem::take(&mut current));
            }
            if part.is_empty() {
                continue;
            }
            match style {
                Some(style) => current.push(Span::styled(part.to_string(), style)),
                None => current.push(Span::raw(part.to_string())),
            }
        }
    }
    lines.push(current);
    // A trailing newline in the source produces a final empty line.
    if code.ends_with('\n') {
        lines.push(Vec::new());
    }
    lines
}

/// The token stream: word/number/string/comment scopes plus the def/class
/// header modes (title name, params parens).
fn tokenize(code: &str) -> Vec<(String, Scope)> {
    let mut tokens: Vec<(String, Scope)> = Vec::new();
    let mut plain = String::new();
    let mut i = 0usize;
    while i < code.len() {
        let rest = &code[i..];
        let ch = rest.chars().next().expect("char boundary");
        if ch == '#' {
            let end = rest.find('\n').map_or(code.len(), |n| i + n);
            flush_plain(&mut plain, &mut tokens);
            tokens.push((code[i..end].to_string(), Scope::Comment));
            i = end;
            continue;
        }
        if ch == '\n' {
            plain.push('\n');
            i += 1;
            continue;
        }
        if let Some(len) = number_at(code, i) {
            flush_plain(&mut plain, &mut tokens);
            tokens.push((code[i..i + len].to_string(), Scope::Number));
            i += len;
            continue;
        }
        if let Some(len) = string_at(code, i) {
            flush_plain(&mut plain, &mut tokens);
            tokens.push((code[i..i + len].to_string(), Scope::String));
            i += len;
            continue;
        }
        if ch.is_ascii_alphabetic() || ch == '_' {
            let word_len = rest
                .char_indices()
                .take_while(|(_, c)| c.is_ascii_alphanumeric() || *c == '_')
                .map(|(idx, c)| idx + c.len_utf8())
                .last()
                .unwrap_or(1);
            let word = &rest[..word_len];
            let scope = word_scope(word);
            // `def`/`class` open the function/class mode: the name (title)
            // and the parameter parens (params) follow.
            if (word == "def" || word == "class") && !ident_continues(code, i + word_len) {
                if let Some(next) = header_mode(code, i, word_len, &mut plain, &mut tokens) {
                    i = next;
                    continue;
                }
                flush_plain(&mut plain, &mut tokens);
                tokens.push((word.to_string(), Scope::Keyword));
                i += word_len;
                continue;
            }
            match scope {
                Scope::Plain => plain.push_str(word),
                scope => {
                    flush_plain(&mut plain, &mut tokens);
                    tokens.push((word.to_string(), scope));
                }
            }
            i += word_len;
            continue;
        }
        plain.push(ch);
        i += ch.len_utf8();
    }
    flush_plain(&mut plain, &mut tokens);
    tokens
}

/// The def/class header: keyword, title name, params parens (bare content
/// carries the params color; sub-modes inside keep their own scopes).
fn header_mode(
    code: &str,
    at: usize,
    keyword_len: usize,
    plain: &mut String,
    tokens: &mut Vec<(String, Scope)>,
) -> Option<usize> {
    let mut i = at + keyword_len;
    while code[i..].starts_with(|c: char| c.is_whitespace()) && !code[i..].starts_with('\n') {
        i += 1;
    }
    let name_len = code[i..]
        .char_indices()
        .take_while(|(_, c)| c.is_ascii_alphanumeric() || *c == '_')
        .map(|(idx, c)| idx + c.len_utf8())
        .last()
        .unwrap_or(0);
    if name_len == 0 {
        return None;
    }
    flush_plain(plain, tokens);
    tokens.push((code[at..at + keyword_len].to_string(), Scope::Keyword));
    if i > gap_start {
        tokens.push((code[gap_start..i].to_string(), Scope::Plain));
    }
    tokens.push((code[i..i + name_len].to_string(), Scope::Title));
    i += name_len;
    if !code[i..].starts_with('(') {
        return Some(i);
    }
    // The opening paren of the params group renders plain (hljs emits it
    // outside the `params` span; cli-highlight colors only the param
    // cells, so the paren must reach the stream or the line loses it).
    flush_plain(plain, tokens);
    tokens.push(("(".to_string(), Scope::Plain));
    i += 1;
    let mut params_plain = String::new();
    let flush_params = |params_plain: &mut String, tokens: &mut Vec<(String, Scope)>| {
        if !params_plain.is_empty() {
            tokens.push((std::mem::take(params_plain), Scope::Params));
        }
    };
    while i < code.len() {
        let rest = &code[i..];
        let ch = rest.chars().next().expect("char boundary");
        if ch == ')' {
            flush_params(&mut params_plain, tokens);
            tokens.push((")".to_string(), Scope::Plain));
            return Some(i + 1);
        }
        if ch == '#' {
            let end = rest.find('\n').map_or(code.len(), |n| i + n);
            flush_params(&mut params_plain, tokens);
            tokens.push((code[i..end].to_string(), Scope::Comment));
            i = end;
            continue;
        }
        if let Some(len) = number_at(code, i) {
            flush_params(&mut params_plain, tokens);
            tokens.push((code[i..i + len].to_string(), Scope::Number));
            i += len;
            continue;
        }
        if let Some(len) = string_at(code, i) {
            flush_params(&mut params_plain, tokens);
            tokens.push((code[i..i + len].to_string(), Scope::String));
            i += len;
            continue;
        }
        params_plain.push(ch);
        i += ch.len_utf8();
    }
    flush_params(&mut params_plain, tokens);
    Some(i)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::theme::{ColorMode, Theme};

    fn theme() -> Theme {
        Theme::builtin("prime", ColorMode::TrueColor)
    }

    fn scopes(code: &str) -> Vec<(String, Scope)> {
        tokenize(code)
    }

    fn line_text(line: &Line) -> String {
        line.iter().map(|s| s.content.as_str()).collect()
    }

    #[test]
    fn print_call_scopes() {
        let toks = scopes("print('visual parity ok')");
        assert_eq!(
            toks,
            vec![
                ("print".into(), Scope::BuiltIn),
                ("(".into(), Scope::Plain),
                ("'visual parity ok'".into(), Scope::String),
                (")".into(), Scope::Plain),
            ]
        );
    }

    #[test]
    fn fstring_is_one_token() {
        let toks = scopes("print(f'line {i}')");
        assert!(toks.contains(&("f'line {i}'".into(), Scope::String)));
    }

    #[test]
    fn def_header_scopes() {
        let toks = scopes("def foo(x, y=1):");
        assert_eq!(
            toks,
            vec![
                ("def".into(), Scope::Keyword),
                (" ".into(), Scope::Plain),
                ("foo".into(), Scope::Title),
                ("(".into(), Scope::Plain),
                ("x, y=".into(), Scope::Params),
                ("1".into(), Scope::Number),
                (")".into(), Scope::Plain),
                (":".into(), Scope::Plain),
            ]
        );
    }

    #[test]
    fn def_header_line_text_is_lossless() {
        // The params group's opening paren renders plain but must reach the
        // stream: dropping it loses text from the rendered line.
        let code = "def gutter_probe(count=7):";
        let lines = highlight_python(code, &SyntaxPalette::from_theme(&theme()));
        assert_eq!(lines.len(), 1);
        assert_eq!(line_text(&lines[0]), code);
    }

    #[test]
    fn class_header_scopes() {
        let toks = scopes("class Foo(Bar):");
        assert_eq!(
            toks,
            vec![
                ("class".into(), Scope::Keyword),
                (" ".into(), Scope::Plain),
                ("Foo".into(), Scope::Title),
                ("(".into(), Scope::Plain),
                ("Bar".into(), Scope::Params),
                (")".into(), Scope::Plain),
                (":".into(), Scope::Plain),
            ]
        );
    }

    #[test]
    fn keywords_literals_numbers() {
        let toks =
            scopes("for i in range(3):\n    raise ValueError('boom')\nx = None\ny = 0x1F + 1.5e3j");
        assert!(toks.contains(&("for".into(), Scope::Keyword)));
        assert!(toks.contains(&("in".into(), Scope::Keyword)));
        assert!(toks.contains(&("range".into(), Scope::BuiltIn)));
        assert!(toks.contains(&("3".into(), Scope::Number)));
        assert!(toks.contains(&("raise".into(), Scope::Keyword)));
        assert!(toks.contains(&("None".into(), Scope::Literal)));
        assert!(toks.contains(&("0x1F".into(), Scope::Number)));
        assert!(toks.contains(&("1.5e3j".into(), Scope::Number)));
        assert!(toks.contains(&("'boom'".into(), Scope::String)));
        // Plain identifiers keep the default color (ValueError is
        // user-defined, so no token carries it with a non-plain scope).
        assert!(toks
            .iter()
            .filter(|(t, _)| t.contains("ValueError"))
            .all(|(_, s)| *s == Scope::Plain));
    }

    #[test]
    fn comment_scope() {
        let toks = scopes("# comment line\nx = 1");
        assert_eq!(toks[0], ("# comment line".into(), Scope::Comment));
        assert!(toks.contains(&("1".into(), Scope::Number)));
    }

    #[test]
    fn triple_quoted_string_spans_lines() {
        let code = "s = '''a\nb'''\nt = 1";
        let toks = scopes(code);
        assert!(toks.contains(&("'''a\nb'''".into(), Scope::String)));
        let lines = highlight_python(code, &SyntaxPalette::from_theme(&theme()));
        assert_eq!(lines.len(), 3);
        assert_eq!(line_text(&lines[0]), "s = '''a");
        assert_eq!(line_text(&lines[1]), "b'''");
        assert_eq!(line_text(&lines[2]), "t = 1");
    }

    #[test]
    fn plain_identifiers_stay_plain() {
        let toks = scopes("self.x = _hidden");
        assert!(toks.iter().all(|(_, scope)| *scope == Scope::Plain));
    }

    #[test]
    fn escaped_quote_stays_in_string() {
        let toks = scopes("x = 'a\\'b'");
        assert!(toks.contains(&("'a\\'b'".into(), Scope::String)));
    }
}

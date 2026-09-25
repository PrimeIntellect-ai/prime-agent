//! Python-side preview analysis: the python half of
//! `packages/coding-agent/src/core/tools/code-preview.ts`.
//!
//! Covers `previewPythonCode`/`previewIpythonCode` and their statement
//! scanner. Split from the bash-side preview module for module-size
//! hygiene; behavior matches the TS source.

use crate::tools::code_preview::{
    descriptor, is_comment_line, js_trim, js_trim_end, path_tail, preview_bash_command, re,
    simplify_bash_command_line, CodePreview, S,
};
use crate::tools::ipython_cell_code::parse_ipython_bash_cell;

/// Skip blank, comment, and import lines when scoring python previews.
fn is_skippable_python_line(line: &str) -> bool {
    let trimmed = js_trim(line);
    trimmed.is_empty()
        || is_comment_line(trimmed)
        || re(&format!(r"^{S}*(?:import{S}+\S|from{S}+\S+{S}+import{S}+)")).is_match(trimmed)
}

fn python_indent(line: &str) -> usize {
    re(&format!(r"^{S}*"))
        .find(line)
        .map_or(0, |m| m.as_str().chars().count())
}

fn python_call_pattern(inner: &str) -> bool {
    re(&format!(
        r"^{S}*(?:await{S}+)?[A-Za-z_][A-Za-z0-9_.]*{S}*\("
    ))
    .is_match(inner)
}

fn python_low_signal_call_pattern(inner: &str) -> bool {
    re(&format!(
        r"^{S}*(?:await{S}+)?(?:print|len|str|repr|int|float|list|dict|set|tuple){S}*\("
    ))
    .is_match(inner)
}

fn python_print_inner_call(line: &str) -> Option<String> {
    let trimmed = js_trim(line);
    let inner = re(r"^print\((.*)\)$")
        .captures(trimmed)
        .and_then(|c| c.get(1))
        .map(|m| js_trim(m.as_str()).to_string());
    inner.filter(|inner| python_call_pattern(inner))
}

fn python_path_vars(lines: &[String]) -> std::collections::HashMap<String, String> {
    let mut vars = std::collections::HashMap::new();
    let path_assign = re(&format!(
        r#"^{S}*([A-Za-z_][A-Za-z0-9_]*){S}*={S}*(?:Path|pathlib\.Path)\((["'])([^"']+)\2\)"#
    ));
    let string_assign = re(&format!(
        r#"^{S}*([A-Za-z_][A-Za-z0-9_]*){S}*={S}*(["'])([^"']+)\2"#
    ));
    for line in lines {
        let m = path_assign
            .captures(line)
            .or_else(|| string_assign.captures(line));
        if let Some(c) = m {
            let name = c.get(1).map(|g| g.as_str().to_string());
            let value = c.get(3).map(|g| g.as_str().to_string());
            if let (Some(name), Some(value)) = (name, value) {
                if value.contains('/') {
                    vars.insert(name, value);
                }
            }
        }
    }
    vars
}

fn python_file_operation(
    line: &str,
    paths: &std::collections::HashMap<String, String>,
) -> Option<String> {
    let m = re(
        r"^(?:await\s+)?([A-Za-z_][A-Za-z0-9_]*)\.(write_text|write_bytes|read_text|read_bytes|mkdir|unlink|rename|replace|touch)\s*\(",
    )
    .captures(js_trim(line))?;
    let name = m.get(1)?.as_str();
    let method = m.get(2)?.as_str();
    let path = paths.get(name)?;
    let action = match method {
        "write_text" | "write_bytes" => "write",
        "read_text" | "read_bytes" => "read",
        "mkdir" => "mkdir",
        "unlink" => "delete",
        "rename" => "rename",
        "replace" => "replace",
        "touch" => "touch",
        other => other,
    };
    Some(format!("{action} {}", path_tail(path)))
}

fn python_subprocess_command(line: &str) -> Option<String> {
    let trimmed = js_trim(line);
    if let Some(c) = re(r#"subprocess\.(?:run|check_call|check_output|Popen)\(\s*(["`])([^"`]+)\1"#)
        .captures(trimmed)
    {
        return c.get(2).map(|g| simplify_bash_command_line(g.as_str()));
    }
    if let Some(c) =
        re(r"subprocess\.(?:run|check_call|check_output|Popen)\(\s*\[([^\]]+)\]").captures(trimmed)
    {
        let inner = c.get(1)?.as_str();
        let words_re = re(r#"["']([^"']+)["']"#);
        let words: Vec<&str> = words_re
            .captures_iter(inner)
            .filter_map(|c| c.get(1).map(|g| g.as_str()))
            .collect();
        return Some(simplify_bash_command_line(&words.join(" ")));
    }
    None
}

fn simplify_python_preview_line(
    line: &str,
    paths: &std::collections::HashMap<String, String>,
) -> String {
    python_file_operation(line, paths)
        .or_else(|| python_subprocess_command(line))
        .or_else(|| python_print_inner_call(line))
        .unwrap_or_else(|| js_trim(line).to_string())
}

fn python_preview_line(
    lines: &[String],
    index: usize,
    paths: &std::collections::HashMap<String, String>,
) -> String {
    let line = lines.get(index).map_or("", String::as_str);
    if index > 0 && re(&format!(r"^{S}*(?:async{S}+def|def|class){S}+")).is_match(line) {
        let previous = lines.get(index - 1).map_or("", String::as_str);
        if re(&format!(r"^{S}*@")).is_match(js_trim(previous)) {
            return format!("{} {}", js_trim(previous), js_trim(line));
        }
    }
    if re(&format!(
        r"^{S}*(?:if|elif|else|for|while|with|try|except|finally)\b.*:\s*$"
    ))
    .is_match(line)
    {
        if let Some(child_index) = first_python_child_line(lines, index) {
            let head = re(r":\s*$").replace(js_trim(line), ":");
            let child = lines.get(child_index).cloned().unwrap_or_default();
            return format!("{head} {}", simplify_python_preview_line(&child, paths));
        }
    }
    simplify_python_preview_line(line, paths)
}

fn first_python_child_line(lines: &[String], parent_index: usize) -> Option<usize> {
    let parent_line = lines.get(parent_index).cloned().unwrap_or_default();
    let parent_indent = python_indent(&parent_line);
    for (i, line) in lines.iter().enumerate().skip(parent_index + 1) {
        if is_skippable_python_line(line) || re(&format!(r"^{S}*@")).is_match(js_trim(line)) {
            continue;
        }
        if python_indent(line) <= parent_indent {
            return None;
        }
        return Some(i);
    }
    None
}

fn python_line_score(
    lines: &[String],
    index: usize,
    paths: &std::collections::HashMap<String, String>,
) -> i64 {
    let line = lines.get(index).cloned().unwrap_or_default();
    let trimmed = js_trim(&line).to_string();
    if is_skippable_python_line(&line)
        || re(&format!(r"^{S}*@")).is_match(&trimmed)
        || re(r"^[)\]},;\s]+(?:#.*)?$").is_match(&trimmed)
    {
        return -1;
    }
    if python_file_operation(&line, paths).is_some() {
        return 95;
    }
    if python_subprocess_command(&line).is_some() {
        return 90;
    }
    if re(&format!(
        r#"^{S}*if{S}+__name__{S}*=={S}*['"]__main__['"]{S}*:"#
    ))
    .is_match(&line)
    {
        return 70;
    }
    if re(&format!(
        r"^{S}*(?:await{S}+)?[A-Za-z_][A-Za-z0-9_.]*\.(?:write_text|write_bytes|mkdir|unlink|rename|replace|touch|append|extend|update|add|remove|discard|close|commit|execute|run){S}*\("
    ))
    .is_match(&line)
    {
        return 80;
    }
    if re(&format!(
        r"^{S}*(?:if|elif|else|for|while|with|try|except|finally)\b.*:\s*$"
    ))
    .is_match(&line)
    {
        return match first_python_child_line(lines, index) {
            None => 20,
            Some(child_index) => (python_line_score(lines, child_index, paths) - 5).max(20),
        };
    }
    if re(&format!(r"^{S}*(?:async{S}+def|def|class){S}+")).is_match(&line) {
        return 50;
    }
    if re(&format!(
        r#"^{S}*[A-Za-z_][A-Za-z0-9_]*(?:{S}*:\s*[^=]+)?{S}*={S}*(?:await{S}+)?(?:Path|pathlib\.Path|json\.loads|json\.dumps|str|int|float|list|dict|set|tuple){S}*\("#
    ))
    .is_match(&line)
    {
        return 25;
    }
    let print_inner_call = python_print_inner_call(&line);
    let is_low_signal_call = print_inner_call
        .as_deref()
        .is_some_and(python_low_signal_call_pattern);
    if print_inner_call.is_some() && !is_low_signal_call {
        return 55;
    }
    if re(&format!(
        r"^{S}*[A-Za-z_][A-Za-z0-9_]*(?:{S}*:\s*[^=]+)?{S}*={S}*(?:await{S}+)?[A-Za-z_][A-Za-z0-9_.]*{S}*\("
    ))
    .is_match(&line)
    {
        return 60;
    }
    let matches_call = python_call_pattern(&line);
    let matches_low_signal = python_low_signal_call_pattern(&line);
    if matches_call && !matches_low_signal {
        return 65;
    }
    if matches_call {
        return 15;
    }
    30
}

fn python_preview_index(lines: &[String], index: usize) -> usize {
    let line = lines.get(index).cloned().unwrap_or_default();
    if !re(&format!(
        r"^{S}*(?:if|elif|else|for|while|with|try|except|finally)\b.*:\s*$"
    ))
    .is_match(&line)
    {
        return index;
    }
    match first_python_child_line(lines, index) {
        None => index,
        Some(child_index) => python_preview_index(lines, child_index),
    }
}

struct PythonStringScan {
    value: String,
    end: usize,
    closed: bool,
    /// Saw a cooked escape whose value is not computed here.
    unsupported_escape: bool,
}

fn is_unsupported_escape_char(ch: char) -> bool {
    matches!(
        ch,
        'x' | 'u' | 'U' | 'N' | 'a' | 'b' | 'f' | 'v' | '0'..='7'
    )
}

/// Walk a python string-literal body from just after the opening delimiter,
/// following python's escape rules (in raw strings backslash-quote never
/// closes). Offsets index bytes into `code`.
fn scan_python_string_literal(
    code: &str,
    start: usize,
    quote: &str,
    raw: bool,
) -> PythonStringScan {
    let mut value = String::new();
    let mut i = start;
    let mut unsupported_escape = false;
    let quote_bytes = quote.as_bytes();
    while i < code.len() {
        let ch = code[i..].chars().next().expect("char boundary");
        if ch == '\\' && i + 1 < code.len() {
            let next = code[i + 1..].chars().next().expect("char boundary");
            if raw {
                value.push('\\');
                value.push(next);
            } else {
                if is_unsupported_escape_char(next) {
                    unsupported_escape = true;
                }
                match next {
                    '\n' => {} // backslash-newline is a line continuation
                    '"' => value.push('"'),
                    '\'' => value.push('\''),
                    '\\' => value.push('\\'),
                    'n' => value.push('\n'),
                    'r' => value.push('\r'),
                    't' => value.push('\t'),
                    other => {
                        value.push('\\');
                        value.push(other);
                    }
                }
            }
            i += 1 + next.len_utf8();
            continue;
        }
        if code.as_bytes()[i..].starts_with(quote_bytes) {
            return PythonStringScan {
                value,
                end: i + quote.len(),
                closed: true,
                unsupported_escape,
            };
        }
        if quote.len() == 1 && ch == '\n' {
            break; // single-quoted literals cannot span lines
        }
        value.push(ch);
        i += ch.len_utf8();
    }
    PythonStringScan {
        value,
        end: i,
        closed: false,
        unsupported_escape,
    }
}

/// Keep source-line positions while masking multiline-string continuations.
pub fn python_statement_lines(code: &str) -> Vec<String> {
    let mut lines: Vec<String> = code.split('\n').map(String::from).collect();
    let mut line = 0usize;
    let mut i = 0usize;
    while i < code.len() {
        let ch = code[i..].chars().next().expect("char boundary");
        if ch == '#' {
            let Some(nl) = code[i..].find('\n') else {
                break;
            };
            i += nl;
            continue;
        }
        if ch == '"' || ch == '\'' {
            let quote = if code[i..].starts_with(&ch.to_string().repeat(3)) {
                ch.to_string().repeat(3)
            } else {
                ch.to_string()
            };
            let scan = scan_python_string_literal(code, i + quote.len(), &quote, true);
            let start_line = line;
            for end in i..scan.end {
                if code.as_bytes().get(end) == Some(&b'\n') {
                    line += 1;
                    while lines.len() <= line {
                        lines.push(String::new());
                    }
                    lines[line] = String::new();
                }
            }
            if scan.closed && line > start_line {
                let column = scan.end - (code[..scan.end].rfind('\n').map_or(0, |p| p + 1));
                let rest_start = scan.end;
                let rest_end = code[rest_start..]
                    .find('\n')
                    .map_or(code.len(), |p| rest_start + p);
                while lines.len() <= line {
                    lines.push(String::new());
                }
                lines[line] = format!("{}{}", " ".repeat(column), &code[rest_start..rest_end]);
            }
            i = scan.end;
            continue;
        }
        if ch == '\n' {
            line += 1;
        }
        i += ch.len_utf8();
    }
    lines
}

fn extract_bash_skill_command(code: &str) -> Option<String> {
    let triple_double = "\"\"\"";
    let triple_single = concat!("''", "'");
    let m = re(&format!(
        r#"{S}*(?:[A-Za-z_][A-Za-z0-9_]*{S}*={S}*)?(?:await{S}+)?bash{S}*\({S}*[rR]?({triple_double}|{triple_single}|"|')"#
    ))
    .captures(code)?;
    let quote = m.get(1)?.as_str();
    let start = m.get(0)?.end();
    // The character before the quote (r/R) marks a raw literal.
    let head: Vec<char> = code[..start].chars().collect();
    let quote_chars = quote.chars().count();
    let prefix_char = if head.len() > quote_chars {
        head[head.len() - quote_chars - 1]
    } else {
        ' '
    };
    let raw = matches!(prefix_char, 'r' | 'R');
    let scan = scan_python_string_literal(code, start, quote, raw);
    if !scan.closed || scan.unsupported_escape {
        return None;
    }
    let rest = code[scan.end..].trim_start();
    // Require a plain literal first argument; concatenation or other
    // expressions fall back.
    if !rest.starts_with(',') && !rest.starts_with(')') {
        return None;
    }
    Some(scan.value)
}

/// Pick the highest-signal line of a python cell as its preview.
pub fn preview_python_code(code: &str) -> CodePreview {
    let raw_lines: Vec<String> = code.split('\n').map(String::from).collect();
    let lines: Vec<String> = python_statement_lines(code)
        .into_iter()
        .map(|line| re(&format!(r"^({S}*);{S}*")).replace(&line, "$1"))
        .collect();
    let paths = python_path_vars(&lines);
    let mut best_index: Option<usize> = None;
    let mut best_score: i64 = -1;

    for (i, _) in lines.iter().enumerate() {
        let score = python_line_score(&lines, i, &paths);
        if score > best_score {
            best_index = Some(i);
            best_score = score;
        }
    }

    if let Some(best_index) = best_index.filter(|_| best_score >= 0) {
        let preview_index = python_preview_index(&lines, best_index);
        // Keep the original tail for multiline commands, excluding any
        // preceding string continuation.
        let mut joined = String::new();
        if let Some(first) = lines.get(preview_index) {
            joined.push_str(first);
        }
        for raw in raw_lines.iter().skip(preview_index + 1) {
            joined.push('\n');
            joined.push_str(raw);
        }
        if let Some(bash_command) = extract_bash_skill_command(&joined) {
            return preview_bash_command(&bash_command);
        }
        let text = python_preview_line(&lines, preview_index, &paths);
        return CodePreview::python(descriptor(&text));
    }
    CodePreview::python(String::new())
}

/// Preview an ipython cell: %%bash cells preview as bash, the rest as python.
#[cfg_attr(not(test), allow(dead_code))]
pub(crate) fn preview_ipython_code(code: &str) -> CodePreview {
    let trimmed = js_trim_end(code);
    if let Some(cell) = parse_ipython_bash_cell(trimmed) {
        return preview_bash_command(&cell.body);
    }
    preview_python_code(trimmed)
}

//! Bash/Python command preview extraction for tool-call rendering.
//!
//! Port of `packages/coding-agent/src/core/tools/code-preview.ts`. Regexes keep
//! JavaScript semantics (whitespace/word classes, UTF-16 string indexing).

use super::python::preview_python_code;
#[cfg(test)]
use super::python::{preview_ipython_code, python_statement_lines};

const DESCRIPTOR_MAX_WIDTH: usize = 64;

/// JavaScript backslash-s character class.
pub(crate) const S: &str = r"[\t\n\x0B\f\r \u{00A0}\u{1680}\u{2000}-\u{200A}\u{2028}\u{2029}\u{202F}\u{205F}\u{3000}\u{FEFF}]";
/// JavaScript backslash-w character class.
pub(crate) const W: &str = r"[A-Za-z0-9_]";

/// One preview regex, on either engine. Nearly every pattern is plain
/// (character classes, groups, alternation) and runs as a linear-time
/// `regex` program; the handful that need lookarounds or backreferences
/// (the redaction and quoted-string patterns) fall back to `fancy_regex`.
/// Preview regexes run per rendered row on the transcript path, so the
/// engine choice is a rendering cost, not a style preference.
#[derive(Clone)]
pub(crate) enum Rx {
    Fast(regex::Regex),
    Fancy(fancy_regex::Regex),
}

/// One capture set from either engine, exposing the group spans the
/// preview code reads (`get(i)`, with `as_str`/`end` on the result).
pub(crate) struct Cap<'t> {
    fast: Option<regex::Captures<'t>>,
    fancy: Option<fancy_regex::Captures<'t>>,
}

/// One captured group: the matched text plus its span, from either engine.
#[derive(Clone, Copy)]
pub(crate) struct Group<'t> {
    text: &'t str,
    end: usize,
}

impl<'t> Group<'t> {
    pub(crate) fn as_str(&self) -> &'t str {
        self.text
    }

    pub(crate) fn end(&self) -> usize {
        self.end
    }
}

impl<'t> Cap<'t> {
    pub(crate) fn get(&self, index: usize) -> Option<Group<'t>> {
        if let Some(captures) = &self.fast {
            let m = captures.get(index)?;
            return Some(Group {
                text: m.as_str(),
                end: m.end(),
            });
        }
        let captures = self.fancy.as_ref()?;
        let m = captures.get(index)?;
        Some(Group {
            text: m.as_str(),
            end: m.end(),
        })
    }
}

/// The interned-regex pool: preview patterns are format-built at call sites
/// but drawn from a small constant set, so one global cache keeps the
/// compiled program alive across calls (compiling a regex per call costs
/// milliseconds — a transcript-scale render pays it per row).
fn regex_pool() -> &'static std::sync::Mutex<std::collections::HashMap<String, Rx>> {
    static POOL: std::sync::OnceLock<std::sync::Mutex<std::collections::HashMap<String, Rx>>> =
        std::sync::OnceLock::new();
    POOL.get_or_init(|| std::sync::Mutex::new(std::collections::HashMap::new()))
}

impl Rx {
    /// Look up (or compile) a preview regex; errors abort (patterns are
    /// compile-time constants).
    pub(crate) fn new(pattern: &str) -> Self {
        let mut pool = regex_pool()
            .lock()
            .expect("code-preview regex pool poisoned");
        // The hit path stays allocation-free: the key borrows, only a miss
        // interns the pattern string.
        if let Some(rx) = pool.get(pattern) {
            return rx.clone();
        }
        // Plain patterns compile on the fast engine; fancy-only syntax
        // (lookarounds, backreferences) falls back to the backtracking
        // engine.
        let rx = match regex::Regex::new(pattern) {
            Ok(inner) => Rx::Fast(inner),
            Err(_) => Rx::Fancy(
                fancy_regex::Regex::new(pattern).expect("code-preview regex must compile"),
            ),
        };
        pool.insert(pattern.to_string(), rx.clone());
        rx
    }

    pub(crate) fn is_match(&self, text: &str) -> bool {
        match self {
            Rx::Fast(inner) => inner.is_match(text),
            Rx::Fancy(inner) => inner.is_match(text).unwrap_or(false),
        }
    }

    pub(crate) fn captures<'t>(&self, text: &'t str) -> Option<Cap<'t>> {
        match self {
            Rx::Fast(inner) => inner.captures(text).map(|fast| Cap {
                fast: Some(fast),
                fancy: None,
            }),
            Rx::Fancy(inner) => inner.captures(text).ok().flatten().map(|fancy| Cap {
                fast: None,
                fancy: Some(fancy),
            }),
        }
    }

    pub(crate) fn captures_iter<'t>(&self, text: &'t str) -> Vec<Cap<'t>> {
        match self {
            Rx::Fast(inner) => inner
                .captures_iter(text)
                .map(|fast| Cap {
                    fast: Some(fast),
                    fancy: None,
                })
                .collect(),
            Rx::Fancy(inner) => inner
                .captures_iter(text)
                .flatten()
                .map(|fancy| Cap {
                    fast: None,
                    fancy: Some(fancy),
                })
                .collect(),
        }
    }

    pub(crate) fn find<'t>(&self, text: &'t str) -> Option<Group<'t>> {
        match self {
            Rx::Fast(inner) => inner.find(text).map(|m| Group {
                text: m.as_str(),
                end: m.end(),
            }),
            Rx::Fancy(inner) => inner.find(text).ok().flatten().map(|m| Group {
                text: m.as_str(),
                end: m.end(),
            }),
        }
    }

    pub(crate) fn replace(&self, text: &str, rep: &str) -> String {
        match self {
            Rx::Fast(inner) => inner.replace(text, rep).into_owned(),
            Rx::Fancy(inner) => inner.replace(text, rep).into_owned(),
        }
    }

    pub(crate) fn replace_all(&self, text: &str, rep: &str) -> String {
        match self {
            Rx::Fast(inner) => inner.replace_all(text, rep).into_owned(),
            Rx::Fancy(inner) => inner.replace_all(text, rep).into_owned(),
        }
    }

    /// Split on every separator match. The `regex` crate has no stable
    /// split, so the fast engine slices around its separator matches; the
    /// fancy engine uses its own split.
    pub(crate) fn split<'t>(&self, text: &'t str) -> Vec<&'t str> {
        match self {
            Rx::Fast(inner) => {
                let mut parts = Vec::new();
                let mut last = 0usize;
                for m in inner.find_iter(text) {
                    parts.push(&text[last..m.start()]);
                    last = m.end();
                }
                parts.push(&text[last..]);
                parts
            }
            Rx::Fancy(inner) => inner.split(text).filter_map(Result::ok).collect(),
        }
    }
}

/// One interned preview regex at a call site: the pattern expression runs
/// exactly once per site (every preview pattern is a constant built from
/// the shared `S`/`W` classes), and later calls clone the pooled program.
/// This is the code-preview equivalent of a JS regex literal, which the TS
/// side gets for free.
macro_rules! re_once {
    ($pattern:expr $(,)?) => {{
        static INTERNED: std::sync::OnceLock<$crate::code_preview::bash::Rx> =
            std::sync::OnceLock::new();
        INTERNED
            .get_or_init(|| $crate::code_preview::bash::re(&$pattern))
            .clone()
    }};
}
pub(crate) use re_once;

pub(crate) fn re(pattern: &str) -> Rx {
    Rx::new(pattern)
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum CodePreviewLanguage {
    Bash,
    Python,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct CodePreview {
    pub language: CodePreviewLanguage,
    pub text: String,
}

impl CodePreview {
    fn bash(text: impl Into<String>) -> Self {
        CodePreview {
            language: CodePreviewLanguage::Bash,
            text: text.into(),
        }
    }

    pub(crate) fn python(text: impl Into<String>) -> Self {
        CodePreview {
            language: CodePreviewLanguage::Python,
            text: text.into(),
        }
    }
}

/// JS String.prototype.trim whitespace set.
fn is_js_whitespace(ch: char) -> bool {
    matches!(
        ch,
        '\u{09}'
            ..='\u{0D}'
                | ' '
                | '\u{00A0}'
                | '\u{1680}'
                | '\u{2028}'
                | '\u{2029}'
                | '\u{202F}'
                | '\u{205F}'
                | '\u{3000}'
                | '\u{FEFF}'
    ) || ('\u{2000}'..='\u{200A}').contains(&ch)
}

pub(crate) fn js_trim(text: &str) -> &str {
    text.trim_matches(is_js_whitespace)
}

pub(crate) fn js_trim_end(s: &str) -> &str {
    s.trim_end_matches(is_js_whitespace)
}

/// Number of UTF-16 code units (JS String.length).
fn utf16_len(s: &str) -> usize {
    s.chars().map(char::len_utf16).sum()
}

/// JS s.slice(0, n): first n UTF-16 code units.
fn utf16_slice_prefix(s: &str, n: usize) -> String {
    let mut units = 0usize;
    for (idx, ch) in s.char_indices() {
        if units + ch.len_utf16() > n {
            return s[..idx].to_string();
        }
        units += ch.len_utf16();
    }
    s.to_string()
}

pub(crate) fn collapse_whitespace(text: &str) -> String {
    re_once!(format!(r"{S}+")).replace_all(text, " ")
}

fn truncate_descriptor(text: &str) -> String {
    if utf16_len(text) <= DESCRIPTOR_MAX_WIDTH {
        return text.to_string();
    }
    let cut = utf16_slice_prefix(text, DESCRIPTOR_MAX_WIDTH - 1);
    format!("{}\u{2026}", js_trim_end(&cut))
}

/// Mask secrets, blobs, and oversized strings before display.
pub(crate) fn redact_noise(text: &str) -> String {
    let step1 = re_once!(r"[A-Za-z0-9+/]{80,}={0,2}").replace_all(text, "<blob>");
    let step2 = re_once!(format!(
        r#"\b((?={W}*(?:token|key|secret|password))[A-Za-z_]{W}*){S}*={S}*(["'])[^"']*\2"#
    ))
    .replace_all(&step1, "$1=<redacted>");
    let step3 = re_once!(format!(
        r#"(?i)\b((?={W}*(?:token|key|secret|password))[A-Za-z_]{W}*){S}*={S}*(?!<redacted>)(?!["'])\S+"#
    ))
    .replace_all(&step2, "$1=<redacted>");
    let step4 = re_once!(r#"(?i)\b(authorization:\s*(?:bearer\s+)?)[^\s"']+"#)
        .replace_all(&step3, "$1<redacted>");
    let step5 = re_once!(r#"(["'])sk-[^"']+\1"#).replace_all(&step4, "$1<redacted>$1");
    re_once!(r#"(["']).{160,}\1"#).replace_all(&step5, "$1\u{2026}$1")
}

pub(crate) fn descriptor(text: &str) -> String {
    truncate_descriptor(js_trim(&collapse_whitespace(&redact_noise(text))))
}

/// Strip a leading ! magic and a leading cd-prefix chain segment.
pub(crate) fn strip_bash_prefix(line: &str) -> String {
    let no_magic = re_once!(format!(r"^{S}*!")).replace(line, "");
    let trimmed = js_trim(&no_magic);
    let no_cd = re_once!(format!(r"^{S}*cd{S}+([^&;|]+)(?:&&|;){S}*")).replace(trimmed, "");
    js_trim(&no_cd).to_string()
}

pub(crate) fn is_comment_line(line: &str) -> bool {
    re_once!(format!(r"^{S}*#")).is_match(line)
}

pub(crate) fn is_skippable_bash_line(line: &str) -> bool {
    let trimmed = js_trim(line);
    trimmed.is_empty()
        || is_comment_line(trimmed)
        || re_once!(format!(
            r"^{S}*set{S}+[-+][A-Za-z]*(?:{S}+[-+]?{W}+)*(?:{S}+pipefail)?{S}*$"
        ))
        .is_match(trimmed)
        || re_once!(format!(r"^(?:export{S}+{W}+=|source{S}+\S+|\.{S}+\S+)")).is_match(trimmed)
}

/// Split a command line into shell-quoted words.
fn shell_words(line: &str) -> Vec<String> {
    let re_words = re_once!(r#""([^"]*)"|'([^']*)'|(\S+)"#);
    re_words
        .captures_iter(line)
        .into_iter()
        .filter_map(|c| {
            c.get(1)
                .or_else(|| c.get(2))
                .or_else(|| c.get(3))
                .map(|g| g.as_str().to_string())
        })
        .collect()
}

/// Drop a leading ./ from a path.
pub(crate) fn path_tail(path: &str) -> String {
    re_once!(r"^\./").replace(path, "")
}

/// Shorten well-known runner invocations for display.
fn simplify_runner_command(line: &str) -> Option<String> {
    let words = shell_words(line);
    let joined = words.join(" ");
    let vitest_index = words
        .iter()
        .position(|w| re_once!(r"(?:^|/)vitest/dist/cli\.js$").is_match(w));
    if words.first().map(String::as_str) == Some("npx")
        && words.get(1).map(String::as_str) == Some("tsx")
    {
        if let Some(vi) = vitest_index.filter(|&i| i >= 2) {
            return Some(
                format!("vitest {}", words[vi + 1..].join(" "))
                    .trim()
                    .to_string(),
            );
        }
    }
    if words.first().map(String::as_str) == Some("npm") {
        let prefix_index = words.iter().position(|w| w == "--prefix");
        let cwd = prefix_index.and_then(|i| words.get(i + 1)).cloned();
        if let Some(ri) = words.iter().position(|w| w == "run") {
            if let Some(next) = words.get(ri + 1) {
                let command = format!("npm {} {}", next, words[ri + 2..].join(" "))
                    .trim()
                    .to_string();
                return cwd
                    .map(|cwd| format!("{command} ({})", path_tail(&cwd)))
                    .or(Some(command));
            }
        }
    }
    if words.first().map(String::as_str) == Some("pnpm") {
        let cwd_index = words.iter().position(|w| w == "-C" || w == "--dir");
        let cwd = cwd_index.and_then(|i| words.get(i + 1)).cloned();
        if let Some(ci) = cwd_index {
            let rest: Vec<String> = words
                .into_iter()
                .enumerate()
                .filter(|(i, _)| *i != ci && *i != ci + 1)
                .map(|(_, w)| w)
                .collect();
            return cwd.map(|cwd| format!("{} ({})", rest.join(" "), path_tail(&cwd)));
        }
        return None;
    }
    // TS findIndex: word === "pytest" (the -m clause is unreachable there).
    if words.first().map(String::as_str) == Some("uv")
        && words.get(1).map(String::as_str) == Some("run")
    {
        if let Some(pi) = words.iter().position(|w| w == "pytest") {
            return Some(
                format!("pytest {}", words[pi + 1..].join(" "))
                    .trim()
                    .to_string(),
            );
        }
    }
    if matches!(
        words.first().map(String::as_str),
        Some("python" | "python3")
    ) && words.get(1).map(String::as_str) == Some("-m")
        && words.get(2).map(String::as_str) == Some("pytest")
    {
        return Some(
            format!("pytest {}", words[3..].join(" "))
                .trim()
                .to_string(),
        );
    }
    if joined.contains("node_modules/.bin/") {
        return Some(re_once!(r"\S*node_modules/\.bin/").replace_all(&joined, ""));
    }
    None
}

/// Shorten file-mutation commands (cat >, tee, `apply_patch`) for display.
fn simplify_mutation_command(line: &str) -> Option<String> {
    let words = shell_words(line);
    if words.is_empty() {
        return None;
    }
    let first = words[0].as_str();
    if first == "cat" && words.get(1).map(String::as_str) == Some(">") && words.len() > 2 {
        return Some(format!("write {}", path_tail(&words[2])));
    }
    if first == "tee" {
        if let Some(last) = words.last() {
            let action = if words.iter().any(|w| w == "-a") {
                "append"
            } else {
                "write"
            };
            return Some(format!("{action} {}", path_tail(last)));
        }
    }
    if first == "apply_patch" {
        return Some("apply patch".to_string());
    }
    if matches!(first, "rm" | "mv" | "cp" | "git" | "npm") {
        return Some(line.to_string());
    }
    if (first == "sed" && words.iter().any(|w| w.starts_with("-i")))
        || (first == "perl" && words.iter().any(|w| w == "-pi"))
    {
        return Some(line.to_string());
    }
    None
}

pub(crate) fn simplify_bash_command_line(line: &str) -> String {
    simplify_runner_command(line)
        .or_else(|| simplify_mutation_command(line))
        .unwrap_or_else(|| line.to_string())
}

/// Split a && b; c into its command segments.
pub(crate) fn split_command_chain(line: &str) -> Vec<String> {
    re_once!(r"\s*(?:&&|;)\s*")
        .split(line)
        .into_iter()
        .map(|p| js_trim(p).to_string())
        .filter(|p| !p.is_empty())
        .collect()
}

fn heredoc_body(lines: &[String], start_index: usize, delimiter: &str) -> Option<String> {
    // While args stream, preview the partial heredoc body rather than the
    // low-signal heredoc opener.
    let mut body: Vec<&str> = Vec::new();
    for line in lines.iter().skip(start_index + 1) {
        if js_trim(line) == delimiter {
            return Some(body.join("\n"));
        }
        body.push(line);
    }
    if body.is_empty() {
        None
    } else {
        Some(body.join("\n"))
    }
}

pub(crate) fn preview_heredoc(lines: &[String]) -> Option<CodePreview> {
    // A generic heredoc body is low-signal; keep it as a fallback and prefer a
    // later, more specific heredoc (python/bash/node/write) if one follows.
    let mut fallback: Option<CodePreview> = None;
    for (i, raw) in lines.iter().enumerate() {
        let line = strip_bash_prefix(raw);
        if is_skippable_bash_line(&line) {
            continue;
        }
        let captures = re_once!(r#"<<-?\s*['"]?([A-Za-z_][A-Za-z0-9_]*)['"]?"#).captures(&line);
        let delimiter = captures
            .as_ref()
            .and_then(|c| c.get(1))
            .map(|m| m.as_str().to_string());
        let delimiter = match delimiter {
            Some(d) => d,
            None => continue,
        };
        let body = match heredoc_body(lines, i, &delimiter) {
            Some(b) => b,
            None => continue,
        };
        if re_once!(format!(r"\b(?:uv{S}+run{S}+)?python3?\b")).is_match(&line) {
            let preview = preview_python_code(&body);
            if !preview.text.is_empty() {
                return Some(preview);
            }
            continue;
        }
        // Match bash/sh as an interpreter word (incl. /bin/sh), not a path
        // suffix like script.sh.
        if re_once!(r"(?<![\w.])(?:bash|sh)\b").is_match(&line) {
            let preview = preview_bash_command(&body);
            if !preview.text.is_empty() {
                return Some(preview);
            }
            return Some(CodePreview::bash(descriptor(&body)));
        }
        if re_once!(r"\bnode\b").is_match(&line) {
            return Some(CodePreview::bash(format!("node: {}", descriptor(&body))));
        }
        let cat_write = re_once!(r"\b(?:cat|tee)\b.*(?:>|\s)(\S+)\s*<<-?")
            .captures(&line)
            .and_then(|c| c.get(1))
            .map(|m| m.as_str().to_string());
        if let Some(target) = cat_write {
            let action = if line.contains("tee -a") {
                "append"
            } else {
                "write"
            };
            return Some(CodePreview::bash(format!(
                "{action} {}",
                path_tail(&target)
            )));
        }
        if re_once!(r"\bapply_patch\b").is_match(&line) {
            return Some(CodePreview::bash("apply patch".to_string()));
        }
        fallback = Some(CodePreview::bash(descriptor(&body)));
    }
    fallback
}

pub(crate) fn bash_line_score(line: &str, index: usize) -> usize {
    let simplified = simplify_bash_command_line(line);
    let words = shell_words(line);
    let mut score = 30usize;
    if simplified != line {
        score += 40;
    }
    if words.first().is_some_and(|w| {
        matches!(
            w.as_str(),
            "rm" | "mv" | "cp" | "git" | "npm" | "pnpm" | "pytest" | "vitest"
        )
    }) {
        score += 20;
    }
    if re_once!(format!(r"\b(?:rm|mv|cp|git{S}+(?:add|commit)|npm{S}+install|sed{S}+-i|perl{S}+-pi|tee|cat{S}*>|apply_patch)\b"))
        .is_match(line)
    {
        score += 40;
    }
    score + index
}

/// Pick the highest-signal line of a bash command as its preview.
pub fn preview_bash_command(command: &str) -> CodePreview {
    let lines: Vec<String> = command.split('\n').map(String::from).collect();
    let heredoc = preview_heredoc(&lines);
    if let Some(h) = heredoc.filter(|h| !h.text.is_empty()) {
        return CodePreview {
            language: h.language,
            text: descriptor(&h.text),
        };
    }

    let mut best: Option<(String, usize)> = None;
    let mut index = 0usize;
    for raw_line in &lines {
        for raw_part in split_command_chain(raw_line) {
            let command_line = strip_bash_prefix(js_trim(&raw_part));
            if command_line.is_empty() || is_skippable_bash_line(&command_line) {
                continue;
            }
            let text = simplify_bash_command_line(&command_line);
            let score = bash_line_score(&command_line, index);
            if best.as_ref().is_none_or(|(_, s)| score > *s) {
                best = Some((text, score));
            }
            index += 1;
        }
    }
    CodePreview::bash(best.map_or(String::new(), |(text, _)| descriptor(&text)))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn descriptor_truncates_at_64_units() {
        let long = "hello world ".repeat(12);
        let d = descriptor(&long);
        assert_eq!(utf16_len(&d), 64);
        assert!(d.ends_with('\u{2026}'));
    }

    #[test]
    fn redact_hides_tokens_and_blobs() {
        let text = "api_token = \"abc123\" and 01234567890123456789012345678901234567890123456789012345678901234567890123456789";
        let red = redact_noise(text);
        assert!(red.contains("api_token=<redacted>"));
        assert!(red.contains("<blob>"));
    }

    #[test]
    fn bash_preview_prefers_mutation_line() {
        let p = preview_bash_command("echo start && git commit -m x && ls");
        assert_eq!(p.text, "git commit -m x");
        assert_eq!(p.language, CodePreviewLanguage::Bash);
    }

    #[test]
    fn bash_preview_simplifies_npm_run() {
        let p = preview_bash_command("npm run test -- --watch");
        assert_eq!(p.text, "npm test -- --watch");
    }

    #[test]
    fn bash_preview_heredoc_python() {
        let cmd = "python3 <<'EOF'\nprint('hi')\nEOF";
        let p = preview_bash_command(cmd);
        assert_eq!(p.text, "print('hi')");
    }

    #[test]
    fn python_preview_file_operation() {
        let code = "p = Path('src/a.ts')\nprint('x')\np.write_text('data')";
        let p = preview_python_code(code);
        assert_eq!(p.text, "write src/a.ts");
        assert_eq!(p.language, CodePreviewLanguage::Python);
    }

    #[test]
    fn python_preview_bash_skill_call() {
        let code = "print('x')\nawait bash(\"git status --porcelain\")";
        let p = preview_python_code(code);
        assert_eq!(p.language, CodePreviewLanguage::Bash);
        assert_eq!(p.text, "git status --porcelain");
    }

    #[test]
    fn ipython_cell_magic_preview() {
        let p = preview_ipython_code("%%bash\necho hi");
        assert_eq!(p.language, CodePreviewLanguage::Bash);
        assert_eq!(p.text, "echo hi");
    }

    #[test]
    fn statement_lines_mask_multiline_strings() {
        let code = "x = \"\"\"\na\nb\n\"\"\"\nrun(1)";
        let lines = python_statement_lines(code);
        assert_eq!(lines[0], "x = \"\"\"");
        assert_eq!(lines[3].trim(), "");
        assert_eq!(lines[4], "run(1)");
    }
}

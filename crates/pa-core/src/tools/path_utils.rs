//! Path expansion and resolution helpers.
//!
//! Port of `packages/coding-agent/src/core/tools/path-utils.ts` (POSIX behavior).

use std::path::Path;

use unicode_normalization::UnicodeNormalization;

/// U+00A0, U+2000-U+200A, U+202F, U+205F, U+3000 -> regular space.
fn is_unicode_space(ch: char) -> bool {
    matches!(ch, '\u{00A0}' | '\u{202F}' | '\u{205F}' | '\u{3000}')
        || ('\u{2000}'..='\u{200A}').contains(&ch)
}

fn normalize_unicode_spaces(s: &str) -> String {
    s.chars()
        .map(|ch| if is_unicode_space(ch) { ' ' } else { ch })
        .collect()
}

/// Replace " AM." / " PM." (case-insensitive) with a narrow no-break space variant.
fn try_macos_screenshot_path(file_path: &str) -> String {
    let mut out = String::with_capacity(file_path.len());
    let chars: Vec<char> = file_path.chars().collect();
    let mut i = 0;
    while i < chars.len() {
        if chars[i] == ' '
            && i + 3 < chars.len()
            && (chars[i + 1] == 'A'
                || chars[i + 1] == 'a'
                || chars[i + 1] == 'P'
                || chars[i + 1] == 'p')
            && (chars[i + 2] == 'M' || chars[i + 2] == 'm')
            && chars[i + 3] == '.'
        {
            out.push('\u{202F}');
            out.push(chars[i + 1].to_ascii_uppercase());
            out.push('M');
            out.push('.');
            i += 4;
        } else {
            out.push(chars[i]);
            i += 1;
        }
    }
    out
}

fn try_nfd_variant(file_path: &str) -> String {
    file_path.chars().nfd().collect()
}

fn try_curly_quote_variant(file_path: &str) -> String {
    file_path.replace('\'', "\u{2019}")
}

fn file_exists(file_path: &str) -> bool {
    Path::new(file_path).exists()
}

fn normalize_at_prefix(file_path: &str) -> &str {
    file_path.strip_prefix('@').unwrap_or(file_path)
}

/// Expand a leading `~` (and, on Windows, `~\\`) to the user's home
/// directory (TS `expandPath`).
pub fn expand_path(file_path: &str) -> String {
    let home = pa_types::platform::home_dir().map(|home| home.to_string_lossy().into_owned());
    expand_path_platform(file_path, home.as_deref())
}

fn expand_path_platform(file_path: &str, home: Option<&str>) -> String {
    let normalized = normalize_unicode_spaces(normalize_at_prefix(file_path));
    let Some(home) = home else { return normalized };
    if normalized == "~" {
        return home.to_string();
    }
    if let Some(rest) = normalized.strip_prefix("~/") {
        return path_join(home, rest);
    }
    #[cfg(windows)]
    if let Some(rest) = normalized.strip_prefix("~\\") {
        return path_join(home, rest);
    }
    normalized
}

/// Node `path.join(a, b)` for the expansion: `path.posix.join` on POSIX,
/// `path.win32.join` on Windows (TS `expandPath` picks per platform).
fn path_join(a: &str, b: &str) -> String {
    #[cfg(windows)]
    {
        win32_join(a, b)
    }
    #[cfg(not(windows))]
    {
        posix_join(a, b)
    }
}

/// Node `path.posix.join(a, b)`: single-slash separation plus lexical normalization.
fn posix_join(a: &str, b: &str) -> String {
    let mut segments: Vec<String> = Vec::new();
    for part in [a, b] {
        for seg in part.split('/') {
            match seg {
                "" => {}
                "." => {}
                ".." => {
                    segments.pop();
                }
                other => segments.push(other.to_string()),
            }
        }
    }
    let mut joined = segments.join("/");
    if a.starts_with('/') {
        joined.insert(0, '/');
    }
    if joined.is_empty() {
        joined.push('.');
    }
    joined
}

/// Node `path.win32.join(a, b)`: backslash separation plus lexical
/// normalization with both `/` and `\\` as segment boundaries.
#[cfg(windows)]
fn win32_join(a: &str, b: &str) -> String {
    let mut segments: Vec<String> = Vec::new();
    for part in [a, b] {
        for seg in part.split(['/', '\\']) {
            match seg {
                "" | "." => {}
                ".." => {
                    segments.pop();
                }
                other => segments.push(other.to_string()),
            }
        }
    }
    let mut joined = segments.join("\\");
    if a.starts_with('\\') {
        joined.insert(0, '\\');
    }
    if joined.is_empty() {
        joined.push('.');
    }
    joined
}

/// Node `path.resolve(...)` for POSIX: right-to-left resolution with lexical
/// normalization of `.` and `..` segments.
pub fn node_path_resolve(base: &str, path: &str) -> String {
    let mut absolute: Option<Vec<String>> = None;

    for part in [base, path] {
        if part.starts_with('/') {
            absolute = Some(Vec::new());
        } else if absolute.is_none() {
            // Neither is absolute: Node resolves against process.cwd().
            let cwd = std::env::current_dir().unwrap_or_default();
            let cwd = cwd.to_string_lossy().to_string();
            absolute = Some(
                cwd.split('/')
                    .filter(|s| !s.is_empty())
                    .map(String::from)
                    .collect(),
            );
        }
        let segs = absolute.get_or_insert_with(Vec::new);
        for seg in part.split('/') {
            match seg {
                "" | "." => {}
                ".." => {
                    segs.pop();
                }
                other => segs.push(other.to_string()),
            }
        }
    }

    let mut joined = absolute.unwrap_or_default().join("/");
    if !joined.starts_with('/') {
        joined.insert(0, '/');
    }
    joined
}

/// Node `path.isAbsolute` (POSIX).
fn is_absolute(p: &str) -> bool {
    p.starts_with('/')
}

/// Resolve a path relative to the given cwd. Handles ~ expansion and absolute paths.
pub fn resolve_to_cwd(file_path: &str, cwd: &str) -> String {
    let expanded = expand_path(file_path);
    if is_absolute(&expanded) {
        return expanded;
    }
    node_path_resolve(cwd, &expanded)
}

/// Resolve a path relative to cwd, retrying with macOS filename variants
/// (narrow no-break space in " AM."/" PM.", NFD decomposition, curly apostrophes).
pub fn resolve_read_path(file_path: &str, cwd: &str) -> String {
    let resolved = resolve_to_cwd(file_path, cwd);

    if file_exists(&resolved) {
        return resolved;
    }

    let am_pm_variant = try_macos_screenshot_path(&resolved);
    if am_pm_variant != resolved && file_exists(&am_pm_variant) {
        return am_pm_variant;
    }

    let nfd_variant = try_nfd_variant(&resolved);
    if nfd_variant != resolved && file_exists(&nfd_variant) {
        return nfd_variant;
    }

    let curly_variant = try_curly_quote_variant(&resolved);
    if curly_variant != resolved && file_exists(&curly_variant) {
        return curly_variant;
    }

    let nfd_curly_variant = try_curly_quote_variant(&nfd_variant);
    if nfd_curly_variant != resolved && file_exists(&nfd_curly_variant) {
        return nfd_curly_variant;
    }

    resolved
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn expand_tilde() {
        assert_eq!(expand_path_platform("~", Some("/home/u")), "/home/u");
        assert_eq!(
            expand_path_platform("~/sub/x", Some("/home/u")),
            "/home/u/sub/x"
        );
        assert_eq!(expand_path_platform("/abs", Some("/home/u")), "/abs");
        assert_eq!(expand_path_platform("rel", Some("/home/u")), "rel");
        // Non-breaking space after ~/ becomes a regular space.
        assert_eq!(
            expand_path_platform("~/\u{00A0}x", Some("/home/u")),
            "/home/u/ x"
        );
    }

    #[test]
    fn strips_at_prefix() {
        assert_eq!(expand_path_platform("@~/f", Some("/h")), "/h/f");
    }

    #[test]
    fn resolve_relative() {
        assert_eq!(resolve_to_cwd("a/b", "/cwd"), "/cwd/a/b");
        assert_eq!(resolve_to_cwd("../a", "/cwd/sub"), "/cwd/a");
        assert_eq!(resolve_to_cwd("/abs/x", "/cwd"), "/abs/x");
    }

    #[test]
    fn node_resolve_matches_node_semantics() {
        assert_eq!(node_path_resolve("/a/b", "c/../d"), "/a/b/d");
        assert_eq!(node_path_resolve("/a/b", "/x"), "/x");
        assert_eq!(node_path_resolve("/a/b", "./x"), "/a/b/x");
        assert_eq!(node_path_resolve("/a/b", "../x"), "/a/x");
        assert_eq!(node_path_resolve("/a/b", "..//x"), "/a/x");
    }
}

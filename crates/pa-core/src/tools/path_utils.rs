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
                "" | "." => {}
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

/// Node `path.resolve(base, path)`: `path.win32.resolve` on Windows,
/// `path.posix.resolve` on POSIX - TS `resolveToCwd` calls the
/// platform-picked module, so a `C:\...` input stays absolute here and
/// a relative tail resolves against the tool's cwd on both platforms.
pub fn node_path_resolve(base: &str, path: &str) -> String {
    #[cfg(windows)]
    {
        win32_node_path_resolve(base, path)
    }
    #[cfg(not(windows))]
    {
        posix_node_path_resolve(base, path)
    }
}

/// Node `path.posix.resolve(base, path)`: right-to-left resolution with
/// lexical normalization of `.` and `..` segments.
#[cfg(not(windows))]
fn posix_node_path_resolve(base: &str, path: &str) -> String {
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

/// Node `path.isAbsolute`: `path.win32.isAbsolute` on Windows,
/// `path.posix.isAbsolute` on POSIX.
fn is_absolute(p: &str) -> bool {
    #[cfg(windows)]
    {
        win32_is_absolute(p)
    }
    #[cfg(not(windows))]
    {
        p.starts_with('/')
    }
}

/// Node `path.js` `isPathSeparator` in the win32 module: `/` and `\`.
#[cfg(any(windows, test))]
fn win32_is_path_separator(c: char) -> bool {
    c == '/' || c == '\\'
}

/// Node `path.win32.isAbsolute`: a leading path separator, or a drive
/// prefix whose third character is a separator (a device root; Node's
/// `len > 2` rule). A device-relative `C:file` is NOT absolute.
#[cfg(any(windows, test))]
fn win32_is_absolute(p: &str) -> bool {
    let mut chars = p.chars();
    let Some(first) = chars.next() else {
        return false;
    };
    if win32_is_path_separator(first) {
        return true;
    }
    // Possible device root: `[A-Za-z]:[\\/]`.
    first.is_ascii_alphabetic()
        && chars.next() == Some(':')
        && chars.next().is_some_and(win32_is_path_separator)
}

/// Node `path.js` `normalizeString` (the win32 module's): lexical folding
/// of `.` and `..` over separator-split segments. `allow_above_root` keeps
/// leading `..` segments (a relative tail); otherwise they clamp at the
/// root. Repeated separators collapse; a trailing separator does not
/// survive.
#[cfg(any(windows, test))]
fn win32_normalize_string(path: &str, allow_above_root: bool) -> String {
    let chars: Vec<char> = path.chars().collect();
    let mut res = String::new();
    let mut last_segment_length = 0usize;
    let mut last_slash: i64 = -1;
    let mut dots = 0i64;
    let mut code = '\0';
    for i in 0..=chars.len() {
        if i < chars.len() {
            code = chars[i];
        } else if win32_is_path_separator(code) {
            break;
        } else {
            code = '/';
        }
        if win32_is_path_separator(code) {
            if last_slash == i as i64 - 1 || dots == 1 {
                // A repeated separator or an isolated `.` segment: dropped.
            } else if dots == 2 {
                if res.len() < 2 || last_segment_length != 2 || !res.ends_with("..") {
                    if res.len() > 2 {
                        match res.rfind('\\') {
                            None => {
                                res.clear();
                                last_segment_length = 0;
                            }
                            Some(index) => {
                                res.truncate(index);
                                last_segment_length =
                                    res.rfind('\\').map_or(0, |slash| res.len() - 1 - slash);
                            }
                        }
                        last_slash = i as i64;
                        dots = 0;
                        continue;
                    } else if !res.is_empty() {
                        res.clear();
                        last_segment_length = 0;
                        last_slash = i as i64;
                        dots = 0;
                        continue;
                    }
                }
                if allow_above_root {
                    if res.is_empty() {
                        res.push_str("..");
                    } else {
                        res.push_str("\\..");
                    }
                    last_segment_length = 2;
                }
            } else {
                // A normal segment.
                let segment: String = chars[(last_slash + 1).max(0) as usize..i].iter().collect();
                if res.is_empty() {
                    res = segment;
                } else {
                    res.push('\\');
                    res.push_str(&segment);
                }
                last_segment_length = (i as i64 - last_slash - 1).max(0) as usize;
            }
            last_slash = i as i64;
            dots = 0;
        } else if code == '.' && dots != -1 {
            dots += 1;
        } else {
            dots = -1;
        }
    }
    res
}

/// Node `path.win32.resolve(base, path)`: right-to-left resolution with
/// drive tracking - a device-relative `D:file` tail resolves against that
/// drive's working directory (Node's `=<device>` environment convention,
/// then the process cwd when it sits on the drive, else the drive root) -
/// plus UNC roots and lexical `.`/`..` normalization over `/`- and
/// `\`-separated segments. Step-for-step the Node `path.js` algorithm;
/// the fixture tests below pin it against Node's own outputs.
#[cfg(any(windows, test))]
fn win32_node_path_resolve(base: &str, path: &str) -> String {
    win32_resolve_with(base, path, &win32_device_cwd)
}

/// Node's drive-specific cwd lookup: the `=<device>` environment
/// convention, else the process cwd (the caller's drive check decides
/// whether the answer applies).
#[cfg(any(windows, test))]
fn win32_device_cwd(device: &str) -> String {
    std::env::var_os(format!("={device}"))
        .map(|value| value.to_string_lossy().into_owned())
        .unwrap_or_else(|| {
            std::env::current_dir()
                .unwrap_or_default()
                .to_string_lossy()
                .into_owned()
        })
}

/// The resolver core, with the drive-cwd lookup injected so the drive
/// convention is testable without mutating the process environment.
#[cfg(any(windows, test))]
fn win32_resolve_with(base: &str, path: &str, device_cwd: &dyn Fn(&str) -> String) -> String {
    let mut resolved_device = String::new();
    let mut resolved_tail = String::new();
    let mut resolved_absolute = false;

    for i in [1i64, 0, -1] {
        let part: String = if i >= 0 {
            // Skip empty entries; Node keeps scanning right-to-left.
            match if i == 1 { path } else { base } {
                "" => continue,
                part => part.to_string(),
            }
        } else if resolved_device.is_empty() {
            std::env::current_dir()
                .unwrap_or_default()
                .to_string_lossy()
                .into_owned()
        } else {
            // Windows has drive-specific current working directories. A
            // resolved drive letter without an absolute path resolves
            // against that drive's cwd (Node's `=<device>` convention),
            // else the process cwd - unless the process cwd itself sits
            // on a different drive, where the drive root is the answer.
            let candidate = device_cwd(&resolved_device);
            let same_drive = candidate
                .get(..2)
                .is_some_and(|prefix| prefix.eq_ignore_ascii_case(&resolved_device));
            if !same_drive && candidate.chars().nth(2) == Some('\\') {
                format!("{resolved_device}\\")
            } else {
                candidate
            }
        };
        let chars: Vec<char> = part.chars().collect();
        let len = chars.len();
        let mut root_end = 0usize;
        let mut device = String::new();
        let mut is_absolute = false;
        let first = chars.first().copied().unwrap_or('\0');
        if len == 1 {
            if win32_is_path_separator(first) {
                root_end = 1;
                is_absolute = true;
            }
        } else if win32_is_path_separator(first) {
            // A leading separator is at least a rooted absolute path.
            is_absolute = true;
            if len > 1 && win32_is_path_separator(chars[1]) {
                // Possible UNC root: `\\server\\share...`.
                let mut j = 2;
                let mut last = 2;
                while j < len && !win32_is_path_separator(chars[j]) {
                    j += 1;
                }
                if j < len && j != last {
                    let server: String = chars[last..j].iter().collect();
                    last = j;
                    while j < len && win32_is_path_separator(chars[j]) {
                        j += 1;
                    }
                    if j < len && j != last {
                        last = j;
                        while j < len && !win32_is_path_separator(chars[j]) {
                            j += 1;
                        }
                        if j == len || j != last {
                            // A matched UNC root.
                            let share: String = chars[last..j].iter().collect();
                            device = format!("\\\\{server}\\{share}");
                            root_end = j;
                        }
                    }
                }
            } else {
                root_end = 1;
            }
        } else if first.is_ascii_alphabetic() && chars.get(1) == Some(&':') {
            // Possible device root: `X:...`.
            device = chars[..2].iter().collect();
            root_end = 2;
            if len > 2 && win32_is_path_separator(chars[2]) {
                is_absolute = true;
                root_end = 3;
            }
        }
        if !device.is_empty() {
            if !resolved_device.is_empty() {
                if !device.eq_ignore_ascii_case(&resolved_device) {
                    // This path points to another device so it is not
                    // applicable.
                    continue;
                }
            } else {
                resolved_device = device;
            }
        }
        if resolved_absolute {
            if !resolved_device.is_empty() {
                break;
            }
        } else {
            let tail: String = chars[root_end.min(len)..].iter().collect();
            resolved_tail = format!("{tail}\\{resolved_tail}");
            resolved_absolute = is_absolute;
            if is_absolute && !resolved_device.is_empty() {
                break;
            }
        }
    }

    resolved_tail = win32_normalize_string(&resolved_tail, !resolved_absolute);
    if resolved_absolute {
        format!("{resolved_device}\\{resolved_tail}")
    } else {
        let joined = format!("{resolved_device}{resolved_tail}");
        if joined.is_empty() {
            ".".to_string()
        } else {
            joined
        }
    }
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

    /// The Node fixture table for `path.win32.resolve` and
    /// `path.win32.isAbsolute`, generated against Node itself
    /// (`node -e` over the same inputs). The port must match Node's
    /// outputs exactly: the edit tool resolves user paths through
    /// this on Windows (TS `resolveToCwd` uses the platform module).
    /// Deterministic rows only - the device-relative fallback reads the
    /// process cwd when the `=<device>` convention is unset, which a
    /// parallel test cannot pin.
    #[test]
    fn win32_resolve_matches_node_outputs() {
        let cases = [
            // (base, input, expected)
            (r"C:\cwd\dir", r"C:\a\b\c.txt", r"C:\a\b\c.txt"),
            (r"C:\cwd\dir", r"a\b.txt", r"C:\cwd\dir\a\b.txt"),
            (r"C:\cwd\dir", r"a/b.txt", r"C:\cwd\dir\a\b.txt"),
            (r"C:\cwd\dir", r".\a.txt", r"C:\cwd\dir\a.txt"),
            (r"C:\cwd\dir", r"..\a.txt", r"C:\cwd\a.txt"),
            (r"C:\cwd\dir", r"a\..\..\z.txt", r"C:\cwd\z.txt"),
            (r"C:\cwd\dir", "/foo.txt", r"C:\foo.txt"),
            (r"C:\cwd\dir", r"\foo.txt", r"C:\foo.txt"),
            (
                r"C:\cwd\dir",
                r"\\server\share\f.txt",
                r"\\server\share\f.txt",
            ),
            (r"C:\cwd\dir", r"D:\work\f.txt", r"D:\work\f.txt"),
            (r"C:\cwd\dir", "C:rel.txt", r"C:\cwd\dir\rel.txt"),
            (r"C:\cwd\dir", "", r"C:\cwd\dir"),
            (r"C:\cwd\dir", r"C:\", r"C:\"),
            (r"C:\cwd\dir", r"a\", r"C:\cwd\dir\a"),
            (r"C:\cwd\dir", "..", r"C:\cwd"),
            (r"C:\cwd\dir", "C:/a/b/../c", r"C:\a\c"),
            (
                r"\\server\share\cwd",
                r"rel\f.txt",
                r"\\server\share\cwd\rel\f.txt",
            ),
            (r"\\server\share\cwd", r"C:\abs.txt", r"C:\abs.txt"),
        ];
        for (base, input, expected) in cases {
            assert_eq!(
                win32_node_path_resolve(base, input),
                expected,
                "resolve({base:?}, {input:?})"
            );
        }

        let absolute = [
            (r"C:\", true),
            ("C:/x", true),
            ("D:work", false),
            ("/x", true),
            (r"\x", true),
            (r"\\server\share", true),
            ("", false),
            ("C:rel", false),
            ("foo", false),
            ("C", false),
            (":", false),
        ];
        for (input, expected) in absolute {
            assert_eq!(win32_is_absolute(input), expected, "isAbsolute({input:?})");
        }
    }

    /// Node's drive-specific cwd convention: a device-relative tail
    /// resolves against that drive's cwd when the convention answers
    /// (Node's `=<device>` fallback order), and against the DRIVE ROOT
    /// when the answered cwd sits on a different drive (the injected
    /// lookup keeps the test off the process environment).
    #[test]
    fn win32_resolve_honors_the_drive_cwd_convention() {
        assert_eq!(
            win32_resolve_with(
                r"C:\cwd",
                r"Q:rel\f.txt",
                &|device| {
                    assert_eq!(device, "Q:", "the lookup sees the resolved drive");
                    r"Q:\custom".to_string()
                }
            ),
            r"Q:\custom\rel\f.txt"
        );
        // A drive cwd on a DIFFERENT drive is not the answer: the drive
        // root is (Node's `path.charCodeAt(2) === CHAR_BACKWARD_SLASH`
        // guard).
        assert_eq!(
            win32_resolve_with(r"C:\cwd", r"Q:rel\f.txt", &|_| r"D:\other".to_string()),
            r"Q:\rel\f.txt"
        );
    }
}

//! Resource-filter patterns: plain and glob includes, `!` excludes, and the
//! `+`/`-` force-include/force-exclude override forms, applied against paths
//! relative to a base directory.
//!
//! Matching is minimatch-compatible via globset with literal separators:
//! `*` and `?` never cross `/`, `**` spans segments, character classes and
//! brace alternates work. A pattern that fails to compile matches nothing
//! (the TS product treats invalid patterns as non-matches).

use std::path::{Path, PathBuf};

use globset::GlobBuilder;

/// True when the entry is a pattern rather than a plain path: `!`/`+`/`-`
/// override prefixes or glob metacharacters.
pub(crate) fn is_pattern(entry: &str) -> bool {
    entry.starts_with('!')
        || entry.starts_with('+')
        || entry.starts_with('-')
        || entry.contains('*')
        || entry.contains('?')
}

/// True when the entry is one of the `!`/`+`/`-` override forms.
pub(crate) fn is_override_pattern(entry: &str) -> bool {
    entry.starts_with('!') || entry.starts_with('+') || entry.starts_with('-')
}

/// True when the entry contains glob metacharacters.
pub(crate) fn has_glob_pattern(entry: &str) -> bool {
    entry.contains('*') || entry.contains('?')
}

/// Split entries into plain paths and patterns.
pub(crate) fn split_patterns(entries: &[String]) -> (Vec<String>, Vec<String>) {
    let mut plain = Vec::new();
    let mut patterns = Vec::new();
    for entry in entries {
        if is_pattern(entry) {
            patterns.push(entry.clone());
        } else {
            plain.push(entry.clone());
        }
    }
    (plain, patterns)
}

/// The `!`/`+`/`-` entries of a pattern list.
fn override_patterns(patterns: &[String]) -> Vec<String> {
    patterns
        .iter()
        .filter(|pattern| is_override_pattern(pattern))
        .cloned()
        .collect()
}

fn to_posix(value: &str) -> String {
    value.replace('\\', "/")
}

fn path_to_posix(path: &Path) -> String {
    to_posix(&path.to_string_lossy())
}

/// minimatch-style single-pattern match over a posix path string.
pub(crate) fn minimatch(value: &str, pattern: &str) -> bool {
    let Ok(glob) = GlobBuilder::new(pattern)
        .literal_separator(true)
        .backslash_escape(true)
        .build()
    else {
        return false;
    };
    glob.compile_matcher().is_match(value)
}

/// The relative-path, basename, and full-path match candidates for a file,
/// plus the parent-directory candidates when the file is a `SKILL.md` (the
/// skill is named by its directory, so patterns may target either).
struct MatchCandidates {
    rel: String,
    name: String,
    full: String,
    parent_rel: Option<String>,
    parent_name: Option<String>,
    parent_full: Option<String>,
}

fn match_candidates(file_path: &Path, base_dir: &Path) -> MatchCandidates {
    let name = file_path
        .file_name()
        .map(|name| name.to_string_lossy().into_owned())
        .unwrap_or_default();
    let is_skill_file = name == "SKILL.md";
    let (parent_rel, parent_name, parent_full) = if is_skill_file {
        let parent = file_path.parent().unwrap_or(file_path);
        (
            Some(super::super::source::path_relative(base_dir, parent)),
            Some(
                parent
                    .file_name()
                    .map(|name| name.to_string_lossy().into_owned())
                    .unwrap_or_default(),
            ),
            Some(path_to_posix(parent)),
        )
    } else {
        (None, None, None)
    };
    MatchCandidates {
        rel: super::super::source::path_relative(base_dir, file_path),
        name,
        full: path_to_posix(file_path),
        parent_rel,
        parent_name,
        parent_full,
    }
}

/// True when the file matches any glob pattern, tested against its path
/// relative to the base dir, its basename, and its full path (plus the
/// parent-directory forms for `SKILL.md` files).
pub(crate) fn matches_any_pattern(file_path: &Path, patterns: &[String], base_dir: &Path) -> bool {
    let candidates = match_candidates(file_path, base_dir);
    patterns.iter().any(|pattern| {
        let normalized = to_posix(pattern);
        minimatch(&candidates.rel, &normalized)
            || minimatch(&candidates.name, &normalized)
            || minimatch(&candidates.full, &normalized)
            || candidates
                .parent_rel
                .as_deref()
                .is_some_and(|parent_rel| minimatch(parent_rel, &normalized))
            || candidates
                .parent_name
                .as_deref()
                .is_some_and(|parent_name| minimatch(parent_name, &normalized))
            || candidates
                .parent_full
                .as_deref()
                .is_some_and(|parent_full| minimatch(parent_full, &normalized))
    })
}

/// Strip a leading `./` and normalize separators (exact-pattern form).
fn normalize_exact_pattern(pattern: &str) -> String {
    let stripped = pattern
        .strip_prefix("./")
        .or_else(|| pattern.strip_prefix(".\\"))
        .unwrap_or(pattern);
    to_posix(stripped)
}

/// True when the file equals any exact pattern: its path relative to the
/// base dir or its full path (plus parent-directory forms for `SKILL.md`).
pub(crate) fn matches_any_exact_pattern(
    file_path: &Path,
    patterns: &[String],
    base_dir: &Path,
) -> bool {
    if patterns.is_empty() {
        return false;
    }
    let candidates = match_candidates(file_path, base_dir);
    patterns.iter().any(|pattern| {
        let normalized = normalize_exact_pattern(pattern);
        normalized == candidates.rel
            || normalized == candidates.full
            || candidates.parent_rel.as_deref() == Some(normalized.as_str())
            || candidates.parent_full.as_deref() == Some(normalized.as_str())
    })
}

/// Override-only enablement: `!` excludes, `+` force-includes (exact),
/// `-` force-excludes (exact, applied last).
pub(crate) fn is_enabled_by_overrides(
    file_path: &Path,
    patterns: &[String],
    base_dir: &Path,
) -> bool {
    let overrides = override_patterns(patterns);
    let excludes: Vec<String> = overrides
        .iter()
        .filter_map(|pattern| pattern.strip_prefix('!'))
        .map(str::to_string)
        .collect();
    let force_includes: Vec<String> = overrides
        .iter()
        .filter_map(|pattern| pattern.strip_prefix('+'))
        .map(str::to_string)
        .collect();
    let force_excludes: Vec<String> = overrides
        .iter()
        .filter_map(|pattern| pattern.strip_prefix('-'))
        .map(str::to_string)
        .collect();

    let mut enabled = true;
    if !excludes.is_empty() && matches_any_pattern(file_path, &excludes, base_dir) {
        enabled = false;
    }
    if !force_includes.is_empty() && matches_any_exact_pattern(file_path, &force_includes, base_dir)
    {
        enabled = true;
    }
    if !force_excludes.is_empty() && matches_any_exact_pattern(file_path, &force_excludes, base_dir)
    {
        enabled = false;
    }
    enabled
}

/// Apply include/exclude/force-include/force-exclude patterns to a list of
/// paths and return the enabled ones (input order preserved).
///
/// Order of application: includes, excludes, force-includes, force-excludes.
pub(crate) fn apply_patterns(
    all_paths: &[PathBuf],
    patterns: &[String],
    base_dir: &Path,
) -> Vec<PathBuf> {
    let mut includes: Vec<String> = Vec::new();
    let mut excludes: Vec<String> = Vec::new();
    let mut force_includes: Vec<String> = Vec::new();
    let mut force_excludes: Vec<String> = Vec::new();
    for pattern in patterns {
        if let Some(rest) = pattern.strip_prefix('+') {
            force_includes.push(rest.to_string());
        } else if let Some(rest) = pattern.strip_prefix('-') {
            force_excludes.push(rest.to_string());
        } else if let Some(rest) = pattern.strip_prefix('!') {
            excludes.push(rest.to_string());
        } else {
            includes.push(pattern.clone());
        }
    }

    let mut result: Vec<PathBuf> = if includes.is_empty() {
        all_paths.to_vec()
    } else {
        all_paths
            .iter()
            .filter(|path| matches_any_pattern(path, &includes, base_dir))
            .cloned()
            .collect()
    };
    if !excludes.is_empty() {
        result.retain(|path| !matches_any_pattern(path, &excludes, base_dir));
    }
    if !force_includes.is_empty() {
        for path in all_paths {
            if !result.contains(path) && matches_any_exact_pattern(path, &force_includes, base_dir)
            {
                result.push(path.clone());
            }
        }
    }
    if !force_excludes.is_empty() {
        result.retain(|path| !matches_any_exact_pattern(path, &force_excludes, base_dir));
    }
    result
}

/// `globSync`-equivalent discovery: every filesystem path under `root`
/// (directories included) matching the glob, as absolute paths in
/// lexicographic order. Dotfiles are only matched when the pattern itself
/// references a dot-prefixed segment.
pub(crate) fn glob_paths(pattern: &str, root: &Path) -> Vec<PathBuf> {
    let pattern = pattern
        .strip_prefix("./")
        .map_or_else(|| pattern.to_string(), str::to_string);
    let Ok(glob) = GlobBuilder::new(&pattern)
        .literal_separator(true)
        .backslash_escape(true)
        .build()
    else {
        return Vec::new();
    };
    let matcher = glob.compile_matcher();
    let allow_dot = pattern.starts_with('.') || pattern.contains("/.");

    let mut matches = Vec::new();
    let mut queue = vec![root.to_path_buf()];
    while let Some(dir) = queue.pop() {
        let Ok(entries) = std::fs::read_dir(&dir) else {
            continue;
        };
        let mut children: Vec<PathBuf> = entries
            .filter_map(|entry| entry.ok().map(|entry| entry.path()))
            .collect();
        children.sort();
        for child in children {
            let Ok(meta) = std::fs::metadata(&child) else {
                continue; // broken symlink or unreadable entry
            };
            let rel = super::super::source::path_relative(root, &child);
            if !rel.is_empty()
                && !allow_dot
                && rel.split('/').any(|segment| segment.starts_with('.'))
            {
                continue;
            }
            if !rel.is_empty() && matcher.is_match(&rel) {
                matches.push(child.clone());
            }
            if meta.is_dir() {
                queue.push(child);
            }
        }
    }
    matches.sort();
    matches
}

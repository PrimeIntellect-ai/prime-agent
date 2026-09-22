//! Session discovery: header-only session scans and the `--resume` selector
//! resolver. Port of `session-resolver.ts` plus the header scanning from
//! `session-manager.ts` (`findMostRecentSessionForCwd`): the CLI turns a
//! user selector into a concrete session file path, or a typed selector
//! error the caller renders.

use std::path::{Path, PathBuf};

use super::manager::read_session_header;

/// The minimum normalized length before a "did you mean" suggestion is offered.
const SUGGESTION_MIN_LENGTH: usize = 4;

/// One line of a session header, as the resolver needs it.
#[derive(Debug, Clone)]
pub struct SessionHeaderInfo {
    pub path: PathBuf,
    pub id: String,
    pub cwd: String,
}

/// Where a `--resume` selector resolved to, mirroring `ResolvedSession`.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum ResolvedSession {
    /// The selector was path-like and is used as-is.
    Path(PathBuf),
    /// A saved session whose cwd matches the current one.
    Local(PathBuf),
    /// A saved session belonging to a different project.
    Global { path: PathBuf, cwd: PathBuf },
}

/// A `--resume` selector failure, mirroring `SessionSelectorError`.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum SessionSelectorError {
    /// No session matched; may carry a "did you mean" suggestion.
    NotFound {
        selector: String,
        suggestion: Option<String>,
    },
    /// More than one session matched.
    Ambiguous {
        selector: String,
        matches: Vec<String>,
    },
}

impl SessionSelectorError {
    /// The error message body, matching the TS constructor text.
    pub fn message(&self) -> String {
        match self {
            SessionSelectorError::NotFound { selector, .. } => {
                format!("No session found matching '{selector}'")
            }
            SessionSelectorError::Ambiguous { selector, matches } => {
                format!(
                    "Ambiguous saved session \"{selector}\": matches {}",
                    matches.join(", ")
                )
            }
        }
    }

    /// The suggestion sentence main appends to a not-found error.
    pub fn suggestion(&self) -> Option<String> {
        match self {
            SessionSelectorError::NotFound {
                suggestion: Some(suggestion),
                ..
            } => Some(format!(" Did you mean '{suggestion}'?")),
            _ => None,
        }
    }
}

impl std::fmt::Display for SessionSelectorError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str(&self.message())
    }
}

impl std::error::Error for SessionSelectorError {}

/// `normalizeSessionId`: strip id separators and lowercase.
fn normalize_session_id(id: &str) -> String {
    id.replace('-', "").to_lowercase()
}

/// Hex session ids normalize to bare alphanumeric; other ids stay text.
fn normalize_hex_session_id(id: &str) -> Option<String> {
    let normalized = normalize_session_id(id);
    (!normalized.is_empty() && normalized.bytes().all(|b| b.is_ascii_hexdigit()))
        .then_some(normalized)
}

/// `looksLikeSessionPath`: separators or a `.jsonl` suffix mean a path.
pub fn looks_like_session_path(selector: &str) -> bool {
    selector.contains('/') || selector.contains('\\') || selector.ends_with(".jsonl")
}

/// `normalizeCwd`: an absolute path without symlink resolution.
fn normalize_cwd(cwd: &Path) -> PathBuf {
    std::path::absolute(cwd).unwrap_or_else(|_| cwd.to_path_buf())
}

/// True when a session header's cwd matches the given cwd.
fn header_matches_cwd(header: &SessionHeaderInfo, cwd: &Path) -> bool {
    !header.cwd.is_empty() && normalize_cwd(Path::new(&header.cwd)) == normalize_cwd(cwd)
}

/// Scan a session directory for valid session headers (invalid files skip).
pub fn scan_session_headers(session_dir: &Path) -> Vec<SessionHeaderInfo> {
    let mut headers = Vec::new();
    let Ok(entries) = std::fs::read_dir(session_dir) else {
        return headers;
    };
    for entry in entries.flatten() {
        let path = entry.path();
        if path.extension().and_then(|ext| ext.to_str()) != Some("jsonl") {
            continue;
        }
        if let Some(header) = read_session_header(&path) {
            if header.id.is_empty() || header.cwd.is_empty() {
                continue;
            }
            headers.push(SessionHeaderInfo {
                path,
                id: header.id,
                cwd: header.cwd,
            });
        }
    }
    headers
}

/// `findMostRecentSessionForCwd`: the newest session file in `session_dir`
/// whose header cwd matches, or None.
pub fn find_most_recent_session_for_cwd(session_dir: &Path, cwd: &Path) -> Option<PathBuf> {
    let mut candidates: Vec<(std::time::SystemTime, PathBuf)> = scan_session_headers(session_dir)
        .into_iter()
        .filter(|header| header_matches_cwd(header, cwd))
        .filter_map(|header| {
            std::fs::metadata(&header.path)
                .and_then(|meta| meta.modified())
                .map(|modified| (modified, header.path))
                .ok()
        })
        .collect();
    candidates.sort_by_key(|(modified, _)| std::cmp::Reverse(*modified));
    candidates.into_iter().map(|(_, path)| path).next()
}

/// `matchesSavedSessionSelector`: hex ids match by prefix or suffix; plain
/// ids match by prefix only.
fn matches_saved_session_selector(candidate: &str, selector: &str) -> bool {
    let normalized_candidate = normalize_hex_session_id(candidate);
    let normalized_selector = normalize_hex_session_id(selector);
    if let (Some(candidate), Some(selector)) = (normalized_candidate, normalized_selector) {
        return candidate.starts_with(&selector) || candidate.ends_with(&selector);
    }
    candidate.starts_with(selector)
}

/// Resolve one resolved session among the matching tier, erroring on ties
/// like `resolveUniqueMatch`.
fn resolve_unique_match(
    selector: &str,
    matches: Vec<SessionHeaderInfo>,
) -> Result<Option<SessionHeaderInfo>, SessionSelectorError> {
    match matches.len() {
        0 => Ok(None),
        1 => Ok(matches.into_iter().next()),
        _ => Err(SessionSelectorError::Ambiguous {
            selector: selector.to_string(),
            matches: matches.iter().map(|header| header.id.clone()).collect(),
        }),
    }
}

/// Resolve a `--resume` selector against the session directory, mirroring
/// `resolveSessionPath`: path-like selectors pass through, then exact and
/// partial matches are tried local-first, global second.
pub fn resolve_session_path(
    selector: &str,
    cwd: &Path,
    session_dir: &Path,
) -> Result<ResolvedSession, SessionSelectorError> {
    if looks_like_session_path(selector) {
        return Ok(ResolvedSession::Path(PathBuf::from(selector)));
    }

    let headers = scan_session_headers(session_dir);
    let local: Vec<SessionHeaderInfo> = headers
        .iter()
        .filter(|header| header_matches_cwd(header, cwd))
        .cloned()
        .collect();

    // Exact local, then exact global.
    let normalized_selector = normalize_session_id(selector);
    let exact_local = local
        .iter()
        .filter(|header| normalize_session_id(&header.id) == normalized_selector)
        .cloned()
        .collect::<Vec<_>>();
    let exact_global = headers
        .iter()
        .filter(|header| normalize_session_id(&header.id) == normalized_selector)
        .cloned()
        .collect::<Vec<_>>();

    if let Some(header) = resolve_unique_match(selector, exact_local)? {
        return Ok(ResolvedSession::Local(header.path));
    }
    if let Some(header) = resolve_unique_match(selector, exact_global)? {
        return Ok(ResolvedSession::Global {
            path: header.path,
            cwd: PathBuf::from(header.cwd),
        });
    }

    // Partial local, then partial global.
    let partial_local = local
        .iter()
        .filter(|header| matches_saved_session_selector(&header.id, selector))
        .cloned()
        .collect::<Vec<_>>();
    let partial_global = headers
        .iter()
        .filter(|header| matches_saved_session_selector(&header.id, selector))
        .cloned()
        .collect::<Vec<_>>();

    if let Some(header) = resolve_unique_match(selector, partial_local)? {
        return Ok(ResolvedSession::Local(header.path));
    }
    if let Some(header) = resolve_unique_match(selector, partial_global)? {
        return Ok(ResolvedSession::Global {
            path: header.path,
            cwd: PathBuf::from(header.cwd),
        });
    }

    Err(SessionSelectorError::NotFound {
        selector: selector.to_string(),
        suggestion: find_closest_session_id(selector, &local, &headers),
    })
}

/// `findClosestSessionId`: the unique closest id within the tolerance, if any.
fn find_closest_session_id(
    selector: &str,
    local: &[SessionHeaderInfo],
    all: &[SessionHeaderInfo],
) -> Option<String> {
    let normalized_selector = normalize_session_id(selector);
    if normalized_selector.len() < SUGGESTION_MIN_LENGTH {
        return None;
    }

    let mut unique_ids: Vec<String> = local
        .iter()
        .chain(all)
        .map(|header| header.id.clone())
        .collect();
    unique_ids.sort();
    unique_ids.dedup();

    let normalized_selector: Vec<char> = normalized_selector.chars().collect();
    let mut closest: Option<(String, usize)> = None;
    let mut tied = false;
    for id in unique_ids {
        let normalized_id: Vec<char> = normalize_session_id(&id).chars().collect();
        let length = normalized_selector.len().min(normalized_id.len());
        let prefix_distance = edit_distance(&normalized_selector, &normalized_id[..length]);
        let suffix_distance = edit_distance(
            &normalized_selector,
            &normalized_id[normalized_id.len() - length..],
        );
        let distance = prefix_distance.min(suffix_distance);
        match closest {
            Some((_, best)) if distance > best => {}
            Some((_, best)) if distance == best => tied = true,
            _ => {
                closest = Some((id, distance));
                tied = false;
            }
        }
    }

    let maximum_distance = (normalized_selector.len() / 5).max(1);
    match closest {
        Some((id, distance)) if !tied && distance <= maximum_distance => Some(id),
        _ => None,
    }
}

/// Edit distance (`editDistance`), over char slices so multi-byte ids stay
/// in-bounds.
fn edit_distance(left: &[char], right: &[char]) -> usize {
    let left_len = left.len();
    let right_len = right.len();
    let mut previous: Vec<usize> = (0..=right_len).collect();
    for left_index in 1..=left_len {
        let mut diagonal = previous[0];
        previous[0] = left_index;
        for right_index in 1..=right_len {
            let above = previous[right_index];
            previous[right_index] = (previous[right_index] + 1)
                .min(previous[right_index - 1] + 1)
                .min(diagonal + usize::from(left[left_index - 1] != right[right_index - 1]));
            diagonal = above;
        }
    }
    previous[right_len]
}

#[cfg(test)]
mod tests {
    use super::*;
    use pa_types::session::FileEntry;

    fn write_session(dir: &Path, id: &str, cwd: &str) -> PathBuf {
        let path = dir.join(format!("{id}.jsonl"));
        let header = FileEntry::Header {
            header: pa_types::session::SessionHeader {
                id: id.to_string(),
                version: Some(3),
                timestamp: "2026-01-01T00:00:00.000Z".to_string(),
                cwd: cwd.to_string(),
                parent_session: None,
                rlm_depth: Some(0),
                git: None,
                rest: Default::default(),
            },
        };
        std::fs::write(
            &path,
            format!("{}\n", serde_json::to_string(&header).unwrap()),
        )
        .unwrap();
        path
    }

    fn temp_dir() -> tempfile::TempDir {
        tempfile::tempdir().unwrap()
    }

    #[test]
    fn path_like_selectors_pass_through() {
        assert!(looks_like_session_path("./a.jsonl"));
        assert!(looks_like_session_path("dir/session"));
        assert!(!looks_like_session_path("01a0ab79"));
        let resolved =
            resolve_session_path("some/file.jsonl", Path::new("/w"), Path::new("/s")).unwrap();
        assert_eq!(
            resolved,
            ResolvedSession::Path(PathBuf::from("some/file.jsonl"))
        );
    }

    #[test]
    fn exact_local_match_resolves_by_normalized_id() {
        let dir = temp_dir();
        let path = write_session(dir.path(), "01a0ab79-503d-768f-bfe5-19a937ded438", "/work");
        let resolved =
            resolve_session_path("01A0AB79-503D", Path::new("/work"), dir.path()).unwrap();
        assert_eq!(resolved, ResolvedSession::Local(path));
    }

    #[test]
    fn global_match_reports_the_session_cwd() {
        let dir = temp_dir();
        let path = write_session(dir.path(), "abcdef12", "/other/project");
        let resolved = resolve_session_path("abcdef12", Path::new("/work"), dir.path()).unwrap();
        assert_eq!(
            resolved,
            ResolvedSession::Global {
                path,
                cwd: PathBuf::from("/other/project")
            }
        );
    }

    #[test]
    fn ambiguous_matches_error_with_ids() {
        let dir = temp_dir();
        write_session(dir.path(), "aaaa0001", "/work");
        write_session(dir.path(), "aaaa0002", "/work");
        let error = resolve_session_path("aaaa", Path::new("/work"), dir.path()).unwrap_err();
        // Directory scan order is filesystem-dependent (TS readdir is too):
        // compare the match set, not its order.
        match &error {
            SessionSelectorError::Ambiguous { selector, matches } => {
                assert_eq!(selector, "aaaa");
                let mut sorted = matches.clone();
                sorted.sort();
                assert_eq!(sorted, vec!["aaaa0001".to_string(), "aaaa0002".to_string()]);
            }
            other => panic!("expected an ambiguous error, got {other:?}"),
        }
        // The rendered message lists matches in scan order; only the shape is
        // order-independent to assert here.
        let message = error.message();
        assert!(message.starts_with("Ambiguous saved session \"aaaa\": matches "));
        assert!(message.contains("aaaa0001"));
        assert!(message.contains("aaaa0002"));
    }

    #[test]
    fn not_found_offers_a_close_suggestion() {
        let dir = temp_dir();
        write_session(dir.path(), "01a0ab79-503d-768f-bfe5-19a937ded438", "/work");
        let error = resolve_session_path(
            "01a0ab79-503d-768f-bfee5-19a937ded438",
            Path::new("/work"),
            dir.path(),
        )
        .unwrap_err();
        assert_eq!(
            error.suggestion().unwrap(),
            " Did you mean '01a0ab79-503d-768f-bfe5-19a937ded438'?"
        );
        match &error {
            SessionSelectorError::NotFound {
                suggestion: Some(suggestion),
                ..
            } => assert_eq!(suggestion, "01a0ab79-503d-768f-bfe5-19a937ded438"),
            other => panic!("expected a suggestion, got {other:?}"),
        }
    }

    #[test]
    fn most_recent_session_for_cwd_prefers_newest_mtime() {
        let dir = temp_dir();
        let older = write_session(dir.path(), "older", "/work");
        let newer = write_session(dir.path(), "newer", "/work");
        // Same mtime granularity: nudge the newer file forward in time.
        let future = std::time::SystemTime::now() + std::time::Duration::from_secs(60);
        let file = std::fs::File::options().append(true).open(&newer).unwrap();
        file.set_modified(future).unwrap();
        assert_eq!(
            find_most_recent_session_for_cwd(dir.path(), Path::new("/work")),
            Some(newer)
        );
        assert_ne!(
            find_most_recent_session_for_cwd(dir.path(), Path::new("/work")),
            Some(older)
        );
    }

    #[test]
    fn most_recent_ignores_other_cwds() {
        let dir = temp_dir();
        write_session(dir.path(), "session", "/elsewhere");
        assert_eq!(
            find_most_recent_session_for_cwd(dir.path(), Path::new("/work")),
            None
        );
    }
}

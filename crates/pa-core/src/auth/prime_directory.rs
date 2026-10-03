//! Prime CLI directory contexts: the Prime team (and, for a saved context,
//! the account) a session directory selects through `PRIME_CONTEXT` or the
//! nearest `.prime/context.json` (written by `prime switch <team> --local`
//! and `prime config use <context> --local`), resolved the way the prime
//! CLI and its SDKs resolve it.

use std::path::{Path, PathBuf};

use serde_json::Value;

use super::prime_inference::{normalize_base_url, string_field, DEFAULT_PRIME_API_BASE_URL};

/// What a directory context selects for Prime Inference.
#[derive(Clone, PartialEq, Eq)]
pub struct PrimeDirectorySelection {
    /// `None` is the personal account.
    pub team_id: Option<String>,
    /// The team's display name, when the selection carries one.
    pub name: Option<String>,
    /// The saved context the selection loads (`None` for a team-only pin
    /// and for the built-in `production`, which keep the stored login).
    pub context: Option<String>,
    /// That saved context's API key: the account the prime CLI uses in
    /// this directory, which replaces the stored login there. `None`
    /// keeps the stored key.
    pub api_key: Option<String>,
    /// Where the selection came from: the pin file, or `PRIME_CONTEXT`.
    pub source: String,
}

impl std::fmt::Debug for PrimeDirectorySelection {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("PrimeDirectorySelection")
            .field("team_id", &self.team_id)
            .field("name", &self.name)
            .field("context", &self.context)
            .field("api_key", &self.api_key.as_ref().map(|_| "<redacted>"))
            .field("source", &self.source)
            .finish()
    }
}

/// A JSON object file, or the error naming the file.
fn read_object(path: &Path) -> Result<Value, String> {
    let content =
        std::fs::read_to_string(path).map_err(|error| format!("{}: {error}", path.display()))?;
    match serde_json::from_str(&content) {
        Ok(object @ Value::Object(_)) => Ok(object),
        Ok(
            Value::Null | Value::Bool(_) | Value::Number(_) | Value::String(_) | Value::Array(_),
        ) => Err(format!("{}: expected a JSON object", path.display())),
        Err(error) => Err(format!("{}: {error}", path.display())),
    }
}

/// The nearest `.prime/context.json` at or above `cwd`, as the prime CLI
/// finds it: the walk stops at `home` (whose `.prime` is the global config)
/// and skips symlinks and files another user owns.
fn find_pin(cwd: &Path, home: &Path) -> Option<PathBuf> {
    let stop = std::fs::canonicalize(home).unwrap_or_else(|_| home.to_path_buf());
    let start = std::fs::canonicalize(cwd).unwrap_or_else(|_| cwd.to_path_buf());
    start
        .ancestors()
        .take_while(|directory| *directory != stop)
        .find_map(|directory| {
            let prime = directory.join(".prime");
            let file = prime.join("context.json");
            let prime_meta = std::fs::symlink_metadata(&prime).ok()?;
            let file_meta = std::fs::symlink_metadata(&file).ok()?;
            (!prime_meta.file_type().is_symlink()
                && file_meta.file_type().is_file()
                && crate::platform::is_owned_by_current_user(&file_meta))
            .then_some(file)
        })
}

/// Refuse a pin field that is set to anything but a string or null.
fn check_string_or_null(pin: &Value, key: &str, source: &str) -> Result<(), String> {
    match pin.get(key) {
        None | Some(Value::Null | Value::String(_)) => Ok(()),
        Some(Value::Bool(_) | Value::Number(_) | Value::Array(_) | Value::Object(_)) => {
            Err(format!("{source}: {key} must be a string or null"))
        }
    }
}

/// What `PRIME_CONTEXT` (`prime_context`) or the nearest
/// `.prime/context.json` at or above `cwd` selects, or `None` when neither
/// applies. As in the prime CLI, a pin's context loads first (a saved
/// context resolves from `home/.prime/environments`, `production` is the
/// personal account on the stored login) and its `team_id` (null: the
/// personal account) overlays the context's team. A saved context that
/// targets a non-production API selects nothing, pin team included: Prime
/// Inference is production-only.
///
/// # Errors
///
/// A malformed pin, or a pin or `PRIME_CONTEXT` naming a missing, unreadable
/// or malformed saved context.
pub(crate) fn resolve_directory_selection(
    cwd: &Path,
    home: &Path,
    prime_context: Option<&str>,
) -> Result<Option<PrimeDirectorySelection>, String> {
    let explicit = prime_context
        .map(str::trim)
        .filter(|context| !context.is_empty());
    let (context, team, source) = if let Some(context) = explicit {
        (Some(context.to_string()), None, "PRIME_CONTEXT".to_string())
    } else {
        let Some(file) = find_pin(cwd, home) else {
            return Ok(None);
        };
        let source = file.display().to_string();
        let pin = read_object(&file)?;
        check_string_or_null(&pin, "team_id", &source)?;
        check_string_or_null(&pin, "team_name", &source)?;
        let context = match pin.get("context") {
            None | Some(Value::Null) => None,
            Some(Value::String(context)) => Some(context.clone()),
            Some(Value::Bool(_) | Value::Number(_) | Value::Array(_) | Value::Object(_)) => {
                return Err(format!("{source}: context must be a string or null"));
            }
        };
        // Present (null or empty: the personal account) overlays the
        // context's team; absent leaves it.
        let team = pin.get("team_id").map(|_| {
            let team_id = string_field(&pin, "team_id");
            let name = team_id
                .as_ref()
                .and_then(|_| string_field(&pin, "team_name"));
            (team_id, name)
        });
        (context, team, source)
    };
    if context.is_none() && team.is_none() {
        return Ok(None);
    }
    let mut selection = PrimeDirectorySelection {
        team_id: None,
        name: None,
        context: None,
        api_key: None,
        source,
    };
    if let Some(context) = context {
        let valid_name = !context.is_empty()
            && context
                .chars()
                .all(|c| c.is_ascii_alphanumeric() || c == '-' || c == '_');
        if !valid_name {
            return Err(format!(
                "{}: invalid Prime context name {context:?}",
                selection.source
            ));
        }
        if !context.eq_ignore_ascii_case("production") {
            let environment = read_object(
                &home
                    .join(".prime")
                    .join("environments")
                    .join(format!("{context}.json")),
            )
            .map_err(|error| {
                format!(
                    "Prime context '{context}' from {}: {error}",
                    selection.source
                )
            })?;
            if normalize_base_url(string_field(&environment, "base_url").as_deref())
                != DEFAULT_PRIME_API_BASE_URL
            {
                return Ok(None);
            }
            selection.team_id = string_field(&environment, "team_id");
            selection.name = string_field(&environment, "team_name");
            selection.api_key = string_field(&environment, "api_key");
            selection.context = Some(context);
        }
    }
    if let Some((team_id, name)) = team {
        selection.team_id = team_id;
        selection.name = name;
    }
    Ok(Some(selection))
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::path::PathBuf;

    /// A home with the global `.prime` (saved contexts `customer` on
    /// production and `dev` off it) and a repo at `home/code/repo`.
    fn layout() -> (tempfile::TempDir, PathBuf, PathBuf) {
        let root = tempfile::tempdir().unwrap();
        // Canonical, so the expected pin paths match the walk's.
        let home = std::fs::canonicalize(root.path()).unwrap().join("home");
        let environments = home.join(".prime/environments");
        std::fs::create_dir_all(&environments).unwrap();
        std::fs::create_dir_all(home.join("code/repo/src")).unwrap();
        std::fs::write(
            environments.join("customer.json"),
            r#"{"base_url": "https://api.primeintellect.ai/api/v1", "api_key": "customer-key", "team_id": "customer-team", "team_name": "Customer"}"#,
        )
        .unwrap();
        std::fs::write(
            environments.join("dev.json"),
            r#"{"base_url": "http://localhost:8000", "api_key": "dev-key", "team_id": "dev-team"}"#,
        )
        .unwrap();
        let repo = home.join("code/repo");
        (root, home, repo)
    }

    fn pin(directory: &Path, content: &str) {
        std::fs::create_dir_all(directory.join(".prime")).unwrap();
        std::fs::write(directory.join(".prime/context.json"), content).unwrap();
    }

    /// A selection without a saved context (a team pin, or `production`).
    fn team(team_id: Option<&str>, name: Option<&str>, source: &str) -> PrimeDirectorySelection {
        PrimeDirectorySelection {
            team_id: team_id.map(str::to_string),
            name: name.map(str::to_string),
            context: None,
            api_key: None,
            source: source.to_string(),
        }
    }

    /// A selection that loads the saved context `customer` (its key).
    fn customer(
        team_id: Option<&str>,
        name: Option<&str>,
        source: &str,
    ) -> PrimeDirectorySelection {
        PrimeDirectorySelection {
            context: Some("customer".to_string()),
            api_key: Some("customer-key".to_string()),
            ..team(team_id, name, source)
        }
    }

    /// The prime CLI and its SDKs run the shared case table in the prime
    /// repo (`packages/prime/tests/data/directory_context_cases.json`);
    /// these cases mirror it, including its cases where a pin's `team_id`
    /// overrides the pinned context's team (keeping the context's key) and
    /// where a missing context is an error even with a `team_id`.
    /// Deliberate divergence: a saved context that
    /// targets a non-production API selects nothing here (the stored team
    /// and key apply), even under a pin `team_id`, because Prime Inference
    /// is production-only; the CLI would use that context's API.
    #[test]
    fn resolves_the_selection_a_directory_makes() {
        /// (case, pin ("" = none), `PRIME_CONTEXT`, expected; Err = refused)
        type Case<'a> = (
            &'a str,
            &'a str,
            Option<&'a str>,
            Result<Option<PrimeDirectorySelection>, ()>,
        );
        let (_root, home, repo) = layout();
        let file = repo.join(".prime/context.json").display().to_string();
        let file = file.as_str();
        let cases: [Case; 21] = [
            ("no pin", "", None, Ok(None)),
            (
                "team pin",
                r#"{"team_id": "t1", "team_name": "T1"}"#,
                None,
                Ok(Some(team(Some("t1"), Some("T1"), file))),
            ),
            (
                "personal pin",
                r#"{"team_id": null, "team_name": "stale"}"#,
                None,
                Ok(Some(team(None, None, file))),
            ),
            (
                "an empty team is personal",
                r#"{"team_id": ""}"#,
                None,
                Ok(Some(team(None, None, file))),
            ),
            (
                "production context",
                r#"{"context": "production"}"#,
                None,
                Ok(Some(team(None, None, file))),
            ),
            (
                "saved context brings its key and team",
                r#"{"context": "customer"}"#,
                None,
                Ok(Some(customer(
                    Some("customer-team"),
                    Some("Customer"),
                    file,
                ))),
            ),
            (
                "team_id overrides the pinned context's team, keeping its key",
                r#"{"context": "customer", "team_id": "t1", "team_name": "T1"}"#,
                None,
                Ok(Some(customer(Some("t1"), Some("T1"), file))),
            ),
            (
                "null team_id over a context is personal with its key",
                r#"{"context": "customer", "team_id": null}"#,
                None,
                Ok(Some(customer(None, None, file))),
            ),
            (
                "team_id over production keeps the stored key",
                r#"{"context": "production", "team_id": "t1"}"#,
                None,
                Ok(Some(team(Some("t1"), None, file))),
            ),
            ("null context", r#"{"context": null}"#, None, Ok(None)),
            (
                "non-production context",
                r#"{"context": "dev"}"#,
                None,
                Ok(None),
            ),
            (
                "non-production context ignores the pin team",
                r#"{"context": "dev", "team_id": "t1"}"#,
                None,
                Ok(None),
            ),
            (
                "PRIME_CONTEXT replaces the pin",
                r#"{"team_id": "t1"}"#,
                Some("customer"),
                Ok(Some(customer(
                    Some("customer-team"),
                    Some("Customer"),
                    "PRIME_CONTEXT",
                ))),
            ),
            (
                "PRIME_CONTEXT=production replaces the pin",
                r#"{"team_id": "t1"}"#,
                Some("production"),
                Ok(Some(team(None, None, "PRIME_CONTEXT"))),
            ),
            ("missing context", r#"{"context": "gone"}"#, None, Err(())),
            (
                "missing context is an error even with a team_id",
                r#"{"context": "gone", "team_id": "t1"}"#,
                None,
                Err(()),
            ),
            (
                "invalid context name",
                r#"{"context": "../x"}"#,
                None,
                Err(()),
            ),
            ("non-string team", r#"{"team_id": 7}"#, None, Err(())),
            (
                "non-string team name",
                r#"{"team_id": "t1", "team_name": 7}"#,
                None,
                Err(()),
            ),
            ("malformed pin", "{not json", None, Err(())),
            ("non-object pin", "[]", None, Err(())),
        ];
        for (name, content, prime_context, expected) in cases {
            let _ = std::fs::remove_dir_all(repo.join(".prime"));
            if !content.is_empty() {
                pin(&repo, content);
            }
            let resolved = resolve_directory_selection(&repo.join("src"), &home, prime_context)
                .map_err(|_| ());
            assert_eq!(resolved, expected, "{name}");
        }
    }

    #[test]
    fn the_nearest_pin_wins() {
        let (_root, home, repo) = layout();
        pin(&repo, r#"{"team_id": "outer"}"#);
        pin(&repo.join("src"), r#"{"team_id": "inner"}"#);
        let file = repo.join("src/.prime/context.json").display().to_string();
        assert_eq!(
            resolve_directory_selection(&repo.join("src"), &home, None),
            Ok(Some(team(Some("inner"), None, &file)))
        );
    }

    #[test]
    fn debug_output_redacts_the_context_key() {
        let rendered = format!("{:?}", customer(None, None, "pin"));
        assert!(!rendered.contains("customer-key"), "{rendered}");
        assert!(rendered.contains("<redacted>"), "{rendered}");
    }

    #[cfg(unix)]
    #[test]
    fn skips_the_pins_the_cli_skips() {
        let (root, home, repo) = layout();
        // Home's own `.prime` is the global config, never a pin.
        pin(&home, r#"{"team_id": "home-team"}"#);
        assert_eq!(resolve_directory_selection(&repo, &home, None), Ok(None));

        // A symlinked `.prime` or pin file could point anywhere.
        let elsewhere = root.path().join("elsewhere");
        pin(&elsewhere, r#"{"team_id": "linked"}"#);
        std::os::unix::fs::symlink(elsewhere.join(".prime"), repo.join(".prime")).unwrap();
        assert_eq!(resolve_directory_selection(&repo, &home, None), Ok(None));
        std::fs::remove_file(repo.join(".prime")).unwrap();
        std::fs::create_dir(repo.join(".prime")).unwrap();
        std::os::unix::fs::symlink(
            elsewhere.join(".prime/context.json"),
            repo.join(".prime/context.json"),
        )
        .unwrap();
        assert_eq!(resolve_directory_selection(&repo, &home, None), Ok(None));
    }
}

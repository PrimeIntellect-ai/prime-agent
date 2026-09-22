//! The `/traces` command surface (TS `handleTracesCommand`): the trace
//! sharing status block, the enable/disable settings writes, and the
//! upload/preview/login subcommands. The upload subsystem itself (TS
//! `core/agent-traces.ts`: the outbox, the session upload, the browser
//! login) is not ported yet; the command renders the TS shapes and wires
//! the surfaces that exist — the opt-in setting and the credential
//! resolution the status block shows.

use std::pin::Pin;

/// The boxed-future shape of [`TracesCommands`] methods (the same
/// contract the composition root's other client hooks use).
pub type TracesFuture<T> = Pin<Box<dyn std::future::Future<Output = T> + Send>>;

/// The trace-sharing state the composition root owns (the settings flag
/// and the auth store stay above this crate).
pub trait TracesCommands: Send + Sync {
    /// The `agentTraces.enabled` setting (TS `getAgentTracesEnabled`).
    fn enabled(&self) -> TracesFuture<bool>;
    /// Set the flag and flush (TS `setAgentTracesEnabled` + `flush()`).
    fn set_enabled(&self, enabled: bool) -> TracesFuture<anyhow::Result<()>>;
    /// The resolved trace credential's label (TS
    /// `getPrimeAgentTraceCredential`: the env keys, the stored
    /// `prime-agent-traces` key, and the stored prime-inference
    /// credential, in that order).
    fn credential(&self) -> TracesFuture<Option<String>>;
}

/// The handle the interactive options carry.
#[derive(Clone)]
pub struct TracesCommandsHandle(pub std::sync::Arc<dyn TracesCommands>);

impl std::fmt::Debug for TracesCommandsHandle {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("TracesCommandsHandle").finish()
    }
}

/// TS `normalizeBaseUrl`: trim, strip trailing slashes, then strip a
/// trailing `/api/v1` (the base the platform API is known under).
fn normalize_base_url(value: &str) -> String {
    let trimmed = value.trim();
    let stripped = trimmed.trim_end_matches('/');
    let stripped = stripped
        .strip_suffix("/api/v1")
        .unwrap_or(stripped)
        .to_string();
    stripped
}

/// TS `resolvePrimeAgentTracesBaseUrl`: the `PRIME_AGENT_TRACES_BASE_URL`
/// override normalized, else the platform default.
pub fn traces_base_url() -> String {
    match std::env::var("PRIME_AGENT_TRACES_BASE_URL") {
        Ok(value) => normalize_base_url(&value),
        Err(_) => "https://api.primeintellect.ai".to_string(),
    }
}

/// One dispatch outcome for the session UI to render.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum TracesOutcome {
    /// The status block (its structured rows, TS `handleTracesCommand`'s
    /// "status" arm).
    StatusBlock(Vec<crate::info_commands::ClientLine>),
    /// A status row (`showStatus`).
    Status(String),
    /// A warning row (`showWarning`).
    Warning(String),
    /// An error row (`showError`).
    Error(String),
}

/// One plain span of a status block line.
fn plain(text: impl Into<String>) -> crate::info_commands::ClientSpan {
    crate::info_commands::ClientSpan {
        text: text.into(),
        color: None,
    }
}

/// One dim span of a status block line (TS `theme.fg("dim", ...)`).
fn dim(text: impl Into<String>) -> crate::info_commands::ClientSpan {
    crate::info_commands::ClientSpan {
        text: text.into(),
        color: Some(crate::theme::ThemeColor::Dim),
    }
}

/// The status block (TS "status" arm): the flag, the credential, the
/// endpoint, and the session file — one structured line per source line
/// (the `ClientText` entry renders them like every other info display).
pub fn status_block(
    enabled: bool,
    credential: Option<&str>,
    session_file: Option<&str>,
    endpoint: &str,
) -> Vec<crate::info_commands::ClientLine> {
    vec![
        vec![plain("Trace Sharing")],
        Vec::new(),
        vec![
            dim("Automatic uploads: "),
            plain(if enabled { "Enabled" } else { "Disabled" }),
        ],
        vec![
            dim("Credential: "),
            plain(credential.unwrap_or("Not configured")),
        ],
        vec![dim("Endpoint: "), plain(endpoint)],
        vec![
            dim("Session file: "),
            plain(session_file.unwrap_or("In-memory")),
        ],
        Vec::new(),
        vec![dim(
            "Commands: /traces on, /traces off, /traces preview, /traces upload-current, /traces upload-all, /traces login",
        )],
    ]
}

/// Dispatch `/traces [subcommand]` (TS `handleTracesCommand`).
/// `enabled` is the current setting, `credential` the resolved trace
/// credential, `session_file` the state's `sessionFile`, and
/// `upload_backend` whether the trace upload subsystem exists in this
/// build (it does not yet: the TS upload/login flows stay unported and
/// surface their unavailability with the TS command vocabulary).
pub fn traces_command(
    command: &str,
    enabled: bool,
    credential: Option<&str>,
    session_file: Option<&str>,
    upload_backend: bool,
) -> TracesOutcome {
    let command = command.trim().to_lowercase();
    match command.as_str() {
        "" | "status" => TracesOutcome::StatusBlock(status_block(
            enabled,
            credential,
            session_file,
            &traces_base_url(),
        )),
        "off" | "disable" => TracesOutcome::Status("Trace sharing disabled.".to_string()),
        "login" => {
            if upload_backend {
                TracesOutcome::Status("Trace login started.".to_string())
            } else {
                TracesOutcome::Status("Trace login is not available in this build yet.".to_string())
            }
        }
        "preview" => {
            if upload_backend {
                TracesOutcome::Status(
                    "Trace preview is not available in this build yet.".to_string(),
                )
            } else if session_file.is_none() {
                TracesOutcome::Status(
                    "Trace preview is unavailable until the current session has a persisted assistant response."
                        .to_string(),
                )
            } else {
                TracesOutcome::Status(
                    "Trace preview is not available in this build yet.".to_string(),
                )
            }
        }
        "upload" | "upload-current" | "upload-all" => {
            if credential.is_none() {
                TracesOutcome::Error(
                    "Trace sharing needs a Prime API key. Run /traces login.".to_string(),
                )
            } else if !upload_backend {
                TracesOutcome::Status(
                    "Trace upload is not available in this build yet.".to_string(),
                )
            } else if session_file.is_none() {
                TracesOutcome::Status(
                    "Current session will upload after the first assistant response.".to_string(),
                )
            } else {
                TracesOutcome::Status("Trace uploaded.".to_string())
            }
        }
        "on" | "enable" => {
            if credential.is_none() {
                TracesOutcome::Error("Trace sharing needs a Prime API key.".to_string())
            } else {
                TracesOutcome::Status(
                    "Trace sharing enabled. Current session will upload after the first assistant response."
                        .to_string(),
                )
            }
        }
        _ => TracesOutcome::Warning(
            "Usage: /traces [status|on|off|preview|upload|upload-current|upload-all|login]"
                .to_string(),
        ),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_status_block_matches_the_ts_layout() {
        let block = status_block(
            true,
            Some("Prime Inference credential"),
            Some("/s/a.jsonl"),
            "https://api.primeintellect.ai",
        );
        let text: Vec<String> = block
            .iter()
            .map(|line| {
                line.iter()
                    .map(|span| span.text.clone())
                    .collect::<String>()
            })
            .collect();
        assert_eq!(
            text,
            vec![
                "Trace Sharing".to_string(),
                String::new(),
                "Automatic uploads: Enabled".to_string(),
                "Credential: Prime Inference credential".to_string(),
                "Endpoint: https://api.primeintellect.ai".to_string(),
                "Session file: /s/a.jsonl".to_string(),
                String::new(),
                "Commands: /traces on, /traces off, /traces preview, /traces upload-current, /traces upload-all, /traces login"
                    .to_string(),
            ]
        );
        // The label spans carry the TS dim color.
        let uploads = &block[2];
        assert_eq!(uploads[0].color, Some(crate::theme::ThemeColor::Dim));
        assert_eq!(uploads[0].text, "Automatic uploads: ");
    }

    #[test]
    fn unset_states_render_the_ts_fallbacks() {
        let block = status_block(false, None, None, "https://api.primeintellect.ai");
        let text: Vec<String> = block
            .iter()
            .map(|line| {
                line.iter()
                    .map(|span| span.text.clone())
                    .collect::<String>()
            })
            .collect();
        let joined = text.join("\n");
        assert!(joined.contains("Automatic uploads: Disabled"));
        assert!(joined.contains("Credential: Not configured"));
        assert!(joined.contains("Session file: In-memory"));
    }

    #[test]
    fn the_base_url_normalizes_like_ts() {
        std::env::set_var("PRIME_AGENT_TRACES_BASE_URL", "https://api.example.com///");
        assert_eq!(traces_base_url(), "https://api.example.com");
        std::env::set_var(
            "PRIME_AGENT_TRACES_BASE_URL",
            "https://api.example.com/api/v1/",
        );
        assert_eq!(traces_base_url(), "https://api.example.com");
        std::env::remove_var("PRIME_AGENT_TRACES_BASE_URL");
        assert_eq!(traces_base_url(), "https://api.primeintellect.ai");
    }

    #[test]
    fn the_command_dispatch_matches_the_ts_branches() {
        // Off answers the TS status regardless of credentials.
        assert_eq!(
            traces_command("off", true, None, None, false),
            TracesOutcome::Status("Trace sharing disabled.".to_string())
        );
        // Upload without a credential is the TS error row.
        assert_eq!(
            traces_command("upload-current", true, None, Some("/s/a.jsonl"), false),
            TracesOutcome::Error(
                "Trace sharing needs a Prime API key. Run /traces login.".to_string()
            )
        );
        // Enable without a credential is the TS error row.
        assert_eq!(
            traces_command("on", false, None, None, false),
            TracesOutcome::Error("Trace sharing needs a Prime API key.".to_string())
        );
        // Unknown subcommands get the TS usage warning.
        assert_eq!(
            traces_command("sideways", false, None, None, false),
            TracesOutcome::Warning(
                "Usage: /traces [status|on|off|preview|upload|upload-current|upload-all|login]"
                    .to_string()
            )
        );
        // An empty argument is the status view.
        assert!(matches!(
            traces_command("  ", false, None, None, false),
            TracesOutcome::StatusBlock(_)
        ));
    }

    #[test]
    fn the_unported_upload_backend_reports_the_ts_shapes_where_it_can() {
        // Without a session file the TS enable status is reproduced.
        assert_eq!(
            traces_command("on", false, Some("PRIME_API_KEY"), None, false),
            TracesOutcome::Status(
                "Trace sharing enabled. Current session will upload after the first assistant response."
                    .to_string()
            )
        );
        // With a session file the unported upload reports itself.
        assert_eq!(
            traces_command(
                "upload-all",
                true,
                Some("PRIME_API_KEY"),
                Some("/s/a.jsonl"),
                false
            ),
            TracesOutcome::Status("Trace upload is not available in this build yet.".to_string())
        );
    }
}

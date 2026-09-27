//! The `/traces` command surface (TS `handleTracesCommand` + the
//! `core/agent-traces.ts` engine's client seam): the trace sharing status
//! block, the enable/disable settings writes, the preview/upload/login
//! arms, and the TS outcome rows the engine results format into
//! (`formatTraceUploadResult`, `formatTracePreview`, the upload-all
//! summary). The upload engine itself lives in the composition root's
//! pa-core (the outbox, the request/retry protocol, the browser
//! challenge); this module owns the TUI shapes and the seam the session
//! UI drives.

use std::pin::Pin;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;

/// The boxed-future shape of [`TracesCommands`] methods (the same
/// contract the composition root's other client hooks use).
pub type TracesFuture<T> = Pin<Box<dyn std::future::Future<Output = T> + Send>>;

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
/// override normalized, else the platform default (the status block's
/// endpoint row).
pub fn traces_base_url() -> String {
    match std::env::var("PRIME_AGENT_TRACES_BASE_URL") {
        Ok(value) => normalize_base_url(&value),
        Err(_) => "https://api.primeintellect.ai".to_string(),
    }
}

/// TS `toLocaleString` (the default en-US grouping): `1,234,567`.
pub fn thousands(value: u64) -> String {
    let raw = value.to_string();
    let mut grouped = String::with_capacity(raw.len() + raw.len() / 3);
    for (index, digit) in raw.char_indices() {
        if index > 0 && (raw.len() - index).is_multiple_of(3) {
            grouped.push(',');
        }
        grouped.push(digit);
    }
    grouped
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
/// (the info panel renders them like every other info display).
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

/// TS `formatTracePreview`'s outcome rows: the structured block the
/// ready preview renders.
#[derive(Debug, Clone, PartialEq)]
pub struct TracePreviewInfo {
    pub session_file: String,
    pub size: u64,
    pub max_bytes: u64,
    pub uploadable: bool,
    pub endpoint: String,
    pub session_id: String,
    pub trace_id: String,
    pub parent_session_id: Option<String>,
    pub git_repo: Option<String>,
    pub git_commit: Option<String>,
    pub content_preview: String,
    pub truncated: bool,
}

/// TS `previewAgentTraceFile`'s result, mapped for the block build.
#[derive(Debug, Clone, PartialEq)]
pub enum TracePreviewOutcome {
    Ready(Box<TracePreviewInfo>),
    NoSessionFile,
    EmptySession,
    Invalid { message: String },
    Failed { message: String },
}

/// TS `formatTracePreview`: the preview block's structured rows (the
/// info panel renders them like the status block).
pub fn preview_block(info: &TracePreviewInfo) -> Vec<crate::info_commands::ClientLine> {
    let mut rows: Vec<crate::info_commands::ClientLine> = vec![
        vec![plain("Trace Preview")],
        vec![dim("Nothing has been uploaded by this command.")],
        Vec::new(),
        vec![dim("File: "), plain(info.session_file.clone())],
        vec![
            dim("Size: "),
            plain(format!("{} bytes", thousands(info.size))),
        ],
        vec![
            dim("Uploadable: "),
            plain(if info.uploadable {
                "Yes".to_string()
            } else {
                format!("No (limit {} bytes)", thousands(info.max_bytes))
            }),
        ],
        vec![dim("Endpoint: "), plain(info.endpoint.clone())],
        vec![dim("Session ID: "), plain(info.session_id.clone())],
        vec![dim("Trace ID: "), plain(info.trace_id.clone())],
    ];
    if let Some(parent) = &info.parent_session_id {
        rows.push(vec![dim("Parent session: "), plain(parent.clone())]);
    }
    if let Some(repo) = &info.git_repo {
        rows.push(vec![dim("Git repository: "), plain(repo.clone())]);
    }
    if let Some(commit) = &info.git_commit {
        rows.push(vec![dim("Git commit: "), plain(commit.clone())]);
    }
    rows.push(Vec::new());
    rows.push(vec![plain("Raw JSONL payload preview")]);
    if info.content_preview.is_empty() {
        rows.push(vec![dim(
            "Payload omitted because the trace exceeds the upload limit.",
        )]);
        return rows;
    }
    for line in info.content_preview.split('\n') {
        rows.push(vec![plain(line)]);
    }
    if info.truncated {
        rows.push(Vec::new());
        rows.push(vec![dim(
            "Preview truncated; upload sends the complete file.",
        )]);
    }
    rows
}

/// One upload's outcome (TS `AgentTraceUploadResult`, the fields the TS
/// formatter reads).
#[derive(Debug, Clone, PartialEq)]
pub enum TraceUploadOutcome {
    Uploaded {
        bytes_stored: u64,
    },
    Disabled,
    Unchanged,
    MissingCredentials,
    NoSessionFile,
    EmptySession,
    InvalidSession {
        message: String,
    },
    TooLarge {
        size: u64,
        max_bytes: u64,
    },
    Failed {
        status_code: Option<u16>,
        message: String,
    },
}

impl TraceUploadOutcome {
    /// The status tag the arms branch on (TS the `status` field).
    pub fn status_tag(&self) -> TraceUploadStatus {
        match self {
            TraceUploadOutcome::Uploaded { .. } => TraceUploadStatus::Uploaded,
            TraceUploadOutcome::Disabled => TraceUploadStatus::Disabled,
            TraceUploadOutcome::Unchanged => TraceUploadStatus::Unchanged,
            TraceUploadOutcome::MissingCredentials => TraceUploadStatus::MissingCredentials,
            TraceUploadOutcome::NoSessionFile => TraceUploadStatus::NoSessionFile,
            TraceUploadOutcome::EmptySession => TraceUploadStatus::EmptySession,
            TraceUploadOutcome::InvalidSession { .. } => TraceUploadStatus::InvalidSession,
            TraceUploadOutcome::TooLarge { .. } => TraceUploadStatus::TooLarge,
            TraceUploadOutcome::Failed { .. } => TraceUploadStatus::Failed,
        }
    }
}

/// The upload status tags the arms decide on.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum TraceUploadStatus {
    Uploaded,
    Disabled,
    Unchanged,
    MissingCredentials,
    NoSessionFile,
    EmptySession,
    InvalidSession,
    TooLarge,
    Failed,
}

/// One upload's client report: the formatted TS row (with the trace log
/// path baked in) plus the status tag the arms branch on.
#[derive(Debug, Clone, PartialEq)]
pub struct TraceUploadReport {
    pub status: TraceUploadStatus,
    pub text: String,
}

impl TraceUploadReport {
    /// TS the upload rows come from `formatTraceUploadResult` (the client
    /// bakes in the log path); the report carries the outcome's tag.
    pub fn new(outcome: &TraceUploadOutcome, log_path: &str) -> Self {
        TraceUploadReport {
            status: outcome.status_tag(),
            text: format_upload_outcome(outcome, log_path),
        }
    }

    /// The enable arm's upload message: the no-session states answer with
    /// the TS future-upload line (the enabled setting outlives the empty
    /// first turn).
    pub fn enable_message(&self) -> String {
        match self.status {
            TraceUploadStatus::NoSessionFile | TraceUploadStatus::EmptySession => {
                "Current session will upload after the first assistant response.".to_string()
            }
            _ => self.text.clone(),
        }
    }
}

/// TS `formatTraceUploadResult`: every outcome's user-visible row.
pub fn format_upload_outcome(outcome: &TraceUploadOutcome, log_path: &str) -> String {
    match outcome {
        TraceUploadOutcome::Uploaded { bytes_stored } => {
            format!("Trace uploaded ({} bytes).", thousands(*bytes_stored))
        }
        TraceUploadOutcome::Disabled => "Trace sharing is disabled.".to_string(),
        TraceUploadOutcome::Unchanged => {
            "Trace is already uploaded; no new content since the last upload.".to_string()
        }
        TraceUploadOutcome::MissingCredentials => {
            "Trace sharing needs a Prime API key. Run /traces login.".to_string()
        }
        TraceUploadOutcome::NoSessionFile => {
            "Current session has no persisted trace yet.".to_string()
        }
        TraceUploadOutcome::EmptySession => "Current session trace is empty.".to_string(),
        TraceUploadOutcome::InvalidSession { message } => {
            format!("Trace upload skipped: {message}.")
        }
        TraceUploadOutcome::TooLarge { size, max_bytes } => format!(
            "Trace upload skipped: session file is {} bytes; limit is {} bytes.",
            thousands(*size),
            thousands(*max_bytes)
        ),
        TraceUploadOutcome::Failed {
            status_code,
            message,
        } => {
            if *status_code == Some(404) {
                return "Trace upload endpoint was not found. The platform API may not be deployed yet, or PRIME_AGENT_TRACES_BASE_URL points at the wrong API.".to_string();
            }
            let status = status_code
                .map(|status| format!("HTTP {status}: "))
                .unwrap_or_default();
            format!("Trace upload failed: {status}{message}. See {log_path} for details.")
        }
    }
}

/// The upload-all summary data (TS `AgentTraceUploadAllResult`'s tally,
/// plus the trace log path its failure row references).
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct TraceUploadAllReport {
    pub total: usize,
    pub uploaded: usize,
    pub failed: usize,
    pub skipped: usize,
    pub bytes_stored: u64,
    pub log_path: String,
}

/// One upload-all note the run loop folds in: the live progress (TS
/// `onProgress` → `showStatus`) and the settled run.
#[derive(Debug, Clone)]
pub enum TraceUploadAllNote {
    Progress {
        completed: usize,
        total: usize,
    },
    Done {
        result: TraceUploadAllReport,
        cancelled: bool,
    },
}

/// The note channel the spawned upload-all run reports through.
pub type TraceUploadAllNoteSender = tokio::sync::mpsc::UnboundedSender<TraceUploadAllNote>;

/// The cancel handle for a running upload-all (TS the arm's
/// `AbortController` the clear key fires).
#[derive(Clone, Default)]
pub struct TraceUploadCancel {
    flag: Arc<AtomicBool>,
    notify: Arc<tokio::sync::Notify>,
}

impl TraceUploadCancel {
    pub fn new() -> Self {
        Self::default()
    }

    pub fn cancel(&self) {
        self.flag.store(true, Ordering::Release);
        self.notify.notify_waiters();
    }

    pub fn is_cancelled(&self) -> bool {
        self.flag.load(Ordering::Acquire)
    }

    /// Resolves once cancelled (the composition root bridges this into
    /// the engine's abort).
    pub async fn wait(&self) {
        loop {
            let notified = self.notify.notified();
            if self.is_cancelled() {
                return;
            }
            notified.await;
        }
    }
}

/// The login flow's outcome (TS `AuthenticationResult`'s states, with
/// the status/error rows the flows report).
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum TraceLoginOutcome {
    /// TS `completeProviderAuthentication`'s status row.
    Status(String),
    /// TS `showError`'s row (`Failed to login to ...`).
    Error(String),
    /// TS the cancelled dialog (silent).
    Cancelled,
}

/// The trace-sharing state the composition root owns (the settings flag,
/// the auth store, the upload engine, and the terminal login flow stay
/// above this crate).
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
    /// TS `previewCurrentTrace` → `previewAgentTraceFile`.
    fn preview(&self, session_file: Option<&str>) -> TracesFuture<TracePreviewOutcome>;
    /// TS `uploadCurrentTraceOnce` → `uploadAgentTraceFile` (the
    /// one-shot upload; `requireEnabled: false`).
    fn upload_current(&self, session_file: Option<&str>) -> TracesFuture<TraceUploadReport>;
    /// TS `uploadAllTraces` → `uploadAllAgentTraces` (the spawned sweep:
    /// progress notes through the channel, cancellation through the
    /// handle, the tally when it settles).
    fn upload_all(
        &self,
        session_dir: Option<&str>,
        progress: TraceUploadAllNoteSender,
        cancel: TraceUploadCancel,
    ) -> TracesFuture<TraceUploadAllReport>;
    /// TS `runPrimeAgentTracesLogin` (the login flow: the prime-cli
    /// reuse, the browser challenge, the paste fallback, the credential
    /// write) driven against the inline auth panel.
    fn login(&self, panel: crate::auth_panel::AuthPanelHandle) -> TracesFuture<TraceLoginOutcome>;
}

/// The handle the interactive options carry.
#[derive(Clone)]
pub struct TracesCommandsHandle(pub std::sync::Arc<dyn TracesCommands>);

impl std::fmt::Debug for TracesCommandsHandle {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("TracesCommandsHandle").finish()
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
    fn the_locale_grouping_matches_en_us() {
        assert_eq!(thousands(0), "0");
        assert_eq!(thousands(999), "999");
        assert_eq!(thousands(1_000), "1,000");
        assert_eq!(thousands(1_234_567), "1,234,567");
    }

    #[test]
    fn the_upload_rows_match_the_ts_formatter() {
        let log = "/agent/logs/agent-traces.log";
        // The uploaded row counts the stored bytes.
        assert_eq!(
            format_upload_outcome(&TraceUploadOutcome::Uploaded { bytes_stored: 42 }, log),
            "Trace uploaded (42 bytes)."
        );
        // The disabled/unchanged/credential states keep their TS rows.
        assert_eq!(
            format_upload_outcome(&TraceUploadOutcome::Disabled, log),
            "Trace sharing is disabled."
        );
        assert_eq!(
            format_upload_outcome(&TraceUploadOutcome::Unchanged, log),
            "Trace is already uploaded; no new content since the last upload."
        );
        assert_eq!(
            format_upload_outcome(&TraceUploadOutcome::MissingCredentials, log),
            "Trace sharing needs a Prime API key. Run /traces login."
        );
        assert_eq!(
            format_upload_outcome(&TraceUploadOutcome::NoSessionFile, log),
            "Current session has no persisted trace yet."
        );
        assert_eq!(
            format_upload_outcome(&TraceUploadOutcome::EmptySession, log),
            "Current session trace is empty."
        );
        assert_eq!(
            format_upload_outcome(
                &TraceUploadOutcome::InvalidSession {
                    message: "Session file is missing a valid session header".to_string()
                },
                log
            ),
            "Trace upload skipped: Session file is missing a valid session header."
        );
        // The oversize row carries both grouped numbers.
        assert_eq!(
            format_upload_outcome(
                &TraceUploadOutcome::TooLarge {
                    size: 20_971_521,
                    max_bytes: 20_971_520
                },
                log
            ),
            "Trace upload skipped: session file is 20,971,521 bytes; limit is 20,971,520 bytes."
        );
        // A failure carries the HTTP status and the log path.
        assert_eq!(
            format_upload_outcome(
                &TraceUploadOutcome::Failed {
                    status_code: Some(403),
                    message: "nope".to_string()
                },
                log
            ),
            format!("Trace upload failed: HTTP 403: nope. See {log} for details.")
        );
        assert_eq!(
            format_upload_outcome(
                &TraceUploadOutcome::Failed {
                    status_code: None,
                    message: "timed out".to_string()
                },
                log
            ),
            format!("Trace upload failed: timed out. See {log} for details.")
        );
        // The 404 row keeps its dedicated TS explanation.
        assert_eq!(
            format_upload_outcome(
                &TraceUploadOutcome::Failed {
                    status_code: Some(404),
                    message: "not found".to_string()
                },
                log
            ),
            "Trace upload endpoint was not found. The platform API may not be deployed yet, or PRIME_AGENT_TRACES_BASE_URL points at the wrong API."
        );
        // The report's enable message replaces the no-file states with
        // the TS future-upload line.
        let report = TraceUploadReport::new(&TraceUploadOutcome::NoSessionFile, log);
        assert_eq!(
            report.enable_message(),
            "Current session will upload after the first assistant response."
        );
        assert_eq!(report.text, "Current session has no persisted trace yet.");
        let uploaded_report =
            TraceUploadReport::new(&TraceUploadOutcome::Uploaded { bytes_stored: 42 }, log);
        assert_eq!(
            uploaded_report.enable_message(),
            "Trace uploaded (42 bytes)."
        );
    }

    #[test]
    fn the_preview_block_matches_the_ts_lines() {
        let info = TracePreviewInfo {
            session_file: "/s/a.jsonl".to_string(),
            size: 1_234_567,
            max_bytes: 20 * 1024 * 1024,
            uploadable: true,
            endpoint: "https://api.primeintellect.ai/api/v1/agent-traces/sessions/s".to_string(),
            session_id: "s".to_string(),
            trace_id: "root".to_string(),
            parent_session_id: Some("root".to_string()),
            git_repo: Some("https://example/repo".to_string()),
            git_commit: Some("abc".to_string()),
            content_preview: "{\"type\":\"session\"}\n{\"type\":\"message\"}".to_string(),
            truncated: false,
        };
        let block = preview_block(&info);
        let text: Vec<String> = block
            .iter()
            .map(|line| {
                line.iter()
                    .map(|span| span.text.clone())
                    .collect::<String>()
            })
            .collect();
        let joined = text.join("\n");
        assert!(joined.contains("Trace Preview"));
        assert!(joined.contains("Nothing has been uploaded by this command."));
        assert!(joined.contains("File: /s/a.jsonl"));
        assert!(joined.contains("Size: 1,234,567 bytes"));
        assert!(joined.contains("Uploadable: Yes"));
        assert!(joined
            .contains("Endpoint: https://api.primeintellect.ai/api/v1/agent-traces/sessions/s"));
        assert!(joined.contains("Session ID: s"));
        assert!(joined.contains("Trace ID: root"));
        assert!(joined.contains("Parent session: root"));
        assert!(joined.contains("Git repository: https://example/repo"));
        assert!(joined.contains("Git commit: abc"));
        assert!(joined.contains("Raw JSONL payload preview"));
        assert!(joined.contains("{\"type\":\"session\"}"));
        // The dim labels carry the color.
        assert_eq!(block[3][0].color, Some(crate::theme::ThemeColor::Dim));

        // An oversize trace omits the payload with the TS row.
        let oversize = TracePreviewInfo {
            content_preview: String::new(),
            truncated: true,
            ..info.clone()
        };
        let oversize_text = preview_block(&oversize)
            .iter()
            .map(|line| {
                line.iter()
                    .map(|span| span.text.clone())
                    .collect::<String>()
            })
            .collect::<Vec<_>>()
            .join("\n");
        assert!(
            oversize_text.contains("Payload omitted because the trace exceeds the upload limit.")
        );

        // A truncated preview closes with the TS dim row.
        let truncated = TracePreviewInfo {
            content_preview: "...".to_string(),
            truncated: true,
            ..info
        };
        let truncated_text = preview_block(&truncated)
            .iter()
            .map(|line| {
                line.iter()
                    .map(|span| span.text.clone())
                    .collect::<String>()
            })
            .collect::<Vec<_>>()
            .join("\n");
        assert!(truncated_text.contains("Preview truncated; upload sends the complete file."));
    }
}

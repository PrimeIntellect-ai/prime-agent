//! The composition root's `/traces` state and engine (TS
//! `getAgentTracesEnabled` / `setAgentTracesEnabled`,
//! `getPrimeAgentTraceCredential`, and `core/agent-traces.ts`'s upload
//! arms): the settings flag, the resolved credential, the session
//! preview, the one-shot upload, the upload-all sweep, and the terminal
//! Prime Agent Traces login.

use std::path::{Path, PathBuf};

use pa_core::agent_traces::{
    agent_traces_log_path, preview_trace_file, trace_credential, upload_all_traces,
    upload_trace_file, TracePreviewResult, TraceUploadAllOptions, TraceUploadAllProgress,
    TraceUploadCancel as EngineCancel, TraceUploadOptions, TraceUploadResult,
    DEFAULT_REQUEST_TIMEOUT_MS,
};
use pa_tui::traces::{
    TraceLoginOutcome, TracePreviewInfo, TracePreviewOutcome, TraceUploadAllNote,
    TraceUploadAllNoteSender, TraceUploadAllReport, TraceUploadCancel, TraceUploadOutcome,
    TraceUploadReport, TracesCommands, TracesFuture,
};

/// The trace-sharing state against one daemon's shared directories.
#[derive(Clone)]
pub struct ClientTraces {
    cwd: PathBuf,
    agent_dir: PathBuf,
}

impl ClientTraces {
    pub fn new(cwd: impl Into<PathBuf>, agent_dir: impl Into<PathBuf>) -> Self {
        ClientTraces {
            cwd: cwd.into(),
            agent_dir: agent_dir.into(),
        }
    }

    fn settings(&self) -> pa_core::settings::SettingsManager {
        pa_core::settings::SettingsManager::create(&self.cwd, &self.agent_dir)
    }

    /// TS `getPrimeAgentTraceCredential` precedence: the traces env key,
    /// the stored `prime-agent-traces` credential, the Prime env key, and
    /// the stored prime-inference credential.
    fn credential_inner(&self) -> Option<String> {
        trace_credential(&self.agent_dir).map(|credential| credential.label)
    }

    /// TS `uploadCurrentTraceOnce` → `uploadAgentTraceFile` (the one-shot
    /// arm with `requireEnabled: false`, `reloadConfig: false`).
    async fn upload_once(&self, session_file: Option<&str>) -> TraceUploadReport {
        let http = pa_core::agent_traces::ReqwestTraceHttp;
        let session_file = session_file.map(PathBuf::from);
        let options = TraceUploadOptions {
            session_file: session_file.as_deref(),
            cwd: &self.cwd,
            agent_dir: &self.agent_dir,
            require_enabled: false,
            reload_config: false,
            base_url: None,
            http: &http,
            request_timeout_ms: DEFAULT_REQUEST_TIMEOUT_MS,
            cancel: None,
            on_upload_delay: None,
        };
        let result = upload_trace_file(&options).await;
        TraceUploadReport::new(
            &map_upload_result(result),
            &agent_traces_log_path(&self.agent_dir).to_string_lossy(),
        )
    }
}

/// The engine result mapped to the TUI outcome (the fields the TS
/// formatter reads).
fn map_upload_result(result: TraceUploadResult) -> TraceUploadOutcome {
    match result {
        TraceUploadResult::Uploaded { bytes_stored, .. } => {
            TraceUploadOutcome::Uploaded { bytes_stored }
        }
        TraceUploadResult::Disabled => TraceUploadOutcome::Disabled,
        TraceUploadResult::Unchanged => TraceUploadOutcome::Unchanged,
        TraceUploadResult::MissingCredentials => TraceUploadOutcome::MissingCredentials,
        TraceUploadResult::NoSessionFile => TraceUploadOutcome::NoSessionFile,
        TraceUploadResult::EmptySession => TraceUploadOutcome::EmptySession,
        TraceUploadResult::InvalidSession { message } => {
            TraceUploadOutcome::InvalidSession { message }
        }
        TraceUploadResult::TooLarge { size, max_bytes } => {
            TraceUploadOutcome::TooLarge { size, max_bytes }
        }
        TraceUploadResult::Failed {
            status_code,
            message,
            ..
        } => TraceUploadOutcome::Failed {
            status_code,
            message,
        },
    }
}

/// The engine preview mapped to the TUI outcome.
fn map_preview_result(result: TracePreviewResult) -> TracePreviewOutcome {
    match result {
        TracePreviewResult::Ready(data) => TracePreviewOutcome::Ready(Box::new(TracePreviewInfo {
            session_file: data.session_file.to_string_lossy().into_owned(),
            size: data.size,
            max_bytes: data.max_bytes,
            uploadable: data.uploadable,
            endpoint: data.endpoint,
            session_id: data.session_id,
            trace_id: data.trace_id,
            parent_session_id: data.parent_session_id,
            git_repo: data.git_repo,
            git_commit: data.git_commit,
            content_preview: data.content_preview,
            truncated: data.truncated,
        })),
        TracePreviewResult::NoSessionFile => TracePreviewOutcome::NoSessionFile,
        TracePreviewResult::EmptySession => TracePreviewOutcome::EmptySession,
        TracePreviewResult::InvalidSession { message } => TracePreviewOutcome::Invalid { message },
        TracePreviewResult::Failed { message } => TracePreviewOutcome::Failed { message },
    }
}

impl TracesCommands for ClientTraces {
    fn enabled(&self) -> TracesFuture<bool> {
        let settings = self.settings();
        Box::pin(async move { settings.get_agent_traces_enabled() })
    }

    fn set_enabled(&self, enabled: bool) -> TracesFuture<anyhow::Result<()>> {
        let provider = self.clone();
        // The settings write is file IO; keep it off the async workers.
        Box::pin(async move {
            tokio::task::spawn_blocking(move || {
                let mut settings = provider.settings();
                settings.set_agent_traces_enabled(enabled)
            })
            .await
            .expect("the settings write task ran")
        })
    }

    fn credential(&self) -> TracesFuture<Option<String>> {
        let provider = self.clone();
        // The auth store's credential resolution locks (and may refresh an
        // OAuth credential); keep it off the async workers.
        Box::pin(async move {
            tokio::task::spawn_blocking(move || provider.credential_inner())
                .await
                .expect("the credential task ran")
        })
    }

    /// TS `previewCurrentTrace` → `previewAgentTraceFile`.
    fn preview(&self, session_file: Option<&str>) -> TracesFuture<TracePreviewOutcome> {
        let session_file = session_file.map(str::to_string);
        Box::pin(async move {
            map_preview_result(
                preview_trace_file(session_file.as_deref().map(Path::new), None, None).await,
            )
        })
    }

    /// TS `uploadCurrentTraceOnce` → `uploadAgentTraceFile`.
    fn upload_current(&self, session_file: Option<&str>) -> TracesFuture<TraceUploadReport> {
        let provider = self.clone();
        let session_file = session_file.map(str::to_string);
        Box::pin(async move { provider.upload_once(session_file.as_deref()).await })
    }

    /// TS `uploadAllTraces` → `uploadAllAgentTraces`: the spawned sweep
    /// (progress through the note channel, cancellation through the
    /// handle bridged into the engine's abort).
    fn upload_all(
        &self,
        session_dir: Option<&str>,
        progress: TraceUploadAllNoteSender,
        cancel: TraceUploadCancel,
    ) -> TracesFuture<TraceUploadAllReport> {
        let session_dir = session_dir.map(str::to_string);
        let cwd = self.cwd.clone();
        let agent_dir = self.agent_dir.clone();
        Box::pin(async move {
            let http = pa_core::agent_traces::ReqwestTraceHttp;
            let engine_cancel = EngineCancel::new();
            // The TUI handle bridges into the engine's abort.
            let bridge = {
                let tui_handle = cancel.clone();
                let engine_handle = engine_cancel.clone();
                tokio::spawn(async move {
                    tui_handle.wait().await;
                    engine_handle.cancel();
                })
            };
            // The engine's per-file progress (with the session files)
            // folds into the note channel's live counter.
            let progress_sender = progress.clone();
            let (engine_progress_tx, mut engine_progress_rx) =
                tokio::sync::mpsc::unbounded_channel::<TraceUploadAllProgress>();
            let forwarder = tokio::spawn(async move {
                while let Some(progress) = engine_progress_rx.recv().await {
                    let _ = progress_sender.send(TraceUploadAllNote::Progress {
                        completed: progress.completed,
                        total: progress.total,
                    });
                }
            });
            let session_dir = session_dir.map(PathBuf::from);
            let result = upload_all_traces(&TraceUploadAllOptions {
                session_dir: session_dir.as_deref(),
                cwd: &cwd,
                agent_dir: &agent_dir,
                require_enabled: false,
                reload_config: false,
                base_url: None,
                http: &http,
                request_timeout_ms: DEFAULT_REQUEST_TIMEOUT_MS,
                cancel: Some(&engine_cancel),
                on_upload_delay: None,
                concurrency: None,
                progress: Some(engine_progress_tx),
            })
            .await;
            forwarder.abort();
            bridge.abort();
            TraceUploadAllReport {
                total: result.total,
                uploaded: result.uploaded,
                failed: result.failed,
                skipped: result.skipped,
                bytes_stored: result.bytes_stored,
                log_path: agent_traces_log_path(&agent_dir)
                    .to_string_lossy()
                    .into_owned(),
            }
        })
    }

    /// TS `runPrimeAgentTracesLogin`: the terminal login flow (the
    /// run loop hands the terminal over around the call).
    fn login(&self) -> TracesFuture<TraceLoginOutcome> {
        let agent_dir = self.agent_dir.clone();
        Box::pin(async move { crate::traces_login::run_traces_login(&agent_dir).await })
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn temp_agent_dir() -> (tempfile::TempDir, PathBuf) {
        let dir = tempfile::tempdir().expect("temp dir");
        let agent = dir.path().join("agent");
        std::fs::create_dir_all(&agent).expect("agent dir");
        (dir, agent)
    }

    /// The engine reads process env (the credential keys); the tests that
    /// touch it serialize on one lock.
    fn env_lock() -> std::sync::MutexGuard<'static, ()> {
        static LOCK: std::sync::Mutex<()> = std::sync::Mutex::new(());
        LOCK.lock().unwrap_or_else(|poisoned| poisoned.into_inner())
    }

    #[tokio::test]
    async fn the_setting_writes_and_reads_the_agent_traces_flag() {
        let (_dir, agent) = temp_agent_dir();
        let traces = ClientTraces::new("/tmp", agent.clone());
        assert!(!traces.enabled().await, "the default is off");
        traces
            .set_enabled(true)
            .await
            .expect("the enable write persists");
        // A fresh manager over the same directories reads the write (TS
        // reloads settings before reporting the flag).
        let traces = ClientTraces::new("/tmp", agent.clone());
        assert!(traces.enabled().await);
    }

    #[tokio::test]
    // The process env must stay stable across the flow's awaits:
    // the sync env lock is held for the whole test by design.
    #[allow(clippy::await_holding_lock)]
    async fn the_credential_labels_follow_the_ts_precedence() {
        let _env = env_lock();
        std::env::remove_var("PRIME_AGENT_TRACES_API_KEY");
        std::env::remove_var("PRIME_API_KEY");
        let (_dir, agent) = temp_agent_dir();
        let traces = ClientTraces::new("/tmp", agent.clone());
        assert_eq!(traces.credential().await, None);
        // A stored prime-inference key is the fallback credential.
        let mut auth = pa_core::auth::AuthStorage::create(&agent);
        auth.set(
            "prime-inference",
            pa_core::auth::AuthCredential::ApiKey {
                key: "k".to_string(),
                prime_team: None,
            },
        );
        assert_eq!(
            traces.credential().await.as_deref(),
            Some("Prime Inference credential")
        );
        // The dedicated traces key wins over the inference fallback.
        auth.set(
            "prime-agent-traces",
            pa_core::auth::AuthCredential::ApiKey {
                key: "t".to_string(),
                prime_team: None,
            },
        );
        assert_eq!(
            traces.credential().await.as_deref(),
            Some("Prime Agent Traces credential")
        );
        // The traces env key wins over everything.
        std::env::set_var("PRIME_AGENT_TRACES_API_KEY", "env-key");
        assert_eq!(
            traces.credential().await.as_deref(),
            Some("PRIME_AGENT_TRACES_API_KEY")
        );
        std::env::remove_var("PRIME_AGENT_TRACES_API_KEY");
    }

    #[tokio::test]
    async fn the_preview_maps_the_engine_result() {
        let (_dir, agent) = temp_agent_dir();
        let session_dir = agent.join("sessions");
        std::fs::create_dir_all(&session_dir).expect("sessions dir");
        let session = session_dir.join("s.jsonl");
        std::fs::write(
            &session,
            concat!(
                "{\"type\":\"session\",\"id\":\"sid\",\"timestamp\":\"2026-01-01T00:00:00.000Z\",\"cwd\":\"/w\",\"version\":3}\n",
                "{\"type\":\"message\",\"id\":\"m1\",\"parentId\":null,\"message\":{\"role\":\"user\",\"content\":\"hi\",\"timestamp\":0}}\n",
            ),
        )
        .expect("session file");
        let traces = ClientTraces::new("/tmp", agent);
        match traces.preview(Some(session.to_str().unwrap())).await {
            TracePreviewOutcome::Ready(info) => {
                assert_eq!(info.session_id, "sid");
                assert!(info.uploadable);
                assert!(info.content_preview.contains("\"type\":\"session\""));
            }
            other => panic!("expected a ready preview, got {other:?}"),
        }
        assert_eq!(
            traces.preview(None).await,
            TracePreviewOutcome::NoSessionFile
        );
    }

    #[tokio::test]
    // The process env must stay stable across the flow's awaits:
    // the sync env lock is held for the whole test by design.
    #[allow(clippy::await_holding_lock)]
    async fn the_report_formats_the_engine_rows() {
        let _env = env_lock();
        std::env::remove_var("PRIME_AGENT_TRACES_API_KEY");
        std::env::remove_var("PRIME_API_KEY");
        let (_dir, agent) = temp_agent_dir();
        let traces = ClientTraces::new("/tmp", agent.clone());
        // No session file: the engine's no-file row.
        let report = traces.upload_current(None).await;
        assert_eq!(report.text, "Current session has no persisted trace yet.");
        // A session file without a credential: the TS login hint row.
        let session_dir = agent.join("sessions");
        std::fs::create_dir_all(&session_dir).expect("sessions dir");
        let session = session_dir.join("s.jsonl");
        std::fs::write(
            &session,
            "{\"type\":\"session\",\"id\":\"sid\",\"timestamp\":\"2026-01-01T00:00:00.000Z\",\"cwd\":\"/w\",\"version\":3}\n",
        )
        .expect("session file");
        let report = traces.upload_current(Some(session.to_str().unwrap())).await;
        assert_eq!(
            report.text,
            "Trace sharing needs a Prime API key. Run /traces login."
        );
    }
}

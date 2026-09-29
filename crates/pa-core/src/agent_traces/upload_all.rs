//! The upload-all concern (moved with its concern): the serialized
//! request gate (the platform rate limit), the session-file find walk,
//! and the concurrent sweep with its progress notes and cancel checks
//! (TS uploadAllAgentTraces).

use super::{
    delay, log_agent_trace_outcome, now_ms, perform_agent_trace_upload, read_trace_session_header,
    resolve_path, Ordering, Path, PathBuf, TraceHttp, TraceHttpError, TraceUploadAllProgress,
    TraceUploadAllResult, TraceUploadCancel, TraceUploadDelay, TraceUploadDelaySink,
    TraceUploadOptions, TraceUploadResult, TRACE_UPLOAD_ALL_CONCURRENCY,
    TRACE_UPLOAD_ALL_MIN_REQUEST_INTERVAL_MS,
};
use std::collections::HashSet;
use std::sync::atomic::AtomicUsize;

/// TS `createTraceUploadAllRequestGate`: one serialized slot per request
/// that holds the platform's rate limit (5 requests a minute, spaced by
/// the computed minimum interval).
#[derive(Default)]
pub struct TraceRequestGate {
    next_request_at: tokio::sync::Mutex<u64>,
}

impl TraceRequestGate {
    #[must_use]
    pub fn new() -> Self {
        Self::default()
    }

    /// TS the gate closure: wait out the interval since the previous
    /// request, then arm the next one. A cancel ends the queued slot.
    pub(super) async fn before_request(
        &self,
        cancel: Option<&TraceUploadCancel>,
        on_upload_delay: Option<&TraceUploadDelaySink>,
    ) -> Result<(), TraceHttpError> {
        let mut next_request_at = self.next_request_at.lock().await;
        let wait_ms = next_request_at.saturating_sub(now_ms());
        if wait_ms > 0 {
            if let Some(sink) = on_upload_delay {
                sink(TraceUploadDelay::RateLimit(wait_ms));
            }
            delay(wait_ms, cancel).await;
            if cancel.is_some_and(TraceUploadCancel::is_cancelled) {
                return Err(TraceHttpError::Cancelled);
            }
        }
        *next_request_at = now_ms() + TRACE_UPLOAD_ALL_MIN_REQUEST_INTERVAL_MS;
        Ok(())
    }
}

/// TS `AgentTraceUploadAllOptions` (the session-file-less arm): the
/// session directory (the daemon state's `sessionDir`; None is TS's
/// `getSessionsDir()` default), the concurrency, and the progress sink.
pub struct TraceUploadAllOptions<'a> {
    pub session_dir: Option<&'a Path>,
    pub cwd: &'a Path,
    pub agent_dir: &'a Path,
    pub require_enabled: bool,
    pub reload_config: bool,
    pub base_url: Option<&'a str>,
    pub http: &'a dyn TraceHttp,
    pub request_timeout_ms: u64,
    pub cancel: Option<&'a TraceUploadCancel>,
    pub on_upload_delay: Option<TraceUploadDelaySink>,
    pub concurrency: Option<usize>,
    pub progress: Option<tokio::sync::mpsc::UnboundedSender<TraceUploadAllProgress>>,
}

/// TS `findSessionFilesUnder`: the recursive `.jsonl` walk that keeps
/// files with a valid session header.
fn find_session_files_under(root: &Path, files: &mut HashSet<PathBuf>) {
    let Ok(entries) = std::fs::read_dir(root) else {
        return;
    };
    for entry in entries.flatten() {
        let path = entry.path();
        let Ok(file_type) = entry.file_type() else {
            continue;
        };
        if file_type.is_dir() {
            find_session_files_under(&path, files);
            continue;
        }
        if path.extension().is_none_or(|ext| ext != "jsonl") {
            continue;
        }
        if read_trace_session_header(&path).is_some() {
            files.insert(resolve_path(&path));
        }
    }
}

/// TS `getSessionArtifactsRoot`: the sibling `session-artifacts` directory.
#[must_use]
pub fn session_artifacts_root(session_dir: &Path) -> PathBuf {
    session_dir
        .parent()
        .unwrap_or(Path::new(""))
        .join("session-artifacts")
}

/// TS `findAgentTraceFiles`: both roots walked, deduplicated, sorted.
#[must_use]
pub fn find_trace_files(session_dir: &Path) -> Vec<PathBuf> {
    let mut files: HashSet<PathBuf> = HashSet::new();
    let roots = [
        resolve_path(session_dir),
        resolve_path(&session_artifacts_root(session_dir)),
    ];
    for root in roots {
        find_session_files_under(&root, &mut files);
    }
    let mut sorted: Vec<PathBuf> = files.into_iter().collect();
    sorted.sort();
    sorted
}

/// TS `uploadAllAgentTraces`: the concurrent sweep (default 4 workers)
/// through the shared request gate, with the per-file progress and the
/// cancel checks at the worker boundaries.
///
/// # Panics
///
/// Panics if a per-file result slot mutex is poisoned, i.e. if another
/// worker panicked while holding that lock.
pub async fn upload_all_traces(options: &TraceUploadAllOptions<'_>) -> TraceUploadAllResult {
    let session_dir = options.session_dir.map_or_else(
        || {
            // TS `getSessionsDir()`: the env override expanded, else the
            // agent dir's sessions directory.
            match std::env::var_os("PRIME_AGENT_SESSION_DIR") {
                Some(dir) if !dir.is_empty() => resolve_path(Path::new(&dir)),
                _ => options.agent_dir.join("sessions"),
            }
        },
        resolve_path,
    );
    let session_files = find_trace_files(&session_dir);
    let total = session_files.len();
    let gate = TraceRequestGate::new();
    let results: Vec<std::sync::Mutex<Option<TraceUploadResult>>> = session_files
        .iter()
        .map(|_| std::sync::Mutex::new(None))
        .collect();
    let completed = AtomicUsize::new(0);
    let cursor = AtomicUsize::new(0);
    let send_progress = |progress: TraceUploadAllProgress| {
        if let Some(sender) = &options.progress {
            let _ = sender.send(progress);
        }
    };
    send_progress(TraceUploadAllProgress {
        completed: 0,
        total,
        session_file: None,
        result: None,
    });

    let cancelled = || options.cancel.is_some_and(TraceUploadCancel::is_cancelled);
    let worker_count = total
        .min(
            options
                .concurrency
                .unwrap_or(TRACE_UPLOAD_ALL_CONCURRENCY)
                .max(1),
        )
        .max(usize::from(!cancelled()));
    let mut workers = Vec::with_capacity(worker_count);
    for _ in 0..worker_count {
        workers.push(async {
            loop {
                if cancelled() {
                    return;
                }
                let index = cursor.fetch_add(1, Ordering::SeqCst);
                let Some(session_file) = session_files.get(index) else {
                    return;
                };
                let upload_options = TraceUploadOptions {
                    session_file: Some(session_file),
                    cwd: options.cwd,
                    agent_dir: options.agent_dir,
                    require_enabled: options.require_enabled,
                    reload_config: options.reload_config,
                    base_url: options.base_url,
                    http: options.http,
                    request_timeout_ms: options.request_timeout_ms,
                    cancel: options.cancel,
                    on_upload_delay: options.on_upload_delay.clone(),
                };
                let result = perform_agent_trace_upload(&upload_options, Some(&gate)).await;
                log_agent_trace_outcome(options.agent_dir, Some(session_file), &result);
                if cancelled() && matches!(result, TraceUploadResult::Failed { .. }) {
                    return;
                }
                *results[index].lock().unwrap() = Some(result.clone());
                let done = completed.fetch_add(1, Ordering::SeqCst) + 1;
                send_progress(TraceUploadAllProgress {
                    completed: done,
                    total,
                    session_file: Some(session_file.clone()),
                    result: Some(result),
                });
            }
        });
    }
    futures::future::join_all(workers).await;

    let mut uploaded = 0;
    let mut failed = 0;
    let mut bytes_stored = 0;
    let mut completed_results = Vec::new();
    for (session_file, slot) in session_files.iter().zip(results.iter()) {
        if let Some(result) = slot.lock().unwrap().clone() {
            match &result {
                TraceUploadResult::Uploaded {
                    bytes_stored: stored,
                    ..
                } => {
                    uploaded += 1;
                    bytes_stored += stored;
                }
                TraceUploadResult::Failed { .. } => failed += 1,
                _ => {}
            }
            completed_results.push((session_file.clone(), result));
        }
    }
    TraceUploadAllResult {
        total,
        uploaded,
        failed,
        skipped: total - uploaded - failed,
        bytes_stored,
        results: completed_results,
    }
}

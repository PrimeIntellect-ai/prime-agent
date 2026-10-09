//! Trace uploads (TS `agent-traces.ts`): the `/traces` command family — credential
//! precedence, the session preview, the single-session upload with its durable outbox
//! cursor, and the upload-all sweep with the rate-limit gate.
use std::fmt::Write as _;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;
use std::time::SystemTime;

use serde_json::{json, Value};

#[cfg(test)]
mod tests;

mod http;
pub use http::{
    encode_uri_component, read_response_message, retry_after_delay, ReqwestTraceHttp, TraceHttp,
    TraceHttpError, TraceHttpResponse,
};
use http::{is_retriable_transport_error, trace_upload_retry_delay, RETRIABLE_HTTP_STATUSES};

mod upload_all;
pub use upload_all::{
    find_trace_files, session_artifacts_root, upload_all_traces, TraceRequestGate,
    TraceUploadAllOptions,
};

mod continuous;
pub use continuous::{ContinuousTraceUpload, TraceConsentSnapshot};

mod upload;
use upload::perform_agent_trace_upload;
pub use upload::{upload_trace_file, TraceUploadOptions};

pub const MAX_TRACE_BYTES: u64 = 20 * 1024 * 1024;
pub const DEFAULT_REQUEST_TIMEOUT_MS: u64 = 15_000;
const TRACE_UPLOAD_RETRY_BASE_DELAY_MS: u64 = 500;
const TRACE_UPLOAD_RETRY_MAX_DELAY_MS: u64 = 10_000;
/// 3 retries means up to 4 requests.
const TRACE_UPLOAD_MAX_RETRIES: u32 = 3;
/// The uniform half-window fraction.
const TRACE_UPLOAD_RETRY_JITTER: f64 = 0.2;
const TRACE_PREVIEW_MAX_CHARS: usize = 8_000;
const TRACE_UPLOAD_ALL_CONCURRENCY: usize = 4;
const TRACE_UPLOAD_RATE_LIMIT_REQUESTS: u64 = 5;
const TRACE_UPLOAD_RATE_LIMIT_WINDOW_MS: u64 = 60_000;
const TRACE_UPLOAD_RATE_LIMIT_SAFETY_MS: u64 = 100;
/// The cap a `Retry-After` date is clamped to.
const MAX_TIMER_DELAY_MS: u64 = (1_u64 << 31) - 1;
/// The ceil of the rate window over the request count, plus the safety margin.
const TRACE_UPLOAD_ALL_MIN_REQUEST_INTERVAL_MS: u64 = TRACE_UPLOAD_RATE_LIMIT_WINDOW_MS
    / TRACE_UPLOAD_RATE_LIMIT_REQUESTS
    + TRACE_UPLOAD_RATE_LIMIT_SAFETY_MS;
const MAX_LOG_BYTES: u64 = 5 * 1024 * 1024;

pub const PRIME_AGENT_TRACES_PROVIDER_ID: &str = "prime-agent-traces";
pub const PRIME_INFERENCE_PROVIDER_ID: &str = "prime-inference";

// Credential

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum TraceCredentialSource {
    Environment,
    Stored,
    PrimeInference,
}

/// The resolved key with the label the status block shows.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct TraceCredential {
    pub api_key: String,
    pub source: TraceCredentialSource,
    pub label: String,
}

#[must_use]
pub fn trace_credential(agent_dir: &Path) -> Option<TraceCredential> {
    if let Ok(value) = std::env::var("PRIME_AGENT_TRACES_API_KEY") {
        if !value.trim().is_empty() {
            return Some(TraceCredential {
                api_key: value,
                source: TraceCredentialSource::Environment,
                label: "PRIME_AGENT_TRACES_API_KEY".to_string(),
            });
        }
    }
    let mut auth = crate::auth::AuthStorage::create(agent_dir);
    if let Some(key) = stored_key(&mut auth, PRIME_AGENT_TRACES_PROVIDER_ID) {
        return Some(TraceCredential {
            api_key: key,
            source: TraceCredentialSource::Stored,
            label: "Prime Agent Traces credential".to_string(),
        });
    }
    if let Ok(value) = std::env::var("PRIME_API_KEY") {
        if !value.trim().is_empty() {
            return Some(TraceCredential {
                api_key: value,
                source: TraceCredentialSource::Environment,
                label: "PRIME_API_KEY".to_string(),
            });
        }
    }
    if let Some(key) = stored_key(&mut auth, PRIME_INFERENCE_PROVIDER_ID) {
        return Some(TraceCredential {
            api_key: key,
            source: TraceCredentialSource::PrimeInference,
            label: "Prime Inference credential".to_string(),
        });
    }
    None
}

fn stored_key(auth: &mut crate::auth::AuthStorage, provider_id: &str) -> Option<String> {
    auth.get_api_key_with_source_token(provider_id, false)
        .api_key
        .filter(|key| !key.is_empty())
}

#[must_use]
pub fn resolve_traces_base_url(base_url: Option<&str>) -> String {
    crate::auth::resolve_prime_agent_traces_base_url(base_url)
}

// Results

#[derive(Debug, Clone, PartialEq)]
pub enum TraceUploadResult {
    Uploaded {
        session_id: String,
        trace_id: String,
        bytes_stored: u64,
        key: Option<String>,
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
        retry_after_ms: Option<u64>,
    },
}

/// The ready payload, boxed because the ready arm dwarfs the fallback states.
#[derive(Debug, Clone, PartialEq)]
pub struct TracePreviewData {
    pub session_file: PathBuf,
    pub session_id: String,
    pub trace_id: String,
    pub parent_session_id: Option<String>,
    pub cwd: String,
    pub size: u64,
    pub max_bytes: u64,
    pub uploadable: bool,
    pub endpoint: String,
    pub git_repo: Option<String>,
    pub git_commit: Option<String>,
    pub content_preview: String,
    pub truncated: bool,
}

#[derive(Debug, Clone, PartialEq)]
pub enum TracePreviewResult {
    Ready(Box<TracePreviewData>),
    NoSessionFile,
    EmptySession,
    InvalidSession { message: String },
    Failed { message: String },
}

#[derive(Debug, Clone)]
pub struct TraceUploadAllProgress {
    pub completed: usize,
    pub total: usize,
    pub session_file: Option<PathBuf>,
    pub result: Option<TraceUploadResult>,
}

#[derive(Debug, Clone, Default, PartialEq)]
pub struct TraceUploadAllResult {
    pub total: usize,
    pub uploaded: usize,
    pub failed: usize,
    pub skipped: usize,
    pub bytes_stored: u64,
    pub results: Vec<(PathBuf, TraceUploadResult)>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum TraceUploadDelay {
    RetryBackoff(u64),
    RateLimit(u64),
}

/// One call per reported wait, before the arm's next request.
pub type TraceUploadDelaySink = Arc<dyn Fn(TraceUploadDelay) + Send + Sync>;

// Cancellation

/// Checked between files and waited on inside sleeps and requests.
#[derive(Clone, Default)]
pub struct TraceUploadCancel {
    flag: Arc<AtomicBool>,
    notify: Arc<tokio::sync::Notify>,
}

impl TraceUploadCancel {
    #[must_use]
    pub fn new() -> Self {
        Self::default()
    }

    pub fn cancel(&self) {
        self.flag.store(true, Ordering::Release);
        self.notify.notify_waiters();
    }

    #[must_use]
    pub fn is_cancelled(&self) -> bool {
        self.flag.load(Ordering::Acquire)
    }

    /// Resolves once cancelled.
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

/// The sleep resolves early when the signal aborts.
async fn delay(ms: u64, cancel: Option<&TraceUploadCancel>) {
    match cancel {
        None => tokio::time::sleep(std::time::Duration::from_millis(ms)).await,
        Some(cancel) => {
            tokio::select! {
                () = tokio::time::sleep(std::time::Duration::from_millis(ms)) => {}
                () = cancel.wait() => {}
            }
        }
    }
}

fn now_ms() -> u64 {
    SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|since| since.as_millis() as u64)
        .unwrap_or_default()
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
struct TraceUploadSignature {
    size: u64,
    mtime_ms: u64,
}

impl TraceUploadSignature {
    fn of(path: &Path) -> Option<Self> {
        let metadata = std::fs::metadata(path).ok()?;
        if !metadata.is_file() {
            return None;
        }
        let mtime_ms = metadata
            .modified()
            .ok()
            .and_then(|mtime| mtime.duration_since(std::time::UNIX_EPOCH).ok())
            .map(|since| since.as_millis() as u64)
            .unwrap_or_default();
        Some(TraceUploadSignature {
            size: metadata.len(),
            mtime_ms,
        })
    }
}

// Session header + context

fn read_trace_session_header(path: &Path) -> Option<pa_types::session::SessionHeader> {
    read_trace_session_header_checked(path).ok().flatten()
}

fn read_trace_session_header_checked(
    path: &Path,
) -> std::io::Result<Option<pa_types::session::SessionHeader>> {
    use std::io::BufRead;
    let file = std::fs::File::open(path)?;
    let mut first_line = String::new();
    // Corrupt headers must not allocate an entire unbounded transcript line.
    if let Err(error) = std::io::Read::take(std::io::BufReader::new(file), 256 * 1024 + 1)
        .read_line(&mut first_line)
    {
        return if error.kind() == std::io::ErrorKind::InvalidData {
            Ok(None)
        } else {
            Err(error)
        };
    }
    if first_line.len() > 256 * 1024 || first_line.trim().is_empty() {
        return Ok(None);
    }
    let Ok(value) = serde_json::from_str::<Value>(first_line.trim()) else {
        return Ok(None);
    };
    if !is_trace_session_header(&value) {
        return Ok(None);
    }
    Ok(serde_json::from_value(value).ok())
}

fn is_trace_session_header(value: &Value) -> bool {
    let string_field = |key: &str| value.get(key).is_some_and(Value::is_string);
    value.get("type").and_then(Value::as_str) == Some("session")
        && string_field("id")
        && string_field("timestamp")
        && string_field("cwd")
        && value
            .get("parentSession")
            .is_none_or(serde_json::Value::is_string)
}

/// Node `resolve`'s lexical normalization (`.` and `..` folded; relative
/// paths anchor at the current directory).
fn resolve_path(path: &Path) -> PathBuf {
    let absolute = if path.is_absolute() {
        path.to_path_buf()
    } else {
        std::env::current_dir().unwrap_or_default().join(path)
    };
    let mut resolved = PathBuf::new();
    for component in absolute.components() {
        match component {
            std::path::Component::CurDir => {}
            std::path::Component::ParentDir => {
                resolved.pop();
            }
            other => resolved.push(other.as_os_str()),
        }
    }
    resolved
}

/// An absolute parent as-is, else relative to the session file's directory.
fn resolve_parent_session_path(session_file: &Path, parent_session: &str) -> PathBuf {
    if Path::new(parent_session).is_absolute() {
        PathBuf::from(parent_session)
    } else {
        session_file
            .parent()
            .unwrap_or(Path::new(""))
            .join(parent_session)
    }
}

/// Leaf-to-root walk: the first `git_state` on the active branch's chain wins.
fn active_git_context(
    body: &str,
    header: &pa_types::session::SessionHeader,
) -> (Option<String>, Option<String>) {
    struct Entry {
        parent_id: Option<String>,
        kind: String,
        git: Option<Value>,
    }
    let mut by_id: Vec<(String, Entry)> = Vec::new();
    let mut leaf_id: Option<String> = None;
    for line in body.split('\n') {
        if line.trim().is_empty() {
            continue;
        }
        let Ok(parsed) = serde_json::from_str::<Value>(line) else {
            continue;
        };
        if !parsed.is_object()
            || parsed.get("type").and_then(Value::as_str) == Some("session")
            || !parsed.get("id").is_some_and(Value::is_string)
        {
            continue;
        }
        let id = parsed
            .get("id")
            .and_then(Value::as_str)
            .unwrap_or_default()
            .to_string();
        let entry = Entry {
            parent_id: parsed
                .get("parentId")
                .and_then(Value::as_str)
                .map(str::to_string),
            kind: parsed
                .get("type")
                .and_then(Value::as_str)
                .unwrap_or_default()
                .to_string(),
            git: parsed.get("git").filter(|git| git.is_object()).cloned(),
        };
        leaf_id = Some(id.clone());
        by_id.push((id, entry));
    }
    let find = |id: &str| {
        by_id
            .iter()
            .find(|(entry_id, _)| entry_id == id)
            .map(|(_, entry)| entry)
    };
    let mut current = leaf_id.as_deref().and_then(find);
    for _ in 0..=by_id.len() {
        let Some(entry) = current else {
            break;
        };
        if entry.kind == "git_state" {
            if let Some(git) = &entry.git {
                let repo = git
                    .get("repoUrl")
                    .and_then(Value::as_str)
                    .map(str::to_string);
                let commit = git
                    .get("commit")
                    .and_then(Value::as_str)
                    .map(str::to_string);
                return (repo, commit);
            }
        }
        current = entry.parent_id.as_deref().and_then(find);
    }
    (
        header.git.as_ref().and_then(|git| git.repo_url.clone()),
        header.git.as_ref().and_then(|git| git.commit.clone()),
    )
}

/// The trace id is the root of the parent chain (subagent sessions upload
/// under their parent's id); the immediate parent feeds `X-Parent-Session`.
fn resolve_trace_context(
    session_file: &Path,
    header: &pa_types::session::SessionHeader,
) -> (String, Option<String>) {
    let mut trace_id = header.id.clone();
    let mut parent_session_id = None;
    let mut current_file = session_file.to_path_buf();
    let mut current_header = header.clone();
    for depth in 0..32 {
        let Some(parent_session) = current_header.parent_session.clone() else {
            break;
        };
        let parent_path =
            resolve_path(&resolve_parent_session_path(&current_file, &parent_session));
        let Some(parent_header) = read_trace_session_header(&parent_path) else {
            break;
        };
        if depth == 0 {
            parent_session_id = Some(parent_header.id.clone());
        }
        trace_id.clone_from(&parent_header.id);
        current_file = parent_path;
        current_header = parent_header;
    }
    (trace_id, parent_session_id)
}

fn trace_content_preview(body: &str, max_chars: usize) -> (String, bool) {
    let chars: Vec<char> = body.chars().collect();
    if chars.len() <= max_chars {
        return (body.trim_end().to_string(), false);
    }
    let marker = "\n... middle of trace omitted ...\n";
    let marker_chars = marker.chars().count();
    let available = max_chars.saturating_sub(marker_chars);
    let head_chars = available.div_ceil(2);
    let tail_chars = available / 2;
    let head: String = chars[..head_chars].iter().collect();
    let tail: String = chars[chars.len() - tail_chars..].iter().collect();
    (
        format!("{}{}{}", head.trim_end(), marker, tail.trim_start()),
        true,
    )
}

// Outbox

fn agent_trace_outbox_dir(agent_dir: &Path) -> PathBuf {
    agent_dir.join("agent-traces-outbox")
}

fn agent_trace_outbox_entry_path(agent_dir: &Path, session_file: &Path) -> PathBuf {
    use sha2::{Digest, Sha256};
    let digest = Sha256::digest(session_file.to_string_lossy().as_bytes());
    let key: String = digest.iter().fold(String::new(), |mut output, b| {
        let _ = write!(output, "{b:02x}");
        output
    });
    agent_trace_outbox_dir(agent_dir).join(format!("{}.json", &key[..32]))
}

fn parse_outbox_entry(raw: &str) -> Option<(String, Option<TraceUploadSignature>)> {
    let parsed: Value = serde_json::from_str(raw).ok()?;
    if !parsed.is_object() {
        return None;
    }
    let session_file = parsed
        .get("sessionFile")
        .and_then(Value::as_str)?
        .to_string();
    let uploaded = match (
        parsed.get("size").and_then(Value::as_u64),
        parsed.get("mtimeMs").and_then(Value::as_u64),
    ) {
        (Some(size), Some(mtime_ms)) => Some(TraceUploadSignature { size, mtime_ms }),
        _ => None,
    };
    Some((session_file, uploaded))
}

fn read_agent_trace_outbox_entry(
    agent_dir: &Path,
    session_file: &Path,
) -> Option<TraceUploadSignature> {
    use std::io::Read;
    let entry_path = agent_trace_outbox_entry_path(agent_dir, session_file);
    let mut raw = String::new();
    std::fs::File::open(entry_path)
        .ok()?
        .take(64 * 1024 + 1)
        .read_to_string(&mut raw)
        .ok()?;
    if raw.len() > 64 * 1024 {
        return None;
    }
    let (recorded_file, uploaded) = parse_outbox_entry(&raw)?;
    if recorded_file != session_file.to_string_lossy() {
        return None;
    }
    uploaded
}

fn signature_equals(recorded: Option<TraceUploadSignature>, current: TraceUploadSignature) -> bool {
    recorded.is_some_and(|recorded| recorded == current)
}

// Separate short mutation leases from delivery leases (which cover network
// waits). Persist callers only try-lock; cursor/prune work stays in background.
fn outbox_mutation_lock(entry: &Path) -> std::io::Result<std::fs::File> {
    let lock = entry.with_extension("mutation-lock");
    let mut options = std::fs::OpenOptions::new();
    options.create(true).read(true).write(true).truncate(false);
    crate::platform::perms::set_private_mode(&mut options);
    match options.open(&lock) {
        Ok(file) => Ok(file),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
            if let Some(parent) = lock.parent() {
                std::fs::create_dir_all(parent)?;
            }
            options.open(lock)
        }
        Err(error) => Err(error),
    }
}

fn record_agent_trace_outbox_upload(
    agent_dir: &Path,
    session_file: &Path,
    signature: TraceUploadSignature,
) -> std::io::Result<()> {
    std::fs::create_dir_all(agent_trace_outbox_dir(agent_dir))?;
    let entry_path = agent_trace_outbox_entry_path(agent_dir, session_file);
    let mutation = outbox_mutation_lock(&entry_path)?;
    crate::platform::lock_exclusive(&mutation)?;
    let temp = entry_path.with_extension(format!(
        "{}.{}.tmp",
        std::process::id(),
        uuid::Uuid::new_v4()
    ));
    std::fs::write(
        &temp,
        format!(
            "{}\n",
            json!({
                "sessionFile": session_file.to_string_lossy(),
                "size": signature.size,
                "mtimeMs": signature.mtime_ms,
            })
        ),
    )?;
    std::fs::rename(temp, entry_path)?;
    Ok(())
}

// Preview

pub async fn preview_trace_file(
    session_file: Option<&Path>,
    base_url: Option<&str>,
    max_content_chars: Option<usize>,
) -> TracePreviewResult {
    let Some(session_file) = session_file else {
        return TracePreviewResult::NoSessionFile;
    };
    let Some(signature) = TraceUploadSignature::of(session_file) else {
        return TracePreviewResult::NoSessionFile;
    };
    if signature.size == 0 {
        return TracePreviewResult::EmptySession;
    }
    let Some(header) = read_trace_session_header(session_file) else {
        return TracePreviewResult::InvalidSession {
            message: "Session file is missing a valid session header".to_string(),
        };
    };
    let mut body = String::new();
    if signature.size <= MAX_TRACE_BYTES {
        match tokio::fs::read_to_string(session_file).await {
            Ok(read) => body = read,
            Err(error) => {
                return TracePreviewResult::Failed {
                    message: error.to_string(),
                }
            }
        }
        if body.trim().is_empty() {
            return TracePreviewResult::EmptySession;
        }
    }
    let (trace_id, parent_session_id) = resolve_trace_context(session_file, &header);
    let base_url = resolve_traces_base_url(base_url);
    let (git_repo, git_commit) = if body.is_empty() {
        (
            header.git.as_ref().and_then(|git| git.repo_url.clone()),
            header.git.as_ref().and_then(|git| git.commit.clone()),
        )
    } else {
        active_git_context(&body, &header)
    };
    let (content_preview, truncated) = if body.is_empty() {
        (String::new(), true)
    } else {
        trace_content_preview(
            &body,
            max_content_chars
                .unwrap_or(TRACE_PREVIEW_MAX_CHARS)
                .max(256),
        )
    };
    TracePreviewResult::Ready(Box::new(TracePreviewData {
        session_file: session_file.to_path_buf(),
        session_id: header.id.clone(),
        trace_id,
        parent_session_id,
        cwd: header.cwd.clone(),
        size: signature.size,
        max_bytes: MAX_TRACE_BYTES,
        uploadable: signature.size <= MAX_TRACE_BYTES,
        endpoint: format!(
            "{}/api/v1/agent-traces/sessions/{}",
            base_url,
            encode_uri_component(&header.id)
        ),
        git_repo,
        git_commit,
        content_preview,
        truncated,
    }))
}

// Trace log

#[must_use]
pub fn agent_traces_log_path(agent_dir: &Path) -> PathBuf {
    agent_dir.join("logs").join("agent-traces.log")
}

/// Every failure stays silent: a broken log dir must not break the upload.
fn append_rotating_log(log_path: &Path, message: &str) {
    let write = || -> std::io::Result<()> {
        use std::io::Write;
        std::fs::create_dir_all(log_path.parent().unwrap_or(Path::new("")))?;
        if std::fs::metadata(log_path).map_or(0, |meta| meta.len()) > MAX_LOG_BYTES {
            let _ = std::fs::remove_file(log_path.with_extension("log.old"));
            let _ = std::fs::rename(log_path, log_path.with_extension("log.old"));
        }
        let mut file = std::fs::OpenOptions::new()
            .append(true)
            .create(true)
            .open(log_path)?;
        writeln!(file, "{message}")?;
        Ok(())
    };
    let _ = write();
}

pub fn log_agent_trace_outcome(
    agent_dir: &Path,
    session_file: Option<&Path>,
    result: &TraceUploadResult,
) {
    let line = match result {
        TraceUploadResult::Uploaded {
            session_id,
            bytes_stored,
            ..
        } => format!("uploaded session {session_id} ({bytes_stored} bytes)"),
        TraceUploadResult::Failed {
            status_code,
            message,
            ..
        } => {
            let status = status_code
                .map(|status| format!(" (HTTP {status})"))
                .unwrap_or_default();
            format!("upload failed{status}: {message}")
        }
        TraceUploadResult::TooLarge { size, max_bytes } => {
            format!("upload skipped: session is {size} bytes (limit {max_bytes})")
        }
        TraceUploadResult::InvalidSession { message } => format!("upload skipped: {message}"),
        TraceUploadResult::MissingCredentials => {
            "upload skipped: no Prime credential configured (run /traces login)".to_string()
        }
        _ => return,
    };
    let suffix = session_file
        .map(|path| format!(" [{}]", path.display()))
        .unwrap_or_default();
    append_rotating_log(
        &agent_traces_log_path(agent_dir),
        &format!(
            "[{}] {line}{suffix}",
            crate::session::manager::format_iso_now()
        ),
    );
}

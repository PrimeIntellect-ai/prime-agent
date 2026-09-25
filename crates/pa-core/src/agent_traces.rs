//! Trace uploads (TS `packages/coding-agent/src/core/agent-traces.ts`): the
//! session-file upload engine behind the `/traces` command family — the
//! trace credential precedence, the session preview, the single-session
//! upload with its durable outbox cursor, and the upload-all sweep over a
//! session directory with the platform rate-limit gate. The daemon-side
//! automatic upload (TS `installAgentTraceUpload`'s debounced controller,
//! the startup catch-up, and the semantic-edges outbox kind) stays
//! unported: this engine is the manual-command surface, and it keeps the
//! outbox cursors the later daemon port replays.

use std::collections::HashSet;
use std::future::Future;
use std::path::{Path, PathBuf};
use std::pin::Pin;
use std::sync::atomic::{AtomicBool, AtomicUsize, Ordering};
use std::sync::Arc;
use std::time::SystemTime;

use serde_json::{json, Value};

/// TS `MAX_TRACE_BYTES`: the upload limit.
pub const MAX_TRACE_BYTES: u64 = 20 * 1024 * 1024;
/// TS `DEFAULT_REQUEST_TIMEOUT_MS`.
pub const DEFAULT_REQUEST_TIMEOUT_MS: u64 = 15_000;
/// TS `TRACE_UPLOAD_RETRY_BASE_DELAY_MS`.
const TRACE_UPLOAD_RETRY_BASE_DELAY_MS: u64 = 500;
/// TS `TRACE_UPLOAD_RETRY_MAX_DELAY_MS`.
const TRACE_UPLOAD_RETRY_MAX_DELAY_MS: u64 = 10_000;
/// TS `TRACE_UPLOAD_MAX_RETRIES`: 3 retries means up to 4 requests.
const TRACE_UPLOAD_MAX_RETRIES: u32 = 3;
/// TS `TRACE_UPLOAD_RETRY_JITTER` (the uniform half-window fraction).
const TRACE_UPLOAD_RETRY_JITTER: f64 = 0.2;
/// TS `TRACE_PREVIEW_MAX_CHARS`.
const TRACE_PREVIEW_MAX_CHARS: usize = 8_000;
/// TS `TRACE_UPLOAD_ALL_CONCURRENCY`.
const TRACE_UPLOAD_ALL_CONCURRENCY: usize = 4;
/// TS `TRACE_UPLOAD_RATE_LIMIT_REQUESTS`.
const TRACE_UPLOAD_RATE_LIMIT_REQUESTS: u64 = 5;
/// TS `TRACE_UPLOAD_RATE_LIMIT_WINDOW_MS`.
const TRACE_UPLOAD_RATE_LIMIT_WINDOW_MS: u64 = 60_000;
/// TS `TRACE_UPLOAD_RATE_LIMIT_SAFETY_MS`.
const TRACE_UPLOAD_RATE_LIMIT_SAFETY_MS: u64 = 100;
/// TS `MAX_TIMER_DELAY_MS`: the cap a `Retry-After` date is clamped to.
const MAX_TIMER_DELAY_MS: u64 = (1_u64 << 31) - 1;
/// TS `TRACE_UPLOAD_ALL_MIN_REQUEST_INTERVAL_MS` (the ceil of the rate
/// window over the request count, plus the safety margin).
const TRACE_UPLOAD_ALL_MIN_REQUEST_INTERVAL_MS: u64 = TRACE_UPLOAD_RATE_LIMIT_WINDOW_MS
    / TRACE_UPLOAD_RATE_LIMIT_REQUESTS
    + TRACE_UPLOAD_RATE_LIMIT_SAFETY_MS;
/// TS `appendRotatingLog`'s `MAX_LOG_BYTES`.
const MAX_LOG_BYTES: u64 = 5 * 1024 * 1024;

/// TS `PRIME_AGENT_TRACES_PROVIDER_ID` (the stored credential id).
pub const PRIME_AGENT_TRACES_PROVIDER_ID: &str = "prime-agent-traces";
/// TS `PRIME_INFERENCE_PROVIDER_ID` (the credential-reuse fallback).
pub const PRIME_INFERENCE_PROVIDER_ID: &str = "prime-inference";

// ---------------------------------------------------------------------------
// Credential
// ---------------------------------------------------------------------------

/// TS `AgentTraceCredentialSource`.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum TraceCredentialSource {
    Environment,
    Stored,
    PrimeInference,
}

/// TS `AgentTraceCredential`: the resolved key with the label the status
/// block shows.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct TraceCredential {
    pub api_key: String,
    pub source: TraceCredentialSource,
    pub label: String,
}

/// TS `getPrimeAgentTraceCredential`: the traces env key, the stored
/// `prime-agent-traces` key, the Prime env key, then the stored
/// prime-inference credential. The store read is fresh — the engine holds
/// no long-lived snapshot, which is TS's post-`authStorage.reload()` view.
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

/// TS `authStorage.getApiKey(providerId, { includeFallback: false })`.
fn stored_key(auth: &mut crate::auth::AuthStorage, provider_id: &str) -> Option<String> {
    auth.get_api_key_with_source_token(provider_id, false)
        .api_key
        .filter(|key| !key.is_empty())
}

/// TS `resolvePrimeAgentTracesBaseUrl` (imported from the auth module there
/// too): the override (or the env key) normalized, else the platform
/// default.
pub fn resolve_traces_base_url(base_url: Option<&str>) -> String {
    crate::auth::resolve_prime_agent_traces_base_url(base_url)
}

// ---------------------------------------------------------------------------
// Results
// ---------------------------------------------------------------------------

/// TS `AgentTraceUploadResult`.
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

/// TS `AgentTracePreviewResult`'s ready payload (boxed on the enum: the
/// ready arm dwarfs the fallback states).
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

/// TS `AgentTracePreviewResult`.
#[derive(Debug, Clone, PartialEq)]
pub enum TracePreviewResult {
    Ready(Box<TracePreviewData>),
    NoSessionFile,
    EmptySession,
    InvalidSession { message: String },
    Failed { message: String },
}

/// TS `AgentTraceUploadAllProgress`.
#[derive(Debug, Clone)]
pub struct TraceUploadAllProgress {
    pub completed: usize,
    pub total: usize,
    pub session_file: Option<PathBuf>,
    pub result: Option<TraceUploadResult>,
}

/// TS `AgentTraceUploadAllResult`.
#[derive(Debug, Clone, Default, PartialEq)]
pub struct TraceUploadAllResult {
    pub total: usize,
    pub uploaded: usize,
    pub failed: usize,
    pub skipped: usize,
    pub bytes_stored: u64,
    pub results: Vec<(PathBuf, TraceUploadResult)>,
}

/// TS `AgentTraceUploadDelay` (the reason an upload arm waits): the retry
/// backoff after a failed attempt, or the upload-all batch gate holding
/// the platform rate limit.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum TraceUploadDelay {
    RetryBackoff(u64),
    RateLimit(u64),
}

/// A sink for the upload delays (TS `onUploadDelay`): one call per wait
/// the arms report before their next request.
pub type TraceUploadDelaySink = Arc<dyn Fn(TraceUploadDelay) + Send + Sync>;

// ---------------------------------------------------------------------------
// Cancellation
// ---------------------------------------------------------------------------

/// TS `AbortSignal` for the upload arms: checked between files and waited
/// on inside sleeps and requests.
#[derive(Clone, Default)]
pub struct TraceUploadCancel {
    flag: Arc<AtomicBool>,
    notify: Arc<tokio::sync::Notify>,
}

impl TraceUploadCancel {
    pub fn new() -> Self {
        Self::default()
    }

    /// TS `abort()` (idempotent like the controller's).
    pub fn cancel(&self) {
        self.flag.store(true, Ordering::Release);
        self.notify.notify_waiters();
    }

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

/// TS `delay(ms, signal)`: the sleep resolves early when the signal
/// aborts.
async fn delay(ms: u64, cancel: Option<&TraceUploadCancel>) {
    match cancel {
        None => tokio::time::sleep(std::time::Duration::from_millis(ms)).await,
        Some(cancel) => {
            tokio::select! {
                _ = tokio::time::sleep(std::time::Duration::from_millis(ms)) => {}
                _ = cancel.wait() => {}
            }
        }
    }
}

/// Unix milliseconds now (TS `Date.now()`).
fn now_ms() -> u64 {
    SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|since| since.as_millis() as u64)
        .unwrap_or_default()
}

/// A file's signature (TS `AgentTraceUploadedSignature`): the size and the
/// mtime in milliseconds.
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

// ---------------------------------------------------------------------------
// Session header + context
// ---------------------------------------------------------------------------

/// TS `isSessionHeader` + `readSessionHeader`: the first line must be a
/// `type: "session"` object with the id, timestamp, and cwd strings.
fn read_trace_session_header(path: &Path) -> Option<pa_types::session::SessionHeader> {
    use std::io::BufRead;
    let file = std::fs::File::open(path).ok()?;
    let mut first_line = String::new();
    std::io::BufReader::new(file)
        .read_line(&mut first_line)
        .ok()?;
    if first_line.trim().is_empty() {
        return None;
    }
    let value: Value = serde_json::from_str(first_line.trim()).ok()?;
    if !is_trace_session_header(&value) {
        return None;
    }
    serde_json::from_value(value).ok()
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

/// TS `resolveParentSessionPath`: an absolute parent as-is, else relative
/// to the session file's directory.
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

/// TS `activeGitContext`: the leaf-to-root walk over the non-session
/// entries — the first `git_state` on the active branch's chain wins over
/// the last `git_state` in file order.
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

/// TS `resolveTraceContext`: the trace id is the root of the parent chain
/// (subagent sessions upload under their parent's id), with the immediate
/// parent kept for the `X-Parent-Session` header.
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

/// TS `traceContentPreview`: the head/tail split around the omission marker.
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

// ---------------------------------------------------------------------------
// Outbox
// ---------------------------------------------------------------------------

/// TS `getAgentTraceOutboxDir`.
fn agent_trace_outbox_dir(agent_dir: &Path) -> PathBuf {
    agent_dir.join("agent-traces-outbox")
}

/// TS `agentTraceOutboxEntryPath`: the sha256 of the session path, first
/// 32 hex chars, one entry file per session.
fn agent_trace_outbox_entry_path(agent_dir: &Path, session_file: &Path) -> PathBuf {
    use sha2::{Digest, Sha256};
    let digest = Sha256::digest(session_file.to_string_lossy().as_bytes());
    let key: String = digest.iter().map(|b| format!("{b:02x}")).collect();
    agent_trace_outbox_dir(agent_dir).join(format!("{}.json", &key[..32]))
}

/// TS `parseOutboxEntry`: the session file plus the uploaded cursor.
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

/// TS `readAgentTraceOutboxEntry`: the entry's cursor when it belongs to
/// this session file (no entry, a mismatched entry, or a pending-only
/// entry all read as "no usable cursor").
fn read_agent_trace_outbox_entry(
    agent_dir: &Path,
    session_file: &Path,
) -> Option<TraceUploadSignature> {
    let entry_path = agent_trace_outbox_entry_path(agent_dir, session_file);
    let raw = std::fs::read_to_string(entry_path).ok()?;
    let (recorded_file, uploaded) = parse_outbox_entry(&raw)?;
    if recorded_file != session_file.to_string_lossy() {
        return None;
    }
    uploaded
}

/// TS `signatureEquals`.
fn signature_equals(recorded: Option<TraceUploadSignature>, current: TraceUploadSignature) -> bool {
    recorded.is_some_and(|recorded| recorded == current)
}

/// TS `recordAgentTraceOutboxUpload`: the durable cursor write.
fn record_agent_trace_outbox_upload(
    agent_dir: &Path,
    session_file: &Path,
    signature: TraceUploadSignature,
) -> std::io::Result<()> {
    std::fs::create_dir_all(agent_trace_outbox_dir(agent_dir))?;
    let entry_path = agent_trace_outbox_entry_path(agent_dir, session_file);
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

// ---------------------------------------------------------------------------
// HTTP transport
// ---------------------------------------------------------------------------

/// One PUT's answer (TS `Response`'s surface the upload reads): the
/// status, the body text, and the `Retry-After` header.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct TraceHttpResponse {
    pub status: u16,
    pub body: String,
    pub retry_after: Option<String>,
}

/// The transport's failure modes (TS `isRetriableNetworkError`'s classes):
/// the request timeout, a cancel, or a transport error with its message.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum TraceHttpError {
    TimedOut { timeout_ms: u64 },
    Cancelled,
    Transport(String),
}

impl TraceHttpError {
    /// TS `describeError`'s message for each class.
    pub fn message(&self) -> String {
        match self {
            TraceHttpError::TimedOut { timeout_ms } => {
                format!("Trace upload timed out after {timeout_ms}ms")
            }
            TraceHttpError::Cancelled => "Trace upload cancelled".to_string(),
            TraceHttpError::Transport(message) => message.clone(),
        }
    }
}

/// The upload's HTTP transport (TS's injectable `fetchFn` + the abort
/// signal plumbing of `fetchWithTimeout`).
pub trait TraceHttp: Send + Sync {
    fn put<'a>(
        &'a self,
        url: &'a str,
        headers: Vec<(String, String)>,
        body: String,
        timeout_ms: u64,
        cancel: Option<&'a TraceUploadCancel>,
    ) -> Pin<Box<dyn Future<Output = Result<TraceHttpResponse, TraceHttpError>> + Send + 'a>>;
}

/// The production transport (reqwest over rustls, the catalog fetch's
/// shape): the PUT with its headers, the client timeout, and a cancel
/// that ends the in-flight request.
pub struct ReqwestTraceHttp;

impl TraceHttp for ReqwestTraceHttp {
    fn put<'a>(
        &'a self,
        url: &'a str,
        headers: Vec<(String, String)>,
        body: String,
        timeout_ms: u64,
        cancel: Option<&'a TraceUploadCancel>,
    ) -> Pin<Box<dyn Future<Output = Result<TraceHttpResponse, TraceHttpError>> + Send + 'a>> {
        Box::pin(async move {
            let client = reqwest::Client::builder()
                .timeout(std::time::Duration::from_millis(timeout_ms))
                .build()
                .map_err(|error| TraceHttpError::Transport(error.to_string()))?;
            let mut request = client.put(url).body(body);
            for (name, value) in headers {
                request = request.header(name, value);
            }
            let send = async {
                let response = request.send().await.map_err(|error| {
                    if error.is_timeout() {
                        TraceHttpError::TimedOut { timeout_ms }
                    } else {
                        TraceHttpError::Transport(error.to_string())
                    }
                })?;
                let status = response.status().as_u16();
                let retry_after = response
                    .headers()
                    .get("retry-after")
                    .and_then(|value| value.to_str().ok())
                    .map(str::to_string);
                let body = response
                    .text()
                    .await
                    .map_err(|error| TraceHttpError::Transport(error.to_string()))?;
                Ok(TraceHttpResponse {
                    status,
                    body,
                    retry_after,
                })
            };
            match cancel {
                Some(cancel) => {
                    tokio::select! {
                        result = send => result,
                        _ = cancel.wait() => Err(TraceHttpError::Cancelled),
                    }
                }
                None => send.await,
            }
        })
    }
}

/// TS `encodeURIComponent` (every byte outside the JS unreserved set
/// escapes).
pub fn encode_uri_component(value: &str) -> String {
    let mut out = String::with_capacity(value.len());
    for &byte in value.as_bytes() {
        match byte {
            b'A'..=b'Z'
            | b'a'..=b'z'
            | b'0'..=b'9'
            | b'-'
            | b'_'
            | b'.'
            | b'!'
            | b'~'
            | b'*'
            | b'\''
            | b'('
            | b')' => out.push(byte as char),
            other => out.push_str(&format!("%{other:02X}")),
        }
    }
    out
}

/// TS `readResponseMessage` (prime-http.ts): the error body's
/// `error.message`, `detail`, or `message`, the raw text, or the status
/// phrase.
pub fn read_response_message(status: u16, body: &str) -> String {
    if body.trim().is_empty() {
        return reqwest::StatusCode::from_u16(status)
            .ok()
            .and_then(|status| status.canonical_reason())
            .unwrap_or("Unknown error")
            .to_string();
    }
    if let Ok(parsed) = serde_json::from_str::<Value>(body) {
        if let Some(message) = parsed
            .get("error")
            .and_then(|error| error.get("message"))
            .and_then(Value::as_str)
            .map(str::trim)
            .filter(|value| !value.is_empty())
        {
            return message.to_string();
        }
        for field in ["detail", "message"] {
            if let Some(message) = parsed
                .get(field)
                .and_then(Value::as_str)
                .map(str::trim)
                .filter(|value| !value.is_empty())
            {
                return message.to_string();
            }
        }
    }
    body.trim().to_string()
}

/// TS `retryAfterDelay`: the `Retry-After` seconds, or an HTTP date,
/// clamped to `cap_ms`.
pub fn retry_after_delay(retry_after: Option<&str>, cap_ms: u64) -> Option<u64> {
    let value = retry_after?.trim();
    if value.is_empty() {
        return None;
    }
    if let Ok(seconds) = value.parse::<f64>() {
        if seconds.is_finite() && seconds >= 0.0 {
            let capped = (seconds * 1000.0).ceil().min(cap_ms as f64);
            return Some(capped as u64);
        }
    }
    let retry_at = parse_http_date(value)?;
    let delta = retry_at.saturating_sub(now_ms());
    Some(delta.min(cap_ms))
}

/// RFC 1123 (HTTP-date) parsing for `Retry-After` (TS `Date.parse`'s HTTP
/// subset): `Sun, 06 Nov 1994 08:49:37 GMT`.
fn parse_http_date(value: &str) -> Option<u64> {
    let rest = value
        .split_once(',')
        .map_or(value.trim(), |(_, rest)| rest.trim());
    let parts: Vec<&str> = rest.split_whitespace().collect();
    if parts.len() < 4 {
        return None;
    }
    let day: u32 = parts[0].parse().ok()?;
    let month = [
        "Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec",
    ]
    .iter()
    .position(|name| parts[1].starts_with(name))? as u32
        + 1;
    let year: i64 = parts[2].parse().ok()?;
    let time: Vec<&str> = parts[3].split(':').collect();
    if time.len() != 3 {
        return None;
    }
    let (hour, minute, second): (u64, u64, u64) = (
        time[0].parse().ok()?,
        time[1].parse().ok()?,
        time[2].parse().ok()?,
    );
    // Civil-date conversion: days from 1970-01-01 (Howard Hinnant's
    // days_from_civil).
    let y = if month <= 2 { year - 1 } else { year };
    let era = if y >= 0 { y } else { y - 399 } / 400;
    let yoe = y - era * 400;
    let mp = ((month + 9) % 12) as i64;
    let doy = (153 * mp + 2) / 5 + day as i64 - 1;
    let doe = yoe * 365 + yoe / 4 - yoe / 100 + doy;
    let days = era * 146_097 + doe - 719_468;
    if days < 0 {
        return None;
    }
    Some((days as u64) * 86_400_000 + hour * 3_600_000 + minute * 60_000 + second * 1000)
}

/// TS `traceUploadRetryDelay`: the exponential backoff with the ±20%
/// jitter.
fn trace_upload_retry_delay(retry_index: u32) -> u64 {
    let exponential = (TRACE_UPLOAD_RETRY_BASE_DELAY_MS * (1_u64 << retry_index.min(16)))
        .min(TRACE_UPLOAD_RETRY_MAX_DELAY_MS) as f64;
    let jitter_multiplier =
        1.0 - TRACE_UPLOAD_RETRY_JITTER + rand_fraction() * TRACE_UPLOAD_RETRY_JITTER * 2.0;
    (exponential * jitter_multiplier).round().max(0.0) as u64
}

/// `Math.random()` (the only TS randomness the engine uses).
fn rand_fraction() -> f64 {
    let mut bytes = [0u8; 8];
    let _ = getrandom::fill(&mut bytes);
    u64::from_le_bytes(bytes) as f64 / u64::MAX as f64
}

/// The retriable transport classes (TS `isRetriableNetworkError`'s list
/// covers every connection failure; the abort and the timeout message
/// keep their own classes).
fn is_retriable_transport_error(error: &TraceHttpError) -> bool {
    matches!(
        error,
        TraceHttpError::TimedOut { .. } | TraceHttpError::Transport(_)
    )
}

/// The retriable HTTP statuses (TS `RETRIABLE_HTTP_STATUSES`; 429 is
/// deliberately absent — the caller reschedules instead).
const RETRIABLE_HTTP_STATUSES: [u16; 6] = [408, 425, 500, 502, 503, 504];

// ---------------------------------------------------------------------------
// Upload
// ---------------------------------------------------------------------------

/// One upload arm's inputs (TS `AgentTraceUploadOptions`): the session
/// file (None is TS's `no_session_file`), the daemon-shared directories
/// for the settings, the outbox, and the trace log, and the transport.
pub struct TraceUploadOptions<'a> {
    pub session_file: Option<&'a Path>,
    pub cwd: &'a Path,
    pub agent_dir: &'a Path,
    /// TS `requireEnabled !== false`.
    pub require_enabled: bool,
    /// TS `reloadConfig !== false`.
    pub reload_config: bool,
    pub base_url: Option<&'a str>,
    pub http: &'a dyn TraceHttp,
    pub request_timeout_ms: u64,
    pub cancel: Option<&'a TraceUploadCancel>,
    pub on_upload_delay: Option<TraceUploadDelaySink>,
}

impl TraceUploadOptions<'_> {
    /// TS `getAgentTracesEnabled`: the reload gate then the setting.
    fn enabled(&self) -> bool {
        let mut settings = crate::settings::SettingsManager::create(self.cwd, self.agent_dir);
        if self.reload_config {
            let _ = settings.reload();
        }
        settings.get_agent_traces_enabled()
    }
}

/// TS `uploadAgentTraceFile`: the upload with its outcome logged to the
/// trace log.
pub async fn upload_trace_file(options: &TraceUploadOptions<'_>) -> TraceUploadResult {
    let result = perform_agent_trace_upload(options, None).await;
    log_agent_trace_outcome(options.agent_dir, options.session_file, &result);
    result
}

/// TS `performAgentTraceUpload` (the gate variant is the upload-all
/// call: perform with the shared request slot, then log).
async fn perform_agent_trace_upload(
    options: &TraceUploadOptions<'_>,
    before_request: Option<&TraceRequestGate>,
) -> TraceUploadResult {
    if options.require_enabled && !options.enabled() {
        return TraceUploadResult::Disabled;
    }
    let Some(session_file) = options.session_file else {
        return TraceUploadResult::NoSessionFile;
    };
    let Some(signature) = TraceUploadSignature::of(session_file) else {
        return TraceUploadResult::NoSessionFile;
    };
    if signature.size == 0 {
        return TraceUploadResult::EmptySession;
    }
    if signature.size > MAX_TRACE_BYTES {
        return TraceUploadResult::TooLarge {
            size: signature.size,
            max_bytes: MAX_TRACE_BYTES,
        };
    }
    // Cursor invariant: an automatic upload never re-sends a file whose
    // content already matches its uploaded cursor.
    if options.require_enabled
        && signature_equals(
            read_agent_trace_outbox_entry(options.agent_dir, session_file),
            signature,
        )
    {
        return TraceUploadResult::Unchanged;
    }
    let Some(header) = read_trace_session_header(session_file) else {
        return TraceUploadResult::InvalidSession {
            message: "Session file is missing a valid session header".to_string(),
        };
    };
    let Some(credential) = trace_credential(options.agent_dir) else {
        return TraceUploadResult::MissingCredentials;
    };
    if options.require_enabled && !options.enabled() {
        return TraceUploadResult::Disabled;
    }
    let body = match tokio::fs::read_to_string(session_file).await {
        Ok(body) => body,
        Err(error) => {
            return TraceUploadResult::Failed {
                status_code: None,
                message: error.to_string(),
                retry_after_ms: None,
            }
        }
    };
    if body.trim().is_empty() {
        return TraceUploadResult::EmptySession;
    }
    let (trace_id, parent_session_id) = resolve_trace_context(session_file, &header);
    let body_bytes = body.len() as u64;
    let mut headers: Vec<(String, String)> = vec![
        (
            "Authorization".to_string(),
            format!("Bearer {}", credential.api_key),
        ),
        (
            "Content-Type".to_string(),
            "application/x-ndjson".to_string(),
        ),
        ("Accept".to_string(), "application/json".to_string()),
        ("X-Trace-Id".to_string(), trace_id.clone()),
        ("X-Cwd".to_string(), header.cwd.clone()),
        (
            "X-Agent-Version".to_string(),
            env!("CARGO_PKG_VERSION").to_string(),
        ),
    ];
    if let Some(parent) = &parent_session_id {
        headers.push(("X-Parent-Session".to_string(), parent.clone()));
    }
    let (git_repo, git_commit) = active_git_context(&body, &header);
    if let Some(repo) = git_repo {
        headers.push(("X-Git-Repo".to_string(), repo));
    }
    if let Some(commit) = git_commit {
        headers.push(("X-Git-Commit".to_string(), commit));
    }
    if options.require_enabled && !options.enabled() {
        return TraceUploadResult::Disabled;
    }
    let base_url = resolve_traces_base_url(options.base_url);
    let url = format!(
        "{}/api/v1/agent-traces/sessions/{}",
        base_url,
        encode_uri_component(&header.id)
    );
    let response = match fetch_with_retry(options, &url, headers, body, before_request).await {
        Ok(response) => response,
        Err(error) => {
            return TraceUploadResult::Failed {
                status_code: None,
                message: error.message(),
                retry_after_ms: None,
            }
        }
    };
    if !(200..300).contains(&response.status) {
        return TraceUploadResult::Failed {
            status_code: Some(response.status),
            message: read_response_message(response.status, &response.body),
            retry_after_ms: retry_after_delay(response.retry_after.as_deref(), MAX_TIMER_DELAY_MS),
        };
    }
    let response_data: Option<Value> = serde_json::from_str(&response.body)
        .ok()
        .filter(|data: &Value| data.is_object());
    if let Err(error) = record_agent_trace_outbox_upload(options.agent_dir, session_file, signature)
    {
        return TraceUploadResult::Failed {
            status_code: None,
            message: format!("stored, but recording the upload cursor failed: {error}"),
            retry_after_ms: None,
        };
    }
    let string_field = |key: &str| {
        response_data
            .as_ref()
            .and_then(|data| data.get(key))
            .and_then(Value::as_str)
            .map(str::to_string)
    };
    TraceUploadResult::Uploaded {
        session_id: string_field("session_id").unwrap_or_else(|| header.id.clone()),
        trace_id: string_field("trace_id").unwrap_or(trace_id),
        bytes_stored: response_data
            .as_ref()
            .and_then(|data| data.get("bytes_stored"))
            .and_then(Value::as_u64)
            .unwrap_or(body_bytes),
        key: string_field("key"),
    }
}

/// TS `fetchWithRetry`: the gate runs before every attempt, the
/// retriable statuses/network errors back off with jitter, and 503 honors
/// `Retry-After`.
async fn fetch_with_retry(
    options: &TraceUploadOptions<'_>,
    url: &str,
    headers: Vec<(String, String)>,
    body: String,
    before_request: Option<&TraceRequestGate>,
) -> Result<TraceHttpResponse, TraceHttpError> {
    let mut attempt: u32 = 0;
    loop {
        if let Some(gate) = before_request {
            // A cancelled wait ends the upload (TS the signal aborts the
            // queued gate slot).
            gate.before_request(options.cancel, options.on_upload_delay.as_ref())
                .await?;
        }
        if options.cancel.is_some_and(TraceUploadCancel::is_cancelled) {
            return Err(TraceHttpError::Cancelled);
        }
        let mut retry_delay_ms: Option<u64> = None;
        let result = options
            .http
            .put(
                url,
                headers.clone(),
                body.clone(),
                options.request_timeout_ms,
                options.cancel,
            )
            .await;
        match result {
            Ok(response) => {
                if attempt >= TRACE_UPLOAD_MAX_RETRIES
                    || !RETRIABLE_HTTP_STATUSES.contains(&response.status)
                {
                    return Ok(response);
                }
                if response.status == 503 {
                    retry_delay_ms = retry_after_delay(
                        response.retry_after.as_deref(),
                        TRACE_UPLOAD_RATE_LIMIT_WINDOW_MS,
                    );
                }
            }
            Err(error) => {
                if options.cancel.is_some_and(TraceUploadCancel::is_cancelled)
                    || matches!(error, TraceHttpError::Cancelled)
                {
                    return Err(TraceHttpError::Cancelled);
                }
                if attempt >= TRACE_UPLOAD_MAX_RETRIES || !is_retriable_transport_error(&error) {
                    return Err(error);
                }
            }
        }
        let backoff_ms = retry_delay_ms.unwrap_or_else(|| trace_upload_retry_delay(attempt));
        if !options.cancel.is_some_and(TraceUploadCancel::is_cancelled) {
            if let Some(sink) = &options.on_upload_delay {
                sink(TraceUploadDelay::RetryBackoff(backoff_ms));
            }
        }
        delay(backoff_ms, options.cancel).await;
        if options.cancel.is_some_and(TraceUploadCancel::is_cancelled) {
            return Err(TraceHttpError::Cancelled);
        }
        attempt += 1;
    }
}

// ---------------------------------------------------------------------------
// Upload all
// ---------------------------------------------------------------------------

/// TS `createTraceUploadAllRequestGate`: one serialized slot per request
/// that holds the platform's rate limit (5 requests a minute, spaced by
/// the computed minimum interval).
#[derive(Default)]
pub struct TraceRequestGate {
    next_request_at: tokio::sync::Mutex<u64>,
}

impl TraceRequestGate {
    pub fn new() -> Self {
        Self::default()
    }

    /// TS the gate closure: wait out the interval since the previous
    /// request, then arm the next one. A cancel ends the queued slot.
    async fn before_request(
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
pub fn session_artifacts_root(session_dir: &Path) -> PathBuf {
    session_dir
        .parent()
        .unwrap_or(Path::new(""))
        .join("session-artifacts")
}

/// TS `findAgentTraceFiles`: both roots walked, deduplicated, sorted.
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
        .max(if cancelled() { 0 } else { 1 });
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

// ---------------------------------------------------------------------------
// Preview
// ---------------------------------------------------------------------------

/// TS `previewAgentTraceFile`.
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

// ---------------------------------------------------------------------------
// Trace log
// ---------------------------------------------------------------------------

/// TS `getAgentTracesLogPath`.
pub fn agent_traces_log_path(agent_dir: &Path) -> PathBuf {
    agent_dir.join("logs").join("agent-traces.log")
}

/// TS `appendRotatingLog`: the oversize log rolls to `.old`, then the
/// line appends; every failure stays silent (a broken log dir must not
/// break the upload).
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

/// TS `logAgentTraceOutcome`: the outcome line the failures reference.
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

#[cfg(test)]
mod tests {
    use super::*;
    use std::collections::VecDeque;
    use std::io::Write as _;
    use std::sync::Mutex;

    /// One captured request (url, headers, body).
    type CapturedRequest = (String, Vec<(String, String)>, String);

    /// A scripted transport: one PUT slot at a time with its captured
    /// request and scripted answer.
    struct ScriptedTraceHttp {
        requests: Mutex<Vec<CapturedRequest>>,
        answers: Mutex<VecDeque<Result<TraceHttpResponse, TraceHttpError>>>,
    }

    impl ScriptedTraceHttp {
        fn new(answers: Vec<Result<TraceHttpResponse, TraceHttpError>>) -> Self {
            ScriptedTraceHttp {
                requests: Mutex::new(Vec::new()),
                answers: Mutex::new(answers.into_iter().collect()),
            }
        }

        fn last_request(&self) -> CapturedRequest {
            self.requests.lock().unwrap().last().cloned().unwrap()
        }
    }

    impl TraceHttp for ScriptedTraceHttp {
        fn put<'a>(
            &'a self,
            url: &'a str,
            headers: Vec<(String, String)>,
            body: String,
            _timeout_ms: u64,
            _cancel: Option<&'a TraceUploadCancel>,
        ) -> Pin<Box<dyn Future<Output = Result<TraceHttpResponse, TraceHttpError>> + Send + 'a>>
        {
            let url = url.to_string();
            let answer = self.answers.lock().unwrap().pop_front();
            self.requests.lock().unwrap().push((url, headers, body));
            Box::pin(async move { answer.expect("a scripted answer for the request") })
        }
    }

    fn response(status: u16, body: &str) -> Result<TraceHttpResponse, TraceHttpError> {
        Ok(TraceHttpResponse {
            status,
            body: body.to_string(),
            retry_after: None,
        })
    }

    struct Fixture {
        /// The temp dir stays alive for the fixture's life (the paths
        /// point into it); it is never read.
        _dir: tempfile::TempDir,
        cwd: PathBuf,
        agent_dir: PathBuf,
        session_dir: PathBuf,
    }

    impl Fixture {
        fn new() -> Self {
            let dir = tempfile::tempdir().expect("temp dir");
            let agent_dir = dir.path().join("agent");
            let session_dir = agent_dir.join("sessions");
            std::fs::create_dir_all(&session_dir).expect("dirs");
            Fixture {
                cwd: dir.path().to_path_buf(),
                agent_dir,
                session_dir,
                _dir: dir,
            }
        }

        fn write_session(&self, name: &str, id: &str) -> PathBuf {
            let path = self.session_dir.join(name);
            std::fs::write(
                &path,
                format!(
                    "{{\"type\":\"session\",\"id\":\"{id}\",\"timestamp\":\"2026-01-01T00:00:00.000Z\",\"cwd\":\"/w\",\"version\":3}}\n{{\"type\":\"message\",\"id\":\"m1\",\"parentId\":null,\"message\":{{\"role\":\"user\",\"content\":\"hi\",\"timestamp\":0}}}}\n"
                ),
            )
            .expect("session file");
            path
        }

        fn options<'a>(
            &'a self,
            http: &'a dyn TraceHttp,
            session_file: Option<&'a Path>,
        ) -> TraceUploadOptions<'a> {
            TraceUploadOptions {
                session_file,
                cwd: &self.cwd,
                agent_dir: &self.agent_dir,
                require_enabled: false,
                reload_config: false,
                base_url: None,
                http,
                request_timeout_ms: DEFAULT_REQUEST_TIMEOUT_MS,
                cancel: None,
                on_upload_delay: None,
            }
        }
    }

    /// The engine reads process env (the credential keys); the tests that
    /// touch it serialize on one lock.
    fn env_lock() -> std::sync::MutexGuard<'static, ()> {
        static LOCK: std::sync::Mutex<()> = std::sync::Mutex::new(());
        LOCK.lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner)
    }

    #[test]
    fn the_header_validation_matches_ts() {
        let fixture = Fixture::new();
        let good = fixture.write_session("good.jsonl", "s1");
        assert!(read_trace_session_header(&good).is_some());
        // A message first line is not a session header.
        let bad = fixture.session_dir.join("bad.jsonl");
        std::fs::write(
            &bad,
            "{\"type\":\"message\",\"id\":\"m\",\"timestamp\":\"t\",\"cwd\":\"/w\"}\n",
        )
        .expect("bad file");
        assert!(read_trace_session_header(&bad).is_none());
        // A blank first line has no header.
        let blank = fixture.session_dir.join("blank.jsonl");
        std::fs::write(&blank, "   \n").expect("blank file");
        assert!(read_trace_session_header(&blank).is_none());
    }

    #[tokio::test]
    // The process env must stay stable across the engine's awaits:
    // the sync env lock is held for the whole test by design.
    #[allow(clippy::await_holding_lock)]
    async fn the_upload_sends_the_ts_request_and_records_the_cursor() {
        let _env = env_lock();
        std::env::remove_var("PRIME_AGENT_TRACES_API_KEY");
        std::env::remove_var("PRIME_API_KEY");
        let fixture = Fixture::new();
        let session = fixture.write_session("s.jsonl", "sid-1");
        std::env::set_var("PRIME_AGENT_TRACES_API_KEY", "trace-key");
        let http = ScriptedTraceHttp::new(vec![response(
            200,
            r#"{"session_id":"sid-1","trace_id":"tid","bytes_stored":42,"key":"k"}"#,
        )]);
        let result = upload_trace_file(&fixture.options(&http, Some(&session))).await;
        assert_eq!(
            result,
            TraceUploadResult::Uploaded {
                session_id: "sid-1".to_string(),
                trace_id: "tid".to_string(),
                bytes_stored: 42,
                key: Some("k".to_string()),
            }
        );
        let (url, headers, body) = http.last_request();
        assert_eq!(
            url,
            "https://api.primeintellect.ai/api/v1/agent-traces/sessions/sid-1"
        );
        let header = |name: &str| {
            headers
                .iter()
                .find(|(key, _)| key == name)
                .map(|(_, value)| value.clone())
                .unwrap()
        };
        assert_eq!(header("Authorization"), "Bearer trace-key");
        assert_eq!(header("Content-Type"), "application/x-ndjson");
        assert_eq!(header("Accept"), "application/json");
        assert_eq!(header("X-Trace-Id"), "sid-1");
        assert_eq!(header("X-Cwd"), "/w");
        assert!(header("X-Agent-Version").contains('.'));
        assert!(body.contains("\"role\":\"user\""));
        // The outbox cursor recorded the upload.
        let signature = TraceUploadSignature::of(&session).expect("signature");
        let recorded = read_agent_trace_outbox_entry(&fixture.agent_dir, &session);
        assert!(signature_equals(recorded, signature));
        // The trace log carries the TS line.
        let log = std::fs::read_to_string(agent_traces_log_path(&fixture.agent_dir)).expect("log");
        assert!(log.contains("uploaded session sid-1 (42 bytes)"), "{log}");
        std::env::remove_var("PRIME_AGENT_TRACES_API_KEY");
    }

    #[tokio::test]
    async fn the_disabled_requirement_gate_matches_ts() {
        let fixture = Fixture::new();
        let session = fixture.write_session("s.jsonl", "sid");
        // Sharing defaults ON, so the disabled gate needs an explicit
        // opt-out on disk; `reload_config` re-reads it before the gate.
        let mut settings =
            crate::settings::SettingsManager::create(&fixture.cwd, &fixture.agent_dir);
        settings
            .set_agent_traces_enabled(false)
            .expect("the opt-out write");
        let http = ScriptedTraceHttp::new(vec![]);
        let mut options = fixture.options(&http, Some(&session));
        options.require_enabled = true;
        options.reload_config = true;
        let result = upload_trace_file(&options).await;
        assert_eq!(result, TraceUploadResult::Disabled);
    }

    #[tokio::test]
    // The process env must stay stable across the engine's awaits:
    // the sync env lock is held for the whole test by design.
    #[allow(clippy::await_holding_lock)]
    async fn a_missing_credential_short_circuits_the_request() {
        let _env = env_lock();
        std::env::remove_var("PRIME_AGENT_TRACES_API_KEY");
        std::env::remove_var("PRIME_API_KEY");
        let fixture = Fixture::new();
        let session = fixture.write_session("s.jsonl", "sid");
        let http = ScriptedTraceHttp::new(vec![]);
        let result = upload_trace_file(&fixture.options(&http, Some(&session))).await;
        assert_eq!(result, TraceUploadResult::MissingCredentials);
    }

    #[tokio::test]
    // The process env must stay stable across the engine's awaits:
    // the sync env lock is held for the whole test by design.
    #[allow(clippy::await_holding_lock)]
    async fn an_oversize_session_reports_the_limit() {
        let _env = env_lock();
        std::env::set_var("PRIME_AGENT_TRACES_API_KEY", "trace-key");
        let fixture = Fixture::new();
        let session = fixture.session_dir.join("big.jsonl");
        let mut file = std::fs::File::create(&session).expect("big file");
        writeln!(
            file,
            "{{\"type\":\"session\",\"id\":\"big\",\"timestamp\":\"t\",\"cwd\":\"/w\"}}"
        )
        .expect("header");
        drop(file);
        std::fs::File::options()
            .append(true)
            .open(&session)
            .expect("reopen")
            .set_len(MAX_TRACE_BYTES + 1)
            .expect("sparse size");
        let http = ScriptedTraceHttp::new(vec![]);
        let result = upload_trace_file(&fixture.options(&http, Some(&session))).await;
        assert_eq!(
            result,
            TraceUploadResult::TooLarge {
                size: MAX_TRACE_BYTES + 1,
                max_bytes: MAX_TRACE_BYTES,
            }
        );
        std::env::remove_var("PRIME_AGENT_TRACES_API_KEY");
    }

    #[tokio::test]
    // The process env must stay stable across the engine's awaits:
    // the sync env lock is held for the whole test by design.
    #[allow(clippy::await_holding_lock)]
    async fn an_error_response_carries_the_status_and_message() {
        let _env = env_lock();
        std::env::set_var("PRIME_AGENT_TRACES_API_KEY", "trace-key");
        let fixture = Fixture::new();
        let session = fixture.write_session("s.jsonl", "sid");
        let http = ScriptedTraceHttp::new(vec![response(404, r#"{"error":{"message":"nope"}}"#)]);
        let result = upload_trace_file(&fixture.options(&http, Some(&session))).await;
        assert_eq!(
            result,
            TraceUploadResult::Failed {
                status_code: Some(404),
                message: "nope".to_string(),
                retry_after_ms: None,
            }
        );
        std::env::remove_var("PRIME_AGENT_TRACES_API_KEY");
    }

    #[tokio::test]
    // The process env must stay stable across the engine's awaits:
    // the sync env lock is held for the whole test by design.
    #[allow(clippy::await_holding_lock)]
    async fn the_retriable_statuses_back_off_and_503_honors_retry_after() {
        let _env = env_lock();
        std::env::set_var("PRIME_AGENT_TRACES_API_KEY", "trace-key");
        let fixture = Fixture::new();
        let session = fixture.write_session("s.jsonl", "sid");
        let http = ScriptedTraceHttp::new(vec![
            Ok(TraceHttpResponse {
                status: 503,
                body: String::new(),
                retry_after: Some("1".to_string()),
            }),
            response(
                200,
                r#"{"session_id":"sid","trace_id":"sid","bytes_stored":1}"#,
            ),
        ]);
        let delays = Arc::new(std::sync::atomic::AtomicU64::new(0));
        let observed = delays.clone();
        let mut options = fixture.options(&http, Some(&session));
        options.on_upload_delay = Some(Arc::new(move |delay| {
            if let TraceUploadDelay::RetryBackoff(ms) = delay {
                observed.fetch_max(ms, Ordering::SeqCst);
            }
        }));
        let result = upload_trace_file(&options).await;
        assert!(matches!(result, TraceUploadResult::Uploaded { .. }));
        // The Retry-After second won over the exponential backoff.
        assert_eq!(delays.load(Ordering::SeqCst), 1000);
        std::env::remove_var("PRIME_AGENT_TRACES_API_KEY");
    }

    #[tokio::test]
    // The process env must stay stable across the engine's awaits:
    // the sync env lock is held for the whole test by design.
    #[allow(clippy::await_holding_lock)]
    async fn the_outbox_cursor_makes_an_enabled_upload_unchanged() {
        let _env = env_lock();
        std::env::set_var("PRIME_AGENT_TRACES_API_KEY", "trace-key");
        let fixture = Fixture::new();
        let session = fixture.write_session("s.jsonl", "sid");
        // The sharing flag gates the run before the cursor: an enabled
        // setting reaches the unchanged check.
        let mut settings =
            crate::settings::SettingsManager::create(&fixture.cwd, &fixture.agent_dir);
        settings
            .set_agent_traces_enabled(true)
            .expect("the enable write");
        let signature = TraceUploadSignature::of(&session).expect("signature");
        record_agent_trace_outbox_upload(&fixture.agent_dir, &session, signature)
            .expect("cursor write");
        let http = ScriptedTraceHttp::new(vec![]);
        let mut options = fixture.options(&http, Some(&session));
        options.require_enabled = true;
        let result = upload_trace_file(&options).await;
        assert_eq!(result, TraceUploadResult::Unchanged);
        std::env::remove_var("PRIME_AGENT_TRACES_API_KEY");
    }

    #[tokio::test]
    async fn the_parent_chain_resolves_the_trace_id() {
        let fixture = Fixture::new();
        let parent = fixture.write_session("parent.jsonl", "root-id");
        let child = fixture.session_dir.join("child.jsonl");
        std::fs::write(
            &child,
            format!(
                "{{\"type\":\"session\",\"id\":\"child-id\",\"timestamp\":\"2026-01-01T00:00:00.000Z\",\"cwd\":\"/w\",\"parentSession\":\"{}\",\"version\":3}}\n",
                parent.display()
            ),
        )
        .expect("child file");
        let header = read_trace_session_header(&child).expect("header");
        let (trace_id, parent_session_id) = resolve_trace_context(&child, &header);
        assert_eq!(trace_id, "root-id");
        assert_eq!(parent_session_id.as_deref(), Some("root-id"));
    }

    #[tokio::test]
    async fn the_active_git_context_walks_leaf_to_root() {
        let fixture = Fixture::new();
        let session = fixture.session_dir.join("s.jsonl");
        std::fs::write(
            &session,
            concat!(
                "{\"type\":\"session\",\"id\":\"s\",\"timestamp\":\"t\",\"cwd\":\"/w\"}\n",
                "{\"type\":\"message\",\"id\":\"m1\",\"parentId\":null,\"message\":{\"role\":\"user\",\"content\":\"hi\",\"timestamp\":0}}\n",
                "{\"type\":\"git_state\",\"id\":\"g1\",\"parentId\":\"m1\",\"git\":{\"repoUrl\":\"https://example/repo\",\"commit\":\"abc\"}}\n",
                "{\"type\":\"message\",\"id\":\"m2\",\"parentId\":\"g1\",\"message\":{\"role\":\"user\",\"content\":\"go\",\"timestamp\":1}}\n",
            ),
        )
        .expect("session file");
        let body = std::fs::read_to_string(&session).expect("body");
        let header = read_trace_session_header(&session).expect("header");
        assert_eq!(
            active_git_context(&body, &header),
            (
                Some("https://example/repo".to_string()),
                Some("abc".to_string())
            )
        );
    }

    #[test]
    fn the_content_preview_splits_head_and_tail() {
        let body = "0123456789abcdef".repeat(4);
        // The marker takes 33 chars of the window; the remaining 6 split
        // into the head and tail halves.
        let (content, truncated) = trace_content_preview(&body, 33 + 6);
        assert!(truncated);
        let parts: Vec<&str> = content.split("... middle of trace omitted ...").collect();
        assert_eq!(parts.len(), 2);
        // The marker's newlines stay with their sides after the split.
        assert_eq!(parts[0].trim_end(), "012");
        assert_eq!(parts[1].trim_start(), "def");
        let (whole, truncated) = trace_content_preview("short", 10);
        assert_eq!(whole, "short");
        assert!(!truncated);
    }

    #[tokio::test]
    async fn the_preview_reports_the_ts_fields() {
        let fixture = Fixture::new();
        let session = fixture.write_session("s.jsonl", "sid-1");
        match preview_trace_file(Some(&session), Some("https://api.example/"), None).await {
            TracePreviewResult::Ready(data) => {
                let (session_id, trace_id, endpoint, uploadable, truncated) = (
                    data.session_id,
                    data.trace_id,
                    data.endpoint,
                    data.uploadable,
                    data.truncated,
                );
                assert_eq!(session_id, "sid-1");
                assert_eq!(trace_id, "sid-1");
                assert_eq!(
                    endpoint,
                    "https://api.example/api/v1/agent-traces/sessions/sid-1"
                );
                assert!(uploadable);
                assert!(!truncated);
            }
            other => panic!("expected a ready preview, got {other:?}"),
        }
        assert_eq!(
            preview_trace_file(None, None, None).await,
            TracePreviewResult::NoSessionFile
        );
    }

    #[tokio::test]
    async fn the_find_walks_both_roots_for_headered_jsonl() {
        let fixture = Fixture::new();
        let session = fixture.write_session("s.jsonl", "sid");
        std::fs::create_dir_all(session_artifacts_root(&fixture.session_dir))
            .expect("artifacts dir");
        std::fs::write(
            session_artifacts_root(&fixture.session_dir).join("notes.txt"),
            "not a session",
        )
        .expect("notes");
        let files = find_trace_files(&fixture.session_dir);
        assert_eq!(files, vec![session]);
    }

    #[test]
    fn the_retry_after_parsing_covers_seconds_and_dates() {
        assert_eq!(retry_after_delay(Some("2"), MAX_TIMER_DELAY_MS), Some(2000));
        assert_eq!(retry_after_delay(Some(""), MAX_TIMER_DELAY_MS), None);
        assert_eq!(retry_after_delay(None, MAX_TIMER_DELAY_MS), None);
        // A past date clamps to zero.
        let past = format_http_date(1000);
        assert_eq!(retry_after_delay(Some(&past), MAX_TIMER_DELAY_MS), Some(0));
        let future_ms = now_ms() + 5000;
        let future = format_http_date(future_ms);
        let parsed = retry_after_delay(Some(&future), MAX_TIMER_DELAY_MS).expect("future");
        assert!((4000..=5000).contains(&parsed), "{parsed}");
    }

    fn format_http_date(ms: u64) -> String {
        let days = ms / 86_400_000;
        let time_ms = ms % 86_400_000;
        let (hour, minute, second) = (
            time_ms / 3_600_000,
            (time_ms % 3_600_000) / 60_000,
            (time_ms % 60_000) / 1000,
        );
        let z = days as i64 + 719_468;
        let era = if z >= 0 { z } else { z - 146_096 } / 146_097;
        let doe = z - era * 146_097;
        let yoe = (doe - doe / 1460 + doe / 36_524 - doe / 146_096) / 365;
        let y = yoe + era * 400;
        let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
        let mp = (5 * doy + 2) / 153;
        let d = doy - (153 * mp + 2) / 5 + 1;
        let m = if mp < 10 { mp + 3 } else { mp - 9 };
        let y = if m <= 2 { y + 1 } else { y };
        let names = [
            "Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec",
        ];
        let weekday = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"][((days + 4) % 7) as usize];
        format!(
            "{weekday}, {d:02} {} {y} {hour:02}:{minute:02}:{second:02} GMT",
            names[(m - 1) as usize]
        )
    }

    #[tokio::test]
    // The process env must stay stable across the engine's awaits:
    // the sync env lock is held for the whole test by design.
    #[allow(clippy::await_holding_lock)]
    async fn the_upload_all_sweeps_with_the_gate_and_tallies() {
        let _env = env_lock();
        std::env::set_var("PRIME_AGENT_TRACES_API_KEY", "trace-key");
        let fixture = Fixture::new();
        fixture.write_session("a.jsonl", "sid-a");
        let http = ScriptedTraceHttp::new(vec![response(
            200,
            r#"{"session_id":"sid-a","bytes_stored":10}"#,
        )]);
        let (progress_tx, mut progress_rx) =
            tokio::sync::mpsc::unbounded_channel::<TraceUploadAllProgress>();
        let options = TraceUploadAllOptions {
            session_dir: Some(&fixture.session_dir),
            cwd: &fixture.cwd,
            agent_dir: &fixture.agent_dir,
            require_enabled: false,
            reload_config: false,
            base_url: None,
            http: &http,
            request_timeout_ms: DEFAULT_REQUEST_TIMEOUT_MS,
            cancel: None,
            on_upload_delay: None,
            // One file keeps the platform rate gate out of the test's
            // wall clock (the second request would wait the minimum
            // interval by design).
            concurrency: Some(1),
            progress: Some(progress_tx),
        };
        let result = upload_all_traces(&options).await;
        assert_eq!(result.total, 1);
        assert_eq!(result.uploaded, 1);
        assert_eq!(result.failed, 0);
        assert_eq!(result.skipped, 0);
        assert_eq!(result.bytes_stored, 10);
        assert_eq!(result.results.len(), 1);
        // The opening progress note plus one per file.
        let mut notes = Vec::new();
        while let Ok(note) = progress_rx.try_recv() {
            notes.push((note.completed, note.total));
        }
        assert_eq!(
            notes,
            vec![(0, 1), (1, 1)],
            "the progress reports completion in file order"
        );
        std::env::remove_var("PRIME_AGENT_TRACES_API_KEY");
    }

    #[tokio::test(start_paused = true)]
    // The process env must stay stable across the engine's awaits:
    // the sync env lock is held for the whole test by design.
    #[allow(clippy::await_holding_lock)]
    async fn the_rate_gate_reports_the_wait_and_serializes() {
        let _env = env_lock();
        std::env::set_var("PRIME_AGENT_TRACES_API_KEY", "trace-key");
        let fixture = Fixture::new();
        let http = ScriptedTraceHttp::new(vec![]);
        let gate = TraceRequestGate::new();
        let delays = Arc::new(std::sync::atomic::AtomicU64::new(0));
        let observed = delays.clone();
        let options = TraceUploadOptions {
            session_file: None,
            cwd: &fixture.cwd,
            agent_dir: &fixture.agent_dir,
            require_enabled: false,
            reload_config: false,
            base_url: None,
            http: &http,
            request_timeout_ms: DEFAULT_REQUEST_TIMEOUT_MS,
            cancel: None,
            on_upload_delay: Some(Arc::new(move |delay| {
                if let TraceUploadDelay::RateLimit(ms) = delay {
                    observed.fetch_max(ms, Ordering::SeqCst);
                }
            })),
        };
        // The first slot arms the interval; the second waits it out.
        gate.before_request(options.cancel, options.on_upload_delay.as_ref())
            .await
            .expect("the first slot");
        gate.before_request(None, options.on_upload_delay.as_ref())
            .await
            .expect("the second slot");
        assert!(delays.load(Ordering::SeqCst) >= TRACE_UPLOAD_ALL_MIN_REQUEST_INTERVAL_MS - 1000);
        std::env::remove_var("PRIME_AGENT_TRACES_API_KEY");
    }

    #[tokio::test]
    // The process env must stay stable across the engine's awaits:
    // the sync env lock is held for the whole test by design.
    #[allow(clippy::await_holding_lock)]
    async fn the_cancel_stops_the_sweep_between_files() {
        let _env = env_lock();
        std::env::set_var("PRIME_AGENT_TRACES_API_KEY", "trace-key");
        let fixture = Fixture::new();
        fixture.write_session("a.jsonl", "sid-a");
        fixture.write_session("b.jsonl", "sid-b");
        let http = ScriptedTraceHttp::new(vec![]);
        let cancel = TraceUploadCancel::new();
        cancel.cancel();
        let options = TraceUploadAllOptions {
            session_dir: Some(&fixture.session_dir),
            cwd: &fixture.cwd,
            agent_dir: &fixture.agent_dir,
            require_enabled: false,
            reload_config: false,
            base_url: None,
            http: &http,
            request_timeout_ms: DEFAULT_REQUEST_TIMEOUT_MS,
            cancel: Some(&cancel),
            on_upload_delay: None,
            concurrency: Some(2),
            progress: None,
        };
        let result = upload_all_traces(&options).await;
        assert_eq!(result.total, 2);
        assert_eq!(result.uploaded, 0);
        assert_eq!(result.skipped, 2);
        std::env::remove_var("PRIME_AGENT_TRACES_API_KEY");
    }

    #[test]
    fn the_uri_component_encoding_matches_javascript() {
        assert_eq!(encode_uri_component("abc-123_._~*'()!"), "abc-123_._~*'()!");
        assert_eq!(encode_uri_component("a/b"), "a%2Fb");
        assert_eq!(encode_uri_component("sp ace"), "sp%20ace");
        assert_eq!(encode_uri_component("ü"), "%C3%BC");
    }

    #[test]
    fn the_outbox_entry_path_is_the_path_hash() {
        let fixture = Fixture::new();
        let session = fixture.session_dir.join("s.jsonl");
        let path = agent_trace_outbox_entry_path(&fixture.agent_dir, &session);
        assert_eq!(path.extension().and_then(|ext| ext.to_str()), Some("json"));
        assert_eq!(path.file_stem().unwrap().len(), 32);
        // The same session file maps to the same entry, a different one
        // does not.
        assert_eq!(
            agent_trace_outbox_entry_path(&fixture.agent_dir, &session),
            path
        );
        assert_ne!(
            agent_trace_outbox_entry_path(&fixture.agent_dir, &fixture.session_dir.join("t.jsonl")),
            path
        );
    }
}

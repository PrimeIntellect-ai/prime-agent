//! The upload concern: the one-session upload options, the outcome-logged
//! upload entry point, the gated perform arm with its cursor/header/context
//! resolution, and the retriable `fetch_with_retry` loop.

use super::{
    active_git_context, delay, encode_uri_component, is_retriable_transport_error,
    log_agent_trace_outcome, read_agent_trace_outbox_entry, read_response_message,
    read_trace_session_header, record_agent_trace_outbox_upload, resolve_trace_context,
    resolve_traces_base_url, retry_after_delay, signature_equals, trace_credential,
    trace_upload_retry_delay, Path, TraceHttp, TraceHttpError, TraceHttpResponse, TraceRequestGate,
    TraceUploadCancel, TraceUploadDelay, TraceUploadDelaySink, TraceUploadResult,
    TraceUploadSignature, Value, MAX_TIMER_DELAY_MS, MAX_TRACE_BYTES, RETRIABLE_HTTP_STATUSES,
    TRACE_UPLOAD_MAX_RETRIES, TRACE_UPLOAD_RATE_LIMIT_WINDOW_MS,
};

/// One upload arm's inputs: the session file (None is TS's
/// `no_session_file`), the daemon-shared directories, and the transport.
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
    /// The reload gate then the setting.
    fn enabled(&self) -> bool {
        let mut settings = crate::settings::SettingsManager::create(self.cwd, self.agent_dir);
        if self.reload_config {
            let _ = settings.reload();
        }
        settings.errors().is_empty() && settings.get_agent_traces_enabled()
    }
}

/// The upload with its outcome logged to the trace log.
pub async fn upload_trace_file(options: &TraceUploadOptions<'_>) -> TraceUploadResult {
    let result = perform_agent_trace_upload(options, None).await;
    log_agent_trace_outcome(options.agent_dir, options.session_file, &result);
    result
}

/// The gate variant is the upload-all call: perform with the shared
/// request slot.
pub(super) async fn perform_agent_trace_upload(
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
    // Bound the read itself: an append racing the initial stat must not allocate
    // an arbitrarily large body or bypass the server's 20 MiB limit.
    let read_body = async {
        use tokio::io::AsyncReadExt;
        let file = tokio::fs::File::open(session_file).await?;
        let mut body = String::new();
        file.take(MAX_TRACE_BYTES + 1)
            .read_to_string(&mut body)
            .await?;
        Ok::<_, std::io::Error>(body)
    };
    let body = match read_body.await {
        Ok(body) => body,
        Err(error) => {
            return TraceUploadResult::Failed {
                status_code: None,
                message: error.to_string(),
                retry_after_ms: None,
            };
        }
    };
    if body.len() as u64 > MAX_TRACE_BYTES {
        return TraceUploadResult::TooLarge {
            size: body.len() as u64,
            max_bytes: MAX_TRACE_BYTES,
        };
    }
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
            };
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

/// The gate runs before every attempt, the retriable statuses/network
/// errors back off with jitter, and 503 honors `Retry-After`.
pub(super) async fn fetch_with_retry(
    options: &TraceUploadOptions<'_>,
    url: &str,
    headers: Vec<(String, String)>,
    body: String,
    before_request: Option<&TraceRequestGate>,
) -> Result<TraceHttpResponse, TraceHttpError> {
    let mut attempt: u32 = 0;
    loop {
        if let Some(gate) = before_request {
            // A cancelled wait ends the upload.
            gate.before_request(options.cancel, options.on_upload_delay.as_ref())
                .await?;
        }
        if options.cancel.is_some_and(TraceUploadCancel::is_cancelled) {
            return Err(TraceHttpError::Cancelled);
        }
        if options.require_enabled && !options.enabled() {
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

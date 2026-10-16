//! Exercise the production uploader against the platform append contract:
//! byte offsets and SHA-256 preconditions, whole-PUT repair, and cursor convergence.
use super::*;

fn header<'a>(request: &'a CapturedRequest, name: &str) -> Option<&'a str> {
    request
        .1
        .iter()
        .find(|(key, _)| key == name)
        .map(|(_, value)| value.as_str())
}

fn sha256(bytes: &[u8]) -> String {
    use sha2::{Digest as _, Sha256};
    format!("{:x}", Sha256::digest(bytes))
}

#[tokio::test]
// Credentials are process-global; the shared fixture lock spans upload awaits.
#[allow(clippy::await_holding_lock)]
async fn whole_upload_then_unicode_tail_satisfies_the_backend_byte_and_hash_preconditions() {
    let _env = env_lock();
    let _credentials = clear_trace_credentials();
    std::env::set_var("PRIME_AGENT_TRACES_API_KEY", "trace-key");
    let fixture = Fixture::new();
    let mut settings = crate::settings::SettingsManager::create(&fixture.cwd, &fixture.agent_dir);
    settings.set_agent_traces_enabled(true).unwrap();
    let session = fixture.write_session("unicode.jsonl", "unicode-session");
    let prefix = std::fs::read_to_string(&session)
        .unwrap()
        .replace("hi", "café 😀");
    std::fs::write(&session, &prefix).unwrap();
    let http = ScriptedTraceHttp::new(vec![Ok(response(200, "{}")), Ok(response(200, "{}"))]);
    let mut options = fixture.options(&http, Some(&session));
    assert!(matches!(
        upload_trace_file(&options).await,
        TraceUploadResult::Uploaded { .. }
    ));
    let full = http.last_request();
    assert_eq!(full.2, prefix);
    assert_eq!(header(&full, "X-Append-Offset"), None);

    let tail = "{\"type\":\"custom\",\"data\":\"résumé 🦀\"}\n";
    std::fs::OpenOptions::new()
        .append(true)
        .open(&session)
        .unwrap()
        .write_all(tail.as_bytes())
        .unwrap();
    assert!(matches!(
        upload_trace_file(&options).await,
        TraceUploadResult::Uploaded { .. }
    ));
    let append = http.last_request();
    assert_eq!(append.0, format!("{}/append", full.0));
    assert_eq!(append.2, tail);
    assert_ne!(
        prefix.len(),
        prefix.chars().count(),
        "fixture distinguishes bytes from characters"
    );
    assert_eq!(
        header(&append, "X-Append-Offset"),
        Some(prefix.len().to_string().as_str())
    );
    assert_eq!(
        header(&append, "X-Append-Prefix-Sha256"),
        Some(sha256(prefix.as_bytes()).as_str())
    );
    let whole = [prefix.as_bytes(), tail.as_bytes()].concat();
    assert_eq!(
        header(&append, "X-Append-Sha256"),
        Some(sha256(&whole).as_str())
    );
    assert_eq!(
        header(&append, "Authorization"),
        header(&full, "Authorization")
    );
    assert_eq!(header(&append, "X-Trace-Id"), Some("unicode-session"));
    // The backend's append response describes the whole stored object. Its
    // cursor must make the next automatic pass quiet, not resend the tail.
    assert!(signature_equals(
        read_agent_trace_outbox_entry(&fixture.agent_dir, &session),
        TraceUploadSignature::of(&session).unwrap()
    ));
    options.require_enabled = true;
    assert_eq!(
        upload_trace_file(&options).await,
        TraceUploadResult::Unchanged
    );
    assert_eq!(http.request_count(), 2);
}

#[tokio::test]
// Credentials are process-global; the shared fixture lock spans upload awaits.
#[allow(clippy::await_holding_lock)]
async fn an_unavailable_append_route_or_prefix_conflict_repairs_the_server_with_a_whole_put() {
    let _env = env_lock();
    let _credentials = clear_trace_credentials();
    std::env::set_var("PRIME_AGENT_TRACES_API_KEY", "trace-key");
    // 404 covers an older backend; 409 is the platform's prefix-mismatch
    // response, including a server copy that was independently replaced.
    for status in [404, 409] {
        let fixture = Fixture::new();
        let session = fixture.write_session("repair.jsonl", "repair-session");
        let prefix = std::fs::read_to_string(&session).unwrap();
        let http = ScriptedTraceHttp::new(vec![
            Ok(response(200, "{}")),
            Ok(response(status, "prefix unavailable")),
            Ok(response(200, "{}")),
        ]);
        let options = fixture.options(&http, Some(&session));
        assert!(matches!(
            upload_trace_file(&options).await,
            TraceUploadResult::Uploaded { .. }
        ));
        let whole = format!("{prefix}{{\"type\":\"custom\",\"data\":\"new tail\"}}\n");
        std::fs::write(&session, &whole).unwrap();
        assert!(matches!(
            upload_trace_file(&options).await,
            TraceUploadResult::Uploaded { .. }
        ));
        let requests = http.requests.lock().unwrap();
        assert_eq!(requests.len(), 3);
        assert_eq!(requests[1].0, format!("{}/append", requests[0].0));
        assert_eq!(requests[1].2.as_bytes(), &whole.as_bytes()[prefix.len()..]);
        assert_eq!(requests[2].0, requests[0].0);
        assert_eq!(requests[2].2, whole);
        for name in [
            "X-Append-Offset",
            "X-Append-Prefix-Sha256",
            "X-Append-Sha256",
        ] {
            assert_eq!(
                header(&requests[2], name),
                None,
                "whole repair must not carry {name}"
            );
        }
        assert!(signature_equals(
            read_agent_trace_outbox_entry(&fixture.agent_dir, &session),
            TraceUploadSignature::of(&session).unwrap()
        ));
    }
}

#[tokio::test]
// Credentials are process-global; the shared fixture lock spans upload awaits.
#[allow(clippy::await_holding_lock)]
async fn an_append_rate_limit_preserves_the_cursor_and_does_not_bypass_the_shared_budget() {
    let _env = env_lock();
    let _credentials = clear_trace_credentials();
    std::env::set_var("PRIME_AGENT_TRACES_API_KEY", "trace-key");
    let fixture = Fixture::new();
    let session = fixture.write_session("limited.jsonl", "limited-session");
    let http = ScriptedTraceHttp::new(vec![
        Ok(response(200, "{}")),
        Ok(TraceHttpResponse {
            status: 429,
            body: "rate limited".into(),
            retry_after: Some("7".into()),
        }),
        Ok(response(200, "{}")),
    ]);
    let options = fixture.options(&http, Some(&session));
    assert!(matches!(
        upload_trace_file(&options).await,
        TraceUploadResult::Uploaded { .. }
    ));
    let old_cursor = read_agent_trace_outbox_entry(&fixture.agent_dir, &session);
    std::fs::OpenOptions::new()
        .append(true)
        .open(&session)
        .unwrap()
        .write_all(b"{\"type\":\"custom\",\"data\":\"queued\"}\n")
        .unwrap();
    assert_eq!(
        upload_trace_file(&options).await,
        TraceUploadResult::Failed {
            status_code: Some(429),
            message: "rate limited".into(),
            retry_after_ms: Some(7_000),
        }
    );
    assert_eq!(
        http.request_count(),
        2,
        "a whole PUT would bypass the append rate limit"
    );
    assert_eq!(
        read_agent_trace_outbox_entry(&fixture.agent_dir, &session),
        old_cursor
    );
    let refused = http.last_request();
    assert!(matches!(
        upload_trace_file(&options).await,
        TraceUploadResult::Uploaded { .. }
    ));
    assert_eq!(
        http.last_request(),
        refused,
        "retry continues from the unadvanced durable cursor"
    );
    assert!(signature_equals(
        read_agent_trace_outbox_entry(&fixture.agent_dir, &session),
        TraceUploadSignature::of(&session).unwrap()
    ));
}

#[tokio::test(start_paused = true)]
// Credentials are process-global; the shared fixture lock spans upload awaits.
#[allow(clippy::await_holding_lock)]
async fn a_lost_append_response_retries_the_identical_idempotent_backend_request() {
    let _env = env_lock();
    let _credentials = clear_trace_credentials();
    std::env::set_var("PRIME_AGENT_TRACES_API_KEY", "trace-key");
    let fixture = Fixture::new();
    let session = fixture.write_session("retry.jsonl", "retry-session");
    let http = ScriptedTraceHttp::new(vec![
        Ok(response(200, "{}")),
        Err(TraceHttpError::Transport(
            "response lost after commit".into(),
        )),
        Ok(response(200, "{}")),
    ]);
    let options = fixture.options(&http, Some(&session));
    assert!(matches!(
        upload_trace_file(&options).await,
        TraceUploadResult::Uploaded { .. }
    ));
    std::fs::OpenOptions::new()
        .append(true)
        .open(&session)
        .unwrap()
        .write_all(b"{\"type\":\"custom\",\"data\":\"retry me\"}\n")
        .unwrap();
    assert!(matches!(
        upload_trace_file(&options).await,
        TraceUploadResult::Uploaded { .. }
    ));
    let requests = http.requests.lock().unwrap();
    assert_eq!(requests.len(), 3);
    assert!(requests[1].0.ends_with("/append"));
    assert_eq!(
        requests[1], requests[2],
        "the backend recognizes already-applied tails by whole hash and resulting size"
    );
    assert!(signature_equals(
        read_agent_trace_outbox_entry(&fixture.agent_dir, &session),
        TraceUploadSignature::of(&session).unwrap()
    ));
}

#[tokio::test]
// Credentials are process-global; the shared fixture lock spans upload awaits.
#[allow(clippy::await_holding_lock)]
async fn stale_offsets_inside_utf8_or_past_eof_repair_with_a_whole_upload() {
    let _env = env_lock();
    let _credentials = clear_trace_credentials();
    std::env::set_var("PRIME_AGENT_TRACES_API_KEY", "trace-key");
    let fixture = Fixture::new();
    let session = fixture.write_session("stale.jsonl", "stale-session");
    let whole = std::fs::read_to_string(&session)
        .unwrap()
        .replace("hi", "😀 rewritten");
    std::fs::write(&session, &whole).unwrap();
    let split_codepoint = whole.find('😀').unwrap() as u64 + 1;
    for stale_size in [split_codepoint, u64::MAX] {
        let signature = TraceUploadSignature {
            size: stale_size,
            ..TraceUploadSignature::of(&session).unwrap()
        };
        record_agent_trace_outbox_upload(&fixture.agent_dir, &session, signature).unwrap();
        let http = ScriptedTraceHttp::new(vec![Ok(response(200, "{}"))]);
        assert!(matches!(
            upload_trace_file(&fixture.options(&http, Some(&session))).await,
            TraceUploadResult::Uploaded { .. }
        ));
        let request = http.last_request();
        assert!(!request.0.ends_with("/append"));
        assert_eq!(request.2, whole);
        assert_eq!(header(&request, "X-Append-Offset"), None);
        assert!(signature_equals(
            read_agent_trace_outbox_entry(&fixture.agent_dir, &session),
            TraceUploadSignature::of(&session).unwrap()
        ));
    }
}

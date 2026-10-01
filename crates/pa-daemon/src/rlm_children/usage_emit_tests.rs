use super::*;
use pa_core::session_engine::rlm_usage::RlmChildUsageReport;
use std::sync::Arc;

/// A capturing sink: reports land in a shared vector for assertions.
#[derive(Default)]
struct CapturingSink(std::sync::Mutex<Vec<RlmChildUsageReport>>);

impl pa_core::session_engine::rlm_usage::RlmChildUsageSink for CapturingSink {
    fn record(
        &self,
        report: RlmChildUsageReport,
    ) -> std::pin::Pin<Box<dyn std::future::Future<Output = ()> + Send + '_>> {
        let reports = &self.0;
        Box::pin(async move {
            reports.lock().expect("reports lock").push(report);
        })
    }

    fn forget(
        &self,
        _rlm_child_id: &str,
    ) -> std::pin::Pin<Box<dyn std::future::Future<Output = ()> + Send + '_>> {
        Box::pin(async move {})
    }
}

/// A child record aimed at a real temp child session file.
fn record_with_file(child_id: &str, session_file: &Path) -> Arc<Mutex<ChildRecord>> {
    Arc::new(Mutex::new(ChildRecord {
        rlm_child_id: child_id.to_string(),
        session_name: "child".to_string(),
        active_session_id: "child-live".to_string(),
        session_id: None,
        session_dir: String::new(),
        label: "child".to_string(),
        started_at_ms: 0,
        settled_status: None,
        settled: false,
        answer_preview: None,
        answer_captured: false,
        replied_since_task: false,
        notice_delivered: false,
        prompt_admitted: true,
        error: None,
        closed_by_parent: false,
        session_file: Some(session_file.display().to_string()),
        attributed_rows: 0,
        usage_watch_live: false,
        usage_rearm: false,
        emit_lock: std::sync::Arc::new(tokio::sync::Mutex::new(())),
    }))
}

fn registry() -> SupervisorChildSessions {
    let tmp = tempfile::tempdir().unwrap();
    let socket = tmp.path().join("supervisor.sock");
    std::mem::forget(tmp);
    SupervisorChildSessions::new(
        Arc::new(SupervisorLink::new(socket)),
        std::path::PathBuf::from("/agent"),
        "parent-live".to_string(),
        std::sync::Arc::new(crate::model_allowlist::ModelRefusalTelemetry::new(
            std::path::PathBuf::from("/agent"),
            /*telemetry_disabled*/ true,
        )),
    )
}

/// A child session file: the task prompt (first user row) plus the
/// captured completion (50,208 input + 2,929 output, $0.0089957 — the
/// branch-verified TS fixture row's child usage).
fn child_file(dir: &Path) -> PathBuf {
    let path = dir.join("child.jsonl");
    std::fs::write(
        &path,
        concat!(
            r#"{"type":"session","id":"child-1","timestamp":"2026-09-23T00:00:00.000Z","cwd":"/tmp","version":3}"#, "\n",
            r#"{"type":"message","id":"u1","parentId":null,"timestamp":"2026-09-23T00:00:01.000Z","message":{"role":"user","content":[{"type":"text","text":"the task"}],"timestamp":0}}"#, "\n",
            r#"{"type":"message","id":"a1","parentId":"u1","timestamp":"2026-09-23T00:00:02.000Z","message":{"role":"assistant","content":[],"stopReason":"toolUse","usage":{"input":50208,"output":2929,"cacheRead":0,"cacheWrite":0,"totalTokens":53137,"cost":{"input":0.0075312,"output":0.0014645,"cacheRead":0,"cacheWrite":0,"total":0.0089957}}}}"#, "\n",
        ),
    )
    .unwrap();
    path
}

/// One emit reads the child's rows past the cursor, delivers the
/// per-origin report, and consumes the rows; a second emit delivers
/// nothing (no double billing).
#[tokio::test]
async fn emit_reads_once_and_advances_the_cursor() {
    let tmp = tempfile::tempdir().unwrap();
    let file = child_file(tmp.path());
    let sessions = registry();
    let sink = Arc::new(CapturingSink::default());
    sessions.set_usage_sink(sink.clone());
    let record = record_with_file("sub-emit1", &file);

    sessions.inner.emit_child_usage(&record).await;
    let reports = sink.0.lock().expect("reports lock").clone();
    assert_eq!(reports.len(), 1);
    assert_eq!(reports[0].rlm_child_id, "sub-emit1");
    let [(origin, usage)] = reports[0].batches[..] else {
        panic!("one batch: {:?}", reports[0].batches);
    };
    assert_eq!(origin, pa_types::session::ChildUsageOrigin::SpawnTask);
    assert_eq!(usage.input, 50_208);
    assert_eq!(usage.output, 2_929);
    assert!((usage.cost.total.as_f64() - 0.008_995_7).abs() < 1e-9);
    let consumed = record.lock().await.attributed_rows;
    assert!(consumed > 0);

    // The cursor consumed the rows: nothing re-delivers.
    sessions.inner.emit_child_usage(&record).await;
    let reports = sink.0.lock().expect("reports lock").clone();
    assert_eq!(reports.len(), 1);
    assert_eq!(record.lock().await.attributed_rows, consumed);
}

/// Without a wired sink nothing is read or consumed: the rows stay
/// attributable once the producer is wired.
#[tokio::test]
async fn emit_without_a_sink_consumes_nothing() {
    let tmp = tempfile::tempdir().unwrap();
    let file = child_file(tmp.path());
    let sessions = registry();
    let record = record_with_file("sub-emit2", &file);

    sessions.inner.emit_child_usage(&record).await;
    assert_eq!(record.lock().await.attributed_rows, 0);
}

/// A record without a session file (the test seam's shape) observes
/// nothing, and a missing file is a silent no-op (the child may not
/// have materialized its file yet).
#[tokio::test]
async fn emit_tolerates_missing_and_absent_files() {
    let tmp = tempfile::tempdir().unwrap();
    let sessions = registry();
    let sink = Arc::new(CapturingSink::default());
    sessions.set_usage_sink(sink.clone());
    let missing = record_with_file("sub-emit3", &tmp.path().join("absent.jsonl"));
    sessions.inner.emit_child_usage(&missing).await;
    assert_eq!(sink.0.lock().expect("reports lock").len(), 0);

    let no_file = record_with_file("sub-emit4", &tmp.path().join("x.jsonl"));
    no_file.lock().await.session_file = None;
    sessions.inner.emit_child_usage(&no_file).await;
    assert_eq!(sink.0.lock().expect("reports lock").len(), 0);
}

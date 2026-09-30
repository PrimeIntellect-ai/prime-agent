//! The payload capture's own battery: the exact-body + envelope contract,
//! the owner-only permission boundary, the symlink refusal, the budget,
//! the ring bound, the name uniqueness, and the dispatch-path contract
//! (record never touches the filesystem).

use super::*;
use serde_json::json;
use std::path::Path;
use std::sync::atomic::Ordering;
use std::sync::Arc;

/// The capture files' names, oldest first (the epoch-lead name order).
pub(crate) fn payload_files(dir: &Path) -> Vec<String> {
    let mut names: Vec<String> = std::fs::read_dir(dir)
        .map(|entries| {
            entries
                .flatten()
                .filter(|entry| entry.file_type().is_ok_and(|file_type| file_type.is_file()))
                .map(|entry| entry.file_name().to_string_lossy().into_owned())
                .filter(|name| Path::new(name).extension().is_some_and(|ext| ext == "json"))
                .collect()
        })
        .unwrap_or_default();
    names.sort();
    names
}

/// Wait until the writer landed `count` capture files: the file is the
/// observable, the deadline bounds failure.
pub(crate) fn wait_for_payload_files(dir: &Path, count: usize) {
    let deadline = std::time::Instant::now() + std::time::Duration::from_secs(30);
    loop {
        let files = payload_files(dir);
        if files.len() >= count {
            return;
        }
        assert!(
            std::time::Instant::now() <= deadline,
            "the capture files never landed: have {files:?}, want {count}"
        );
        std::thread::sleep(std::time::Duration::from_millis(10));
    }
}

/// Wait until the writer's queue is empty (every reservation released).
pub(crate) fn wait_for_drained_queue() {
    let deadline = std::time::Instant::now() + std::time::Duration::from_secs(60);
    loop {
        let queued = super::CAPTURE_WRITER
            .get()
            .and_then(|writer| {
                writer
                    .as_ref()
                    .map(|writer| writer.queued.load(Ordering::Relaxed))
            })
            .expect("the writer is armed");
        if queued == 0 {
            return;
        }
        assert!(
            std::time::Instant::now() <= deadline,
            "the writer queue never drained: {queued} jobs remain"
        );
        std::thread::sleep(std::time::Duration::from_millis(10));
    }
}

/// One capture file's parsed envelope.
pub(crate) fn payload_envelope(dir: &Path, name: &str) -> Value {
    let content = std::fs::read_to_string(dir.join(name)).expect("the capture file reads");
    serde_json::from_str(&content).expect("the capture file is one complete JSON object")
}

fn agent_model() -> pa_agent::types::Model {
    pa_agent::types::Model {
        id: "bench/bench-model".to_string(),
        name: "Bench".to_string(),
        api: "openai-completions".to_string(),
        provider: "bench".to_string(),
        base_url: "https://bench.test/v1".to_string(),
        reasoning: true,
        cost: pa_agent::types::UsageCost::default(),
        context_window: 1_000_000,
        max_tokens: 128_000,
    }
}

fn job(
    root: &Path,
    dir: &Path,
    keep: usize,
    payload: Value,
    request_seq: u64,
    capture_seq: u64,
) -> CaptureJob {
    let estimate = payload_bytes(&payload);
    CaptureJob {
        root: root.to_path_buf(),
        dir: dir.to_path_buf(),
        keep,
        payload,
        model: agent_model(),
        session_id: Some("sess-timing".to_string()),
        request_seq,
        now_ms: 1_700_000_000_000,
        capture_seq,
        estimate,
    }
}

/// Fill the writer's queue until the reserve counter reports it full (the counter is the
/// saturation observable, so the probe below races a provably-full queue).
fn fill_until_saturated(capture: &RequestPayloadCapture, marker_prefix: &str) -> usize {
    let writer = super::CAPTURE_WRITER
        .get()
        .and_then(|writer| writer.as_ref())
        .expect("the writer is armed");
    let mut fills = 0;
    while fills < 2 * REQUEST_PAYLOAD_CAPTURE_KEEP {
        if writer.queued.load(Ordering::Relaxed) >= WRITE_QUEUE_CAPACITY {
            break;
        }
        capture.record(
            &json!({ "marker": format!("{marker_prefix}-{fills}") }),
            &agent_model(),
            Some("sess-timing"),
            fills as u64 + 2,
        );
        fills += 1;
    }
    assert!(
        writer.queued.load(Ordering::Relaxed) >= WRITE_QUEUE_CAPACITY,
        "the fill loop never saturated the queue"
    );
    fills
}

#[test]
fn the_capture_writes_the_exact_body_and_envelope() {
    let _writer_lock = super::WRITER_TEST_LOCK.blocking_lock();
    let dir = tempfile::tempdir().unwrap();
    let dir_path = dir.path().join("request-payloads");
    let payload = json!({"messages": [{"role": "user", "content": "hello \u{1F680}"}]});
    write_capture(
        dir.path(),
        &dir_path,
        64,
        &job(dir.path(), &dir_path, 64, payload, 7, 1),
    )
    .expect("the write persists");
    let names = payload_files(&dir_path);
    assert_eq!(names.len(), 1, "one file per request: {names:?}");
    let envelope = payload_envelope(&dir_path, &names[0]);
    assert_eq!(
        envelope.get("payload"),
        Some(&json!({"messages": [{"role": "user", "content": "hello \u{1F680}"}]})),
        "the file carries the exact outbound body: {envelope}"
    );
    assert_eq!(
        envelope.get("model").and_then(Value::as_str),
        Some("bench/bench-model")
    );
    assert_eq!(
        envelope.get("provider").and_then(Value::as_str),
        Some("bench")
    );
    assert_eq!(envelope.get("sessionId"), Some(&json!("sess-timing")));
    assert_eq!(envelope.get("requestSeq"), Some(&json!(7)));
    assert_eq!(
        envelope.get("requestBytes"),
        Some(&json!(
            serde_json::to_vec(&envelope["payload"]).unwrap().len() as u64
        )),
        "UTF-8 bytes, not a code-unit count: {envelope}"
    );
    assert!(
        envelope.get("ts").and_then(Value::as_str).is_some(),
        "the envelope carries the ISO timestamp: {envelope}"
    );
}

#[cfg(unix)]
#[test]
fn the_capture_writes_owner_only_modes_even_into_an_existing_dir() {
    use std::os::unix::fs::PermissionsExt;
    let _writer_lock = super::WRITER_TEST_LOCK.blocking_lock();
    let dir = tempfile::tempdir().unwrap();
    let dir_path = dir.path().join("request-payloads");
    std::fs::create_dir_all(&dir_path).unwrap();
    std::fs::set_permissions(&dir_path, std::fs::Permissions::from_mode(0o755)).unwrap();
    write_capture(
        dir.path(),
        &dir_path,
        64,
        &job(dir.path(), &dir_path, 64, json!({"a": 1}), 1, 1),
    )
    .expect("the write persists");
    assert_eq!(
        perms::file_mode(&dir_path),
        Some(perms::PRIVATE_DIR_MODE),
        "the existing permissive dir is restricted"
    );
    let name = &payload_files(&dir_path)[0];
    assert_eq!(
        perms::file_mode(&dir_path.join(name)),
        Some(perms::PRIVATE_FILE_MODE),
        "the capture file is owner-only"
    );
}

#[cfg(unix)]
#[test]
fn symlinked_components_end_the_capture_before_any_write() {
    let _writer_lock = super::WRITER_TEST_LOCK.blocking_lock();
    let dir = tempfile::tempdir().unwrap();
    // A symlinked ring directory: <agent>/request-payloads -> <attacker>.
    let attacker = dir.path().join("attacker");
    std::fs::create_dir_all(&attacker).unwrap();
    let symlinked_ring = dir.path().join("request-payloads");
    std::os::unix::fs::symlink(&attacker, &symlinked_ring).unwrap();
    let error = write_capture(
        dir.path(),
        &symlinked_ring,
        64,
        &job(dir.path(), &symlinked_ring, 64, json!({"a": 1}), 1, 1),
    )
    .expect_err("the symlinked ring is refused");
    assert_eq!(error.kind(), std::io::ErrorKind::InvalidInput);
    assert!(
        payload_files(&attacker).is_empty(),
        "nothing reached the symlink target"
    );

    // A symlinked intermediate component (the `logs` tree): the ring
    // directory is never created through the link.
    let logs_link = dir.path().join("logs");
    std::os::unix::fs::symlink(&attacker, &logs_link).unwrap();
    let through_link = logs_link.join("request-payloads");
    let error = write_capture(
        dir.path(),
        &through_link,
        64,
        &job(dir.path(), &through_link, 64, json!({"b": 2}), 1, 2),
    )
    .expect_err("the symlinked logs component is refused");
    assert_eq!(error.kind(), std::io::ErrorKind::InvalidInput);
    assert!(
        payload_files(&attacker).is_empty(),
        "nothing reached the symlink target"
    );
}

#[test]
fn a_failed_write_takes_its_temp_file_with_it() {
    let _writer_lock = super::WRITER_TEST_LOCK.blocking_lock();
    let dir = tempfile::tempdir().unwrap();
    let dir_path = dir.path().join("request-payloads");
    std::fs::create_dir_all(&dir_path).unwrap();
    // The target exists as a directory, so the rename fails.
    let target = dir_path.join(format!(
        "1700000000000-{}-00000007.json",
        std::process::id()
    ));
    std::fs::create_dir_all(&target).unwrap();
    let payload = json!({"messages": [{"role": "user", "content": "hello"}]});
    let error = write_capture(
        dir.path(),
        &dir_path,
        64,
        &job(dir.path(), &dir_path, 64, payload, 7, 7),
    )
    .expect_err("the blocked rename fails the write");
    assert_ne!(error.kind(), std::io::ErrorKind::InvalidInput);
    let temps: Vec<String> = std::fs::read_dir(&dir_path)
        .unwrap()
        .flatten()
        .map(|entry| entry.file_name().to_string_lossy().into_owned())
        .filter(|name| Path::new(name).extension().is_some_and(|ext| ext == "tmp"))
        .collect();
    assert!(
        temps.is_empty(),
        "the failed write cleaned up its temp: {temps:?}"
    );
    assert_eq!(
        payload_files(&dir_path).len(),
        0,
        "no capture landed through the failure"
    );
}

#[test]
fn an_over_budget_body_drops_without_cloning() {
    let _writer_lock = super::WRITER_TEST_LOCK.blocking_lock();
    let dir = tempfile::tempdir().unwrap();
    let dir_path = dir.path().join("request-payloads");
    let capture = RequestPayloadCapture::at(&dir_path, 8);
    // The stall: a many-node body serialized for far longer than the three records, so
    // the third is priced while the earlier reservations hold.
    let stall = json!({
        "marker": "stall",
        "messages": (0..20_000_u32).map(|seq| json!({ "seq": seq })).collect::<Vec<_>>()
    });
    // Three bodies each estimating near a third of the budget: the
    // third would cross it and drops at the budget gate.
    let body_x = json!({ "marker": "budget-x", "body": "x".repeat(8 * 1024 * 1024) });
    let body_y = json!({ "marker": "budget-y", "body": "y".repeat(8 * 1024 * 1024) });
    let body_z = json!({ "marker": "budget-z", "body": "z".repeat(8 * 1024 * 1024) });
    assert!(payload_bytes(&body_x) * 2 < REQUEST_PAYLOAD_BUDGET_BYTES);
    assert!(payload_bytes(&body_x) * 3 > REQUEST_PAYLOAD_BUDGET_BYTES);
    capture.record(&stall, &agent_model(), Some("sess-timing"), 0);
    capture.record(&body_x, &agent_model(), Some("sess-timing"), 1);
    capture.record(&body_y, &agent_model(), Some("sess-timing"), 2);
    capture.record(&body_z, &agent_model(), Some("sess-timing"), 3);
    wait_for_payload_files(&dir_path, 3);
    wait_for_drained_queue();
    capture.record(
        &json!({ "marker": "recovered" }),
        &agent_model(),
        Some("sess-timing"),
        4,
    );
    wait_for_payload_files(&dir_path, 4);
    let files = payload_files(&dir_path);
    let landed = files
        .iter()
        .map(|name| {
            payload_envelope(&dir_path, name)["payload"]["marker"]
                .as_str()
                .expect("the envelope carries the marker")
                .to_string()
        })
        .collect::<Vec<_>>();
    assert_eq!(
        landed,
        ["stall", "budget-x", "budget-y", "recovered"],
        "the over-budget body never landed; the recovered handoff did"
    );
    assert!(
        !files.iter().any(|name| {
            std::fs::read_to_string(dir_path.join(name))
                .is_ok_and(|content| content.contains("budget-z"))
        }),
        "the dropped body exists nowhere in the ring"
    );
}

#[test]
fn the_ring_keeps_the_newest_bodies() {
    let _writer_lock = super::WRITER_TEST_LOCK.blocking_lock();
    let dir = tempfile::tempdir().unwrap();
    let dir_path = dir.path().join("request-payloads");
    for seq in 1..=3u64 {
        write_capture(
            dir.path(),
            &dir_path,
            2,
            &job(
                dir.path(),
                &dir_path,
                2,
                json!({ "request": seq }),
                seq,
                seq,
            ),
        )
        .expect("the write persists");
    }
    let names = payload_files(&dir_path);
    assert_eq!(names.len(), 2, "the ring keeps the configured size");
    let bodies: Vec<u64> = names
        .iter()
        .map(|name| {
            payload_envelope(&dir_path, name)["payload"]["request"]
                .as_u64()
                .expect("the parsed envelope carries the body")
        })
        .collect();
    assert_eq!(bodies, [2, 3], "the oldest body left first: {bodies:?}");
}

#[test]
fn two_wirings_sharing_one_dir_each_keep_their_capture() {
    let _writer_lock = super::WRITER_TEST_LOCK.blocking_lock();
    let dir = tempfile::tempdir().unwrap();
    let dir_path = dir.path().join("request-payloads");
    let wiring_a = RequestPayloadCapture::at(&dir_path, 64);
    let wiring_b = RequestPayloadCapture::at(&dir_path, 64);
    wiring_a.record(&json!({"wiring": "a"}), &agent_model(), Some("sess-a"), 1);
    wiring_b.record(&json!({"wiring": "b"}), &agent_model(), Some("sess-b"), 1);
    wait_for_payload_files(&dir_path, 2);
    let names = payload_files(&dir_path);
    let mut wirings = names
        .iter()
        .map(|name| {
            payload_envelope(&dir_path, name)["payload"]["wiring"]
                .as_str()
                .expect("the parsed envelope carries the body")
                .to_string()
        })
        .collect::<Vec<_>>();
    wirings.sort();
    assert_eq!(wirings, ["a", "b"], "both captures survived intact");
}

#[test]
fn two_sessions_captures_own_their_directories() {
    let _writer_lock = super::WRITER_TEST_LOCK.blocking_lock();
    let dir = tempfile::tempdir().unwrap();
    let dir_a = dir.path().join("agent-a").join("request-payloads");
    let dir_b = dir.path().join("agent-b").join("request-payloads");
    let capture_a = RequestPayloadCapture::at(&dir_a, 8);
    let capture_b = RequestPayloadCapture::at(&dir_b, 8);
    for seq in 0..3 {
        capture_a.record(
            &json!({"session": "a", "seq": seq}),
            &agent_model(),
            Some("sess-a"),
            seq,
        );
        capture_b.record(
            &json!({"session": "b", "seq": seq}),
            &agent_model(),
            Some("sess-b"),
            seq,
        );
    }
    wait_for_payload_files(&dir_a, 3);
    wait_for_payload_files(&dir_b, 3);
    for (path, session) in [(&dir_a, "a"), (&dir_b, "b")] {
        let envelopes: Vec<Value> = payload_files(path)
            .iter()
            .map(|name| payload_envelope(path, name))
            .collect();
        assert_eq!(
            envelopes.len(),
            3,
            "each ring holds exactly its own captures"
        );
        for envelope in &envelopes {
            assert_eq!(envelope["payload"]["session"], json!(session));
            assert_eq!(envelope["sessionId"], json!(format!("sess-{session}")));
        }
    }
}

#[test]
fn an_unwritable_target_disables_the_capture_silently() {
    let _writer_lock = super::WRITER_TEST_LOCK.blocking_lock();
    let dir = tempfile::tempdir().unwrap();
    // A FILE where the capture's directory would be: every write fails.
    let blocker = dir.path().join("request-payloads");
    std::fs::write(&blocker, "a file, not a directory").unwrap();
    let capture = RequestPayloadCapture::at(&blocker, 64);
    capture.record(&json!({"a": 1}), &agent_model(), Some("sess-timing"), 1);
    capture.record(&json!({"a": 2}), &agent_model(), Some("sess-timing"), 2);
    // Nothing can ever appear on the blocker: a failed capture stays
    // silent.
    assert_eq!(
        std::fs::read_to_string(&blocker).unwrap(),
        "a file, not a directory",
        "the capture never replaces the blocker with a directory"
    );
}

#[test]
fn a_record_hands_off_without_waiting_for_the_write() {
    let _writer_lock = super::WRITER_TEST_LOCK.blocking_lock();
    let dir = tempfile::tempdir().unwrap();
    let dir_path = dir.path().join("request-payloads");
    let capture = RequestPayloadCapture::at(&dir_path, 64);
    let big = "x".repeat(8 * 1024 * 1024);
    let payload = json!({"messages": [{"role": "user", "content": big}]});
    let started = std::time::Instant::now();
    capture.record(&payload, &agent_model(), Some("sess-timing"), 1);
    let handed_off = started.elapsed();
    // The clone on the dispatch path is bounded by memory, not by the
    // disk: handing this body off costs milliseconds.
    assert!(
        handed_off < std::time::Duration::from_secs(2),
        "the handoff is memory-bounded: {handed_off:?}"
    );
    assert!(
        payload_files(&dir_path).is_empty(),
        "the write happens on the writer thread, after record returns"
    );
    wait_for_payload_files(&dir_path, 1);
    let names = payload_files(&dir_path);
    let envelope = payload_envelope(&dir_path, &names[0]);
    assert_eq!(
        envelope.get("requestBytes"),
        Some(&json!(serde_json::to_vec(&payload).unwrap().len() as u64)),
        "the writer persisted the whole body: {envelope:?}"
    );
}

/// The slot reserve precedes the clone; the self-calibrating bound compares the probe's
/// handoff against the same body's measured clone cost.
#[test]
fn a_saturated_queue_drops_without_cloning() {
    let _writer_lock = super::WRITER_TEST_LOCK.blocking_lock();
    let dir = tempfile::tempdir().unwrap();
    let dir_path = dir.path().join("request-payloads");
    // The ring keeps every body: the count assertions need no eviction.
    let capture = RequestPayloadCapture::at(&dir_path, 4 * REQUEST_PAYLOAD_CAPTURE_KEEP);
    // The stall body: a many-node body the writer serializes for far
    // longer than the whole test window, so no slot frees mid-probe.
    let stall = json!({
        "marker": "stall",
        "messages": (0..100_000_u32).map(|seq| json!({ "seq": seq })).collect::<Vec<_>>()
    });
    capture.record(&stall, &agent_model(), Some("sess-timing"), 1);
    // The fill: the queue is saturated against the reserve counter.
    let fills = fill_until_saturated(&capture, "fill");
    // The probe: the same shape as the calibration body — its clone is
    // measurably slow, its reserve-check drop is not.
    let big = "x".repeat(128 * 1024 * 1024);
    let probe = json!({ "messages": [{"role": "user", "content": big}] });
    let clone_started = std::time::Instant::now();
    let calibration = probe.clone();
    let clone_cost = clone_started.elapsed();
    drop(calibration);
    let probe_started = std::time::Instant::now();
    capture.record(&probe, &agent_model(), Some("sess-timing"), 99);
    let probe_cost = probe_started.elapsed();
    assert!(
        probe_cost + probe_cost < clone_cost,
        "the saturated handoff must not pay the clone: probe {probe_cost:?} vs clone {clone_cost:?}"
    );
    wait_for_drained_queue();
    capture.record(
        &json!({ "marker": "recovered" }),
        &agent_model(),
        Some("sess-timing"),
        u64::MAX,
    );
    wait_for_payload_files(&dir_path, fills + 2);
    let landed = payload_files(&dir_path);
    let fill_count = landed
        .iter()
        .filter(|name| {
            std::fs::read_to_string(dir_path.join(name))
                .is_ok_and(|content| content.contains("fill-"))
        })
        .count();
    assert_eq!(
        fill_count, fills,
        "every fill landed (the fills are part of the saturated queue's content)"
    );
    assert_eq!(
        landed.len(),
        fill_count + 2,
        "the stall body, every fill, and the recovery — the probe exists nowhere"
    );
    assert!(
        !landed.iter().any(|name| {
            std::fs::metadata(dir_path.join(name)).is_ok_and(|meta| meta.len() > 16 * 1024 * 1024)
        }),
        "no probe-sized body landed"
    );
}

#[test]
fn concurrent_producers_drop_at_the_reserve_when_the_queue_is_full() {
    let _writer_lock = super::WRITER_TEST_LOCK.blocking_lock();
    let dir = tempfile::tempdir().unwrap();
    let dir_path = dir.path().join("request-payloads");
    // The ring keeps every body: the count assertions need no eviction.
    let capture = RequestPayloadCapture::at(&dir_path, 4 * REQUEST_PAYLOAD_CAPTURE_KEEP);
    // The stall body: serialized for far longer than the whole storm
    // window, so no slot frees mid storm.
    let stall = json!({
        "marker": "stall",
        "messages": (0..100_000_u32).map(|seq| json!({ "seq": seq })).collect::<Vec<_>>()
    });
    capture.record(&stall, &agent_model(), Some("sess-timing"), 1);
    let fills = fill_until_saturated(&capture, "fill");
    // The storm: many concurrent producers racing the full queue; none
    // of their bodies exists anywhere afterwards.
    let producers = 4 * REQUEST_PAYLOAD_CAPTURE_KEEP;
    let barrier = Arc::new(std::sync::Barrier::new(producers + 1));
    let mut handles = Vec::new();
    for producer in 0..producers {
        let capture = capture.clone();
        let barrier = Arc::clone(&barrier);
        handles.push(std::thread::spawn(move || {
            barrier.wait();
            capture.record(
                &json!({ "marker": format!("storm-{producer}") }),
                &agent_model(),
                Some("sess-timing"),
                u64::MAX,
            );
        }));
    }
    barrier.wait();
    for handle in handles {
        handle.join().expect("the producer finishes");
    }
    let queued_after = super::CAPTURE_WRITER
        .get()
        .and_then(|writer| {
            writer
                .as_ref()
                .map(|writer| writer.queued.load(Ordering::Relaxed))
        })
        .expect("the writer is armed");
    assert!(
        queued_after <= REQUEST_PAYLOAD_CAPTURE_KEEP,
        "the reserve counter stays within the capacity: {queued_after}"
    );
    // A fresh handoff still reserves after the storm — a leaked
    // reservation would report saturation forever.
    wait_for_drained_queue();
    capture.record(
        &json!({ "marker": "recovered" }),
        &agent_model(),
        Some("sess-timing"),
        u64::MAX,
    );
    wait_for_payload_files(&dir_path, fills + 2);
    let landed = payload_files(&dir_path);
    let storm_body = landed.iter().any(|name| {
        std::fs::read_to_string(dir_path.join(name)).is_ok_and(|content| content.contains("storm-"))
    });
    assert!(
        !storm_body,
        "no storm body may land: every storm producer dropped at the reserve"
    );
    assert_eq!(
        landed.len(),
        fills + 2,
        "the stall body, every fill, and the recovery body: the queue bound held"
    );
}

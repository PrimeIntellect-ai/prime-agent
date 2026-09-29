//! The payload capture's own battery: the exact-body + envelope contract,
//! the owner-only permission boundary, the ring bound, the name uniqueness
//! across wirings sharing one directory, and the dispatch-path contract
//! (record never touches the filesystem; a slow or failing writer never
//! delays the request it observes).

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
                .map(|entry| entry.file_name().to_string_lossy().into_owned())
                .filter(|name| Path::new(name).extension().is_some_and(|ext| ext == "json"))
                .collect()
        })
        .unwrap_or_default();
    names.sort();
    names
}

/// Wait until the writer thread landed `count` capture files: the file is
/// the observable, the deadline bounds failure (a timeout fails the
/// test, never passes it).
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

fn job(dir: &Path, keep: usize, payload: Value, request_seq: u64, capture_seq: u64) -> CaptureJob {
    CaptureJob {
        dir: dir.to_path_buf(),
        keep,
        payload,
        model: agent_model(),
        session_id: Some("sess-timing".to_string()),
        request_seq,
        now_ms: 1_700_000_000_000,
        capture_seq,
    }
}

#[test]
fn the_capture_writes_the_exact_body_and_envelope() {
    let dir = tempfile::tempdir().unwrap();
    let dir_path = dir.path().join("request-payloads");
    let payload = json!({"messages": [{"role": "user", "content": "hello \u{1F680}"}]});
    write_capture(&dir_path, 64, &job(&dir_path, 64, payload, 7, 1)).expect("the write persists");
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

/// The capture is a confidentiality boundary, not just a diagnostic: the
/// request bodies carry the whole transcript (system prompt, messages,
/// tool output), so the ring's directory and every file are owner-only —
/// including when the directory already exists with permissive modes (a
/// shared or different-umask agent dir).
#[cfg(unix)]
#[test]
fn the_capture_writes_owner_only_modes_even_into_an_existing_dir() {
    use std::os::unix::fs::PermissionsExt;
    let dir = tempfile::tempdir().unwrap();
    let dir_path = dir.path().join("request-payloads");
    std::fs::create_dir_all(&dir_path).unwrap();
    std::fs::set_permissions(&dir_path, std::fs::Permissions::from_mode(0o755)).unwrap();
    write_capture(&dir_path, 64, &job(&dir_path, 64, json!({"a": 1}), 1, 1))
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

#[test]
fn the_ring_keeps_the_newest_bodies() {
    let dir = tempfile::tempdir().unwrap();
    let dir_path = dir.path().join("request-payloads");
    for seq in 1..=3u64 {
        write_capture(
            &dir_path,
            2,
            &job(&dir_path, 2, json!({ "request": seq }), seq, seq),
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
    assert!(
        !dir_path
            .join(format!(
                "{}-{}-{:08}.json",
                1_700_000_000_000u64,
                std::process::id(),
                1u64
            ))
            .exists(),
        "the evicted file is removed"
    );
}

/// Two session wirings share one agent dir and both restart their wire
/// sequence at 1: the capture's file names stay unique (the process-wide
/// counter), so neither body truncates the other.
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

/// The dispatch-path contract: [`RequestPayloadCapture::record`] never
/// touches the filesystem — the writer thread owns the serialization and
/// the writes — so a slow writer can never delay the request that handed
/// the body off. The observable: the file does not exist yet when record
/// returns for a body this large, and lands afterwards.
#[test]
fn a_record_hands_off_without_waiting_for_the_write() {
    let _writer_lock = super::WRITER_TEST_LOCK.blocking_lock();
    let dir = tempfile::tempdir().unwrap();
    let dir_path = dir.path().join("request-payloads");
    let capture = RequestPayloadCapture::at(&dir_path, 64);
    let big = "x".repeat(32 * 1024 * 1024);
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

/// A capture whose directory cannot exist (a file sits on the path) is
/// silently disabled: the handoff succeeds, nothing panics, and the
/// request-timing integration (the failing-capture wiring test) keeps the
/// request itself untouched.
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
    // The handoffs succeeded and nothing can ever appear on the blocker:
    // a failed capture stays silent (the integration test proves the
    // request path is unaffected).
    assert_eq!(
        std::fs::read_to_string(&blocker).unwrap(),
        "a file, not a directory",
        "the capture never replaces the blocker with a directory"
    );
}

/// One writer serves the whole process: two sessions' captures (two
/// rings, two directories) hand off to the same bounded writer and each
/// owns its own directory — no cross-writes, no per-session thread.
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

/// The saturated-queue handoff stays O(1): the queue slot is reserved
/// BEFORE the payload clone, so a stalled writer with a full queue drops
/// the capture without paying the copy. The test calibrates its own
/// machine — the same body's clone cost measured directly — and pins the
/// saturated handoff to well under half of it.
#[test]
fn a_saturated_queue_drops_without_cloning() {
    let _writer_lock = super::WRITER_TEST_LOCK.blocking_lock();
    let dir = tempfile::tempdir().unwrap();
    let dir_path = dir.path().join("request-payloads");
    let capture = RequestPayloadCapture::at(&dir_path, REQUEST_PAYLOAD_CAPTURE_KEEP);
    // A body big enough that its clone cost is machine-measurable, and
    // big enough that the writer stays busy on it while the queue fills.
    let big = "x".repeat(128 * 1024 * 1024);
    let big_payload = json!({"messages": [{"role": "user", "content": big}]});
    // The calibration: the very copy the saturated path must not pay.
    let clone_started = std::time::Instant::now();
    let calibration = big_payload.clone();
    let clone_cost = clone_started.elapsed();
    drop(calibration);
    // The stall: the writer serializes and writes this first body for a
    // long while after taking it.
    capture.record(&big_payload, &agent_model(), Some("sess-timing"), 1);
    // Fill the one bounded queue behind it (the writer holds the first
    // body's slot open on itself; these are tiny and queue instantly).
    for seq in 0..REQUEST_PAYLOAD_CAPTURE_KEEP {
        capture.record(
            &json!({ "fill": seq, "marker": format!("fill-{seq}") }),
            &agent_model(),
            Some("sess-timing"),
            seq as u64 + 2,
        );
    }
    // The saturated handoff: the queue is full, so this body is dropped
    // at the reserve check — no clone.
    let probe_started = std::time::Instant::now();
    capture.record(&big_payload, &agent_model(), Some("sess-timing"), 99);
    let probe_cost = probe_started.elapsed();
    assert!(
        probe_cost + probe_cost < clone_cost,
        "the saturated handoff must not pay the clone: probe {probe_cost:?} vs clone {clone_cost:?}"
    );
    // The queue drains: the last fill body lands (the drain's tail), and
    // the probe's body never lands — it was dropped at the reserve.
    let marker = format!("fill-{}", REQUEST_PAYLOAD_CAPTURE_KEEP - 1);
    let deadline = std::time::Instant::now() + std::time::Duration::from_secs(60);
    loop {
        let drained = payload_files(&dir_path).iter().any(|name| {
            std::fs::read_to_string(dir_path.join(name))
                .is_ok_and(|content| content.contains(&marker))
        });
        assert!(
            std::time::Instant::now() <= deadline,
            "the fill bodies never landed"
        );
        if drained {
            break;
        }
        std::thread::sleep(std::time::Duration::from_millis(20));
    }
    // The ring settles behind the drain: the first body (the oldest
    // name) ages out as the fills land, and the probe (a 128 MiB body)
    // never landed — it was dropped at the reserve check, never queued.
    let settle_deadline = std::time::Instant::now() + std::time::Duration::from_secs(30);
    loop {
        let oversized = payload_files(&dir_path)
            .iter()
            .filter(|name| {
                std::fs::metadata(dir_path.join(name)).is_ok_and(|meta| meta.len() > 1024 * 1024)
            })
            .count();
        assert!(
            std::time::Instant::now() <= settle_deadline,
            "the ring never settled after the drain"
        );
        if oversized == 0 {
            break;
        }
        std::thread::sleep(std::time::Duration::from_millis(20));
    }
    for name in payload_files(&dir_path) {
        let content = std::fs::read_to_string(dir_path.join(&name)).unwrap();
        assert!(
            content.contains("fill-"),
            "only the fill bodies exist in the ring: {name}"
        );
    }
}

/// The concurrent-producers pin: a concurrent storm over a
/// pre-saturated queue — every producer drops at the reserve check, so
/// no storm body is cloned, queued, or landed (the file set is exactly
/// the stall body, the fills, and the recovery body), the counter never
/// exceeds the capacity, and a fresh handoff still reserves after the
/// storm (no reservation leak).
#[test]
fn concurrent_producers_drop_at_the_reserve_when_the_queue_is_full() {
    let _writer_lock = super::WRITER_TEST_LOCK.blocking_lock();
    let dir = tempfile::tempdir().unwrap();
    let dir_path = dir.path().join("request-payloads");
    // The ring keeps every body: the count assertions need no eviction.
    let capture = RequestPayloadCapture::at(&dir_path, 4 * REQUEST_PAYLOAD_CAPTURE_KEEP);
    // The stall body: a many-node body the writer serializes for far
    // longer than the whole storm window, so no queue slot frees mid
    // storm (a released slot would let a producer through — the fills
    // below pre-saturate the queue behind the stalled writer).
    let stall = json!({
        "marker": "stall",
        "messages": (0..200_000_u32).map(|seq| json!({ "seq": seq })).collect::<Vec<_>>()
    });
    capture.record(&stall, &agent_model(), Some("sess-timing"), 1);
    for seq in 0..REQUEST_PAYLOAD_CAPTURE_KEEP {
        capture.record(
            &json!({ "marker": format!("fill-{seq}") }),
            &agent_model(),
            Some("sess-timing"),
            seq as u64 + 2,
        );
    }
    // The storm: many concurrent producers, each with its own marker,
    // racing the full queue. Every one drops at the reserve check —
    // the assertions below are the observable: none of their bodies
    // exists anywhere afterwards.
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
    // The counter never exceeded the capacity and leaked nothing.
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
    // The drain lands the stall body and every fill — the storm left
    // nothing behind it (a storm body in the files would mean an
    // unreserved clone reached the queue).
    let deadline = std::time::Instant::now() + std::time::Duration::from_secs(60);
    loop {
        let files = payload_files(&dir_path);
        assert!(
            std::time::Instant::now() <= deadline,
            "the drain never completed: {} files",
            files.len()
        );
        if files.len() > REQUEST_PAYLOAD_CAPTURE_KEEP {
            let storm_landed = files.iter().any(|name| {
                std::fs::read_to_string(dir_path.join(name))
                    .is_ok_and(|content| content.contains("\"storm-"))
            });
            assert!(
                !storm_landed,
                "no storm body may land: every storm producer dropped at the reserve"
            );
            break;
        }
        std::thread::sleep(std::time::Duration::from_millis(20));
    }
    // A fresh handoff after the storm still reserves and lands — a
    // leaked reservation would report saturation forever.
    capture.record(
        &json!({ "marker": "recovered" }),
        &agent_model(),
        Some("sess-timing"),
        u64::MAX,
    );
    loop {
        let files = payload_files(&dir_path);
        let recovered = files.iter().any(|name| {
            std::fs::read_to_string(dir_path.join(name))
                .is_ok_and(|content| content.contains("\"recovered\""))
        });
        assert!(
            std::time::Instant::now() <= deadline,
            "the recovery body never landed after the drain"
        );
        if recovered {
            assert_eq!(
                files.len(),
                REQUEST_PAYLOAD_CAPTURE_KEEP + 2,
                "the stall body, every fill, and the recovery body: the queue bound held"
            );
            break;
        }
        std::thread::sleep(std::time::Duration::from_millis(20));
    }
}

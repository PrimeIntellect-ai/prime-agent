use super::*;

#[test]
fn window_preserves_transcript_metadata_and_append_then_hydrate() {
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("session.jsonl");
    let mut full = SessionFile::create("/tmp", None, 0);
    full.set_path(path.clone());
    full.append_session_info("old name");
    full.append_thinking_level_change("high");
    full.append_message(json!({
        "role":"assistant", "provider":"openai", "model":"test", "api":"openai-responses",
        "content":[{"type":"toolCall","id":"call","name":"bash","arguments":{}}],
        "stopReason":"toolUse", "timestamp":0,
        "usage":{"input":10,"output":5,"cacheRead":3,"cacheWrite":2,"totalTokens":20,
        "cost":{"input":0.1,"output":0.2,"cacheRead":0.3,"cacheWrite":0.4,"total":1.0}}
    }));
    let mut kept = String::new();
    for i in 0..220 {
        let id = full
            .append_message(json!({"role":"user","content":format!("message {i}"),"timestamp":i}));
        if i == 210 {
            kept = id;
        }
    }
    full.append_entry(
        "compaction",
        json!({"summary":"summary","firstKeptEntryId":kept,"tokensBefore":10000}),
    );
    full.append_message(json!({"role":"user","content":"after","timestamp":221}));
    full.rewrite().unwrap();
    let lease = crate::lease::acquire_runtime_session_lease(&path, dir.path()).unwrap();
    let mut window = SessionFile::open_windowed(&path).unwrap();
    window.lease = Some(std::sync::Arc::new(lease));
    assert!(window.window.is_some());
    assert_eq!(window.messages(), full.messages());
    assert_eq!(
        (
            window.message_count(),
            window.first_message(),
            window.session_name()
        ),
        (
            full.message_count(),
            full.first_message(),
            full.session_name()
        )
    );
    assert_eq!(
        crate::session_stats::session_stats(&window, Some(100000)),
        crate::session_stats::session_stats(&full, Some(100000))
    );
    assert!(window.rewrite().is_err());
    window
        .persist_entry(
            "message",
            json!({"message":{"role":"user","content":"appended","timestamp":222}}),
        )
        .unwrap();
    let warm = pa_core::session::window::WindowedSessionStore::open(&path)
        .unwrap()
        .unwrap();
    assert!(warm.read_stats().cache_hit);
    assert!(window.has_thinking_level());
    assert_eq!(window.compaction_count(), full.compaction_count());
    window
        .persist_entry("session_info", json!({"name":"renamed"}))
        .unwrap();
    window
        .persist_entry("session_state", json!({"state":{"status":"active"}}))
        .unwrap();
    let reopened_window = SessionFile::open_windowed(&path).unwrap();
    let reopened_full = SessionFile::open(&path).unwrap();
    assert_eq!(reopened_window.messages(), reopened_full.messages());
    assert_eq!(reopened_window.session_name(), Some("renamed"));
    assert_eq!(reopened_window.state(), reopened_full.state());
    assert_eq!(
        crate::session_stats::session_stats(&reopened_window, Some(100000)),
        crate::session_stats::session_stats(&reopened_full, Some(100000))
    );
    window.append_session_info("pending name");
    let leaf = window.leaf_id.clone();
    window.ensure_full_history().unwrap();
    assert_eq!(window.leaf_id, leaf);
    assert_eq!(window.message_count(), 223);
    assert_eq!(window.session_name(), Some("pending name"));
    assert_eq!(window.entries.len(), full.entries.len() + 4);
    window.rewrite().unwrap();
    let reopened = SessionFile::open(&path).unwrap();
    assert_eq!(reopened.messages(), window.messages());
    assert_eq!(reopened.entries.len(), window.entries.len());
}

#[test]
#[ignore = "requires a captured local session path"]
fn captured_window_matches_full_transcript_and_stats() {
    let source = PathBuf::from(std::env::var("PA_WINDOW_FIXTURE").unwrap());
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("capture.jsonl");
    std::fs::copy(source, &path).unwrap();
    let lease = std::sync::Arc::new(
        crate::lease::acquire_runtime_session_lease(&path, dir.path()).unwrap(),
    );
    let start = std::time::Instant::now();
    let full = SessionFile::open(&path).unwrap();
    let full_elapsed = start.elapsed();
    for phase in ["cold", "warm", "append-warm"] {
        let start = std::time::Instant::now();
        let mut window = SessionFile::open_windowed(&path).unwrap();
        window.lease = Some(lease.clone());
        let elapsed = start.elapsed();
        assert!(
            window.window.is_some(),
            "fixture must exercise window reader"
        );
        let reference = SessionFile::open(&path).unwrap();
        assert_eq!(window.messages(), reference.messages());
        assert_eq!(
            crate::session_stats::session_stats(&window, Some(200000)),
            crate::session_stats::session_stats(&reference, Some(200000))
        );
        assert_eq!(
            (
                window.message_count(),
                window.first_message(),
                window.session_name()
            ),
            (
                reference.message_count(),
                reference.first_message(),
                reference.session_name()
            )
        );
        let probe = pa_core::session::window::WindowedSessionStore::open(&path)
            .unwrap()
            .unwrap();
        assert!(probe.read_stats().cache_hit);
        eprintln!("phase={phase} full={full_elapsed:?} open={elapsed:?} bytes={} jsonl_bytes={} ranges={:?} entries={}/{}", path.metadata().unwrap().len(), probe.read_stats().jsonl_bytes, probe.read_stats().jsonl_ranges, window.entries.len(), full.entries.len());
        if phase == "warm" {
            let original = std::fs::read(&path).unwrap();
            let started = std::time::Instant::now();
            window
                .persist_entry("session_state", json!({"state":{"status":"active"}}))
                .unwrap();
            eprintln!("resume_active_append={:?}", started.elapsed());
            assert!(std::fs::read(&path).unwrap().starts_with(&original));
            let maintained = pa_core::session::window::WindowedSessionStore::open(&path)
                .unwrap()
                .unwrap();
            assert!(
                maintained.read_stats().cache_hit,
                "resume append must maintain warm cache"
            );
        }
    }
}

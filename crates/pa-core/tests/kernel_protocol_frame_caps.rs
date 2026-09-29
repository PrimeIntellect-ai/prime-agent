// The Tier-C/D ruling (fleet-uniform, 2026-09-28) - this target's own
// crate root: the same bounded-boundary disposition as src/lib.rs
// (large_futures/too_many_lines/the cast family; details there).
#![allow(
    clippy::large_futures,
    clippy::too_many_lines,
    clippy::cast_possible_truncation,
    clippy::cast_possible_wrap,
    clippy::cast_sign_loss,
    clippy::cast_precision_loss
)]

//! Verifier integration test: an oversized protocol line poisons the child
//! and lands in protocol repair instead of buffering until OOM (TS #2423
//! `MAX_PROTOCOL_LINE_CHARS` + the `oversized protocol line` repair test).
//!
//! A fake runtime (a small executable script, not the real one) answers the
//! ready handshake, streams 33 Mi of unterminated output for one request, and
//! answers every other request normally — so the repair's replacement child
//! serves the follow-up cell.

#![cfg(unix)]

use std::collections::HashMap;
use std::os::unix::fs::PermissionsExt;
use std::time::{Duration, Instant};

use pa_core::kernel::manager::{KernelStartOptions, ReplKernelManager};
use pa_core::kernel::shared::{
    ExecuteOptions, ExecuteStatus, HostRequestHandlers, KernelManagerOptions, KernelShutdownOptions,
};

/// Speaks protocol v3: ready, then per request the oversized unterminated
/// line (the corruption under test), a multi-MiB blank line followed by a
/// plain stdout frame (the linear-scan test), or a plain done frame.
const FAKE_RUNTIME: &str = r#"#!/usr/bin/env python3
import json
import sys
import time

print(json.dumps({"event": "ready", "protocol": 3, "python": "3.13.0"}), flush=True)
for line in sys.stdin:
    try:
        req = json.loads(line)
    except Exception:
        continue
    if req.get("code") == "corrupt-huge-line":
        sys.stdout.write("x" * (33 * 1024 * 1024))
        sys.stdout.flush()
        time.sleep(30)
        break
    if req.get("code") == "big-frame":
        sys.stdout.write(" " * (31 * 1024 * 1024) + "\n")
        sys.stdout.write(json.dumps({"event": "stdout", "id": req.get("id"), "text": "big"}) + "\n")
    sys.stdout.write(json.dumps({"event": "done", "id": req.get("id"), "status": "ok"}) + "\n")
    sys.stdout.flush()
"#;

fn fake_runtime_path() -> std::path::PathBuf {
    let dir = tempfile::TempDir::new().expect("temp dir");
    let path = dir.path().join("fake-kernel");
    std::fs::write(&path, FAKE_RUNTIME).expect("write fake runtime");
    std::fs::set_permissions(&path, std::fs::Permissions::from_mode(0o755)).expect("chmod");
    // Leak the temp dir: the script must exist until the spawned child exits.
    std::mem::forget(dir);
    path
}

fn manager(python: std::path::PathBuf) -> ReplKernelManager {
    ReplKernelManager::new(KernelManagerOptions {
        python: Some(python),
        cwd: Some(std::env::temp_dir()),
        env: HashMap::new(),
        session_id: Some("protocol-caps-test".to_string()),
        host_handlers: HostRequestHandlers::new(),
        python_skills: Vec::new(),
        snapshot: None,
        bootstrap_code: None,
        stderr_log_path: None,
        on_background_work_settled: None,
    })
}

#[tokio::test]
async fn oversized_unterminated_protocol_line_poisons_and_repairs() {
    let manager = manager(fake_runtime_path());
    manager
        .start(KernelStartOptions::default())
        .await
        .expect("fake kernel must start");

    let corrupt = manager
        .execute("corrupt-huge-line", ExecuteOptions::default())
        .await;
    let error = corrupt.expect_err("the oversized line must fail the request");
    assert!(
        error.to_string().contains("oversized protocol line"),
        "unexpected error: {error:#}"
    );

    // The poisoned child is replaced by the protocol repair; the follow-up
    // cell (the replacement also speaks the fake protocol) serves normally
    // with a plain ok done frame.
    let follow = manager.execute("42", ExecuteOptions::default()).await;
    let follow = follow.expect("follow-up execute must not fail");
    assert_eq!(follow.status, ExecuteStatus::Ok);
    assert_eq!(follow.result, None);

    let shutdown = manager.shutdown(KernelShutdownOptions::default()).await;
    assert!(shutdown.is_ok());
}

#[tokio::test]
async fn normal_protocol_lines_still_stream_through_the_bounded_reader() {
    // Multiple frames in one 64 Ki chunk plus a trailing partial line must
    // all dispatch: the chunked reader only poisons past the ceiling.
    let manager = manager(fake_runtime_path());
    manager
        .start(KernelStartOptions::default())
        .await
        .expect("fake kernel must start");
    for i in 0..50 {
        let result = manager
            .execute(&format!("cell-{i}"), ExecuteOptions::default())
            .await
            .expect("execute must not fail");
        assert_eq!(result.status, ExecuteStatus::Ok);
    }
    // Give the teardown its full grace window (the fake lives until EOF).
    let _ = tokio::time::timeout(
        Duration::from_secs(10),
        manager.shutdown(KernelShutdownOptions::default()),
    )
    .await;
}

#[tokio::test]
async fn multi_mib_blank_protocol_line_is_read_in_linear_time() {
    // A 31 MiB blank line arrives in pipe reads of at most 64 KiB; rescanning
    // the buffered prefix per read would scan >= 8 GB. Blank lines skip
    // parse_event, so the fixed path pays only the one-pass scan.
    let manager = manager(fake_runtime_path());
    manager
        .start(KernelStartOptions::default())
        .await
        .expect("fake kernel must start");
    let started = Instant::now();
    let result = manager
        .execute("big-frame", ExecuteOptions::default())
        .await
        .expect("execute must not fail");
    let elapsed = started.elapsed();
    assert_eq!(
        (result.status, result.stdout.as_str()),
        (ExecuteStatus::Ok, "big")
    );
    assert!(
        elapsed < Duration::from_secs(3),
        "31 MiB blank line took {elapsed:?}"
    );
    assert!(manager
        .shutdown(KernelShutdownOptions::default())
        .await
        .is_ok());
}

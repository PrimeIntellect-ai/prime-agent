//! Result clipping must preserve UTF-8 and leave the reader serving later cells.
#![cfg(unix)]
// Kernel manager futures follow the crate's existing integration-test disposition.
#![allow(clippy::large_futures)]

use std::collections::HashMap;
use std::os::unix::fs::PermissionsExt;
use std::time::Duration;

use pa_core::kernel::manager::{KernelStartOptions, ReplKernelManager};
use pa_core::kernel::shared::{
    ExecuteOptions, ExecuteStatus, HostRequestHandlers, KernelManagerOptions, KernelShutdownOptions,
};

const FAKE_RUNTIME: &str = r#"#!/usr/bin/env python3
import json
import sys

print(json.dumps({"event": "ready", "protocol": 3, "python": "3.13.0"}), flush=True)
for line in sys.stdin:
    req = json.loads(line)
    if req.get("type") == "execute":
        text = json.loads(req["code"])
        print(json.dumps({"event": "result", "id": req["id"], "text": text}), flush=True)
    print(json.dumps({"event": "done", "id": req.get("id"), "status": "ok"}), flush=True)
"#;

#[tokio::test]
async fn result_clipping_counts_characters_and_preserves_follow_up_cells() {
    let dir = tempfile::TempDir::new().expect("temp dir");
    let python = dir.path().join("fake-kernel");
    std::fs::write(&python, FAKE_RUNTIME).expect("write fake runtime");
    std::fs::set_permissions(&python, std::fs::Permissions::from_mode(0o755)).expect("chmod");
    let manager = ReplKernelManager::new(KernelManagerOptions {
        python: Some(python),
        cwd: Some(dir.path().to_path_buf()),
        env: HashMap::new(),
        session_id: Some("result-clip-test".to_string()),
        host_handlers: HostRequestHandlers::new(),
        python_skills: Vec::new(),
        snapshot: None,
        bootstrap_code: None,
        stderr_log_path: None,
        on_background_work_settled: None,
    });
    tokio::time::timeout(
        Duration::from_secs(10),
        manager.start(KernelStartOptions::default()),
    )
    .await
    .expect("fake runtime must become ready")
    .expect("fake runtime must start");

    let long = format!("'{}'", "é".repeat(70_000));
    let long_prefix = format!("'{}", "é".repeat(65_535));
    let cases = [
        // The leading quote puts byte 65,536 inside an accented character.
        (long.as_str(), None, long_prefix.as_str(), true),
        ("é界🦀x", Some(3), "é界🦀", true),
        ("é界🦀", Some(3), "é界🦀", false),
        ("🦀", Some(2), "🦀", false),
        ("abc", Some(2), "ab", true),
        ("é", Some(0), "", true),
        ("", Some(0), "", false),
        ("2", None, "2", false),
    ];
    for (text, max_output_chars, prefix, truncated) in cases {
        let result = tokio::time::timeout(
            Duration::from_secs(10),
            manager.execute(
                &serde_json::to_string(text).expect("encode result"),
                ExecuteOptions {
                    max_output_chars,
                    ..ExecuteOptions::default()
                },
            ),
        )
        .await
        .expect("reader must continue serving cells")
        .expect("execute must succeed");
        let expected = if truncated {
            let cap = max_output_chars.unwrap_or(65_536);
            format!("{prefix}\n[... output truncated at {cap} chars ...]")
        } else {
            prefix.to_string()
        };
        assert_eq!(
            (result.status, result.result),
            (ExecuteStatus::Ok, Some(expected))
        );
    }
    tokio::time::timeout(
        Duration::from_secs(10),
        manager.shutdown(KernelShutdownOptions::default()),
    )
    .await
    .expect("shutdown must finish")
    .expect("shutdown must succeed");
}

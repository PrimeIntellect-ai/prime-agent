//! The getter test battery: the TS wire shapes of every `get_*` handler - the
//! connection state, the rlm children sequence, the context tree folds, the
//! session context, the model catalog, and the empty-loader shapes - over the
//! shared `created_worker` fixtures.

use super::*;
use serde_json::json;
use std::sync::Arc;

/// A created worker backed by an existing session file (so the artifact tree beside it resolves).
async fn created_worker_at(root: &std::path::Path, session_file: &std::path::Path) -> Arc<Worker> {
    std::fs::create_dir_all(root).unwrap();
    let config = crate::worker::WorkerConfig {
        socket_path: root.join("worker.sock"),
        supervisor_socket_path: std::path::PathBuf::new(),
        token: "token".to_string(),
        worker_instance_id: String::new(),
        active_session_id: "getter-session".to_string(),
        agent_dir: root.join("agent"),
        recovery_journal_path: root.join("recovery.jsonl"),
        telemetry_disabled: None,
        script: Some(json!({ "responses": ["ack"] })),
    };
    let worker = Arc::new(Worker::new(config, None));
    let created = worker
        .dispatch(
            "create",
            &json!({
                "sessionPath": session_file.display().to_string(),
                "cwd": "/tmp",
                "name": "getters",
            }),
        )
        .await;
    assert!(created.success, "create failed: {created:?}");
    worker
}

async fn created_worker() -> Arc<Worker> {
    let dir = std::env::temp_dir().join(format!("pa-worker-sg-{}", uuid::Uuid::new_v4()));
    std::fs::create_dir_all(&dir).unwrap();
    let config = crate::worker::WorkerConfig {
        socket_path: dir.join("worker.sock"),
        supervisor_socket_path: std::path::PathBuf::new(),
        token: "token".to_string(),
        worker_instance_id: String::new(),
        active_session_id: "getter-session".to_string(),
        agent_dir: dir.join("agent"),
        recovery_journal_path: dir.join("recovery.jsonl"),
        telemetry_disabled: None,
        script: Some(json!({ "responses": ["ack"] })),
    };
    let worker = Arc::new(Worker::new(config, None));
    let created = worker
        .dispatch(
            "create",
            &json!({ "noSession": true, "cwd": "/tmp", "name": "getters" }),
        )
        .await;
    assert!(created.success, "create failed: {created:?}");
    worker
}

/// `heartbeat` is present and null (no cron store on this worker).
#[tokio::test]
async fn get_connection_state_matches_the_ts_shape() {
    let worker = created_worker().await;
    let response = worker
        .dispatch(
            "get_connection_state",
            &json!({ "activeSessionId": "getter-session" }),
        )
        .await;
    assert!(response.success, "failed: {response:?}");
    let data = response.data.expect("connection state data");
    assert_eq!(data["activeSessionId"], "getter-session");
    assert_eq!(data["cwd"], "/tmp");
    assert_eq!(data["heartbeat"], Value::Null);
    for field in [
        "thinkingLevel",
        "serviceTier",
        "availableThinkingLevels",
        "isStreaming",
        "isCompacting",
        "isBashRunning",
        "retryAttempt",
        "steeringMode",
        "followUpMode",
        "sessionId",
        "leafId",
        "autoCompactionEnabled",
        "messageCount",
        "sessionActions",
        "compactionCount",
        "goal",
        "scopedModels",
        "activeToolNames",
    ] {
        assert!(data.get(field).is_some(), "missing {field}: {data}");
    }
    // A session that has not been created answers the TS initializing refusal.
    let fresh = Arc::new(Worker::new(
        {
            let mut config = worker.config.clone();
            config.active_session_id = "fresh-session".to_string();
            config
        },
        None,
    ));
    let response = fresh
        .dispatch(
            "get_connection_state",
            &json!({ "activeSessionId": "fresh-session" }),
        )
        .await;
    assert!(!response.success);
    assert_eq!(
        response.error.as_deref(),
        Some("Session is still initializing")
    );
}

#[tokio::test]
async fn get_rlm_children_carries_the_sequence() {
    let worker = created_worker().await;
    let response = worker
        .dispatch(
            "get_rlm_children",
            &json!({ "activeSessionId": "getter-session" }),
        )
        .await;
    assert!(response.success, "failed: {response:?}");
    let data = response.data.expect("data");
    assert_eq!(data["children"], json!([]));
    let sequence = data["eventSequence"].as_u64().expect("event sequence");
    // A subsequent read captures the same sequence until an event bumps it (TS
    // freshness contract).
    let again = worker
        .dispatch(
            "get_rlm_children",
            &json!({ "activeSessionId": "getter-session" }),
        )
        .await;
    assert_eq!(again.data.expect("data")["eventSequence"], json!(sequence));
}

/// Child attributions move the split between `ownUsage` and `totalUsage`.
#[tokio::test]
async fn get_context_tree_matches_the_ts_root_node() {
    let worker = created_worker().await;
    let response = worker
        .dispatch(
            "get_context_tree",
            &json!({ "activeSessionId": "getter-session" }),
        )
        .await;
    assert!(response.success, "failed: {response:?}");
    let tree = response.data.expect("data");
    assert_eq!(tree["id"], "root");
    assert_eq!(tree["label"], "getters");
    assert_eq!(tree["status"], "active");
    assert_eq!(tree["children"], json!([]));
    assert_eq!(tree["ownUsage"]["totalTokens"], json!(0));

    // One assistant turn seeds usage totals (the scripted usage block).
    let _ = worker
        .dispatch(
            "prompt_and_wait",
            &json!({ "activeSessionId": "getter-session", "message": "hi" }),
        )
        .await;
    let response = worker
        .dispatch(
            "get_context_tree",
            &json!({ "activeSessionId": "getter-session" }),
        )
        .await;
    let tree = response.data.expect("data");
    assert_eq!(tree["ownUsage"]["input"], json!(120));
    assert_eq!(tree["totalUsage"]["totalTokens"], json!(128));
    assert_eq!(tree["totalUsage"]["cost"]["total"].as_f64(), Some(0.0));
}

/// The captured-attribution fixture over the full daemon path (create from a
/// copy, so the repo fixture stays read-only). `ownUsage` is the assistant's
/// own row (input 2690, cost $0, `totalTokens` clamped to zero); `totalUsage`
/// carries the attributed child spend (input 52898, cost $0.0089957).
#[tokio::test]
async fn get_context_tree_folds_the_captured_attributions() {
    let root = std::env::temp_dir().join(format!("pa-worker-af-{}", uuid::Uuid::new_v4()));
    std::fs::create_dir_all(&root).unwrap();
    let fixture = std::path::PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .join("tests/fixtures/attribution-fold-captured.jsonl");
    let session_file = root.join("captured.jsonl");
    std::fs::copy(&fixture, &session_file).unwrap();
    let worker = created_worker_at(&root, &session_file).await;
    let response = worker
        .dispatch(
            "get_context_tree",
            &json!({ "activeSessionId": "getter-session" }),
        )
        .await;
    assert!(response.success, "failed: {response:?}");
    let tree = response.data.expect("data");
    assert_eq!(tree["ownUsage"]["input"], json!(2690));
    assert_eq!(tree["ownUsage"]["output"], json!(2934));
    assert_eq!(tree["ownUsage"]["cacheRead"], json!(17408));
    assert_eq!(tree["ownUsage"]["totalTokens"], json!(0));
    // The six sequential subtractions leave float-order noise in the last
    // ulps (TS walks the same order), so own cost pins at ~0, not bit-exact zero.
    assert!(
        tree["ownUsage"]["cost"]["total"].as_f64().unwrap().abs() < 1e-12,
        "own cost {} is not ~0",
        tree["ownUsage"]["cost"]["total"]
    );
    assert_eq!(tree["totalUsage"]["input"], json!(52898));
    assert_eq!(tree["totalUsage"]["output"], json!(5863));
    assert_eq!(tree["totalUsage"]["cacheRead"], json!(18560));
    assert_eq!(tree["totalUsage"]["totalTokens"], json!(23032));
    assert_eq!(
        tree["totalUsage"]["cost"]["total"].as_f64(),
        Some(0.008_995_7)
    );
    // `get_session_stats` reports the same folded totals over the gap-bridged branch.
    let stats = worker
        .dispatch(
            "get_session_stats",
            &json!({ "activeSessionId": "getter-session" }),
        )
        .await;
    assert!(stats.success, "failed: {stats:?}");
    let stats = stats.data.expect("data");
    assert_eq!(stats["tokens"]["input"], json!(52898));
    assert_eq!(stats["tokens"]["output"], json!(5863));
    assert_eq!(stats["tokens"]["cacheRead"], json!(18560));
    assert_eq!(stats["cost"].as_f64(), Some(0.008_995_7));
}

/// The operator's cost question over the real file path: a session that switches
/// models mid-conversation accumulates the per-model costs INCLUDING the
/// switch's cache-write burst (the cost blocks are `calculate_cost` records).
#[tokio::test]
async fn get_context_tree_breaks_own_usage_down_by_model() {
    let root = std::env::temp_dir().join(format!("pa-worker-bm-{}", uuid::Uuid::new_v4()));
    std::fs::create_dir_all(&root).unwrap();
    let session_file = root.join("switched.jsonl");
    let usage = |input: u64,
                 output: u64,
                 cache_read: u64,
                 cache_write: u64,
                 total: u64,
                 (ci, co, cr, cw, ct): (f64, f64, f64, f64, f64)| {
        json!({
            "input": input, "output": output, "cacheRead": cache_read,
            "cacheWrite": cache_write, "totalTokens": total,
            "cost": {"input": ci, "output": co, "cacheRead": cr,
                      "cacheWrite": cw, "total": ct},
        })
    };
    let lines = [
        json!({"type": "session", "version": 3, "id": "switched-0001", "timestamp": "2026-09-24T00:00:00.000Z", "cwd": "/tmp"}),
        json!({"type": "model_change", "id": "m0", "parentId": null, "timestamp": "2026-09-24T00:00:00.100Z", "provider": "openai", "modelId": "gpt-5.6-sol"}),
        json!({"type": "message", "id": "e1", "parentId": "m0", "timestamp": "2026-09-24T00:00:01.000Z", "message": {"role": "user", "content": "audit the costs"}}),
        json!({"type": "message", "id": "e2", "parentId": "e1", "timestamp": "2026-09-24T00:00:02.000Z", "message": {"role": "assistant", "content": [{"type": "text", "text": "on it"}], "provider": "openai", "model": "gpt-5.6-sol", "stopReason": "stop", "usage": usage(100_000, 2000, 0, 0, 1200, (0.4, 0.04, 0.0, 0.0, 0.44))}}),
        json!({"type": "model_change", "id": "m1", "parentId": "e2", "timestamp": "2026-09-24T00:00:03.000Z", "provider": "anthropic", "modelId": "claude-opus-4-6"}),
        json!({"type": "message", "id": "e3", "parentId": "m1", "timestamp": "2026-09-24T00:00:04.000Z", "message": {"role": "user", "content": "switch to opus"}}),
        json!({"type": "message", "id": "e4", "parentId": "e3", "timestamp": "2026-09-24T00:00:05.000Z", "message": {"role": "assistant", "content": [{"type": "text", "text": "done"}], "provider": "anthropic", "model": "claude-opus-4-6", "stopReason": "stop", "usage": usage(5000, 1000, 0, 104_000, 110_000, (0.025, 0.025, 0.0, 0.65, 0.7))}}),
        json!({"type": "message", "id": "e5", "parentId": "e4", "timestamp": "2026-09-24T00:00:06.000Z", "message": {"role": "user", "content": "and now a cache hit"}}),
        json!({"type": "message", "id": "e6", "parentId": "e5", "timestamp": "2026-09-24T00:00:07.000Z", "message": {"role": "assistant", "content": [{"type": "text", "text": "cheap"}], "provider": "anthropic", "model": "claude-opus-4-6", "stopReason": "stop", "usage": usage(500, 800, 110_000, 0, 110_500, (0.0025, 0.02, 0.055, 0.0, 0.0775))}}),
    ];
    let content = lines
        .iter()
        .map(std::string::ToString::to_string)
        .collect::<Vec<_>>()
        .join("\n");
    std::fs::write(&session_file, content).unwrap();
    let worker = created_worker_at(&root, &session_file).await;
    let response = worker
        .dispatch(
            "get_context_tree",
            &json!({ "activeSessionId": "getter-session" }),
        )
        .await;
    assert!(response.success, "failed: {response:?}");
    let tree = response.data.expect("data");
    // The grand totals sum every record's stored cost — the honest per-model-summed total.
    assert_eq!(tree["ownUsage"]["input"], json!(105_500));
    assert_eq!(tree["ownUsage"]["output"], json!(3800));
    assert_eq!(tree["ownUsage"]["cacheRead"], json!(110_000));
    assert_eq!(tree["ownUsage"]["cacheWrite"], json!(104_000));
    assert_eq!(tree["ownUsage"]["totalTokens"], json!(221_700));
    assert_eq!(
        tree["ownUsage"]["cost"]["total"].as_f64(),
        Some(0.4 + 0.04 + 0.7 + 0.0775)
    );
    // The per-model breakdown: first-seen order, each bucket holding exactly the records
    // that model served.
    let buckets = tree["ownUsageByModel"]
        .as_array()
        .expect("the by-model breakdown is present");
    assert_eq!(buckets.len(), 2);
    assert_eq!(buckets[0]["provider"], json!("openai"));
    assert_eq!(buckets[0]["id"], json!("gpt-5.6-sol"));
    assert_eq!(buckets[0]["ownUsage"]["input"], json!(100_000));
    assert_eq!(buckets[0]["ownUsage"]["output"], json!(2000));
    assert_eq!(buckets[0]["ownUsage"]["cacheWrite"], json!(0));
    assert_eq!(
        buckets[0]["ownUsage"]["cost"]["total"].as_f64(),
        Some(0.4 + 0.04)
    );
    assert_eq!(buckets[1]["provider"], json!("anthropic"));
    assert_eq!(buckets[1]["id"], json!("claude-opus-4-6"));
    assert_eq!(buckets[1]["ownUsage"]["input"], json!(5500));
    assert_eq!(buckets[1]["ownUsage"]["output"], json!(1800));
    assert_eq!(buckets[1]["ownUsage"]["cacheRead"], json!(110_000));
    assert_eq!(buckets[1]["ownUsage"]["cacheWrite"], json!(104_000));
    // The switch's cache-write burst bills at the new model's write rate: 104k
    // tokens x $6.25/M (1.25x the $5/M input rate) is exactly $0.65.
    assert_eq!(
        buckets[1]["ownUsage"]["cost"]["cacheWrite"].as_f64(),
        Some(104_000.0 * 6.25 / 1_000_000.0)
    );
    assert_eq!(
        buckets[1]["ownUsage"]["cost"]["total"].as_f64(),
        Some(0.7 + 0.0775)
    );
}

/// The buckets reconcile or the breakdown is omitted: a bucket that clamps
/// makes the buckets sum past `ownUsage`, so `ownUsageByModel` is omitted
/// and the display degrades to the plain totals instead of overstating the node.
#[tokio::test]
async fn get_context_tree_omits_the_breakdown_when_an_attribution_exceeds_its_bucket() {
    let root = std::env::temp_dir().join(format!("pa-worker-bmx-{}", uuid::Uuid::new_v4()));
    std::fs::create_dir_all(&root).unwrap();
    let session_file = root.join("clamped.jsonl");
    let usage = |input: u64, output: u64, total: u64| {
        json!({
            "input": input, "output": output, "cacheRead": 0, "cacheWrite": 0,
            "totalTokens": total,
            "cost": {"input": 0, "output": 0, "cacheRead": 0, "cacheWrite": 0, "total": 0},
        })
    };
    let lines = [
        json!({"type": "session", "version": 3, "id": "clamped-0001", "timestamp": "2026-09-25T00:00:00.000Z", "cwd": "/tmp"}),
        json!({"type": "model_change", "id": "m0", "parentId": null, "timestamp": "2026-09-25T00:00:00.100Z", "provider": "openai", "modelId": "gpt-5.6-sol"}),
        json!({"type": "message", "id": "e1", "parentId": "m0", "timestamp": "2026-09-25T00:00:01.000Z", "message": {"role": "user", "content": "audit the mix"}}),
        json!({"type": "message", "id": "e2", "parentId": "e1", "timestamp": "2026-09-25T00:00:02.000Z", "message": {"role": "assistant", "content": [{"type": "text", "text": "on it"}], "provider": "openai", "model": "gpt-5.6-sol", "stopReason": "stop", "usage": usage(1_000, 100, 1_100)}}),
        json!({"type": "model_change", "id": "m1", "parentId": "e2", "timestamp": "2026-09-25T00:00:03.000Z", "provider": "anthropic", "modelId": "claude-opus-4-6"}),
        json!({"type": "message", "id": "e3", "parentId": "m1", "timestamp": "2026-09-25T00:00:04.000Z", "message": {"role": "user", "content": "big opus turn"}}),
        json!({"type": "message", "id": "e4", "parentId": "e3", "timestamp": "2026-09-25T00:00:05.000Z", "message": {"role": "assistant", "content": [{"type": "text", "text": "done"}], "provider": "anthropic", "model": "claude-opus-4-6", "stopReason": "stop", "usage": usage(100_000, 2_000, 102_000)}}),
        // The child's input/output ride the cumulative aggregate; the
        // totalTokens do not (the row keeps its own 1_100).
        json!({"type": "child_usage_attributed", "id": "a1", "parentId": "e4", "timestamp": "2026-09-25T00:00:06.000Z", "targetId": "e2",
            "childUsage": usage(3_000, 300, 9_000),
            "aggregateUsage": usage(4_000, 400, 1_100),
            "origin": "spawn_task"}),
    ];
    let content = lines
        .iter()
        .map(std::string::ToString::to_string)
        .collect::<Vec<_>>()
        .join("\n");
    std::fs::write(&session_file, content).unwrap();
    let worker = created_worker_at(&root, &session_file).await;
    let response = worker
        .dispatch(
            "get_context_tree",
            &json!({ "activeSessionId": "getter-session" }),
        )
        .await;
    assert!(response.success, "failed: {response:?}");
    let tree = response.data.expect("data");
    // The plain fold subtracts the 9_000 tokens from the combined pool:
    // 1_100 + 102_000 - 9_000; input and output reconcile exactly.
    assert_eq!(tree["ownUsage"]["input"], json!(101_000));
    assert_eq!(tree["ownUsage"]["output"], json!(2_100));
    assert_eq!(tree["ownUsage"]["totalTokens"], json!(94_100));
    // The sol bucket clamps at zero while the opus bucket keeps its 102_000:
    // the buckets would overstate the node's 94_100, so the breakdown is omitted.
    assert!(
        tree["ownUsageByModel"].is_null(),
        "the clamped breakdown must not be served: {}",
        tree["ownUsageByModel"]
    );
}

/// The control for the omission rule: a fitting attribution reconciles and the breakdown
/// stays served.
#[tokio::test]
async fn get_context_tree_keeps_the_breakdown_when_an_attribution_fits_its_bucket() {
    let root = std::env::temp_dir().join(format!("pa-worker-bmf-{}", uuid::Uuid::new_v4()));
    std::fs::create_dir_all(&root).unwrap();
    let session_file = root.join("fits.jsonl");
    let usage = |input: u64, output: u64, total: u64| {
        json!({
            "input": input, "output": output, "cacheRead": 0, "cacheWrite": 0,
            "totalTokens": total,
            "cost": {"input": 0, "output": 0, "cacheRead": 0, "cacheWrite": 0, "total": 0},
        })
    };
    let lines = [
        json!({"type": "session", "version": 3, "id": "fits-0001", "timestamp": "2026-09-25T00:00:00.000Z", "cwd": "/tmp"}),
        json!({"type": "model_change", "id": "m0", "parentId": null, "timestamp": "2026-09-25T00:00:00.100Z", "provider": "openai", "modelId": "gpt-5.6-sol"}),
        json!({"type": "message", "id": "e1", "parentId": "m0", "timestamp": "2026-09-25T00:00:01.000Z", "message": {"role": "user", "content": "audit the mix"}}),
        json!({"type": "message", "id": "e2", "parentId": "e1", "timestamp": "2026-09-25T00:00:02.000Z", "message": {"role": "assistant", "content": [{"type": "text", "text": "on it"}], "provider": "openai", "model": "gpt-5.6-sol", "stopReason": "stop", "usage": usage(1_000, 100, 1_100)}}),
        json!({"type": "model_change", "id": "m1", "parentId": "e2", "timestamp": "2026-09-25T00:00:03.000Z", "provider": "anthropic", "modelId": "claude-opus-4-6"}),
        json!({"type": "message", "id": "e3", "parentId": "m1", "timestamp": "2026-09-25T00:00:04.000Z", "message": {"role": "user", "content": "big opus turn"}}),
        json!({"type": "message", "id": "e4", "parentId": "e3", "timestamp": "2026-09-25T00:00:05.000Z", "message": {"role": "assistant", "content": [{"type": "text", "text": "done"}], "provider": "anthropic", "model": "claude-opus-4-6", "stopReason": "stop", "usage": usage(100_000, 2_000, 102_000)}}),
        json!({"type": "child_usage_attributed", "id": "a1", "parentId": "e4", "timestamp": "2026-09-25T00:00:06.000Z", "targetId": "e2",
            "childUsage": usage(3_000, 300, 500),
            "aggregateUsage": usage(4_000, 400, 1_100),
            "origin": "spawn_task"}),
    ];
    let content = lines
        .iter()
        .map(std::string::ToString::to_string)
        .collect::<Vec<_>>()
        .join("\n");
    std::fs::write(&session_file, content).unwrap();
    let worker = created_worker_at(&root, &session_file).await;
    let response = worker
        .dispatch(
            "get_context_tree",
            &json!({ "activeSessionId": "getter-session" }),
        )
        .await;
    assert!(response.success, "failed: {response:?}");
    let tree = response.data.expect("data");
    assert_eq!(tree["ownUsage"]["totalTokens"], json!(102_600));
    let buckets = tree["ownUsageByModel"]
        .as_array()
        .expect("the fitting breakdown is served");
    assert_eq!(buckets.len(), 2);
    assert_eq!(buckets[0]["id"], json!("gpt-5.6-sol"));
    assert_eq!(buckets[0]["ownUsage"]["input"], json!(1_000));
    assert_eq!(buckets[0]["ownUsage"]["totalTokens"], json!(600));
    assert_eq!(buckets[1]["id"], json!("claude-opus-4-6"));
    assert_eq!(buckets[1]["ownUsage"]["totalTokens"], json!(102_000));
}

/// `get_context_tree` surfaces the persisted child sessions: idle, settled, and
/// restart-orphaned subagents all appear, with real usage and grandchildren.
#[tokio::test]
async fn get_context_tree_lists_persisted_children() {
    let root = std::env::temp_dir().join(format!("pa-worker-ct-{}", uuid::Uuid::new_v4()));
    let agent_dir = root.join("agent");
    let sessions = agent_dir.join("sessions");
    std::fs::create_dir_all(&sessions).unwrap();
    let session_id = "01a0ct-1111-2222-3333-444444444444";
    let session_file = sessions.join(format!("{session_id}.jsonl"));
    let usage = json!({
        "input": 30, "output": 6, "cacheRead": 0, "cacheWrite": 0,
        "totalTokens": 36,
        "cost": { "input": 0, "output": 0, "cacheRead": 0, "cacheWrite": 0, "total": 0 },
    });
    let content = [
        json!({"type": "session", "version": 3, "id": session_id, "timestamp": "2026-09-22T00:00:00.000Z", "cwd": "/tmp"}),
        json!({"type": "message", "id": "e1", "parentId": null, "timestamp": "2026-09-22T00:00:01.000Z", "message": {"role": "user", "content": "hi"}}),
        json!({"type": "message", "id": "e2", "parentId": "e1", "timestamp": "2026-09-22T00:00:02.000Z", "message": {"role": "assistant", "content": [{ "type": "text", "text": "hello" }], "provider": "prime-inference", "model": "internal/glm-5.3-fast", "usage": usage}}),
    ]
    .iter()
    .map(std::string::ToString::to_string)
    .collect::<Vec<_>>()
    .join("\n");
    std::fs::write(&session_file, content).unwrap();
    // The artifact tree lives under the worker's agent dir (the writer's
    // addressing): one settled child with a grandchild in a sibling tree.
    let artifacts = agent_dir.join("session-artifacts");
    let child_session = "01a0child-1111-2222-3333-4444444444";
    let grandchild_session = "01a0grand-1111-2222-3333-4444444444";
    let write_child = |stop: &str| {
        [
            json!({"type": "message", "id": "c1", "parentId": null, "timestamp": "2026-09-22T00:00:01.000Z", "message": {"role": "user", "content": "fix the login bug"}}),
            json!({"type": "message", "id": "c2", "parentId": "c1", "timestamp": "2026-09-22T00:00:02.000Z", "message": {"role": "assistant", "content": [{ "type": "text", "text": "done" }], "provider": "prime-inference", "model": "internal/glm-5.3-fast", "stopReason": stop, "usage": {"input": 10, "output": 5, "cacheRead": 0, "cacheWrite": 0, "totalTokens": 15, "cost": {"input": 0, "output": 0, "cacheRead": 0, "cacheWrite": 0, "total": 0}}}}),
        ]
    };
    let write_session = |dir: &std::path::Path, session: &str, stop: &str| {
        std::fs::create_dir_all(dir).unwrap();
        let mut lines = vec![
            json!({"type": "session", "version": 3, "id": session, "timestamp": "2026-09-22T00:00:00.000Z", "cwd": "/tmp"}),
        ];
        lines.extend(write_child(stop));
        std::fs::write(
            dir.join(format!("{session}.jsonl")),
            lines
                .iter()
                .map(std::string::ToString::to_string)
                .collect::<Vec<_>>()
                .join("\n"),
        )
        .unwrap();
    };
    let child_dir = artifacts.join(session_id).join("sub-003f741a");
    write_session(&child_dir, child_session, "stop");
    let grandchild_dir = artifacts.join(child_session).join("sub-00aa00aa");
    write_session(&grandchild_dir, grandchild_session, "stop");
    // A second child the user deleted: the ledger tombstone must keep it out of the tree.
    let deleted_dir = artifacts.join(session_id).join("sub-deadbeef");
    let deleted_session = "01a0dead-1111-2222-3333-4444444444";
    write_session(&deleted_dir, deleted_session, "stop");
    let ledger = crate::rlm_ledger::RlmSpawnLedger::new(&agent_dir, &sessions, |_| {});
    ledger
        .append_spawn(&crate::rlm_ledger::RlmSpawnInput {
            child_id: "sub-deadbeef".to_string(),
            parent: session_file.display().to_string(),
            child: deleted_dir.display().to_string(),
            depth: 1,
            name: "deleted-child".to_string(),
        })
        .unwrap();
    ledger
        .append_delete(
            "sub-deadbeef",
            &deleted_dir.display().to_string(),
            crate::rlm_ledger::RlmLedgerDeleteReason::User,
        )
        .unwrap();

    let worker = created_worker_at(&root, &session_file).await;
    // The children come from the background cache refresh (the create warm armed
    // it): the persisted tree fills when the walk lands.
    let deadline = std::time::Instant::now() + std::time::Duration::from_secs(30);
    let children = loop {
        let response = worker
            .dispatch(
                "get_context_tree",
                &json!({ "activeSessionId": "getter-session" }),
            )
            .await;
        assert!(response.success, "failed: {response:?}");
        let tree = response.data.expect("data");
        assert_eq!(
            tree["ownUsage"]["input"],
            json!(30),
            "the root usage counts"
        );
        let children = tree["children"].as_array().cloned().unwrap_or_default();
        if children.len() == 1 || std::time::Instant::now() > deadline {
            break children;
        }
        tokio::time::sleep(std::time::Duration::from_millis(50)).await;
    };
    assert_eq!(
        children.len(),
        1,
        "the persisted child appears, the deleted one stays hidden: {children:?}"
    );
    let child = &children[0];
    assert_eq!(child["id"], json!("sub-003f741a"));
    assert_eq!(child["status"], json!("done"));
    assert_eq!(child["label"], json!("fix the login bug"));
    assert_eq!(child["ownUsage"]["totalTokens"], json!(15));
    let grandchildren = child["children"].as_array().expect("grandchildren");
    assert_eq!(grandchildren.len(), 1);
    assert_eq!(grandchildren[0]["id"], json!("sub-00aa00aa"));
    assert_eq!(grandchildren[0]["ownUsage"]["totalTokens"], json!(15));
    let _ = std::fs::remove_dir_all(&root);
}

#[tokio::test]
async fn commands_and_resources_match_the_empty_loader_shape() {
    let worker = created_worker().await;
    let response = worker
        .dispatch(
            "get_commands",
            &json!({ "activeSessionId": "getter-session" }),
        )
        .await;
    assert!(response.success);
    assert_eq!(response.data.expect("data"), json!({ "commands": [] }));
    let response = worker
        .dispatch(
            "get_resource_snapshot",
            &json!({ "activeSessionId": "getter-session" }),
        )
        .await;
    assert!(response.success);
    assert_eq!(
        response.data.expect("data"),
        crate::engine::empty_resource_snapshot()
    );
}

#[tokio::test]
async fn get_session_context_matches_the_ts_context_shape() {
    let worker = created_worker().await;
    let response = worker
        .dispatch(
            "get_session_context",
            &json!({ "activeSessionId": "getter-session" }),
        )
        .await;
    assert!(response.success, "failed: {response:?}");
    let context = response.data.expect("data")["context"].clone();
    assert!(context.get("messages").is_some());
    assert!(context.get("thinkingLevel").is_some());
    assert!(context.get("serviceTier").is_some());
    assert!(context.get("model").is_some());

    // One turn lands its accepted user message on the resolved context. (The
    // synthetic assistant row carries no stop reason, so the walk cannot consume it.)
    let _ = worker
        .dispatch(
            "prompt_and_wait",
            &json!({ "activeSessionId": "getter-session", "message": "hello" }),
        )
        .await;
    let response = worker
        .dispatch(
            "get_session_context",
            &json!({ "activeSessionId": "getter-session" }),
        )
        .await;
    let context = response.data.expect("data")["context"].clone();
    let roles: Vec<String> = context["messages"]
        .as_array()
        .expect("messages array")
        .iter()
        .filter_map(|message| {
            message
                .get("role")
                .and_then(Value::as_str)
                .map(str::to_string)
        })
        .collect();
    assert!(roles.iter().any(|role| role == "user"));
    assert_eq!(context["messages"][0]["content"], json!("hello"));
}

/// No prompt (empty string, the TS key present) and no tools (the `toolDefinition`
/// key omitted, like the TS `undefined` field).
#[tokio::test]
async fn system_prompt_and_tool_definition_match_the_ts_shapes() {
    let worker = created_worker().await;
    let response = worker
        .dispatch(
            "get_system_prompt",
            &json!({ "activeSessionId": "getter-session" }),
        )
        .await;
    assert!(response.success);
    assert_eq!(response.data.expect("data"), json!({ "systemPrompt": "" }));

    let response = worker
        .dispatch(
            "get_tool_definition",
            &json!({ "activeSessionId": "getter-session", "name": "ipython" }),
        )
        .await;
    assert!(response.success);
    assert_eq!(response.data.expect("data"), json!({}));

    let response = worker
        .dispatch(
            "get_tool_definition",
            &json!({ "activeSessionId": "getter-session" }),
        )
        .await;
    assert!(!response.success);
    assert_eq!(
        response.error.as_deref(),
        Some("get_tool_definition requires a name")
    );
}

#[tokio::test]
async fn rlm_max_depth_status_matches_the_ts_shape() {
    let worker = created_worker().await;
    let response = worker
        .dispatch(
            "get_rlm_max_depth_status",
            &json!({ "activeSessionId": "getter-session" }),
        )
        .await;
    assert!(response.success);
    assert_eq!(
        response.data.expect("data"),
        json!({ "maxDepth": crate::rlm_children::DEFAULT_RLM_MAX_DEPTH, "source": "default" })
    );
}

#[tokio::test]
async fn model_catalog_and_available_models_match_the_ts_shapes() {
    let dir = tempfile::tempdir().expect("tempdir");
    std::fs::create_dir_all(dir.path().join("agent")).expect("agent dir");
    std::fs::write(
        dir.path().join("agent").join("models.json"),
        json!({
            "providers": {
                "prime-inference": {
                    "api": "openai-completions",
                    "baseUrl": "http://127.0.0.1:9/v1",
                    "apiKey": "sk-test",
                    "models": [
                        { "id": "mock-1", "name": "Mock 1", "api": "openai-completions",
                          "baseUrl": "http://127.0.0.1:9/v1", "contextWindow": 128_000,
                          "maxTokens": 4096 },
                        { "id": "mock-2", "name": "Mock 2", "api": "openai-completions",
                          "baseUrl": "http://127.0.0.1:9/v1", "contextWindow": 128_000,
                          "maxTokens": 4096 }
                    ]
                }
            }
        })
        .to_string(),
    )
    .expect("write models.json");
    let config = crate::worker::WorkerConfig {
        socket_path: dir.path().join("worker.sock"),
        supervisor_socket_path: std::path::PathBuf::new(),
        token: "token".to_string(),
        worker_instance_id: String::new(),
        active_session_id: "catalog-session".to_string(),
        agent_dir: dir.path().join("agent"),
        recovery_journal_path: dir.path().join("recovery.jsonl"),
        telemetry_disabled: None,
        script: Some(json!({ "responses": ["ack"] })),
    };
    let worker = Arc::new(Worker::new(config, None));
    let created = worker
        .dispatch("create", &json!({ "noSession": true, "cwd": "/tmp" }))
        .await;
    assert!(created.success, "create failed: {created:?}");

    let response = worker
        .dispatch(
            "get_model_catalog",
            &json!({ "activeSessionId": "catalog-session" }),
        )
        .await;
    assert!(response.success, "failed: {response:?}");
    let catalog = response.data.expect("data");
    assert_eq!(
        catalog["models"]
            .as_array()
            .expect("models")
            .iter()
            .filter(|model| model["id"] == json!("mock-1"))
            .count(),
        1
    );
    assert_eq!(catalog["configuredProviders"], json!(["prime-inference"]));

    let response = worker
        .dispatch(
            "get_available_models",
            &json!({ "activeSessionId": "catalog-session" }),
        )
        .await;
    assert!(response.success);
    let available = response.data.expect("data");
    let models = available["models"].as_array().expect("models");
    // The registry also serves the built-in catalog when the box has configured auth; the
    // fixture provider must be complete.
    assert!(
        models
            .iter()
            .filter(|model| model["provider"] == json!("prime-inference"))
            .count()
            >= 2
    );
    assert!(models.iter().any(|model| model["id"] == json!("mock-1")));
}

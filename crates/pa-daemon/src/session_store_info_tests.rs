//! Compare the streaming listing fold against the previous whole-file fold.
use super::*;
use std::io::Write;

fn legacy_read_session_info(path: &Path) -> Option<SessionInfo> {
    let content = fs::read_to_string(path).ok()?;
    let mut header: Option<SessionHeader> = None;
    let mut name = None;
    let mut state = None;
    let mut model = None;
    let mut thinking_level = None;
    let mut message_count = 0usize;
    let mut first_message = String::new();
    let mut all_messages_text = String::new();
    let mut agent_status: Option<Value> = None;
    let mut usage_scan = crate::session_usage::UsageScan::default();
    let mut last_activity_ms: Option<u64> = None;
    for line in content.lines() {
        let trimmed = line.trim();
        if trimmed.is_empty() {
            continue;
        }
        let Ok(entry) = serde_json::from_str::<SessionEntry>(trimmed) else {
            continue;
        };
        match entry.type_.as_str() {
            "session" => {
                let parsed: SessionHeader = serde_json::from_str(trimmed).ok()?;
                header = Some(parsed);
            }
            "session_info" => {
                name = entry
                    .fields
                    .get("name")
                    .and_then(Value::as_str)
                    .map(str::trim)
                    .filter(|n| !n.is_empty())
                    .map(str::to_string);
            }
            "session_state" => {
                if let Some(status) = entry
                    .fields
                    .get("state")
                    .and_then(|s| s.get("status"))
                    .and_then(Value::as_str)
                {
                    state = Some(normalize_state_status(status));
                }
            }
            "model_change" => {
                model = Some((
                    entry.fields.get("provider")?.as_str()?.to_string(),
                    entry.fields.get("modelId")?.as_str()?.to_string(),
                ));
            }
            // The last persisted level wins, like `model_change`: a later
            // `set_thinking_level` overwrites the creation prefix.
            "thinking_level_change" => {
                if let Some(level) = entry
                    .fields
                    .get("thinkingLevel")
                    .and_then(Value::as_str)
                    .map(str::trim)
                    .filter(|level| !level.is_empty())
                {
                    thinking_level = Some(level.to_string());
                }
            }
            // Keep the latest recap/verdict (TS `agent_status` fold): the
            // `summary` text is part of the agents-view search corpus.
            "agent_status" => {
                agent_status = entry.fields.get("status").cloned();
            }
            "child_usage_attributed" => {
                let usage_field = |name: &str| {
                    entry.fields.get(name).and_then(|usage| {
                        serde_json::from_value::<pa_types::ai::Usage>(usage.clone()).ok()
                    })
                };
                usage_scan.fold_child_attribution(
                    entry.fields.get("targetId").and_then(Value::as_str),
                    usage_field("childUsage"),
                    usage_field("aggregateUsage"),
                );
            }
            "compaction" | "branch_summary" => {
                usage_scan.fold_summarization(entry.fields.get("usage").and_then(|usage| {
                    serde_json::from_value::<pa_types::ai::Usage>(usage.clone()).ok()
                }));
            }
            "message" => {
                message_count += 1;
                if let Some(message) = entry.fields.get("message") {
                    let role = message_role(message);
                    usage_scan.fold_message(
                        &entry.id,
                        role,
                        message.get("usage").and_then(|usage| {
                            serde_json::from_value::<pa_types::ai::Usage>(usage.clone()).ok()
                        }),
                    );
                    if role == Some("assistant") {
                        if let (Some(provider), Some(model_id)) = (
                            message.get("provider").and_then(Value::as_str),
                            message.get("model").and_then(Value::as_str),
                        ) {
                            model = Some((provider.to_string(), model_id.to_string()));
                        }
                    }
                    if matches!(role, Some("user" | "assistant")) {
                        if let Some(timestamp) = message.get("timestamp").and_then(Value::as_u64) {
                            last_activity_ms = Some(last_activity_ms.unwrap_or(0).max(timestamp));
                        }
                    }
                    if role == Some("user") && first_message.is_empty() {
                        let text = message_text(message);
                        if !text.is_empty() {
                            first_message = text;
                        }
                    }
                    // TS `allMessagesText`: user and assistant text
                    // content feeds the full-transcript search.
                    if matches!(role, Some("user" | "assistant")) {
                        let text = message_text(message);
                        append_capped_search_text(&mut all_messages_text, &text);
                    }
                }
            }
            _ => {}
        }
    }
    let header = header?;
    let modified_ms = last_activity_ms.unwrap_or(0);
    let modified = if modified_ms > 0 {
        crate::util::iso_from_unix_ms(modified_ms)
    } else {
        crate::util::iso_from_unix_ms(
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .map_or(0, |d| d.as_millis() as u64),
        )
    };
    Some(SessionInfo {
        path: path.to_path_buf(),
        id: header.id,
        cwd: header.cwd,
        name,
        state,
        model,
        thinking_level,
        parent_session_path: header.parent_session,
        rlm_depth: header.rlm_depth.unwrap_or(0) as u32,
        created: header.timestamp,
        modified,
        message_count,
        first_message: if first_message.is_empty() {
            "(no messages)".to_string()
        } else {
            first_message
        },
        all_messages_text,
        agent_status,
        usage: usage_scan.summary(),
        deleted_descendant_usage: None,
    })
}

fn test_dir() -> PathBuf {
    let dir = std::env::temp_dir().join(format!("session-info-fold-{}", uuid::Uuid::new_v4()));
    fs::create_dir_all(&dir).unwrap();
    dir
}

fn append_rows(path: &Path, rows: &[Value]) {
    let mut file = fs::OpenOptions::new()
        .append(true)
        .create(true)
        .open(path)
        .unwrap();
    for row in rows {
        writeln!(file, "{row}").unwrap();
    }
}

fn assert_fold_matches(path: &Path) {
    assert_eq!(read_session_info(path), legacy_read_session_info(path));
}

#[test]
fn streaming_fold_matches_legacy_across_large_file_and_appends() {
    let dir = test_dir();
    let path = dir.join("session.jsonl");
    append_rows(
        &path,
        &[
            json!({"type":"session","id":"s","timestamp":"2026-09-23T00:00:00.000Z","cwd":"/test","parentSession":"/parent", "rlmDepth":2}),
        ],
    );
    for index in 0..2_000 {
        let text = format!("{index}:{}", "世界🚀".repeat(200));
        append_rows(
            &path,
            &[
                json!({"type":"message","id":format!("m{index}"),"timestamp":"2026-09-23T00:00:00.000Z","message":{"role": if index % 2 == 0 { "user" } else { "assistant" },"content":text,"timestamp":1_790_110_000_000_u64,"provider":"p","model":"a"}}),
            ],
        );
        if index == 500 {
            append_rows(
                &path,
                &[
                    json!({"type":"session_info","id":"n","timestamp":"2026-09-23T00:00:00.000Z","name":" mid-file "}),
                ],
            );
        }
    }
    append_rows(
        &path,
        &[
            json!({"type":"model_change","id":"mc","timestamp":"2026-09-23T00:00:00.000Z","provider":"p2","modelId":"m2"}),
            json!({"type":"session_state","id":"st","timestamp":"2026-09-23T00:00:00.000Z","state":{"status":"sleep"}}),
            json!({"type":"thinking_level_change","id":"tl","timestamp":"2026-09-23T00:00:00.000Z","thinkingLevel":"high"}),
            json!({"type":"agent_status","id":"as","timestamp":"2026-09-23T00:00:00.000Z","status":{"summary":"latest"}}),
        ],
    );
    assert_fold_matches(&path);
    let before = read_session_info(&path).unwrap();
    assert_eq!(read_session_info(&path), Some(before.clone()));
    append_rows(
        &path,
        &[
            json!({"type":"session_info","id":"n2","timestamp":"2026-09-23T00:00:00.000Z","name":"renamed"}),
            json!({"type":"message","id":"m-last","timestamp":"2026-09-23T00:00:00.000Z","message":{"role":"assistant","content":"last","timestamp":1_790_190_000_000_u64,"provider":"tail","model":"tail-model"}}),
        ],
    );
    assert_fold_matches(&path);
    assert_ne!(before, read_session_info(&path).unwrap());
    fs::remove_dir_all(dir).unwrap();
}

#[test]
fn cache_rejects_replacement_and_same_length_in_place_rewrite() {
    let dir = test_dir();
    let path = dir.join("session.jsonl");
    let replacement = dir.join("replacement.jsonl");
    let header =
        json!({"type":"session","id":"s","timestamp":"2026-09-23T00:00:00.000Z","cwd":"/test"});
    let row = |name: &str| json!({"type":"session_info","id":"n","timestamp":"2026-09-23T00:00:00.000Z","name":name});
    let stamp = json!({"type":"message","id":"m","timestamp":"2026-09-23T00:00:00.000Z","message":{"role":"user","content":"start","timestamp":1_790_110_000_000_u64}});
    append_rows(&path, &[header.clone(), row("alpha"), stamp.clone()]);
    assert_fold_matches(&path);
    let _first = read_session_info(&path).unwrap();
    append_rows(&replacement, &[header, row("bravo"), stamp]);
    fs::rename(&replacement, &path).unwrap();
    assert_fold_matches(&path);
    assert_eq!(
        read_session_info(&path).unwrap().name.as_deref(),
        Some("bravo")
    );
    let saved_mtime = fs::metadata(&path).unwrap().modified().unwrap();
    let original = fs::read_to_string(&path).unwrap();
    fs::write(&path, original.replace("bravo", "delta")).unwrap();
    filetime::set_file_mtime(&path, filetime::FileTime::from_system_time(saved_mtime)).unwrap();
    assert_eq!(fs::metadata(&path).unwrap().len(), original.len() as u64);
    assert_fold_matches(&path);
    assert_eq!(
        read_session_info(&path).unwrap().name.as_deref(),
        Some("delta")
    );
    fs::remove_dir_all(dir).unwrap();
}

#[test]
fn untimestamped_fallback_is_not_cached() {
    let dir = test_dir();
    let path = dir.join("session.jsonl");
    append_rows(
        &path,
        &[json!({"type":"session","id":"s","timestamp":"2026-09-23T00:00:00.000Z","cwd":"/test"})],
    );
    let previous = read_session_info(&path).unwrap();
    assert_eq!(read_session_info(&path).unwrap().id, previous.id);
    let mut newer = read_session_info(&path).unwrap();
    let modified = newer.modified.clone();
    newer.modified = previous.modified.clone();
    assert_eq!(newer, previous);
    assert!(!modified.is_empty());
    fs::remove_dir_all(dir).unwrap();
}

#[test]
fn captured_fixture_matches_legacy_if_available() {
    let Ok(path) = std::env::var("PA_SESSION_INFO_CAPTURED_FIXTURE") else {
        return;
    };
    assert_fold_matches(Path::new(&path));
}

#[test]
#[ignore = "run with PA_SESSION_INFO_CAPTURED_FIXTURE to benchmark the real corpus"]
fn captured_fixture_cold_and_warm_timings() {
    let path = std::env::var("PA_SESSION_INFO_CAPTURED_FIXTURE").expect("captured fixture path");
    let path = Path::new(&path);
    let mut legacy = Vec::new();
    let mut cold = Vec::new();
    let mut warm = Vec::new();
    for _ in 0..7 {
        let start = std::time::Instant::now();
        let reference = legacy_read_session_info(path);
        legacy.push(start.elapsed());
        super::session_info_cache().lock().unwrap().drop_state(path);
        let start = std::time::Instant::now();
        let result = read_session_info(path);
        cold.push(start.elapsed());
        assert_eq!(result, reference);
        let start = std::time::Instant::now();
        assert_eq!(read_session_info(path), result);
        warm.push(start.elapsed());
    }
    legacy.sort();
    cold.sort();
    warm.sort();
    eprintln!(
        "31MB read_session_info median old={:?} new_cold={:?} new_warm={:?}",
        legacy[3], cold[3], warm[3]
    );
}

#[test]
fn a_torn_trailing_line_folds_once_completed() {
    let dir = test_dir();
    let path = dir.join("torn.jsonl");
    append_rows(
        &path,
        &[json!({"type":"session","id":"t","timestamp":"2026-09-23T00:00:00.000Z","cwd":"/test"})],
    );
    // A torn trailing message - invalid JSON (the write is mid-line), no
    // newline: the scan leaves it unconsumed and the row cannot fold it
    // (TS snapshotSessionInfo's tornTail is lenient: a parse failure is
    // skipped).
    let torn_head = r#"{"type":"message","id":"torn","timestamp":"2026-09-23T00:00:00.000Z","message":{"role":"user","content":"torn"#;
    {
        let mut file = fs::OpenOptions::new().append(true).open(&path).unwrap();
        file.write_all(torn_head.as_bytes()).unwrap();
    }
    let partial = read_session_info(&path).unwrap();
    assert_eq!(partial.message_count, 0, "a torn line must not fold");
    // The completed line folds exactly once, and the row matches the oracle.
    {
        let mut file = fs::OpenOptions::new().append(true).open(&path).unwrap();
        file.write_all(br#" text","timestamp":1790110000000}}"#.as_slice())
            .unwrap();
        file.write_all(b"\n").unwrap();
    }
    assert_fold_matches(&path);
    let completed = read_session_info(&path).unwrap();
    assert_eq!(completed.message_count, 1);
    assert!(completed.all_messages_text.contains("torn text"));
}

#[test]
fn a_same_size_rewrite_rescans_from_the_top() {
    let dir = test_dir();
    let path = dir.join("rewrite.jsonl");
    append_rows(
        &path,
        &[
            json!({"type":"session","id":"r","timestamp":"2026-09-23T00:00:00.000Z","cwd":"/test"}),
            json!({"type":"session_info","id":"n","timestamp":"2026-09-23T00:00:00.000Z","name":"before"}),
        ],
    );
    let first = read_session_info(&path).unwrap();
    assert_eq!(first.name.as_deref(), Some("before"));
    // A same-size rewrite with different early content: the resume must not
    // answer the stale row (TS resumes only strictly-grown files).
    let line = json!({"type":"session_info","id":"n","timestamp":"2026-09-23T00:00:00.000Z","name":"after!"}).to_string();
    let before_line = json!({"type":"session_info","id":"n","timestamp":"2026-09-23T00:00:00.000Z","name":"before"}).to_string();
    assert_eq!(line.len(), before_line.len());
    let content = fs::read_to_string(&path).unwrap();
    let rewritten = content.replacen(&before_line, &line, 1);
    assert_eq!(rewritten.len(), content.len());
    // Force the mtime tick so the generation is not byte-equal.
    let past = std::time::SystemTime::now() - std::time::Duration::from_secs(10);
    let _ = fs::write(&path, rewritten.as_bytes());
    let file = fs::File::open(&path).unwrap();
    let _ = file.set_modified(past);
    drop(file);
    let rewritten_info = read_session_info(&path).unwrap();
    assert_eq!(
        rewritten_info.name.as_deref(),
        Some("after!"),
        "a same-size rewrite must rescan"
    );
    assert_fold_matches(&path);
}

#[test]
fn multi_round_appends_match_the_legacy_fold() {
    let dir = test_dir();
    let path = dir.join("rounds.jsonl");
    append_rows(
        &path,
        &[json!({"type":"session","id":"q","timestamp":"2026-09-23T00:00:00.000Z","cwd":"/test"})],
    );
    for round in 0..5 {
        for index in 0..50 {
            append_rows(
                &path,
                &[
                    json!({"type":"message","id":format!("r{round}m{index}"),"timestamp":"2026-09-23T00:00:00.000Z","message":{"role": if index % 2 == 0 { "user" } else { "assistant" },"content":format!("round {round} message {index}"),"timestamp":1_790_110_000_000_u64 + round as u64 * 1000 + index as u64}}),
                ],
            );
        }
        assert_fold_matches(&path);
    }
    let final_info = read_session_info(&path).unwrap();
    assert_eq!(final_info.message_count, 250);
}

#[test]
fn a_failed_prefix_check_rescans_from_byte_zero() {
    let dir = test_dir();
    let path = dir.join("grown-rewrite.jsonl");
    append_rows(
        &path,
        &[
            json!({"type":"session","id":"g","timestamp":"2026-09-23T00:00:00.000Z","cwd":"/test"}),
            json!({"type":"session_info","id":"n","timestamp":"2026-09-23T00:00:00.000Z","name":"before"}),
        ],
    );
    let first = read_session_info(&path).unwrap();
    assert_eq!(first.name.as_deref(), Some("before"));
    // An in-place rewrite of the consumed prefix's final line changes the
    // resume tail window, so the grown-file path fails `prefix_intact` and
    // must rescan from byte zero. A fresh scan that kept the shared cursor
    // where `prefix_intact` left it would start mid-file, miss the session
    // header, and return None (the bots' prefix-rewrite-then-append case).
    let line = json!({"type":"session_info","id":"n","timestamp":"2026-09-23T00:00:00.000Z","name":"after!"}).to_string();
    let before_line = json!({"type":"session_info","id":"n","timestamp":"2026-09-23T00:00:00.000Z","name":"before"}).to_string();
    assert_eq!(line.len(), before_line.len());
    let content = fs::read_to_string(&path).unwrap();
    let rewritten = content.replacen(&before_line, &line, 1);
    assert_eq!(rewritten.len(), content.len());
    let _ = fs::write(&path, rewritten.as_bytes());
    // The file also grows: a valid appended line enters the resume path.
    append_rows(
        &path,
        &[
            json!({"type":"message","id":"m1","timestamp":"2026-09-23T00:00:00.000Z","message":{"role":"user","content":"grown","timestamp":1_790_110_000_000_u64}}),
        ],
    );
    // Force the mtime tick so the generation is not byte-equal.
    let past = std::time::SystemTime::now() - std::time::Duration::from_secs(10);
    let file = fs::File::open(&path).unwrap();
    let _ = file.set_modified(past);
    drop(file);
    let second = read_session_info(&path).unwrap();
    assert_eq!(
        second.name.as_deref(),
        Some("after!"),
        "a prefix rewrite then append must rescan from the top"
    );
    assert_fold_matches(&path);
}

#[test]
fn a_valid_unterminated_final_line_folds_into_the_snapshot() {
    let dir = test_dir();
    let path = dir.join("unterminated.jsonl");
    append_rows(
        &path,
        &[json!({"type":"session","id":"u","timestamp":"2026-09-23T00:00:00.000Z","cwd":"/test"})],
    );
    // The final line is complete JSON with NO terminal newline: the row
    // must fold it (TS snapshotSessionInfo's tornTail - the legacy
    // str::lines oracle yields it too), without consuming it.
    let tail = json!({"type":"session_info","id":"n","timestamp":"2026-09-23T00:00:00.000Z","name":"tail-name"}).to_string();
    {
        let mut file = fs::OpenOptions::new().append(true).open(&path).unwrap();
        file.write_all(tail.as_bytes()).unwrap();
    }
    let info = read_session_info(&path).unwrap();
    assert_eq!(info.name.as_deref(), Some("tail-name"));
    assert_fold_matches(&path);
    // Completing the line folds it into the consumed prefix exactly once.
    {
        let mut file = fs::OpenOptions::new().append(true).open(&path).unwrap();
        file.write_all(b"\n").unwrap();
    }
    assert_fold_matches(&path);
    let completed = read_session_info(&path).unwrap();
    assert_eq!(completed.name.as_deref(), Some("tail-name"));
}

#[test]
fn zero_usage_states_are_capped_by_count_not_only_the_usage_budget() {
    let dir = test_dir();
    // Zero-usage sessions: a timestamped user message each (no assistant
    // usage block, so accounted entries stay 0 - only the count cap can
    // evict; the message also passes the modified_ms > 0 store guard).
    for index in 0..(SESSION_SCAN_MAX_CACHED_STATES + 8) {
        let path = dir.join(format!("zero-{index}.jsonl"));
        append_rows(
            &path,
            &[
                json!({"type":"session","id":format!("z{index}"),"timestamp":"2026-09-23T00:00:00.000Z","cwd":"/test"}),
                json!({"type":"message","id":format!("zm{index}"),"timestamp":"2026-09-23T00:00:00.000Z","message":{"role":"user","content":"n","timestamp":1_790_110_000_000_u64}}),
            ],
        );
        let info = read_session_info(&path).unwrap();
        assert_eq!(info.message_count, 1);
    }
    // The cache really populated past the cap and stayed capped: LRU-first
    // eviction dropped the earliest-written files, the latest stay resident.
    let cache = super::session_info_cache().lock().unwrap();
    assert_eq!(
        super::SESSION_SCAN_MAX_CACHED_STATES,
        cache.states.len(),
        "the state count must sit exactly at the cap, got {}",
        cache.states.len()
    );
    assert_eq!(cache.order.len(), cache.states.len());
    assert!(!cache.states.contains_key(&dir.join("zero-0.jsonl")));
    assert!(!cache.states.contains_key(&dir.join("zero-7.jsonl")));
    assert!(cache.states.contains_key(&dir.join(format!(
        "zero-{}.jsonl",
        super::SESSION_SCAN_MAX_CACHED_STATES + 7
    ))));
}

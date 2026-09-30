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
                    // content feeds the full-transcript search. The legacy
                    // reference inlines the append (the product's helper
                    // takes the fold's running char counter now), so the
                    // oracle stays independent of the perf reshape.
                    if matches!(role, Some("user" | "assistant")) {
                        let text = message_text(message);
                        if !text.is_empty() {
                            let used = all_messages_text.chars().count();
                            if used < SESSION_LIST_SEARCH_TEXT_MAX_CHARS {
                                if used > 0 {
                                    all_messages_text.push(' ');
                                }
                                let remaining = SESSION_LIST_SEARCH_TEXT_MAX_CHARS
                                    - all_messages_text.chars().count();
                                all_messages_text.extend(text.chars().take(remaining));
                            }
                        }
                    }
                }
            }
            _ => {}
        }
    }
    let header = header?;
    // Mirrors `build_info`: newest message timestamp, then the header's
    // creation timestamp, then the file's mtime - never scan time. Zero is
    // a real epoch timestamp; only the message arm filters it (a missing
    // entry timestamp stamps 0, not activity). `None` renders blank.
    let modified_ms = last_activity_ms
        .filter(|ms| *ms > 0)
        .or_else(|| crate::util::iso_to_unix_ms(&header.timestamp))
        .or_else(|| {
            fs::metadata(path).ok().and_then(|meta| {
                meta.modified()
                    .ok()
                    .and_then(|time| time.duration_since(std::time::UNIX_EPOCH).ok())
                    .map(|duration| duration.as_millis() as u64)
            })
        });
    let modified = modified_ms
        .map(crate::util::iso_from_unix_ms)
        .unwrap_or_default();
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

/// The persisted scan-state sidecar: a state written at lease release and
/// loaded on a process-cache miss resumes the fold of the appended tail -
/// whole-row equality against the full fold, including a prefix-targeted
/// attribution (the resumed fold must find the prefix id in the persisted
/// per-id map). A replacement file (a new inode) rejects the stale sidecar
/// and rescans whole. Unix-only: a state is certified into the process
/// cache (and so persistable) only on Unix - `read_session_info_from`'s
/// store gate - so no sidecar exists to load elsewhere.
#[cfg(unix)]
#[test]
fn a_persisted_scan_state_resumes_like_the_full_fold() {
    let dir = test_dir();
    let path = dir.join("sidecar.jsonl");
    let usage = |cost: f64| {
        json!({
            "input": 100, "output": 10, "cacheRead": 0, "cacheWrite": 0, "totalTokens": 110,
            "cost": { "input": 0.0, "output": cost, "cacheRead": 0.0, "cacheWrite": 0.0, "total": cost },
        })
    };
    let assistant = |id: &str, cost: f64| {
        json!({
            "type": "message", "id": id, "timestamp": "2026-09-23T00:00:00.000Z",
            "message": {
                "role": "assistant", "content": format!("answer {id}"),
                "timestamp": 1_790_110_000_000_u64, "usage": usage(cost),
            },
        })
    };
    let attribution = |id: &str, target: &str, child: f64, aggregate: f64| {
        json!({
            "type": "child_usage_attributed", "id": id, "timestamp": "2026-09-23T00:00:00.000Z",
            "targetId": target, "childUsage": usage(child), "aggregateUsage": usage(aggregate),
        })
    };
    append_rows(
        &path,
        &[
            json!({"type":"session","id":"sc","timestamp":"2026-09-23T00:00:00.000Z","cwd":"/test"}),
            assistant("a1", 0.1),
            assistant("a2", 0.2),
            assistant("a3", 0.3),
            json!({"type":"compaction","id":"c1","timestamp":"2026-09-23T00:00:00.000Z","summary":"s","usage":usage(0.25)}),
            attribution("x1", "a2", 0.05, 0.45),
        ],
    );
    assert_fold_matches(&path);
    // The lease-release write persists the certified state beside the
    // file; the in-process copy is gone, so the next read can only be
    // served by the sidecar.
    super::persist_info_sidecar(&path);
    assert!(
        path.with_extension("info-cache.json").is_file(),
        "the release write persists the state"
    );
    // The sidecar carries message text (the search corpus, the first
    // message): it is owner-only like the session files it derives from.
    assert_eq!(
        pa_core::platform::perms::file_mode(&path.with_extension("info-cache.json")),
        Some(pa_core::platform::perms::PRIVATE_FILE_MODE)
    );
    super::session_info_cache()
        .lock()
        .unwrap()
        .drop_state(&path);
    append_rows(
        &path,
        &[attribution("x2", "a2", 0.02, 0.52), assistant("a4", 0.4)],
    );
    assert_fold_matches(&path);
    // A replacement file (a new inode): the stale sidecar fails the
    // same-file ladder and the scan runs cold from byte zero.
    let replacement = dir.join("replacement.jsonl");
    append_rows(
        &replacement,
        &[
            json!({"type":"session","id":"sc2","timestamp":"2026-09-23T00:00:00.000Z","cwd":"/test"}),
            assistant("b1", 0.5),
        ],
    );
    fs::rename(&replacement, &path).unwrap();
    super::session_info_cache()
        .lock()
        .unwrap()
        .drop_state(&path);
    assert_fold_matches(&path);
    fs::remove_dir_all(dir).unwrap();
}

/// The sidecar round trip through a real lease, for a session opened by
/// a symlinked dir (macOS `/var`, a symlinked `~/.prime`): the release
/// persists what the holder's raw-path reads cached, though the lease
/// keys the file canonically. The next read then serves a valid sidecar
/// (here a name the file does not carry - a cold scan cannot produce
/// it), and scans cold past a corrupt one or one at another version.
/// Unix-only like its sibling: only Unix certifies a state to persist.
#[cfg(unix)]
#[test]
fn a_symlinked_lease_release_persists_a_sidecar_the_next_read_serves() {
    let dir = test_dir();
    let real_dir = dir.join("real");
    fs::create_dir_all(&real_dir).unwrap();
    std::os::unix::fs::symlink(&real_dir, dir.join("linked")).unwrap();
    let path = dir.join("linked").join("s.jsonl");
    append_rows(
        &path,
        &[
            json!({"type":"session","id":"sl","timestamp":"2026-09-23T00:00:00.000Z","cwd":"/test"}),
            json!({"type":"message","id":"u1","timestamp":"2026-09-23T00:00:00.000Z",
                "message":{"role":"user","content":"hi","timestamp":1_790_110_000_000_u64}}),
        ],
    );
    let lease = crate::lease::acquire_runtime_session_lease(&path, &dir).unwrap();
    let cold = read_session_info(&path).unwrap();
    drop(lease);
    let sidecar = real_dir.join("s.info-cache.json");
    assert!(sidecar.is_file(), "the release persists the raw-path state");
    let mut valid: Value = serde_json::from_slice(&fs::read(&sidecar).unwrap()).unwrap();
    valid["state"]["acc"]["name"] = json!("from the sidecar");
    let mut other_version = valid.clone();
    other_version["version"] = json!(valid["version"].as_u64().unwrap() + 1);
    let served = SessionInfo {
        name: Some("from the sidecar".to_string()),
        ..cold.clone()
    };
    for (contents, expected) in [
        (valid.to_string(), &served),
        (other_version.to_string(), &cold),
        ("{".to_string(), &cold),
    ] {
        fs::write(&sidecar, contents).unwrap();
        super::session_info_cache()
            .lock()
            .unwrap()
            .drop_state(&path);
        assert_eq!(read_session_info(&path).as_ref(), Some(expected));
    }
    fs::remove_dir_all(dir).unwrap();
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
    assert_eq!(cache.ordinal_by_path.len(), cache.states.len());
    assert!(!cache.states.contains_key(&dir.join("zero-0.jsonl")));
    assert!(!cache.states.contains_key(&dir.join("zero-7.jsonl")));
    assert!(cache.states.contains_key(&dir.join(format!(
        "zero-{}.jsonl",
        super::SESSION_SCAN_MAX_CACHED_STATES + 7
    ))));
}

#[test]
fn scan_cache_recency_tracks_updates_and_removals_without_growth() {
    let dir = test_dir();
    let paths: Vec<PathBuf> = (0..3)
        .map(|index| dir.join(format!("lru-{index}.jsonl")))
        .collect();
    let generation = SessionInfoGeneration::from_metadata(&fs::metadata(&dir).unwrap());
    let mut cache = SessionInfoScanCache::default();
    for path in &paths {
        cache.store_state(path, SessionScanState::fresh(generation));
    }
    cache.touch(&paths[0]);
    cache.touch(&paths[2]);
    assert_eq!(
        cache.order.values().collect::<Vec<_>>(),
        vec![&paths[1], &paths[0], &paths[2]]
    );
    for _ in 0..1000 {
        cache.touch(&paths[0]);
    }
    assert_eq!(cache.order.len(), 3);
    assert_eq!(cache.ordinal_by_path.len(), 3);
    assert_eq!(cache.order.first_key_value().unwrap().1, &paths[1]);
    cache.store_state(&paths[1], SessionScanState::fresh(generation));
    assert_eq!(
        cache.order.values().collect::<Vec<_>>(),
        vec![&paths[2], &paths[0], &paths[1]]
    );
    cache.drop_state(&paths[0]);
    assert_eq!(
        cache.order.values().collect::<Vec<_>>(),
        vec![&paths[2], &paths[1]]
    );
    assert_eq!(cache.ordinal_by_path.len(), cache.states.len());
    cache.next_ordinal = u64::MAX;
    cache.touch(&paths[2]);
    assert_eq!(
        cache.order.values().collect::<Vec<_>>(),
        vec![&paths[1], &paths[2]]
    );
    assert_eq!(cache.ordinal_by_path.len(), cache.states.len());
    fs::remove_dir_all(dir).unwrap();
}

/// The old-record regression (the Mac bug's shape): a session created
/// days ago whose messages carry no numeric timestamp. The fold's
/// `modified` is the header's own creation timestamp - TS
/// `getSessionModifiedDateFromLastActivity` - so the agents-view age
/// column keeps reading the record's real age across re-enumeration
/// (rescans and mtime cache busts), never a scan-time `now()`.
#[test]
fn no_timestamp_record_modified_is_the_header_time_across_rescans() {
    let dir = test_dir();
    let path = dir.join("header-only.jsonl");
    append_rows(
        &path,
        &[
            json!({"type":"session","id":"stub","timestamp":"2026-09-20T12:00:00.000Z","cwd":"/test","rlmDepth":1}),
        ],
    );
    // A stamped mtime distinct from both the header time and the scan
    // time: whichever value `modified` carries names its source.
    filetime::set_file_mtime(&path, filetime::FileTime::from_unix_time(1_790_110_000, 0)).unwrap();
    let info = read_session_info(&path).unwrap();
    assert_eq!(info.created, "2026-09-20T12:00:00.000Z");
    assert_eq!(info.modified, "2026-09-20T12:00:00.000Z");
    // The rescan (no-timestamp records never certify into the cache) and
    // an mtime cache bust both keep the durable header value.
    assert_eq!(
        read_session_info(&path).unwrap().modified,
        "2026-09-20T12:00:00.000Z"
    );
    filetime::set_file_mtime(&path, filetime::FileTime::now()).unwrap();
    assert_eq!(
        read_session_info(&path).unwrap().modified,
        "2026-09-20T12:00:00.000Z"
    );
    assert_fold_matches(&path);
    fs::remove_dir_all(dir).unwrap();
}

/// A header timestamp no parser accepts: TS falls to `stats.mtime`, and
/// the fold follows the file's own mtime - including after an mtime
/// cache bust - never the scan time.
#[test]
fn unparseable_header_modified_falls_back_to_the_file_mtime() {
    let dir = test_dir();
    let path = dir.join("legacy-header.jsonl");
    append_rows(
        &path,
        &[json!({"type":"session","id":"legacy","timestamp":"not-a-date","cwd":"/test"})],
    );
    filetime::set_file_mtime(&path, filetime::FileTime::from_unix_time(1_790_110_000, 0)).unwrap();
    let info = read_session_info(&path).unwrap();
    assert_eq!(info.created, "not-a-date");
    assert_eq!(
        info.modified,
        crate::util::iso_from_unix_ms(1_790_110_000_000)
    );
    filetime::set_file_mtime(&path, filetime::FileTime::from_unix_time(1_790_120_000, 0)).unwrap();
    assert_eq!(
        read_session_info(&path).unwrap().modified,
        crate::util::iso_from_unix_ms(1_790_120_000_000)
    );
    assert_fold_matches(&path);
    fs::remove_dir_all(dir).unwrap();
}

/// A record with real message timestamps keeps its live source: the
/// newest user/assistant message timestamp wins over the header fallback
/// and the file mtime.
#[test]
fn message_timestamps_still_win_over_the_header_fallback() {
    let dir = test_dir();
    let path = dir.join("live.jsonl");
    append_rows(
        &path,
        &[
            json!({"type":"session","id":"live","timestamp":"2026-09-20T12:00:00.000Z","cwd":"/test"}),
            json!({"type":"message","id":"m1","timestamp":"2026-09-24T00:00:00.000Z","message":{"role":"user","content":"hi","timestamp":1_790_110_000_000_u64}}),
            json!({"type":"message","id":"m2","timestamp":"2026-09-24T00:00:01.000Z","message":{"role":"assistant","content":"ok","timestamp":1_790_110_001_000_u64,"provider":"p","model":"m"}}),
        ],
    );
    // A future mtime proves the message timestamp wins over it too.
    filetime::set_file_mtime(&path, filetime::FileTime::from_unix_time(1_800_000_000, 0)).unwrap();
    let info = read_session_info(&path).unwrap();
    assert_eq!(
        info.modified,
        crate::util::iso_from_unix_ms(1_790_110_001_000)
    );
    assert_fold_matches(&path);
    fs::remove_dir_all(dir).unwrap();
}

/// An impossible calendar date in the header (2026-02-31): the parser
/// rejects it instead of normalizing it into March (TS `Date.parse`
/// rejects it too), so the fold falls to the file's mtime.
#[test]
fn impossible_calendar_date_header_falls_back_to_the_file_mtime() {
    let dir = test_dir();
    let path = dir.join("feb-31.jsonl");
    append_rows(
        &path,
        &[
            json!({"type":"session","id":"feb","timestamp":"2026-02-31T00:00:00.000Z","cwd":"/test"}),
        ],
    );
    filetime::set_file_mtime(&path, filetime::FileTime::from_unix_time(1_790_110_000, 0)).unwrap();
    let info = read_session_info(&path).unwrap();
    assert_eq!(info.created, "2026-02-31T00:00:00.000Z");
    assert_eq!(
        info.modified,
        crate::util::iso_from_unix_ms(1_790_110_000_000)
    );
    assert_fold_matches(&path);
    fs::remove_dir_all(dir).unwrap();
}

/// A real epoch mtime renders as the epoch date: a durable zero stays
/// distinct from an unavailable value (blank), and neither is ever a
/// fabricated scan-time age.
#[test]
fn epoch_zero_mtime_renders_the_epoch_not_blank() {
    let dir = test_dir();
    let path = dir.join("epoch.jsonl");
    append_rows(
        &path,
        &[json!({"type":"session","id":"epoch","timestamp":"not-a-date","cwd":"/test"})],
    );
    filetime::set_file_mtime(&path, filetime::FileTime::from_unix_time(0, 0)).unwrap();
    let info = read_session_info(&path).unwrap();
    assert_eq!(info.modified, "1970-01-01T00:00:00.000Z");
    assert_fold_matches(&path);
    fs::remove_dir_all(dir).unwrap();
}

/// The corpus text reads the `content` span the typed parse borrows; the
/// full-parse path (the legacy reference fold above) re-parses the entry
/// and reads the same subtree through `message_text`. This matrix pins
/// the two extractions together for every content shape the fold can
/// meet on disk, then folds the same rows end to end: each row's text,
/// the first-message pick, and the capped corpus must agree.
#[test]
fn content_borrow_matches_full_parse_across_content_matrix() {
    let header =
        json!({"type":"session","id":"s","timestamp":"2026-09-23T00:00:00.000Z","cwd":"/test"});
    let row = |id: &str, message: Value| json!({"type":"message","id":id,"timestamp":"2026-09-23T00:00:00.000Z","message":message});
    let messages = vec![
        // plain string content, user role
        (row("m0", json!({"role":"user","content":"hello"})), "hello"),
        // escaped string content: newlines, quotes, backslash, and unicode
        // escapes at the JSON byte level (built from raw JSON so the
        // escapes ride the bytes both extraction paths walk)
        (
            row(
                "m1",
                serde_json::from_str::<Value>(
                    r#"{"role":"user","content":"line1\nline2 \"quoted\" \\ \"é世界\""}"#,
                )
                .unwrap(),
            ),
            "line1\nline2 \"quoted\" \\ \"é世界\"",
        ),
        // text blocks join with a space (TS `contentToText`)
        (
            row(
                "m2",
                json!({"role":"assistant","content":[{"type":"text","text":"hello"},{"type":"text","text":"world"}]}),
            ),
            "hello world",
        ),
        // non-text blocks and blocks without string text are skipped
        (
            row(
                "m3",
                json!({"role":"assistant","content":[{"type":"thinking","thinking":"x"},{"type":"text","text":"visible"},{"type":"tool_call","name":"t","args":{"a":1}},{"type":"text","text":null},{"type":"text","text":42},{"type":"text"}]}),
            ),
            "visible",
        ),
        // empty array, empty string, missing content, null content, scalar content
        (row("m4", json!({"role":"assistant","content":[]})), ""),
        (row("m5", json!({"role":"assistant","content":""})), ""),
        (row("m6", json!({"role":"assistant"})), ""),
        (row("m7", json!({"role":"assistant","content":null})), ""),
        (row("m8", json!({"role":"assistant","content":42})), ""),
        (
            row(
                "m9",
                json!({"role":"assistant","content":[{"type":"image","source":{"data":"base64"}}]}),
            ),
            "",
        ),
        // tool results never feed the corpus, but the extraction still
        // agrees on their shape
        (
            row(
                "m10",
                json!({"role":"toolResult","content":[{"type":"text","text":"tool output"}]}),
            ),
            "tool output",
        ),
        // a block object with extra unknown fields
        (
            row(
                "m11",
                json!({"role":"assistant","content":[{"id":"b1","type":"text","text":"extra fields","meta":{"x":1}}]}),
            ),
            "extra fields",
        ),
        // deeply nested unicode escapes inside the content — including a
        // surrogate pair — at the JSON byte level
        (
            row(
                "m12",
                serde_json::from_str::<Value>(
                    r#"{"role":"user","content":"\u672a\u8a60 emoji \ud83d\ude80 tail"}"#,
                )
                .unwrap(),
            ),
            "未詠 emoji 🚀 tail",
        ),
        // a message object with only role (no content at all)
        (row("m13", json!({"role":"user"})), ""),
        // scalar content under the user role
        (row("m14", json!({"role":"user","content":true})), ""),
    ];

    // Row-level differential: the borrowed-span extraction equals the
    // full-parse `message_text` for every row in the matrix.
    for (entry, expected) in &messages {
        let line = entry.to_string();
        let full: SessionEntry = serde_json::from_str(&line).unwrap();
        let reference = full
            .fields
            .get("message")
            .map(message_text)
            .unwrap_or_default();
        assert_eq!(&reference, expected, "reference extraction: {line}");
        let typed: SessionInfoEntry = serde_json::from_str(&line).unwrap();
        let borrowed = typed
            .message
            .as_ref()
            .map(|message| message_content_text(message.content))
            .unwrap_or_default();
        assert_eq!(&borrowed, expected, "borrowed extraction: {line}");
        assert_eq!(borrowed, reference, "differential: {line}");
    }

    // Fold-level differential: the same rows through the production fold
    // and the legacy full-parse reference, with cap-cut appends around
    // the matrix (multibyte boundary cut, then past the cap).
    let dir = test_dir();
    let path = dir.join("session.jsonl");
    append_rows(&path, std::slice::from_ref(&header));
    for (entry, _) in &messages {
        append_rows(&path, std::slice::from_ref(entry));
    }
    append_rows(
        &path,
        &[
            row(
                "cap0",
                json!({"role":"assistant","content":"x".repeat(SESSION_LIST_SEARCH_TEXT_MAX_CHARS)}),
            ),
            row("cap1", json!({"role":"assistant","content":"past the cap"})),
            row("cap2", json!({"role":"user","content":"past the cap user"})),
        ],
    );
    assert_fold_matches(&path);

    // First-message pick: the first NON-EMPTY user text wins (m0), the
    // empty-string user rows never claim it, and later users cannot
    // replace it; the corpus holds every user/assistant text under the
    // cap in fold order.
    let info = read_session_info(&path).unwrap();
    assert_eq!(info.first_message, "hello");
    assert!(info.all_messages_text.starts_with("hello line1"));
    assert!(info.all_messages_text.chars().count() <= SESSION_LIST_SEARCH_TEXT_MAX_CHARS);

    // A session whose only user text is empty keeps the no-message label.
    let empty_dir = test_dir();
    let empty_path = empty_dir.join("session.jsonl");
    append_rows(
        &empty_path,
        &[
            header,
            row("e0", json!({"role":"user","content":""})),
            row("e1", json!({"role":"user"})),
            row(
                "e2",
                json!({"role":"assistant","content":[{"type":"text","text":"assistant only"}]}),
            ),
        ],
    );
    assert_fold_matches(&empty_path);
    let empty_info = read_session_info(&empty_path).unwrap();
    assert_eq!(empty_info.first_message, "(no messages)");

    fs::remove_dir_all(dir).unwrap();
    fs::remove_dir_all(empty_dir).unwrap();
}

/// The borrowed metadata reads match the full-parse `Value` reads for
/// every shape the fold can meet on disk: the typed parse borrows the
/// entry's scalar fields (`Cow`) and its object fields (raw spans), and
/// each arm parses its span back only when the arm runs. This matrix pins
/// the span's parse-back to the `Value` read per row, checks the typed
/// parse still rejects exactly the rows the owned struct rejected, and
/// folds the accepted rows end to end against the legacy full-parse
/// reference.
#[test]
#[allow(clippy::used_underscore_binding)] // the envelope scalars the fold
                                          // keeps only for acceptance (`_timestamp`, `_parent_id`) are READ here to
                                          // pin that acceptance, which is exactly the matrix's point
fn borrowed_metadata_reads_match_full_parse_across_shape_matrix() {
    // Rows are written from raw JSON so the escapes ride the bytes both
    // extraction paths walk.
    let rows: Vec<&str> = vec![
        r#"{"type":"custom","id":"plain-id","timestamp":"2026-09-23T00:00:00.000Z"}"#,
        // escaped scalars: the type tag, id, timestamp, parentId
        r#"{"type":"custom","id":"escaped id","timestamp":"2026-09-23T00:00:00.000Z","parentId":"pérent"}"#,
        // a string carrying every JSON escape class
        r#"{"type":"custom","id":"q\"uo\\te\/bfnrt\u00e9","timestamp":"2026-09-23T00:00:00.000Z"}"#,
        // name shapes: present, absent, null, non-string, escaped, padded
        r#"{"type":"session_info","id":"n0","timestamp":"2026-09-23T00:00:00.000Z","name":"fresh name"}"#,
        r#"{"type":"session_info","id":"n1","timestamp":"2026-09-23T00:00:00.000Z"}"#,
        r#"{"type":"session_info","id":"n2","timestamp":"2026-09-23T00:00:00.000Z","name":null}"#,
        r#"{"type":"session_info","id":"n3","timestamp":"2026-09-23T00:00:00.000Z","name":42}"#,
        r#"{"type":"session_info","id":"n4","timestamp":"2026-09-23T00:00:00.000Z","name":"escéped"}"#,
        r#"{"type":"session_info","id":"n5","timestamp":"2026-09-23T00:00:00.000Z","name":"   "}"#,
        r#"{"type":"session_info","id":"n6","timestamp":"2026-09-23T00:00:00.000Z","name":"   trimmed   "}"#,
        // state shapes: hidden/sleep normalize; non-string status; non-object
        r#"{"type":"session_state","id":"s0","timestamp":"2026-09-23T00:00:00.000Z","state":{"status":"hidden"}}"#,
        r#"{"type":"session_state","id":"s1","timestamp":"2026-09-23T00:00:00.000Z","state":{"status":"sl\u0065ep"}}"#,
        r#"{"type":"session_state","id":"s2","timestamp":"2026-09-23T00:00:00.000Z","state":{"status":42}}"#,
        r#"{"type":"session_state","id":"s3","timestamp":"2026-09-23T00:00:00.000Z","state":42}"#,
        // model_change: escaped modelId; the abort shapes
        r#"{"type":"model_change","id":"mc0","timestamp":"2026-09-23T00:00:00.000Z","provider":"prov","modelId":"m\u00f3del"}"#,
        r#"{"type":"model_change","id":"mc1","timestamp":"2026-09-23T00:00:00.000Z","provider":"prov","modelId":42}"#,
        r#"{"type":"model_change","id":"mc2","timestamp":"2026-09-23T00:00:00.000Z","provider":42,"modelId":"m"}"#,
        r#"{"type":"model_change","id":"mc3","timestamp":"2026-09-23T00:00:00.000Z","provider":"prov"}"#,
        // thinking_level_change: escaped, empty-after-trim, non-string
        r#"{"type":"thinking_level_change","id":"t0","timestamp":"2026-09-23T00:00:00.000Z","thinkingLevel":"h\u0069gh"}"#,
        r#"{"type":"thinking_level_change","id":"t1","timestamp":"2026-09-23T00:00:00.000Z","thinkingLevel":"   "}"#,
        r#"{"type":"thinking_level_change","id":"t2","timestamp":"2026-09-23T00:00:00.000Z","thinkingLevel":42}"#,
        // message shapes: role absent/null/non-string/escaped, timestamp
        // float/string/huge/null, provider/model partial pairs
        r#"{"type":"message","id":"m0","timestamp":"2026-09-23T00:00:00.000Z","message":{"role":"assistant","content":"ok","timestamp":123,"provider":"p","model":"m"}}"#,
        r#"{"type":"message","id":"m1","timestamp":"2026-09-23T00:00:00.000Z","message":{"role":"assist\u0061nt","content":"escaped role matches","timestamp":456}}"#,
        r#"{"type":"message","id":"m2","timestamp":"2026-09-23T00:00:00.000Z","message":{"role":42,"content":"non-string role"}}"#,
        r#"{"type":"message","id":"m3","timestamp":"2026-09-23T00:00:00.000Z","message":{"role":"user","content":"ts float","timestamp":1.5}}"#,
        r#"{"type":"message","id":"m4","timestamp":"2026-09-23T00:00:00.000Z","message":{"role":"user","content":"ts string","timestamp":"999"}}"#,
        r#"{"type":"message","id":"m5","timestamp":"2026-09-23T00:00:00.000Z","message":{"role":"user","content":"ts huge","timestamp":18446744073709551616}}"#,
        r#"{"type":"message","id":"m6","timestamp":"2026-09-23T00:00:00.000Z","message":{"role":"user","content":"ts null","timestamp":null}}"#,
        r#"{"type":"message","id":"m7","timestamp":"2026-09-23T00:00:00.000Z","message":{"role":"assistant","content":"prov nonstring","provider":42,"model":"m"}}"#,
        r#"{"type":"message","id":"m8","timestamp":"2026-09-23T00:00:00.000Z","message":{"role":"assistant","content":"model absent","provider":"p"}}"#,
        r#"{"type":"message","id":"m9","timestamp":"2026-09-23T00:00:00.000Z","message":null}"#,
        r#"{"type":"message","id":"m10","timestamp":"2026-09-23T00:00:00.000Z"}"#,
        // a non-object message: the typed parse rejects the row (the
        // owned struct did too), the reference fold's dispatch is a no-op
        r#"{"type":"message","id":"m11","timestamp":"2026-09-23T00:00:00.000Z","message":"plain string"}"#,
        // child_usage_attributed: a non-string targetId rejects the row
        // (the owned Option<String> rejected it too)
        r#"{"type":"child_usage_attributed","id":"c0","timestamp":"2026-09-23T00:00:00.000Z","targetId":"x"}"#,
        r#"{"type":"child_usage_attributed","id":"c1","timestamp":"2026-09-23T00:00:00.000Z","targetId":42}"#,
        // rows the typed parse still rejects: non-string required scalars
        r#"{"type":42,"id":"x","timestamp":"2026-09-23T00:00:00.000Z"}"#,
        r#"{"type":"custom","id":42,"timestamp":"2026-09-23T00:00:00.000Z"}"#,
        r#"{"type":"custom","id":"x","timestamp":42}"#,
        // usage blocks ride the same typed lenient shape on both paths
        r#"{"type":"message","id":"u0","timestamp":"2026-09-23T00:00:00.000Z","message":{"role":"assistant","content":"u","usage":{"inputTokens":1,"cost":{"input":0.5}}}}"#,
    ];

    // Row-level differential: every borrowed span read equals the
    // full-parse `Value` read for every row the typed parse accepts. The
    // envelope scalars (`type`, `id`, `timestamp`, `parentId`) read from
    // `SessionEntry`'s typed fields (serde `flatten` keeps them out of
    // `fields`), the rest from the flattened map.
    for row in &rows {
        let typed: Option<SessionInfoEntry> = serde_json::from_str(row).ok();
        let full: Option<SessionEntry> = serde_json::from_str(row).ok();
        match (typed, full) {
            (Some(entry), Some(full)) => {
                let full_str = |field: &str| full.fields.get(field).and_then(Value::as_str);
                let message = full
                    .fields
                    .get("message")
                    .filter(|message| message.is_object());
                let message_str = |field: &str| {
                    message
                        .and_then(|message| message.get(field))
                        .and_then(Value::as_str)
                };
                let message_u64 = |field: &str| {
                    message
                        .and_then(|message| message.get(field))
                        .and_then(Value::as_u64)
                };
                assert_eq!(entry.type_.as_ref(), full.type_.as_str(), "type: {row}");
                assert_eq!(entry.id.as_ref(), full.id.as_str(), "id: {row}");
                assert_eq!(
                    entry._timestamp.as_ref(),
                    full.timestamp.as_str(),
                    "timestamp: {row}"
                );
                assert_eq!(
                    entry._parent_id.as_deref(),
                    full.parent_id.as_deref(),
                    "parentId: {row}"
                );
                assert_eq!(
                    raw_string(entry.name).as_deref(),
                    full_str("name"),
                    "name: {row}"
                );
                assert_eq!(
                    entry
                        .state
                        .and_then(|raw| serde_json::from_str::<Value>(raw.get()).ok()),
                    full.fields.get("state").cloned(),
                    "state: {row}"
                );
                assert_eq!(
                    raw_string(entry.provider).as_deref(),
                    full_str("provider"),
                    "provider: {row}"
                );
                assert_eq!(
                    raw_string(entry.model_id).as_deref(),
                    full_str("modelId"),
                    "modelId: {row}"
                );
                assert_eq!(
                    raw_string(entry.thinking_level).as_deref(),
                    full_str("thinkingLevel"),
                    "thinkingLevel: {row}"
                );
                assert_eq!(
                    entry.target_id.as_deref(),
                    full_str("targetId"),
                    "targetId: {row}"
                );
                if let Some(message) = &entry.message {
                    assert_eq!(
                        raw_string(message.role).as_deref(),
                        message_str("role"),
                        "role: {row}"
                    );
                    assert_eq!(
                        raw_string(message.provider).as_deref(),
                        message_str("provider"),
                        "m.provider: {row}"
                    );
                    assert_eq!(
                        raw_string(message.model).as_deref(),
                        message_str("model"),
                        "m.model: {row}"
                    );
                    assert_eq!(
                        raw_u64(message.timestamp),
                        message_u64("timestamp"),
                        "m.timestamp: {row}"
                    );
                }
            }
            // Both envelopes reject a non-string envelope scalar.
            (None, None) => {}
            // The borrowed struct rejects a non-object message or a
            // non-string targetId exactly as the owned struct did (the
            // row-level census over 177k real fixture lines pinned the
            // two acceptance sets identical); the lenient envelope sees
            // the shape the fold's arm would read as absent.
            (None, Some(full)) => {
                let rejected = ["targetId"].iter().any(|field| {
                    matches!(
                        full.fields.get(field),
                        Some(
                            Value::Bool(_) | Value::Number(_) | Value::Array(_) | Value::Object(_)
                        )
                    )
                }) || full
                    .fields
                    .get("message")
                    .is_some_and(|message| !message.is_object() && !message.is_null());
                assert!(rejected, "unexpected rejection: {row}");
            }
            (Some(_), None) => panic!("borrowed parse accepted what the envelope rejects: {row}"),
        }
    }

    // Fold-level differential: the accepted rows fold end to end and the
    // production fold matches the legacy full-parse reference.
    let header =
        json!({"type":"session","id":"s","timestamp":"2026-09-23T00:00:00.000Z","cwd":"/test"});
    let dir = test_dir();
    let path = dir.join("session.jsonl");
    append_rows(&path, std::slice::from_ref(&header));
    // The abort rows (15-17) would end the whole file's fold on both
    // paths (they get their own files below); the non-object message row
    // (32) is rejected by the typed parse on BOTH the owned and the
    // borrowed struct while the lenient reference counts it — a
    // pre-existing reference divergence outside this change's surface,
    // so it stays row-level only.
    for (index, row) in rows.iter().enumerate() {
        if matches!(index, 15..=17 | 32) {
            continue;
        }
        let Ok(value) = serde_json::from_str::<Value>(row) else {
            continue;
        };
        append_rows(&path, std::slice::from_ref(&value));
    }
    assert_fold_matches(&path);
    let info = read_session_info(&path).unwrap();
    assert_eq!(info.name.as_deref(), Some("trimmed"));
    assert_eq!(info.state.as_deref(), Some("archived"));
    assert_eq!(info.thinking_level.as_deref(), Some("high"));
    assert_eq!(
        info.model.as_ref(),
        Some(&("p".to_string(), "m".to_string()))
    );
    // every accepted message row counts, including the null-message and
    // the missing-message rows; both paths count exactly the typed-parse
    // accepted rows.
    assert_eq!(info.message_count, 12);
    assert_eq!(info.first_message, "ts float");
    assert!(info.all_messages_text.contains("escaped role matches"));
    assert_eq!(info.modified, crate::util::iso_from_unix_ms(456));

    // The abort rows kill the whole file's row on both paths.
    for aborting in [rows[15], rows[16], rows[17]] {
        let abort_dir = test_dir();
        let abort_path = abort_dir.join("session.jsonl");
        append_rows(
            &abort_path,
            &[
                header.clone(),
                serde_json::from_str::<Value>(aborting).unwrap(),
            ],
        );
        assert_eq!(read_session_info(&abort_path), None);
        assert_fold_matches(&abort_path);
        fs::remove_dir_all(abort_dir).unwrap();
    }

    fs::remove_dir_all(dir).unwrap();
}

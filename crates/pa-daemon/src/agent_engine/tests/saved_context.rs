//! The saved-context tests (the windowed reader vs the full-parse oracle).
use super::*;

/// The full-parse reference the differential oracle compares against.
fn full_parse_saved_session_context(
    path: &std::path::Path,
) -> Option<crate::engine::SavedSessionContext> {
    let store = crate::session_store::SessionFile::open(path).ok()?;
    let entries = store.branch_file_entries();
    let leaf = store.leaf_id().map(str::to_string);
    let context = pa_core::session::build_session_context(&entries, leaf.as_deref());
    let thinking = store
        .has_thinking_level()
        .then(|| pa_ai::models::thinking_level_from_str(&context.thinking_level))
        .flatten();
    Some(crate::engine::SavedSessionContext {
        model: context.model,
        thinking,
    })
}

fn assert_saved_context_equals_reference(name: &str, path: &std::path::Path) {
    let windowed = super::super::model::saved_session_context(path)
        .unwrap_or_else(|| panic!("{name}: the windowed reader must answer"));
    let reference = full_parse_saved_session_context(path)
        .unwrap_or_else(|| panic!("{name}: the reference reader must answer"));
    assert_eq!(
        windowed.model, reference.model,
        "{name}: the saved (provider, model) must match the full-parse reference"
    );
    assert_eq!(
        windowed.thinking, reference.thinking,
        "{name}: the saved thinking level must match the full-parse reference"
    );
}

/// A session builder for the oracle fixtures (hold the temp dir until the assertion).
fn oracle_session() -> (
    crate::session_store::SessionFile,
    std::path::PathBuf,
    tempfile::TempDir,
) {
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("session.jsonl");
    let mut file = crate::session_store::SessionFile::create("/tmp", None, 0);
    file.set_path(path.clone());
    (file, path, dir)
}

#[test]
fn saved_context_windowed_matches_full_parse_without_a_boundary() {
    let (mut file, path, _dir) = oracle_session();
    file.append_message(&json!({"role":"user","content":"hello","timestamp":0}));
    file.append_entry(
        "model_change",
        json!({"provider":"battery","modelId":"mock-1"}),
    );
    file.append_entry("thinking_level_change", json!({"thinkingLevel":"medium"}));
    file.append_message(&json!({
        "role":"assistant","provider":"battery","model":"mock-1","api":"openai-responses",
        "content":[{"type":"text","text":"hi"}],"stopReason":"stop","timestamp":1
    }));
    file.rewrite().unwrap();
    assert_saved_context_equals_reference("no-boundary session", &path);
}

#[test]
fn saved_context_windowed_matches_full_parse_with_changes_inside_the_window() {
    let (mut file, path, _dir) = oracle_session();
    let mut kept = String::new();
    for i in 0..12 {
        let id = file
            .append_message(&json!({"role":"user","content":format!("message {i}"),"timestamp":i}));
        if i == 4 {
            kept = id;
        }
    }
    file.append_entry(
        "compaction",
        json!({"summary":"summary","firstKeptEntryId":kept,"tokensBefore":1000}),
    );
    file.append_entry(
        "model_change",
        json!({"provider":"battery","modelId":"mock-1"}),
    );
    file.append_entry("thinking_level_change", json!({"thinkingLevel":"high"}));
    file.rewrite().unwrap();
    assert_saved_context_equals_reference("boundary, changes inside the window", &path);
}

#[test]
fn saved_context_windowed_matches_full_parse_with_model_only_before_the_boundary() {
    let (mut file, path, _dir) = oracle_session();
    file.append_entry(
        "model_change",
        json!({"provider":"battery","modelId":"mock-1"}),
    );
    let mut kept = String::new();
    for i in 0..12 {
        let id = file
            .append_message(&json!({"role":"user","content":format!("message {i}"),"timestamp":i}));
        if i == 4 {
            kept = id;
        }
    }
    file.append_entry(
        "compaction",
        json!({"summary":"summary","firstKeptEntryId":kept,"tokensBefore":1000}),
    );
    file.rewrite().unwrap();
    // The only model_change sits in the discarded prefix: the model overlay must supply the
    // reference's answer.
    assert_saved_context_equals_reference("boundary, model only before", &path);
}

#[test]
fn saved_context_windowed_matches_full_parse_with_thinking_only_before_the_boundary() {
    let (mut file, path, _dir) = oracle_session();
    file.append_entry("thinking_level_change", json!({"thinkingLevel":"low"}));
    let mut kept = String::new();
    for i in 0..12 {
        let id = file
            .append_message(&json!({"role":"user","content":format!("message {i}"),"timestamp":i}));
        if i == 4 {
            kept = id;
        }
    }
    file.append_entry(
        "compaction",
        json!({"summary":"summary","firstKeptEntryId":kept,"tokensBefore":1000}),
    );
    file.rewrite().unwrap();
    // The only thinking_level_change sits in the discarded prefix: the overlays must match the
    // reference.
    assert_saved_context_equals_reference("boundary, thinking only before", &path);
}

#[test]
fn saved_context_windowed_falls_back_to_the_full_open_on_a_malformed_retained_row() {
    let (mut file, path, _dir) = oracle_session();
    let mut kept = String::new();
    for i in 0..12 {
        let id = file
            .append_message(&json!({"role":"user","content":format!("message {i}"),"timestamp":i}));
        if i == 4 {
            kept = id;
        }
    }
    file.append_entry(
        "compaction",
        json!({"summary":"summary","firstKeptEntryId":kept,"tokensBefore":1000}),
    );
    file.append_entry(
        "model_change",
        json!({"provider":"battery","modelId":"mock-1"}),
    );
    file.rewrite().unwrap();
    // Corrupt one DISCARDED-PREFIX row: the walk must bail to the
    // full-open fallback, which still answers the reference exactly.
    let content = std::fs::read_to_string(&path).unwrap();
    let mut lines: Vec<&str> = content.lines().collect();
    assert!(lines.len() > 8, "fixture must hold a discardable prefix");
    lines[2] = "{not json}";
    std::fs::write(&path, lines.join("\n") + "\n").unwrap();
    assert_saved_context_equals_reference("malformed retained row fallback", &path);
}

#[test]
fn saved_context_from_the_open_store_matches_the_file_read_and_the_reference() {
    let (mut file, path, _dir) = oracle_session();
    file.append_entry(
        "model_change",
        json!({"provider":"battery","modelId":"mock-1"}),
    );
    let mut kept = String::new();
    for i in 0..12 {
        let id = file
            .append_message(&json!({"role":"user","content":format!("message {i}"),"timestamp":i}));
        if i == 4 {
            kept = id;
        }
    }
    file.append_entry(
        "compaction",
        json!({"summary":"summary","firstKeptEntryId":kept,"tokensBefore":1000}),
    );
    file.append_entry("thinking_level_change", json!({"thinkingLevel":"high"}));
    file.rewrite().unwrap();

    let store = crate::session_store::SessionFile::open_windowed(&path).unwrap();
    let from_store = super::super::model::saved_session_context_from_parts(
        &store.restored_settings(),
        store.has_thinking_level(),
    );
    let file_read = super::super::model::saved_session_context(&path)
        .unwrap_or_else(|| panic!("the file-read path must answer"));
    let reference = full_parse_saved_session_context(&path)
        .unwrap_or_else(|| panic!("the reference reader must answer"));
    assert_eq!(
        from_store, file_read,
        "the from-store reader is the file read"
    );
    assert_eq!(
        from_store.model, reference.model,
        "the from-store saved (provider, model) must match the reference"
    );
    assert_eq!(
        from_store.thinking, reference.thinking,
        "the from-store saved thinking level must match the reference"
    );
}

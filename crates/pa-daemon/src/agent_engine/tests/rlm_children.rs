//! The rlm-children tests (the persisted max-depth scan, the settled-child release probe).
use super::*;

/// The reference reader the depth scan replaced, verbatim: the whole-file
/// read plus a full `parse_session_entries` walk. The scan
/// (`model::persisted_rlm_max_depth`) must match it on every class.
fn persisted_rlm_max_depth_reference(path: Option<&str>) -> Option<u64> {
    let path = std::path::Path::new(path?);
    let content = std::fs::read_to_string(path).ok()?;
    crate::session_store::parse_session_entries(&content)
        .iter()
        .rev()
        .find_map(|entry| {
            (entry.get("type").and_then(serde_json::Value::as_str) == Some("custom")
                && entry.get("customType").and_then(serde_json::Value::as_str)
                    == Some("rlm_max_depth_state"))
            .then(|| {
                entry
                    .get("data")
                    .and_then(|data| data.get("maxDepth"))
                    .and_then(serde_json::Value::as_u64)
            })
            .flatten()
        })
}

fn depth_override_row(id: &str, depth: serde_json::Value) -> String {
    json!({
        "type": "custom",
        "id": id,
        "timestamp": "2026-01-01T00:00:02.000Z",
        "customType": "rlm_max_depth_state",
        "data": { "maxDepth": depth },
    })
    .to_string()
}

/// The depth scan matches the reference reader over every row class: the
/// common absent case, a present override (last and mid-file), a
/// non-`u64` bound that must not stop the scan, malformed lines, the
/// shape-loose row a typed store reader would skip (no `id`), the
/// transcript-text marker false-positive gate, CRLF lines, multi-byte
/// content, the invalid-UTF-8 file (both readers return `None`), and
/// the empty/missing/absent-path fallthroughs.
#[test]
fn persisted_rlm_max_depth_scan_matches_reference_across_classes() {
    let header = || {
        json!({
            "type": "session", "version": 3, "id": "s",
            "timestamp": "2026-01-01T00:00:00.000Z", "cwd": "/w",
        })
        .to_string()
    };
    let message = || {
        json!({
            "type": "message", "id": "m1", "timestamp": "2026-01-01T00:00:01.000Z",
            "message": { "role": "user", "content": "we ship rlm_max_depth_state fixes", "timestamp": 0 },
        })
        .to_string()
    };
    let unicode_message = || {
        json!({
            "type": "message", "id": "m1", "timestamp": "2026-01-01T00:00:01.000Z",
            "message": { "role": "user", "content": "emoji \u{1f69b}\u{1f69b} bytes across boundaries", "timestamp": 0 },
        })
        .to_string()
    };
    // The shape-loose row: parses as a raw `Value` (the reference's row
    // shape) but would fail the typed `SessionEntry` reader (no `id`) -
    // the scan must see it exactly like the reference does.
    let shape_loose = || {
        json!({
            "type": "custom",
            "timestamp": "2026-01-01T00:00:03.000Z",
            "customType": "rlm_max_depth_state",
            "data": { "maxDepth": 7 },
        })
        .to_string()
    };
    let malformed = || r#"{"type": "message", "id": "broken""#.to_string();
    let missing_bound_row = || {
        json!({
            "type": "custom", "id": "d2", "timestamp": "2026-01-01T00:00:04.000Z",
            "customType": "rlm_max_depth_state", "data": {},
        })
        .to_string()
    };
    let marker_text_row = || {
        json!({
            "type": "message", "id": "m2", "timestamp": "2026-01-01T00:00:02.000Z",
            "message": { "role": "assistant", "content": "rlm_max_depth_state", "timestamp": 0 },
        })
        .to_string()
    };

    let classes: Vec<(&str, String)> = [
        ("absent", [header(), message()].join("\n")),
        (
            "present_last",
            [header(), message(), depth_override_row("d1", json!(5))].join("\n"),
        ),
        (
            "present_mid",
            [
                header(),
                message(),
                depth_override_row("d1", json!(5)),
                message(),
            ]
            .join("\n"),
        ),
        // A newer row whose bound does not parse as u64 must not stop
        // the scan: the older valid row still wins (the reference's
        // `find_map` continues past it).
        (
            "non_u64_bound_continues",
            [
                header(),
                message(),
                depth_override_row("d1", json!(5)),
                depth_override_row("d2", json!("many")),
            ]
            .join("\n"),
        ),
        (
            "missing_bound_continues",
            [
                header(),
                message(),
                depth_override_row("d1", json!(5)),
                missing_bound_row(),
            ]
            .join("\n"),
        ),
        (
            "malformed_lines_skipped",
            [
                header(),
                malformed(),
                depth_override_row("d1", json!(9)),
                malformed(),
            ]
            .join("\n"),
        ),
        (
            "shape_loose_row_found",
            [header(), message(), shape_loose()].join("\n"),
        ),
        (
            "marker_text_not_a_row",
            [header(), message(), marker_text_row()].join("\n"),
        ),
        (
            "crlf_lines",
            [header(), message(), depth_override_row("d1", json!(11))].join("\r\n"),
        ),
        (
            "unicode_content_absent",
            [header(), unicode_message()].join("\n"),
        ),
        (
            "unicode_content_present",
            [
                header(),
                unicode_message(),
                depth_override_row("d1", json!(3)),
            ]
            .join("\n"),
        ),
        // The escaped-marker classes (the union gate's `\u` arm): a
        // row whose `customType` carries a JSON-escaped marker character
        // is exactly the reference's row after decoding — the scan must
        // honor it like the full-parse reference does — and an escaped
        // NON-marker must stay rejected (the `\u` arm widens the parse
        // set, never a match).
        (
            "escaped_customType_honored",
            [
                header(),
                message(),
                // Raw (never re-serialized): `\u0073` decodes to `s`.
                r#"{"type":"custom","id":"e1","timestamp":"2026-01-01T00:00:05.000Z","customType":"rlm_max_depth_\u0073tate","data":{"maxDepth":13}}"#
                    .to_string(),
            ]
            .join("\n"),
        ),
        (
            "escaped_non_marker_rejected",
            [
                header(),
                message(),
                // `\u0041` decodes to `A`: an escaped customType that is
                // NOT the marker — both readers return `None`.
                r#"{"type":"custom","id":"e2","timestamp":"2026-01-01T00:00:06.000Z","customType":"totally_other_\u0041type","data":{"maxDepth":13}}"#
                    .to_string(),
            ]
            .join("\n"),
        ),
        ("empty_file", String::new()),
    ]
    .into();
    for (name, content) in classes {
        let dir = tempfile::TempDir::new().unwrap();
        let path = dir.path().join("session.jsonl");
        let mut bytes = content.into_bytes();
        if !bytes.is_empty() {
            bytes.push(b'\n');
        }
        std::fs::write(&path, bytes).unwrap();
        let path_str = path.display().to_string();
        assert_eq!(
            model::persisted_rlm_max_depth(Some(&path_str)),
            persisted_rlm_max_depth_reference(Some(&path_str)),
            "depth class {name}"
        );
    }
    // An invalid UTF-8 byte anywhere voids the override for both
    // readers (the reference's whole-file `read_to_string` fails).
    {
        let dir = tempfile::TempDir::new().unwrap();
        let path = dir.path().join("session.jsonl");
        let mut bytes = format!(
            "{}\n{}\n{}\n",
            header(),
            message(),
            depth_override_row("d1", json!(5))
        )
        .into_bytes();
        bytes.push(0xff);
        bytes.push(b'\n');
        std::fs::write(&path, bytes).unwrap();
        let path_str = path.display().to_string();
        assert_eq!(
            model::persisted_rlm_max_depth(Some(&path_str)),
            persisted_rlm_max_depth_reference(Some(&path_str)),
            "depth class invalid_utf8"
        );
        assert!(
            model::persisted_rlm_max_depth(Some(&path_str)).is_none(),
            "invalid utf8 voids the override"
        );
    }
    // Missing file and absent path: the TS fallthrough keeps the
    // create-carried bound for both readers.
    assert_eq!(model::persisted_rlm_max_depth(None), None);
    assert_eq!(
        model::persisted_rlm_max_depth(None),
        persisted_rlm_max_depth_reference(None)
    );
    let missing = "/nonexistent-cold-open-residual/session.jsonl";
    assert_eq!(
        model::persisted_rlm_max_depth(Some(missing)),
        persisted_rlm_max_depth_reference(Some(missing))
    );
}

/// The settled-child kernel release policy (TS #2483's
/// `canPassivateSettledSession` gates, engine-side): with no
/// registered scheduled jobs the release probe fires; a jobs probe
/// reporting this session's jobs defers the release (the kernel
/// stays resident for the job's next run).
#[test]
fn release_settled_child_kernel_defers_to_scheduled_jobs_and_fires_the_release_probe() {
    let dir = tempfile::TempDir::new().unwrap();
    let engine = std::sync::Arc::new(bare_engine(dir.path()));
    let fired = std::sync::Arc::new(std::sync::atomic::AtomicUsize::new(0));
    let probe_fired = std::sync::Arc::clone(&fired);
    *engine
        .kernel_release_probe
        .lock()
        .expect("kernel release probe lock") = Some(std::sync::Arc::new(move || {
        probe_fired.fetch_add(1, std::sync::atomic::Ordering::SeqCst);
        Box::pin(std::future::ready(()))
    }));
    // No children (the bare engine wires none) and no jobs probe:
    // the release probe fires once.
    engine
        .runtime
        .block_on(crate::engine::SessionEngine::release_settled_child_kernel(
            &*engine,
        ));
    assert_eq!(fired.load(std::sync::atomic::Ordering::SeqCst), 1);
    // A jobs probe reporting this session's jobs defers the
    // release (the TS `hasRegisteredCronJob` gate).
    *engine
        .registered_jobs_probe
        .lock()
        .expect("registered jobs probe lock") = Some(std::sync::Arc::new(|| true));
    engine
        .runtime
        .block_on(crate::engine::SessionEngine::release_settled_child_kernel(
            &*engine,
        ));
    assert_eq!(fired.load(std::sync::atomic::Ordering::SeqCst), 1);
}

// ---------------------------------------------------------------------------
// saved_session_context differential oracle.
//
// The reader must return the same (provider, model) + thinking level as
// the full-parse reference below, fixture class by fixture class.
// ---------------------------------------------------------------------------

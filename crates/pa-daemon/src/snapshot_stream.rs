//! Chunked snapshot streaming on the client attach path.
//!
//! When a client advertises the `chunked_snapshot` capability, the attach
//! response omits the transcript and the snapshot travels as
//! `session_snapshot_begin` / `session_snapshot_chunk` /
//! `session_snapshot_end` records. Each chunk record is a self-contained
//! JSONL event whose `messages` array stays under a target byte budget; the
//! client reassembles the arrays in index order. A snapshot that fails after
//! the streamed response was produced surfaces as
//! `session_snapshot_failed` keyed by the same snapshot id.

use anyhow::{anyhow, Result};
use pa_types::daemon::SnapshotPurpose;
use serde_json::{json, Value};

/// Byte budget for one chunk's serialized `messages` array. Mirrors the
/// product default (`SNAPSHOT_TARGET_CHUNK_BYTES`).
pub(crate) const SNAPSHOT_TARGET_CHUNK_BYTES: usize = 512 * 1024;

/// Stream identity announced in the attach response and carried by every
/// snapshot event (`snapshotStream` on the wire).
#[derive(Debug, Clone)]
pub(crate) struct SnapshotStream {
    pub id: String,
    pub message_count: u64,
    pub target_chunk_bytes: u64,
}

/// The outbound records of one snapshot transfer.
#[derive(Debug)]
pub(crate) enum SnapshotStreamEvents {
    /// `session_snapshot_begin`, the chunk records, `session_snapshot_end`.
    Streamed(Vec<Value>),
    /// The transcript could not be transferred: `session_snapshot_failed`.
    Failed(Value),
}

impl SnapshotStreamEvents {
    pub fn lines(self) -> Vec<Value> {
        match self {
            SnapshotStreamEvents::Streamed(lines) => lines,
            SnapshotStreamEvents::Failed(line) => vec![line],
        }
    }
}

/// The client capability set for one attach command, normalized the way the
/// supervisor's `normalizeCapabilities` does: unsupported entries are
/// dropped, missing capabilities default to the standard pair, and
/// `supports_extension_ui` upgrades to `extension_ui`.
pub(crate) fn attach_client_capabilities(
    capabilities: Option<&[String]>,
    supports_extension_ui: Option<bool>,
) -> Vec<String> {
    let capabilities = capabilities.map_or_else(
        crate::protocol::default_client_capabilities,
        |caps: &[String]| caps.to_vec(),
    );
    let mut normalized = crate::protocol::normalize_client_capabilities(&capabilities);
    if supports_extension_ui.unwrap_or(false) && !normalized.iter().any(|cap| cap == "extension_ui")
    {
        normalized.push("extension_ui".to_string());
    }
    normalized
}

/// True when the client asked for chunked snapshot delivery.
pub(crate) fn wants_chunked(capabilities: &[String]) -> bool {
    capabilities.iter().any(|cap| cap == "chunked_snapshot")
}

/// Snapshot id: `<activeSessionId>-<generation>-<sequence>` derived from
/// the event cursor, so a regenerated snapshot never reuses an old id.
fn snapshot_stream_id(
    active_session_id: &str,
    generation: &str,
    last_event_sequence: u64,
) -> String {
    format!("{active_session_id}-{generation}-{last_event_sequence}")
}

/// Convert a worker attach result into its streamed form plus the snapshot
/// event records: the transcript leaves the response (`messages` arrays
/// emptied) and the response advertises the `snapshotStream` the events
/// carry.
///
/// `Err` means the worker response could not even identify a snapshot; the
/// attach itself fails before any record is produced.
/// [`SnapshotStreamEvents::Failed`] means the response was streamable but
/// the transcript could not be transferred; the caller sends the streamed
/// response followed by the failed record.
pub(crate) fn stream_attach(
    mut data: Value,
    active_session_id: &str,
    purpose: SnapshotPurpose,
) -> Result<(Value, SnapshotStreamEvents)> {
    let object = data
        .as_object_mut()
        .ok_or_else(|| anyhow!("Session worker did not provide a snapshot"))?;
    let last_event_sequence = object
        .get("lastEventSequence")
        .and_then(Value::as_u64)
        .ok_or_else(|| anyhow!("Session snapshot is missing its event sequence"))?;
    let generation = object
        .get("lastEventCursor")
        .and_then(|cursor| cursor.get("generation"))
        .and_then(Value::as_str)
        .ok_or_else(|| anyhow!("Session snapshot is missing its event cursor"))?
        .to_string();
    let snapshot = object
        .get_mut("snapshot")
        .and_then(Value::as_object_mut)
        .ok_or_else(|| anyhow!("Session worker did not provide a snapshot"))?;
    let message_count = snapshot
        .get("summary")
        .and_then(|summary| summary.get("messageCount"))
        .and_then(Value::as_u64)
        .ok_or_else(|| anyhow!("Session snapshot is missing its message count"))?;
    let stream = SnapshotStream {
        id: snapshot_stream_id(active_session_id, &generation, last_event_sequence),
        message_count,
        target_chunk_bytes: SNAPSHOT_TARGET_CHUNK_BYTES as u64,
    };
    // The transcript leaves the response; the snapshot header keeps an
    // empty `messages` array so the streamed shape matches the full one.
    let messages = snapshot.remove("messages").unwrap_or(Value::Null);
    snapshot.insert("messages".to_string(), Value::Array(Vec::new()));
    // Legacy (non-slim) attach results duplicate the transcript at the top
    // level; the streamed form drops the copy instead of shipping it empty.
    match object.get_mut("messages") {
        Some(Value::Array(_)) => {
            object.insert("messages".to_string(), Value::Array(Vec::new()));
        }
        Some(Value::Null) | None => {
            object.remove("messages");
        }
        Some(other) => {
            return Err(anyhow!(
                "Session attach result has a malformed messages payload: {}",
                json_type_name(other)
            ))
        }
    }
    object.insert(
        "snapshotStream".to_string(),
        json!({
            "id": stream.id,
            "messageCount": stream.message_count,
            "targetChunkBytes": stream.target_chunk_bytes,
        }),
    );
    let events = snapshot_event_lines(&messages, &stream, active_session_id, purpose, &data);
    Ok((data, events))
}

fn json_type_name(value: &Value) -> &'static str {
    match value {
        Value::Null => "null",
        Value::Bool(_) => "bool",
        Value::Number(_) => "number",
        Value::String(_) => "string",
        Value::Array(_) => "array",
        Value::Object(_) => "object",
    }
}

/// Split the transcript into chunk `messages` arrays under the byte budget.
/// A single message larger than the budget travels alone; messages are
/// never split.
fn chunk_messages(messages: &[Value], target_chunk_bytes: usize) -> Vec<Vec<Value>> {
    let mut chunks: Vec<Vec<Value>> = Vec::new();
    let mut current: Vec<Value> = Vec::new();
    let mut bytes = 0usize;
    for message in messages {
        let serialized = serde_json::to_string(message).unwrap_or_default();
        let cost = serialized.len() + usize::from(!current.is_empty());
        if !current.is_empty() && bytes + cost > target_chunk_bytes {
            chunks.push(std::mem::take(&mut current));
            bytes = 0;
        }
        bytes += cost;
        current.push(message.clone());
    }
    if !current.is_empty() {
        chunks.push(current);
    }
    chunks
}

/// Build the begin/chunk/end records (or the failed record) for a streamed
/// attach result. `messages` is the transcript the streamed response left
/// out; `data` is the already-streamed response (for the end record's
/// event cursor).
fn snapshot_event_lines(
    messages: &Value,
    stream: &SnapshotStream,
    active_session_id: &str,
    purpose: SnapshotPurpose,
    data: &Value,
) -> SnapshotStreamEvents {
    let messages = match messages {
        Value::Array(messages) => messages,
        Value::Null => {
            return SnapshotStreamEvents::Failed(failed_line(
                active_session_id,
                &stream.id,
                "Session worker did not provide a snapshot transcript",
            ))
        }
        other => {
            return SnapshotStreamEvents::Failed(failed_line(
                active_session_id,
                &stream.id,
                &format!(
                    "Session snapshot has a malformed messages payload: {}",
                    json_type_name(other)
                ),
            ))
        }
    };
    let snapshot_header = data.get("snapshot").cloned().unwrap_or_else(|| json!({}));
    let mut lines = vec![json!({
        "type": "session_snapshot_begin",
        "activeSessionId": active_session_id,
        "snapshotId": stream.id,
        "snapshot": snapshot_header,
        "messageCount": stream.message_count,
        "targetChunkBytes": stream.target_chunk_bytes,
        "purpose": purpose,
    })];
    let chunks = chunk_messages(messages, SNAPSHOT_TARGET_CHUNK_BYTES);
    for (index, chunk) in chunks.iter().enumerate() {
        lines.push(json!({
            "type": "session_snapshot_chunk",
            "activeSessionId": active_session_id,
            "snapshotId": stream.id,
            "index": index,
            "messages": chunk,
        }));
    }
    lines.push(json!({
        "type": "session_snapshot_end",
        "activeSessionId": active_session_id,
        "snapshotId": stream.id,
        "chunkCount": chunks.len(),
        "lastEventSequence": data
            .get("lastEventSequence")
            .cloned()
            .unwrap_or(Value::Null),
        "lastEventCursor": data.get("lastEventCursor").cloned().unwrap_or(Value::Null),
    }));
    SnapshotStreamEvents::Streamed(lines)
}

fn failed_line(active_session_id: &str, snapshot_id: &str, error: &str) -> Value {
    json!({
        "type": "session_snapshot_failed",
        "activeSessionId": active_session_id,
        "snapshotId": snapshot_id,
        "error": error,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    fn attach_result(messages: &[Value]) -> Value {
        json!({
            "protocol": { "name": "prime-agent.daemon", "version": 7 },
            "activeSessionId": "s1",
            "snapshot": {
                "activeSessionId": "s1",
                "summary": { "sessionId": "sid", "messageCount": messages.len() },
                "state": { "status": "idle" },
                "messages": messages,
                "lastEventSequence": 5,
                "lastEventCursor": { "generation": "g1", "sequence": 5 },
                "children": [],
            },
            "replay": { "status": "complete", "toSequence": 5 },
            "lastEventSequence": 5,
            "lastEventCursor": { "generation": "g1", "sequence": 5 },
            "client": { "id": "c1", "capabilities": ["attach_snapshot", "event_sequence", "slim_attach"] },
        })
    }

    fn message(index: usize) -> Value {
        json!({ "role": "user", "content": format!("message {index}"), "timestamp": index as u64 })
    }

    #[test]
    fn streamed_result_strips_the_transcript_and_adds_the_stream() {
        let data = attach_result(&[message(0), message(1)]);
        let (streamed, events) =
            stream_attach(data, "s1", SnapshotPurpose::Attach).expect("stream");
        let SnapshotStreamEvents::Streamed(lines) = events else {
            panic!("valid transcript must stream");
        };
        assert_eq!(lines.len(), 3, "one begin, one chunk, one end");
        assert_eq!(streamed["snapshot"]["messages"], json!([]));
        assert!(streamed.get("messages").is_none(), "slim result stays slim");
        let stream_id = streamed["snapshotStream"]["id"]
            .as_str()
            .unwrap()
            .to_string();
        assert_eq!(stream_id, "s1-g1-5");
        assert_eq!(streamed["snapshotStream"]["messageCount"], json!(2));
        assert_eq!(
            streamed["snapshotStream"]["targetChunkBytes"],
            json!(SNAPSHOT_TARGET_CHUNK_BYTES as u64)
        );
    }

    #[test]
    fn legacy_top_level_transcript_leaves_an_empty_copy() {
        let mut data = attach_result(&[message(0)]);
        data["messages"] = json!([message(0)]);
        data["state"] = json!({ "status": "idle" });
        let (streamed, events) =
            stream_attach(data, "s1", SnapshotPurpose::Attach).expect("stream");
        assert!(matches!(events, SnapshotStreamEvents::Streamed(_)));
        assert_eq!(streamed["messages"], json!([]));
    }

    #[test]
    fn headerless_worker_result_fails_the_attach() {
        let error = stream_attach(
            json!({
                "activeSessionId": "s1",
                "lastEventSequence": 5,
                "lastEventCursor": { "generation": "g1", "sequence": 5 },
            }),
            "s1",
            SnapshotPurpose::Attach,
        )
        .unwrap_err();
        assert_eq!(
            error.to_string(),
            "Session worker did not provide a snapshot"
        );
        let mut data = attach_result(&[]);
        data["snapshot"]["summary"]
            .as_object_mut()
            .unwrap()
            .remove("messageCount");
        assert!(stream_attach(data, "s1", SnapshotPurpose::Attach)
            .unwrap_err()
            .to_string()
            .contains("message count"));
        let mut data = attach_result(&[]);
        data.as_object_mut().unwrap().remove("lastEventCursor");
        data["snapshot"]
            .as_object_mut()
            .unwrap()
            .remove("lastEventCursor");
        assert!(stream_attach(data, "s1", SnapshotPurpose::Attach)
            .unwrap_err()
            .to_string()
            .contains("event cursor"));
    }

    #[test]
    fn event_lines_begin_chunk_end_reassemble_the_transcript() {
        let messages: Vec<Value> = (0..5).map(message).collect();
        let data = attach_result(&messages);
        let (streamed, events) =
            stream_attach(data, "s1", SnapshotPurpose::Replacement).expect("stream");
        let SnapshotStreamEvents::Streamed(lines) = events else {
            panic!("valid transcript must stream");
        };
        assert_eq!(lines.len(), 3, "one begin, one chunk, one end");
        assert_eq!(lines[0]["type"], "session_snapshot_begin");
        assert_eq!(lines[0]["purpose"], "replacement");
        assert_eq!(lines[0]["messageCount"], json!(5));
        assert_eq!(
            lines[0]["snapshot"]["summary"],
            streamed["snapshot"]["summary"]
        );
        assert_eq!(lines[0]["snapshot"]["messages"], json!([]));
        assert_eq!(lines[1]["type"], "session_snapshot_chunk");
        assert_eq!(lines[1]["index"], json!(0));
        assert_eq!(lines[1]["messages"], json!(messages));
        assert_eq!(lines[2]["type"], "session_snapshot_end");
        assert_eq!(lines[2]["chunkCount"], json!(1));
        assert_eq!(lines[2]["lastEventSequence"], json!(5));
        assert_eq!(
            lines[2]["lastEventCursor"],
            json!({ "generation": "g1", "sequence": 5 })
        );
        for line in &lines {
            assert_eq!(line["snapshotId"], streamed["snapshotStream"]["id"]);
            assert_eq!(line["activeSessionId"], json!("s1"));
        }
    }

    #[test]
    fn chunking_respects_the_byte_budget_and_never_splits_a_message() {
        let big = json!({ "role": "user", "content": "x".repeat(SNAPSHOT_TARGET_CHUNK_BYTES + 1) });
        let messages = vec![message(0), big.clone(), message(2), big.clone()];
        let chunks = chunk_messages(&messages, SNAPSHOT_TARGET_CHUNK_BYTES);
        assert_eq!(
            chunks,
            vec![
                vec![message(0)],
                vec![big.clone()],
                vec![message(2)],
                vec![big],
            ]
        );
        let messages: Vec<Value> = (0..100)
            .map(|i| json!({ "role": "user", "content": "y".repeat(1024), "timestamp": i }))
            .collect();
        let chunks = chunk_messages(&messages, SNAPSHOT_TARGET_CHUNK_BYTES);
        let reassembled: Vec<Value> = chunks.iter().flat_map(std::clone::Clone::clone).collect();
        assert_eq!(reassembled, messages, "index order reassembly is lossless");
        for chunk in &chunks {
            let bytes: usize = chunk
                .iter()
                .map(|m| serde_json::to_string(m).unwrap().len() + 1)
                .sum::<usize>()
                .saturating_sub(1);
            assert!(
                bytes <= SNAPSHOT_TARGET_CHUNK_BYTES || chunk.len() == 1,
                "chunk of {} messages over budget",
                chunk.len()
            );
        }
    }

    #[test]
    fn malformed_transcript_fails_the_transfer_after_the_response() {
        let mut data = attach_result(&[message(0)]);
        data["snapshot"]["messages"] = json!("not an array");
        let (_, events) = stream_attach(data, "s1", SnapshotPurpose::Attach).expect("streamable");
        let SnapshotStreamEvents::Failed(line) = events else {
            panic!("malformed transcript must fail the stream");
        };
        assert_eq!(line["type"], "session_snapshot_failed");
        assert_eq!(
            line["error"],
            "Session snapshot has a malformed messages payload: string"
        );

        let mut missing = attach_result(&[message(0)]);
        missing["snapshot"]
            .as_object_mut()
            .unwrap()
            .remove("messages");
        let (streamed, events) =
            stream_attach(missing, "s1", SnapshotPurpose::Attach).expect("streamable");
        let SnapshotStreamEvents::Failed(line) = events else {
            panic!("missing transcript must fail the stream");
        };
        assert_eq!(
            line["error"],
            "Session worker did not provide a snapshot transcript"
        );
        assert_eq!(line["snapshotId"], streamed["snapshotStream"]["id"]);
    }

    #[test]
    fn capabilities_normalize_like_the_supervisor() {
        let normalized =
            attach_client_capabilities(Some(&["chunked_snapshot".into(), "bogus".into()]), None);
        assert_eq!(normalized, vec!["chunked_snapshot".to_string()]);
        assert!(wants_chunked(&normalized));
        let defaults = attach_client_capabilities(None, None);
        assert_eq!(
            defaults,
            vec!["attach_snapshot".to_string(), "event_sequence".to_string()]
        );
        assert!(!wants_chunked(&defaults));
        let extension = attach_client_capabilities(None, Some(true));
        assert!(extension.contains(&"extension_ui".to_string()));
        let already = attach_client_capabilities(
            Some(&["extension_ui".into(), "attach_snapshot".into()]),
            Some(true),
        );
        assert_eq!(
            already,
            vec!["extension_ui".to_string(), "attach_snapshot".to_string()]
        );
    }
}

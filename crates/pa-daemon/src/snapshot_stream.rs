//! Chunked snapshot streaming on the client attach path: with the
//! `chunked_snapshot` capability the attach response omits the transcript,
//! which travels as `session_snapshot_begin`/`chunk`/`end` records — each
//! chunk's `messages` array stays under a byte budget. A failure after the
//! streamed response surfaces as `session_snapshot_failed`.

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

/// The client capability set for one attach command: unsupported entries
/// dropped, missing capabilities defaulted to the standard pair.
pub(crate) fn attach_client_capabilities(capabilities: Option<&[String]>) -> Vec<String> {
    let capabilities = capabilities.map_or_else(
        crate::protocol::default_client_capabilities,
        |caps: &[String]| caps.to_vec(),
    );
    crate::protocol::normalize_client_capabilities(&capabilities)
}

/// True when the client asked for chunked snapshot delivery.
pub(crate) fn wants_chunked(capabilities: &[String]) -> bool {
    capabilities.iter().any(|cap| cap == "chunked_snapshot")
}

/// True when the client asked for image payloads to leave the snapshot (`elide_snapshot_images`).
pub(crate) fn wants_image_elision(capabilities: &[String]) -> bool {
    capabilities
        .iter()
        .any(|cap| cap == "elide_snapshot_images")
}

/// The attach snapshot's image-payload elision: a `toolResult` image block
/// travels with its payload replaced by an empty string plus `elidedBytes` and
/// `widthPx`/`heightPx`. The transcript's image rows are fallback-only metadata
/// (TS mounts `Image` components with `fallbackOnly`), so an image-heavy session
/// stops shipping megabytes of base64 per attach; the store keeps the payload.
pub(crate) fn elide_snapshot_image_payloads(messages: &mut [Value]) {
    for message in messages.iter_mut() {
        if message.get("role").and_then(Value::as_str) != Some("toolResult") {
            continue;
        }
        let Some(content) = message.get_mut("content").and_then(Value::as_array_mut) else {
            continue;
        };
        for block in content.iter_mut() {
            let is_image = block.get("type").and_then(Value::as_str) == Some("image");
            // The immutable reads (payload length, the bounded-prefix dimension parse) end
            // here; the marker writes below borrow the block mutably.
            let (payload_chars, dimensions) = match (
                is_image,
                block.get("data").and_then(Value::as_str),
                block.get("mimeType").and_then(Value::as_str),
            ) {
                (true, Some(data), Some(mime)) if !data.is_empty() => (
                    data.len(),
                    pa_core::get_image_dimensions_prefix(
                        data,
                        mime,
                        pa_core::IMAGE_DIMENSIONS_PREFIX_BYTES,
                    ),
                ),
                _ => continue,
            };
            let Some(object) = block.as_object_mut() else {
                continue;
            };
            object.insert("elidedBytes".to_string(), json!(payload_chars));
            if let Some(dimensions) = dimensions {
                object.insert("widthPx".to_string(), json!(dimensions.width_px));
                object.insert("heightPx".to_string(), json!(dimensions.height_px));
            }
            object.insert("data".to_string(), json!(""));
        }
    }
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
/// event records (the transcript leaves the response). `Err` means the
/// response could not identify a snapshot; [`SnapshotStreamEvents::Failed`]
/// means the transcript could not be transferred — send the streamed
/// response, then the failed record.
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

/// Split the transcript into chunk `messages` arrays under the byte budget; a single
/// message larger than the budget travels alone, messages are never split.
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
/// attach result (the end record's event cursor comes from `data`).
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

    /// A tiny PNG header payload (base64 of the signature + IHDR with the given dimensions),
    /// built without a base64 dependency: the header bytes are all one-byte base64 triples.
    fn tiny_png(width: u32, height: u32) -> String {
        let mut bytes = vec![0x89, b'P', b'N', b'G'];
        bytes.extend(vec![0u8; 8]);
        bytes.extend(*b"IHDR");
        bytes.extend(width.to_be_bytes());
        bytes.extend(height.to_be_bytes());
        let table: &[u8; 64] = b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
        let mut out = String::new();
        for chunk in bytes.chunks(3) {
            let b0 = u32::from(chunk[0]);
            let b1 = u32::from(*chunk.get(1).unwrap_or(&0));
            let b2 = u32::from(*chunk.get(2).unwrap_or(&0));
            let triple = (b0 << 16) | (b1 << 8) | b2;
            out.push(table[(triple >> 18) as usize & 63] as char);
            out.push(table[(triple >> 12) as usize & 63] as char);
            out.push(table[(triple >> 6) as usize & 63] as char);
            out.push(table[triple as usize & 63] as char);
        }
        out
    }

    fn image_tool_result(payload: &str) -> Value {
        json!({
            "role": "toolResult",
            "toolCallId": "call-1",
            "toolName": "ipython",
            "content": [
                { "type": "text", "text": "Loaded 1 image(s) into context: /tmp/shot.png" },
                { "type": "image", "data": payload, "mimeType": "image/png" }
            ],
            "isError": false,
            "timestamp": 1
        })
    }

    #[test]
    fn elision_empties_image_payloads_and_keeps_their_metadata() {
        let payload = format!("{}{}", tiny_png(64, 32), "A".repeat(500_000));
        let mut messages = vec![
            json!({ "role": "user", "content": "hello", "timestamp": 0 }),
            image_tool_result(&payload),
            json!({
                "role": "assistant",
                "content": [ { "type": "text", "text": "done" } ],
                "timestamp": 2
            }),
        ];
        elide_snapshot_image_payloads(&mut messages);
        let block = &messages[1]["content"][1];
        assert_eq!(block["data"], json!(""));
        assert_eq!(block["elidedBytes"], json!(payload.len()));
        assert_eq!(block["widthPx"], json!(64));
        assert_eq!(block["heightPx"], json!(32));
        assert_eq!(block["mimeType"], json!("image/png"));
        // The other messages and the text block stay verbatim.
        assert_eq!(
            messages[0],
            json!({ "role": "user", "content": "hello", "timestamp": 0 })
        );
        assert_eq!(
            messages[1]["content"][0]["text"],
            json!("Loaded 1 image(s) into context: /tmp/shot.png")
        );
        assert_eq!(messages[2]["content"][0]["text"], json!("done"));
    }

    #[test]
    fn elision_marks_unparseable_headers_with_the_size_only() {
        // A payload whose dimensions do not parse from the bounded prefix carries the byte
        // count alone.
        let payload = "x".repeat(186_328);
        let mut messages = vec![image_tool_result(&payload)];
        elide_snapshot_image_payloads(&mut messages);
        let block = &messages[0]["content"][1];
        assert_eq!(block["data"], json!(""));
        assert_eq!(block["elidedBytes"], json!(186_328));
        assert!(block.get("widthPx").is_none());
    }

    #[test]
    fn elision_skips_empty_payloads_and_non_tool_results() {
        // A user message carrying an image block (the pasted-image wire) stays verbatim:
        // the elision targets tool-result payloads only.
        let pasted = json!({
            "role": "user",
            "content": [
                { "type": "text", "text": "look" },
                { "type": "image", "data": "QUJD", "mimeType": "image/png" }
            ],
            "timestamp": 0
        });
        let mut messages = vec![pasted.clone()];
        elide_snapshot_image_payloads(&mut messages);
        assert_eq!(messages[0], pasted);

        // An already-elided block (empty data) is left as-is.
        let mut elided = vec![image_tool_result("")];
        elide_snapshot_image_payloads(&mut elided);
        assert_eq!(elided[0]["content"][1]["data"], json!(""));
        assert!(elided[0]["content"][1].get("elidedBytes").is_none());
    }

    #[test]
    fn the_image_elision_capability_is_the_gate() {
        assert!(wants_image_elision(&[
            "attach_snapshot".to_string(),
            "elide_snapshot_images".to_string()
        ]));
        assert!(!wants_image_elision(&[
            "attach_snapshot".to_string(),
            "slim_attach".to_string()
        ]));
        assert!(!wants_image_elision(&[]));
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
            attach_client_capabilities(Some(&["chunked_snapshot".into(), "bogus".into()]));
        assert_eq!(normalized, vec!["chunked_snapshot".to_string()]);
        assert!(wants_chunked(&normalized));
        let defaults = attach_client_capabilities(None);
        assert_eq!(
            defaults,
            vec!["attach_snapshot".to_string(), "event_sequence".to_string()]
        );
        assert!(!wants_chunked(&defaults));
    }
}

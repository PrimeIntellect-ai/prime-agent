//! Wire types of the REPL runtime protocol (version 3).
//!
//! Requests are newline-delimited JSON objects written to the kernel's stdin;
//! events arrive as newline-delimited JSON objects on the runtime's private
//! protocol dup of fd 1. See `prime-agent-runtime/src/rlm/repl.md`.

use serde_json::{json, Value};

use crate::kernel::shared::parse_sent_agent_message;
use crate::kernel::shared::KernelSentAgentMessage;

/// Protocol version the manager speaks; the runtime announces its own in the
/// `ready` event and the handshake must match exactly.
pub const REPL_PROTOCOL_VERSION: u64 = 3;

/// One request frame.
#[derive(Debug, Clone)]
pub enum Request {
    Execute {
        code: String,
    },
    Interrupt,
    HostReply {
        data: Value,
    },
    Snapshot {
        path: String,
        manifest_path: String,
        max_bytes: u64,
        max_variable_bytes: u64,
        prune_oversized: bool,
    },
    Restore {
        path: String,
    },
    ListNames,
    McpStatus {
        servers: Vec<String>,
        timeout_ms: u64,
    },
    Shutdown,
}

impl Request {
    pub fn type_name(&self) -> &'static str {
        match self {
            Request::Execute { .. } => "execute",
            Request::Interrupt => "interrupt",
            Request::HostReply { .. } => "host_reply",
            Request::Snapshot { .. } => "snapshot",
            Request::Restore { .. } => "restore",
            Request::ListNames => "list_names",
            Request::McpStatus { .. } => "mcp_status",
            Request::Shutdown => "shutdown",
        }
    }

    pub fn to_json(&self) -> Value {
        match self {
            Request::Execute { code } => json!({ "type": "execute", "code": code }),
            Request::Interrupt => json!({ "type": "interrupt" }),
            Request::HostReply { data } => json!({ "type": "host_reply", "data": data }),
            Request::Snapshot {
                path,
                manifest_path,
                max_bytes,
                max_variable_bytes,
                prune_oversized,
            } => json!({
                "type": "snapshot",
                "path": path,
                "manifest_path": manifest_path,
                "max_bytes": max_bytes,
                "max_variable_bytes": max_variable_bytes,
                "prune_oversized": prune_oversized,
            }),
            Request::Restore { path } => json!({ "type": "restore", "path": path }),
            Request::ListNames => json!({ "type": "list_names" }),
            Request::McpStatus {
                servers,
                timeout_ms,
            } => json!({
                "type": "mcp_status",
                "servers": servers,
                "timeout_ms": timeout_ms,
            }),
            Request::Shutdown => json!({ "type": "shutdown" }),
        }
    }
}

/// One parsed event frame.
#[derive(Debug, Clone, PartialEq)]
pub enum Event {
    Ready {
        protocol: i64,
    },
    Stdout {
        id: Option<String>,
        text: String,
    },
    Stderr {
        id: Option<String>,
        text: String,
    },
    Result {
        id: String,
        text: String,
    },
    Display {
        id: Option<String>,
        data: Value,
    },
    HostRequest {
        id: String,
        data: Value,
    },
    Error {
        id: Option<String>,
        ename: String,
        evalue: String,
        traceback: Vec<String>,
    },
    Done {
        id: String,
        fields: Value,
    },
}

impl Event {
    pub fn kind(&self) -> &'static str {
        match self {
            Event::Ready { .. } => "ready",
            Event::Stdout { .. } => "stdout",
            Event::Stderr { .. } => "stderr",
            Event::Result { .. } => "result",
            Event::Display { .. } => "display",
            Event::HostRequest { .. } => "host_request",
            Event::Error { .. } => "error",
            Event::Done { .. } => "done",
        }
    }
}

/// Parse one protocol line into an event, or explain why the frame is invalid.
///
/// `done` and `host_request` route strictly by non-empty string id (the
/// runtime mints uuid hex ids and echoes the host's uuids); silently dropping
/// an id-less one would leave the awaiting request unsettled forever.
pub fn parse_event(line: &str) -> Result<Event, String> {
    let mut value: Value = serde_json::from_str(line)
        .map_err(|_| format!("unparseable protocol line: {}", clip(line)))?;
    // `display` and `host_request` carry bulk `data` payloads (attachments,
    // agent messages); move the field out of the parsed map instead of
    // deep-cloning it out of `value` below. Other kinds and non-object lines
    // keep `Null`, and a missing field parses exactly as before.
    let data = match value.as_object_mut() {
        Some(map) if matches!(
            map.get("event").and_then(Value::as_str),
            Some("display") | Some("host_request")
        ) => map.remove("data").unwrap_or(Value::Null),
        _ => Value::Null,
    };
    let obj = value
        .as_object()
        .ok_or_else(|| format!("non-object protocol line: {}", clip(line)))?;
    let kind = obj
        .get("event")
        .and_then(Value::as_str)
        .ok_or_else(|| format!("unknown protocol event: {}", clip(line)))?;
    let known = matches!(
        kind,
        "ready" | "stdout" | "stderr" | "result" | "display" | "host_request" | "error" | "done"
    );
    if !known {
        return Err(format!("unknown protocol event: {}", clip(line)));
    }
    let id =
        |key: &str| -> Option<String> { obj.get(key).and_then(Value::as_str).map(str::to_string) };
    match kind {
        "ready" => Ok(Event::Ready {
            protocol: obj.get("protocol").and_then(Value::as_i64).unwrap_or(-1),
        }),
        "stdout" | "stderr" => {
            let id = id("id");
            let text = obj
                .get("text")
                .and_then(Value::as_str)
                .unwrap_or_default()
                .to_string();
            Ok(if kind == "stdout" {
                Event::Stdout { id, text }
            } else {
                Event::Stderr { id, text }
            })
        }
        "result" => {
            let id = id("id").ok_or_else(|| format!("result frame without id: {}", clip(line)))?;
            let text = obj
                .get("text")
                .and_then(Value::as_str)
                .unwrap_or_default()
                .to_string();
            Ok(Event::Result { id, text })
        }
        "display" => Ok(Event::Display {
            id: id("id"),
            data,
        }),
        "host_request" => {
            let rid =
                id("id").ok_or_else(|| format!("host_request frame without id: {}", clip(line)))?;
            Ok(Event::HostRequest { id: rid, data })
        }
        "error" => Ok(Event::Error {
            id: id("id"),
            ename: obj
                .get("ename")
                .and_then(Value::as_str)
                .unwrap_or("Error")
                .to_string(),
            evalue: obj
                .get("evalue")
                .and_then(Value::as_str)
                .unwrap_or_default()
                .to_string(),
            traceback: obj
                .get("traceback")
                .and_then(Value::as_array)
                .map(|a| {
                    a.iter()
                        .filter_map(Value::as_str)
                        .map(str::to_string)
                        .collect()
                })
                .unwrap_or_default(),
        }),
        "done" => {
            let id = id("id").ok_or_else(|| format!("done frame without id: {}", clip(line)))?;
            Ok(Event::Done { id, fields: value })
        }
        _ => unreachable!("kind validated above"),
    }
}

fn clip(line: &str) -> &str {
    match line.char_indices().nth(200).map(|(i, _)| i) {
        Some(i) => &line[..i],
        None => line,
    }
}

/// A late agent-message display payload observed outside its owning cell.
pub fn late_sent_agent_message(id: Option<&str>, data: &Value) -> Option<KernelSentAgentMessage> {
    let payload = data.get(crate::kernel::shared::AGENT_MESSAGE_DISPLAY_MIME)?;
    let message = parse_sent_agent_message(payload)?;
    id?;
    Some(message)
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn parses_ready() {
        let e = parse_event(r#"{"event":"ready","protocol":3,"python":"3.11.16"}"#).unwrap();
        match e {
            Event::Ready { protocol } => assert_eq!(protocol, 3),
            other => panic!("{other:?}"),
        }
    }

    #[test]
    fn done_without_id_is_invalid() {
        assert!(parse_event(r#"{"event":"done","status":"ok"}"#).is_err());
    }

    #[test]
    fn host_request_requires_id() {
        assert!(parse_event(r#"{"event":"host_request","data":{}}"#).is_err());
    }

    #[test]
    fn unknown_kind_is_invalid() {
        assert!(parse_event(r#"{"event":"mystery"}"#).is_err());
        assert!(parse_event("not json").is_err());
        assert!(parse_event("[1,2,3]").is_err());
    }

    #[test]
    fn parses_done_with_fields() {
        let e =
            parse_event(r#"{"event":"done","id":"abc","status":"ok","saved":["x"],"bytes":12}"#)
                .unwrap();
        match e {
            Event::Done { id, fields } => {
                assert_eq!(id, "abc");
                assert_eq!(fields["saved"][0], "x");
            }
            other => panic!("{other:?}"),
        }
    }

    #[test]
    fn request_json_round_trip() {
        let req = Request::Snapshot {
            path: "/tmp/s.dill".into(),
            manifest_path: "/tmp/s.json".into(),
            max_bytes: 1,
            max_variable_bytes: 2,
            prune_oversized: true,
        };
        let v = req.to_json();
        assert_eq!(v["type"], "snapshot");
        assert_eq!(v["prune_oversized"], true);
    }

    #[test]
    fn late_sent_agent_message_needs_id() {
        let data = json!({ crate::kernel::shared::AGENT_MESSAGE_DISPLAY_MIME: json!({
            "id": "m1", "message": "hi", "deliveryStatus": "delivered",
            "target": {"activeSessionId": "a", "sessionId": "s"}
        })});
        assert!(late_sent_agent_message(Some("cell1"), &data).is_some());
        assert!(late_sent_agent_message(None, &data).is_none());
    }

    #[test]
    fn parses_every_event_kind_verbatim() {
        assert_eq!(
            parse_event(r#"{"event":"ready","protocol":3,"python":"3.13.11"}"#).unwrap(),
            Event::Ready { protocol: 3 }
        );
        assert_eq!(
            parse_event(r#"{"event":"ready"}"#).unwrap(),
            Event::Ready { protocol: -1 }
        );
        assert_eq!(
            parse_event(r#"{"event":"stdout","id":"c1","text":"out"}"#).unwrap(),
            Event::Stdout { id: Some("c1".into()), text: "out".into() }
        );
        assert_eq!(
            parse_event(r#"{"event":"stdout","id":null,"text":"raw 🌸"}"#).unwrap(),
            Event::Stdout { id: None, text: "raw 🌸".into() }
        );
        assert_eq!(
            parse_event(r#"{"event":"stderr","text":"err"}"#).unwrap(),
            Event::Stderr { id: None, text: "err".into() }
        );
        assert_eq!(
            parse_event(r#"{"event":"stderr","id":"c1","text":null}"#).unwrap(),
            Event::Stderr { id: Some("c1".into()), text: String::new() }
        );
        assert_eq!(
            parse_event(r#"{"event":"result","id":"c1","text":"42"}"#).unwrap(),
            Event::Result { id: "c1".into(), text: "42".into() }
        );
        assert_eq!(
            parse_event(
                r#"{"event":"error","id":"c1","ename":"KeyboardInterrupt","evalue":"in cell","traceback":["a","b"]}"#
            )
            .unwrap(),
            Event::Error {
                id: Some("c1".into()),
                ename: "KeyboardInterrupt".into(),
                evalue: "in cell".into(),
                traceback: vec!["a".into(), "b".into()],
            }
        );
        assert_eq!(
            parse_event(r#"{"event":"error"}"#).unwrap(),
            Event::Error {
                id: None,
                ename: "Error".into(),
                evalue: String::new(),
                traceback: Vec::new(),
            }
        );
        assert_eq!(
            parse_event(r#"{"event":"done","id":"c1","status":"ok","saved":["x"],"bytes":12}"#)
                .unwrap(),
            Event::Done {
                id: "c1".into(),
                fields: json!({"event":"done","id":"c1","status":"ok","saved":["x"],"bytes":12}),
            }
        );
        // Only display/host_request move `data` out; a done frame keeps it in fields.
        assert_eq!(
            parse_event(r#"{"event":"done","id":"c1","status":"ok","data":{"keep":1}}"#).unwrap(),
            Event::Done {
                id: "c1".into(),
                fields: json!({"event":"done","id":"c1","status":"ok","data":{"keep":1}}),
            }
        );
    }

    #[test]
    fn display_and_host_request_data_move_verbatim() {
        // Every `data` shape parses to the same event the deep-clone produced:
        // missing, null, scalar, array, number, object.
        assert_eq!(
            parse_event(r#"{"event":"display","id":"c1"}"#).unwrap(),
            Event::Display { id: Some("c1".into()), data: Value::Null }
        );
        assert_eq!(
            parse_event(r#"{"event":"display","id":"c1","data":null}"#).unwrap(),
            Event::Display { id: Some("c1".into()), data: Value::Null }
        );
        assert_eq!(
            parse_event(r#"{"event":"display","id":null,"data":"scalar"}"#).unwrap(),
            Event::Display { id: None, data: json!("scalar") }
        );
        assert_eq!(
            parse_event(r#"{"event":"display","id":null,"data":[1,2,3]}"#).unwrap(),
            Event::Display { id: None, data: json!([1, 2, 3]) }
        );
        assert_eq!(
            parse_event(r#"{"event":"display","id":null,"data":123}"#).unwrap(),
            Event::Display { id: None, data: json!(123) }
        );
        assert_eq!(
            parse_event(r#"{"event":"host_request","id":"hr1"}"#).unwrap(),
            Event::HostRequest { id: "hr1".into(), data: Value::Null }
        );
        assert_eq!(
            parse_event(
                r#"{"event":"host_request","id":"hr1","data":{"reason":"agent_message.send"}}"#
            )
            .unwrap(),
            Event::HostRequest {
                id: "hr1".into(),
                data: json!({"reason": "agent_message.send"}),
            }
        );
    }

    #[test]
    fn moved_data_serializes_byte_identically() {
        // The payload is moved out of the parsed map, not rebuilt; key order
        // (serde_json preserve_order, matching the TS byte stream) survives.
        let event = parse_event(
            r#"{"event":"display","id":"c1","data":{"application/vnd.prime-agent.attachment+json":{"name":"a.png","data":"aGk="}}}"#,
        )
        .unwrap();
        let Event::Display { data, .. } = &event else {
            panic!("display frame parsed to {event:?}");
        };
        assert_eq!(
            serde_json::to_string(data).unwrap(),
            r#"{"application/vnd.prime-agent.attachment+json":{"name":"a.png","data":"aGk="}}"#
        );
        let event = parse_event(
            r#"{"event":"host_request","id":"hr1","data":{"reason":"agent_message.send","target":{"activeSessionId":"a","sessionId":"s"}}}"#,
        )
        .unwrap();
        let Event::HostRequest { data, .. } = &event else {
            panic!("host_request frame parsed to {event:?}");
        };
        assert_eq!(
            serde_json::to_string(data).unwrap(),
            r#"{"reason":"agent_message.send","target":{"activeSessionId":"a","sessionId":"s"}}"#
        );
    }

    #[test]
    fn invalid_frames_report_exact_reasons() {
        assert_eq!(
            parse_event("not json").unwrap_err(),
            "unparseable protocol line: not json"
        );
        assert_eq!(
            parse_event("[1,2,3]").unwrap_err(),
            "non-object protocol line: [1,2,3]"
        );
        assert_eq!(
            parse_event(r#"{"event":"mystery"}"#).unwrap_err(),
            r#"unknown protocol event: {"event":"mystery"}"#
        );
        assert_eq!(
            parse_event(r#"{"event":"result"}"#).unwrap_err(),
            r#"result frame without id: {"event":"result"}"#
        );
        assert_eq!(
            parse_event(r#"{"event":"host_request","data":{}}"#).unwrap_err(),
            r#"host_request frame without id: {"event":"host_request","data":{}}"#
        );
        assert_eq!(
            parse_event(r#"{"event":"done","status":"ok"}"#).unwrap_err(),
            r#"done frame without id: {"event":"done","status":"ok"}"#
        );
    }

    /// TS wire parity (`packages/coding-agent/src/core/kernel/repl-manager.ts`,
    /// `invalidProtocolFrameReason`): `done` and `host_request` are the only
    /// kinds the TS manager rejects for id shape, and both products reject the
    /// same corpus of id-less frames below. Rust keeps its pre-existing
    /// stricter rule for `result` ids (the runtime always sends one).
    #[test]
    fn id_requirements_match_the_ts_manager() {
        // Rejected by both: done/host_request without a string id.
        assert!(parse_event(r#"{"event":"done","status":"ok"}"#).is_err());
        assert!(parse_event(r#"{"event":"host_request","data":{}}"#).is_err());
        assert!(parse_event(r#"{"event":"host_request","id":null,"data":{}}"#).is_err());
        // Accepted by both: display with a null id (user threads emit id null)
        // and no-id stream kinds.
        assert!(parse_event(r#"{"event":"display","id":null,"data":{}}"#).is_ok());
        assert!(parse_event(r#"{"event":"stdout","text":"x"}"#).is_ok());
        assert!(parse_event(r#"{"event":"error","evalue":"x"}"#).is_ok());
    }

    /// Timed fixture for the bulk `data` payloads of `display`/`host_request`
    /// frames at 1 KiB / 1 MiB / 10 MiB. Run with
    /// `cargo test -p pa-core --release -- kernel::protocol --ignored --nocapture`.
    #[test]
    #[ignore = "timing fixture; run with --release --ignored --nocapture"]
    fn parse_event_data_frame_timing() {
        use std::hint::black_box;
        use std::time::Instant;

        fn display_frame(data_bytes: usize) -> String {
            json!({
                "event": "display",
                "id": "cell-1",
                "data": {
                    crate::kernel::shared::ATTACHMENT_DISPLAY_MIME: {
                        "name": "bench.png",
                        "data": "A".repeat(data_bytes),
                    }
                }
            })
            .to_string()
        }

        fn host_request_frame(entries: usize) -> String {
            json!({
                "event": "host_request",
                "id": "hr-1",
                "data": {
                    "reason": "bench",
                    "items": (0..entries)
                        .map(|i| json!({ "name": format!("entry-{i}"), "text": "x".repeat(48), "n": i }))
                        .collect::<Vec<_>>(),
                }
            })
            .to_string()
        }

        for (target, label, iters) in [
            (1024_usize, "1 KiB", 200_000_u32),
            (1024 * 1024, "1 MiB", 2_000),
            (10 * 1024 * 1024, "10 MiB", 200),
        ] {
            let display = display_frame(target.saturating_sub(120));
            let host = host_request_frame(((target - 60) / 85).max(1));
            for (kind, frame) in [("display", display.as_str()), ("host_request", host.as_str())] {
                assert_eq!(parse_event(frame).expect("valid fixture frame").kind(), kind);
                for _ in 0..(iters / 20).max(1) {
                    let _ = black_box(parse_event(black_box(frame)));
                }
                let start = Instant::now();
                for _ in 0..iters {
                    let _ = black_box(parse_event(black_box(frame)));
                }
                let elapsed = start.elapsed();
                let per_frame = elapsed / iters;
                let throughput =
                    frame.len() as f64 * iters as f64 / elapsed.as_secs_f64() / (1024.0 * 1024.0);
                println!(
                    "{label} {kind:>12} frame={frame_len:>9} bytes iters={iters:>6} per-frame={per_frame_us:>12.1} µs throughput={throughput:8.1} MiB/s",
                    frame_len = frame.len(),
                    per_frame_us = per_frame.as_secs_f64() * 1e6,
                );
            }
        }
    }
}

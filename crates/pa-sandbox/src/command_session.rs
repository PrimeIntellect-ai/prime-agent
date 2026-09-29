//! The sandbox `command_session` service message codec: request
//! validation and encoding, and strict decoding of the
//! `StartResponse`/`ConnectResponse` event envelope. Port of the message
//! half of `command-session-proto.ts` (TS branch
//! `feat/direct-cloud-sandbox`); the wire primitives and the Connect
//! frame envelope live in [`crate::proto`].
//!
//! Authoritative shape: `command_session.proto` in
//! `platform/sandbox/vm-sandboxes/packages/sandboxd/spec` (the sandboxd
//! guest service). Only the messages the gateway client needs are
//! implemented: `StartRequest`, `ConnectRequest`, `UpdateRequest`,
//! `SendInputRequest`, `SendSignalRequest`, and the
//! `StartResponse`/`ConnectResponse` event envelope.
//!
//! Why hand-rolled instead of generated: the workspace declares no
//! protobuf codegen dependency, and the `command_session` surface is
//! small and stable, so a strict codec keeps this slice dependency-free
//! and fully testable (the TS module made the same call).
//!
//! Strictness contract (TS parity):
//! - decoders reject malformed or truncated input instead of defaulting;
//! - encoders reject invalid requests (non-UUID idempotency keys, empty
//!   commands, out-of-range sizes) before any bytes reach the network;
//! - strings must be valid UTF-8; bools must be exactly 0 or 1; oneof
//!   members may not repeat; unknown fields are skipped per proto3
//!   rules;
//! - the frame decoder refuses frames larger than its bound so a hostile
//!   or buggy peer cannot force unbounded buffering.
//!
//! Reviewed deviations: the TS decoder also rejects varints above
//! JavaScript's safe-integer range (a JS number-model concern Rust does
//! not share — [`u64`] covers the whole proto range), and the
//! `CommandSpec.envs` map is encoded in `BTreeMap` order (sorted keys)
//! rather than TS insertion order — protobuf map entries are unordered,
//! so the wire contract is identical for any entry set.

use std::collections::BTreeMap;

use crate::proto::{
    canonical_uuid_key, require_nul_free_string, ProtoError, Reader, Writer, WIRE_LEN, WIRE_VARINT,
};

/// The signals the `CommandSession` service delivers; values are the
/// proto enum values (TS `VM_SIGNALS`).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum VmSignal {
    /// SIGTERM (proto value 15).
    Terminate,
    /// SIGKILL (proto value 9).
    Kill,
}

impl VmSignal {
    /// The proto enum value.
    #[must_use]
    pub fn value(self) -> u64 {
        match self {
            Self::Terminate => 15,
            Self::Kill => 9,
        }
    }
}

/// A command to run, without a shell (proto `CommandSpec`).
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct CommandSpec {
    /// Executable path or name; non-empty, NUL-free.
    pub cmd: String,
    /// Arguments passed verbatim; NUL-free strings.
    pub args: Vec<String>,
    /// Environment overrides applied over the sandbox default.
    pub envs: BTreeMap<String, String>,
    /// Working directory; `None` inherits the sandbox default.
    pub cwd: Option<String>,
}

/// PTY window size (proto `PTY.Size`).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct PtySize {
    /// Columns; 1..=65535 (sandboxd casts to `winsize` cols).
    pub cols: u16,
    /// Rows; 1..=65535 (sandboxd casts to `winsize` rows).
    pub rows: u16,
}

/// Input write target channel (proto `CommandInput` oneof).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum InputChannel {
    /// Write to the process stdin pipe.
    Stdin,
    /// Write to the process PTY.
    Pty,
}

/// Raw Start request; `session_uuid` is the create-or-attach idempotency
/// key (TS `StartRequest`).
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct StartRequest {
    /// The command to start.
    pub command: CommandSpec,
    /// Initial PTY size; presence starts the command under a PTY.
    pub pty: Option<PtySize>,
    /// Whether the process gets a real stdin pipe. Explicit on the wire:
    /// sandboxd treats an absent field as `true`, so a resident daemon
    /// that wants no stdin must encode `false`, not omit it.
    pub stdin: bool,
    /// Caller-supplied create-or-attach key. Re-issuing the identical
    /// request attaches to the session instead of spawning a second
    /// process; a different spec under the same key fails with
    /// `failed_precondition`.
    pub session_uuid: String,
}

/// One decoded output channel of a data event.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum OutputChannel {
    /// The process stdout pipe.
    Stdout,
    /// The process stderr pipe.
    Stderr,
    /// The process PTY.
    Pty,
}

/// End event: the terminal record, replayed for sessions retained after
/// exit. Every field of the deployed end event is optional (the platform
/// omits the ones it does not know); the event itself is the terminal
/// signal, `exited` defaults true, and missing details stay `None` (TS
/// `CommandSessionEndEvent`).
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct EndEvent {
    /// Process exit code when the platform reports one.
    pub exit_code: Option<i32>,
    /// True when the session ended by process exit; true unless the
    /// platform says otherwise.
    pub exited: bool,
    /// Platform status token when provided.
    pub status: Option<String>,
    /// Platform error text when provided.
    pub error: Option<String>,
}

/// One decoded `CommandSessionEvent` (the `StartResponse` or
/// `ConnectResponse` envelope member).
#[derive(Debug, Clone, PartialEq)]
pub enum CommandSessionEvent {
    /// The process's PID, re-announced on every (re)attach.
    Start {
        /// The guest process id.
        pid: u32,
    },
    /// Output bytes tagged by channel.
    Data {
        /// The channel the bytes came from.
        channel: OutputChannel,
        /// The output bytes.
        data: Vec<u8>,
    },
    /// The terminal record (see [`EndEvent`]).
    End(EndEvent),
    /// Transport liveness ping; carries no process state.
    Keepalive,
}

// ---------------------------------------------------------------------------
// Request validation and encoding
// ---------------------------------------------------------------------------

fn encode_command_spec(writer: &mut Writer, command: &CommandSpec) -> Result<(), ProtoError> {
    require_nul_free_string(&command.cmd, "command.cmd")?;
    for arg in &command.args {
        if arg.contains('\0') {
            return Err(ProtoError::invalid_input(
                "command.args must be an array of NUL-free strings",
            ));
        }
    }
    writer.string_field(1, &command.cmd);
    for arg in &command.args {
        writer.string_field(2, arg);
    }
    for (key, value) in &command.envs {
        if key.is_empty() || key.contains('\0') || key.contains('=') {
            return Err(ProtoError::invalid_input(format!(
                "command.envs key {key:?} must be non-empty and free of NUL and \"=\""
            )));
        }
        if value.contains('\0') {
            return Err(ProtoError::invalid_input(format!(
                "command.envs[{key}] must be a NUL-free string"
            )));
        }
        // map<string, string> entries are nested messages: field 1 key,
        // field 2 value.
        writer.message_field(3, |entry| {
            entry.string_field(1, key);
            entry.string_field(2, value);
            Ok(())
        })?;
    }
    if let Some(cwd) = command.cwd.as_deref() {
        require_nul_free_string(cwd, "command.cwd")?;
        writer.string_field(4, cwd);
    }
    Ok(())
}

fn encode_selector(writer: &mut Writer, session_uuid: &str) -> Result<(), ProtoError> {
    let canonical = canonical_uuid_key(session_uuid, "sessionUuid")?;
    // pid (field 1) is never used by this client; session_uuid is field 3.
    writer.string_field(3, &canonical);
    Ok(())
}

fn encode_pty_size(writer: &mut Writer, size: PtySize, field: &str) -> Result<(), ProtoError> {
    if size.cols < 1 || size.rows < 1 {
        return Err(ProtoError::invalid_input(format!(
            "{field} cols and rows must be integers 1..65535"
        )));
    }
    // PTY { size { cols = 1, rows = 2 } }
    writer.message_field(1, |size_writer| {
        size_writer.varint_field(1, u64::from(size.cols));
        size_writer.varint_field(2, u64::from(size.rows));
        Ok(())
    })?;
    Ok(())
}

/// Encode a `StartRequest`. Field 3 is reserved on the wire; stdin is
/// field 4 and always carries explicit presence because sandboxd
/// defaults an absent field to true.
///
/// # Errors
///
/// Returns [`ProtoErrorKind::InvalidInput`] on invalid values.
pub fn encode_start_request(request: &StartRequest) -> Result<Vec<u8>, ProtoError> {
    let session_uuid = canonical_uuid_key(&request.session_uuid, "sessionUuid")?;
    let mut writer = Writer::default();
    writer.message_field(1, |spec| encode_command_spec(spec, &request.command))?;
    if let Some(pty) = request.pty {
        writer.message_field(2, |pty_writer| encode_pty_size(pty_writer, pty, "pty"))?;
    }
    writer.bool_field(4, request.stdin);
    writer.string_field(5, &session_uuid);
    Ok(writer.finish())
}

/// Encode a `ConnectRequest` selecting a session by its UUID.
///
/// # Errors
///
/// Returns [`ProtoErrorKind::InvalidInput`] for a non-UUID key.
pub fn encode_connect_request(session_uuid: &str) -> Result<Vec<u8>, ProtoError> {
    let mut writer = Writer::default();
    writer.message_field(1, |selector| encode_selector(selector, session_uuid))?;
    Ok(writer.finish())
}

/// Encode an `UpdateRequest` resizing a session's PTY.
///
/// # Errors
///
/// Returns [`ProtoErrorKind::InvalidInput`] for a non-UUID key or an
/// out-of-range size.
pub fn encode_update_request(session_uuid: &str, size: PtySize) -> Result<Vec<u8>, ProtoError> {
    let mut writer = Writer::default();
    writer.message_field(1, |selector| encode_selector(selector, session_uuid))?;
    writer.message_field(2, |pty| encode_pty_size(pty, size, "pty"))?;
    Ok(writer.finish())
}

/// Encode a `SendInputRequest` writing `data` to the session's stdin or
/// PTY.
///
/// # Errors
///
/// Returns [`ProtoErrorKind::InvalidInput`] for a non-UUID key.
pub fn encode_send_input_request(
    session_uuid: &str,
    channel: InputChannel,
    data: &[u8],
    input_uuid: &str,
) -> Result<Vec<u8>, ProtoError> {
    let input_uuid = canonical_uuid_key(input_uuid, "inputUuid")?;
    let mut writer = Writer::default();
    writer.message_field(1, |selector| encode_selector(selector, session_uuid))?;
    writer.message_field(2, |input| {
        // CommandInput oneof: stdin = 1 (bytes), pty = 2 (bytes).
        let field = match channel {
            InputChannel::Stdin => 1,
            InputChannel::Pty => 2,
        };
        input.bytes_field(field, data);
        Ok(())
    })?;
    writer.string_field(3, &input_uuid);
    Ok(writer.finish())
}

/// Encode a `SendSignalRequest` delivering SIGTERM (`terminate`) or
/// SIGKILL (`kill`).
///
/// # Errors
///
/// Returns [`ProtoErrorKind::InvalidInput`] for a non-UUID key.
pub fn encode_send_signal_request(
    session_uuid: &str,
    signal: VmSignal,
    signal_uuid: &str,
) -> Result<Vec<u8>, ProtoError> {
    let signal_uuid = canonical_uuid_key(signal_uuid, "signalUuid")?;
    let mut writer = Writer::default();
    writer.message_field(1, |selector| encode_selector(selector, session_uuid))?;
    writer.varint_field(2, signal.value());
    writer.string_field(3, &signal_uuid);
    Ok(writer.finish())
}

// ---------------------------------------------------------------------------
// Response decoding: the shared CommandSessionEvent envelope
// ---------------------------------------------------------------------------

/// Decode one event envelope member.
fn decode_event(reader: &mut Reader<'_>, context: &str) -> Result<CommandSessionEvent, ProtoError> {
    let mut start: Option<u32> = None;
    let mut data: Option<(OutputChannel, Vec<u8>)> = None;
    let mut end: Option<EndEvent> = None;
    let mut keepalive = false;
    while !reader.is_eof() {
        let (field, wire) = reader.tag(context)?;
        if wire != WIRE_LEN {
            return Err(ProtoError::invalid_wire(format!(
                "{context}: event members must be length-delimited"
            )));
        }
        match field {
            1 if start.is_none() => {
                let body = reader.bytes(context)?;
                let mut nested = Reader::new(body);
                start = Some(decode_start_event(
                    &mut nested,
                    &format!("{context}.StartEvent"),
                )?);
            }
            2 if data.is_none() => {
                let body = reader.bytes(context)?;
                let mut nested = Reader::new(body);
                data = Some(decode_data_event(
                    &mut nested,
                    &format!("{context}.DataEvent"),
                )?);
            }
            3 if end.is_none() => {
                let body = reader.bytes(context)?;
                let mut nested = Reader::new(body);
                end = Some(decode_end_event(
                    &mut nested,
                    &format!("{context}.EndEvent"),
                )?);
            }
            4 if !keepalive => {
                let body = reader.bytes(context)?;
                if !body.is_empty() {
                    return Err(ProtoError::invalid_wire(format!(
                        "{context}: keepalive body must be empty"
                    )));
                }
                keepalive = true;
            }
            1..=4 => {
                return Err(ProtoError::invalid_wire(format!(
                    "{context}: duplicate oneof member {field}"
                )));
            }
            _ => reader.skip(wire, &format!("{context}.event.{field}"))?,
        }
    }
    let members = usize::from(start.is_some())
        + usize::from(data.is_some())
        + usize::from(end.is_some())
        + usize::from(keepalive);
    if members != 1 {
        return Err(ProtoError::invalid_wire(format!(
            "{context}: expected exactly one event member, got {members}"
        )));
    }
    if let Some(pid) = start {
        return Ok(CommandSessionEvent::Start { pid });
    }
    if let Some((channel, data)) = data {
        return Ok(CommandSessionEvent::Data { channel, data });
    }
    if let Some(end) = end {
        return Ok(CommandSessionEvent::End(end));
    }
    Ok(CommandSessionEvent::Keepalive)
}

fn decode_start_event(reader: &mut Reader<'_>, context: &str) -> Result<u32, ProtoError> {
    let mut pid = 0u32;
    while !reader.is_eof() {
        let (field, wire) = reader.tag(context)?;
        if field == 1 {
            if wire != WIRE_VARINT {
                return Err(ProtoError::invalid_wire(format!(
                    "{context}: pid must be a varint"
                )));
            }
            pid = reader.uint32(&format!("{context}.pid"))?;
        } else {
            reader.skip(wire, &format!("{context}.{field}"))?;
        }
    }
    Ok(pid)
}

fn decode_data_event(
    reader: &mut Reader<'_>,
    context: &str,
) -> Result<(OutputChannel, Vec<u8>), ProtoError> {
    let mut stdout: Option<Vec<u8>> = None;
    let mut stderr: Option<Vec<u8>> = None;
    let mut pty: Option<Vec<u8>> = None;
    while !reader.is_eof() {
        let (field, wire) = reader.tag(context)?;
        if wire != WIRE_LEN {
            return Err(ProtoError::invalid_wire(format!(
                "{context}: output members must be length-delimited"
            )));
        }
        let slot = match field {
            1 => &mut stdout,
            2 => &mut stderr,
            3 => &mut pty,
            _ => {
                reader.skip(wire, &format!("{context}.{field}"))?;
                continue;
            }
        };
        if slot.is_some() {
            return Err(ProtoError::invalid_wire(format!(
                "{context}: duplicate oneof member {field}"
            )));
        }
        *slot = Some(reader.bytes(context)?.to_vec());
    }
    match (stdout, stderr, pty) {
        (Some(data), None, None) => Ok((OutputChannel::Stdout, data)),
        (None, Some(data), None) => Ok((OutputChannel::Stderr, data)),
        (None, None, Some(data)) => Ok((OutputChannel::Pty, data)),
        _ => Err(ProtoError::invalid_wire(format!(
            "{context}: expected exactly one output member"
        ))),
    }
}

fn decode_end_event(reader: &mut Reader<'_>, context: &str) -> Result<EndEvent, ProtoError> {
    let mut exit_code = None;
    let mut exited = None;
    let mut status = None;
    let mut error = None;
    while !reader.is_eof() {
        let (field, wire) = reader.tag(context)?;
        match field {
            1 => {
                if wire != WIRE_VARINT {
                    return Err(ProtoError::invalid_wire(format!(
                        "{context}: exit_code must be a varint"
                    )));
                }
                exit_code = Some(reader.sint32(&format!("{context}.exit_code"))?);
            }
            2 => {
                if wire != WIRE_VARINT {
                    return Err(ProtoError::invalid_wire(format!(
                        "{context}: exited must be a varint"
                    )));
                }
                exited = Some(reader.boolean(&format!("{context}.exited"))?);
            }
            3 => {
                if wire != WIRE_LEN {
                    return Err(ProtoError::invalid_wire(format!(
                        "{context}: status must be length-delimited"
                    )));
                }
                status = Some(reader.string(&format!("{context}.status"))?.to_string());
            }
            4 => {
                if wire != WIRE_LEN {
                    return Err(ProtoError::invalid_wire(format!(
                        "{context}: error must be length-delimited"
                    )));
                }
                error = Some(reader.string(&format!("{context}.error"))?.to_string());
            }
            _ => reader.skip(wire, &format!("{context}.{field}"))?,
        }
    }
    // Tolerant by necessity: the deployed end event is valid with any
    // subset of its fields, so nothing here is required. An end event
    // always means the session is no longer running, hence the defaulted
    // `exited` (TS parity).
    Ok(EndEvent {
        exit_code,
        exited: exited.unwrap_or(true),
        status,
        error,
    })
}

/// Decode a `StartResponse` or `ConnectResponse` body (they share the
/// same single `event` field). Returns `Ok(None)` when the response
/// carries no event, which the stream consumer must skip.
///
/// # Errors
///
/// Returns [`ProtoErrorKind::InvalidWire`] on malformed input.
pub fn decode_command_session_event_response(
    body: &[u8],
    context: &str,
) -> Result<Option<CommandSessionEvent>, ProtoError> {
    let mut reader = Reader::new(body);
    let mut event = None;
    while !reader.is_eof() {
        let (field, wire) = reader.tag(context)?;
        match field {
            1 => {
                if wire != WIRE_LEN {
                    return Err(ProtoError::invalid_wire(format!(
                        "{context}: event must be length-delimited"
                    )));
                }
                if event.is_some() {
                    return Err(ProtoError::invalid_wire(format!(
                        "{context}: duplicate event field"
                    )));
                }
                let body = reader.bytes(context)?;
                let mut nested = Reader::new(body);
                event = Some(decode_event(
                    &mut nested,
                    &format!("{context}.CommandSessionEvent"),
                )?);
            }
            _ => reader.skip(wire, &format!("{context}.{field}"))?,
        }
    }
    Ok(event)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::proto::ProtoErrorKind;

    const UUID: &str = "0198c0de-9a1b-4d3e-8f2a-5c6b7d8e9f01";

    #[test]
    fn start_requests_encode_the_ts_wire_shape() {
        let mut envs = BTreeMap::new();
        envs.insert("KEY".to_string(), "val".to_string());
        let request = StartRequest {
            command: CommandSpec {
                cmd: "echo".to_string(),
                args: vec!["hi".to_string()],
                envs,
                cwd: Some("/tmp".to_string()),
            },
            pty: Some(PtySize {
                cols: 100,
                rows: 30,
            }),
            stdin: false,
            session_uuid: UUID.to_string(),
        };
        let bytes = encode_start_request(&request).unwrap();
        // CommandSpec: cmd (1), args (2), envs map entry (3), cwd (4).
        let spec = [
            0x0a, 0x04, b'e', b'c', b'h', b'o', // cmd = "echo"
            0x12, 0x02, b'h', b'i', // args = ["hi"]
            0x1a, 0x0a, // envs entry (10 bytes)
            0x0a, 0x03, b'K', b'E', b'Y', // key = "KEY"
            0x12, 0x03, b'v', b'a', b'l', // value = "val"
            0x22, 0x04, b'/', b't', b'm', b'p', // cwd = "/tmp"
        ];
        // PTY: size { cols (1) = 100, rows (2) = 30 }; stdin (4) = false;
        // session_uuid (5) = the canonical UUID.
        let spec_len = u8::try_from(spec.len()).expect("spec length fits a byte");
        let expected = [
            &[0x0a, spec_len][..],
            &spec[..],
            &[
                0x12, 0x06, // pty (6 bytes)
                0x0a, 0x04, // size
                0x08, 100, // cols
                0x10, 30, // rows
                0x20, 0x00, // stdin = false
            ][..],
            &[
                0x2a, 36, // session_uuid
            ][..],
            UUID.as_bytes(),
        ]
        .concat();
        assert_eq!(bytes, expected);
    }

    #[test]
    fn connect_requests_select_by_session_uuid() {
        let bytes = encode_connect_request(UUID).unwrap();
        let expected = [
            &[
                0x0a, 38, // selector
                0x1a, 36, // session_uuid
            ][..],
            UUID.as_bytes(),
        ]
        .concat();
        assert_eq!(bytes, expected);
    }

    #[test]
    fn send_input_requests_encode_the_oneof_channel() {
        let bytes = encode_send_input_request(UUID, InputChannel::Stdin, b"zz", UUID).unwrap();
        let expected = [
            &[
                0x0a, 38, // selector
                0x1a, 36, // session_uuid
            ][..],
            UUID.as_bytes(),
            &[
                0x12, 0x04, // input (4 bytes)
                0x0a, 0x02, b'z', b'z', // stdin = "zz"
                0x1a, 36, // input_uuid
            ][..],
            UUID.as_bytes(),
        ]
        .concat();
        assert_eq!(bytes, expected);
        // The pty channel uses the other oneof member.
        let bytes = encode_send_input_request(UUID, InputChannel::Pty, b"zz", UUID).unwrap();
        assert_eq!(bytes[38 + 2 + 2], 0x12);
    }

    #[test]
    fn send_signal_requests_carry_the_proto_signal_values() {
        let bytes = encode_send_signal_request(UUID, VmSignal::Terminate, UUID).unwrap();
        let expected = [
            &[
                0x0a, 38, // selector
                0x1a, 36, // session_uuid
            ][..],
            UUID.as_bytes(),
            &[
                0x10, 15, // signal = terminate
                0x1a, 36, // signal_uuid
            ][..],
            UUID.as_bytes(),
        ]
        .concat();
        assert_eq!(bytes, expected);
        assert_eq!(VmSignal::Kill.value(), 9);
    }

    #[test]
    fn update_requests_resize_the_pty() {
        let bytes = encode_update_request(UUID, PtySize { cols: 1, rows: 2 }).unwrap();
        let expected = [
            &[
                0x0a, 38, // selector
                0x1a, 36, // session_uuid
            ][..],
            UUID.as_bytes(),
            &[
                0x12, 0x06, // pty (6 bytes)
                0x0a, 0x04, // size
                0x08, 0x01, // cols
                0x10, 0x02, // rows
            ][..],
        ]
        .concat();
        assert_eq!(bytes, expected);
    }

    #[test]
    fn invalid_requests_fail_before_encoding() {
        let spec = CommandSpec {
            cmd: String::new(),
            args: Vec::new(),
            envs: BTreeMap::new(),
            cwd: None,
        };
        let request = StartRequest {
            command: spec,
            pty: None,
            stdin: true,
            session_uuid: UUID.to_string(),
        };
        assert_eq!(
            encode_start_request(&request).unwrap_err().kind(),
            ProtoErrorKind::InvalidInput
        );
        let request = StartRequest {
            command: CommandSpec {
                cmd: "a\0b".to_string(),
                args: Vec::new(),
                envs: BTreeMap::new(),
                cwd: None,
            },
            pty: None,
            stdin: true,
            session_uuid: UUID.to_string(),
        };
        assert_eq!(
            encode_start_request(&request).unwrap_err().kind(),
            ProtoErrorKind::InvalidInput
        );
        let request = StartRequest {
            command: CommandSpec {
                cmd: "echo".to_string(),
                args: vec![],
                envs: BTreeMap::new(),
                cwd: None,
            },
            pty: Some(PtySize { cols: 0, rows: 30 }),
            stdin: true,
            session_uuid: UUID.to_string(),
        };
        assert_eq!(
            encode_start_request(&request).unwrap_err().kind(),
            ProtoErrorKind::InvalidInput
        );
        let mut envs = BTreeMap::new();
        envs.insert("A=B".to_string(), "v".to_string());
        let request = StartRequest {
            command: CommandSpec {
                cmd: "echo".to_string(),
                args: vec![],
                envs,
                cwd: None,
            },
            pty: None,
            stdin: true,
            session_uuid: UUID.to_string(),
        };
        assert_eq!(
            encode_start_request(&request).unwrap_err().kind(),
            ProtoErrorKind::InvalidInput
        );
        assert!(encode_connect_request("nope").is_err());
        assert!(encode_update_request(UUID, PtySize { cols: 1, rows: 0 }).is_err());
    }

    /// Wrap one `CommandSessionEvent` oneof member (start = 1, data = 2,
    /// end = 3, keepalive = 4) into a StartResponse/ConnectResponse body.
    fn response_body(member: u32, event_bytes: &[u8]) -> Vec<u8> {
        let mut event = Writer::default();
        event.bytes_field(member, event_bytes);
        let event = event.finish();
        let mut response = Writer::default();
        response.bytes_field(1, &event);
        response.finish()
    }

    #[test]
    fn event_responses_decode_strictly() {
        // start { pid = 4242 }
        let start_event = [0x08, 0x92, 0x21];
        let body = response_body(1, &start_event);
        let event = decode_command_session_event_response(&body, "StartResponse")
            .unwrap()
            .unwrap();
        assert_eq!(event, CommandSessionEvent::Start { pid: 4242 });
        // An empty envelope decodes to no event.
        assert!(decode_command_session_event_response(&[], "StartResponse")
            .unwrap()
            .is_none());
        // A start member carrying no pid defaults to 0.
        let body = response_body(1, &[]);
        let event = decode_command_session_event_response(&body, "StartResponse")
            .unwrap()
            .unwrap();
        assert_eq!(event, CommandSessionEvent::Start { pid: 0 });
        // An event member on a non-LEN wire is invalid.
        let bad_event = [0x0a];
        let body = response_body(1, &bad_event);
        assert!(decode_command_session_event_response(&body, "StartResponse").is_err());
        // Two members in one event envelope is invalid.
        let mut event = Writer::default();
        event.bytes_field(1, &start_event);
        event.bytes_field(4, &[]);
        let both = event.finish();
        let mut response = Writer::default();
        response.bytes_field(1, &both);
        assert!(
            decode_command_session_event_response(&response.finish(), "StartResponse").is_err()
        );
        // Keepalive must be empty.
        let body = response_body(4, b"x");
        assert!(decode_command_session_event_response(&body, "StartResponse").is_err());
        // The event field must not repeat.
        let mut response = Writer::default();
        response.bytes_field(1, &both);
        response.bytes_field(1, &both);
        assert!(
            decode_command_session_event_response(&response.finish(), "StartResponse").is_err()
        );
    }

    #[test]
    fn data_events_require_exactly_one_channel() {
        for (member, channel, tag) in [
            (1u8, OutputChannel::Stdout, 0x0au8),
            (2, OutputChannel::Stderr, 0x12),
            (3, OutputChannel::Pty, 0x1a),
        ] {
            let data_event = [tag, 0x01, member];
            let body = response_body(2, &data_event);
            let event = decode_command_session_event_response(&body, "StartResponse")
                .unwrap()
                .unwrap();
            assert_eq!(
                event,
                CommandSessionEvent::Data {
                    channel,
                    data: vec![member]
                }
            );
        }
        // Two channels in one data event is invalid.
        let mut data_event = Writer::default();
        data_event.bytes_field(1, b"a");
        data_event.bytes_field(2, b"b");
        let data_event = data_event.finish();
        let body = response_body(2, &data_event);
        assert!(decode_command_session_event_response(&body, "StartResponse").is_err());
    }

    #[test]
    fn end_events_default_exited_and_decode_zigzag_exit_codes() {
        // exit_code = -1 (sint32 zigzag 1), exited = true, status, error.
        let mut end_event = Writer::default();
        end_event.varint_field(1, 1);
        end_event.bool_field(2, true);
        end_event.string_field(3, "done");
        end_event.string_field(4, "killed");
        let end_event = end_event.finish();
        let body = response_body(3, &end_event);
        let decoded = decode_command_session_event_response(&body, "StartResponse")
            .unwrap()
            .unwrap();
        assert_eq!(
            decoded,
            CommandSessionEvent::End(EndEvent {
                exit_code: Some(-1),
                exited: true,
                status: Some("done".to_string()),
                error: Some("killed".to_string()),
            })
        );
        // The deployed end event can carry a subset (even nothing).
        let body = response_body(3, &[]);
        let decoded = decode_command_session_event_response(&body, "StartResponse")
            .unwrap()
            .unwrap();
        assert_eq!(
            decoded,
            CommandSessionEvent::End(EndEvent {
                exit_code: None,
                exited: true,
                status: None,
                error: None,
            })
        );
        // A non-UTF-8 status string is invalid.
        let mut end_event = Writer::default();
        end_event.bytes_field(3, &[0xff, 0xfe]);
        let body = response_body(3, &end_event.finish());
        assert!(decode_command_session_event_response(&body, "x").is_err());
    }

    #[test]
    fn malformed_wire_is_rejected() {
        // Truncated length-delimited field.
        let truncated = [0x0a, 0x10, b'a'];
        assert!(decode_command_session_event_response(&truncated, "x").is_err());
        // A bool that is not 0 or 1.
        let mut end_event = Writer::default();
        end_event.varint_field(2, 2);
        let body = response_body(3, &end_event.finish());
        assert!(decode_command_session_event_response(&body, "x").is_err());
        // Field number 0.
        assert!(decode_command_session_event_response(&[0x00], "x").is_err());
        // An unsupported wire type (group start).
        assert!(decode_command_session_event_response(&[0x0b], "x").is_err());
    }
}

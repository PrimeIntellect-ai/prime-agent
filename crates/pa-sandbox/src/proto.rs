//! Wire primitives for the sandbox `command_session` client: the strict
//! protobuf varint/length-delimited reader and writer, the canonical
//! UUID idempotency-key parser, and the Connect protocol frame envelope
//! its streaming RPCs use. Port of the primitives half of
//! `command-session-proto.ts` (TS branch `feat/direct-cloud-sandbox`).
//!
//! Strictness contract (TS parity):
//! - decoders reject malformed or truncated input instead of defaulting;
//! - strings must be valid UTF-8; bools must be exactly 0 or 1; unknown
//!   fields are skipped per proto3 rules;
//! - the frame decoder refuses frames larger than its bound so a hostile
//!   or buggy peer cannot force unbounded buffering.
//!
//! Reviewed deviations: the TS decoder also rejects varints above
//! JavaScript's safe-integer range (a JS number-model concern Rust does
//! not share — [`u64`] covers the whole proto range).

use thiserror::Error;

/// A codec-level failure kind: a bad request value
/// ([`ProtoErrorKind::InvalidInput`]), malformed wire bytes
/// ([`ProtoErrorKind::InvalidWire`]), or a frame over the decoder's
/// bound ([`ProtoErrorKind::OversizeFrame`]).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Error)]
pub enum ProtoErrorKind {
    /// A caller-supplied value failed local validation.
    #[error("invalid_input")]
    InvalidInput,
    /// The peer sent malformed wire bytes.
    #[error("invalid_wire")]
    InvalidWire,
    /// A Connect streaming frame exceeded the decoder's bound.
    #[error("oversize_frame")]
    OversizeFrame,
}

/// Codec-level error: a bad request value, malformed wire bytes, or an
/// oversize frame.
#[derive(Debug, Error)]
#[error("{message}")]
pub struct ProtoError {
    kind: ProtoErrorKind,
    message: String,
}

impl ProtoError {
    /// A local validation failure.
    #[must_use]
    pub fn invalid_input(message: impl Into<String>) -> Self {
        Self::new(ProtoErrorKind::InvalidInput, message)
    }

    /// A wire-decoding failure.
    #[must_use]
    pub fn invalid_wire(message: impl Into<String>) -> Self {
        Self::new(ProtoErrorKind::InvalidWire, message)
    }

    /// A frame over the decoder's bound.
    #[must_use]
    pub fn oversize_frame(message: impl Into<String>) -> Self {
        Self::new(ProtoErrorKind::OversizeFrame, message)
    }

    fn new(kind: ProtoErrorKind, message: impl Into<String>) -> Self {
        Self {
            kind,
            message: message.into(),
        }
    }

    /// The failure kind.
    #[must_use]
    pub fn kind(&self) -> ProtoErrorKind {
        self.kind
    }
}

/// Varint wire type.
pub(crate) const WIRE_VARINT: u32 = 0;
/// 64-bit wire type.
pub(crate) const WIRE_64BIT: u32 = 1;
/// Length-delimited wire type.
pub(crate) const WIRE_LEN: u32 = 2;
/// 32-bit wire type.
pub(crate) const WIRE_32BIT: u32 = 5;

/// A varint longer than 10 bytes is not canonical proto.
const MAX_VARINT_BYTES: usize = 10;

/// The strict protobuf writer. All values are plain Rust types, so
/// encoding cannot fail; validation happens before encoding starts.
#[derive(Debug, Default)]
pub(crate) struct Writer {
    pub(crate) buf: Vec<u8>,
}

impl Writer {
    // Varint encoding truncates each byte to its low 7 bits by design.
    #[allow(clippy::cast_possible_truncation)]
    pub(crate) fn varint(&mut self, mut value: u64) {
        while value >= 0x80 {
            self.buf.push((value as u8) | 0x80);
            value >>= 7;
        }
        self.buf.push(value as u8);
    }

    pub(crate) fn tag(&mut self, field: u32, wire: u32) {
        self.varint((u64::from(field) << 3) | u64::from(wire));
    }

    pub(crate) fn bytes_field(&mut self, field: u32, value: &[u8]) {
        self.tag(field, WIRE_LEN);
        self.varint(value.len() as u64);
        self.buf.extend_from_slice(value);
    }

    pub(crate) fn string_field(&mut self, field: u32, value: &str) {
        self.bytes_field(field, value.as_bytes());
    }

    pub(crate) fn bool_field(&mut self, field: u32, value: bool) {
        self.tag(field, WIRE_VARINT);
        self.varint(u64::from(value));
    }

    pub(crate) fn varint_field(&mut self, field: u32, value: u64) {
        self.tag(field, WIRE_VARINT);
        self.varint(value);
    }

    /// Encode a nested message field by writing it into a sub-writer;
    /// the writer's validation failures propagate.
    pub(crate) fn message_field(
        &mut self,
        field: u32,
        write: impl FnOnce(&mut Writer) -> Result<(), ProtoError>,
    ) -> Result<(), ProtoError> {
        let mut sub = Writer::default();
        write(&mut sub)?;
        self.bytes_field(field, &sub.buf);
        Ok(())
    }

    pub(crate) fn finish(self) -> Vec<u8> {
        self.buf
    }
}

/// The strict protobuf reader over borrowed bytes.
pub(crate) struct Reader<'a> {
    pub(crate) data: &'a [u8],
    pub(crate) pos: usize,
}

impl<'a> Reader<'a> {
    pub(crate) fn new(data: &'a [u8]) -> Self {
        Self { data, pos: 0 }
    }

    pub(crate) fn is_eof(&self) -> bool {
        self.pos >= self.data.len()
    }

    pub(crate) fn varint(&mut self, context: &str) -> Result<u64, ProtoError> {
        let mut value = 0u64;
        let mut shift = 0u32;
        for _ in 1..=MAX_VARINT_BYTES {
            let Some(byte) = self.data.get(self.pos) else {
                return Err(ProtoError::invalid_wire(format!(
                    "{context}: truncated varint"
                )));
            };
            self.pos += 1;
            value |= u64::from(*byte & 0x7f) << shift;
            if *byte & 0x80 == 0 {
                return Ok(value);
            }
            shift += 7;
            if shift >= 64 {
                return Err(ProtoError::invalid_wire(format!(
                    "{context}: varint exceeds 10 bytes"
                )));
            }
        }
        Err(ProtoError::invalid_wire(format!(
            "{context}: varint exceeds 10 bytes"
        )))
    }

    pub(crate) fn tag(&mut self, context: &str) -> Result<(u32, u32), ProtoError> {
        let raw = self.varint(context)?;
        let field = u32::try_from(raw >> 3)
            .map_err(|_| ProtoError::invalid_wire(format!("{context}: field number overflows")))?;
        #[allow(clippy::cast_possible_truncation)]
        let wire = (raw & 0x7) as u32;
        if field == 0 {
            return Err(ProtoError::invalid_wire(format!(
                "{context}: field number 0 is invalid"
            )));
        }
        Ok((field, wire))
    }

    /// Read a length-delimited field body as a borrowed slice.
    pub(crate) fn bytes(&mut self, context: &str) -> Result<&'a [u8], ProtoError> {
        let length = self.varint(context)?;
        let length = usize::try_from(length).map_err(|_| {
            ProtoError::invalid_wire(format!("{context}: length overflows the address space"))
        })?;
        let start = self.pos;
        let end = start.checked_add(length).ok_or_else(|| {
            ProtoError::invalid_wire(format!("{context}: length overflows the address space"))
        })?;
        if end > self.data.len() {
            return Err(ProtoError::invalid_wire(format!(
                "{context}: truncated length-delimited field"
            )));
        }
        self.pos = end;
        Ok(&self.data[start..end])
    }

    pub(crate) fn string(&mut self, context: &str) -> Result<&'a str, ProtoError> {
        let raw = self.bytes(context)?;
        std::str::from_utf8(raw)
            .map_err(|_| ProtoError::invalid_wire(format!("{context}: string is not valid UTF-8")))
    }

    pub(crate) fn uint32(&mut self, context: &str) -> Result<u32, ProtoError> {
        let value = self.varint(context)?;
        u32::try_from(value)
            .map_err(|_| ProtoError::invalid_wire(format!("{context}: value overflows uint32")))
    }

    pub(crate) fn boolean(&mut self, context: &str) -> Result<bool, ProtoError> {
        match self.varint(context)? {
            0 => Ok(false),
            1 => Ok(true),
            other => Err(ProtoError::invalid_wire(format!(
                "{context}: bool must be 0 or 1, got {other}"
            ))),
        }
    }

    pub(crate) fn sint32(&mut self, context: &str) -> Result<i32, ProtoError> {
        let value = self.varint(context)?;
        // Zigzag decode for the 32-bit range: the u64-to-i64 wraps are the
        // decode itself (the low bit is the sign), then the i32 range check.
        #[allow(clippy::cast_possible_wrap)]
        let widened = ((value >> 1) as i64) ^ -((value & 1) as i64);
        i32::try_from(widened)
            .map_err(|_| ProtoError::invalid_wire(format!("{context}: value overflows sint32")))
    }

    pub(crate) fn skip(&mut self, wire: u32, context: &str) -> Result<(), ProtoError> {
        match wire {
            WIRE_VARINT => {
                self.varint(context)?;
            }
            WIRE_64BIT => {
                let end = self.pos + 8;
                if end > self.data.len() {
                    return Err(ProtoError::invalid_wire(format!(
                        "{context}: truncated 64-bit field"
                    )));
                }
                self.pos = end;
            }
            WIRE_LEN => {
                self.bytes(context)?;
            }
            WIRE_32BIT => {
                let end = self.pos + 4;
                if end > self.data.len() {
                    return Err(ProtoError::invalid_wire(format!(
                        "{context}: truncated 32-bit field"
                    )));
                }
                self.pos = end;
            }
            other => {
                return Err(ProtoError::invalid_wire(format!(
                    "{context}: unsupported wire type {other} (groups are not valid proto3)"
                )));
            }
        }
        Ok(())
    }
}

const CANONICAL_UUID_PATTERN: [usize; 5] = [8, 4, 4, 4, 12];
const NIL_UUID: &str = "00000000-0000-0000-0000-000000000000";

/// Parse and canonicalize a UUID key the way sandboxd does (google/uuid
/// `Parse`: plain, `urn:uuid:`-prefixed, and braced spellings all
/// converge to one lowercase canonical key). The nil UUID is rejected:
/// it is never a valid idempotency key.
///
/// # Errors
///
/// Returns [`ProtoErrorKind::InvalidInput`] when the value is not a UUID
/// or is the nil UUID.
pub fn canonical_uuid_key(value: &str, field: &str) -> Result<String, ProtoError> {
    let mut candidate = value.trim();
    if candidate
        .get(..9)
        .is_some_and(|prefix| prefix.eq_ignore_ascii_case("urn:uuid:"))
    {
        candidate = &candidate[9..];
    }
    if candidate.len() >= 2 && candidate.starts_with('{') && candidate.ends_with('}') {
        candidate = &candidate[1..candidate.len() - 1];
    }
    if !is_canonical_uuid(candidate) {
        return Err(ProtoError::invalid_input(format!(
            "{field} {value:?} is not a UUID"
        )));
    }
    let canonical = candidate.to_lowercase();
    if canonical == NIL_UUID {
        return Err(ProtoError::invalid_input(format!(
            "{field} must not be the nil UUID"
        )));
    }
    Ok(canonical)
}

/// The canonical 8-4-4-4-12 hex UUID shape.
fn is_canonical_uuid(value: &str) -> bool {
    let mut rest = value;
    for (index, group_len) in CANONICAL_UUID_PATTERN.iter().enumerate() {
        match rest.get(..*group_len) {
            Some(hex) if hex.bytes().all(|b| b.is_ascii_hexdigit()) => {}
            _ => return false,
        }
        rest = &rest[*group_len..];
        if index < CANONICAL_UUID_PATTERN.len() - 1 {
            match rest.get(..1) {
                Some("-") => {}
                _ => return false,
            }
            rest = &rest[1..];
        }
    }
    rest.is_empty()
}

/// End-of-stream flag on a Connect frame (JSON `EndStreamResponse`
/// payload).
pub const CONNECT_FRAME_END_OF_STREAM: u8 = 0x02;

/// Compression flag on a Connect frame; never negotiated by this client.
pub const CONNECT_FRAME_COMPRESSED: u8 = 0x01;

/// One decoded Connect frame: its flags byte and its payload.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ConnectFrame {
    /// The frame's flag bits.
    pub flags: u8,
    /// The frame's message payload.
    pub payload: Vec<u8>,
}

/// Envelope one message payload for a Connect streaming request body.
/// The 5-byte header is the flags byte then the payload length, big
/// endian.
#[must_use]
pub fn encode_connect_frame(payload: &[u8], flags: u8) -> Vec<u8> {
    let mut out = Vec::with_capacity(5 + payload.len());
    out.push(flags);
    // A payload over the u32 frame-length range cannot ride a Connect
    // frame at all; the frame bound rejects it long before here.
    #[allow(clippy::cast_possible_truncation)]
    let length = payload.len() as u32;
    out.extend_from_slice(&length.to_be_bytes());
    out.extend_from_slice(payload);
    out
}

/// Incremental Connect frame decoder fed with response body chunks. A
/// frame larger than the bound is [`ProtoErrorKind::OversizeFrame`], so
/// a hostile or buggy peer cannot force unbounded buffering.
#[derive(Debug)]
pub struct ConnectFrameDecoder {
    buffer: Vec<u8>,
    max_frame_bytes: usize,
}

impl ConnectFrameDecoder {
    /// Build a decoder with a per-frame size bound.
    ///
    /// # Errors
    ///
    /// Returns [`ProtoErrorKind::InvalidInput`] when the bound is zero.
    pub fn new(max_frame_bytes: usize) -> Result<Self, ProtoError> {
        if max_frame_bytes == 0 {
            return Err(ProtoError::invalid_input(
                "maxFrameBytes must be a positive integer",
            ));
        }
        Ok(Self {
            buffer: Vec::new(),
            max_frame_bytes,
        })
    }

    /// Bytes buffered while waiting for a complete frame header and
    /// body.
    #[must_use]
    pub fn buffered_len(&self) -> usize {
        self.buffer.len()
    }

    /// Append a response body chunk.
    pub fn push(&mut self, chunk: &[u8]) {
        self.buffer.extend_from_slice(chunk);
    }

    /// Pop the next complete frame, or `None` while more bytes are
    /// needed.
    ///
    /// # Errors
    ///
    /// Returns [`ProtoErrorKind::OversizeFrame`] when the next frame
    /// exceeds the bound.
    pub fn next_frame(&mut self) -> Result<Option<ConnectFrame>, ProtoError> {
        if self.buffer.len() < 5 {
            return Ok(None);
        }
        let flags = self.buffer[0];
        let length = u32::from_be_bytes([
            self.buffer[1],
            self.buffer[2],
            self.buffer[3],
            self.buffer[4],
        ]) as usize;
        if length > self.max_frame_bytes {
            return Err(ProtoError::oversize_frame(format!(
                "Connect frame of {length} bytes exceeds the {} byte limit",
                self.max_frame_bytes
            )));
        }
        if self.buffer.len() < 5 + length {
            return Ok(None);
        }
        let payload = self.buffer[5..5 + length].to_vec();
        self.buffer.drain(..5 + length);
        Ok(Some(ConnectFrame { flags, payload }))
    }
}

/// Require a non-empty, NUL-free string (TS `requireNulFreeString`).
pub(crate) fn require_nul_free_string(value: &str, field: &str) -> Result<(), ProtoError> {
    if value.is_empty() || value.contains('\0') {
        return Err(ProtoError::invalid_input(format!(
            "{field} must be a non-empty NUL-free string"
        )));
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    const UUID: &str = "0198c0de-9a1b-4d3e-8f2a-5c6b7d8e9f01";

    #[test]
    fn canonical_uuid_keys_accept_the_google_uuid_spellings() {
        assert_eq!(canonical_uuid_key(UUID, "sessionUuid").unwrap(), UUID);
        assert_eq!(
            canonical_uuid_key(&UUID.to_uppercase(), "sessionUuid").unwrap(),
            UUID
        );
        assert_eq!(
            canonical_uuid_key(&format!("  {UUID}  "), "sessionUuid").unwrap(),
            UUID
        );
        assert_eq!(
            canonical_uuid_key(&format!("urn:uuid:{UUID}"), "sessionUuid").unwrap(),
            UUID
        );
        assert_eq!(
            canonical_uuid_key(&format!("{{{UUID}}}"), "sessionUuid").unwrap(),
            UUID
        );
        for bad in [
            "",
            "not-a-uuid",
            "0198c0de-9a1b-4d3e-8f2a-5c6b7d8e9f0",
            NIL_UUID,
            "{\"0198c0de-9a1b-4d3e-8f2a-5c6b7d8e9f01\"}",
        ] {
            assert!(
                canonical_uuid_key(bad, "sessionUuid").is_err(),
                "{bad:?} must be rejected"
            );
        }
    }

    #[test]
    fn varints_round_trip_and_reject_truncation() {
        let mut writer = Writer::default();
        writer.varint(0);
        writer.varint(1);
        writer.varint(300);
        writer.varint(u64::from(u32::MAX) + 1);
        let bytes = writer.finish();
        let mut reader = Reader::new(&bytes);
        assert_eq!(reader.varint("t").unwrap(), 0);
        assert_eq!(reader.varint("t").unwrap(), 1);
        assert_eq!(reader.varint("t").unwrap(), 300);
        assert_eq!(reader.varint("t").unwrap(), u64::from(u32::MAX) + 1);
        // A truncated varint (dangling continuation) is invalid.
        let mut reader = Reader::new(&[0x80]);
        assert_eq!(
            reader.varint("t").unwrap_err().kind(),
            ProtoErrorKind::InvalidWire
        );
        // Ten continuation bytes is not canonical proto.
        let ten = [0x80; 10];
        let mut reader = Reader::new(&ten);
        assert_eq!(
            reader.varint("t").unwrap_err().kind(),
            ProtoErrorKind::InvalidWire
        );
    }

    #[test]
    fn connect_frames_round_trip_across_chunk_boundaries() {
        let frame = encode_connect_frame(&[0xaa, 0xbb, 0xcc], 0);
        let mut decoder = ConnectFrameDecoder::new(1024).unwrap();
        // Feed one byte at a time: no complete frame until the end.
        for byte in &frame[..frame.len() - 1] {
            decoder.push(std::slice::from_ref(byte));
            assert!(decoder.next_frame().unwrap().is_none());
        }
        decoder.push(std::slice::from_ref(&frame[frame.len() - 1]));
        let frame = decoder.next_frame().unwrap().unwrap();
        assert_eq!(
            frame,
            ConnectFrame {
                flags: 0,
                payload: vec![0xaa, 0xbb, 0xcc]
            }
        );
        assert_eq!(decoder.buffered_len(), 0);
        assert!(decoder.next_frame().unwrap().is_none());
    }

    #[test]
    fn oversized_frames_fail_the_decoder() {
        let mut decoder = ConnectFrameDecoder::new(4).unwrap();
        let frame = encode_connect_frame(&[1, 2, 3, 4, 5], 0);
        decoder.push(&frame);
        let error = decoder.next_frame().unwrap_err();
        assert_eq!(error.kind(), ProtoErrorKind::OversizeFrame);
        assert!(error.to_string().contains("exceeds the 4 byte limit"));
        assert!(ConnectFrameDecoder::new(0).is_err());
    }

    #[test]
    fn the_end_of_stream_flag_value_is_the_connect_spec() {
        assert_eq!(CONNECT_FRAME_END_OF_STREAM, 0x02);
        assert_eq!(CONNECT_FRAME_COMPRESSED, 0x01);
    }
}

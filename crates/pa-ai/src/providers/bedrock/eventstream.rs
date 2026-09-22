//! AWS `vnd.amazon.eventstream` binary framing decoder.
//!
//! Bedrock `converse-stream` responses use the AWS event-stream wire format:
//! a prelude (total length, headers length, CRC), a header section, a JSON
//! payload, and a message CRC. Only the payload and the `:event-type` /
//! `:exception-type` headers are needed by the provider.

/// One decoded event-stream message.
#[derive(Debug, Clone)]
#[allow(dead_code)] // full decoded header surface; the provider reads event/exception types
pub struct EventStreamMessage {
    /// `:message-type` header value when present (`event` for data events).
    pub message_type: Option<String>,
    /// `:event-type` header value (`messageStart`, `metadata`, ...).
    pub event_type: Option<String>,
    /// `:exception-type` header value for error events.
    pub exception_type: Option<String>,
    /// Raw JSON payload bytes.
    pub payload: Vec<u8>,
}

/// Incremental decoder fed with raw response body chunks.
#[derive(Default)]
pub struct EventStreamDecoder {
    buffer: Vec<u8>,
}

/// CRC-32 (IEEE, reflected 0xEDB88320) used by the event-stream framing.
fn crc32(bytes: &[u8]) -> u32 {
    let mut table = [0u32; 256];
    for (i, entry) in table.iter_mut().enumerate() {
        let mut value = i as u32;
        for _ in 0..8 {
            value = if value & 1 != 0 {
                (value >> 1) ^ 0xEDB8_8320
            } else {
                value >> 1
            };
        }
        *entry = value;
    }
    let mut crc = 0xFFFF_FFFFu32;
    for byte in bytes {
        crc = table[((crc ^ *byte as u32) & 0xFF) as usize] ^ (crc >> 8);
    }
    !crc
}

fn read_u16(bytes: &[u8]) -> u16 {
    u16::from_be_bytes([bytes[0], bytes[1]])
}

fn read_u32(bytes: &[u8]) -> u32 {
    u32::from_be_bytes([bytes[0], bytes[1], bytes[2], bytes[3]])
}

/// Parse the header section: name (u8 len + bytes), value type u8, value.
/// Value type 7 is a length-prefixed (u16) string; other types are skipped
/// by their fixed or encoded widths.
fn parse_headers(bytes: &[u8]) -> Vec<(String, Option<String>)> {
    let mut headers = Vec::new();
    let mut offset = 0usize;
    while offset + 2 <= bytes.len() {
        let name_len = bytes[offset] as usize;
        if offset + 1 + name_len > bytes.len() {
            break;
        }
        let name_start = offset + 1;
        let name = String::from_utf8_lossy(&bytes[name_start..name_start + name_len]).to_string();
        offset = name_start + name_len;
        if offset >= bytes.len() {
            break;
        }
        let value_type = bytes[offset];
        offset += 1;
        let value = match value_type {
            0 => Some("true".to_string()),
            1 => Some("false".to_string()),
            2 | 3 => {
                offset += 1;
                None
            }
            4 | 5 => {
                offset += 2;
                None
            }
            6 => {
                if offset + 2 > bytes.len() {
                    break;
                }
                let len = read_u16(&bytes[offset..]) as usize;
                offset += 2 + len;
                None
            }
            7 => {
                if offset + 2 > bytes.len() {
                    break;
                }
                let len = read_u16(&bytes[offset..]) as usize;
                offset += 2;
                let value = String::from_utf8_lossy(&bytes[offset..offset + len]).to_string();
                offset += len;
                Some(value)
            }
            8 => {
                offset += 4;
                None
            }
            9 => {
                offset += 8;
                None
            }
            10 | 11 => {
                offset += 16;
                None
            }
            other => {
                // Unknown header value type: stop parsing the header section.
                let _ = other;
                break;
            }
        };
        headers.push((name, value));
    }
    headers
}

impl EventStreamDecoder {
    pub fn new() -> Self {
        Self::default()
    }

    /// Feed raw bytes and return every complete decoded message.
    pub fn push(&mut self, bytes: &[u8]) -> Vec<EventStreamMessage> {
        self.buffer.extend_from_slice(bytes);
        let mut messages = Vec::new();
        while self.buffer.len() >= 16 {
            let total_len = read_u32(&self.buffer) as usize;
            if total_len < 16 {
                // Corrupt framing; drop everything to avoid an infinite loop.
                self.buffer.clear();
                break;
            }
            if self.buffer.len() < total_len {
                break;
            }
            let headers_len = read_u32(&self.buffer[4..]) as usize;
            let prelude_crc = read_u32(&self.buffer[8..]);
            if crc32(&self.buffer[..8]) != prelude_crc {
                // Corrupt prelude; drop the buffered bytes.
                self.buffer.clear();
                break;
            }
            let message = &self.buffer[..total_len];
            let message_crc = read_u32(&message[total_len - 4..]);
            if crc32(&message[..total_len - 4]) != message_crc {
                // Corrupt message; skip past it.
                self.buffer.drain(..total_len);
                continue;
            }
            let headers = parse_headers(&message[12..12 + headers_len]);
            let payload = message[12 + headers_len..total_len - 4].to_vec();
            let header = |name: &str| {
                headers
                    .iter()
                    .find(|(key, _)| key == name)
                    .and_then(|(_, value)| value.clone())
            };
            messages.push(EventStreamMessage {
                message_type: header(":message-type"),
                event_type: header(":event-type"),
                exception_type: header(":exception-type"),
                payload,
            });
            self.buffer.drain(..total_len);
        }
        messages
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Build one framed event-stream message (mirrors the encoder format).
    fn frame(event_type: &str, payload: &[u8]) -> Vec<u8> {
        let mut headers = Vec::new();
        let mut push_header = |name: &str, value: &str| {
            headers.push(name.len() as u8);
            headers.extend_from_slice(name.as_bytes());
            headers.push(7);
            headers.extend_from_slice(&(value.len() as u16).to_be_bytes());
            headers.extend_from_slice(value.as_bytes());
        };
        push_header(":message-type", "event");
        push_header(":content-type", "application/json");
        push_header(":event-type", event_type);
        let mut message = Vec::new();
        let total_len = 12 + headers.len() + payload.len() + 4;
        message.extend_from_slice(&(total_len as u32).to_be_bytes());
        message.extend_from_slice(&(headers.len() as u32).to_be_bytes());
        message.extend_from_slice(&crc32(&message[..8]).to_be_bytes());
        message.extend_from_slice(&headers);
        message.extend_from_slice(payload);
        message.extend_from_slice(&crc32(&message).to_be_bytes());
        message
    }

    #[test]
    fn decodes_framed_messages_across_chunk_boundaries() {
        let frame1 = frame("messageStart", br#"{"messageStart":{"role":"assistant"}}"#);
        let mut frame2 = frame("metadata", br#"{"metadata":{"usage":{"inputTokens":5}}}"#);
        // split the second frame across two pushes
        let split = frame2.len() / 2;
        let tail2 = frame2.split_off(split);

        let mut decoder = EventStreamDecoder::new();
        let mut all: Vec<EventStreamMessage> = Vec::new();
        all.extend(decoder.push(&frame1));
        all.extend(decoder.push(&frame2));
        all.extend(decoder.push(&tail2));

        assert_eq!(all.len(), 2);
        assert_eq!(all[0].event_type.as_deref(), Some("messageStart"));
        assert_eq!(
            String::from_utf8_lossy(&all[0].payload),
            r#"{"messageStart":{"role":"assistant"}}"#
        );
        assert_eq!(all[1].event_type.as_deref(), Some("metadata"));
    }

    #[test]
    fn crc32_matches_reference_value() {
        // CRC-32 of "123456789" (standard IEEE check value).
        assert_eq!(crc32(b"123456789"), 0xCBF4_3926);
    }
}

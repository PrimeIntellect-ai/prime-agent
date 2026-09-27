//! NDJSON line framing for the extension sidecar RPC.
//!
//! The private protocol of `docs/extensions-runner-design.md` §2.2: one JSON
//! object per line over the sidecar's stdio, both directions. This module owns
//! the byte level: line encoding, incremental decoding, and size limits.

use anyhow::{anyhow, Context, Result};
use serde::Serialize;

/// Default cap for a single protocol line. Event payloads can be large (the
/// `context` event carries the whole message list), so this mirrors the
/// daemon frame limits' order of magnitude rather than a small RPC cap.
pub const DEFAULT_MAX_LINE_BYTES: usize = 256 * 1024 * 1024;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct LineLimits {
    pub max_line_bytes: usize,
}

impl Default for LineLimits {
    fn default() -> Self {
        LineLimits {
            max_line_bytes: DEFAULT_MAX_LINE_BYTES,
        }
    }
}

/// Serialize one protocol message as an NDJSON line (trailing `\n` included).
///
/// # Errors
///
/// Returns an error when the message cannot be serialized as JSON or the
/// encoded line exceeds `limits.max_line_bytes`.
pub fn encode_line<T: Serialize + ?Sized>(message: &T, limits: LineLimits) -> Result<Vec<u8>> {
    let mut bytes = serde_json::to_vec(message).context("serialize extension RPC message")?;
    if bytes.len() + 1 > limits.max_line_bytes {
        return Err(anyhow!(
            "extension RPC message exceeds the line limit: {} bytes",
            bytes.len()
        ));
    }
    bytes.push(b'\n');
    Ok(bytes)
}

/// Incremental NDJSON decoder: feed raw socket/pipe chunks, drain complete
/// lines. Rejects oversized partial lines and invalid UTF-8.
#[derive(Debug)]
pub struct LineDecoder {
    buffer: Vec<u8>,
    limits: LineLimits,
}

impl LineDecoder {
    pub fn new(limits: LineLimits) -> Self {
        LineDecoder {
            buffer: Vec::new(),
            limits,
        }
    }

    /// Bytes buffered waiting for a newline.
    pub fn buffered_bytes(&self) -> usize {
        self.buffer.len()
    }

    /// Feed one chunk and return every complete line it produced (plus any
    /// completed by previously buffered bytes). Empty lines are skipped.
    ///
    /// # Errors
    ///
    /// Returns an error when a completed line is not valid UTF-8, or when the
    /// unterminated buffered bytes exceed `limits.max_line_bytes`.
    pub fn feed(&mut self, chunk: &[u8]) -> Result<Vec<String>> {
        self.buffer.extend_from_slice(chunk);
        let mut lines = Vec::new();
        while let Some(pos) = self.buffer.iter().position(|&b| b == b'\n') {
            let mut line: Vec<u8> = self.buffer.drain(..=pos).collect();
            line.pop(); // the newline
            if line.last() == Some(&b'\r') {
                line.pop();
            }
            if line.is_empty() {
                continue;
            }
            let line = String::from_utf8(line)
                .map_err(|err| anyhow!("extension RPC line is not valid UTF-8: {err}"))?;
            lines.push(line);
        }
        if self.buffer.len() > self.limits.max_line_bytes {
            return Err(anyhow!(
                "extension RPC line exceeds the line limit: {} bytes without a newline",
                self.buffer.len()
            ));
        }
        Ok(lines)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn limits(max: usize) -> LineLimits {
        LineLimits {
            max_line_bytes: max,
        }
    }

    #[test]
    fn encode_appends_newline() {
        let out = encode_line(&json!({"id": 1}), LineLimits::default()).unwrap();
        let mut expected = br#"{"id":1}"#.to_vec();
        expected.push(b'\n');
        assert_eq!(out, expected);
    }

    #[test]
    fn encode_rejects_oversized_messages() {
        let big = "x".repeat(10);
        let err = encode_line(&json!({"data": big}), limits(8)).unwrap_err();
        assert!(err.to_string().contains("line limit"));
    }

    #[test]
    fn decoder_handles_chunked_lines() {
        let mut dec = LineDecoder::new(LineLimits::default());
        assert!(dec.feed(b"{\"id\"").unwrap().is_empty());
        let lines = dec.feed(b":1}\n{\"id\":2}\n").unwrap();
        assert_eq!(lines, vec!["{\"id\":1}", "{\"id\":2}"]);
        assert_eq!(dec.buffered_bytes(), 0);
    }

    #[test]
    fn decoder_skips_blank_and_tolerates_crlf() {
        let mut dec = LineDecoder::new(LineLimits::default());
        let lines = dec.feed(b"\n{\"id\":1}\r\n\n").unwrap();
        assert_eq!(lines, vec!["{\"id\":1}"]);
    }

    #[test]
    fn decoder_rejects_oversized_partial_line() {
        let mut dec = LineDecoder::new(limits(4));
        let err = dec.feed(b"aaaaaaaa").unwrap_err();
        assert!(err.to_string().contains("line limit"));
    }

    #[test]
    fn decoder_rejects_invalid_utf8() {
        let mut dec = LineDecoder::new(LineLimits::default());
        let err = dec.feed(&[0xff, b'\n']).unwrap_err();
        assert!(err.to_string().contains("UTF-8"));
    }
}

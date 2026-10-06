//! Length-prefixed private frames: the worker-socket wire codec shared by pa-daemon workers and
//! direct-attach clients (pa-tui/pa-cli) (TS `private-framing.ts`): 8-byte big-endian prefix (u32
//! header length, u32 payload length), JSON header, binary payload.

use anyhow::{anyhow, Context, Result};
use tokio::io::{AsyncRead, AsyncReadExt, AsyncWrite, AsyncWriteExt};

pub const FRAME_PREFIX_BYTES: usize = 8;

#[derive(Debug, Clone, Copy)]
pub struct PrivateFrameLimits {
    pub max_header_bytes: usize,
    pub max_payload_bytes: usize,
}

pub const DEFAULT_PRIVATE_FRAME_LIMITS: PrivateFrameLimits = PrivateFrameLimits {
    max_header_bytes: 1024 * 1024,
    max_payload_bytes: 1024 * 1024 * 1024,
};

impl Default for PrivateFrameLimits {
    fn default() -> Self {
        DEFAULT_PRIVATE_FRAME_LIMITS
    }
}

#[derive(Debug, Clone)]
pub struct PrivateFrame {
    pub header: serde_json::Value,
    pub payload: Vec<u8>,
}

fn assert_frame_length(name: &str, value: usize, maximum: usize) -> Result<()> {
    if value > maximum {
        return Err(anyhow!("Invalid private frame {name}: {value}"));
    }
    Ok(())
}

/// Encode one length-prefixed private frame.
///
/// # Errors
///
/// Returns an error if serializing `header` fails, the encoded header is empty, or a length exceeds
/// `limits`.
pub fn encode_private_frame(
    header: &serde_json::Value,
    payload: &[u8],
    limits: PrivateFrameLimits,
) -> Result<Vec<u8>> {
    let header_bytes = serde_json::to_vec(header).context("serialize private frame header")?;
    if header_bytes.is_empty() {
        return Err(anyhow!("Private frame header cannot be empty"));
    }
    assert_frame_length("header length", header_bytes.len(), limits.max_header_bytes)?;
    assert_frame_length("payload length", payload.len(), limits.max_payload_bytes)?;
    let mut frame = Vec::with_capacity(FRAME_PREFIX_BYTES + header_bytes.len() + payload.len());
    // Wire widths: the prefix packs lengths as u32 BE; limits asserted above.
    #[allow(clippy::cast_possible_truncation)]
    let header_len = header_bytes.len() as u32;
    #[allow(clippy::cast_possible_truncation)]
    let payload_len = payload.len() as u32;
    frame.extend_from_slice(&header_len.to_be_bytes());
    frame.extend_from_slice(&payload_len.to_be_bytes());
    frame.extend_from_slice(&header_bytes);
    frame.extend_from_slice(payload);
    Ok(frame)
}

/// Incremental decoder: feed it socket chunks, pull complete frames out.
#[derive(Debug, Default)]
pub struct PrivateFrameDecoder {
    buffer: Vec<u8>,
    limits: PrivateFrameLimits,
}

impl PrivateFrameDecoder {
    #[must_use]
    pub fn new(limits: PrivateFrameLimits) -> Self {
        Self {
            buffer: Vec::new(),
            limits,
        }
    }

    #[must_use]
    pub fn buffered_bytes(&self) -> usize {
        self.buffer.len()
    }

    /// Feed one socket chunk in; returns every frame the chunk completed. Incomplete trailing bytes
    /// stay buffered for the next call.
    ///
    /// # Errors
    ///
    /// Returns an error if a frame's length prefix exceeds `limits`, its header length is zero, or
    /// its header bytes are not a JSON object.
    pub fn push(&mut self, chunk: &[u8]) -> Result<Vec<PrivateFrame>> {
        self.buffer.extend_from_slice(chunk);
        let mut frames = Vec::new();
        let mut offset = 0usize;
        while self.buffer.len() - offset >= FRAME_PREFIX_BYTES {
            let prefix = &self.buffer[offset..offset + FRAME_PREFIX_BYTES];
            let header_len =
                u32::from_be_bytes([prefix[0], prefix[1], prefix[2], prefix[3]]) as usize;
            let payload_len =
                u32::from_be_bytes([prefix[4], prefix[5], prefix[6], prefix[7]]) as usize;
            assert_frame_length("header length", header_len, self.limits.max_header_bytes)?;
            assert_frame_length("payload length", payload_len, self.limits.max_payload_bytes)?;
            if header_len == 0 {
                return Err(anyhow!("Private frame header cannot be empty"));
            }
            let frame_len = FRAME_PREFIX_BYTES + header_len + payload_len;
            if self.buffer.len() - offset < frame_len {
                break;
            }
            let header_start = offset + FRAME_PREFIX_BYTES;
            let payload_start = header_start + header_len;
            let header: serde_json::Value =
                serde_json::from_slice(&self.buffer[header_start..payload_start])
                    .map_err(|e| anyhow!("Invalid private frame header JSON: {e}"))?;
            if !header.is_object() {
                return Err(anyhow!("Invalid private frame routing header"));
            }
            frames.push(PrivateFrame {
                header,
                payload: self.buffer[payload_start..payload_start + payload_len].to_vec(),
            });
            offset += frame_len;
        }
        if offset > 0 {
            self.buffer.drain(..offset);
        }
        Ok(frames)
    }

    /// # Errors
    ///
    /// Returns an error when buffered bytes remain, i.e. the channel ended mid-frame.
    pub fn finish(&self) -> Result<()> {
        if !self.buffer.is_empty() {
            return Err(anyhow!(
                "Private frame channel ended with {} incomplete bytes",
                self.buffer.len()
            ));
        }
        Ok(())
    }
}

/// Write one frame to a byte sink.
///
/// # Errors
///
/// Returns an error if encoding the frame fails or writing/flushing it on `writer` fails.
pub async fn write_frame<W: AsyncWrite + Unpin>(
    writer: &mut W,
    header: &serde_json::Value,
    payload: &[u8],
    limits: PrivateFrameLimits,
) -> Result<()> {
    let frame = encode_private_frame(header, payload, limits)?;
    writer.write_all(&frame).await?;
    writer.flush().await?;
    Ok(())
}

/// Write a private frame without re-buffering the payload: same wire bytes as [`write_frame`], but
/// the payload writes straight from the caller's slice, avoiding a second payload-sized allocation
/// and copy per frame. The caller holds its write lock across both writes, so no other frame can
/// interleave.
///
/// # Errors
///
/// Returns an error if serializing `header` fails, the encoded header is empty, a length exceeds
/// `limits`, or writing on `writer` fails.
pub async fn write_frame_segments<W: AsyncWrite + Unpin>(
    writer: &mut W,
    header: &serde_json::Value,
    payload: &[u8],
    limits: PrivateFrameLimits,
) -> Result<()> {
    let header_bytes = serde_json::to_vec(header).context("serialize private frame header")?;
    if header_bytes.is_empty() {
        return Err(anyhow!("Private frame header cannot be empty"));
    }
    assert_frame_length("header length", header_bytes.len(), limits.max_header_bytes)?;
    assert_frame_length("payload length", payload.len(), limits.max_payload_bytes)?;
    let mut prefix = Vec::with_capacity(FRAME_PREFIX_BYTES + header_bytes.len());
    // Wire widths: the prefix packs lengths as u32 BE, which the decoder
    // reads back; limits were asserted just above.
    #[allow(clippy::cast_possible_truncation)]
    let header_len = header_bytes.len() as u32;
    #[allow(clippy::cast_possible_truncation)]
    let payload_len = payload.len() as u32;
    prefix.extend_from_slice(&header_len.to_be_bytes());
    prefix.extend_from_slice(&payload_len.to_be_bytes());
    prefix.extend_from_slice(&header_bytes);
    writer.write_all(&prefix).await?;
    writer.write_all(payload).await?;
    writer.flush().await?;
    Ok(())
}

/// Stateful frame reader over a byte stream; frames arriving in one chunk are handed out one
/// `read_frame` at a time; `Ok(None)` means clean EOF at a frame boundary.
pub struct PrivateFrameReader<R> {
    reader: R,
    decoder: PrivateFrameDecoder,
    queue: std::collections::VecDeque<PrivateFrame>,
}

impl<R: AsyncRead + Unpin> PrivateFrameReader<R> {
    pub fn new(reader: R, limits: PrivateFrameLimits) -> Self {
        Self {
            reader,
            decoder: PrivateFrameDecoder::new(limits),
            queue: std::collections::VecDeque::new(),
        }
    }

    /// Buffered bytes of a partially received frame, if any.
    pub fn buffered_bytes(&self) -> usize {
        self.decoder.buffered_bytes()
    }

    /// Read the next frame; `Ok(None)` means clean EOF at a frame boundary.
    ///
    /// # Errors
    ///
    /// Returns an error if the stream fails, ends mid-frame, or a frame is malformed (length prefix
    /// over `limits`, zero header length, or a non-object header).
    pub async fn read_frame(&mut self) -> Result<Option<PrivateFrame>> {
        let mut chunk = [0u8; 8192];
        loop {
            if let Some(frame) = self.queue.pop_front() {
                return Ok(Some(frame));
            }
            let read = self.reader.read(&mut chunk).await?;
            if read == 0 {
                self.decoder
                    .finish()
                    .with_context(|| "private frame channel ended mid-frame")?;
                if self.decoder.buffered_bytes() == 0 {
                    return Ok(None);
                }
                return Err(anyhow!("Private frame channel ended mid-frame"));
            }
            // Partial frames stay buffered inside the decoder for the next read.
            let frames = self.decoder.push(&chunk[..read])?;
            self.queue.extend(frames);
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn header(kind: &str) -> serde_json::Value {
        serde_json::json!({ "kind": kind })
    }

    #[test]
    fn round_trips_frames() {
        let frame = encode_private_frame(
            &header("command"),
            b"{\"x\":1}",
            DEFAULT_PRIVATE_FRAME_LIMITS,
        )
        .unwrap();
        let mut decoder = PrivateFrameDecoder::new(DEFAULT_PRIVATE_FRAME_LIMITS);
        let frames = decoder.push(&frame).unwrap();
        assert_eq!(frames.len(), 1);
        assert_eq!(frames[0].header["kind"], "command");
        assert_eq!(frames[0].payload, b"{\"x\":1}");
    }

    #[tokio::test]
    async fn segments_write_the_same_stream_as_the_buffered_frame() {
        // `i % 251` is 0..=250: non-negative, fits u8 exactly.
        #[allow(clippy::cast_sign_loss)]
        let payload: Vec<u8> = (0..100_000).map(|i| (i % 251) as u8).collect();
        let mut buffered = Vec::new();
        write_frame(
            &mut buffered,
            &header("outbound"),
            &payload,
            DEFAULT_PRIVATE_FRAME_LIMITS,
        )
        .await
        .unwrap();
        let mut segmented = Vec::new();
        write_frame_segments(
            &mut segmented,
            &header("outbound"),
            &payload,
            DEFAULT_PRIVATE_FRAME_LIMITS,
        )
        .await
        .unwrap();
        assert_eq!(buffered, segmented);

        let mut decoder = PrivateFrameDecoder::new(DEFAULT_PRIVATE_FRAME_LIMITS);
        let frames = decoder.push(&segmented).unwrap();
        assert_eq!(frames.len(), 1);
        assert_eq!(frames[0].header["kind"], "outbound");
        assert_eq!(frames[0].payload, payload);
    }

    #[tokio::test]
    async fn segments_reject_the_same_oversized_frames() {
        let payload = vec![0u8; DEFAULT_PRIVATE_FRAME_LIMITS.max_payload_bytes + 1];
        let mut sink = Vec::new();
        let error = write_frame_segments(
            &mut sink,
            &header("outbound"),
            &payload,
            DEFAULT_PRIVATE_FRAME_LIMITS,
        )
        .await;
        assert!(error.is_err());
        assert!(sink.is_empty());
    }

    #[test]
    fn splits_and_reassembles_chunks() {
        let frame = encode_private_frame(
            &header("outbound"),
            &[7u8; 100],
            DEFAULT_PRIVATE_FRAME_LIMITS,
        )
        .unwrap();
        let mut decoder = PrivateFrameDecoder::new(DEFAULT_PRIVATE_FRAME_LIMITS);
        assert!(decoder.push(&frame[..10]).unwrap().is_empty());
        assert!(decoder.push(&frame[10..60]).unwrap().is_empty());
        let frames = decoder.push(&frame[60..]).unwrap();
        assert_eq!(frames.len(), 1);
        assert_eq!(frames[0].payload, vec![7u8; 100]);
    }

    #[tokio::test]
    async fn read_frame_round_trips_over_duplex() {
        let (mut client, server) = tokio::io::duplex(64);
        // Interleave write/read: the 64-byte duplex buffer cannot hold two
        // frames at once, so a write blocks until the peer reads it.
        write_frame(
            &mut client,
            &header("command"),
            b"{\"x\":1}",
            DEFAULT_PRIVATE_FRAME_LIMITS,
        )
        .await
        .unwrap();
        let mut frame_reader = PrivateFrameReader::new(server, DEFAULT_PRIVATE_FRAME_LIMITS);
        let first = frame_reader
            .read_frame()
            .await
            .unwrap()
            .expect("first frame");
        assert_eq!(first.header["kind"], "command");
        assert_eq!(first.payload, b"{\"x\":1}");
        write_frame(
            &mut client,
            &header("command"),
            b"{\"y\":2}",
            DEFAULT_PRIVATE_FRAME_LIMITS,
        )
        .await
        .unwrap();
        let second = frame_reader
            .read_frame()
            .await
            .unwrap()
            .expect("second frame");
        assert_eq!(second.payload, b"{\"y\":2}");
    }

    #[tokio::test]
    async fn frame_reader_yields_every_frame_in_one_chunk() {
        // Two frames coalesced into one chunk must both come out.
        let first = encode_private_frame(
            &header("command"),
            b"{\"a\":1}",
            DEFAULT_PRIVATE_FRAME_LIMITS,
        )
        .unwrap();
        let second = encode_private_frame(
            &header("outbound"),
            b"{\"b\":2}",
            DEFAULT_PRIVATE_FRAME_LIMITS,
        )
        .unwrap();
        let wire: Vec<u8> = [first, second].concat();
        let mut frame_reader =
            PrivateFrameReader::new(std::io::Cursor::new(wire), DEFAULT_PRIVATE_FRAME_LIMITS);
        let frame = frame_reader.read_frame().await.unwrap().unwrap();
        assert_eq!(frame.payload, b"{\"a\":1}");
        let frame = frame_reader.read_frame().await.unwrap().unwrap();
        assert_eq!(frame.payload, b"{\"b\":2}");
        assert!(frame_reader.read_frame().await.unwrap().is_none());
    }

    #[test]
    fn rejects_oversized_headers() {
        let limits = PrivateFrameLimits {
            max_header_bytes: 8,
            max_payload_bytes: 1024,
        };
        let header_value = serde_json::json!({"kind": "aaaaaaaaaaaaaaaaaaaa"});
        let err = encode_private_frame(&header_value, &[], limits).unwrap_err();
        assert!(err
            .to_string()
            .contains("Invalid private frame header length"));
    }
}

//! Passive inbound GOAWAY tracking for the bedrock h2c transport.
//!
//! The `h2` crate files a received GOAWAY as the connection's pending error,
//! but any later connection-level failure (a TCP reset from a peer that
//! closes with unread request data — exactly what the provider-error probe
//! drives, and what broken middleboxes do in the wild) overwrites it before
//! a mid-body stream read can observe it. The TS transport (bun's
//! node:http2) reports the session error even then, so this module observes
//! the inbound wire directly: a pass-through frame-boundary scanner that
//! records the last GOAWAY error code the peer sent. It never interprets
//! anything else (no HPACK, no flow control) and feeds only the failure
//! classification in [`super::h2`].

use std::sync::{Arc, Mutex};

use crate::utils_inner::h2_classify::classify_h2_error;
use crate::utils_inner::stream_failure::H2Failure;

const H2_FRAME_HEADER_LEN: usize = 9;
const H2_FRAME_GOAWAY: u8 = 0x7;

/// The inbound frame scanner. `h2` reads through it, so every inbound byte is
/// observed in order; frame headers are self-delimiting so no HPACK
/// knowledge is needed to track boundaries.
#[derive(Default)]
struct GoAwayTracker {
    /// Bytes of the current frame header collected so far.
    header: [u8; H2_FRAME_HEADER_LEN],
    header_filled: usize,
    /// Payload bytes still expected for the current frame.
    payload_remaining: usize,
    /// The current frame is a connection-level GOAWAY.
    tracking_goaway: bool,
    /// First bytes of a GOAWAY payload (last_stream_id + error code prefix).
    goaway_prefix: Vec<u8>,
    /// The last GOAWAY error code received from the peer.
    last_goaway_code: Option<u32>,
}

impl GoAwayTracker {
    /// Feed the bytes just read from the wire.
    fn observe(&mut self, chunk: &[u8]) {
        let mut rest = chunk;
        loop {
            if self.header_filled < H2_FRAME_HEADER_LEN {
                let take = rest.len().min(H2_FRAME_HEADER_LEN - self.header_filled);
                self.header[self.header_filled..self.header_filled + take]
                    .copy_from_slice(&rest[..take]);
                self.header_filled += take;
                rest = &rest[take..];
                if self.header_filled < H2_FRAME_HEADER_LEN {
                    return;
                }
                let frame_type = self.header[3];
                let stream_id = u32::from_be_bytes([
                    self.header[5],
                    self.header[6],
                    self.header[7],
                    self.header[8],
                ]) & 0x7FFF_FFFF;
                let length =
                    u32::from_be_bytes([0, self.header[0], self.header[1], self.header[2]]);
                self.payload_remaining = length as usize;
                self.tracking_goaway = frame_type == H2_FRAME_GOAWAY && stream_id == 0;
                self.goaway_prefix.clear();
            }
            if self.payload_remaining == 0 {
                self.header_filled = 0;
                continue;
            }
            let take = rest.len().min(self.payload_remaining);
            let consumed = &rest[..take];
            if self.tracking_goaway && self.goaway_prefix.len() < 8 {
                let need = 8 - self.goaway_prefix.len();
                self.goaway_prefix
                    .extend_from_slice(&consumed[..consumed.len().min(need)]);
                if self.goaway_prefix.len() == 8 {
                    // GOAWAY payload: last-stream-id (4) + error code (4).
                    self.last_goaway_code = Some(u32::from_be_bytes(
                        self.goaway_prefix[4..8].try_into().unwrap(),
                    ));
                }
            }
            self.payload_remaining -= take;
            rest = &rest[take..];
            if rest.is_empty() {
                return;
            }
            if self.payload_remaining == 0 {
                self.header_filled = 0;
            }
        }
    }
}

/// The shared tracker a transport response reads its GOAWAY state from.
#[derive(Clone, Default)]
pub(crate) struct GoAwayObserver {
    inner: Arc<Mutex<GoAwayTracker>>,
}

impl GoAwayObserver {
    /// The last GOAWAY error code the peer sent, if any.
    fn last_goaway_code(&self) -> Option<u32> {
        self.inner
            .lock()
            .map(|tracker| tracker.last_goaway_code)
            .unwrap_or(None)
    }

    /// The mid-body failure detail behind an `h2` error, preferring a
    /// received GOAWAY over the stream/socket failure that followed it (the
    /// TS transport reports the session error even when a reset clobbers it).
    pub(crate) fn classify_mid_body(&self, error: &h2::Error) -> H2Failure {
        if let Some(code) = self.last_goaway_code() {
            return H2Failure::SessionClosed { code };
        }
        classify_h2_error(error)
    }
}

/// The pass-through read half: observes the inbound bytes, then hands them
/// to the socket untouched.
pub(crate) struct TrackedReadHalf {
    inner: tokio::net::tcp::OwnedReadHalf,
    observer: GoAwayObserver,
}

impl TrackedReadHalf {
    pub(crate) fn new(inner: tokio::net::tcp::OwnedReadHalf) -> (Self, GoAwayObserver) {
        let observer = GoAwayObserver::default();
        (
            Self {
                inner,
                observer: observer.clone(),
            },
            observer,
        )
    }
}

impl tokio::io::AsyncRead for TrackedReadHalf {
    fn poll_read(
        mut self: std::pin::Pin<&mut Self>,
        cx: &mut std::task::Context<'_>,
        buf: &mut tokio::io::ReadBuf<'_>,
    ) -> std::task::Poll<std::io::Result<()>> {
        let filled_before = buf.filled().len();
        let poll = std::pin::Pin::new(&mut self.inner).poll_read(cx, buf);
        if let std::task::Poll::Ready(Ok(())) = &poll {
            if let Ok(mut tracker) = self.observer.inner.lock() {
                tracker.observe(&buf.filled()[filled_before..]);
            }
        }
        poll
    }
}

/// The stream handed to `h2::client::handshake`: tracked inbound half,
/// pass-through outbound half.
pub(crate) struct TrackedStream {
    read: TrackedReadHalf,
    write: tokio::net::tcp::OwnedWriteHalf,
}

impl TrackedStream {
    pub(crate) fn new(read: TrackedReadHalf, write: tokio::net::tcp::OwnedWriteHalf) -> Self {
        Self { read, write }
    }
}

impl tokio::io::AsyncRead for TrackedStream {
    fn poll_read(
        mut self: std::pin::Pin<&mut Self>,
        cx: &mut std::task::Context<'_>,
        buf: &mut tokio::io::ReadBuf<'_>,
    ) -> std::task::Poll<std::io::Result<()>> {
        std::pin::Pin::new(&mut self.read).poll_read(cx, buf)
    }
}

impl tokio::io::AsyncWrite for TrackedStream {
    fn poll_write(
        mut self: std::pin::Pin<&mut Self>,
        cx: &mut std::task::Context<'_>,
        buf: &[u8],
    ) -> std::task::Poll<Result<usize, std::io::Error>> {
        std::pin::Pin::new(&mut self.write).poll_write(cx, buf)
    }

    fn poll_flush(
        mut self: std::pin::Pin<&mut Self>,
        cx: &mut std::task::Context<'_>,
    ) -> std::task::Poll<Result<(), std::io::Error>> {
        std::pin::Pin::new(&mut self.write).poll_flush(cx)
    }

    fn poll_shutdown(
        mut self: std::pin::Pin<&mut Self>,
        cx: &mut std::task::Context<'_>,
    ) -> std::task::Poll<Result<(), std::io::Error>> {
        std::pin::Pin::new(&mut self.write).poll_shutdown(cx)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn frame(ftype: u8, flags: u8, stream_id: u32, payload: &[u8]) -> Vec<u8> {
        let mut out = Vec::new();
        out.extend_from_slice(&(payload.len() as u32).to_be_bytes()[1..]);
        out.push(ftype);
        out.push(flags);
        out.extend_from_slice(&stream_id.to_be_bytes());
        out.extend_from_slice(payload);
        out
    }

    /// Byte-chunked observation: HEADERS, DATA, then GOAWAY(1) split across
    /// arbitrary read boundaries is still recognized.
    #[test]
    fn tracks_goaway_across_chunk_boundaries() {
        let observer = GoAwayObserver::default();
        let mut tracker = observer.inner.lock().unwrap();
        let mut wire = Vec::new();
        wire.extend_from_slice(&frame(0x1, 0x4, 1, &[0x88])); // HEADERS
        wire.extend_from_slice(&frame(0x0, 0x0, 1, &[0u8; 16])); // DATA
        let mut goaway_payload = Vec::new();
        goaway_payload.extend_from_slice(&1u32.to_be_bytes()); // last stream id
        goaway_payload.extend_from_slice(&1u32.to_be_bytes()); // error code
        wire.extend_from_slice(&frame(0x7, 0x0, 0, &goaway_payload));
        // Feed in odd-size chunks.
        let mut rest = wire.as_slice();
        while !rest.is_empty() {
            let take = rest.len().min(7);
            tracker.observe(&rest[..take]);
            rest = &rest[take..];
        }
        assert_eq!(tracker.last_goaway_code, Some(1));
    }

    /// A connection-level GOAWAY (stream 0) only; a stream-scoped frame with
    /// the same type is ignored (reserved-bit stripped on read).
    #[test]
    fn ignores_non_connection_frames() {
        let observer = GoAwayObserver::default();
        {
            let mut tracker = observer.inner.lock().unwrap();
            let wire = frame(0x7, 0x0, 3, &[0u8; 8]); // GOAWAY-shaped, wrong stream
            tracker.observe(&wire);
            assert_eq!(tracker.last_goaway_code, None);
        }
        let error = h2::Error::from(h2::Reason::PROTOCOL_ERROR);
        assert_eq!(observer.classify_mid_body(&error), H2Failure::Protocol);
    }
}

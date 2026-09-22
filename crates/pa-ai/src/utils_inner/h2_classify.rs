//! http2 transport-failure classification for the bedrock h2 transports.
//!
//! The TS bedrock client's default transport is the AWS SDK's
//! NodeHttp2Handler on bun's `node:http2`: HTTP/2 with h2c prior knowledge
//! over cleartext (and h2-only ALPN over TLS). When the transport fails, the
//! observable surface is bun's `node:http2` error text and codes — which the
//! provider-error probe pinned byte-for-byte against the TS binary. This
//! module turns `h2` crate errors (directly, or through a reqwest error
//! chain) into the failure detail that composes those texts.

use crate::utils_inner::stream_failure::H2Failure;

/// The nghttp2 error-code name bun composes for a stream reset
/// ("Stream closed with error code NGHTTP2_<NAME>").
pub(crate) fn nghttp2_code_name(reason: h2::Reason) -> String {
    match reason {
        h2::Reason::NO_ERROR => "NGHTTP2_NO_ERROR",
        h2::Reason::PROTOCOL_ERROR => "NGHTTP2_PROTOCOL_ERROR",
        h2::Reason::INTERNAL_ERROR => "NGHTTP2_INTERNAL_ERROR",
        h2::Reason::FLOW_CONTROL_ERROR => "NGHTTP2_FLOW_CONTROL_ERROR",
        h2::Reason::SETTINGS_TIMEOUT => "NGHTTP2_SETTINGS_TIMEOUT",
        h2::Reason::STREAM_CLOSED => "NGHTTP2_STREAM_CLOSED",
        h2::Reason::FRAME_SIZE_ERROR => "NGHTTP2_FRAME_SIZE_ERROR",
        h2::Reason::REFUSED_STREAM => "NGHTTP2_REFUSED_STREAM",
        h2::Reason::CANCEL => "NGHTTP2_CANCEL",
        h2::Reason::COMPRESSION_ERROR => "NGHTTP2_COMPRESSION_ERROR",
        h2::Reason::CONNECT_ERROR => "NGHTTP2_CONNECT_ERROR",
        h2::Reason::ENHANCE_YOUR_CALM => "NGHTTP2_ENHANCE_YOUR_CALM",
        h2::Reason::INADEQUATE_SECURITY => "NGHTTP2_INADEQUATE_SECURITY",
        h2::Reason::HTTP_1_1_REQUIRED => "NGHTTP2_HTTP_1_1_REQUIRED",
        // `h2::Reason` is an open u32 newtype; unknown codes have no nghttp2
        // name, so fall back to the wire number like nghttp2's own
        // `nghttp2_strerror` does for unknown codes.
        other => return format!("NGHTTP2_UNKNOWN_{}", u32::from(other)),
    }
    .to_string()
}

/// The observable failure shape of an `h2` error.
#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) enum H2ErrorShape {
    /// A GOAWAY frame received from the peer (connection-level failure).
    RemoteGoAway { code: u32 },
    /// A RST_STREAM frame received from the peer (stream-level failure).
    RemoteReset { reason: h2::Reason },
    /// An h2 library-detected protocol violation (e.g. an HTTP/1.1 answer at
    /// a prior-knowledge peer surfaces as a locally-initiated GOAWAY with the
    /// frame-size reason); bun surfaces these as its generic protocol error.
    LibraryViolation { reason: h2::Reason },
    /// A stream/socket failure (peer reset or close at the TCP layer).
    Io,
    /// Any other h2 error kind.
    Other,
}

/// The observable shape of an h2 error: what initiated it (remote frame vs
/// local detection vs socket) and its reason code, which decides the
/// TS-visible failure detail.
pub(crate) fn h2_error_shape(error: &h2::Error) -> H2ErrorShape {
    if error.is_go_away() {
        if error.is_remote() {
            return H2ErrorShape::RemoteGoAway {
                code: error.reason().map(u32::from).unwrap_or(0),
            };
        }
        if error.is_library() {
            return H2ErrorShape::LibraryViolation {
                reason: error.reason().unwrap_or(h2::Reason::PROTOCOL_ERROR),
            };
        }
    }
    if error.is_reset() {
        if error.is_remote() {
            return H2ErrorShape::RemoteReset {
                reason: error.reason().unwrap_or(h2::Reason::PROTOCOL_ERROR),
            };
        }
        if error.is_library() {
            return H2ErrorShape::LibraryViolation {
                reason: error.reason().unwrap_or(h2::Reason::PROTOCOL_ERROR),
            };
        }
    }
    if error.is_io() {
        return H2ErrorShape::Io;
    }
    H2ErrorShape::Other
}

/// The failure detail a shape composes (see the TS evidence in
/// `stream_failure::h2_failure_text`).
pub(crate) fn classify_h2_shape(shape: &H2ErrorShape) -> H2Failure {
    match shape {
        H2ErrorShape::RemoteGoAway { code } => H2Failure::SessionClosed { code: *code },
        H2ErrorShape::RemoteReset { reason } => H2Failure::StreamReset {
            nghttp2_code: nghttp2_code_name(*reason),
        },
        H2ErrorShape::LibraryViolation { .. } => H2Failure::Protocol,
        H2ErrorShape::Io => H2Failure::Canceled,
        H2ErrorShape::Other => H2Failure::Protocol,
    }
}

/// The failure detail of an h2 error.
pub(crate) fn classify_h2_error(error: &h2::Error) -> H2Failure {
    classify_h2_shape(&h2_error_shape(error))
}

/// Walk an error's source chain for the embedded `h2::Error` (reqwest wraps
/// it in a `hyper::Error`, which the provider plumbing does not name).
pub(crate) fn h2_error_from_chain<'a>(
    mut error: &'a (dyn std::error::Error + 'static),
) -> Option<&'a h2::Error> {
    loop {
        if let Some(h2_error) = error.downcast_ref::<h2::Error>() {
            return Some(h2_error);
        }
        error = error.source()?;
    }
}

/// The failure detail behind a reqwest transport error. When no h2 detail is
/// reachable (raw TLS/socket failure), the stream failed at the socket: the
/// TS h2 transport surfaces that as a canceled pending stream.
pub(crate) fn classify_reqwest_error(error: &reqwest::Error) -> H2Failure {
    match h2_error_from_chain(error) {
        Some(h2_error) => classify_h2_error(h2_error),
        None => H2Failure::Canceled,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn nghttp2_names() {
        assert_eq!(
            nghttp2_code_name(h2::Reason::INTERNAL_ERROR),
            "NGHTTP2_INTERNAL_ERROR"
        );
        assert_eq!(
            nghttp2_code_name(h2::Reason::HTTP_1_1_REQUIRED),
            "NGHTTP2_HTTP_1_1_REQUIRED"
        );
    }

    #[test]
    fn shape_classification() {
        // A remote GOAWAY: bun composes the numeric session code.
        let detail = classify_h2_shape(&H2ErrorShape::RemoteGoAway { code: 1 });
        assert_eq!(
            detail,
            H2Failure::SessionClosed { code: 1 },
            "GOAWAY(PROTOCOL_ERROR) -> Session closed with error code 1"
        );
        // A remote RST_STREAM: bun names the nghttp2 code.
        let detail = classify_h2_shape(&H2ErrorShape::RemoteReset {
            reason: h2::Reason::INTERNAL_ERROR,
        });
        assert_eq!(
            detail,
            H2Failure::StreamReset {
                nghttp2_code: "NGHTTP2_INTERNAL_ERROR".to_string()
            }
        );
        // An h2 library violation (HTTP/1.1 answer at a prior-knowledge
        // peer): bun's generic protocol error.
        assert_eq!(
            classify_h2_shape(&H2ErrorShape::LibraryViolation {
                reason: h2::Reason::FRAME_SIZE_ERROR
            }),
            H2Failure::Protocol
        );
        // A socket failure: the canceled pending stream.
        assert_eq!(classify_h2_shape(&H2ErrorShape::Io), H2Failure::Canceled);
        assert_eq!(classify_h2_shape(&H2ErrorShape::Other), H2Failure::Protocol);
    }

    #[test]
    fn reason_only_errors_classify_as_protocol() {
        // A bare `Reason` error (the only constructible h2 shape in tests)
        // is neither a remote frame nor an io failure: the generic protocol
        // error, like the HTTP/1.1-answer case.
        let error = h2::Error::from(h2::Reason::INTERNAL_ERROR);
        assert_eq!(classify_h2_error(&error), H2Failure::Protocol);
    }
}

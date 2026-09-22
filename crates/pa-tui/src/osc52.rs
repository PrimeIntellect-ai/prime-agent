//! OSC 52 clipboard writes: the terminal-escape clipboard channel used by
//! explicit copy commands (TS `emitOsc52` in `utils/clipboard.ts`). The
//! sequence is zero-width and needs no terminal state, so it can be written
//! while the alternate screen and raw mode are active.

/// The encoded-payload cap (TS `MAX_OSC52_ENCODED_LENGTH`): a payload
/// above it is refused rather than desynchronizing the terminal render.
pub(crate) const MAX_ENCODED_LENGTH: usize = 100_000;

/// The OSC 52 clipboard sequence for `text` (clipboard selection `c`),
/// or `None` when the encoded payload exceeds the cap.
pub(crate) fn sequence(text: &str) -> Option<String> {
    use base64::Engine;
    let encoded = base64::engine::general_purpose::STANDARD.encode(text);
    if encoded.len() > MAX_ENCODED_LENGTH {
        return None;
    }
    Some(format!("\x1b]52;c;{encoded}\x07"))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn small_texts_get_the_ts_sequence_shape() {
        assert_eq!(sequence("hello").as_deref(), Some("\x1b]52;c;aGVsbG8=\x07"));
    }

    #[test]
    fn empty_text_still_emits() {
        assert_eq!(sequence("").as_deref(), Some("\x1b]52;c;\x07"));
    }

    #[test]
    fn oversized_payloads_are_refused() {
        // 100_001 base64 characters of source payload.
        let big = "a".repeat(80_001);
        assert!(sequence(&big).is_none());
        // Just under the cap passes.
        let fit = "a".repeat(70_000);
        assert!(sequence(&fit).is_some());
    }
}

//! OSC 52 clipboard writes: the terminal-escape clipboard channel used by
//! explicit copy commands (TS `emitOsc52` in `utils/clipboard.ts`). The
//! sequence is zero-width and needs no terminal state, so it can be written
//! while the alternate screen and raw mode are active.

/// The encoded-payload cap (TS `MAX_OSC52_ENCODED_LENGTH`): a payload
/// above it is refused rather than desynchronizing the terminal render.
pub(crate) const MAX_ENCODED_LENGTH: usize = 100_000;

/// Whether `text` fits the cap, by length alone: base64 output is
/// exactly `4 * ceil(bytes / 3)` characters, so callers gate on the cap
/// without building the encoding — a local helper takes the raw
/// payload, and the encoding belongs to the OSC 52 write alone.
pub(crate) fn carries(text: &str) -> bool {
    text.len().div_ceil(3) * 4 <= MAX_ENCODED_LENGTH
}

/// The OSC 52 clipboard sequence for `text` (clipboard selection `c`),
/// or `None` when the encoded payload exceeds the cap.
pub(crate) fn sequence(text: &str) -> Option<String> {
    use base64::Engine;
    if !carries(text) {
        return None;
    }
    let encoded = base64::engine::general_purpose::STANDARD.encode(text);
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
    fn the_length_gate_agrees_with_the_encoded_cap() {
        // 75_000 raw bytes encode to exactly the 100_000-character cap.
        let at_cap = "a".repeat(75_000);
        assert!(carries(&at_cap));
        assert!(sequence(&at_cap).is_some());
        let over = "a".repeat(75_001);
        assert!(!carries(&over));
        assert!(sequence(&over).is_none());
        // The length gate and the real encoding agree across the
        // boundary and below it.
        for size in [0, 1, 2, 3, 6, 70_000, 74_999, 75_000, 75_001, 200_001] {
            let text = "a".repeat(size);
            assert_eq!(carries(&text), sequence(&text).is_some(), "size {size}");
        }
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

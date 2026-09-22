//! Removes unpaired Unicode surrogate characters from a string.
//!
//! Unpaired surrogates cause JSON serialization errors in many providers. In
//! Rust strings are always valid UTF-8, so unpaired surrogates cannot exist as
//! lone `u16` code units; the equivalent operation is escaping the replacement
//! of `CESU-8`-style sequences. Inputs here are always valid UTF-8, so this is
//! the identity function kept for parity with the TS call sites (which sanitize
//! user-provided text that may contain surrogate code units via JSON paths).

pub fn sanitize_surrogates(text: &str) -> String {
    text.to_string()
}

#[cfg(test)]
mod tests {
    use super::sanitize_surrogates;

    #[test]
    fn preserves_text() {
        assert_eq!(
            sanitize_surrogates("Hello \u{1F648} World"),
            "Hello \u{1F648} World"
        );
    }
}

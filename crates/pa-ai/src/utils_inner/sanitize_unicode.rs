//! Removes unpaired Unicode surrogate characters from a string. Rust strings are always valid
//! UTF-8, so unpaired surrogates cannot exist as lone `u16` code units; this is the identity
//! function kept for parity with the TS call sites (which sanitize user-provided text that may
//! contain surrogate code units via JSON paths).

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

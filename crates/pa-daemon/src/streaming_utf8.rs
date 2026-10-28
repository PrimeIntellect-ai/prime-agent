//! Streaming UTF-8 decoding for the `!` command runner's pipe reads, so a
//! character split across two reads decodes whole (TS `TextDecoder`
//! `{ stream: true }`).

/// Streaming UTF-8 decoder matching `TextDecoder` `{ stream: true }`: an
/// incomplete trailing sequence is buffered for the next chunk, and invalid
/// bytes become one U+FFFD per maximal subpart (the `String::from_utf8_lossy`
/// rule), so an overlong, surrogate or out-of-range sequence such as
/// `ED A0 80` yields one U+FFFD per byte. One decoder per byte stream: feed each
/// read to [`Self::decode_chunk`], then [`Self::flush`] once at end of stream.
#[derive(Default)]
pub(crate) struct StreamingUtf8 {
    buffer: Vec<u8>,
}

impl StreamingUtf8 {
    /// Decode the complete characters buffered so far plus `data`; a trailing
    /// incomplete sequence waits for the next chunk.
    pub(crate) fn decode_chunk(&mut self, data: &[u8]) -> String {
        self.buffer.extend_from_slice(data);
        let (text, consumed) = decode_lossy_prefix(&self.buffer);
        self.buffer.drain(..consumed);
        text
    }

    /// End of stream: decode whatever is left, a truncated trailing sequence
    /// as one U+FFFD.
    pub(crate) fn flush(&mut self) -> String {
        let buffer = std::mem::take(&mut self.buffer);
        let (mut text, consumed) = decode_lossy_prefix(&buffer);
        if consumed < buffer.len() {
            text.push('\u{FFFD}');
        }
        text
    }
}

/// Lossily decode `bytes` up to a trailing incomplete sequence, returning the
/// text and how many bytes it consumed; the unconsumed tail is a valid prefix
/// of a character that more bytes may complete.
fn decode_lossy_prefix(bytes: &[u8]) -> (String, usize) {
    let mut text = String::with_capacity(bytes.len());
    let mut rest = bytes;
    loop {
        match std::str::from_utf8(rest) {
            Ok(valid) => {
                text.push_str(valid);
                return (text, bytes.len());
            }
            Err(error) => {
                let (valid, after) = rest.split_at(error.valid_up_to());
                // `valid_up_to` marks the longest valid prefix, so this never fails.
                text.push_str(std::str::from_utf8(valid).unwrap_or_default());
                match error.error_len() {
                    Some(invalid) => {
                        text.push('\u{FFFD}');
                        rest = &after[invalid..];
                    }
                    None => return (text, bytes.len() - after.len()),
                }
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::StreamingUtf8;

    /// Feeding `bytes` one byte at a time and flushing decodes exactly what
    /// `String::from_utf8_lossy` (`TextDecoder`'s maximal-subpart rule) does for
    /// the whole input.
    fn assert_matches_lossy(bytes: &[u8]) {
        let expected = String::from_utf8_lossy(bytes).into_owned();
        let mut whole = StreamingUtf8::default();
        let mut whole_text = whole.decode_chunk(bytes);
        whole_text.push_str(&whole.flush());
        assert_eq!(whole_text, expected, "one chunk: {bytes:02X?}");
        let mut split = StreamingUtf8::default();
        let mut split_text: String = bytes
            .iter()
            .map(|byte| split.decode_chunk(std::slice::from_ref(byte)))
            .collect();
        split_text.push_str(&split.flush());
        assert_eq!(split_text, expected, "byte by byte: {bytes:02X?}");
    }

    #[test]
    fn split_chunks_and_a_truncated_tail_decode_like_one_input() {
        for bytes in [
            b"a\xED\xA0\x80\xE0\x80\xAFb".as_slice(),
            "\u{20ac}\u{1F600}".as_bytes(),
            b"x\xE2\x82".as_slice(),
        ] {
            assert_matches_lossy(bytes);
        }
        let mut decoder = StreamingUtf8::default();
        assert_eq!(decoder.decode_chunk(b"x\xE2\x82"), "x");
        assert_eq!(decoder.flush(), "\u{FFFD}");
    }
}

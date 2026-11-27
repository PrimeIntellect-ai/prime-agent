//! Server-sent event decoding shared by streaming providers.
//!
//! Mirrors the TS SSE decoder: \n, \r\n and \r line breaks, comment lines, `event:`/`data:` fields
//! and multi-line data, blank-line/EOF flush.

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ServerSentEvent {
    pub event: Option<String>,
    pub data: String,
    pub raw: Vec<String>,
}

#[derive(Debug, Default)]
struct DecoderState {
    event: Option<String>,
    data: Vec<String>,
    raw: Vec<String>,
}

impl DecoderState {
    fn flush(&mut self) -> Option<ServerSentEvent> {
        if self.event.is_none() && self.data.is_empty() {
            return None;
        }
        let event = ServerSentEvent {
            event: self.event.take(),
            data: std::mem::take(&mut self.data).join("\n"),
            raw: std::mem::take(&mut self.raw),
        };
        Some(event)
    }

    fn decode_line(&mut self, line: &str) -> Option<ServerSentEvent> {
        if line.is_empty() {
            return self.flush();
        }
        self.raw.push(line.to_string());
        if line.starts_with(':') {
            return None;
        }
        let (field_name, value) = match line.find(':') {
            Some(index) => {
                let name = &line[..index];
                let mut value = &line[index + 1..];
                if let Some(stripped) = value.strip_prefix(' ') {
                    value = stripped;
                }
                (name, value)
            }
            None => (line, ""),
        };
        if field_name == "event" {
            self.event = Some(value.to_string());
        } else if field_name == "data" {
            self.data.push(value.to_string());
        }
        None
    }
}

/// Incremental SSE decoder over text chunks.
#[derive(Debug, Default)]
pub struct SseDecoder {
    state: DecoderState,
    buffer: String,
}

impl SseDecoder {
    pub fn new() -> Self {
        Self::default()
    }

    /// Feed a chunk of decoded text; returns complete events in order.
    pub fn push_text(&mut self, text: &str) -> Vec<ServerSentEvent> {
        // Scan from the start of the retained tail, not from the new chunk: the
        // tail can end in a `\r` that this chunk's first byte completes as CRLF,
        // and a scan that began at the new chunk would see a bare `\n` and keep
        // the `\r` inside the line. Completed lines are drained below, so the
        // retained tail is one partial line.
        let mut index = 0;
        self.buffer.push_str(text);
        let mut events = Vec::new();
        let mut line_start = 0;
        let bytes = self.buffer.as_bytes();
        while index < bytes.len() {
            let break_len = match bytes[index] {
                b'\r' if bytes.get(index + 1) == Some(&b'\n') => 2,
                // A chunk-final `\r` may be the first half of a CRLF that the
                // next chunk completes. Ending the line here would make that
                // `\n` a false blank line, which dispatches the event early and
                // splits one response into two (or drops the text entirely when
                // the provider's chunk boundary lands between them).
                b'\r' if bytes.get(index + 1).is_none() => break,
                b'\r' | b'\n' => 1,
                _ => {
                    index += 1;
                    continue;
                }
            };
            if let Some(event) = self.state.decode_line(&self.buffer[line_start..index]) {
                events.push(event);
            }
            index += break_len;
            line_start = index;
        }
        self.buffer.drain(..line_start);
        events
    }

    /// Signal end of stream; flushes the final line and trailing event.
    pub fn finish(&mut self) -> Vec<ServerSentEvent> {
        let mut events = Vec::new();
        // Remaining buffer without a line break is the last line.
        if !self.buffer.is_empty() {
            let mut line = std::mem::take(&mut self.buffer);
            // A lone `\r` at end of stream is a line terminator (SSE spec); it
            // was held back by `push_text` only because the next chunk could
            // have completed it as CRLF.
            if line.ends_with('\r') {
                line.pop();
            }
            if let Some(event) = self.state.decode_line(&line) {
                events.push(event);
            }
        }
        if let Some(event) = self.state.flush() {
            events.push(event);
        }
        events
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn decodes_prime_inference_capture() {
        let text = std::fs::read_to_string(concat!(
            env!("CARGO_MANIFEST_DIR"),
            "/tests/testdata/prime_inference_glm53_flash.sse"
        ))
        .unwrap();
        let mut decoder = SseDecoder::new();
        let events = decoder.push_text(&text);
        let extra = decoder.finish();
        assert_eq!(events.len() + extra.len(), 44); // 43 chunks + [DONE]
        let expected_lines: Vec<&str> = text
            .lines()
            .filter(|line| line.starts_with("data: "))
            .map(|line| &line[6..])
            .collect();
        let actual: Vec<&str> = events
            .iter()
            .chain(extra.iter())
            .map(|event| event.data.as_str())
            .collect();
        assert_eq!(actual, expected_lines);
        let empty: Vec<&str> = events
            .iter()
            .chain(extra.iter())
            .filter(|e| e.data.is_empty())
            .map(|_| "empty")
            .collect();
        assert!(empty.is_empty(), "found empty data events");
        assert!(events[0].data.contains("chat.completion.chunk"));
    }

    #[test]
    fn a_crlf_split_across_chunks_is_one_line_ending_not_two() {
        // Discussion #4299: the HTTP chunk boundary fell between `\r` and `\n`,
        // so the decoder ended the line at `\r` and the `\n` became a false
        // blank line - dispatching "a" alone and dropping the joined text.
        let mut decoder = SseDecoder::new();
        assert!(decoder.push_text("data: a\r").is_empty());
        let events = decoder.push_text("\ndata: b\r\n\r\n");
        let extra = decoder.finish();
        let data: Vec<&str> = events
            .iter()
            .chain(extra.iter())
            .map(|event| event.data.as_str())
            .collect();
        assert_eq!(data, ["a\nb"], "one event carrying both data lines");
    }

    #[test]
    fn preserves_fragmented_line_breaks_and_raw_lines() {
        let mut decoder = SseDecoder::new();
        assert!(decoder.push_text("data: first\r").is_empty());
        // A chunk-final `\r` is held until the next chunk says whether it is a
        // CRLF: `\r` + `\n` is ONE line ending, so the event dispatches on the
        // blank line that follows, not on the `\n` that completes the CRLF.
        assert!(decoder.push_text("\n").is_empty());
        assert_eq!(
            decoder.push_text("\n"),
            vec![ServerSentEvent {
                event: None,
                data: "first".into(),
                raw: vec!["data: first".into()],
            }]
        );
        assert_eq!(
            decoder.push_text("event: update\rdata: next\n\n"),
            vec![ServerSentEvent {
                event: Some("update".into()),
                data: "next".into(),
                raw: vec!["event: update".into(), "data: next".into()],
            }]
        );
        assert!(decoder.push_text("data: final").is_empty());
        assert_eq!(
            decoder.finish(),
            vec![ServerSentEvent {
                event: None,
                data: "final".into(),
                raw: vec!["data: final".into()],
            }]
        );

        // Multi-line data joins with `\n`; comments and unknown fields are skipped.
        let mut decoder = SseDecoder::new();
        let events =
            decoder.push_text("data: line1\r\ndata: line2\r\n\r\n: keep-alive\ndata: x\nid: 3\n\n");
        let data: Vec<&str> = events.iter().map(|event| event.data.as_str()).collect();
        assert_eq!(data, ["line1\nline2", "x"]);
    }

    #[test]
    fn flushes_trailing_event_at_eof() {
        let mut decoder = SseDecoder::new();
        decoder.push_text("data: partial");
        let events = decoder.finish();
        assert_eq!(events.len(), 1);
        assert_eq!(events[0].data, "partial");
    }
}

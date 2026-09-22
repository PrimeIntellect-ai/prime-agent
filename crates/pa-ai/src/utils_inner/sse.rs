//! Server-sent event decoding shared by streaming providers.
//!
//! Mirrors the SSE decoder from the Anthropic provider in the TS reference:
//! handles \n, \r\n and \r line breaks, comment lines, `event:`/`data:` fields
//! and multi-line data, flushing on blank lines and at end-of-stream.

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
        self.buffer.push_str(text);
        let mut events = Vec::new();
        while let Some(line) = take_line(&mut self.buffer) {
            if let Some(event) = self.state.decode_line(&line) {
                events.push(event);
            }
        }
        events
    }

    /// Signal end of stream; flushes the final line and trailing event.
    pub fn finish(&mut self) -> Vec<ServerSentEvent> {
        let mut events = Vec::new();
        // Remaining buffer without a line break is the last line.
        if !self.buffer.is_empty() {
            let line = std::mem::take(&mut self.buffer);
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

fn take_line(buffer: &mut String) -> Option<String> {
    let break_index = next_line_break_index(buffer)?;
    let line: String = buffer[..break_index.start].to_string();
    buffer.drain(..break_index.start + break_index.len);
    Some(line)
}

struct LineBreak {
    /// Index of the break character.
    start: usize,
    /// Length of the break (1 for \r or \n, 2 for \r\n).
    len: usize,
}

fn next_line_break_index(text: &str) -> Option<LineBreak> {
    let carriage_return = text.find('\r');
    let newline = text.find('\n');
    match (carriage_return, newline) {
        (None, None) => None,
        (Some(cr), None) => Some(LineBreak { start: cr, len: 1 }),
        (None, Some(lf)) => Some(LineBreak { start: lf, len: 1 }),
        (Some(cr), Some(lf)) => {
            if cr < lf {
                if cr + 1 == lf {
                    // \r\n is a single line break.
                    Some(LineBreak { start: cr, len: 2 })
                } else {
                    Some(LineBreak { start: cr, len: 1 })
                }
            } else {
                Some(LineBreak { start: lf, len: 1 })
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn decodes_basic_events() {
        let mut decoder = SseDecoder::new();
        let events = decoder.push_text("event: message_start\ndata: {\"a\":1}\n\n");
        assert_eq!(events.len(), 1);
        assert_eq!(events[0].event.as_deref(), Some("message_start"));
        assert_eq!(events[0].data, "{\"a\":1}");
    }

    #[test]
    fn handles_crlf_and_multiline_data() {
        let mut decoder = SseDecoder::new();
        let events = decoder.push_text("data: line1\r\ndata: line2\r\n\r\n");
        assert_eq!(events[0].data, "line1\nline2");
        assert_eq!(events[0].event, None);
    }

    #[test]
    fn skips_comments_and_unknown_fields() {
        let mut decoder = SseDecoder::new();
        let events = decoder.push_text(": keep-alive\ndata: x\nid: 3\n\n");
        assert_eq!(events.len(), 1);
        assert_eq!(events[0].data, "x");
    }

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
    fn flushes_trailing_event_at_eof() {
        let mut decoder = SseDecoder::new();
        decoder.push_text("data: partial");
        let events = decoder.finish();
        assert_eq!(events.len(), 1);
        assert_eq!(events[0].data, "partial");
    }
}

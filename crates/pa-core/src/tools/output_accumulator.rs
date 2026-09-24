//! Bounded-memory streaming output accumulator with temp-file spill.
//!
//! Port of `packages/coding-agent/src/core/tools/output-accumulator.ts`.

use std::fs::File;
use std::io::Write;
use std::path::{Path, PathBuf};

use crate::tools::truncate::{truncate_tail, TruncationOptions, TruncationResult};

pub struct OutputAccumulatorOptions {
    pub max_lines: usize,
    pub max_bytes: usize,
    pub temp_file_prefix: String,
}

impl Default for OutputAccumulatorOptions {
    fn default() -> Self {
        Self {
            max_lines: crate::tools::truncate::DEFAULT_MAX_LINES,
            max_bytes: crate::tools::truncate::DEFAULT_MAX_BYTES,
            temp_file_prefix: "pi-output".to_string(),
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct OutputSnapshot {
    pub content: String,
    pub truncation: TruncationResult,
    pub full_output_path: Option<String>,
}

fn default_temp_file_path(prefix: &str) -> PathBuf {
    let nanos = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_nanos())
        .unwrap_or(0);
    let id = nanos ^ ((std::process::id() as u128) << 64);
    std::env::temp_dir().join(format!("{prefix}-{id:032x}.log"))
}

/// Streaming UTF-8 decoder matching `TextDecoder` `{ stream: true }`: incomplete
/// sequences are buffered; invalid bytes become one U+FFFD per maximal subpart.
#[derive(Default)]
struct StreamingUtf8 {
    buffer: Vec<u8>,
}

impl StreamingUtf8 {
    fn decode_chunk(&mut self, data: &[u8]) -> String {
        self.buffer.extend_from_slice(data);
        let mut text = String::new();
        let mut start = 0usize;
        let buf = &self.buffer;
        while start < buf.len() {
            match decode_utf8_char(&buf[start..]) {
                Decoded::Char(len) => {
                    // Safety-free push: re-encode the validated sequence.
                    text.push_str(
                        std::str::from_utf8(&buf[start..start + len]).unwrap_or("\u{FFFD}"),
                    );
                    start += len;
                }
                Decoded::Invalid(len) => {
                    text.push('\u{FFFD}');
                    start += len;
                }
                Decoded::Incomplete => break,
            }
        }
        self.buffer.drain(..start);
        text
    }

    fn flush(&mut self) -> String {
        if self.buffer.is_empty() {
            return String::new();
        }
        let mut text = String::new();
        let mut start = 0usize;
        let buf = std::mem::take(&mut self.buffer);
        while start < buf.len() {
            match decode_utf8_char(&buf[start..]) {
                Decoded::Char(len) => {
                    text.push_str(
                        std::str::from_utf8(&buf[start..start + len]).unwrap_or("\u{FFFD}"),
                    );
                    start += len;
                }
                Decoded::Invalid(len) => {
                    text.push('\u{FFFD}');
                    start += len;
                }
                Decoded::Incomplete => {
                    // Truncated trailing sequence at end of stream: one replacement char.
                    text.push('\u{FFFD}');
                    break;
                }
            }
        }
        text
    }
}

enum Decoded {
    Char(usize),
    Invalid(usize),
    Incomplete,
}

/// Decode one UTF-8 sequence at the start of `buf`, mirroring the WHATWG
/// decoder's maximal-subpart behavior.
fn decode_utf8_char(buf: &[u8]) -> Decoded {
    if buf.is_empty() {
        return Decoded::Incomplete;
    }
    let b0 = buf[0];
    if b0 < 0x80 {
        return Decoded::Char(1);
    }
    let (len, min, mut cp) = if b0 & 0xE0 == 0xC0 {
        (2usize, 0x80u32, u32::from(b0 & 0x1F))
    } else if b0 & 0xF0 == 0xE0 {
        (3, 0x800, u32::from(b0 & 0x0F))
    } else if b0 & 0xF8 == 0xF0 {
        (4, 0x10000, u32::from(b0 & 0x07))
    } else {
        return Decoded::Invalid(1);
    };
    if buf.len() < len {
        // Check for an invalid leading byte early: a shorter buffer that can
        // never become valid must fail now, not wait for more bytes.
        for (i, b) in buf.iter().enumerate().take(len).skip(1) {
            if b & 0xC0 != 0x80 {
                return Decoded::Invalid(i);
            }
        }
        return Decoded::Incomplete;
    }
    for (i, b) in buf.iter().enumerate().take(len).skip(1) {
        if b & 0xC0 != 0x80 {
            return Decoded::Invalid(i);
        }
        cp = (cp << 6) | u32::from(b & 0x3F);
    }
    if cp < min || (0xD800..=0xDFFF).contains(&cp) || cp > 0x0010_FFFF {
        return Decoded::Invalid(len);
    }
    Decoded::Char(len)
}

/// One spill lifecycle with exactly two terminal states: a COMPLETE file whose
/// path `finalize()` resolves, or a DEGRADED spill (failure at open, write, or
/// final flush) whose path is never advertised. `finalize()` never fails; the
/// caller keeps its bounded in-memory tail either way.
pub struct OutputSpill {
    prefix: String,
    path: Option<PathBuf>,
    file: Option<File>,
    failed: bool,
}

impl OutputSpill {
    pub fn new(prefix: &str) -> Self {
        Self {
            prefix: prefix.to_string(),
            path: None,
            file: None,
            failed: false,
        }
    }

    pub fn is_open(&self) -> bool {
        self.file.is_some()
    }

    /// Advertisable path; None once the spill degraded.
    pub fn current_path(&self) -> Option<String> {
        self.path.as_ref().map(|p| p.to_string_lossy().into_owned())
    }

    /// Open once, writing `replay` first; a degraded spill never reopens.
    pub fn open(&mut self, replay: &[Vec<u8>]) {
        if self.file.is_some() || self.failed {
            return;
        }
        let prefix = self.prefix.clone();
        let path = default_temp_file_path(&prefix);
        match File::create(&path) {
            Ok(mut file) => {
                for chunk in replay {
                    if file.write_all(chunk).is_err() {
                        self.failed = true;
                        self.file = None;
                        self.path = None;
                        let _ = std::fs::remove_file(&path);
                        return;
                    }
                }
                self.path = Some(path);
                self.file = Some(file);
            }
            Err(_) => {
                self.failed = true;
                self.path = None;
            }
        }
    }

    pub fn write(&mut self, chunk: &[u8]) {
        if let Some(file) = self.file.as_mut() {
            if file.write_all(chunk).is_err() {
                self.failed = true;
                let partial = self.path.take();
                self.file = None;
                if let Some(partial) = partial {
                    let _ = std::fs::remove_file(partial);
                }
            }
        }
    }

    /// Flush and settle: the complete file's path, or None when degraded.
    #[allow(dead_code)]
    pub async fn finalize(&mut self) -> Option<String> {
        self.finalize_sync()
    }

    /// Blocking form of [`Self::finalize`].
    pub fn finalize_sync(&mut self) -> Option<String> {
        let file = self.file.take();
        if let Some(mut file) = file {
            let _ = file.flush();
            let _ = file.sync_data();
        }
        if self.failed {
            None
        } else {
            self.path.as_ref().map(|p| p.to_string_lossy().into_owned())
        }
    }
}

impl Default for OutputSpill {
    fn default() -> Self {
        Self::new("pi-output")
    }
}

/// Incrementally tracks streaming output with bounded memory.
///
/// Appends decode chunks with a streaming UTF-8 decoder, keeps only a decoded
/// tail for display snapshots, and opens a temp file when the full output needs
/// to be preserved.
pub struct OutputAccumulator {
    max_lines: usize,
    max_bytes: usize,
    max_rolling_bytes: usize,
    decoder: StreamingUtf8,

    raw_chunks: Vec<Vec<u8>>,
    tail_text: String,
    tail_bytes: usize,
    tail_starts_at_line_boundary: bool,
    total_raw_bytes: usize,
    total_decoded_bytes: usize,
    total_lines: usize,
    current_line_bytes: usize,
    finished: bool,

    spill: OutputSpill,
}

impl OutputAccumulator {
    pub fn new(options: OutputAccumulatorOptions) -> Self {
        let max_rolling_bytes = (options.max_bytes * 2).max(1);
        let spill = OutputSpill::new(&options.temp_file_prefix);
        Self {
            max_lines: options.max_lines,
            max_bytes: options.max_bytes,
            max_rolling_bytes,
            decoder: StreamingUtf8::default(),
            raw_chunks: Vec::new(),
            tail_text: String::new(),
            tail_bytes: 0,
            tail_starts_at_line_boundary: true,
            total_raw_bytes: 0,
            total_decoded_bytes: 0,
            total_lines: 1,
            current_line_bytes: 0,
            finished: false,
            spill,
        }
    }

    pub fn append(&mut self, data: &[u8]) {
        assert!(
            !self.finished,
            "Cannot append to a finished output accumulator"
        );

        self.total_raw_bytes += data.len();
        let decoded = self.decoder.decode_chunk(data);
        self.append_decoded_text(&decoded);

        if self.spill.is_open() || self.should_use_temp_file() {
            self.ensure_temp_file();
            self.spill.write(data);
        } else if !data.is_empty() {
            self.raw_chunks.push(data.to_vec());
        }
    }

    pub fn finish(&mut self) {
        if self.finished {
            return;
        }
        self.finished = true;
        let flushed = self.decoder.flush();
        self.append_decoded_text(&flushed);
        if self.should_use_temp_file() {
            self.ensure_temp_file();
        }
    }

    pub fn snapshot(&self) -> OutputSnapshot {
        let tail_truncation = truncate_tail(
            &self.get_snapshot_text(),
            TruncationOptions::with_limits(self.max_lines, self.max_bytes),
        );
        let truncated =
            self.total_lines > self.max_lines || self.total_decoded_bytes > self.max_bytes;
        let truncated_by = if truncated {
            tail_truncation
                .truncated_by
                .or(if self.total_decoded_bytes > self.max_bytes {
                    Some(crate::tools::truncate::TruncatedBy::Bytes)
                } else {
                    Some(crate::tools::truncate::TruncatedBy::Lines)
                })
        } else {
            None
        };
        let mut truncation = tail_truncation;
        truncation.truncated = truncated;
        truncation.truncated_by = truncated_by;
        truncation.total_lines = self.total_lines;
        truncation.total_bytes = self.total_decoded_bytes;
        truncation.max_lines = self.max_lines;
        truncation.max_bytes = self.max_bytes;

        OutputSnapshot {
            content: truncation.content.clone(),
            truncation,
            full_output_path: self.spill.current_path(),
        }
    }

    /// Settle the spill; afterwards `snapshot().full_output_path` is terminal.
    #[allow(dead_code)]
    pub async fn close_temp_file(&mut self) {
        self.spill.finalize().await;
    }

    /// Synchronous settle of the spill (same terminal states as
    /// [`Self::close_temp_file`]); safe to call while holding the accumulator
    /// lock across no awaits.
    pub fn close_temp_file_sync(&mut self) {
        self.spill.finalize_sync();
    }

    pub fn get_last_line_bytes(&self) -> usize {
        self.current_line_bytes
    }

    fn append_decoded_text(&mut self, text: &str) {
        if text.is_empty() {
            return;
        }

        let bytes = text.len();
        self.total_decoded_bytes += bytes;
        self.tail_text.push_str(text);
        self.tail_bytes += bytes;
        if self.tail_bytes > self.max_rolling_bytes * 2 {
            self.trim_tail();
        }

        let mut newlines = 0usize;
        let mut last_newline: Option<usize> = None;
        let mut search_from = 0usize;
        while let Some(pos) = text[search_from..].find('\n') {
            newlines += 1;
            last_newline = Some(search_from + pos);
            search_from = search_from + pos + 1;
        }
        if newlines == 0 {
            self.current_line_bytes += bytes;
        } else {
            self.total_lines += newlines;
            let last = last_newline.unwrap_or(0);
            self.current_line_bytes = text[last + 1..].len();
        }
    }

    fn trim_tail(&mut self) {
        let buffer = self.tail_text.as_bytes().to_vec();
        if buffer.len() <= self.max_rolling_bytes {
            self.tail_bytes = buffer.len();
            return;
        }

        let mut start = buffer.len() - self.max_rolling_bytes;
        while start < buffer.len() && (buffer[start] & 0xc0) == 0x80 {
            start += 1;
        }

        self.tail_starts_at_line_boundary = if start == 0 {
            self.tail_starts_at_line_boundary
        } else {
            buffer[start - 1] == 0x0a
        };
        self.tail_text = String::from_utf8_lossy(&buffer[start..]).into_owned();
        self.tail_bytes = self.tail_text.len();
    }

    fn get_snapshot_text(&self) -> String {
        if self.tail_starts_at_line_boundary {
            return self.tail_text.clone();
        }

        match self.tail_text.find('\n') {
            Some(first_newline) => self.tail_text[first_newline + 1..].to_string(),
            None => self.tail_text.clone(),
        }
    }

    fn should_use_temp_file(&self) -> bool {
        self.total_raw_bytes > self.max_bytes
            || self.total_decoded_bytes > self.max_bytes
            || self.total_lines > self.max_lines
    }

    fn ensure_temp_file(&mut self) {
        self.spill.open(&self.raw_chunks);
        self.raw_chunks.clear();
    }
}

#[allow(dead_code)]
fn _unused(_: &Path) {}

//! The streaming main-screen flush (TS `exitFullscreen`'s inline
//! repaint): the exit path that renders the inline frame section by
//! section and writes the changed rows into the user's native
//! scrollback in bounded chunks — the flush state, its chunking, and
//! the row-text helpers.

use super::AgentView;
use crate::Line;

impl AgentView {
    /// Stream the changed rows of the inline layout to `out` as the
    /// main-screen flush (TS `exitFullscreen`'s inline repaint): the flush
    /// is the one output path that writes into the user's native
    /// scrollback, so its byte stream is parity-frozen — and on a long
    /// transcript the materialized flush (`render_inline_frame` plus the
    /// row texts plus the write buffer) held the whole transcript in
    /// memory at once, a +O(rows) RSS spike right at exit. The streaming
    /// flush renders the frame one section at a time (splash, chat
    /// entries, tail, dock) and hands the encoded rows to `out` in
    /// bounded chunks, so the peak extra memory is one section plus one
    /// chunk.
    ///
    /// The write plan keeps the materialized flush's decision tree:
    ///
    /// - rows extending the flushed frame append below the cursor and
    ///   flow into native scrollback — the exit path that keeps the exit
    ///   frame and resume hint visible;
    /// - a change above the flushed tail (a transcript that grew past a
    ///   suspend-time flush, a snapshot rebuild) erases the visible
    ///   screen and repaints the last screenful, mirroring the TS full
    ///   redraw — scrollback above the screen is never rewritten,
    ///   because terminal scrollback is immutable;
    /// - an identical frame writes nothing.
    ///
    /// `self.flushed_frame` (the row texts of the last flush) is the diff
    /// base for the next flush, exactly as before.
    ///
    /// # Errors
    ///
    /// Propagates the write error when `out` rejects a chunk (a terminal
    /// that went away mid-flush): the rows already written have scrolled,
    /// so the flush is not retried — the exit tail restores the terminal.
    pub fn stream_flush_to(
        &mut self,
        out: &mut dyn std::io::Write,
        width: usize,
        screen_height: usize,
    ) -> std::io::Result<()> {
        let layout = self.layout_pass(width);
        let mut sink = FlushSink {
            flushed: std::mem::take(&mut self.flushed_frame),
            texts: Vec::new(),
            ring: std::collections::VecDeque::new(),
            chunk: String::new(),
            screen_height,
            appending: false,
            repaint: false,
        };
        sink.feed(out, &layout.splash)?;
        let mut preceded_by_tool_activity = false;
        for (index, entry) in self.chat.iter().enumerate() {
            let rows =
                self.render_entry(index, entry, width, index == 0, preceded_by_tool_activity);
            sink.feed(out, &rows)?;
            preceded_by_tool_activity = Self::is_compact_neighbor(entry);
        }
        sink.feed(out, &layout.tail)?;
        let dock = self.render_dock(width);
        sink.feed(out, &dock)?;
        sink.finish(out)?;
        self.flushed_frame = std::mem::take(&mut sink.texts);
        Ok(())
    }
}

/// The encoded flush rows leave the process in slices of at most this
/// many bytes: big enough that each PTY write stays one syscall, small
/// enough that the flush buffer never holds the transcript. 32KiB also
/// bounds the exit guard's blind window on a slow terminal: a completed
/// chunk write is the guard's progress proof (the writer blocks inside a
/// chunk while the terminal drains, invisible from userspace), and at
/// this size a drain of at least ~65KB/s completes chunks within the
/// guard's grace window — the flush rides out a slow drain instead of
/// tripping the 1500ms force-quit deadline mid-write.
const CHUNK_BYTES: usize = 32 * 1024;

/// The streaming main-screen flush state: feeds the inline frame's rows
/// section by section, routes them between the append stream and the
/// repaint ring, and writes the encoded bytes in bounded chunks.
struct FlushSink {
    /// The last flush's row texts — the diff base (owned: the new frame's
    /// texts replace it at the end of the flush).
    flushed: Vec<String>,
    /// The new frame's row texts, accumulated as the rows stream (the
    /// diff base the NEXT flush compares against).
    texts: Vec<String>,
    /// The most recent `screen_height` rows seen, for the repaint write:
    /// a change above the flushed tail repaints the frame tail only.
    ring: std::collections::VecDeque<crate::Line>,
    /// The encoded append rows not yet handed to `out`.
    chunk: String,
    screen_height: usize,
    /// Set once a row extends the flushed frame: every later row appends.
    appending: bool,
    /// Set when a row inside the flushed frame changed: every row keeps
    /// landing in the repaint ring instead.
    repaint: bool,
}

impl FlushSink {
    /// Feed one section of the inline frame.
    fn feed(&mut self, out: &mut dyn std::io::Write, rows: &[crate::Line]) -> std::io::Result<()> {
        for row in rows {
            let index = self.texts.len();
            let text = row_text_of(row);
            if self.appending {
                crate::interactive::write_flush_rows(&mut self.chunk, std::slice::from_ref(row));
                self.texts.push(text);
                if self.chunk.len() >= CHUNK_BYTES {
                    out.write_all(self.chunk.as_bytes())?;
                    self.chunk.clear();
                    // A completed chunk write is exit-path progress: the
                    // exit guard holds its force-quit while these keep
                    // landing, so a slow terminal drains the flush
                    // instead of dying mid-write.
                    crate::exit_guard::note_exit_progress();
                }
            } else if self.repaint || index >= self.flushed.len() {
                // Rows inside the flushed frame landed in the ring while
                // the mode was undecided; a changed row turns the write
                // into a repaint, and a row past the flushed frame turns
                // it into an append.
                if self.repaint {
                    self.ring_push(row);
                } else {
                    self.appending = true;
                    crate::interactive::write_flush_rows(
                        &mut self.chunk,
                        std::slice::from_ref(row),
                    );
                }
                self.texts.push(text);
            } else {
                if self.flushed[index].as_str() != text.as_str() {
                    self.repaint = true;
                }
                self.ring_push(row);
                self.texts.push(text);
            }
        }
        Ok(())
    }

    /// Keep the repaint ring at one screenful.
    fn ring_push(&mut self, row: &crate::Line) {
        self.ring.push_back(row.clone());
        while self.ring.len() > self.screen_height {
            self.ring.pop_front();
        }
    }

    /// Write what the decided mode owes: the append tail, the repaint
    /// erase plus the ring, or nothing for an identical frame.
    fn finish(&mut self, out: &mut dyn std::io::Write) -> std::io::Result<()> {
        if self.appending {
            if !self.chunk.is_empty() {
                out.write_all(self.chunk.as_bytes())?;
                self.chunk.clear();
                crate::exit_guard::note_exit_progress();
            }
        } else if self.repaint || self.texts.len() < self.flushed.len() {
            // A frame that shrank never rewinds into a rewrite of
            // scrollback: the changed region repaints the visible window.
            let mut buffer = String::from("\x1b[2J\x1b[H");
            let ring: Vec<crate::Line> = std::mem::take(&mut self.ring).into_iter().collect();
            crate::interactive::write_flush_rows(&mut buffer, &ring);
            out.write_all(buffer.as_bytes())?;
            self.chunk.clear();
            crate::exit_guard::note_exit_progress();
        }
        Ok(())
    }
}

/// Concatenated span contents of a row (includes zero-width OSC zone
/// markers, which must persist into scrollback).
fn row_text_of(line: &Line) -> String {
    line.iter().map(|span| span.content.as_str()).collect()
}

/// Split a string at a char boundary.
pub(super) fn split_at_chars(text: &str, at: usize) -> (&str, &str) {
    let mut end = text.len();
    let mut count = 0;
    for (index, _) in text.char_indices() {
        if count == at {
            end = index;
            break;
        }
        count += 1;
    }
    if count < at {
        return (text, "");
    }
    (&text[..end], &text[end..])
}

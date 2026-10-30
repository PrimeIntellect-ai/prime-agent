//! The streaming main-screen flush (TS `exitFullscreen`'s inline
//! repaint): the exit path that renders the inline frame section by
//! section and writes the changed rows into the user's native
//! scrollback in bounded chunks.

use super::AgentView;
use crate::Line;

impl AgentView {
    /// Stream the changed rows of the inline layout to `out` as the main-screen flush: the one
    /// output path that writes into the user's native scrollback, so its byte stream is
    /// parity-frozen. `self.flushed_frame` is the diff base.
    ///
    /// - rows extending the flushed frame append into scrollback;
    /// - a change above the flushed tail repaints the last screenful
    ///   (scrollback is immutable);
    /// - an identical frame writes nothing.
    ///
    /// # Errors
    ///
    /// Propagates the write error when `out` rejects a chunk: the rows already written have
    /// scrolled, so the flush is not retried.
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

    /// Stream the turn-settled transcript delta to `out` as the automatic scrollback flush:
    /// unlike `stream_flush_to` this writes ONLY the chat-entry rows, with their own diff base
    /// (`self.flushed_transcript_rows`), so the dock, tail, and splash never land in scrollback
    /// and a settle never rewrites rows that already scrolled. Returns whether any rows
    /// appended (a reset, an unchanged transcript, or a mid-run suspend that already wrote
    /// them appends nothing).
    ///
    /// - the FIRST flush of a run steps one line down before its rows: the main screen's
    ///   cursor sits at the end of the shell line that launched the TUI, and a bare row write
    ///   would leave that line's tail glued to the first row (the launch line stays intact
    ///   instead); later flushes continue right after the previous turn's rows;
    /// - rows extending the flushed transcript append into scrollback, chunked like the exit
    ///   flush;
    /// - a change inside the flushed transcript (compaction, a branch switch, a rewrap, a
    ///   detail change) writes NOTHING: scrollback is immutable, so the affected region becomes
    ///   a deliberate gap and the base silently advances to the new rows;
    /// - on a write error the base keeps only the prefix that reached the terminal: rows
    ///   already in scrollback are durable, so a retry never duplicates them (this path runs
    ///   again, unlike the exit flush).
    ///
    /// The exit path's shared base (`self.flushed_frame`) is re-seeded with the full inline row
    /// texts WITHOUT writing them whenever rows already reached scrollback (a successful
    /// append, or the durable prefix of a failed one): the next suspend/exit flush must start
    /// from the current frame instead of re-appending the transcript. A reset seeds NOTHING:
    /// it wrote no rows, and the exit flush's repaint is what puts the rewritten region on the
    /// visible screen.
    ///
    /// # Errors
    ///
    /// Propagates the write error after advancing the base to the durable prefix.
    pub(crate) fn stream_transcript_delta_to(
        &mut self,
        out: &mut dyn std::io::Write,
        width: usize,
    ) -> std::io::Result<bool> {
        let layout = self.layout_pass(width);
        let rows = self.transcript_rows(width);
        let texts: Vec<String> = rows.iter().map(row_text_of).collect();
        let base = std::mem::take(&mut self.flushed_transcript_rows);
        let changed_prefix = texts
            .iter()
            .zip(base.iter())
            .any(|(text, flushed)| text.as_str() != flushed.as_str());
        if changed_prefix || texts.len() < base.len() {
            // An edited or re-rendered transcript is a scrollback gap, never a rewrite.
            self.flushed_transcript_rows = texts;
            return Ok(false);
        }
        let mut chunk = String::new();
        let mut written = base.len();
        // The run's first flush starts BELOW the launching shell line: the main-screen
        // cursor parked at that line's end, and a row's bare `\r` never clears the rest
        // of the line it lands on.
        if base.is_empty() && !rows.is_empty() {
            chunk.push_str("\r\n");
        }
        for (index, row) in rows[base.len()..].iter().enumerate() {
            crate::interactive::write_flush_rows(&mut chunk, std::slice::from_ref(row));
            if chunk.len() >= CHUNK_BYTES {
                if let Err(error) = out.write_all(chunk.as_bytes()) {
                    self.flushed_transcript_rows = texts[..written].to_vec();
                    self.seed_flushed_frame(&layout.splash, &rows, &layout.tail, width);
                    return Err(error);
                }
                chunk.clear();
                // A completed chunk write is exit-path progress for the
                // exit guard's force-quit hold.
                crate::exit_guard::note_exit_progress();
                written = base.len() + index + 1;
            }
        }
        if !chunk.is_empty() {
            if let Err(error) = out.write_all(chunk.as_bytes()) {
                self.flushed_transcript_rows = texts[..written].to_vec();
                self.seed_flushed_frame(&layout.splash, &rows, &layout.tail, width);
                return Err(error);
            }
            chunk.clear();
            crate::exit_guard::note_exit_progress();
        }
        let appended = base.len() < texts.len();
        self.flushed_transcript_rows = texts;
        self.seed_flushed_frame(&layout.splash, &rows, &layout.tail, width);
        Ok(appended)
    }

    /// Rebase the settle delta base to the transcript a suspend/external-editor/exit flush
    /// just appended onto the main screen: that flush owns those rows now, so the next
    /// settle must append only what landed after it. Writes nothing, so the exit flush's
    /// parity-frozen byte stream is untouched.
    pub(crate) fn rebase_transcript_delta_base(&mut self, width: usize) {
        let rows = self.transcript_rows(width);
        self.flushed_transcript_rows = rows.iter().map(row_text_of).collect();
    }

    /// The chat-entry rows with the same per-entry rendering `stream_flush_to` uses: the
    /// transcript alone, without the splash, tail, or dock.
    fn transcript_rows(&self, width: usize) -> Vec<crate::Line> {
        let mut rows: Vec<crate::Line> = Vec::new();
        let mut preceded_by_tool_activity = false;
        for (index, entry) in self.chat.iter().enumerate() {
            let entry_rows =
                self.render_entry(index, entry, width, index == 0, preceded_by_tool_activity);
            rows.extend(entry_rows);
            preceded_by_tool_activity = Self::is_compact_neighbor(entry);
        }
        rows
    }

    /// Replace the exit path's diff base with the current full inline row texts WITHOUT
    /// writing them: a settle already wrote the transcript into scrollback, so the next
    /// suspend/exit flush must not append it again.
    fn seed_flushed_frame(
        &mut self,
        splash: &[crate::Line],
        transcript_rows: &[crate::Line],
        tail: &[crate::Line],
        width: usize,
    ) {
        let dock = self.render_dock(width);
        self.flushed_frame = splash
            .iter()
            .chain(transcript_rows)
            .chain(tail)
            .chain(dock.iter())
            .map(row_text_of)
            .collect();
    }
}

/// The encoded flush rows leave the process in slices of at most this many bytes: each PTY
/// write stays one syscall, and a completed chunk write is the exit guard's progress proof.
const CHUNK_BYTES: usize = 32 * 1024;

/// The streaming main-screen flush state: feeds rows section by section, routes them between
/// the append stream and the repaint ring, writes in bounded chunks.
struct FlushSink {
    /// The last flush's row texts — the diff base.
    flushed: Vec<String>,
    /// The new frame's row texts (the NEXT flush's diff base).
    texts: Vec<String>,
    /// The most recent `screen_height` rows, for the repaint write.
    ring: std::collections::VecDeque<crate::Line>,
    /// The encoded append rows not yet handed to `out`.
    chunk: String,
    screen_height: usize,
    /// Set once a row extends the flushed frame: every later row appends.
    appending: bool,
    /// Set when a row inside the flushed frame changed: every row lands
    /// in the repaint ring instead.
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
                    // A completed chunk write is exit-path progress for
                    // the exit guard's force-quit hold.
                    crate::exit_guard::note_exit_progress();
                }
            } else if self.repaint || index >= self.flushed.len() {
                // A changed row turns the write into a repaint; a row
                // past the flushed frame turns it into an append.
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

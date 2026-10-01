//! The on-disk ledger tail rule (TS `event-log.ts`, this ledger only):
//! append-only JSONL, one `O_APPEND` write per event, no fsync (TS
//! `appendSync` without `durable`).
//!
//! Tail rule: an unterminated final line is an uncommitted append —
//! skipped on replay even when it parses, truncated at its byte offset
//! before the next append, never newline-completed (completion would
//! turn a line a strict parser rejects into permanent interior poison).
//! Interior malformed lines fail closed. Repair runs only on append,
//! never on read: a viewer may replay a live writer's log.

use std::io::Write;
use std::path::Path;

use super::SemanticEdgeLedgerEvent;

/// Read every terminated line (the missing-file decision at the open: no
/// check-then-read window). A torn final line is skipped; an interior
/// line that fails the parse fails the whole read.
///
/// # Errors
///
/// Returns the underlying I/O error, or an `InvalidData` error naming the
/// corrupt line for a parse failure.
pub(super) fn read_events(path: &Path) -> std::io::Result<Option<Vec<SemanticEdgeLedgerEvent>>> {
    let contents = match std::fs::read(path) {
        Ok(contents) => contents,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(None),
        Err(error) => return Err(error),
    };
    let ends_with_newline = contents.last() == Some(&b'\n');
    let lines = String::from_utf8_lossy(&contents);
    let lines = lines.split('\n').collect::<Vec<_>>();
    let mut events = Vec::new();
    for (index, line) in lines.iter().enumerate() {
        let line = line.trim();
        if line.is_empty() {
            continue;
        }
        // The unterminated final line (the last split element when the
        // contents do not end in a newline): an uncommitted append.
        if index == lines.len() - 1 && !ends_with_newline {
            continue;
        }
        let event: SemanticEdgeLedgerEvent = serde_json::from_str(line).map_err(|error| {
            std::io::Error::other(format!(
                "corrupt semantic-edge ledger line {}: {error}",
                index + 1
            ))
        })?;
        events.push(event);
    }
    Ok(Some(events))
}

/// Append one event as a single `O_APPEND` write, repairing a torn tail
/// first (TS `appendSync`). The ledger dir is created private (`0o700`)
/// and the file private (`0o600`) where mode bits exist.
///
/// # Errors
///
/// Returns the underlying I/O error when the dir, the repair, or the
/// append fails.
pub(super) fn append_event(path: &Path, event: &SemanticEdgeLedgerEvent) -> std::io::Result<()> {
    let mut line = serde_json::to_string(event).map_err(|error| {
        std::io::Error::other(format!("semantic-edge event not serializable: {error}"))
    })?;
    line.push('\n');
    if let Some(parent) = path.parent() {
        crate::platform::perms::create_dir_all_private(parent)?;
    }
    repair_torn_tail(path)?;
    let mut options = std::fs::OpenOptions::new();
    options.create(true).append(true);
    crate::platform::perms::set_private_mode(&mut options);
    let mut file = options.open(path)?;
    write_line_once(&mut file, line.as_bytes(), path)
}

/// Issue exactly one write: a short append cannot be completed safely after
/// another writer's append, and must disable the recorder instead (TS
/// `EventLog.appendSync`'s short-write check).
fn write_line_once(writer: &mut impl Write, line: &[u8], path: &Path) -> std::io::Result<()> {
    let written = writer.write(line)?;
    if written != line.len() {
        return Err(std::io::Error::other(format!(
            "semantic-edge ledger {}: short write ({written} of {} bytes)",
            path.display(),
            line.len()
        )));
    }
    Ok(())
}

/// Truncate an unterminated tail at its byte offset (all offsets are BYTE
/// offsets: string indices diverge from them as soon as any record carries
/// multi-byte UTF-8). The healthy path reads one byte (TS `appendSync`
/// stats and checks the final byte); only a torn tail reads the file.
///
/// # Errors
///
/// Returns the underlying I/O error when the read or the truncate fails.
fn repair_torn_tail(path: &Path) -> std::io::Result<()> {
    use std::io::{Read as _, Seek as _};
    let mut file = match std::fs::OpenOptions::new()
        .read(true)
        .write(true)
        .open(path)
    {
        Ok(file) => file,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(()),
        Err(error) => return Err(error),
    };
    if file.metadata()?.len() == 0 {
        return Ok(());
    }
    file.seek(std::io::SeekFrom::End(-1))?;
    let mut last = [0u8; 1];
    file.read_exact(&mut last)?;
    if last[0] == b'\n' {
        return Ok(());
    }
    file.seek(std::io::SeekFrom::Start(0))?;
    let mut contents = Vec::new();
    file.read_to_end(&mut contents)?;
    let keep = contents
        .iter()
        .rposition(|byte| *byte == b'\n')
        .map_or(0, |position| position + 1);
    file.set_len(keep as u64)
}

#[cfg(test)]
mod tests {
    use std::io::{self, Write};

    use super::write_line_once;

    /// A partial append must not be retried: a rival's complete line could
    /// land between writes and turn two valid records into interior poison.
    struct ShortWriter {
        writes: usize,
    }

    impl Write for ShortWriter {
        fn write(&mut self, bytes: &[u8]) -> io::Result<usize> {
            self.writes += 1;
            Ok(bytes.len() / 2)
        }

        fn flush(&mut self) -> io::Result<()> {
            Ok(())
        }
    }

    #[test]
    fn short_append_fails_without_a_second_write() {
        let mut writer = ShortWriter { writes: 0 };
        let error = write_line_once(
            &mut writer,
            b"{\"type\":\"request_started\"}\n",
            std::path::Path::new("ledger"),
        )
        .expect_err("a short append must fail");
        assert_eq!(writer.writes, 1);
        assert!(error.to_string().contains("short write"));
    }
}

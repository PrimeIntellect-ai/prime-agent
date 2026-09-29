//! The crash-repair + load concern (moved with its concern): the
//! serialized-entry wire, the bounded damage scan, the torn-tail
//! repair, and the header-validating load.

use super::{atomic_write, parse_session_entries, FileEntry, Path};

pub(super) fn serialize_entry(entry: &FileEntry) -> String {
    serde_json::to_string(entry).unwrap_or_default()
}

// ---------------------------------------------------------------------------
// Crash repair
// ---------------------------------------------------------------------------

const REPAIR_SUSPICION_WINDOW_BYTES: usize = 1024 * 1024;

fn parses_as_json(line: &[u8]) -> bool {
    serde_json::from_slice::<serde_json::Value>(line).is_ok()
}

/// A bounded tail read gates the full repair scan: clean opens stay O(window).
fn tail_looks_damaged(target_path: &Path) -> bool {
    use std::io::Read;
    use std::io::Seek;
    let Ok(mut file) = std::fs::File::open(target_path) else {
        return false;
    };
    let Ok(size) = file.metadata().map(|meta| meta.len() as usize) else {
        return true;
    };
    if size == 0 {
        return false;
    }
    let window_bytes = size.min(REPAIR_SUSPICION_WINDOW_BYTES);
    let mut window = vec![0u8; window_bytes];
    if file
        .seek(std::io::SeekFrom::Start((size - window_bytes) as u64))
        .is_err()
    {
        return true;
    }
    if file.read_exact(&mut window).is_err() {
        return true;
    }
    if window.contains(&0) {
        return true;
    }
    if window.last() != Some(&0x0a) {
        return true;
    }
    let previous_newline = window[..window_bytes - 1]
        .iter()
        .rposition(|byte| *byte == 0x0a);
    match previous_newline {
        None => window_bytes < size,
        Some(position) => {
            let last_line = &window[position + 1..window_bytes - 1];
            !last_line.is_empty() && !parses_as_json(last_line)
        }
    }
}

/// Repair crash damage (torn tail, zero-filled append) once at open.
pub(super) fn repair_jsonl_damage(file_path: &Path) {
    if !tail_looks_damaged(file_path) {
        return;
    }
    let Ok(buffer) = std::fs::read(file_path) else {
        return;
    };
    if buffer.is_empty() {
        return;
    }
    let mut kept_lines: Vec<&[u8]> = Vec::new();
    let mut dropped_lines = 0usize;
    let mut repaired_tail = false;
    let mut dirty = false;
    let mut start = 0usize;
    while start < buffer.len() {
        let end = match buffer[start..].iter().position(|byte| *byte == 0x0a) {
            Some(offset) => start + offset,
            None => buffer.len(),
        };
        let terminated = end < buffer.len();
        let mut line_start = start;
        while line_start < end && buffer[line_start] == 0 {
            line_start += 1;
        }
        let line = &buffer[line_start..end];
        if line_start > start {
            // Zero-filled prefix: recover what parses, drop the rest.
            dirty = true;
            if !line.is_empty() && parses_as_json(line) {
                kept_lines.push(line);
            } else {
                dropped_lines += 1;
            }
        } else if !terminated {
            // Unterminated tail merges with the next append: re-terminate.
            dirty = true;
            if !line.is_empty() && parses_as_json(line) {
                kept_lines.push(line);
                repaired_tail = true;
            } else {
                dropped_lines += 1;
            }
        } else if end + 1 >= buffer.len() && !line.is_empty() && !parses_as_json(line) {
            dirty = true;
            dropped_lines += 1;
        } else {
            kept_lines.push(line);
        }
        start = end + 1;
    }
    if !dirty {
        return;
    }
    let mut content = String::new();
    for (index, line) in kept_lines.iter().enumerate() {
        if index > 0 {
            content.push('\n');
        }
        content.push_str(&String::from_utf8_lossy(line));
    }
    if !content.is_empty() {
        content.push('\n');
    }
    // TS repairs crash damage through `writeFileAtomicSync`: the repaired
    // file lands by rename, never as a torn in-place write.
    let _ = atomic_write(file_path, &content);
    let _ = (repaired_tail, dropped_lines);
}

/// Load entries from a session file (repairing damage first when persisting).
#[must_use]
pub fn load_entries_from_file(file_path: &Path, repair: bool) -> Vec<FileEntry> {
    if !file_path.exists() {
        return Vec::new();
    }
    if repair {
        repair_jsonl_damage(file_path);
    }
    let Ok(content) = std::fs::read_to_string(file_path) else {
        return Vec::new();
    };
    finalize_loaded_entries(parse_session_entries(&content))
}

/// Finalize: entries need a valid header first; attributions fold in.
fn finalize_loaded_entries(entries: Vec<FileEntry>) -> Vec<FileEntry> {
    if entries.is_empty() {
        return entries;
    }
    let valid_header = matches!(&entries[0], FileEntry::Header { .. });
    if !valid_header {
        return Vec::new();
    }
    entries
}

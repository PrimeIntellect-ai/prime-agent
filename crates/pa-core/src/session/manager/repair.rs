//! The crash-repair + load concern: the serialized-entry wire, the bounded
//! damage scan, the torn-tail repair, and the header-validating load.

use super::{parse_session_entries, FileEntry, Path};

pub(super) fn serialize_entry(entry: &FileEntry) -> String {
    serde_json::to_string(entry).unwrap_or_default()
}

const REPAIR_SUSPICION_WINDOW_BYTES: usize = 1024 * 1024;

fn parses_as_json(line: &[u8]) -> bool {
    serde_json::from_slice::<serde_json::Value>(line).is_ok()
}

/// A bounded tail read gates the repair scan: clean opens never copy the file.
fn tail_looks_damaged(target_path: &Path) -> bool {
    use std::io::{Read, Seek};

    let Ok(mut file) = std::fs::File::open(target_path) else {
        return false;
    };
    let Ok(size) = file.metadata().map(|meta| meta.len()) else {
        return true;
    };
    if size == 0 {
        return false;
    }
    let mut window = vec![0u8; size.min(REPAIR_SUSPICION_WINDOW_BYTES as u64) as usize];
    let mut end = size;
    while end > 0 {
        let start = end.saturating_sub(REPAIR_SUSPICION_WINDOW_BYTES as u64);
        let chunk = (end - start) as usize;
        if file.seek(std::io::SeekFrom::Start(start)).is_err()
            || file.read_exact(&mut window[..chunk]).is_err()
        {
            return true;
        }
        if window[..chunk].contains(&0) {
            return true;
        }
        if end == size && window[chunk - 1] != b'\n' {
            return true;
        }
        let search_end = if end == size { chunk - 1 } else { chunk };
        if let Some(position) = window[..search_end].iter().rposition(|byte| *byte == b'\n') {
            let last_line_start = start + position as u64 + 1;
            return !last_line_is_json(&mut file, last_line_start, size - 1);
        }
        end = start;
    }
    !last_line_is_json(&mut file, 0, size - 1)
}

fn last_line_is_json(file: &mut std::fs::File, start: u64, end: u64) -> bool {
    use std::io::{Read, Seek};

    if start == end {
        return true;
    }
    if file.seek(std::io::SeekFrom::Start(start)).is_err() {
        return false;
    }
    let reader = std::io::BufReader::new(file.take(end - start));
    serde_json::from_reader::<_, serde::de::IgnoredAny>(reader).is_ok()
}

fn first_line_is_session_header(file_path: &Path) -> bool {
    use std::io::BufRead;
    let Ok(file) = std::fs::File::open(file_path) else {
        return false;
    };
    let mut first_line = String::new();
    if std::io::BufReader::new(file)
        .read_line(&mut first_line)
        .is_err()
    {
        return false;
    }
    parse_session_entries(&first_line)
        .first()
        .is_some_and(|entry| matches!(entry, FileEntry::Header { .. }))
}

/// Repair crash damage (torn tail, zero-filled append) once at open.
pub fn repair_jsonl_damage(file_path: &Path) {
    use std::io::{BufRead, Write};

    let Ok(target_path) = std::fs::canonicalize(file_path) else {
        return;
    };
    let file_path = target_path.as_path();
    if !tail_looks_damaged(file_path) {
        return;
    }
    if !first_line_is_session_header(file_path) {
        return;
    }
    let temp =
        std::path::PathBuf::from(format!("{}.tmp{}", file_path.display(), std::process::id()));
    let _ = (|| -> std::io::Result<()> {
        let source = std::fs::File::open(file_path)?;
        let mut reader = std::io::BufReader::new(source);
        let mut options = std::fs::OpenOptions::new();
        options.create(true).write(true).truncate(true);
        crate::platform::perms::set_private_mode(&mut options);
        let mut output = options.open(&temp)?;
        let mut line = Vec::new();
        let mut dirty = false;
        while reader.read_until(b'\n', &mut line)? != 0 {
            let terminated = line.last() == Some(&b'\n');
            let end = line.len() - usize::from(terminated);
            let last = reader.fill_buf()?.is_empty();
            let prefix = line[..end].iter().take_while(|byte| **byte == 0).count();
            let content = &line[prefix..end];
            let keep = if prefix > 0 {
                // Zero-filled prefix: recover what parses, drop the rest.
                dirty = true;
                !content.is_empty() && parses_as_json(content)
            } else if !terminated {
                // Unterminated tail merges with the next append: re-terminate.
                dirty = true;
                !content.is_empty() && parses_as_json(content)
            } else if last && !content.is_empty() && !parses_as_json(content) {
                dirty = true;
                false
            } else {
                true
            };
            if keep {
                output.write_all(String::from_utf8_lossy(content).as_bytes())?;
                output.write_all(b"\n")?;
            }
            line.clear();
        }
        if !dirty {
            return Ok(());
        }
        output.sync_all()?;
        drop(output);
        drop(reader);
        // TS repairs crash damage through `writeFileAtomicSync`: the repaired
        // file lands by rename, never as a torn in-place write.
        crate::platform::rename_onto(&temp, file_path)
    })();
    let _ = std::fs::remove_file(&temp);
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

//! Char-index helpers for editor text manipulation and key-id decoding.

// ---- helpers -------------------------------------------------------------

/// Normalize CRLF/CR to LF and tabs to 4 spaces (TS normalizeText).
pub fn normalize_text(text: &str) -> String {
    text.replace("\r\n", "\n")
        .replace('\r', "\n")
        .replace('\t', "    ")
}

/// Decode CSI-u Ctrl+letter re-encodings inside a pasted block (TS
/// `handlePaste`'s pre-filter decode): a tmux popup with
/// `extended-keys-format=csi-u` re-encodes control bytes inside bracketed
/// paste as `ESC [ <codepoint> ; 5 u`. Decode them back to their literal
/// byte so the per-char filter below keeps newlines instead of leaking the
/// printable tail into the editor: both `a`-`z` (minus 96) and `A`-`Z`
/// (minus 64) map to the control byte 1-26 (`j` -> LF); any other
/// sequence stays literal.
pub(crate) fn decode_paste_ctrl_sequences(text: &str) -> String {
    let bytes = text.as_bytes();
    let mut out = String::with_capacity(text.len());
    let mut i = 0;
    while i < bytes.len() {
        if bytes[i] == b'\x1b' && i + 1 < bytes.len() && bytes[i + 1] == b'[' {
            let mut j = i + 2;
            let mut codepoint = 0u32;
            let mut digits = false;
            while j < bytes.len() && bytes[j].is_ascii_digit() {
                codepoint = codepoint * 10 + u32::from(bytes[j] - b'0');
                digits = true;
                j += 1;
            }
            if digits && j + 2 < bytes.len() {
                let suffix = &bytes[j..j + 3];
                if suffix == b";5u" {
                    let decoded = if (97..=122).contains(&codepoint) {
                        char::from_u32(codepoint - 96)
                    } else if (65..=90).contains(&codepoint) {
                        char::from_u32(codepoint - 64)
                    } else {
                        None
                    };
                    if let Some(decoded) = decoded {
                        out.push(decoded);
                        i = j + 3;
                        continue;
                    }
                }
            }
        }
        // Push the full UTF-8 char starting at this byte.
        let ch = text[i..].chars().next().expect("a char starts here");
        out.push(ch);
        i += ch.len_utf8();
    }
    out
}

/// Split a string at a char (not byte) index.
pub(crate) fn split_at_char(s: &str, char_idx: usize) -> (String, String) {
    let mut left = String::new();
    let mut count = 0usize;
    for c in s.chars() {
        if count < char_idx {
            left.push(c);
            count += 1;
        } else {
            break;
        }
    }
    let right: String = s.chars().skip(char_idx).collect();
    (left, right)
}

pub(crate) fn char_prefix(s: &str, char_idx: usize) -> String {
    split_at_char(s, char_idx).0
}

pub(crate) fn char_suffix(s: &str, char_idx: usize) -> String {
    split_at_char(s, char_idx).1
}

pub(crate) fn char_at(s: &str, char_idx: usize) -> Option<char> {
    s.chars().nth(char_idx)
}

/// Find `needle` (single char) after a char index.
pub(crate) fn char_find_after(line: &str, from_char: usize, needle: &str) -> Option<usize> {
    let n = needle.chars().next()?;
    if from_char == usize::MAX {
        return line.chars().position(|c| c == n);
    }
    line.chars()
        .enumerate()
        .skip_while(|(i, _)| *i <= from_char)
        .find(|(_, c)| *c == n)
        .map(|(i, _)| i)
}

pub(crate) fn char_find_before(line: &str, from_char: usize, needle: &str) -> Option<usize> {
    let n = needle.chars().next()?;
    let limit = if from_char == usize::MAX {
        line.chars().count()
    } else {
        from_char
    };
    line.chars()
        .take(limit)
        .collect::<Vec<_>>()
        .iter()
        .rposition(|&c| c == n)
}

/// Decode a printable character from a key id ("" for control keys).
pub(crate) fn decode_printable(input: &str) -> Option<String> {
    let (mods, key) = split_key_id(input);
    if !matches!(mods.as_str(), "" | "shift") {
        return None;
    }
    let printable = match key.as_str() {
        "space" => " ".to_string(),
        "enter" | "tab" | "escape" | "backspace" | "delete" | "up" | "down" | "left" | "right"
        | "home" | "end" | "pageUp" | "pageDown" => return None,
        k => k.to_string(),
    };
    if printable.chars().count() == 1 {
        if mods == "shift" {
            return Some(printable.to_uppercase());
        }
        Some(printable)
    } else {
        None
    }
}

fn split_key_id(input: &str) -> (String, String) {
    // `+` is itself a key id (shift+= on a US layout): a TRAILING
    // separator is the literal plus key, never an empty segment (`+` ->
    // key `+`, `ctrl++` -> ctrl + `+`). TS needs no such rule — its
    // printable insert reads the raw character before key-id parsing.
    let parts: Vec<&str> = input.split('+').collect();
    if parts.len() > 1 && parts[parts.len() - 1].is_empty() {
        return (parts[..parts.len() - 2].join("+"), "+".to_string());
    }
    if parts.len() > 1 {
        (
            parts[..parts.len() - 1].join("+"),
            parts[parts.len() - 1].to_string(),
        )
    } else {
        (String::new(), input.to_string())
    }
}

/// Match `(?:^|[ \t])(?:@|...)...` symbol-token suffix used for @/# autocomplete.
pub(crate) fn ends_with_symbol_token(text: &str) -> bool {
    let chars: Vec<char> = text.chars().collect();
    if chars.is_empty() {
        return false;
    }
    // find last whitespace boundary
    let start = chars
        .iter()
        .rposition(|&c| c == ' ' || c == '\t')
        .map_or(0, |p| p + 1);
    let token: String = chars[start..].iter().collect();
    let mut tchars = token.chars();
    matches!(tchars.next(), Some('@' | '#')) && !token.contains(char::is_whitespace)
}

#[cfg(test)]
mod tests {
    use super::decode_paste_ctrl_sequences;

    #[test]
    fn decodes_csi_u_ctrl_letters_to_literal_bytes() {
        // Ctrl+J inside a tmux csi-u paste decodes to LF (TS: cp - 96).
        assert_eq!(decode_paste_ctrl_sequences("\x1b[106;5u"), "\n");
        // Uppercase form decodes the same control byte (cp - 64).
        assert_eq!(decode_paste_ctrl_sequences("\x1b[74;5u"), "\n");
        // Ctrl+I is the tab byte; normalize_text expands it later.
        assert_eq!(decode_paste_ctrl_sequences("\x1b[105;5u"), "\t");
        assert_eq!(decode_paste_ctrl_sequences("\x1b[73;5u"), "\t");
    }

    #[test]
    fn leaves_non_matching_sequences_literal() {
        // A non-ctrl modifier (shift) and out-of-range codepoints stay.
        assert_eq!(decode_paste_ctrl_sequences("\x1b[106;2u"), "\x1b[106;2u");
        assert_eq!(decode_paste_ctrl_sequences("\x1b[13;5u"), "\x1b[13;5u");
        // Incomplete sequences and plain text pass through untouched.
        assert_eq!(decode_paste_ctrl_sequences("a\x1b[1"), "a\x1b[1");
        assert_eq!(decode_paste_ctrl_sequences("plain text"), "plain text");
        // Multi-byte UTF-8 survives byte-wise scanning.
        assert_eq!(decode_paste_ctrl_sequences("héllo"), "héllo");
    }

    #[test]
    fn decodes_only_the_reencoded_ctrl_bytes_in_a_block() {
        // A re-encoded newline inside otherwise-normal paste content.
        let input = "alpha\x1b[106;5ubeta";
        assert_eq!(decode_paste_ctrl_sequences(input), "alpha\nbeta");
    }
}

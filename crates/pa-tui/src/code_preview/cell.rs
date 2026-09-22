//! Port of `packages/coding-agent/src/core/tools/ipython-cell-code.ts`.

/// Matches leading blank lines and a `%%bash` cell-magic line.
#[cfg_attr(not(test), allow(dead_code))]
fn bash_cell_magic_match(code: &str) -> Option<usize> {
    let bytes = code.as_bytes();
    let mut i = 0;
    // (?:[ \t]*\r?\n)*
    loop {
        let start = i;
        while i < bytes.len() && (bytes[i] == b' ' || bytes[i] == b'\t') {
            i += 1;
        }
        if i < bytes.len() && bytes[i] == b'\r' && i + 1 < bytes.len() && bytes[i + 1] == b'\n' {
            i += 2;
        } else if i < bytes.len() && bytes[i] == b'\n' {
            i += 1;
        } else {
            i = start;
            break;
        }
    }
    // [ \t]*%%bash
    while i < bytes.len() && (bytes[i] == b' ' || bytes[i] == b'\t') {
        i += 1;
    }
    if !code[i..].starts_with("%%bash") {
        return None;
    }
    i += "%%bash".len();
    // \b: the char after "%%bash" must not be a word char.
    if let Some(next) = code[i..].chars().next() {
        if next.is_alphanumeric() || next == '_' {
            return None;
        }
    }
    // [^\r\n]* then (\r?\n or end of string)
    while i < bytes.len() && bytes[i] != b'\r' && bytes[i] != b'\n' {
        i += 1;
    }
    if i < bytes.len() && bytes[i] == b'\r' && i + 1 < bytes.len() && bytes[i + 1] == b'\n' {
        i += 2;
    } else if i < bytes.len() && bytes[i] == b'\n' {
        i += 1;
    }
    Some(i)
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ParsedIpythonBashCell {
    pub body: String,
}

/// Detect an `%%bash` cell magic and return the cell body that follows it.
pub fn parse_ipython_bash_cell(code: &str) -> Option<ParsedIpythonBashCell> {
    let matched = bash_cell_magic_match(code)?;
    Some(ParsedIpythonBashCell {
        body: code[matched..].to_string(),
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_bash_cell() {
        let p = parse_ipython_bash_cell("%%bash\necho hi").unwrap();
        assert_eq!(p.body, "echo hi");
    }

    #[test]
    fn ignores_leading_blank_lines() {
        let p = parse_ipython_bash_cell("\n\t\n  %%bash -l\nls").unwrap();
        assert_eq!(p.body, "ls");
    }

    #[test]
    fn no_magic() {
        assert!(parse_ipython_bash_cell("print(1)").is_none());
        assert!(parse_ipython_bash_cell("x = '%%bash'").is_none());
        assert!(parse_ipython_bash_cell("  %%bashish\n").is_none());
    }
}

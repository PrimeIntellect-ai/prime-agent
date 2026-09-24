//! `prime-agent session export <file> [output]`: the HTML export of a saved
//! session file (TS main.ts' `--export` branch, reached through the
//! `session export` rewrite; the export itself is pa-core's `export_from_file`).

use crate::args::Args;

/// Run the export and print the TS output: the written path on success
/// (`Exported to: ...`), the error message on failure (the main entry's
/// `Error: ...` prefix + exit 1).
pub fn run(parsed: &Args, agent_dir: &std::path::Path) -> Result<i32, String> {
    let Some(input) = parsed.export.as_deref() else {
        return Err("--export requires a value".to_string());
    };
    let output = parsed.messages.first().map(String::as_str);
    match pa_core::export_html::export_from_file(std::path::Path::new(input), output, agent_dir) {
        Ok(path) => {
            println!("Exported to: {path}");
            Ok(0)
        }
        Err(error) => Err(error.to_string()),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn parsed_with(export: Option<&str>, messages: &[&str]) -> Args {
        crate::args::parse_args(&{
            let mut args: Vec<String> = Vec::new();
            if let Some(export) = export {
                args.push(crate::args::INTERNAL_RUNTIME_COMMAND_MARKER.to_string());
                args.push("--export".to_string());
                args.push(export.to_string());
            }
            args.extend(messages.iter().map(std::string::ToString::to_string));
            args
        })
    }

    /// A fixture session exports to the requested output and the run prints
    /// the TS success line.
    #[test]
    fn exports_a_session_file() {
        let dir = tempfile::TempDir::new().expect("temp dir");
        let input = dir.path().join("s.jsonl");
        std::fs::write(
            &input,
            concat!(
                r##"{"type":"session","id":"s","version":3,"timestamp":"2026-01-01T00:00:00.000Z","cwd":"/tmp"}"##,
                "\n",
                r##"{"type":"message","id":"e1","parentId":null,"timestamp":"2026-01-01T00:00:01.000Z","message":{"role":"user","content":"hi"}}"##,
                "\n",
            ),
        )
        .expect("write session");
        let out = dir.path().join("exported.html");
        let parsed = parsed_with(Some(input.to_str().unwrap()), &[out.to_str().unwrap()]);
        let agent_dir = dir.path().join("agent");
        std::fs::create_dir_all(&agent_dir).expect("agent dir");
        let code = run(&parsed, &agent_dir).expect("export runs");
        assert_eq!(code, 0);
        assert!(out.exists());
    }

    /// A missing input file surfaces the TS error (through the main
    /// entry's `Error: ...` prefix).
    #[test]
    fn missing_file_errors() {
        let dir = tempfile::TempDir::new().expect("temp dir");
        let parsed = parsed_with(Some("/nonexistent/session.jsonl"), &[]);
        let error = run(&parsed, &dir.path().join("agent")).expect_err("missing file must fail");
        assert!(error.starts_with("File not found:"), "unexpected: {error}");
    }
}

//! `prime-agent factory`: the machine library commands.
//!
//! Every subcommand — list included — is one `rlm.factory.cli_dispatch`
//! payload through the kernel Python. The kernel owns the whole library
//! contract: the bundled seeds ship as wheel package data inside the
//! runtime, the personal library lives under the agent dir, the strict
//! MACHINE.md parser gates what lists, and the write-time validator gates
//! what persists (an invalid spec never persists; the exact error
//! sentences reach this command's output verbatim). The CLI never
//! re-implements resolution or parsing, so the two sides cannot drift.

use std::io::Write as _;
use std::path::PathBuf;
use std::process::{Command, Stdio};

use serde_json::{json, Value};

/// One machine as the kernel lists it (`cli_dispatch`'s `list` op).
#[derive(Debug, Clone, PartialEq, serde::Deserialize)]
struct MachineListing {
    name: String,
    description: String,
    #[serde(default)]
    version: String,
    #[serde(default)]
    author: String,
    /// The library level: `repo` (the bundled library) or `user`.
    source: String,
    path: String,
}

/// The thin runner executed by the kernel Python: one JSON payload in on
/// stdin, one JSON result out on stdout (`rlm.factory.cli_dispatch`).
const CLI_DISPATCH_RUNNER: &str = concat!(
    "import json, sys\n",
    "from rlm.factory import cli_dispatch\n",
    "payload = json.loads(sys.stdin.read() or \"{}\")\n",
    "print(json.dumps(cli_dispatch(payload)))\n",
);

/// The parsed `prime-agent factory` invocation.
#[derive(Debug, PartialEq, Eq)]
enum FactoryCommand {
    List {
        json: bool,
    },
    Import {
        path: String,
        json: bool,
    },
    Export {
        name: String,
        out: String,
        json: bool,
    },
}

/// Parse the subcommand and its flags; `Err` carries a usage hint.
fn parse_factory_command(args: &[String]) -> Result<FactoryCommand, String> {
    let children: Vec<&str> = crate::command_registry::get_child_command_specs(&["factory"])
        .into_iter()
        .map(|spec| spec.path[spec.path.len() - 1])
        .collect();
    let Some(subcommand) = args.first() else {
        return Err(String::new());
    };
    if !children.contains(&subcommand.as_str()) {
        let suggestion = crate::command_registry::find_command_suggestion(subcommand, &children);
        return Err(format!(
            "Unknown factory command: {subcommand}{}",
            suggestion.map_or_else(String::new, |s| format!(" (did you mean \"{s}\"?)"))
        ));
    }
    let mut json = false;
    let mut operands: Vec<String> = Vec::new();
    let mut out: Option<String> = None;
    let mut rest = args[1..].iter();
    while let Some(arg) = rest.next() {
        match arg.as_str() {
            "--json" => json = true,
            "--out" => {
                let Some(value) = rest.next() else {
                    return Err("--out requires a file path".to_string());
                };
                out = Some(value.clone());
            }
            other if other.starts_with('-') => {
                return Err(format!("unknown option {other:?}"));
            }
            other => operands.push(other.to_string()),
        }
    }
    match subcommand.as_str() {
        "list" => {
            if !operands.is_empty() {
                return Err("Usage: prime-agent factory list [--json]".to_string());
            }
            Ok(FactoryCommand::List { json })
        }
        "import" => {
            if operands.len() != 1 {
                return Err("Usage: prime-agent factory import <path> [--json]".to_string());
            }
            Ok(FactoryCommand::Import {
                path: operands.remove(0),
                json,
            })
        }
        "export" => {
            if operands.len() != 1 {
                return Err(
                    "Usage: prime-agent factory export <name> --out <path> [--json]".to_string(),
                );
            }
            let Some(out) = out else {
                return Err(
                    "Usage: prime-agent factory export <name> --out <path> [--json]".to_string(),
                );
            };
            Ok(FactoryCommand::Export {
                name: operands.remove(0),
                out,
                json,
            })
        }
        _ => Err(String::new()),
    }
}

/// Run the `factory` command; returns the process exit code.
pub fn run_factory_command(args: &[String]) -> i32 {
    let command = match parse_factory_command(args) {
        Ok(command) => command,
        Err(empty_hint) if empty_hint.is_empty() => {
            eprintln!("Missing factory command.");
            eprintln!("Run \"prime-agent help factory\" for usage.");
            return 1;
        }
        Err(error) => {
            eprintln!("Error: {error}");
            eprintln!("Run `prime-agent help factory` for usage.");
            return 1;
        }
    };
    match command {
        FactoryCommand::List { json } => run_list(json),
        FactoryCommand::Import { path, json } => run_import(&path, json),
        FactoryCommand::Export { name, out, json } => run_export(&name, &out, json),
    }
}

/// The `list` payload: the op alone — the kernel resolves every library
/// directory itself.
fn list_payload() -> Value {
    json!({"op": "list"})
}

/// The `import` payload: the machine file the user pointed at.
fn import_payload(path: &std::path::Path) -> Value {
    json!({
        "op": "import",
        "path": path.display().to_string(),
    })
}

/// The `export` payload: the name and the out target the user chose.
fn export_payload(name: &str, out: &std::path::Path) -> Value {
    json!({
        "op": "export",
        "name": name,
        "out": out.display().to_string(),
    })
}

/// `factory list`: library contents with descriptions.
fn run_list(json: bool) -> i32 {
    let payload = list_payload();
    match resolve_kernel_python().and_then(|python| dispatch_via_kernel(&python, &payload)) {
        Ok(result) => render_list(&result, json),
        Err(error) => {
            eprintln!("Error: {error}");
            1
        }
    }
}

/// Render one `list` dispatch result: errors verbatim, warnings as
/// warnings, machines as rows (or the whole payload for `--json`).
fn render_list(result: &Value, json: bool) -> i32 {
    if let Some(code) = print_dispatch_errors(result) {
        return code;
    }
    if json {
        println!(
            "{}",
            serde_json::to_string_pretty(result).unwrap_or_default()
        );
        return 0;
    }
    let machines: Vec<MachineListing> = result
        .get("machines")
        .cloned()
        .map(|value| serde_json::from_value(value).unwrap_or_default())
        .unwrap_or_default();
    for warning in result
        .get("warnings")
        .and_then(Value::as_array)
        .map(|warnings| {
            warnings
                .iter()
                .filter_map(Value::as_str)
                .collect::<Vec<_>>()
        })
        .unwrap_or_default()
    {
        eprintln!("Warning: {warning}");
    }
    if machines.is_empty() {
        println!("No machines in the library.");
        return 0;
    }
    let name_width = machines
        .iter()
        .map(|machine| machine.name.chars().count())
        .max()
        .unwrap_or(0);
    for machine in &machines {
        println!("{}", listing_row(machine, name_width));
    }
    0
}

fn pad_end(text: &str, width: usize) -> String {
    let length = text.chars().count();
    if length >= width {
        return text.to_string();
    }
    let mut padded = String::from(text);
    padded.extend(std::iter::repeat_n(' ', width - length));
    padded
}

/// Format one listing row (exposed for the unit tests).
#[must_use]
fn listing_row(machine: &MachineListing, name_width: usize) -> String {
    format!(
        "{}  {}  {}",
        pad_end(&machine.name, name_width),
        machine.source.as_str(),
        machine.description
    )
}

/// Resolve the kernel Python (bootstrapping the venv on first use), the
/// same interpreter the factory gate lives in.
fn resolve_kernel_python() -> Result<PathBuf, String> {
    let runtime = tokio::runtime::Builder::new_current_thread()
        .enable_all()
        .build()
        .map_err(|error| format!("failed to start the CLI runtime: {error}"))?;
    runtime
        .block_on(pa_core::kernel::ensure_kernel_python(
            pa_core::kernel::EnsureKernelPythonOptions::default(),
        ))
        .map_err(|error| format!("kernel python unavailable: {error:#}"))
}

/// Drive one `rlm.factory.cli_dispatch` payload through the kernel Python.
fn dispatch_via_kernel(python: &std::path::Path, payload: &Value) -> Result<Value, String> {
    let mut child = Command::new(python);
    child
        .args(["-c", CLI_DISPATCH_RUNNER])
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());
    // Hidden window on Windows, matching the kernel probes.
    pa_core::platform::process::set_no_window(&mut child);
    let mut child = child
        .spawn()
        .map_err(|error| format!("failed to run the kernel python: {error}"))?;
    {
        let stdin = child.stdin.as_mut().expect("stdin was piped on this child");
        stdin
            .write_all(payload.to_string().as_bytes())
            .map_err(|error| format!("failed to send the payload: {error}"))?;
    }
    let output = child
        .wait_with_output()
        .map_err(|error| format!("failed to wait for the kernel python: {error}"))?;
    if !output.status.success() {
        let stderr = String::from_utf8_lossy(&output.stderr);
        let tail: Vec<&str> = stderr.lines().rev().take(3).collect::<Vec<_>>();
        let mut lines = tail;
        lines.reverse();
        return Err(format!(
            "the kernel python failed (exit {}): {}",
            output.status,
            lines.join(" | ")
        ));
    }
    let stdout = String::from_utf8_lossy(&output.stdout);
    serde_json::from_str(stdout.trim_end_matches(['\n', '\r']))
        .map_err(|error| format!("unreadable kernel result: {error}"))
}

/// `factory import <path>`: validate through the kernel gate and persist.
fn run_import(path: &str, json: bool) -> i32 {
    let source = crate::config::expand_tilde_path(path);
    if !source.is_file() {
        eprintln!("Error: machine file not found: {}", source.display());
        return 1;
    }
    let payload = import_payload(&source);
    match resolve_kernel_python().and_then(|python| dispatch_via_kernel(&python, &payload)) {
        Ok(result) => print_dispatch_result(&result, json, "imported"),
        Err(error) => {
            eprintln!("Error: {error}");
            1
        }
    }
}

/// `factory export <name> --out <path>`: serialize a machine to MACHINE.md.
fn run_export(name: &str, out: &str, json: bool) -> i32 {
    let payload = export_payload(name, &crate::config::expand_tilde_path(out));
    match resolve_kernel_python().and_then(|python| dispatch_via_kernel(&python, &payload)) {
        Ok(result) => print_dispatch_result(&result, json, "exported"),
        Err(error) => {
            eprintln!("Error: {error}");
            1
        }
    }
}

/// The failed dispatch's error sentences (the validator's exact text,
/// unwrapped from the JSON envelope — printing the `Value` would show the
/// JSON quoting around every sentence).
fn dispatch_error_sentences(result: &Value) -> Vec<&str> {
    result
        .get("errors")
        .and_then(Value::as_array)
        .map(|errors| errors.iter().filter_map(Value::as_str).collect())
        .unwrap_or_default()
}

/// Print a failed dispatch's errors verbatim (the validator's exact
/// sentences); `Some(exit code)` when the result is not an ok-payload.
fn print_dispatch_errors(result: &Value) -> Option<i32> {
    if result.get("ok").and_then(Value::as_bool).unwrap_or(false) {
        return None;
    }
    for error in dispatch_error_sentences(result) {
        eprintln!("Error: {error}");
    }
    Some(1)
}

/// Print one dispatch result: errors verbatim (the validator's exact
/// sentences), or the ok-payload as text or JSON. `verb` is the done-word
/// of the subcommand that ran ("imported" or "exported").
fn print_dispatch_result(result: &Value, json: bool, verb: &str) -> i32 {
    if let Some(code) = print_dispatch_errors(result) {
        return code;
    }
    if json {
        println!(
            "{}",
            serde_json::to_string_pretty(result).unwrap_or_default()
        );
        return 0;
    }
    let name = result
        .get("name")
        .and_then(Value::as_str)
        .unwrap_or_default();
    let path = result
        .get("path")
        .and_then(Value::as_str)
        .unwrap_or_default();
    let source = result.get("source").and_then(Value::as_str);
    if verb == "exported" {
        match source {
            Some(source) => println!("Exported {name} to {path} (from {source})."),
            None => println!("Exported {name} to {path}."),
        }
    } else {
        println!("Imported {name} into {path}.");
    }
    0
}

#[cfg(test)]
mod tests {
    use super::*;

    fn arg(words: &[&str]) -> Vec<String> {
        words.iter().map(ToString::to_string).collect()
    }

    #[test]
    fn parses_the_three_subcommands() {
        assert_eq!(
            parse_factory_command(&arg(&["list"])),
            Ok(FactoryCommand::List { json: false })
        );
        assert_eq!(
            parse_factory_command(&arg(&["list", "--json"])),
            Ok(FactoryCommand::List { json: true })
        );
        assert_eq!(
            parse_factory_command(&arg(&["import", "/tmp/m.MACHINE.md"])),
            Ok(FactoryCommand::Import {
                path: "/tmp/m.MACHINE.md".to_string(),
                json: false
            })
        );
        assert_eq!(
            parse_factory_command(&arg(&[
                "export",
                "sweep",
                "--out",
                "/tmp/s.MACHINE.md",
                "--json"
            ])),
            Ok(FactoryCommand::Export {
                name: "sweep".to_string(),
                out: "/tmp/s.MACHINE.md".to_string(),
                json: true
            })
        );
    }

    #[test]
    fn rejects_missing_and_unknown_subcommands() {
        assert_eq!(parse_factory_command(&arg(&[])), Err(String::new()));
        let unknown = parse_factory_command(&arg(&["run"]));
        assert!(unknown.is_err());
        assert!(unknown
            .unwrap_err()
            .contains("Unknown factory command: run"));
        let missing_out = parse_factory_command(&arg(&["export", "sweep"]));
        assert!(missing_out.is_err());
        assert!(missing_out
            .unwrap_err()
            .starts_with("Usage: prime-agent factory export"));
        let dangling_out = parse_factory_command(&arg(&["export", "sweep", "--out"]));
        assert!(dangling_out.is_err());
        assert!(dangling_out
            .unwrap_err()
            .starts_with("--out requires a file path"));
        let extra = parse_factory_command(&arg(&["list", "extra"]));
        assert!(extra.is_err());
    }

    #[test]
    fn dispatch_results_print_errors_verbatim() {
        let failure: Value = serde_json::from_str(
            r#"{"ok": false, "errors": ["run max_parallel must be an integer between 1 and 64"]}"#,
        )
        .expect("fixture");
        // Errors go to stderr inside print_dispatch_result; the exit code is the pin.
        assert_eq!(print_dispatch_result(&failure, false, "imported"), 1);
        assert_eq!(render_list(&failure, false), 1);
        // The sentence prints verbatim: unwrapped from the JSON envelope,
        // never with JSON quoting.
        assert_eq!(
            dispatch_error_sentences(&failure),
            ["run max_parallel must be an integer between 1 and 64"]
        );
    }

    #[test]
    fn dispatch_runner_contract_is_the_json_facade() {
        assert!(CLI_DISPATCH_RUNNER.contains("from rlm.factory import cli_dispatch"));
        assert!(CLI_DISPATCH_RUNNER.contains("print(json.dumps(cli_dispatch(payload)))"));
    }

    #[test]
    fn payloads_carry_only_what_the_user_typed() {
        // The kernel resolves every library directory itself, so the
        // payloads carry no directory fields to drift out of sync.
        assert_eq!(list_payload(), serde_json::json!({"op": "list"}));
        assert_eq!(
            import_payload(std::path::Path::new("/tmp/m.MACHINE.md")),
            serde_json::json!({"op": "import", "path": "/tmp/m.MACHINE.md"})
        );
        assert_eq!(
            export_payload("sweep", std::path::Path::new("/tmp/s.MACHINE.md")),
            serde_json::json!({
                "op": "export",
                "name": "sweep",
                "out": "/tmp/s.MACHINE.md",
            })
        );
    }

    #[test]
    fn listing_row_renders_name_source_description() {
        let listing = MachineListing {
            name: "sweep".to_string(),
            description: "A machine that sweeps.".to_string(),
            version: "1".to_string(),
            author: "Tester".to_string(),
            source: "repo".to_string(),
            path: "/machines/sweep/MACHINE.md".to_string(),
        };
        assert_eq!(
            listing_row(&listing, 5),
            "sweep  repo  A machine that sweeps."
        );
    }

    #[test]
    fn render_list_parses_the_kernel_listing() {
        let result: Value = serde_json::from_str(
            r#"{"ok": true, "machines": [
                {"name": "review-sweep", "description": "Sweep a branch.", "version": "1", "author": "Prime Agent", "source": "repo", "path": "/rlm/machines/review-sweep/MACHINE.md"},
                {"name": "mine", "description": "Personal.", "version": "", "author": "", "source": "user", "path": "/agent/machines/mine/MACHINE.md"}
            ], "warnings": []}"#,
        )
        .expect("fixture");
        // The rows print to stdout; the exit code pins the ok-path.
        assert_eq!(render_list(&result, false), 0);
        assert_eq!(render_list(&result, true), 0);
    }

    #[test]
    fn render_list_exits_cleanly_with_no_machines() {
        let result: Value = serde_json::from_str(r#"{"ok": true, "machines": [], "warnings": []}"#)
            .expect("fixture");
        assert_eq!(render_list(&result, false), 0);
    }
}

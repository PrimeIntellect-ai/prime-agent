//! `prime-agent factory`: the machine library commands.
//!
//! The library is `pa-factory`'s scan (the same one a session's
//! `factory.compile` resolves names with), so `list`, `export`, and
//! `convert` read files only. `import` also asks the kernel Python's
//! validator to check the spec's structure before the file persists (an
//! invalid spec never persists; the exact error sentences reach this
//! command's output verbatim).

use std::io::Write as _;
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};

use serde_json::{json, Value};

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
    Validate {
        path: String,
        json: bool,
    },
    Compile {
        path: String,
        params: Vec<String>,
    },
    Convert {
        source: String,
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
    let mut params: Vec<String> = Vec::new();
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
            "--param" if subcommand == "compile" => {
                let Some(value) = rest.next() else {
                    return Err("--param requires name=value".to_string());
                };
                params.push(value.clone());
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
        "validate" => match operands.as_slice() {
            [path] => Ok(FactoryCommand::Validate {
                path: path.clone(),
                json,
            }),
            _ => Err("Usage: prime-agent factory validate <dir> [--json]".to_string()),
        },
        "compile" => match operands.as_slice() {
            [path] if !json => Ok(FactoryCommand::Compile {
                path: path.clone(),
                params,
            }),
            _ => {
                Err("Usage: prime-agent factory compile <dir> [--param name=value]...".to_string())
            }
        },
        "convert" => match (operands.as_slice(), out) {
            ([source], Some(out)) => Ok(FactoryCommand::Convert {
                source: source.clone(),
                out,
                json,
            }),
            _ => Err(
                "Usage: prime-agent factory convert <MACHINE.md|name> --out <dir> [--json]"
                    .to_string(),
            ),
        },
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
        FactoryCommand::Validate { path, json } => {
            crate::factory_dir_command::run_validate(&path, json)
        }
        FactoryCommand::Compile { path, params } => {
            crate::factory_dir_command::run_compile(&path, &params)
        }
        FactoryCommand::Convert { source, out, json } => run_convert(&source, &out, json),
    }
}

fn library() -> pa_factory::Library {
    pa_core::session_engine::factory_host::machine_library(&crate::config::get_agent_dir())
}

/// A MACHINE.md path, or a library machine's name, read as a v1 machine.
fn read_v1_machine(source: &str) -> Result<pa_factory::MachineMd, String> {
    let path = crate::config::expand_tilde_path(source);
    if path.is_file() {
        return pa_factory::read_machine_md(&path);
    }
    let library = library();
    let machine = library.resolve(source)?;
    if machine.kind == pa_factory::MachineKind::Directory {
        return Err(format!(
            "{source} is already a machine directory ({})",
            machine.path.display()
        ));
    }
    pa_factory::read_machine_md(&machine.path)
}

/// `factory convert <MACHINE.md|name> --out <dir>`: read the v1 machine,
/// then write it as a directory.
fn run_convert(source: &str, out: &str, json: bool) -> i32 {
    match read_v1_machine(source) {
        Ok(machine) => crate::factory_dir_command::run_convert(
            &machine,
            &crate::config::expand_tilde_path(out),
            json,
        ),
        Err(error) => {
            eprintln!("Error: {error}");
            1
        }
    }
}

/// `factory list`: library contents with descriptions.
fn run_list(json: bool) -> i32 {
    let library = library();
    for warning in &library.warnings {
        eprintln!("Warning: {warning}");
    }
    if json {
        println!(
            "{}",
            serde_json::to_string_pretty(&library.to_json()).unwrap_or_default()
        );
        return 0;
    }
    let machines: Vec<&pa_factory::LibraryMachine> = library.machines().collect();
    if machines.is_empty() {
        println!("No machines in the library.");
        return 0;
    }
    let name_width = machines
        .iter()
        .map(|machine| machine.name.chars().count())
        .max()
        .unwrap_or(0);
    for machine in machines {
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

/// Format one listing row.
fn listing_row(machine: &pa_factory::LibraryMachine, name_width: usize) -> String {
    format!(
        "{}  {}  {}",
        pad_end(&machine.name, name_width),
        machine.source,
        machine.description
    )
}

/// Create `out` with `bytes`, never replacing an existing file.
fn write_new_file(out: &Path, bytes: &[u8]) -> Result<(), String> {
    if out.is_dir() {
        return Err(format!(
            "export path {} is a directory (pass a file path)",
            out.display()
        ));
    }
    if let Some(parent) = out.parent() {
        std::fs::create_dir_all(parent)
            .map_err(|error| format!("cannot create {}: {error}", parent.display()))?;
    }
    let mut file = std::fs::OpenOptions::new()
        .write(true)
        .create_new(true)
        .open(out)
        .map_err(|error| match error.kind() {
            std::io::ErrorKind::AlreadyExists => {
                format!("export path {} already exists", out.display())
            }
            _ => format!("cannot write {}: {error}", out.display()),
        })?;
    file.write_all(bytes)
        .map_err(|error| format!("cannot write {}: {error}", out.display()))
}

/// `factory export <name> --out <path>`: copy a library MACHINE.md.
fn export_machine(name: &str, out: &Path) -> Result<Value, String> {
    let library = library();
    let machine = library.resolve(name)?;
    if machine.kind == pa_factory::MachineKind::Directory {
        return Err(format!(
            "{name} is a machine directory ({}); copy the directory instead",
            machine.path.display()
        ));
    }
    let bytes = std::fs::read(&machine.path)
        .map_err(|error| format!("cannot read {}: {error}", machine.path.display()))?;
    write_new_file(out, &bytes)?;
    Ok(
        json!({"ok": true, "name": machine.name, "path": out.display().to_string(), "source": "library"}),
    )
}

fn run_export(name: &str, out: &str, json: bool) -> i32 {
    let result = export_machine(name, &crate::config::expand_tilde_path(out));
    print_result(result, json, |result| {
        format!(
            "Exported {} to {} (from library).",
            text_field(result, "name"),
            text_field(result, "path")
        )
    })
}

/// `factory import <path>`: parse and bound-check the MACHINE.md here, ask
/// the kernel validator to check its spec, then copy it byte for byte into
/// the personal library.
fn import_machine(source: &Path, user_dir: &Path) -> Result<Value, String> {
    if !source.is_file() {
        return Err(format!("machine file not found: {}", source.display()));
    }
    let machine = pa_factory::read_machine_md(source)?;
    let folder = user_dir.join(&machine.name);
    if folder.join(pa_factory::MACHINE_FILE).is_file() {
        return Err(format!(
            "{} is a machine directory, which the library uses before a MACHINE.md; rename the machine or move the directory first",
            folder.display()
        ));
    }
    let checked = resolve_kernel_python().and_then(|python| {
        dispatch_via_kernel(&python, &json!({"op": "validate", "spec": machine.spec}))
    })?;
    let errors = dispatch_error_sentences(&checked);
    if !errors.is_empty() {
        return Err(errors.join("; "));
    }
    let bytes = std::fs::read(source)
        .map_err(|error| format!("cannot read {}: {error}", source.display()))?;
    let destination = folder.join(pa_factory::MACHINE_MD_FILE);
    let created = !destination.exists();
    if let Some(parent) = destination.parent() {
        std::fs::create_dir_all(parent)
            .map_err(|error| format!("cannot create {}: {error}", parent.display()))?;
    }
    std::fs::write(&destination, bytes)
        .map_err(|error| format!("cannot write {}: {error}", destination.display()))?;
    Ok(
        json!({"ok": true, "name": machine.name, "path": destination.display().to_string(), "created": created}),
    )
}

fn run_import(path: &str, json: bool) -> i32 {
    let user_dir = crate::config::get_agent_dir().join("machines");
    let result = import_machine(&crate::config::expand_tilde_path(path), &user_dir);
    print_result(result, json, |result| {
        format!(
            "Imported {} into {}.",
            text_field(result, "name"),
            text_field(result, "path")
        )
    })
}

fn text_field<'a>(result: &'a Value, key: &str) -> &'a str {
    result.get(key).and_then(Value::as_str).unwrap_or_default()
}

/// Print an import or export result as JSON or one line; errors verbatim.
fn print_result(result: Result<Value, String>, json: bool, line: impl Fn(&Value) -> String) -> i32 {
    match result {
        Ok(result) if json => {
            println!(
                "{}",
                serde_json::to_string_pretty(&result).unwrap_or_default()
            );
            0
        }
        Ok(result) => {
            println!("{}", line(&result));
            0
        }
        Err(error) => {
            eprintln!("Error: {error}");
            1
        }
    }
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
        .args(["-P", "-s", "-c", CLI_DISPATCH_RUNNER])
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .env_clear()
        .envs(pa_core::kernel::python_process_environment());
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
    fn parses_the_machine_directory_subcommands() {
        assert_eq!(
            parse_factory_command(&arg(&["validate", "~/machines/rsi", "--json"])),
            Ok(FactoryCommand::Validate {
                path: "~/machines/rsi".to_string(),
                json: true
            })
        );
        assert_eq!(
            parse_factory_command(&arg(&[
                "compile",
                "rsi",
                "--param",
                "task=@task.md",
                "--param",
                "max_loc=300"
            ])),
            Ok(FactoryCommand::Compile {
                path: "rsi".to_string(),
                params: vec!["task=@task.md".to_string(), "max_loc=300".to_string()],
            })
        );
        assert_eq!(
            parse_factory_command(&arg(&["convert", "builder", "--out", "/tmp/builder"])),
            Ok(FactoryCommand::Convert {
                source: "builder".to_string(),
                out: "/tmp/builder".to_string(),
                json: false
            })
        );
        assert!(parse_factory_command(&arg(&["convert", "builder"]))
            .unwrap_err()
            .starts_with("Usage: prime-agent factory convert"));
        assert_eq!(
            parse_factory_command(&arg(&["validate", "a", "--param", "x=1"])),
            Err("unknown option \"--param\"".to_string())
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
    fn dispatch_runner_contract_is_the_json_facade() {
        assert!(CLI_DISPATCH_RUNNER.contains("from rlm.factory import cli_dispatch"));
        assert!(CLI_DISPATCH_RUNNER.contains("print(json.dumps(cli_dispatch(payload)))"));
    }

    #[test]
    fn listing_row_renders_name_source_description() {
        let machine = pa_factory::LibraryMachine {
            name: "sweep".to_string(),
            description: "A machine that sweeps.".to_string(),
            version: "1".to_string(),
            author: "Tester".to_string(),
            source: "repo".to_string(),
            path: PathBuf::from("/machines/sweep/MACHINE.md"),
            kind: pa_factory::MachineKind::File,
        };
        assert_eq!(
            listing_row(&machine, 5),
            "sweep  repo  A machine that sweeps."
        );
    }

    #[test]
    fn an_import_never_hides_behind_a_machine_directory() {
        let dir = tempfile::tempdir().unwrap();
        let source = dir.path().join("MACHINE.md");
        std::fs::write(
            &source,
            "---\nname: sweep\ndescription: Sweep.\n---\n```machine-spec\n{\"states\": []}\n```\n",
        )
        .unwrap();
        let user = dir.path().join("machines");
        std::fs::create_dir_all(user.join("sweep")).unwrap();
        std::fs::write(user.join("sweep/machine.toml"), "format = 1\n").unwrap();
        assert!(import_machine(&source, &user)
            .unwrap_err()
            .contains("is a machine directory"));
        assert!(!user.join("sweep/MACHINE.md").exists());
    }

    #[test]
    fn an_export_never_replaces_an_existing_file() {
        let dir = tempfile::tempdir().unwrap();
        let out = dir.path().join("nested/sweep.MACHINE.md");
        write_new_file(&out, b"first").unwrap();
        assert_eq!(
            write_new_file(&out, b"second").unwrap_err(),
            format!("export path {} already exists", out.display())
        );
        assert_eq!(std::fs::read(&out).unwrap(), b"first");
        assert!(write_new_file(dir.path(), b"x")
            .unwrap_err()
            .ends_with("is a directory (pass a file path)"));
    }
}

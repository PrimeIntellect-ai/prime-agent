//! The machine-directory half of `prime-agent factory`: `validate`,
//! `compile`, `convert`, and the directories `list` shows.
//!
//! A machine directory (`machine.toml` plus Markdown and Python files) is
//! loaded by `pa-factory`, the same loader a session's `factory.compile`
//! host request uses, so the CLI and a running session accept exactly the
//! same machines. MACHINE.md files stay with the kernel's parser.

use std::path::Path;

use serde_json::{json, Map, Value};

use pa_factory::types::Type;

/// `factory validate <dir>`: load and check one machine directory.
pub(crate) fn run_validate(path: &str, json: bool) -> i32 {
    let dir = crate::config::expand_tilde_path(path);
    match pa_factory::load_machine_dir(&dir) {
        Ok(machine) => {
            if json {
                let summary = json!({
                    "ok": true,
                    "name": machine.name,
                    "version": machine.version,
                    "states": machine.states.len(),
                    "path": dir.display().to_string(),
                });
                println!(
                    "{}",
                    serde_json::to_string_pretty(&summary).unwrap_or_default()
                );
            } else {
                println!(
                    "{} v{} is valid: {} states.",
                    machine.name,
                    machine.version,
                    machine.states.len()
                );
            }
            0
        }
        Err(problems) => print_problems(&dir, &problems, json),
    }
}

/// `factory compile <dir> [--param k=v]...`: print the canonical spec the
/// executor would run, for debugging a machine or storing it as a factory
/// entry.
pub(crate) fn run_compile(path: &str, params: &[String]) -> i32 {
    let dir = crate::config::expand_tilde_path(path);
    let machine = match pa_factory::load_machine_dir(&dir) {
        Ok(machine) => machine,
        Err(problems) => return print_problems(&dir, &problems, false),
    };
    let given = match parse_params(&machine, params) {
        Ok(given) => given,
        Err(error) => {
            eprintln!("Error: {error}");
            return 1;
        }
    };
    match pa_factory::compile(&machine, &given) {
        Ok(spec) => {
            println!(
                "{}",
                serde_json::to_string_pretty(&spec).unwrap_or_default()
            );
            0
        }
        Err(problems) => print_problems(&dir, &problems, false),
    }
}

/// `--param name=value` (or `name=@file` to read the value from a file).
/// Text and file params take the value as written; every other type
/// parses it as JSON, falling back to the bare word (an enum value).
fn parse_params(
    machine: &pa_factory::Machine,
    params: &[String],
) -> Result<Map<String, Value>, String> {
    let mut given = Map::new();
    for param in params {
        let Some((name, raw)) = param.split_once('=') else {
            return Err(format!("--param {param:?} must be name=value"));
        };
        let raw = match raw.strip_prefix('@') {
            Some(file) => std::fs::read_to_string(crate::config::expand_tilde_path(file))
                .map_err(|error| format!("--param {name}: cannot read {file}: {error}"))?,
            None => raw.to_string(),
        };
        let as_text = machine
            .param(name)
            .is_none_or(|declared| matches!(declared.ty, Type::Text | Type::File));
        let value = if as_text {
            Value::String(raw)
        } else {
            serde_json::from_str(&raw).unwrap_or(Value::String(raw))
        };
        if given.insert(name.to_string(), value).is_some() {
            return Err(format!("--param {name} is given twice"));
        }
    }
    Ok(given)
}

/// `factory convert`: write a stored v1 machine (the kernel's `read`
/// result) as a machine directory at `out`, then load it back.
pub(crate) fn run_convert(read: &Value, out: &Path, json: bool) -> i32 {
    let text = |key: &str| {
        read.get(key)
            .and_then(Value::as_str)
            .unwrap_or_default()
            .to_string()
    };
    let meta = pa_factory::MachineMeta {
        name: text("name"),
        description: text("description"),
        version: text("version")
            .parse()
            .ok()
            .filter(|version| *version >= 1)
            .unwrap_or(1),
        author: Some(text("author")).filter(|author| !author.is_empty()),
    };
    let spec = read.get("spec").cloned().unwrap_or(Value::Null);
    let files = match pa_factory::convert_spec(&spec, &meta) {
        Ok(files) => files,
        Err(problems) => {
            for problem in &problems {
                eprintln!("Error: {}: {problem}", meta.name);
            }
            return 1;
        }
    };
    if out.exists() {
        eprintln!(
            "Error: {} already exists; choose a new directory",
            out.display()
        );
        return 1;
    }
    for file in &files {
        let path = out.join(&file.path);
        let written = path
            .parent()
            .map_or(Ok(()), std::fs::create_dir_all)
            .and_then(|()| std::fs::write(&path, &file.content));
        if let Err(error) = written {
            eprintln!("Error: cannot write {}: {error}", path.display());
            return 1;
        }
    }
    if let Err(problems) = pa_factory::load_machine_dir(out) {
        eprintln!(
            "Converted {} to {}, but the result does not load:",
            meta.name,
            out.display()
        );
        return print_problems(out, &problems, false);
    }
    if json {
        let paths: Vec<&str> = files.iter().map(|file| file.path.as_str()).collect();
        let summary = json!({"ok": true, "name": meta.name, "path": out.display().to_string(), "files": paths});
        println!(
            "{}",
            serde_json::to_string_pretty(&summary).unwrap_or_default()
        );
    } else {
        println!(
            "Converted {} to {} ({} files).",
            meta.name,
            out.display(),
            files.len()
        );
        println!(
            "Its prompts keep their hand-written output instructions; the generated Outputs section now asks for rlm.factory.emit, so delete those lines."
        );
    }
    0
}

fn print_problems(dir: &Path, problems: &[pa_factory::Diagnostic], json: bool) -> i32 {
    if json {
        let lines: Vec<String> = problems.iter().map(ToString::to_string).collect();
        let result = json!({"ok": false, "path": dir.display().to_string(), "errors": lines});
        println!(
            "{}",
            serde_json::to_string_pretty(&result).unwrap_or_default()
        );
    } else {
        for problem in problems {
            eprintln!("Error: {}: {problem}", dir.display());
        }
    }
    1
}

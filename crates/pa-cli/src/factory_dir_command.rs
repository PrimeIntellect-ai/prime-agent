//! The machine-directory half of `prime-agent factory`: `validate`,
//! `compile`, `convert`, and the directories `list` shows.
//!
//! A machine directory (`machine.toml` plus Markdown and Python files) is
//! loaded by `pa-factory`, the same loader a session's `factory.compile`
//! host request uses, so the CLI and a running session accept exactly the
//! same machines. MACHINE.md files stay with the kernel's parser.

use std::path::{Path, PathBuf};

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

/// Merge the machine directories of every library level into the
/// kernel's `list` result. Within a level a machine directory wins over a
/// MACHINE.md of the same name; an earlier level wins over a later one,
/// the order `rlm.factory.run` resolves names in. `run` resolves a
/// directory by its folder name, so a directory that fails to load or
/// declares another name is a warning, never a row.
pub(crate) fn add_machine_dirs(result: &mut Value) {
    let levels: Vec<(String, PathBuf)> = result
        .get("levels")
        .and_then(Value::as_array)
        .map(|levels| {
            levels
                .iter()
                .filter_map(|level| {
                    let source = level.get("source")?.as_str()?.to_string();
                    let path = PathBuf::from(level.get("path")?.as_str()?);
                    Some((source, path))
                })
                .collect()
        })
        .unwrap_or_default();
    let rank_of = |source: &str| {
        levels
            .iter()
            .position(|(level, _)| level == source)
            .unwrap_or(levels.len())
    };
    // (level rank, 0 for a directory or 1 for MACHINE.md) per name. A
    // directory that cannot run under its folder name still claims that
    // name with no row: `_resolve_machine_dir` picks it first, so a later
    // machine of the same name must not look usable.
    let mut chosen: std::collections::BTreeMap<String, ((usize, u8), Option<Value>)> =
        std::collections::BTreeMap::new();
    let mut offer = |name: String, rank: (usize, u8), row: Option<Value>| {
        if chosen.get(&name).is_none_or(|(held, _)| rank < *held) {
            chosen.insert(name, (rank, row));
        }
    };
    for row in result
        .get("machines")
        .and_then(Value::as_array)
        .cloned()
        .unwrap_or_default()
    {
        let name = row
            .get("name")
            .and_then(Value::as_str)
            .unwrap_or_default()
            .to_string();
        let source = row
            .get("source")
            .and_then(Value::as_str)
            .unwrap_or_default();
        offer(name, (rank_of(source), 1), Some(row));
    }
    let mut warnings: Vec<Value> = result
        .get("warnings")
        .and_then(Value::as_array)
        .cloned()
        .unwrap_or_default();
    for (rank, (source, root)) in levels.iter().enumerate() {
        let Ok(entries) = std::fs::read_dir(root) else {
            continue;
        };
        let mut dirs: Vec<PathBuf> = entries
            .filter_map(Result::ok)
            .map(|entry| entry.path())
            .filter(|path| path.join(pa_factory::MACHINE_FILE).is_file())
            .collect();
        dirs.sort();
        for dir in dirs {
            let folder = dir
                .file_name()
                .map(|name| name.to_string_lossy().into_owned())
                .unwrap_or_default();
            let row = match pa_factory::load_machine_dir(&dir) {
                Ok(machine) if machine.name == folder => Some(json!({
                    "name": machine.name,
                    "description": machine.description,
                    "version": machine.version.to_string(),
                    "author": machine.author.unwrap_or_default(),
                    "source": source,
                    "path": dir.display().to_string(),
                })),
                Ok(machine) => {
                    let declared = machine.name;
                    warnings.push(json!(format!(
                        "{}: declares the name {declared:?}; rename the directory or the machine so they match",
                        dir.display()
                    )));
                    None
                }
                Err(problems) => {
                    let lines: Vec<String> = problems.iter().map(ToString::to_string).collect();
                    warnings.push(json!(format!("{}: {}", dir.display(), lines.join("; "))));
                    None
                }
            };
            offer(folder, (rank, 0), row);
        }
    }
    let machines: Vec<Value> = chosen.into_values().filter_map(|(_, row)| row).collect();
    if let Some(object) = result.as_object_mut() {
        object.insert("machines".to_string(), Value::Array(machines));
        object.insert("warnings".to_string(), Value::Array(warnings));
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn write_machine(root: &Path, name: &str, description: &str) {
        let dir = root.join(name);
        std::fs::create_dir_all(dir.join("prompts")).unwrap();
        std::fs::write(
            dir.join("machine.toml"),
            format!("format = 1\nname = \"{name}\"\nversion = 2\ndescription = \"{description}\"\n\n[states.go]\nentry = true\nagent = {{ prompt = \"prompts/go.md\" }}\n"),
        )
        .unwrap();
        std::fs::write(dir.join("prompts/go.md"), "Go.\n").unwrap();
    }

    #[test]
    fn machine_dirs_join_the_listing_in_resolution_order() {
        let repo = tempfile::tempdir().unwrap();
        let user = tempfile::tempdir().unwrap();
        write_machine(repo.path(), "sweep", "The directory sweep.");
        write_machine(user.path(), "builder", "A personal builder.");
        write_machine(user.path(), "mine", "Mine.");
        std::fs::create_dir_all(user.path().join("broken")).unwrap();
        std::fs::write(user.path().join("broken/machine.toml"), "format = 1\n").unwrap();
        let mut result = json!({
            "ok": true,
            "levels": [
                {"source": "repo", "path": repo.path().display().to_string()},
                {"source": "user", "path": user.path().display().to_string()},
            ],
            "machines": [
                {"name": "builder", "description": "The bundled builder.", "version": "1", "author": "Prime Agent", "source": "repo", "path": "/rlm/machines/builder/MACHINE.md"},
                {"name": "sweep", "description": "The bundled sweep.", "version": "1", "author": "Prime Agent", "source": "repo", "path": "/rlm/machines/sweep/MACHINE.md"},
            ],
            "warnings": [],
        });
        add_machine_dirs(&mut result);
        let row = |name: &str,
                   description: &str,
                   version: &str,
                   author: &str,
                   source: &str,
                   path: String| {
            json!({"name": name, "description": description, "version": version, "author": author, "source": source, "path": path})
        };
        assert_eq!(
            result["machines"],
            json!([
                row(
                    "builder",
                    "The bundled builder.",
                    "1",
                    "Prime Agent",
                    "repo",
                    "/rlm/machines/builder/MACHINE.md".to_string()
                ),
                row(
                    "mine",
                    "Mine.",
                    "2",
                    "",
                    "user",
                    user.path().join("mine").display().to_string()
                ),
                row(
                    "sweep",
                    "The directory sweep.",
                    "2",
                    "",
                    "repo",
                    repo.path().join("sweep").display().to_string()
                ),
            ])
        );
        let warnings = result["warnings"].as_array().unwrap();
        assert_eq!(warnings.len(), 1);
        assert!(warnings[0]
            .as_str()
            .unwrap()
            .contains("broken: machine.toml: missing field `name`"));
    }

    #[test]
    fn a_directory_that_cannot_run_by_its_folder_name_hides_that_name() {
        let repo = tempfile::tempdir().unwrap();
        std::fs::create_dir_all(repo.path().join("sweep")).unwrap();
        std::fs::write(repo.path().join("sweep/machine.toml"), "format = 1\n").unwrap();
        write_machine(repo.path(), "declared", "Declared elsewhere.");
        std::fs::rename(repo.path().join("declared"), repo.path().join("folder")).unwrap();
        let file_row = |name: &str| json!({"name": name, "description": "A file.", "version": "1", "author": "", "source": "user", "path": format!("/user/{name}/MACHINE.md")});
        let mut result = json!({
            "ok": true,
            "levels": [
                {"source": "repo", "path": repo.path().display().to_string()},
                {"source": "user", "path": "/user"},
            ],
            "machines": [file_row("declared"), file_row("folder"), file_row("sweep")],
            "warnings": [],
        });
        add_machine_dirs(&mut result);
        assert_eq!(result["machines"], json!([file_row("declared")]));
        let folder = repo.path().join("folder").display().to_string();
        let warnings = result["warnings"].as_array().unwrap();
        assert_eq!(
            warnings[0],
            json!(format!("{folder}: declares the name \"declared\"; rename the directory or the machine so they match"))
        );
        assert!(warnings[1]
            .as_str()
            .unwrap()
            .contains("sweep: machine.toml: missing field `name`"));
        assert_eq!(warnings.len(), 2);
    }

    #[test]
    fn params_follow_their_declared_types() {
        let root = tempfile::tempdir().unwrap();
        let dir = root.path().join("typed");
        std::fs::create_dir_all(dir.join("prompts")).unwrap();
        std::fs::write(
            dir.join("machine.toml"),
            "format = 1\nname = \"typed\"\nversion = 1\ndescription = \"d\"\n\n[params]\ntask = { type = \"text\" }\nmax_loc = { type = \"int\" }\nmode = { type = \"enum(fast, slow)\" }\n\n[states.go]\nentry = true\nagent = { prompt = \"prompts/go.md\" }\n",
        )
        .unwrap();
        std::fs::write(dir.join("prompts/go.md"), "Go.\n").unwrap();
        std::fs::write(root.path().join("task.md"), "Fix 42.\n").unwrap();
        let machine = pa_factory::load_machine_dir(&dir).unwrap();
        let given = parse_params(
            &machine,
            &[
                format!("task=@{}", root.path().join("task.md").display()),
                "max_loc=400".to_string(),
                "mode=fast".to_string(),
            ],
        )
        .unwrap();
        assert_eq!(
            Value::Object(given),
            json!({"task": "Fix 42.\n", "max_loc": 400, "mode": "fast"})
        );
        assert_eq!(
            parse_params(&machine, &["mode".to_string()]),
            Err("--param \"mode\" must be name=value".to_string())
        );
    }
}

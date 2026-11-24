//! The machine library: the one scan behind `factory list`, running a
//! machine by name, export, import, and the machines page.
//!
//! The library has levels, searched in order (the bundled library, then
//! the personal one). Each level holds one folder per machine: either a
//! machine directory (`machine.toml`) or a v1 `MACHINE.md` file.

use std::collections::BTreeMap;
use std::path::{Path, PathBuf};

use serde_json::{json, Value};

use crate::limits::check_spec_limits;
use crate::load::{load_machine_dir, MACHINE_FILE};

/// The v1 machine file inside a library folder.
pub const MACHINE_MD_FILE: &str = "MACHINE.md";
const MACHINE_SPEC_FENCE: &str = "machine-spec";
const MACHINE_NAME_MAX_LENGTH: usize = 64;
const MACHINE_DESCRIPTION_MAX_LENGTH: usize = 1024;
const FRONTMATTER_FIELDS: [&str; 4] = ["name", "description", "version", "author"];

/// One library level: its label (`repo`, `user`) and its directory.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Level {
    pub source: String,
    pub dir: PathBuf,
}

/// How a library machine is stored.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum MachineKind {
    /// A machine directory (`machine.toml`).
    Directory,
    /// A v1 `MACHINE.md` file.
    File,
}

/// One usable library machine.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct LibraryMachine {
    pub name: String,
    pub description: String,
    pub version: String,
    pub author: String,
    pub source: String,
    /// The machine directory, or the `MACHINE.md` file.
    pub path: PathBuf,
    pub kind: MachineKind,
}

impl LibraryMachine {
    /// The listing row (`factory list --json`, the machines page).
    #[must_use]
    pub fn to_json(&self) -> Value {
        json!({
            "name": self.name,
            "description": self.description,
            "version": self.version,
            "author": self.author,
            "source": self.source,
            "path": self.path.display().to_string(),
            "kind": match self.kind {
                MachineKind::Directory => "directory",
                MachineKind::File => "file",
            },
        })
    }
}

/// A parsed `MACHINE.md`: strict frontmatter plus the JSON spec.
#[derive(Debug, Clone, PartialEq)]
pub struct MachineMd {
    pub name: String,
    pub description: String,
    pub version: String,
    pub author: String,
    pub spec: Value,
}

/// The scanned library. A name belongs to the first folder that claims it
/// (level order; within a level, machine directories first, then
/// `MACHINE.md` files, each in folder order). A machine directory claims its
/// folder name, a valid `MACHINE.md` its declared name, and a broken one its
/// folder name. A broken claim keeps the name: running it reports its
/// errors instead of falling through to another machine.
#[derive(Debug, Default)]
pub struct Library {
    claims: BTreeMap<String, Result<LibraryMachine, String>>,
    /// Every broken folder, `<path>: <errors>`, in scan order.
    pub warnings: Vec<String>,
}

impl Library {
    /// The usable machines, by name.
    pub fn machines(&self) -> impl Iterator<Item = &LibraryMachine> {
        self.claims.values().filter_map(|claim| claim.as_ref().ok())
    }

    /// The machine that owns `name`.
    ///
    /// # Errors
    /// The broken machine's errors, or that no machine has the name.
    pub fn resolve(&self, name: &str) -> Result<&LibraryMachine, String> {
        match self.claims.get(name) {
            Some(Ok(machine)) => Ok(machine),
            Some(Err(error)) => Err(format!(
                "the library machine {name:?} exists but is broken ({error})"
            )),
            None => {
                let names: Vec<&str> = self.machines().map(|machine| machine.name.as_str()).collect();
                Err(format!(
                    "no library machine named {name:?} (machines: {})",
                    if names.is_empty() { "none".to_string() } else { names.join(", ") }
                ))
            }
        }
    }

    /// `factory list --json`'s payload.
    #[must_use]
    pub fn to_json(&self) -> Value {
        let machines: Vec<Value> = self.machines().map(LibraryMachine::to_json).collect();
        json!({"ok": true, "machines": machines, "warnings": self.warnings})
    }

    fn claim(&mut self, name: String, claim: Result<LibraryMachine, String>) {
        self.claims.entry(name).or_insert(claim);
    }
}

/// Scan every level once.
#[must_use]
pub fn scan_library(levels: &[Level]) -> Library {
    let mut library = Library::default();
    for level in levels {
        let Ok(entries) = std::fs::read_dir(&level.dir) else {
            continue;
        };
        let mut folders: Vec<PathBuf> = entries
            .filter_map(Result::ok)
            .map(|entry| entry.path())
            .filter(|path| path.is_dir())
            .collect();
        folders.sort();
        let folder_name = |folder: &Path| {
            folder
                .file_name()
                .map(|name| name.to_string_lossy().into_owned())
                .unwrap_or_default()
        };
        for folder in folders.iter().filter(|folder| folder.join(MACHINE_FILE).is_file()) {
            let name = folder_name(folder);
            let claim = match load_machine_dir(folder) {
                Ok(machine) if machine.name == name => Ok(LibraryMachine {
                    name: machine.name,
                    description: machine.description,
                    version: machine.version.to_string(),
                    author: machine.author.unwrap_or_default(),
                    source: level.source.clone(),
                    path: folder.clone(),
                    kind: MachineKind::Directory,
                }),
                Ok(machine) => Err(format!(
                    "declares the name {:?}; rename the directory or the machine so they match",
                    machine.name
                )),
                Err(problems) => Err(problems
                    .iter()
                    .map(ToString::to_string)
                    .collect::<Vec<_>>()
                    .join("; ")),
            };
            if let Err(error) = &claim {
                library.warnings.push(format!("{}: {error}", folder.display()));
            }
            library.claim(name, claim);
        }
        for folder in folders.iter().filter(|folder| {
            !folder.join(MACHINE_FILE).is_file() && folder.join(MACHINE_MD_FILE).is_file()
        }) {
            let path = folder.join(MACHINE_MD_FILE);
            match read_machine_md(&path) {
                Ok(machine) => library.claim(
                    machine.name.clone(),
                    Ok(LibraryMachine {
                        name: machine.name,
                        description: machine.description,
                        version: machine.version,
                        author: machine.author,
                        source: level.source.clone(),
                        path,
                        kind: MachineKind::File,
                    }),
                ),
                Err(error) => {
                    library.warnings.push(error.clone());
                    library.claim(folder_name(folder), Err(error));
                }
            }
        }
    }
    library
}

/// Read, parse, and bound-check one `MACHINE.md`.
///
/// # Errors
/// `<path>: <errors>` when the file cannot be read, does not parse, or its
/// spec breaks a limit.
pub fn read_machine_md(path: &Path) -> Result<MachineMd, String> {
    let bytes = std::fs::read(path).map_err(|error| format!("{}: unreadable ({error})", path.display()))?;
    let text = String::from_utf8(bytes)
        .map_err(|error| format!("{}: not valid UTF-8 ({error})", path.display()))?;
    let machine = parse_machine_md(&text, &path.display().to_string())
        .map_err(|errors| errors.join("; "))?;
    let limits = check_spec_limits(&machine.spec);
    if !limits.is_empty() {
        return Err(format!("{}: {}", path.display(), limits.join("; ")));
    }
    Ok(machine)
}

/// The machine name rule (the skill library's): lowercase a-z, 0-9 and
/// hyphens, at most 64 characters, not ending in a hyphen.
#[must_use]
pub fn machine_name_errors(name: &str) -> Vec<String> {
    if name.is_empty() {
        return vec!["machine name must be a non-empty string".to_string()];
    }
    let mut errors = Vec::new();
    let length = name.chars().count();
    if length > MACHINE_NAME_MAX_LENGTH {
        errors.push(format!(
            "machine name exceeds {MACHINE_NAME_MAX_LENGTH} characters ({length})"
        ));
    }
    let mut chars = name.chars();
    let valid = chars
        .next()
        .is_some_and(|first| first.is_ascii_lowercase() || first.is_ascii_digit())
        && chars.all(|c| c.is_ascii_lowercase() || c.is_ascii_digit() || c == '-');
    if !valid {
        errors.push(
            "machine name contains invalid characters (must be lowercase a-z, 0-9, hyphens only)"
                .to_string(),
        );
    }
    if name.ends_with('-') {
        errors.push("machine name must not end with a hyphen".to_string());
    }
    errors
}

fn machine_description_errors(description: Option<&str>) -> Vec<String> {
    let Some(description) = description.filter(|text| !text.trim().is_empty()) else {
        return vec!["frontmatter description is required".to_string()];
    };
    let length = description.chars().count();
    if length > MACHINE_DESCRIPTION_MAX_LENGTH {
        return vec![format!(
            "frontmatter description exceeds {MACHINE_DESCRIPTION_MAX_LENGTH} characters ({length})"
        )];
    }
    if description.contains(['\n', '\r']) {
        return vec!["frontmatter description must be a single line".to_string()];
    }
    Vec::new()
}

/// Parse one `MACHINE.md`: frontmatter (`name`, `description`, `version`,
/// `author`, one `key: value` line each) and exactly one fenced
/// `machine-spec` block holding a JSON object.
///
/// # Errors
/// Every problem, each prefixed with `source`.
pub fn parse_machine_md(text: &str, source: &str) -> Result<MachineMd, Vec<String>> {
    let normalized = text
        .trim_start_matches('\u{feff}')
        .replace("\r\n", "\n")
        .replace('\r', "\n");
    let lines: Vec<&str> = normalized.split('\n').collect();
    if lines.first().is_none_or(|line| line.trim_end() != "---") {
        return Err(vec![format!(
            "{source}: MACHINE.md must start with a `---` frontmatter block"
        )]);
    }
    let mut fields: BTreeMap<&str, String> = BTreeMap::new();
    let mut errors = Vec::new();
    let Some(close) = lines.iter().skip(1).position(|line| line.trim_end() == "---").map(|at| at + 1)
    else {
        return Err(vec![format!(
            "{source}: frontmatter is not closed (end it with a `---` line)"
        )]);
    };
    for (index, line) in lines.iter().enumerate().take(close).skip(1) {
        let line = line.trim_end();
        let number = index + 1;
        if line.trim().is_empty() {
            errors.push(format!(
                "{source}: frontmatter line {number} is empty (one `key: value` line per field)"
            ));
            continue;
        }
        let Some((key, raw)) = line.split_once(':') else {
            errors.push(format!("{source}: frontmatter line {number} must be `key: value`"));
            continue;
        };
        let key = key.trim();
        let Some(&key) = FRONTMATTER_FIELDS.iter().find(|field| **field == key) else {
            errors.push(format!(
                "{source}: unknown frontmatter key {key:?} (allowed: {})",
                FRONTMATTER_FIELDS.join(", ")
            ));
            continue;
        };
        if fields.contains_key(key) {
            errors.push(format!(
                "{source}: frontmatter field {key:?} is declared more than once"
            ));
            continue;
        }
        if raw.trim().is_empty() {
            errors.push(format!("{source}: frontmatter field {key:?} requires a value"));
            continue;
        }
        match unquote(raw, key) {
            Ok(value) => {
                fields.insert(key, value);
            }
            Err(error) => errors.push(format!("{source}: {error}")),
        }
    }
    if !errors.is_empty() {
        return Err(errors);
    }
    let body = &lines[close + 1..];
    let payload = machine_spec_block(body, source)?;
    let spec: Value = serde_json::from_str(&payload).map_err(|error| {
        vec![format!(
            "{source}: the ```{MACHINE_SPEC_FENCE} block must contain a JSON object ({error})"
        )]
    })?;
    if !spec.is_object() {
        return Err(vec![format!(
            "{source}: the ```{MACHINE_SPEC_FENCE} block must contain a JSON object"
        )]);
    }
    let name = fields.remove("name").unwrap_or_default();
    let description = fields.remove("description");
    let mut errors = machine_name_errors(&name);
    errors.extend(machine_description_errors(description.as_deref()));
    if !errors.is_empty() {
        return Err(errors);
    }
    Ok(MachineMd {
        name,
        description: description.unwrap_or_default(),
        version: fields.remove("version").unwrap_or_default(),
        author: fields.remove("author").unwrap_or_default(),
        spec,
    })
}

/// Unquote one frontmatter value: plain, single-quoted, or double-quoted
/// (JSON string rules). A plain value may not contain a colon.
fn unquote(raw: &str, field: &str) -> Result<String, String> {
    let value = raw.trim();
    if value.len() >= 2 && value.starts_with('"') && value.ends_with('"') {
        return match serde_json::from_str::<Value>(value) {
            Ok(Value::String(text)) => Ok(text),
            Ok(_) => Err(format!("frontmatter {field} must be a string scalar")),
            Err(error) => Err(format!(
                "frontmatter {field} has an invalid double-quoted value ({error})"
            )),
        };
    }
    if value.len() >= 2 && value.starts_with('\'') && value.ends_with('\'') {
        return Ok(value[1..value.len() - 1].replace("''", "'"));
    }
    if value.contains(':') {
        return Err(format!(
            "frontmatter {field} is not a plain scalar (quote the value to include ':' characters)"
        ));
    }
    Ok(value.to_string())
}

/// The single fenced `machine-spec` payload. Other fenced blocks are
/// skipped whole, so their content never counts as a fence.
fn machine_spec_block(lines: &[&str], source: &str) -> Result<String, Vec<String>> {
    let mut found: Vec<String> = Vec::new();
    let mut index = 0;
    while index < lines.len() {
        let line = lines[index].trim_end();
        if !line.trim_start().starts_with("```") {
            index += 1;
            continue;
        }
        let open = index;
        let info = line.trim()[3..].trim().to_string();
        index += 1;
        let mut content: Vec<&str> = Vec::new();
        let mut closed = false;
        while index < lines.len() {
            if lines[index].trim_end() == "```" {
                closed = true;
                index += 1;
                break;
            }
            content.push(lines[index]);
            index += 1;
        }
        if info != MACHINE_SPEC_FENCE {
            if !closed {
                return Err(vec![format!(
                    "{source}: the ```{info} fence opened at line {} is never closed",
                    open + 1
                )]);
            }
            continue;
        }
        if !closed {
            return Err(vec![format!(
                "{source}: the ```{MACHINE_SPEC_FENCE} fence is never closed"
            )]);
        }
        found.push(content.join("\n"));
    }
    match found.len() {
        1 => Ok(found.remove(0)),
        0 => Err(vec![format!(
            "{source}: MACHINE.md requires exactly one fenced ```{MACHINE_SPEC_FENCE} block; found none"
        )]),
        count => Err(vec![format!(
            "{source}: MACHINE.md requires exactly one fenced ```{MACHINE_SPEC_FENCE} block; found {count}"
        )]),
    }
}

#[cfg(test)]
mod tests;

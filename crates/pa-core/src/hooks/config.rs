//! Bounded, immutable configuration snapshots. Trust is never read from a project file.
use std::collections::BTreeMap;
use std::io::Read;
use std::path::Path;
use std::time::Duration;

use anyhow::{bail, Context};
use fancy_regex::{Regex, RegexBuilder};
use serde::Deserialize;
use sha2::{Digest, Sha256};

const FILE_LIMIT: u64 = 256 * 1024;
const HANDLER_LIMIT: usize = 32;

#[derive(Clone, Copy, Debug, PartialEq, Eq, Deserialize)]
pub(super) enum Event {
    PreToolUse,
    PostToolUse,
    SessionStart,
    UserPromptSubmit,
    Stop,
    SessionEnd,
    PreCompact,
}

impl Event {
    pub fn parse(name: &str) -> anyhow::Result<Self> {
        match name {
            "PreToolUse" => Ok(Self::PreToolUse),
            "PostToolUse" => Ok(Self::PostToolUse),
            "SessionStart" => Ok(Self::SessionStart),
            "UserPromptSubmit" => Ok(Self::UserPromptSubmit),
            "Stop" => Ok(Self::Stop),
            "SessionEnd" => Ok(Self::SessionEnd),
            "PreCompact" => Ok(Self::PreCompact),
            _ => bail!("unsupported hook event {name}"),
        }
    }

    pub fn name(self) -> &'static str {
        match self {
            Self::PreToolUse => "PreToolUse",
            Self::PostToolUse => "PostToolUse",
            Self::SessionStart => "SessionStart",
            Self::UserPromptSubmit => "UserPromptSubmit",
            Self::Stop => "Stop",
            Self::SessionEnd => "SessionEnd",
            Self::PreCompact => "PreCompact",
        }
    }
}

// Configuration documents are shared with Codex. Unknown keys are ignored with
// a notice instead of rejecting the whole source, so one Codex-only field never
// drops the policies around it. Cosmetic Codex keys are ignored silently.
#[derive(Deserialize)]
struct Document {
    #[serde(default)]
    description: Option<String>,
    hooks: BTreeMap<String, Vec<Group>>,
    #[serde(flatten)]
    unknown: BTreeMap<String, serde_json::Value>,
}

#[derive(Deserialize)]
struct Group {
    matcher: Option<String>,
    hooks: Vec<Handler>,
    #[serde(flatten)]
    unknown: BTreeMap<String, serde_json::Value>,
}

#[derive(Deserialize)]
struct Handler {
    #[serde(rename = "type")]
    kind: String,
    #[serde(default)]
    command: Option<String>,
    timeout: Option<u64>,
    #[serde(default, rename = "async")]
    background: bool,
    #[serde(flatten)]
    unknown: BTreeMap<String, serde_json::Value>,
}

/// Codex display-only handler keys: accepting them changes no behavior.
const COSMETIC_HANDLER_FIELDS: [&str; 1] = ["statusMessage"];

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct Trust {
    version: u32,
    trusted: Vec<String>,
}

pub(super) struct ConfiguredHook {
    pub event: Event,
    pub command: String,
    pub timeout: Duration,
    matcher: Option<Regex>,
}

impl ConfiguredHook {
    pub fn matches(&self, event: Event, name: &str) -> bool {
        self.event == event
            && (matches!(event, Event::UserPromptSubmit | Event::Stop)
                || self.matcher.as_ref().is_none_or(|matcher| {
                    // Bounded regex execution errors never broaden a match.
                    match matcher.is_match(name) {
                        Ok(matched) => matched,
                        Err(error) => {
                            tracing::warn!(%error, "hook matcher failed");
                            false
                        }
                    }
                }))
    }
}

/// One immutable snapshot plus the user-facing reasons any source was skipped.
pub(super) struct Loaded {
    pub hooks: Vec<ConfiguredHook>,
    pub diagnostics: Vec<String>,
}

pub(super) fn fingerprint(source: &Path, cwd: &Path, bytes: &[u8]) -> String {
    let mut hash = Sha256::new();
    hash.update(source.as_os_str().as_encoded_bytes());
    hash.update([0]);
    hash.update(cwd.as_os_str().as_encoded_bytes());
    hash.update([0]);
    hash.update(bytes);
    format!("{:x}", hash.finalize())
}

#[derive(Clone, Copy)]
enum SourceKind {
    Configuration,
    Trust,
}

#[cfg(unix)]
fn validate_owner(metadata: &std::fs::Metadata, path: &Path) -> anyhow::Result<()> {
    use std::os::unix::fs::MetadataExt;
    if metadata.uid() != crate::platform::process::current_user_id() || metadata.mode() & 0o022 != 0
    {
        bail!(
            "{} must be owned by the current user and not group/world writable",
            path.display()
        );
    }
    Ok(())
}

fn read_bounded(path: &Path, kind: SourceKind) -> anyhow::Result<Option<Vec<u8>>> {
    let mut options = std::fs::OpenOptions::new();
    options.read(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        // Reject symlinks atomically and avoid blocking on a FIFO before fstat.
        options.custom_flags(libc::O_NOFOLLOW | libc::O_NONBLOCK);
    }
    let file = match options.open(path) {
        Ok(file) => file,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(None),
        Err(error) => return Err(error).context("open hook file (symlinks are unsupported)"),
    };
    let metadata = file.metadata()?;
    if !metadata.is_file() {
        bail!("hook source must be a regular file");
    }
    #[cfg(unix)]
    if matches!(kind, SourceKind::Trust) {
        validate_owner(&metadata, path)?;
    }
    #[cfg(not(unix))]
    let _ = kind;
    let mut bytes = Vec::new();
    file.take(FILE_LIMIT + 1).read_to_end(&mut bytes)?;
    if bytes.len() as u64 > FILE_LIMIT {
        bail!("hook file exceeds 256 KiB");
    }
    Ok(Some(bytes))
}

/// Parsed hooks plus notices for the parts of a source that were skipped.
struct Parsed {
    hooks: Vec<ConfiguredHook>,
    notices: Vec<String>,
}

fn parse(bytes: &[u8], group_count: &mut usize) -> anyhow::Result<Parsed> {
    let document: Document = serde_json::from_slice(bytes).context("invalid hook configuration")?;
    let _ = document.description;
    *group_count += document.hooks.values().map(Vec::len).sum::<usize>();
    if *group_count > HANDLER_LIMIT {
        bail!("at most 32 hook groups total across user and project sources");
    }
    let mut notices = Vec::new();
    let mut ignore_fields = |scope: &str, unknown: BTreeMap<String, serde_json::Value>| {
        let names: Vec<_> = unknown
            .into_keys()
            .filter(|name| !COSMETIC_HANDLER_FIELDS.contains(&name.as_str()))
            .collect();
        if !names.is_empty() {
            notices.push(format!(
                "ignored unsupported {scope} field(s) {}",
                names.join(", ")
            ));
        }
    };
    ignore_fields("configuration", document.unknown);
    let mut hooks = Vec::new();
    let mut skipped = Vec::new();
    for (name, groups) in document.hooks {
        let Ok(event) = Event::parse(&name) else {
            skipped.push(format!("{name} hooks (unsupported event)"));
            continue;
        };
        for group in groups {
            ignore_fields(&format!("{name} group"), group.unknown);
            if group.matcher.as_ref().is_some_and(|m| m.len() > 1024) {
                skipped.push(format!("a {name} group (matcher exceeds 1024 bytes)"));
                continue;
            }
            let matcher = match group.matcher.as_deref() {
                _ if matches!(event, Event::UserPromptSubmit | Event::Stop) => None,
                None | Some("" | "*") => None,
                Some(pattern) => match RegexBuilder::new(pattern).backtrack_limit(10_000).build() {
                    Ok(matcher) => Some(matcher),
                    Err(error) => {
                        skipped.push(format!("a {name} group (invalid matcher: {error})"));
                        continue;
                    }
                },
            };
            for handler in group.hooks {
                let unknown = handler.unknown;
                // An unsupported handler is skipped without discarding the
                // rest of its source.
                let accepted = (|| -> Result<_, String> {
                    if handler.kind != "command" {
                        return Err(format!(
                            "type {} is unsupported; only command is supported",
                            handler.kind
                        ));
                    }
                    let command = handler.command.unwrap_or_default();
                    if command.trim().is_empty() || command.len() > 16 * 1024 {
                        return Err("command must contain 1..16384 bytes".into());
                    }
                    if event != Event::SessionEnd
                        && handler.background != (event == Event::PostToolUse)
                    {
                        return Err(if event == Event::PostToolUse {
                            "PostToolUse requires async:true".into()
                        } else {
                            format!("{name} requires synchronous execution")
                        });
                    }
                    let (default, maximum) = if event == Event::SessionEnd {
                        (1, 3)
                    } else {
                        (600, 600)
                    };
                    let timeout = handler.timeout.unwrap_or(default);
                    if !(1..=maximum).contains(&timeout) {
                        return Err(format!("timeout must be 1..{maximum} seconds"));
                    }
                    Ok((command, Duration::from_secs(timeout)))
                })();
                match accepted {
                    Ok((command, timeout)) => {
                        ignore_fields(&format!("{name} handler"), unknown);
                        hooks.push(ConfiguredHook {
                            event,
                            command,
                            timeout,
                            matcher: matcher.clone(),
                        });
                        if hooks.len() > HANDLER_LIMIT {
                            bail!("at most 32 command hooks may be configured");
                        }
                    }
                    Err(reason) => skipped.push(format!("a {name} handler ({reason})")),
                }
            }
        }
    }
    notices.extend(skipped.into_iter().map(|part| format!("skipped {part}")));
    Ok(Parsed { hooks, notices })
}

pub(super) fn load(cwd: &Path, agent_dir: &Path) -> anyhow::Result<Loaded> {
    let cwd = cwd
        .canonicalize()
        .context("hook working directory unavailable")?;
    let root = cwd
        .ancestors()
        .find(|path| path.join(".git").exists())
        .unwrap_or(&cwd);
    let user_source = agent_dir.join("hooks.json");
    // Mirrors the user source `<agent-dir>/hooks.json` and the existing
    // project configuration directory `.prime/agent/`.
    let project_source = root.join(".prime/agent/hooks.json");
    // Missing files are normal. Avoid even reading trust in the common no-hooks case.
    if !user_source.exists() && !project_source.exists() {
        return Ok(Loaded {
            hooks: Vec::new(),
            diagnostics: Vec::new(),
        });
    }
    let agent_dir = agent_dir
        .canonicalize()
        .context("hook trust directory unavailable")?;
    if agent_dir.starts_with(root) {
        bail!(
            "the agent directory {} is inside the project root {}, and project-local agent directories cannot authorize hooks; start the session from a directory outside it",
            agent_dir.display(),
            root.display()
        );
    }
    #[cfg(unix)]
    validate_owner(&std::fs::metadata(&agent_dir)?, &agent_dir)?;
    let trust_path = agent_dir.join("hook-trust.json");
    let trusted = match read_bounded(&trust_path, SourceKind::Trust)? {
        Some(bytes) => {
            let trust: Trust = serde_json::from_slice(&bytes)
                .with_context(|| format!("invalid hook trust file {}", trust_path.display()))?;
            if trust.version != 1 || trust.trusted.len() > 256 {
                bail!("hook trust requires version 1 and at most 256 fingerprints");
            }
            trust.trusted
        }
        None => Vec::new(),
    };
    let mut group_count = 0;
    let mut result = Vec::new();
    let mut diagnostics = Vec::new();
    for (source, project) in [(user_source, false), (project_source, true)] {
        // Commit a complete source only after all its checks pass. A project
        // file must never erase an already accepted user policy.
        let attempt = (|| -> anyhow::Result<_> {
            let Some(bytes) = read_bounded(&source, SourceKind::Configuration)? else {
                return Ok(None);
            };
            let canonical_source = source.canonicalize()?;
            if project && !canonical_source.starts_with(root) {
                bail!("project hook source must remain inside the project");
            }
            let digest = fingerprint(&canonical_source, &cwd, &bytes);
            if !trusted.contains(&digest) {
                tracing::warn!(source = %source.display(), fingerprint = %digest,
                    "hooks skipped: review exact source and add its fingerprint to user hook-trust.json (see docs/hooks.md)");
                diagnostics.push(format!(
                    "Hooks skipped: {} is not trusted for {}. Trust covers the file's path and bytes and the session directory, so an edit or another directory needs a new entry. After reviewing it, add this fingerprint to {} (see docs/hooks.md):\n{digest}",
                    source.display(),
                    cwd.display(),
                    trust_path.display(),
                ));
                return Ok(None);
            }
            let mut candidate_groups = group_count;
            let parsed = parse(&bytes, &mut candidate_groups)?;
            if result.len() + parsed.hooks.len() > HANDLER_LIMIT {
                bail!("at most 32 hooks total across user and project sources");
            }
            Ok(Some((parsed, candidate_groups)))
        })();
        match attempt {
            Ok(Some((parsed, candidate_groups))) => {
                group_count = candidate_groups;
                result.extend(parsed.hooks);
                if !parsed.notices.is_empty() {
                    diagnostics.push(format!(
                        "Hooks partially loaded from {}: {}. Its other hooks remain active.",
                        source.display(),
                        parsed.notices.join("; ")
                    ));
                }
            }
            Ok(None) => {}
            Err(error) => {
                tracing::warn!(source = %source.display(), %error,
                    "hook source skipped; other trusted sources remain active");
                diagnostics.push(format!(
                    "Hooks skipped: {}: {error:#}. Other trusted hook sources remain active.",
                    source.display()
                ));
            }
        }
    }
    Ok(Loaded {
        hooks: result,
        diagnostics,
    })
}

#[cfg(test)]
#[path = "config_tests.rs"]
mod tests;

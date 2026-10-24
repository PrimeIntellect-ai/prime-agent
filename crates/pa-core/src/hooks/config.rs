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

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct Document {
    #[serde(default)]
    description: Option<String>,
    hooks: BTreeMap<String, Vec<Group>>,
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct Group {
    matcher: Option<String>,
    hooks: Vec<Handler>,
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct Handler {
    #[serde(rename = "type")]
    kind: String,
    command: String,
    timeout: Option<u64>,
    #[serde(default, rename = "async")]
    background: bool,
}

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

fn parse(bytes: &[u8], group_count: &mut usize) -> anyhow::Result<Vec<ConfiguredHook>> {
    let document: Document = serde_json::from_slice(bytes).context("invalid hook configuration")?;
    let _ = document.description;
    *group_count += document.hooks.values().map(Vec::len).sum::<usize>();
    if *group_count > HANDLER_LIMIT {
        bail!("at most 32 hook groups total across user and project sources");
    }
    let mut hooks = Vec::new();
    for (event, groups) in document.hooks {
        let event = Event::parse(&event)?;
        for group in groups {
            if group.matcher.as_ref().is_some_and(|m| m.len() > 1024) {
                bail!("hook matcher exceeds 1024 bytes");
            }
            let matcher = match group.matcher.as_deref() {
                _ if matches!(event, Event::UserPromptSubmit | Event::Stop) => None,
                None | Some("" | "*") => None,
                Some(pattern) => Some(
                    RegexBuilder::new(pattern)
                        .backtrack_limit(10_000)
                        .build()
                        .context("invalid hook matcher")?,
                ),
            };
            for handler in group.hooks {
                if handler.kind != "command" {
                    bail!(
                        "unsupported hook handler {}; only command is supported",
                        handler.kind
                    );
                }
                if handler.command.trim().is_empty() || handler.command.len() > 16 * 1024 {
                    bail!("hook command must contain 1..16384 bytes");
                }
                if event != Event::SessionEnd && handler.background != (event == Event::PostToolUse)
                {
                    bail!(
                        "PostToolUse requires async:true; decision events require synchronous execution"
                    );
                }
                let (default, maximum) = if event == Event::SessionEnd {
                    (1, 3)
                } else {
                    (600, 600)
                };
                let timeout = handler.timeout.unwrap_or(default);
                if !(1..=maximum).contains(&timeout) {
                    bail!("hook timeout must be 1..{maximum} seconds");
                }
                hooks.push(ConfiguredHook {
                    event,
                    command: handler.command,
                    timeout: Duration::from_secs(timeout),
                    matcher: matcher.clone(),
                });
                if hooks.len() > HANDLER_LIMIT {
                    bail!("at most 32 command hooks may be configured");
                }
            }
        }
    }
    Ok(hooks)
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
    let project_source = root.join(".prime/hooks.json");
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
            let hooks = parse(&bytes, &mut candidate_groups)?;
            if result.len() + hooks.len() > HANDLER_LIMIT {
                bail!("at most 32 hooks total across user and project sources");
            }
            Ok(Some((hooks, candidate_groups)))
        })();
        match attempt {
            Ok(Some((hooks, candidate_groups))) => {
                group_count = candidate_groups;
                result.extend(hooks);
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

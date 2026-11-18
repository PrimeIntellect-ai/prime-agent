//! Per-skill status: why each discovered skill is or is not part of the
//! session, read off the resolution and load results (`prime-agent skills`
//! lists them; a session start reports the problems).

use std::path::{Path, PathBuf};

use serde::Serialize;

use crate::packages::{DisabledBy, MetadataSource, ResolvedResource};
use crate::skills::{ResourceDiagnostic, Skill};

/// Why a discovered skill is or is not part of the session.
#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(tag = "state", rename_all = "camelCase")]
pub enum SkillState {
    Active,
    /// `disable-model-invocation`: out of the prompt, callable via `/skill:<name>`.
    Hidden,
    /// A project Python skill: its markdown loads, its code does not.
    ProjectCodeNotLoaded,
    /// Another skill with the same name loaded first.
    #[serde(rename_all = "camelCase")]
    Shadowed {
        winner_path: String,
    },
    /// The bundled skill with the same name wins; `"skills": ["-<name>"]` in
    /// the global settings file disables it so this one loads.
    #[serde(rename_all = "camelCase")]
    IgnoredForBundled {
        winner_path: String,
        settings_path: String,
    },
    Disabled {
        by: DisabledBy,
    },
    Invalid {
        message: String,
    },
}

impl SkillState {
    /// The states a session start reports: the user expects these skills
    /// and does not get them.
    #[must_use]
    pub fn is_problem(&self) -> bool {
        match self {
            SkillState::Shadowed { .. }
            | SkillState::IgnoredForBundled { .. }
            | SkillState::Invalid { .. } => true,
            SkillState::Active
            | SkillState::Hidden
            | SkillState::ProjectCodeNotLoaded
            | SkillState::Disabled { .. } => false,
        }
    }
}

/// One discovered skill file and its state.
#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct SkillStatus {
    pub name: String,
    pub path: String,
    #[serde(flatten)]
    pub state: SkillState,
}

impl SkillStatus {
    /// The state in plain words.
    #[must_use]
    pub fn describe(&self) -> String {
        match &self.state {
            SkillState::Active => "active".to_string(),
            SkillState::Hidden => format!("hidden from the model (use /skill:{})", self.name),
            SkillState::ProjectCodeNotLoaded => {
                "active as markdown (project Python code is not loaded)".to_string()
            }
            SkillState::Shadowed { winner_path } => {
                format!("not loaded: {winner_path} has the same name and loads first")
            }
            SkillState::IgnoredForBundled { settings_path, .. } => format!(
                "not loaded: the bundled skill \"{name}\" wins; to use this one instead, add \"skills\": [\"-{name}\"] to {settings_path}",
                name = self.name
            ),
            SkillState::Disabled { by } => match by {
                DisabledBy::Settings => "disabled in settings".to_string(),
                DisabledBy::WebSearchOff => "disabled: web search is off (no key for the selected provider, or bundledSkills.websearch is false)".to_string(),
                DisabledBy::McpLogin => {
                    "disabled: its MCP integration is not logged in".to_string()
                }
            },
            SkillState::Invalid { message } => format!("invalid: {message}"),
        }
    }
}

/// A skill name from its file: the directory of a `SKILL.md`, else the
/// file stem (the loader's fallback when frontmatter names nothing).
fn name_from_path(path: &Path) -> String {
    let named = if path.file_name().is_some_and(|name| name == "SKILL.md") {
        path.parent().and_then(Path::file_name)
    } else {
        path.file_stem()
    };
    named.map_or_else(String::new, |name| name.to_string_lossy().into_owned())
}

/// The status of every discovered skill: the loaded skills (with the
/// project-code demotion `demoted` marks), the collision losers, the
/// disabled resolved entries, and the files that failed to load. Sorted by
/// name, then path. A collision lost to a bundled skill also gets the
/// settings hint in its diagnostic message.
pub(super) fn skill_statuses(
    skills: &[Skill],
    demoted: &[PathBuf],
    diagnostics: &mut [ResourceDiagnostic],
    resolved: &[ResolvedResource],
    global_settings_path: &Path,
) -> Vec<SkillStatus> {
    let mut statuses: Vec<SkillStatus> = skills
        .iter()
        .map(|skill| SkillStatus {
            name: skill.name.clone(),
            path: skill.file_path.display().to_string(),
            state: if demoted.contains(&skill.file_path) {
                SkillState::ProjectCodeNotLoaded
            } else if skill.disable_model_invocation {
                SkillState::Hidden
            } else {
                SkillState::Active
            },
        })
        .collect();
    let is_bundled = |path: &Path| {
        resolved.iter().any(|resource| {
            resource.metadata.source == MetadataSource::Builtin && path.starts_with(&resource.path)
        })
    };
    let mut failed: Vec<(String, Vec<String>)> = Vec::new();
    for diagnostic in diagnostics.iter_mut() {
        match diagnostic {
            ResourceDiagnostic::Collision {
                message, collision, ..
            } => {
                let status = SkillStatus {
                    name: collision.name.clone(),
                    path: collision.loser_path.clone(),
                    state: if is_bundled(Path::new(&collision.winner_path)) {
                        SkillState::IgnoredForBundled {
                            winner_path: collision.winner_path.clone(),
                            settings_path: global_settings_path.display().to_string(),
                        }
                    } else {
                        SkillState::Shadowed {
                            winner_path: collision.winner_path.clone(),
                        }
                    },
                };
                if matches!(status.state, SkillState::IgnoredForBundled { .. }) {
                    *message = format!("{message}: {}", status.describe());
                }
                statuses.push(status);
            }
            // A warning on a skill file that did not load is why it did not
            // load; warnings on loaded skills (and on pyproject files) are not.
            ResourceDiagnostic::Warning {
                message,
                path: Some(path),
            }
            | ResourceDiagnostic::Error {
                message,
                path: Some(path),
            } if Path::new(path.as_str())
                .extension()
                .is_some_and(|ext| ext == "md")
                && !skills
                    .iter()
                    .any(|skill| skill.file_path.as_path() == Path::new(path.as_str())) =>
            {
                match failed
                    .iter_mut()
                    .find(|(failed_path, _)| failed_path.as_str() == path.as_str())
                {
                    Some((_, messages)) => messages.push(message.clone()),
                    None => failed.push((path.clone(), vec![message.clone()])),
                }
            }
            ResourceDiagnostic::Warning { .. } | ResourceDiagnostic::Error { .. } => {}
        }
    }
    statuses.extend(failed.into_iter().map(|(path, messages)| SkillStatus {
        name: name_from_path(Path::new(&path)),
        path,
        state: SkillState::Invalid {
            message: messages.join("; "),
        },
    }));
    statuses.extend(resolved.iter().filter_map(|resource| {
        resource.disabled_by.map(|by| SkillStatus {
            name: name_from_path(&resource.path),
            path: resource.path.display().to_string(),
            state: SkillState::Disabled { by },
        })
    }));
    statuses.sort_by(|a, b| a.name.cmp(&b.name).then_with(|| a.path.cmp(&b.path)));
    statuses
}

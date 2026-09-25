//! Skill loading from all configured locations. Port of loadSkills in skills.ts.

use std::collections::{HashMap, HashSet};
use std::path::{Path, PathBuf};

use super::diagnostics::{ResourceCollision, ResourceDiagnostic};
use super::discovery::{load_skill_from_file, load_skills_from_dir};
use super::Skill;

pub struct LoadSkillsOptions {
    /// Working directory for project-local skills.
    pub cwd: PathBuf,
    /// Agent config directory for global skills.
    pub agent_dir: PathBuf,
    /// Explicit skill paths (files or directories).
    pub skill_paths: Vec<String>,
    /// Include default skills directories.
    pub include_defaults: bool,
}

pub struct LoadSkillsResult {
    pub skills: Vec<Skill>,
    pub diagnostics: Vec<ResourceDiagnostic>,
}

/// Agent-side config dir name (TS `CONFIG_DIR_NAME`).
pub const CONFIG_DIR_NAME: &str = ".prime/agent";

fn normalize_path(input: &str) -> PathBuf {
    let trimmed = input.trim();
    if trimmed == "~" {
        return home_dir();
    }
    if let Some(rest) = trimmed.strip_prefix("~/") {
        return home_dir().join(rest);
    }
    if let Some(rest) = trimmed.strip_prefix('~') {
        return home_dir().join(rest);
    }
    PathBuf::from(trimmed)
}

fn home_dir() -> PathBuf {
    pa_types::platform::home_dir().unwrap_or_else(|| PathBuf::from("."))
}

fn resolve_skill_path(path: &str, cwd: &Path) -> PathBuf {
    let normalized = normalize_path(path);
    if normalized.is_absolute() {
        normalized
    } else {
        cwd.join(normalized)
    }
}

/// canonicalizePath: realpath on success, the input path otherwise.
pub fn canonicalize_path(path: &Path) -> PathBuf {
    std::fs::canonicalize(path).unwrap_or_else(|_| path.to_path_buf())
}

fn is_under_path(target: &Path, root: &Path) -> bool {
    let root = canonicalize_path(root);
    let target = canonicalize_path(target);
    target == root || target.starts_with(&root)
}

/// Load skills from all configured locations.
pub fn load_skills(options: &LoadSkillsOptions) -> LoadSkillsResult {
    let mut skill_map: HashMap<String, Skill> = HashMap::new();
    let mut real_path_set: HashSet<PathBuf> = HashSet::new();
    let mut python_import_map: HashMap<String, String> = HashMap::new();
    let mut all_diagnostics: Vec<ResourceDiagnostic> = Vec::new();
    let mut collision_diagnostics: Vec<ResourceDiagnostic> = Vec::new();
    let mut python_import_diagnostics: Vec<ResourceDiagnostic> = Vec::new();

    let add_skill = |skill: Skill,
                     skill_map: &mut HashMap<String, Skill>,
                     real_path_set: &mut HashSet<PathBuf>,
                     python_import_map: &mut HashMap<String, String>,
                     collision_diagnostics: &mut Vec<ResourceDiagnostic>,
                     python_import_diagnostics: &mut Vec<ResourceDiagnostic>| {
        let real_path = canonicalize_path(&skill.file_path);
        if real_path_set.contains(&real_path) {
            return;
        }
        if let Some(existing) = skill_map.get(&skill.name) {
            collision_diagnostics.push(ResourceDiagnostic::Collision {
                message: format!("name \"{}\" collision", skill.name),
                path: skill.file_path.display().to_string(),
                collision: ResourceCollision {
                    resource_type: "skill",
                    name: skill.name.clone(),
                    winner_path: existing.file_path.display().to_string(),
                    loser_path: skill.file_path.display().to_string(),
                },
            });
        } else {
            real_path_set.insert(real_path);
            if let Some(python) = &skill.python {
                let existing = python_import_map.get(&python.import_name).cloned();
                match existing {
                    Some(existing_name) => python_import_diagnostics.push(ResourceDiagnostic::Warning {
                        message: format!(
                            "python import name \"{}\" is shared by skills \"{existing_name}\" and \"{}\"",
                            python.import_name, skill.name
                        ),
                        path: Some(skill.file_path.display().to_string()),
                    }),
                    None => {
                        python_import_map.insert(python.import_name.clone(), skill.name.clone());
                    }
                }
            }
            skill_map.insert(skill.name.clone(), skill);
        }
    };

    let user_skills_dir = options.agent_dir.join("skills");
    let project_skills_dir = options.cwd.join(CONFIG_DIR_NAME).join("skills");

    if options.include_defaults {
        let user_result = load_skills_from_dir(&user_skills_dir, "user");
        all_diagnostics.extend(user_result.diagnostics);
        for skill in user_result.skills {
            add_skill(
                skill,
                &mut skill_map,
                &mut real_path_set,
                &mut python_import_map,
                &mut collision_diagnostics,
                &mut python_import_diagnostics,
            );
        }
        let project_result = load_skills_from_dir(&project_skills_dir, "project");
        all_diagnostics.extend(project_result.diagnostics);
        for skill in project_result.skills {
            add_skill(
                skill,
                &mut skill_map,
                &mut real_path_set,
                &mut python_import_map,
                &mut collision_diagnostics,
                &mut python_import_diagnostics,
            );
        }
    }

    for raw_path in &options.skill_paths {
        let resolved_path = resolve_skill_path(raw_path, &options.cwd);
        if !resolved_path.exists() {
            all_diagnostics.push(ResourceDiagnostic::Warning {
                message: "skill path does not exist".to_string(),
                path: Some(resolved_path.display().to_string()),
            });
            continue;
        }
        let source = if options.include_defaults {
            "path"
        } else if is_under_path(&resolved_path, &user_skills_dir) {
            "user"
        } else if is_under_path(&resolved_path, &project_skills_dir) {
            "project"
        } else {
            "path"
        };
        let meta = match std::fs::metadata(&resolved_path) {
            Ok(meta) => meta,
            Err(error) => {
                all_diagnostics.push(ResourceDiagnostic::Warning {
                    message: error.to_string(),
                    path: Some(resolved_path.display().to_string()),
                });
                continue;
            }
        };
        if meta.is_dir() {
            let result = load_skills_from_dir(&resolved_path, source);
            all_diagnostics.extend(result.diagnostics);
            for skill in result.skills {
                add_skill(
                    skill,
                    &mut skill_map,
                    &mut real_path_set,
                    &mut python_import_map,
                    &mut collision_diagnostics,
                    &mut python_import_diagnostics,
                );
            }
        } else if meta.is_file() && resolved_path.extension().is_some_and(|ext| ext == "md") {
            let (skill, diagnostics) = load_skill_from_file(&resolved_path, source);
            match skill {
                Some(skill) => {
                    all_diagnostics.extend(diagnostics);
                    add_skill(
                        skill,
                        &mut skill_map,
                        &mut real_path_set,
                        &mut python_import_map,
                        &mut collision_diagnostics,
                        &mut python_import_diagnostics,
                    );
                }
                None => all_diagnostics.extend(diagnostics),
            }
        } else {
            all_diagnostics.push(ResourceDiagnostic::Warning {
                message: "skill path is not a markdown file".to_string(),
                path: Some(resolved_path.display().to_string()),
            });
        }
    }

    let mut diagnostics = all_diagnostics;
    diagnostics.extend(collision_diagnostics);
    diagnostics.extend(python_import_diagnostics);
    LoadSkillsResult {
        skills: skill_map.into_values().collect(),
        diagnostics,
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::skills::SourceScope;
    use std::fs;

    fn write_skill(dir: &Path, name: &str, description: &str) {
        let skill_dir = dir.join(name);
        fs::create_dir_all(&skill_dir).unwrap();
        fs::write(
            skill_dir.join("SKILL.md"),
            format!("---\nname: {name}\ndescription: {description}\n---\nbody"),
        )
        .unwrap();
    }

    #[test]
    fn loads_user_and_project_skills_with_collision() {
        let tmp = tempfile::tempdir().unwrap();
        let agent_dir = tmp.path().join("agent");
        let project = tmp.path().join("project");
        fs::create_dir_all(agent_dir.join("skills")).unwrap();
        fs::create_dir_all(project.join(".prime").join("skills")).unwrap();
        write_skill(&agent_dir.join("skills"), "alpha", "user alpha");
        write_skill(&agent_dir.join("skills"), "beta", "user beta");
        write_skill(
            &project.join(".prime").join("agent").join("skills"),
            "beta",
            "project beta",
        );
        let result = load_skills(&LoadSkillsOptions {
            cwd: project,
            agent_dir,
            skill_paths: vec![],
            include_defaults: true,
        });
        let names: Vec<&str> = result.skills.iter().map(|s| s.name.as_str()).collect();
        assert!(names.contains(&"alpha"));
        assert!(names.contains(&"beta"));
        // The user-scope skill wins; the project copy reports a collision.
        let beta = result.skills.iter().find(|s| s.name == "beta").unwrap();
        assert!(beta.source_info.scope == SourceScope::User);
        assert!(result
            .diagnostics
            .iter()
            .any(|d| matches!(d, ResourceDiagnostic::Collision { .. })));
    }

    #[test]
    fn explicit_paths_and_missing_paths() {
        let tmp = tempfile::tempdir().unwrap();
        let agent_dir = tmp.path().join("agent");
        let project = tmp.path().join("project");
        fs::create_dir_all(&agent_dir).unwrap();
        fs::create_dir_all(&project).unwrap();
        let lone = project.join("lone.md");
        fs::write(&lone, "---\ndescription: a lone skill\n---\nbody").unwrap();
        let result = load_skills(&LoadSkillsOptions {
            cwd: project,
            agent_dir,
            skill_paths: vec![lone.display().to_string(), "/missing/skill".to_string()],
            include_defaults: false,
        });
        // lone.md: name falls back to the parent directory name.
        assert!(result.skills.iter().any(|s| s.name == "project"));
        assert!(result.diagnostics.iter().any(
            |d| matches!(d, ResourceDiagnostic::Warning { message, path }
                if path.is_some() && path.as_ref().unwrap().contains("missing"))
        ));
    }
}

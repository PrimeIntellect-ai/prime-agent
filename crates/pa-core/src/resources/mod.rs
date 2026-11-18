//! Project context files (AGENTS.md/CLAUDE.md discovery) and the resource
//! loader: skills, prompt templates, agents files, and system-prompt
//! sources, resolved from configured packages, settings, auto-discovery,
//! and bundled skills through the package manager. Theme loading lives in pa-tui.

use std::collections::HashSet;
use std::path::{Path, PathBuf};

use crate::skills::diagnostics::ResourceDiagnostic;
use crate::skills::{
    load_prompt_templates, load_skills, LoadPromptTemplatesOptions, LoadSkillsOptions,
    PromptTemplate, Skill, SkillKind, SourceScope,
};

/// AGENTS.md-family candidates, in priority order.
const CONTEXT_FILE_CANDIDATES: [&str; 4] = ["AGENTS.md", "AGENTS.MD", "CLAUDE.md", "CLAUDE.MD"];

#[derive(Debug, Clone, PartialEq)]
pub struct ContextFile {
    pub path: PathBuf,
    pub content: String,
}

fn load_context_file_from_dir(dir: &Path) -> Option<ContextFile> {
    for filename in CONTEXT_FILE_CANDIDATES {
        let file_path = dir.join(filename);
        if let Ok(content) = std::fs::read_to_string(&file_path) {
            return Some(ContextFile {
                path: file_path,
                content,
            });
        }
    }
    None
}

/// Load the global (agentDir) context file first, then the nearest-to-root ancestor chain of cwd.
#[must_use]
pub fn load_project_context_files(cwd: &Path, agent_dir: &Path) -> Vec<ContextFile> {
    let mut context_files = Vec::new();
    let mut seen: HashSet<PathBuf> = HashSet::new();
    if let Some(global) = load_context_file_from_dir(agent_dir) {
        seen.insert(global.path.clone());
        context_files.push(global);
    }

    // Walk cwd upward, collecting context files; root-most first in output.
    let mut ancestors = Vec::new();
    let mut current = cwd.to_path_buf();
    loop {
        if let Some(found) = load_context_file_from_dir(&current) {
            if seen.insert(found.path.clone()) {
                ancestors.push(found);
            }
        }
        let Some(parent) = current.parent() else {
            break;
        };
        if parent == current {
            break;
        }
        current = parent.to_path_buf();
    }
    ancestors.reverse();
    context_files.extend(ancestors);
    context_files
}

// Session resource resolution (package-manager `resolve()`) feeds the loader below.
pub(crate) mod resolution;
mod skill_status;

pub use skill_status::{SkillState, SkillStatus};

use anyhow::Result;

use crate::packages::BundledSkillsDir;
use crate::settings::SettingsManager;

#[derive(Debug, Default)]
pub struct LoadedResources {
    pub skills: Vec<Skill>,
    pub skill_diagnostics: Vec<ResourceDiagnostic>,
    /// Every discovered skill and why it is or is not in the session.
    pub skill_statuses: Vec<SkillStatus>,
    pub prompts: Vec<PromptTemplate>,
    pub agents_files: Vec<ContextFile>,
    pub system_prompt: Option<String>,
    pub append_system_prompt: Vec<String>,
}

/// Resource loading options (the TS `DefaultResourceLoaderOptions` surface, minus the theme
/// machinery).
#[derive(Default)]
pub struct ResourceLoaderOptions {
    pub cwd: PathBuf,
    pub agent_dir: PathBuf,
    /// Settings manager for package resolution; loaded from disk when `None`.
    pub settings: Option<SettingsManager>,
    /// Built-in skills directory (default: the packaged layout).
    pub bundled_skills_dir: BundledSkillsDir,
    /// Extra force-exclude patterns for built-in skills.
    pub extra_builtin_skill_overrides: Vec<String>,
    pub additional_skill_paths: Vec<String>,
    pub additional_prompt_paths: Vec<String>,
    pub no_skills: bool,
    pub no_prompt_templates: bool,
    pub no_context_files: bool,
    pub system_prompt: Option<String>,
    pub append_system_prompt: Vec<String>,
}

impl ResourceLoaderOptions {
    /// Options with just the working directories set.
    pub fn new(cwd: impl Into<PathBuf>, agent_dir: impl Into<PathBuf>) -> Self {
        Self {
            cwd: cwd.into(),
            agent_dir: agent_dir.into(),
            ..Default::default()
        }
    }
}

/// The user's MCP gating of session resources: `-<server>/SKILL.md`
/// overrides for the built-in integrations the user is not logged into, the
/// enabled persistent generic servers, and the manager that decided them.
/// MCP execution is user/global only (TS `getGlobalMcpServers`), so only the
/// global settings count. Reads the auth store under a blocking lock.
#[must_use]
pub fn mcp_gating(
    global_settings: &crate::settings::Settings,
    agent_dir: &Path,
) -> (Vec<String>, Vec<String>, crate::mcp::McpManager) {
    let user_servers = global_settings
        .mcp_servers
        .clone()
        .unwrap_or_default()
        .into_iter()
        .filter_map(|(server, config)| {
            serde_json::from_value(config)
                .ok()
                .map(|parsed| (server, parsed))
        })
        .collect::<std::collections::HashMap<String, crate::mcp::McpServerConfig>>();
    crate::mcp::McpManager::prompt_gating(user_servers, agent_dir)
}

/// Load all session resources: package-manager resolution (configured
/// packages, settings arrays, auto-discovery, bundled skills) feeds the
/// enabled skill and prompt paths.
///
/// # Errors
///
/// Error when a configured package source cannot be parsed, installed, or refreshed.
pub fn load_resources(mut options: ResourceLoaderOptions) -> Result<LoadedResources> {
    let settings = options
        .settings
        .take()
        .unwrap_or_else(|| SettingsManager::create(&options.cwd, &options.agent_dir));
    let resolution = resolution::resolve_session_resources(&options, settings)?;

    let mut resources = LoadedResources::default();

    // Skills: bundled skills, then CLI/additional paths, then resolved paths
    // in precedence order; name collisions resolve first-wins in load order.
    let skills_result = if options.no_skills && resolution.skill_paths.is_empty() {
        crate::skills::LoadSkillsResult {
            skills: Vec::new(),
            diagnostics: Vec::new(),
        }
    } else {
        load_skills(&LoadSkillsOptions {
            cwd: options.cwd.clone(),
            agent_dir: options.agent_dir.clone(),
            skill_paths: resolution.skill_paths.clone(),
            include_defaults: false,
        })
    };
    let mut demoted: Vec<PathBuf> = Vec::new();
    resources.skills = skills_result
        .skills
        .into_iter()
        .map(|mut skill| {
            if let Some(source_info) =
                resolution::find_source_info(&resolution.source_infos, &skill.file_path)
            {
                skill.source_info = source_info;
            }
            if skill.source_info.scope == SourceScope::Project && skill.is_python() {
                // Project files can supply pyproject.toml and Python modules.
                // Keep the skill's markdown text, but do not offer or prepare
                // executable code from a repository on session startup.
                skill.kind = SkillKind::Markdown;
                skill.python = None;
                demoted.push(skill.file_path.clone());
            }
            skill
        })
        .collect();
    resources.skill_diagnostics = skills_result.diagnostics;
    // Resolution-time warnings (e.g. missing bundled skills directory).
    resources
        .skill_diagnostics
        .extend(resolution.resolved.diagnostics.clone());
    for path in &options.additional_skill_paths {
        if is_local_path(path)
            && !Path::new(path).exists()
            && !resources
                .skill_diagnostics
                .iter()
                .any(|d| diagnostics_path(d) == Some(path.clone()))
        {
            resources.skill_diagnostics.push(ResourceDiagnostic::Error {
                message: "Skill path does not exist".to_string(),
                path: Some(path.clone()),
            });
        }
    }
    resources.skill_statuses = skill_status::skill_statuses(
        &resources.skills,
        &demoted,
        &mut resources.skill_diagnostics,
        &resolution.resolved.skills,
        &options.agent_dir.join("settings.json"),
    );

    // Prompt templates: CLI paths + resolved paths, then additional paths.
    let all_prompts = if options.no_prompt_templates && resolution.prompt_paths.is_empty() {
        Vec::new()
    } else {
        load_prompt_templates(&LoadPromptTemplatesOptions {
            cwd: options.cwd.clone(),
            agent_dir: options.agent_dir.clone(),
            prompt_paths: resolution.prompt_paths.clone(),
            include_defaults: false,
        })
    };
    resources.prompts = dedupe_prompts(all_prompts)
        .into_iter()
        .map(|mut prompt| {
            if let Some(source_info) =
                resolution::find_source_info(&resolution.source_infos, Path::new(&prompt.file_path))
            {
                prompt.source_info = source_info;
            }
            prompt
        })
        .collect();
    for path in &options.additional_prompt_paths {
        if is_local_path(path) && !Path::new(path).exists() {
            resources.skill_diagnostics.push(ResourceDiagnostic::Error {
                message: "Prompt template path does not exist".to_string(),
                path: Some(path.clone()),
            });
        }
    }

    // Agents files (project context).
    if !options.no_context_files {
        resources.agents_files = load_project_context_files(&options.cwd, &options.agent_dir);
    }

    // System prompt: explicit source or discovered file content.
    let system_source = options.system_prompt.clone().or_else(|| {
        discover_system_prompt_file(&options.cwd, &options.agent_dir)
            .map(|p| p.to_string_lossy().to_string())
    });
    resources.system_prompt = system_source.and_then(|source| resolve_prompt_input(&source));

    // Append system prompt: explicit sources or discovered file.
    let append_sources: Vec<String> = if options.append_system_prompt.is_empty() {
        discover_append_system_prompt_file(&options.cwd, &options.agent_dir)
            .map(|path| path.to_string_lossy().to_string())
            .into_iter()
            .collect()
    } else {
        options.append_system_prompt.clone()
    };
    resources.append_system_prompt = append_sources
        .iter()
        .filter_map(|source| resolve_prompt_input(source))
        .collect();

    Ok(resources)
}

fn diagnostics_path(diagnostic: &ResourceDiagnostic) -> Option<String> {
    match diagnostic {
        ResourceDiagnostic::Warning { path, .. } | ResourceDiagnostic::Error { path, .. } => {
            path.clone()
        }
        ResourceDiagnostic::Collision { path, .. } => Some(path.clone()),
    }
}

fn resolve_prompt_input(input: &str) -> Option<String> {
    let path = Path::new(input);
    if path.exists() {
        return std::fs::read_to_string(path).ok();
    }
    Some(input.to_string())
}

fn is_local_path(path: &str) -> bool {
    let trimmed = path.trim();
    !(trimmed.starts_with("npm:")
        || trimmed.starts_with("git:")
        || trimmed.starts_with("http://")
        || trimmed.starts_with("https://"))
}

/// Later same-name templates win? No: TS dedupe keeps the FIRST of each name.
fn dedupe_prompts(prompts: Vec<PromptTemplate>) -> Vec<PromptTemplate> {
    let mut seen = HashSet::new();
    let mut out = Vec::new();
    for prompt in prompts {
        if seen.insert(prompt.name.clone()) {
            out.push(prompt);
        }
    }
    out
}

/// `cwd/{CONFIG_DIR_NAME}/SYSTEM.md` then agentDir/SYSTEM.md.
#[must_use]
pub fn discover_system_prompt_file(cwd: &Path, agent_dir: &Path) -> Option<PathBuf> {
    let project = cwd.join(crate::settings::CONFIG_DIR_NAME).join("SYSTEM.md");
    if project.exists() {
        return Some(project);
    }
    let global = agent_dir.join("SYSTEM.md");
    if global.exists() {
        return Some(global);
    }
    None
}

/// `cwd/{CONFIG_DIR_NAME}/APPEND_SYSTEM.md` then `agentDir/APPEND_SYSTEM.md`.
#[must_use]
pub fn discover_append_system_prompt_file(cwd: &Path, agent_dir: &Path) -> Option<PathBuf> {
    let project = cwd
        .join(crate::settings::CONFIG_DIR_NAME)
        .join("APPEND_SYSTEM.md");
    if project.exists() {
        return Some(project);
    }
    let global = agent_dir.join("APPEND_SYSTEM.md");
    if global.exists() {
        return Some(global);
    }
    None
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::packages::DisabledBy;
    use std::fs;

    #[test]
    fn context_files_global_then_ancestors_root_first() {
        let tmp = tempfile::tempdir().unwrap();
        let agent_dir = tmp.path().join("agent");
        let deep = tmp.path().join("a").join("b");
        fs::create_dir_all(&agent_dir).unwrap();
        fs::create_dir_all(&deep).unwrap();
        fs::write(agent_dir.join("AGENTS.md"), "global").unwrap();
        fs::write(tmp.path().join("a").join("AGENTS.md"), "level-a").unwrap();
        fs::write(deep.join("AGENTS.md"), "deep").unwrap();
        let files = load_project_context_files(&deep, &agent_dir);
        let contents: Vec<&str> = files.iter().map(|f| f.content.as_str()).collect();
        assert_eq!(contents, vec!["global", "level-a", "deep"]);
    }

    #[test]
    fn system_prompt_discovery_prefers_project() {
        let tmp = tempfile::tempdir().unwrap();
        let agent_dir = tmp.path().join("agent");
        let project = tmp.path().join("proj");
        fs::create_dir_all(agent_dir.join(".prime").join("agent")).unwrap();
        fs::create_dir_all(project.join(".prime").join("agent")).unwrap();
        fs::write(
            agent_dir.join(".prime").join("agent").join("SYSTEM.md"),
            "global system",
        )
        .unwrap();
        fs::write(
            project.join(".prime").join("agent").join("SYSTEM.md"),
            "project system",
        )
        .unwrap();
        let found = discover_system_prompt_file(&project, &agent_dir).unwrap();
        assert!(found.to_string_lossy().contains("proj"));
        assert_eq!(
            resolve_prompt_input(&found.to_string_lossy()),
            Some("project system".to_string())
        );
    }

    #[test]
    fn resources_load_end_to_end() {
        let tmp = tempfile::tempdir().unwrap();
        let agent_dir = tmp.path().join("agent");
        let cwd = tmp.path().join("proj");
        fs::create_dir_all(agent_dir.join("skills").join("alpha")).unwrap();
        fs::create_dir_all(cwd.join(".prime").join("agent").join("prompts")).unwrap();
        fs::create_dir_all(&cwd).unwrap();
        fs::write(
            agent_dir.join("skills").join("alpha").join("SKILL.md"),
            "---\nname: alpha\ndescription: Alpha skill\n---\nbody",
        )
        .unwrap();
        fs::write(
            cwd.join(".prime")
                .join("agent")
                .join("prompts")
                .join("fix.md"),
            "Fix $1",
        )
        .unwrap();
        fs::write(cwd.join("AGENTS.md"), "Project rules").unwrap();
        fs::write(
            cwd.join(".prime").join("agent").join("SYSTEM.md"),
            "custom system",
        )
        .unwrap();
        let resources = load_resources(ResourceLoaderOptions {
            cwd,
            agent_dir,
            ..Default::default()
        })
        .unwrap();
        assert!(resources.skills.iter().any(|s| s.name == "alpha"));
        assert!(resources.prompts.iter().any(|p| p.name == "fix"));
        assert_eq!(resources.agents_files.len(), 1);
        assert_eq!(resources.agents_files[0].content, "Project rules");
        assert_eq!(resources.system_prompt.as_deref(), Some("custom system"));
        assert!(resources.append_system_prompt.is_empty());
    }

    #[test]
    fn package_provided_skills_and_prompts_load_into_a_session() {
        let tmp = tempfile::tempdir().unwrap();
        let agent_dir = tmp.path().join("agent");
        let cwd = tmp.path().join("proj");
        fs::create_dir_all(&agent_dir).unwrap();
        fs::create_dir_all(&cwd).unwrap();
        let pkg = tmp.path().join("fixture-pkg");
        fs::create_dir_all(pkg.join("skills").join("pack-skill")).unwrap();
        fs::create_dir_all(pkg.join("prompts")).unwrap();
        fs::write(
            pkg.join("package.json"),
            r#"{"name":"fixture-pkg","version":"1.0.0"}"#,
        )
        .unwrap();
        fs::write(
            pkg.join("skills").join("pack-skill").join("SKILL.md"),
            "---\nname: pack-skill\ndescription: From the package\n---\nBody",
        )
        .unwrap();
        fs::write(pkg.join("prompts").join("fix.md"), "Fix $1").unwrap();
        fs::write(
            agent_dir.join("settings.json"),
            serde_json::json!({"packages": ["../fixture-pkg"]}).to_string(),
        )
        .unwrap();

        let resources = load_resources(ResourceLoaderOptions::new(&cwd, &agent_dir)).unwrap();
        let skill = resources
            .skills
            .iter()
            .find(|skill| skill.name == "pack-skill")
            .expect("package skill loaded");
        assert_eq!(skill.source_info.source, "../fixture-pkg");
        assert_eq!(
            skill.source_info.origin,
            crate::skills::SourceOrigin::Package
        );
        let prompt = resources
            .prompts
            .iter()
            .find(|prompt| prompt.name == "fix")
            .expect("package prompt loaded");
        assert_eq!(prompt.source_info.source, "../fixture-pkg");
    }

    #[test]
    fn project_python_skills_are_markdown_only_before_kernel_bootstrap() {
        let tmp = tempfile::tempdir().unwrap();
        let cwd = tmp.path().join("project");
        let agent_dir = tmp.path().join("agent");
        let project_skill = cwd.join(".prime/agent/skills/project-code");
        let configured_skill = tmp.path().join("configured/configured-code");
        let ancestor_skill = tmp.path().join(".agents/skills/ancestor-code");
        let user_skill = agent_dir.join("skills/user-code");
        for (dir, name) in [
            (&project_skill, "project-code"),
            (&configured_skill, "configured-code"),
            (&ancestor_skill, "ancestor-code"),
            (&user_skill, "user-code"),
        ] {
            fs::create_dir_all(dir.join("src").join(name.replace('-', "_"))).unwrap();
            fs::write(
                dir.join("SKILL.md"),
                format!("---\nname: {name}\ndescription: Python skill\n---\nBody"),
            )
            .unwrap();
            fs::write(
                dir.join("pyproject.toml"),
                "[project]\nname = \"skill\"\nversion = \"0.1.0\"\n",
            )
            .unwrap();
            fs::write(
                dir.join("src")
                    .join(name.replace('-', "_"))
                    .join("__init__.py"),
                "# would execute if imported\n",
            )
            .unwrap();
        }
        fs::write(
            cwd.join(".prime/agent/settings.json"),
            serde_json::json!({"skills": [configured_skill.display().to_string()] }).to_string(),
        )
        .unwrap();
        let resources = load_resources(ResourceLoaderOptions::new(&cwd, &agent_dir)).unwrap();
        for name in ["project-code", "configured-code", "ancestor-code"] {
            let project = resources
                .skills
                .iter()
                .find(|skill| skill.name == name)
                .unwrap();
            assert_eq!(project.source_info.scope, SourceScope::Project);
            assert_eq!(project.kind, SkillKind::Markdown);
            assert!(project.python.is_none());
        }
        let user = resources
            .skills
            .iter()
            .find(|skill| skill.name == "user-code")
            .unwrap();
        assert_eq!(user.source_info.scope, SourceScope::User);
        assert_eq!(user.kind, SkillKind::Python);
        let imports =
            crate::session_engine::runtime_wiring::kernel_python_skills(&resources.skills)
                .into_iter()
                .map(|skill| skill.import_name)
                .collect::<Vec<_>>();
        assert!(imports.contains(&"user_code".to_string()));
        for name in ["project_code", "configured_code", "ancestor_code"] {
            assert!(!imports.contains(&name.to_string()));
        }
    }

    #[test]
    fn project_auto_skills_win_name_collisions_over_user_auto() {
        let tmp = tempfile::tempdir().unwrap();
        let agent_dir = tmp.path().join("agent");
        let cwd = tmp.path().join("proj");
        fs::create_dir_all(agent_dir.join("skills").join("alpha")).unwrap();
        fs::create_dir_all(
            cwd.join(".prime")
                .join("agent")
                .join("skills")
                .join("alpha"),
        )
        .unwrap();
        fs::create_dir_all(&cwd).unwrap();
        fs::write(
            agent_dir.join("skills").join("alpha").join("SKILL.md"),
            "---\nname: alpha\ndescription: User alpha\n---\nBody",
        )
        .unwrap();
        fs::write(
            cwd.join(".prime")
                .join("agent")
                .join("skills")
                .join("alpha")
                .join("SKILL.md"),
            "---\nname: alpha\ndescription: Project alpha\n---\nBody",
        )
        .unwrap();

        let resources = load_resources(ResourceLoaderOptions::new(&cwd, &agent_dir)).unwrap();
        let alpha: Vec<_> = resources
            .skills
            .iter()
            .filter(|skill| skill.name == "alpha")
            .collect();
        assert_eq!(alpha.len(), 1, "same name resolves to one skill");
        assert_eq!(alpha[0].description, "Project alpha");
        assert_eq!(
            alpha[0].source_info.scope,
            crate::skills::SourceScope::Project
        );
        assert!(resources
            .skill_diagnostics
            .iter()
            .any(|d| matches!(d, ResourceDiagnostic::Collision { .. })));
    }

    /// A skill directory: `SKILL.md` with `frontmatter`, plus a Python
    /// package (pyproject named `project`) when given.
    fn write_skill_dir(dir: &Path, frontmatter: &str, project: Option<&str>) -> PathBuf {
        fs::create_dir_all(dir).unwrap();
        let skill_file = dir.join("SKILL.md");
        fs::write(&skill_file, format!("---\n{frontmatter}\n---\nBody")).unwrap();
        if let Some(project) = project {
            let import = dir.file_name().unwrap().to_string_lossy().replace('-', "_");
            fs::create_dir_all(dir.join("src").join(&import)).unwrap();
            fs::write(dir.join("src").join(&import).join("__init__.py"), "").unwrap();
            fs::write(
                dir.join("pyproject.toml"),
                format!("[project]\nname = \"{project}\"\nversion = \"0.1.0\"\n"),
            )
            .unwrap();
        }
        skill_file
    }

    fn named(name: &str) -> String {
        format!("name: {name}\ndescription: The {name} skill")
    }

    fn status(name: &str, path: &Path, state: SkillState) -> SkillStatus {
        SkillStatus {
            name: name.to_string(),
            path: path.display().to_string(),
            state,
        }
    }

    /// Every state a discovered skill can be in, from one resolution: the
    /// bundled skill wins its name over a project copy (which keeps the
    /// bundled Python code importable), a project skill shadows a user one,
    /// and settings, frontmatter, and project scope each explain the rest.
    #[test]
    fn skill_statuses_explain_every_discovered_skill() {
        let tmp = tempfile::tempdir().unwrap();
        let agent_dir = tmp.path().join("agent");
        let bundled = tmp.path().join("bundled");
        let cwd = tmp.path().join("proj");
        let project_skills = cwd.join(".prime/agent/skills");
        let user_skills = agent_dir.join("skills");
        let bundled_goal = write_skill_dir(&bundled.join("goal"), &named("goal"), Some("goal"));
        let project_goal = write_skill_dir(&project_skills.join("goal"), &named("goal"), None);
        let project_code = write_skill_dir(
            &project_skills.join("proj-code"),
            &named("proj-code"),
            Some("x"),
        );
        let project_twin = write_skill_dir(&project_skills.join("twin"), &named("twin"), None);
        let user_twin = write_skill_dir(&user_skills.join("twin"), &named("twin"), None);
        let hidden = write_skill_dir(
            &user_skills.join("hidden"),
            &format!("{}\ndisable-model-invocation: true", named("hidden")),
            None,
        );
        let broken_yaml = "name: broken\ndescription: Runs: things";
        let broken = write_skill_dir(&user_skills.join("broken"), broken_yaml, None);
        let off = write_skill_dir(&user_skills.join("off"), &named("off"), None);
        fs::write(
            agent_dir.join("settings.json"),
            serde_json::json!({"skills": ["-skills/off"]}).to_string(),
        )
        .unwrap();

        let resources = load_resources(ResourceLoaderOptions {
            bundled_skills_dir: BundledSkillsDir::Directory(bundled),
            ..ResourceLoaderOptions::new(&cwd, &agent_dir)
        })
        .unwrap();

        let yaml_error = serde_yaml::from_str::<serde_yaml::Value>(broken_yaml).unwrap_err();
        let settings_path = agent_dir.join("settings.json").display().to_string();
        assert_eq!(
            resources.skill_statuses,
            vec![
                status(
                    "broken",
                    &broken,
                    SkillState::Invalid {
                        message: format!("invalid YAML frontmatter: {yaml_error}"),
                    },
                ),
                status("goal", &bundled_goal, SkillState::Active),
                status(
                    "goal",
                    &project_goal,
                    SkillState::IgnoredForBundled {
                        winner_path: bundled_goal.display().to_string(),
                        settings_path: settings_path.clone(),
                    },
                ),
                status("hidden", &hidden, SkillState::Hidden),
                status(
                    "off",
                    &off,
                    SkillState::Disabled {
                        by: DisabledBy::Settings,
                    },
                ),
                status("proj-code", &project_code, SkillState::ProjectCodeNotLoaded),
                status(
                    "twin",
                    &user_twin,
                    SkillState::Shadowed {
                        winner_path: project_twin.display().to_string(),
                    },
                ),
                status("twin", &project_twin, SkillState::Active),
            ]
        );
        let goal = resources
            .skills
            .iter()
            .find(|skill| skill.name == "goal")
            .unwrap();
        assert_eq!(
            goal.kind,
            SkillKind::Python,
            "the bundled code stays importable"
        );
        let collision_message = resources
            .skill_diagnostics
            .iter()
            .find_map(|diagnostic| match diagnostic {
                ResourceDiagnostic::Collision {
                    message, collision, ..
                } if collision.name == "goal" => Some(message.clone()),
                _ => None,
            })
            .unwrap();
        assert!(
            collision_message.contains(r#""skills": ["-goal"]"#)
                && collision_message.contains(&settings_path),
            "the losing skill's diagnostic names the settings line: {collision_message}"
        );
    }

    /// `"skills": ["-<name>"]` in the global settings disables exactly the
    /// bundled skill, so the user's same-named Python skill loads instead.
    #[test]
    fn the_global_settings_line_lets_a_user_skill_replace_a_bundled_one() {
        let tmp = tempfile::tempdir().unwrap();
        let agent_dir = tmp.path().join("agent");
        let bundled = tmp.path().join("bundled");
        let cwd = tmp.path().join("proj");
        fs::create_dir_all(&cwd).unwrap();
        let bundled_goal = write_skill_dir(&bundled.join("goal"), &named("goal"), Some("goal"));
        let user_goal = write_skill_dir(
            &agent_dir.join("skills/goal"),
            &named("goal"),
            Some("user-goal"),
        );
        let goal_file = || {
            load_resources(ResourceLoaderOptions {
                bundled_skills_dir: BundledSkillsDir::Directory(bundled.clone()),
                ..ResourceLoaderOptions::new(&cwd, &agent_dir)
            })
            .unwrap()
            .skills
            .into_iter()
            .find(|skill| skill.name == "goal")
            .map(|skill| (skill.file_path, skill.kind))
        };
        assert_eq!(goal_file(), Some((bundled_goal, SkillKind::Python)));
        fs::write(
            agent_dir.join("settings.json"),
            serde_json::json!({"skills": ["-goal"]}).to_string(),
        )
        .unwrap();
        assert_eq!(goal_file(), Some((user_goal, SkillKind::Python)));
    }
}

//! Ported TS resolve test cases (package-manager.test.ts): settings entries,
//! auto-discovery (settings-base dirs, `.agents/skills` ancestors, ignore
//! files, symlinks), extension sources, pattern filtering (top-level
//! arrays, pi manifest, package filters, `+`/`-` force forms), package
//! dedupe, multi-file extension discovery, and the offline/missing-source
//! policies.

use std::path::{Path, PathBuf};

use super::{MetadataSource, ResolvedResource, ResourceOrigin};
use crate::packages::manager::BundledSkillsDir;
use crate::packages::source::SourceScope;
use crate::packages::{PackageManager, PackageManagerOptions, ResolveExtensionOptions};
use crate::settings::SettingsManager;

/// Environment mutations (HOME, `PI_OFFLINE`) are process-wide: tests that
/// touch them, and tests that read the env-sensitive update flows,
/// serialize through the shared packages lock.
use crate::packages::test_support::ENV_MUTEX;

struct Fixture {
    root: tempfile::TempDir,
    temp_dir: PathBuf,
    agent_dir: PathBuf,
    manager: PackageManager,
}

impl Fixture {
    fn new() -> Self {
        let root = tempfile::tempdir().unwrap();
        let temp_dir = root.path().to_path_buf();
        let agent_dir = temp_dir.join("agent");
        std::fs::create_dir_all(&agent_dir).unwrap();
        Self::with_cwd(root, temp_dir.join("work"), agent_dir)
    }

    fn with_cwd(root: tempfile::TempDir, cwd: PathBuf, agent_dir: PathBuf) -> Self {
        std::fs::create_dir_all(&cwd).unwrap();
        let temp_dir = root.path().to_path_buf();
        let settings = SettingsManager::create(&cwd, &agent_dir);
        let manager = PackageManager::with_options(PackageManagerOptions {
            cwd,
            agent_dir: agent_dir.clone(),
            settings,
            bundled_skills_dir: BundledSkillsDir::Disabled,
            extra_builtin_skill_overrides: Vec::new(),
        });
        Self {
            root,
            temp_dir,
            agent_dir,
            manager,
        }
    }

    fn set_user_packages(&mut self, packages: serde_json::Value) {
        std::fs::create_dir_all(&self.agent_dir).unwrap();
        let path = self.agent_dir.join("settings.json");
        let mut settings = std::fs::read_to_string(&path).map_or_else(
            |_| serde_json::json!({}),
            |content| serde_json::from_str::<serde_json::Value>(&content).unwrap(),
        );
        settings["packages"] = packages;
        std::fs::write(&path, settings.to_string()).unwrap();
        self.reload();
    }

    fn set_user_array(&mut self, field: &str, entries: serde_json::Value) {
        std::fs::create_dir_all(&self.agent_dir).unwrap();
        let path = self.agent_dir.join("settings.json");
        let mut settings = std::fs::read_to_string(&path).map_or_else(
            |_| serde_json::json!({}),
            |content| serde_json::from_str::<serde_json::Value>(&content).unwrap(),
        );
        settings[field] = entries;
        std::fs::write(&path, settings.to_string()).unwrap();
        self.reload();
    }

    fn set_project_array(&mut self, field: &str, entries: serde_json::Value) {
        let dir = self.manager.cwd().join(crate::settings::CONFIG_DIR_NAME);
        std::fs::create_dir_all(&dir).unwrap();
        let path = dir.join("settings.json");
        let mut settings = std::fs::read_to_string(&path).map_or_else(
            |_| serde_json::json!({}),
            |content| serde_json::from_str::<serde_json::Value>(&content).unwrap(),
        );
        settings[field] = entries;
        std::fs::write(&path, settings.to_string()).unwrap();
        self.reload();
    }

    fn reload(&mut self) {
        self.manager.reload_settings().unwrap();
    }
}

fn write(path: &Path, content: &str) {
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent).unwrap();
    }
    std::fs::write(path, content).unwrap();
}

fn skill_md(dir: &Path, name: &str, description: &str) -> PathBuf {
    let path = dir.join(name).join("SKILL.md");
    write(
        &path,
        &format!("---\nname: {name}\ndescription: {description}\n---\nContent"),
    );
    path
}

fn is_enabled(resources: &[ResolvedResource], suffix: &str) -> bool {
    resources
        .iter()
        .any(|r| r.path.to_string_lossy().ends_with(suffix) && r.enabled)
}

fn is_disabled(resources: &[ResolvedResource], suffix: &str) -> bool {
    resources
        .iter()
        .any(|r| r.path.to_string_lossy().ends_with(suffix) && !r.enabled)
}

fn has_path(resources: &[ResolvedResource], suffix: &str) -> bool {
    resources
        .iter()
        .any(|r| r.path.to_string_lossy().ends_with(suffix))
}

// -- resolve: settings entries and auto-discovery --------------------------------

#[test]
fn resolve_without_configured_sources_returns_only_auto_resources() {
    let mut fixture = Fixture::new();
    let result = fixture.manager.resolve().unwrap();
    assert!(result.extensions.is_empty());
    assert!(result.prompts.is_empty());
    assert!(result.themes.is_empty());
    assert!(result.skills.iter().all(|r| {
        r.metadata.source == MetadataSource::Auto && r.metadata.origin == ResourceOrigin::TopLevel
    }));
}

#[test]
fn resolve_local_extension_paths_from_settings() {
    let mut fixture = Fixture::new();
    let ext_path = fixture.agent_dir.join("extensions").join("my-extension.ts");
    write(&ext_path, "export default function() {}");
    fixture.set_user_array(
        "extensions",
        serde_json::json!(["extensions/my-extension.ts"]),
    );

    let result = fixture.manager.resolve().unwrap();
    assert!(result
        .extensions
        .iter()
        .any(|r| r.path == ext_path && r.enabled));
}

#[test]
fn resolve_skill_paths_from_settings() {
    let mut fixture = Fixture::new();
    let skill_file = skill_md(
        &fixture.agent_dir.join("skills"),
        "my-skill",
        "A test skill",
    );
    fixture.set_user_array("skills", serde_json::json!(["skills"]));

    let result = fixture.manager.resolve().unwrap();
    assert!(result
        .skills
        .iter()
        .any(|r| r.path == skill_file && r.enabled));
}

#[test]
fn auto_discovers_root_markdown_skills() {
    let mut fixture = Fixture::new();
    let skill_file = fixture.agent_dir.join("skills").join("single-file.md");
    write(
        &skill_file,
        "---\nname: single-file\ndescription: A root markdown skill\n---\nContent",
    );

    let result = fixture.manager.resolve().unwrap();
    assert!(result
        .skills
        .iter()
        .any(|r| r.path == skill_file && r.enabled));
}

#[test]
fn resolves_project_paths_relative_to_project_config_dir() {
    let mut fixture = Fixture::new();
    let project_dir = fixture.manager.cwd().join(crate::settings::CONFIG_DIR_NAME);
    let ext_path = project_dir.join("extensions").join("project-ext.ts");
    write(&ext_path, "export default function() {}");
    fixture.set_project_array(
        "extensions",
        serde_json::json!(["extensions/project-ext.ts"]),
    );

    let result = fixture.manager.resolve().unwrap();
    assert!(result
        .extensions
        .iter()
        .any(|r| r.path == ext_path && r.enabled));
}

#[test]
fn auto_discovers_user_prompts_with_overrides() {
    let mut fixture = Fixture::new();
    let prompt_path = fixture.agent_dir.join("prompts").join("auto.md");
    write(&prompt_path, "Auto prompt");
    fixture.set_user_array("prompts", serde_json::json!(["!prompts/auto.md"]));

    let result = fixture.manager.resolve().unwrap();
    assert!(result
        .prompts
        .iter()
        .any(|r| r.path == prompt_path && !r.enabled));
}

#[test]
fn auto_discovers_project_prompts_with_overrides() {
    let mut fixture = Fixture::new();
    let project_dir = fixture.manager.cwd().join(crate::settings::CONFIG_DIR_NAME);
    let prompt_path = project_dir.join("prompts").join("is.md");
    write(&prompt_path, "Is prompt");
    fixture.set_project_array("prompts", serde_json::json!(["!prompts/is.md"]));

    let result = fixture.manager.resolve().unwrap();
    assert!(result
        .prompts
        .iter()
        .any(|r| r.path == prompt_path && !r.enabled));
}

/// Unix symlink layout; Windows needs `symlink_dir` and a privileged
/// developer mode to create links, so the case runs on Unix only.
#[cfg(unix)]
#[test]
fn resolves_symlinked_user_and_project_resources_once() {
    use std::os::unix::fs::symlink;
    let _guard = ENV_MUTEX.lock().unwrap();
    let previous_home = std::env::var("HOME").ok();
    let mut fixture = Fixture::new();
    std::env::set_var("HOME", &fixture.temp_dir);

    let shared = fixture.temp_dir.join("shared-resources");
    let shared_skills = shared.join("skills");
    skill_md(&shared_skills, "shared-skill", "Shared skill");
    write(&shared.join("prompts").join("shared.md"), "Shared prompt");
    write(&shared.join("themes").join("shared.json"), "{}");
    write(
        &shared.join("extensions").join("shared.ts"),
        "export default function() {}",
    );
    let project_dir = fixture.manager.cwd().join(crate::settings::CONFIG_DIR_NAME);
    std::fs::create_dir_all(&project_dir).unwrap();
    symlink(
        shared.join("extensions"),
        fixture.agent_dir.join("extensions"),
    )
    .unwrap();
    symlink(&shared_skills, fixture.agent_dir.join("skills")).unwrap();
    symlink(shared.join("prompts"), fixture.agent_dir.join("prompts")).unwrap();
    symlink(shared.join("themes"), fixture.agent_dir.join("themes")).unwrap();
    symlink(shared.join("extensions"), project_dir.join("extensions")).unwrap();
    symlink(shared_skills, project_dir.join("skills")).unwrap();
    symlink(shared.join("prompts"), project_dir.join("prompts")).unwrap();
    symlink(shared.join("themes"), project_dir.join("themes")).unwrap();

    let result = fixture.manager.resolve().unwrap();
    assert_eq!(result.extensions.len(), 1);
    assert_eq!(result.skills.len(), 1);
    assert_eq!(result.prompts.len(), 1);
    assert_eq!(result.themes.len(), 1);
    assert_eq!(result.extensions[0].metadata.scope, SourceScope::Project);
    assert_eq!(result.skills[0].metadata.scope, SourceScope::Project);
    assert_eq!(result.prompts[0].metadata.scope, SourceScope::Project);
    assert_eq!(result.themes[0].metadata.scope, SourceScope::Project);

    match previous_home {
        Some(home) => std::env::set_var("HOME", home),
        None => std::env::remove_var("HOME"),
    }
}

#[test]
fn resolves_directory_with_pi_extensions_manifest() {
    let mut fixture = Fixture::new();
    let pkg_dir = fixture.temp_dir.join("my-extensions-pkg");
    write(
        &pkg_dir.join("package.json"),
        r#"{"name":"my-extensions-pkg","pi":{"extensions":["./extensions/clip.ts","./extensions/cost.ts"]}}"#,
    );
    write(
        &pkg_dir.join("extensions").join("clip.ts"),
        "export default function() {}",
    );
    write(
        &pkg_dir.join("extensions").join("cost.ts"),
        "export default function() {}",
    );
    write(
        &pkg_dir.join("extensions").join("helper.ts"),
        "export const x = 1;",
    );

    fixture.set_user_array(
        "extensions",
        serde_json::json!([pkg_dir.display().to_string()]),
    );

    let result = fixture.manager.resolve().unwrap();
    assert!(is_enabled(&result.extensions, "clip.ts"));
    assert!(is_enabled(&result.extensions, "cost.ts"));
    assert!(!has_path(&result.extensions, "helper.ts"));
}

// -- .agents/skills ancestor scan -----------------------------------------------

#[test]
fn agents_skills_scan_stops_at_git_repo_root() {
    let fixture = Fixture::new();
    let repo_root = fixture.temp_dir.join("repo");
    let nested_cwd = repo_root.join("packages").join("feature");
    std::fs::create_dir_all(&nested_cwd).unwrap();
    std::fs::create_dir_all(repo_root.join(".git")).unwrap();

    let above_repo = skill_md(
        &fixture.temp_dir.join(".agents").join("skills"),
        "above-repo",
        "above",
    );
    let repo_root_skill = skill_md(
        &repo_root.join(".agents").join("skills"),
        "repo-root",
        "repo",
    );
    let nested = skill_md(
        &repo_root.join("packages").join(".agents").join("skills"),
        "nested",
        "nested",
    );

    let mut nested_manager = Fixture::with_cwd(fixture.root, nested_cwd, fixture.agent_dir);
    let result = nested_manager.manager.resolve().unwrap();
    assert!(result
        .skills
        .iter()
        .any(|r| r.path == repo_root_skill && r.enabled));
    assert!(result.skills.iter().any(|r| r.path == nested && r.enabled));
    assert!(!result.skills.iter().any(|r| r.path == above_repo));
}

#[test]
fn agents_skills_scan_goes_to_fs_root_without_a_repo() {
    let fixture = Fixture::new();
    let non_repo_root = fixture.temp_dir.join("non-repo");
    let nested_cwd = non_repo_root.join("a").join("b");
    std::fs::create_dir_all(&nested_cwd).unwrap();

    let root_skill = skill_md(
        &non_repo_root.join(".agents").join("skills"),
        "root",
        "root",
    );
    let middle_skill = skill_md(
        &non_repo_root.join("a").join(".agents").join("skills"),
        "middle",
        "middle",
    );

    let mut nested_manager = Fixture::with_cwd(fixture.root, nested_cwd, fixture.agent_dir);
    let result = nested_manager.manager.resolve().unwrap();
    assert!(result
        .skills
        .iter()
        .any(|r| r.path == root_skill && r.enabled));
    assert!(result
        .skills
        .iter()
        .any(|r| r.path == middle_skill && r.enabled));
}

#[test]
fn agents_skills_ignores_root_markdown_files() {
    let mut fixture = Fixture::new();
    let agents_skills = fixture.temp_dir.join(".agents").join("skills");
    let root_file = agents_skills.join("root-file.md");
    write(
        &root_file,
        "---\nname: root-file\ndescription: Root markdown file\n---\n",
    );
    let nested = skill_md(&agents_skills, "nested-skill", "Nested skill");

    let result = fixture.manager.resolve().unwrap();
    assert!(!result.skills.iter().any(|r| r.path == root_file));
    assert!(result.skills.iter().any(|r| r.path == nested && r.enabled));
}

#[test]
fn home_agents_skills_stays_user_scoped_when_cwd_is_under_home() {
    let _guard = ENV_MUTEX.lock().unwrap();
    let previous_home = std::env::var("HOME").ok();
    let fixture = Fixture::new();
    std::env::set_var("HOME", &fixture.temp_dir);

    let home_skill = skill_md(
        &fixture.temp_dir.join(".agents").join("skills"),
        "home-skill",
        "home",
    );
    let mut manager = PackageManager::new(
        fixture.temp_dir.join("scratch").join("nested"),
        fixture.temp_dir.join(".prime").join("agent"),
        SettingsManager::create(
            fixture.temp_dir.join("scratch").join("nested"),
            fixture.temp_dir.join(".prime").join("agent"),
        ),
    );
    let result = manager.resolve().unwrap();
    let matching: Vec<_> = result
        .skills
        .iter()
        .filter(|r| r.path == home_skill)
        .collect();
    assert_eq!(matching.len(), 1);
    assert!(matching[0].enabled);
    assert_eq!(matching[0].metadata.scope, SourceScope::User);
    assert_eq!(matching[0].metadata.source, MetadataSource::Auto);

    match previous_home {
        Some(home) => std::env::set_var("HOME", home),
        None => std::env::remove_var("HOME"),
    }
}

/// Unix symlink layout (see `resolves_symlinked_user_and_project_resources_once`).
#[cfg(unix)]
#[test]
fn user_skill_entries_dedupe_when_agent_skills_symlinks_agents_skills() {
    use std::os::unix::fs::symlink;
    let _guard = ENV_MUTEX.lock().unwrap();
    let previous_home = std::env::var("HOME").ok();
    let mut fixture = Fixture::new();
    std::env::set_var("HOME", &fixture.temp_dir);

    let agents_skills = fixture.temp_dir.join(".agents").join("skills");
    std::fs::create_dir_all(&agents_skills).unwrap();
    symlink(&agents_skills, fixture.agent_dir.join("skills")).unwrap();
    skill_md(&agents_skills, "foo", "foo");

    let result = fixture.manager.resolve().unwrap();
    let foo: Vec<_> = result
        .skills
        .iter()
        .filter(|r| r.path.to_string_lossy().ends_with("foo/SKILL.md"))
        .collect();
    assert_eq!(foo.len(), 1);

    match previous_home {
        Some(home) => std::env::set_var("HOME", home),
        None => std::env::remove_var("HOME"),
    }
}

// -- ignore files ---------------------------------------------------------------

#[test]
fn skill_directories_respect_gitignore() {
    let mut fixture = Fixture::new();
    let skills_dir = fixture.agent_dir.join("skills");
    std::fs::create_dir_all(&skills_dir).unwrap();
    write(&skills_dir.join(".gitignore"), "venv\n__pycache__\n");
    let good = skill_md(&skills_dir, "good-skill", "Good");
    let bad = skill_md(&skills_dir.join("venv"), "bad-skill", "Bad");

    fixture.set_user_array("skills", serde_json::json!(["skills"]));

    let result = fixture.manager.resolve().unwrap();
    assert!(result.skills.iter().any(|r| r.path == good && r.enabled));
    assert!(!result.skills.iter().any(|r| r.path == bad && r.enabled));
}

#[test]
fn parent_gitignore_does_not_apply_to_auto_discovery() {
    let mut fixture = Fixture::new();
    write(&fixture.temp_dir.join(".gitignore"), ".prime/agent\n");

    let project_dir = fixture.manager.cwd().join(crate::settings::CONFIG_DIR_NAME);
    let skill_path = skill_md(&project_dir.join("skills"), "auto-skill", "Auto");

    let result = fixture.manager.resolve().unwrap();
    assert!(result
        .skills
        .iter()
        .any(|r| r.path == skill_path && r.enabled));
}

// -- resolveExtensionSources ----------------------------------------------------

#[test]
fn extension_sources_resolve_local_paths() {
    let mut fixture = Fixture::new();
    let ext_path = fixture.temp_dir.join("ext.ts");
    write(&ext_path, "export default function() {}");

    let result = fixture
        .manager
        .resolve_extension_sources(
            &[ext_path.display().to_string()],
            ResolveExtensionOptions::default(),
        )
        .unwrap();
    assert!(result
        .extensions
        .iter()
        .any(|r| r.path == ext_path && r.enabled));
}

#[test]
fn extension_sources_handle_directories_with_pi_manifest() {
    let mut fixture = Fixture::new();
    let pkg_dir = fixture.temp_dir.join("my-package");
    write(
        &pkg_dir.join("package.json"),
        r#"{"name":"my-package","pi":{"extensions":["./src/index.ts"],"skills":["./skills"]}}"#,
    );
    write(
        &pkg_dir.join("src").join("index.ts"),
        "export default function() {}",
    );
    let skill_path = skill_md(&pkg_dir.join("skills"), "my-skill", "Test");

    let result = fixture
        .manager
        .resolve_extension_sources(
            &[pkg_dir.display().to_string()],
            ResolveExtensionOptions::default(),
        )
        .unwrap();
    assert!(result
        .extensions
        .iter()
        .any(|r| r.path == pkg_dir.join("src").join("index.ts") && r.enabled));
    assert!(result
        .skills
        .iter()
        .any(|r| r.path == skill_path && r.enabled));
}

#[test]
fn extension_sources_handle_auto_discovery_layout() {
    let mut fixture = Fixture::new();
    let pkg_dir = fixture.temp_dir.join("auto-pkg");
    write(
        &pkg_dir.join("extensions").join("main.ts"),
        "export default function() {}",
    );
    write(&pkg_dir.join("themes").join("dark.json"), "{}");

    let result = fixture
        .manager
        .resolve_extension_sources(
            &[pkg_dir.display().to_string()],
            ResolveExtensionOptions::default(),
        )
        .unwrap();
    assert!(is_enabled(&result.extensions, "main.ts"));
    assert!(is_enabled(&result.themes, "dark.json"));
}

#[test]
fn extension_sources_stop_recursion_at_skill_md() {
    let mut fixture = Fixture::new();
    let pkg_dir = fixture.temp_dir.join("skill-root-pkg");
    let root_skill = pkg_dir.join("skills").join("root-skill").join("SKILL.md");
    write(
        &root_skill,
        "---\nname: root-skill\ndescription: Root\n---\n",
    );
    let nested = skill_md(
        &pkg_dir
            .join("skills")
            .join("root-skill")
            .join("nested-skill"),
        "nested-skill",
        "Nested",
    );

    let result = fixture
        .manager
        .resolve_extension_sources(
            &[pkg_dir.display().to_string()],
            ResolveExtensionOptions::default(),
        )
        .unwrap();
    assert!(result
        .skills
        .iter()
        .any(|r| r.path == root_skill && r.enabled));
    assert!(!result.skills.iter().any(|r| r.path == nested));
}

// -- pattern filtering: top-level arrays ----------------------------------------

#[test]
fn top_level_excludes_extensions_with_pattern() {
    let mut fixture = Fixture::new();
    let ext_dir = fixture.agent_dir.join("extensions");
    write(&ext_dir.join("keep.ts"), "export default function() {}");
    write(&ext_dir.join("remove.ts"), "export default function() {}");
    fixture.set_user_array(
        "extensions",
        serde_json::json!(["extensions", "!**/remove.ts"]),
    );

    let result = fixture.manager.resolve().unwrap();
    assert!(is_enabled(&result.extensions, "keep.ts"));
    assert!(is_disabled(&result.extensions, "remove.ts"));
}

#[test]
fn top_level_filters_themes_with_glob_patterns() {
    let mut fixture = Fixture::new();
    let themes_dir = fixture.agent_dir.join("themes");
    for name in ["dark.json", "light.json", "funky.json"] {
        write(&themes_dir.join(name), "{}");
    }
    fixture.set_user_array("themes", serde_json::json!(["themes", "!funky.json"]));

    let result = fixture.manager.resolve().unwrap();
    assert!(is_enabled(&result.themes, "dark.json"));
    assert!(is_enabled(&result.themes, "light.json"));
    assert!(is_disabled(&result.themes, "funky.json"));
}

#[test]
fn top_level_filters_prompts_with_exclusion_pattern() {
    let mut fixture = Fixture::new();
    let prompts_dir = fixture.agent_dir.join("prompts");
    write(&prompts_dir.join("review.md"), "Review code");
    write(&prompts_dir.join("explain.md"), "Explain code");
    fixture.set_user_array("prompts", serde_json::json!(["prompts", "!explain.md"]));

    let result = fixture.manager.resolve().unwrap();
    assert!(is_enabled(&result.prompts, "review.md"));
    assert!(is_disabled(&result.prompts, "explain.md"));
}

#[test]
fn top_level_filters_skills_with_exclusion_pattern() {
    let mut fixture = Fixture::new();
    let skills_dir = fixture.agent_dir.join("skills");
    skill_md(&skills_dir, "good-skill", "Good");
    skill_md(&skills_dir, "bad-skill", "Bad");
    fixture.set_user_array("skills", serde_json::json!(["skills", "!**/bad-skill"]));

    let result = fixture.manager.resolve().unwrap();
    assert!(result
        .skills
        .iter()
        .any(|r| r.path.to_string_lossy().contains("good-skill") && r.enabled));
    assert!(result
        .skills
        .iter()
        .any(|r| r.path.to_string_lossy().contains("bad-skill") && !r.enabled));
}

// -- pattern filtering: pi manifest ----------------------------------------------

#[test]
fn manifest_supports_glob_patterns_for_extensions() {
    let mut fixture = Fixture::new();
    let pkg_dir = fixture.temp_dir.join("manifest-pkg");
    write(
        &pkg_dir.join("package.json"),
        r#"{"name":"manifest-pkg","pi":{"extensions":["extensions","node_modules/dep/extensions","!**/skip.ts"]}}"#,
    );
    write(
        &pkg_dir.join("extensions").join("local.ts"),
        "export default function() {}",
    );
    write(
        &pkg_dir
            .join("node_modules")
            .join("dep")
            .join("extensions")
            .join("remote.ts"),
        "export default function() {}",
    );
    write(
        &pkg_dir
            .join("node_modules")
            .join("dep")
            .join("extensions")
            .join("skip.ts"),
        "export default function() {}",
    );

    let result = fixture
        .manager
        .resolve_extension_sources(
            &[pkg_dir.display().to_string()],
            ResolveExtensionOptions::default(),
        )
        .unwrap();
    assert!(is_enabled(&result.extensions, "local.ts"));
    assert!(is_enabled(&result.extensions, "remote.ts"));
    assert!(!has_path(&result.extensions, "skip.ts"));
}

#[test]
fn manifest_supports_glob_patterns_for_skills() {
    let mut fixture = Fixture::new();
    let pkg_dir = fixture.temp_dir.join("skill-manifest-pkg");
    write(
        &pkg_dir.join("package.json"),
        r#"{"name":"skill-manifest-pkg","pi":{"skills":["skills","!**/bad-skill"]}}"#,
    );
    skill_md(&pkg_dir.join("skills"), "good-skill", "Good");
    skill_md(&pkg_dir.join("skills"), "bad-skill", "Bad");

    let result = fixture
        .manager
        .resolve_extension_sources(
            &[pkg_dir.display().to_string()],
            ResolveExtensionOptions::default(),
        )
        .unwrap();
    assert!(result
        .skills
        .iter()
        .any(|r| r.path.to_string_lossy().contains("good-skill") && r.enabled));
    assert!(!result
        .skills
        .iter()
        .any(|r| r.path.to_string_lossy().contains("bad-skill")));
}

#[test]
fn manifest_expands_positive_glob_entries_before_collecting_skills() {
    let mut fixture = Fixture::new();
    let pkg_dir = fixture.temp_dir.join("skill-manifest-glob-pkg");
    write(
        &pkg_dir.join("package.json"),
        r#"{"name":"skill-manifest-glob-pkg","pi":{"skills":["./plugins/*/skills"]}}"#,
    );
    skill_md(
        &pkg_dir
            .join("plugins")
            .join("pdf-to-markdown")
            .join("skills"),
        "pdf-to-markdown",
        "PDF to Markdown",
    );
    skill_md(
        &pkg_dir.join("plugins").join("nutrient-dws").join("skills"),
        "document-processor-api",
        "DWS",
    );

    let result = fixture
        .manager
        .resolve_extension_sources(
            &[pkg_dir.display().to_string()],
            ResolveExtensionOptions::default(),
        )
        .unwrap();
    assert!(result
        .skills
        .iter()
        .any(|r| r.path.to_string_lossy().contains("pdf-to-markdown") && r.enabled));
    assert!(result.skills.iter().any(|r| r
        .path
        .to_string_lossy()
        .contains("document-processor-api")
        && r.enabled));
}

// -- pattern filtering: package filters ------------------------------------------

#[test]
fn user_filters_layer_on_top_of_manifest_filters() {
    let mut fixture = Fixture::new();
    let pkg_dir = fixture.temp_dir.join("layered-pkg");
    write(
        &pkg_dir.join("package.json"),
        r#"{"name":"layered-pkg","pi":{"extensions":["extensions","!**/baz.ts"]}}"#,
    );
    for name in ["foo.ts", "bar.ts", "baz.ts"] {
        write(
            &pkg_dir.join("extensions").join(name),
            "export default function() {}",
        );
    }
    fixture.set_user_packages(serde_json::json!([{
        "source": pkg_dir.display().to_string(),
        "extensions": ["!**/bar.ts"],
        "skills": [],
        "prompts": [],
        "themes": [],
    }]));

    let result = fixture.manager.resolve().unwrap();
    assert!(is_enabled(&result.extensions, "foo.ts"));
    assert!(is_disabled(&result.extensions, "bar.ts"));
    assert!(!has_path(&result.extensions, "baz.ts"));
}

#[test]
fn package_filters_exclude_extensions_with_pattern() {
    let mut fixture = Fixture::new();
    let pkg_dir = fixture.temp_dir.join("pattern-pkg");
    for name in ["foo.ts", "bar.ts", "baz.ts"] {
        write(
            &pkg_dir.join("extensions").join(name),
            "export default function() {}",
        );
    }
    fixture.set_user_packages(serde_json::json!([{
        "source": pkg_dir.display().to_string(),
        "extensions": ["!**/baz.ts"],
        "skills": [],
        "prompts": [],
        "themes": [],
    }]));

    let result = fixture.manager.resolve().unwrap();
    assert!(is_enabled(&result.extensions, "foo.ts"));
    assert!(is_enabled(&result.extensions, "bar.ts"));
    assert!(is_disabled(&result.extensions, "baz.ts"));
}

#[test]
fn package_filters_filter_themes() {
    let mut fixture = Fixture::new();
    let pkg_dir = fixture.temp_dir.join("theme-pkg");
    write(&pkg_dir.join("themes").join("nice.json"), "{}");
    write(&pkg_dir.join("themes").join("ugly.json"), "{}");
    fixture.set_user_packages(serde_json::json!([{
        "source": pkg_dir.display().to_string(),
        "extensions": [],
        "skills": [],
        "prompts": [],
        "themes": ["!ugly.json"],
    }]));

    let result = fixture.manager.resolve().unwrap();
    assert!(is_enabled(&result.themes, "nice.json"));
    assert!(is_disabled(&result.themes, "ugly.json"));
}

#[test]
fn package_filters_combine_include_and_exclude_patterns() {
    let mut fixture = Fixture::new();
    let pkg_dir = fixture.temp_dir.join("combo-pkg");
    for name in ["alpha.ts", "beta.ts", "gamma.ts"] {
        write(
            &pkg_dir.join("extensions").join(name),
            "export default function() {}",
        );
    }
    fixture.set_user_packages(serde_json::json!([{
        "source": pkg_dir.display().to_string(),
        "extensions": ["**/alpha.ts", "**/beta.ts", "!**/beta.ts"],
        "skills": [],
        "prompts": [],
        "themes": [],
    }]));

    let result = fixture.manager.resolve().unwrap();
    assert!(is_enabled(&result.extensions, "alpha.ts"));
    assert!(is_disabled(&result.extensions, "beta.ts"));
    assert!(is_disabled(&result.extensions, "gamma.ts"));
}

#[test]
fn package_filters_work_with_direct_paths() {
    let mut fixture = Fixture::new();
    let pkg_dir = fixture.temp_dir.join("direct-pkg");
    write(
        &pkg_dir.join("extensions").join("one.ts"),
        "export default function() {}",
    );
    write(
        &pkg_dir.join("extensions").join("two.ts"),
        "export default function() {}",
    );
    fixture.set_user_packages(serde_json::json!([{
        "source": pkg_dir.display().to_string(),
        "extensions": ["extensions/one.ts"],
        "skills": [],
        "prompts": [],
        "themes": [],
    }]));

    let result = fixture.manager.resolve().unwrap();
    assert!(is_enabled(&result.extensions, "one.ts"));
    assert!(is_disabled(&result.extensions, "two.ts"));
}

// -- force-include / force-exclude ---------------------------------------------

#[test]
fn force_include_extensions_after_exclusion() {
    let mut fixture = Fixture::new();
    let ext_dir = fixture.agent_dir.join("extensions");
    for name in ["keep.ts", "excluded.ts", "force-back.ts"] {
        write(&ext_dir.join(name), "export default function() {}");
    }
    fixture.set_user_array(
        "extensions",
        serde_json::json!([
            "extensions",
            "!extensions/*.ts",
            "+extensions/force-back.ts"
        ]),
    );

    let result = fixture.manager.resolve().unwrap();
    assert!(is_disabled(&result.extensions, "keep.ts"));
    assert!(is_disabled(&result.extensions, "excluded.ts"));
    assert!(is_enabled(&result.extensions, "force-back.ts"));
}

#[test]
fn force_include_overrides_exclude_in_package_filters() {
    let mut fixture = Fixture::new();
    let pkg_dir = fixture.temp_dir.join("force-pkg");
    for name in ["alpha.ts", "beta.ts", "gamma.ts"] {
        write(
            &pkg_dir.join("extensions").join(name),
            "export default function() {}",
        );
    }
    fixture.set_user_packages(serde_json::json!([{
        "source": pkg_dir.display().to_string(),
        "extensions": ["!**/*.ts", "+extensions/beta.ts"],
        "skills": [],
        "prompts": [],
        "themes": [],
    }]));

    let result = fixture.manager.resolve().unwrap();
    assert!(is_disabled(&result.extensions, "alpha.ts"));
    assert!(is_enabled(&result.extensions, "beta.ts"));
    assert!(is_disabled(&result.extensions, "gamma.ts"));
}

#[test]
fn force_include_multiple_resources() {
    let mut fixture = Fixture::new();
    let pkg_dir = fixture.temp_dir.join("multi-force-pkg");
    for name in ["skill-a", "skill-b", "skill-c"] {
        skill_md(&pkg_dir.join("skills"), name, "A skill");
    }
    fixture.set_user_packages(serde_json::json!([{
        "source": pkg_dir.display().to_string(),
        "extensions": [],
        "skills": ["!**/*", "+skills/skill-a", "+skills/skill-c"],
        "prompts": [],
        "themes": [],
    }]));

    let result = fixture.manager.resolve().unwrap();
    assert!(result
        .skills
        .iter()
        .any(|r| r.path.to_string_lossy().contains("skill-a") && r.enabled));
    assert!(result
        .skills
        .iter()
        .any(|r| r.path.to_string_lossy().contains("skill-b") && !r.enabled));
    assert!(result
        .skills
        .iter()
        .any(|r| r.path.to_string_lossy().contains("skill-c") && r.enabled));
}

#[test]
fn force_include_after_specific_exclusion() {
    let mut fixture = Fixture::new();
    let ext_dir = fixture.agent_dir.join("extensions");
    write(&ext_dir.join("a.ts"), "export default function() {}");
    write(&ext_dir.join("b.ts"), "export default function() {}");
    fixture.set_user_array(
        "extensions",
        serde_json::json!(["extensions", "!extensions/b.ts", "+extensions/b.ts"]),
    );

    let result = fixture.manager.resolve().unwrap();
    assert!(is_enabled(&result.extensions, "a.ts"));
    assert!(is_enabled(&result.extensions, "b.ts"));
}

#[test]
fn force_include_in_manifest_patterns() {
    let mut fixture = Fixture::new();
    let pkg_dir = fixture.temp_dir.join("manifest-force-pkg");
    write(
        &pkg_dir.join("package.json"),
        r#"{"name":"manifest-force-pkg","pi":{"extensions":["extensions","!**/two.ts","+extensions/two.ts"]}}"#,
    );
    for name in ["one.ts", "two.ts", "three.ts"] {
        write(
            &pkg_dir.join("extensions").join(name),
            "export default function() {}",
        );
    }

    let result = fixture
        .manager
        .resolve_extension_sources(
            &[pkg_dir.display().to_string()],
            ResolveExtensionOptions::default(),
        )
        .unwrap();
    assert!(is_enabled(&result.extensions, "one.ts"));
    assert!(is_enabled(&result.extensions, "two.ts"));
    assert!(is_enabled(&result.extensions, "three.ts"));
}

#[test]
fn force_include_themes() {
    let mut fixture = Fixture::new();
    let themes_dir = fixture.agent_dir.join("themes");
    for name in ["dark.json", "light.json", "special.json"] {
        write(&themes_dir.join(name), "{}");
    }
    fixture.set_user_array(
        "themes",
        serde_json::json!(["themes", "!themes/*.json", "+themes/special.json"]),
    );

    let result = fixture.manager.resolve().unwrap();
    assert!(is_disabled(&result.themes, "dark.json"));
    assert!(is_disabled(&result.themes, "light.json"));
    assert!(is_enabled(&result.themes, "special.json"));
}

#[test]
fn force_include_prompts() {
    let mut fixture = Fixture::new();
    let prompts_dir = fixture.agent_dir.join("prompts");
    for name in ["review.md", "explain.md", "debug.md"] {
        write(&prompts_dir.join(name), "Prompt");
    }
    fixture.set_user_array(
        "prompts",
        serde_json::json!(["prompts", "!prompts/*.md", "+prompts/debug.md"]),
    );

    let result = fixture.manager.resolve().unwrap();
    assert!(is_disabled(&result.prompts, "review.md"));
    assert!(is_disabled(&result.prompts, "explain.md"));
    assert!(is_enabled(&result.prompts, "debug.md"));
}

#[test]
fn force_exclude_top_level_resources() {
    let mut fixture = Fixture::new();
    let ext_dir = fixture.agent_dir.join("extensions");
    write(&ext_dir.join("alpha.ts"), "export default function() {}");
    write(&ext_dir.join("beta.ts"), "export default function() {}");
    fixture.set_user_array(
        "extensions",
        serde_json::json!(["extensions", "+extensions/alpha.ts", "-extensions/alpha.ts"]),
    );

    let result = fixture.manager.resolve().unwrap();
    assert!(is_disabled(&result.extensions, "alpha.ts"));
    assert!(is_enabled(&result.extensions, "beta.ts"));
}

#[test]
fn force_exclude_in_package_filters() {
    let mut fixture = Fixture::new();
    let pkg_dir = fixture.temp_dir.join("force-exclude-pkg");
    write(
        &pkg_dir.join("extensions").join("alpha.ts"),
        "export default function() {}",
    );
    write(
        &pkg_dir.join("extensions").join("beta.ts"),
        "export default function() {}",
    );
    fixture.set_user_packages(serde_json::json!([{
        "source": pkg_dir.display().to_string(),
        "extensions": ["extensions/*.ts", "+extensions/alpha.ts", "-extensions/alpha.ts"],
        "skills": [],
        "prompts": [],
        "themes": [],
    }]));

    let result = fixture.manager.resolve().unwrap();
    assert!(is_disabled(&result.extensions, "alpha.ts"));
    assert!(is_enabled(&result.extensions, "beta.ts"));
}

// -- package deduplication -------------------------------------------------------

#[test]
fn same_local_package_in_both_scopes_resolves_once_with_project_scope() {
    let mut fixture = Fixture::new();
    let pkg_dir = fixture.temp_dir.join("shared-pkg");
    write(
        &pkg_dir.join("extensions").join("shared.ts"),
        "export default function() {}",
    );

    fixture.set_user_packages(serde_json::json!([pkg_dir.display().to_string()]));
    let project_dir = fixture.manager.cwd().join(crate::settings::CONFIG_DIR_NAME);
    std::fs::create_dir_all(&project_dir).unwrap();
    std::fs::write(
        project_dir.join("settings.json"),
        serde_json::json!({"packages": [pkg_dir.display().to_string()]}).to_string(),
    )
    .unwrap();
    fixture.reload();

    let result = fixture.manager.resolve().unwrap();
    let shared: Vec<_> = result
        .extensions
        .iter()
        .filter(|r| r.path.to_string_lossy().contains("shared-pkg"))
        .collect();
    assert_eq!(shared.len(), 1);
    assert_eq!(shared[0].metadata.scope, SourceScope::Project);
}

#[test]
fn different_packages_in_both_scopes_both_resolve() {
    let mut fixture = Fixture::new();
    let pkg1 = fixture.temp_dir.join("pkg1");
    let pkg2 = fixture.temp_dir.join("pkg2");
    write(
        &pkg1.join("extensions").join("from-pkg1.ts"),
        "export default function() {}",
    );
    write(
        &pkg2.join("extensions").join("from-pkg2.ts"),
        "export default function() {}",
    );

    fixture.set_user_packages(serde_json::json!([pkg1.display().to_string()]));
    let project_dir = fixture.manager.cwd().join(crate::settings::CONFIG_DIR_NAME);
    std::fs::create_dir_all(&project_dir).unwrap();
    std::fs::write(
        project_dir.join("settings.json"),
        serde_json::json!({"packages": [pkg2.display().to_string()]}).to_string(),
    )
    .unwrap();
    fixture.reload();

    let result = fixture.manager.resolve().unwrap();
    assert!(result
        .extensions
        .iter()
        .any(|r| r.path.to_string_lossy().contains("pkg1")));
    assert!(result
        .extensions
        .iter()
        .any(|r| r.path.to_string_lossy().contains("pkg2")));
}

// -- multi-file extension discovery ---------------------------------------------

#[test]
fn only_index_ts_loads_from_subdirectories() {
    let mut fixture = Fixture::new();
    let pkg_dir = fixture.temp_dir.join("multifile-pkg");
    write(
        &pkg_dir.join("extensions").join("subagent").join("index.ts"),
        "export default function(api) {}",
    );
    write(
        &pkg_dir
            .join("extensions")
            .join("subagent")
            .join("agents.ts"),
        "export function helper() {}",
    );
    write(
        &pkg_dir.join("extensions").join("standalone.ts"),
        "export default function(api) {}",
    );

    let result = fixture
        .manager
        .resolve_extension_sources(
            &[pkg_dir.display().to_string()],
            ResolveExtensionOptions::default(),
        )
        .unwrap();
    assert!(is_enabled(&result.extensions, "subagent/index.ts"));
    assert!(is_enabled(&result.extensions, "standalone.ts"));
    assert!(!has_path(&result.extensions, "agents.ts"));
}

#[test]
fn manifest_in_subdirectories_is_respected() {
    let mut fixture = Fixture::new();
    let pkg_dir = fixture.temp_dir.join("manifest-subdir-pkg");
    write(
        &pkg_dir
            .join("extensions")
            .join("custom")
            .join("package.json"),
        r#"{"pi":{"extensions":["./main.ts"]}}"#,
    );
    write(
        &pkg_dir.join("extensions").join("custom").join("main.ts"),
        "export default function(api) {}",
    );
    write(
        &pkg_dir.join("extensions").join("custom").join("utils.ts"),
        "export const util = 1;",
    );

    let result = fixture
        .manager
        .resolve_extension_sources(
            &[pkg_dir.display().to_string()],
            ResolveExtensionOptions::default(),
        )
        .unwrap();
    assert!(is_enabled(&result.extensions, "custom/main.ts"));
    assert!(!has_path(&result.extensions, "utils.ts"));
}

#[test]
fn mixed_top_level_files_and_subdirectories() {
    let mut fixture = Fixture::new();
    let pkg_dir = fixture.temp_dir.join("mixed-pkg");
    write(
        &pkg_dir.join("extensions").join("simple.ts"),
        "export default function(api) {}",
    );
    write(
        &pkg_dir.join("extensions").join("complex").join("index.ts"),
        "export default function(api) {}",
    );
    write(
        &pkg_dir.join("extensions").join("complex").join("a.ts"),
        "export const a = 1;",
    );
    write(
        &pkg_dir.join("extensions").join("complex").join("b.ts"),
        "export const b = 2;",
    );

    let result = fixture
        .manager
        .resolve_extension_sources(
            &[pkg_dir.display().to_string()],
            ResolveExtensionOptions::default(),
        )
        .unwrap();
    assert!(is_enabled(&result.extensions, "simple.ts"));
    assert!(is_enabled(&result.extensions, "complex/index.ts"));
    assert!(!has_path(&result.extensions, "complex/a.ts"));
    assert!(!has_path(&result.extensions, "complex/b.ts"));
    assert_eq!(result.extensions.iter().filter(|r| r.enabled).count(), 2);
}

#[test]
fn subdirectories_without_entry_point_are_skipped() {
    let mut fixture = Fixture::new();
    let pkg_dir = fixture.temp_dir.join("no-entry-pkg");
    write(
        &pkg_dir.join("extensions").join("broken").join("helper.ts"),
        "export const x = 1;",
    );
    write(
        &pkg_dir.join("extensions").join("broken").join("another.ts"),
        "export const y = 2;",
    );
    write(
        &pkg_dir.join("extensions").join("valid.ts"),
        "export default function(api) {}",
    );

    let result = fixture
        .manager
        .resolve_extension_sources(
            &[pkg_dir.display().to_string()],
            ResolveExtensionOptions::default(),
        )
        .unwrap();
    assert!(is_enabled(&result.extensions, "valid.ts"));
    assert_eq!(result.extensions.iter().filter(|r| r.enabled).count(), 1);
}

// -- offline / missing-source policies -------------------------------------------

#[test]
fn offline_mode_skips_installing_missing_sources() {
    let _guard = ENV_MUTEX.lock().unwrap();
    let previous = std::env::var("PI_OFFLINE").ok();
    std::env::set_var("PI_OFFLINE", "1");
    let mut fixture = Fixture::new();
    fixture.set_user_packages(serde_json::json!(["npm:missing-package"]));
    let project_dir = fixture.manager.cwd().join(crate::settings::CONFIG_DIR_NAME);
    std::fs::create_dir_all(&project_dir).unwrap();
    std::fs::write(
        project_dir.join("settings.json"),
        serde_json::json!({"packages": ["git:github.com/example/missing-repo"]}).to_string(),
    )
    .unwrap();
    fixture.reload();

    let result = fixture.manager.resolve().unwrap();
    assert!(!result
        .extensions
        .iter()
        .chain(&result.skills)
        .chain(&result.prompts)
        .chain(&result.themes)
        .any(|r| r.metadata.origin == ResourceOrigin::Package));

    match previous {
        Some(value) => std::env::set_var("PI_OFFLINE", value),
        None => std::env::remove_var("PI_OFFLINE"),
    }
}

#[test]
fn offline_mode_skips_refreshing_temporary_git_sources() {
    let _guard = ENV_MUTEX.lock().unwrap();
    let previous = std::env::var("PI_OFFLINE").ok();
    std::env::set_var("PI_OFFLINE", "1");
    let mut fixture = Fixture::new();

    // A pre-existing temporary checkout for the source is collected without
    // any refresh attempt.
    let git_source = "git:github.com/example/repo";
    let parsed = super::super::source::parse_source(git_source);
    let installed = match &parsed {
        crate::packages::ParsedSource::Git(git) => super::super::git::git_install_path(
            git,
            SourceScope::Temporary,
            fixture.manager.cwd(),
            &fixture.agent_dir,
        ),
        _ => panic!("expected git source"),
    };
    write(
        &installed.join("extensions").join("index.ts"),
        "export default function() {};",
    );

    let result = fixture
        .manager
        .resolve_extension_sources(
            &[git_source.to_string()],
            ResolveExtensionOptions {
                temporary: true,
                ..Default::default()
            },
        )
        .unwrap();
    assert!(is_enabled(&result.extensions, "extensions/index.ts"));

    match previous {
        Some(value) => std::env::set_var("PI_OFFLINE", value),
        None => std::env::remove_var("PI_OFFLINE"),
    }
}

#[test]
fn on_missing_error_fails_resolution() {
    let _guard = ENV_MUTEX.lock().unwrap();
    let mut fixture = Fixture::new();
    fixture.set_user_packages(serde_json::json!(["npm:missing-package"]));

    let error = fixture
        .manager
        .resolve_with_on_missing(Some(&mut |source| {
            assert_eq!(source, "npm:missing-package");
            crate::packages::MissingSourceAction::Error
        }))
        .unwrap_err();
    assert_eq!(error.to_string(), "Missing source: npm:missing-package");
}

#[test]
fn on_missing_skip_leaves_the_source_out() {
    let _guard = ENV_MUTEX.lock().unwrap();
    let mut fixture = Fixture::new();
    fixture.set_user_packages(serde_json::json!(["npm:missing-package"]));

    let result = fixture
        .manager
        .resolve_with_on_missing(Some(&mut |_| crate::packages::MissingSourceAction::Skip))
        .unwrap();
    assert!(result
        .extensions
        .iter()
        .all(|r| r.metadata.origin != ResourceOrigin::Package));
}

// -- bundled skills -------------------------------------------------------------

#[test]
fn bundled_skills_collect_with_websearch_excluded_until_enabled() {
    let fixture = Fixture::new();
    let bundled = fixture.temp_dir.join("bundled-skills");
    skill_md(&bundled, "websearch", "Search the web");
    skill_md(&bundled, "other-skill", "Other");
    let settings_path = fixture.agent_dir.join("settings.json");
    std::fs::create_dir_all(&fixture.agent_dir).unwrap();

    // Default: websearch is bundled and enabled.
    std::fs::write(&settings_path, serde_json::json!({}).to_string()).unwrap();
    let mut manager = PackageManager::with_options(PackageManagerOptions {
        cwd: fixture.manager.cwd().to_path_buf(),
        agent_dir: fixture.agent_dir.clone(),
        settings: SettingsManager::create(fixture.manager.cwd(), &fixture.agent_dir),
        bundled_skills_dir: BundledSkillsDir::Directory(bundled),
        extra_builtin_skill_overrides: vec!["-other-skill/SKILL.md".to_string()],
    });
    let result = manager.resolve().unwrap();
    let websearch = result
        .skills
        .iter()
        .find(|r| r.path.to_string_lossy().contains("websearch"))
        .expect("websearch collected");
    assert!(websearch.enabled, "websearch enabled by default");
    assert_eq!(websearch.metadata.source, MetadataSource::Builtin);
    let other = result
        .skills
        .iter()
        .find(|r| r.path.to_string_lossy().contains("other-skill"))
        .expect("other collected");
    assert!(!other.enabled, "extra builtin overrides apply");

    // bundledSkills.websearch=false force-excludes the websearch skill.
    std::fs::write(
        &settings_path,
        serde_json::json!({"bundledSkills": {"websearch": false}}).to_string(),
    )
    .unwrap();
    manager.reload_settings().unwrap();
    let result = manager.resolve().unwrap();
    let websearch = result
        .skills
        .iter()
        .find(|r| r.path.to_string_lossy().contains("websearch"))
        .expect("websearch still collected");
    assert!(!websearch.enabled, "websearch excluded until enabled");
}

#[test]
fn empty_bundled_skills_dir_warns() {
    let fixture = Fixture::new();
    let settings = SettingsManager::create(fixture.manager.cwd(), &fixture.agent_dir);
    let mut manager = PackageManager::with_options(PackageManagerOptions {
        cwd: fixture.manager.cwd().to_path_buf(),
        agent_dir: fixture.agent_dir.clone(),
        settings,
        bundled_skills_dir: BundledSkillsDir::Directory(fixture.temp_dir.join("no-such-dir")),
        extra_builtin_skill_overrides: Vec::new(),
    });

    let result = manager.resolve().unwrap();
    assert!(result.diagnostics.iter().any(|d| {
        matches!(
            d,
            crate::skills::diagnostics::ResourceDiagnostic::Warning { message, .. }
                if message.contains("built-in skills directory not found")
        )
    }));
}

#[test]
fn disabled_builtin_skills_are_not_collected() {
    let fixture = Fixture::new();
    let bundled = fixture.temp_dir.join("bundled-skills");
    skill_md(&bundled, "some-skill", "Some");
    std::fs::create_dir_all(&fixture.agent_dir).unwrap();
    std::fs::write(
        fixture.agent_dir.join("settings.json"),
        serde_json::json!({"enableBuiltinSkills": false}).to_string(),
    )
    .unwrap();
    let settings = SettingsManager::create(fixture.manager.cwd(), &fixture.agent_dir);
    let mut manager = PackageManager::with_options(PackageManagerOptions {
        cwd: fixture.manager.cwd().to_path_buf(),
        agent_dir: fixture.agent_dir.clone(),
        settings,
        bundled_skills_dir: BundledSkillsDir::Directory(bundled),
        extra_builtin_skill_overrides: Vec::new(),
    });

    let result = manager.resolve().unwrap();
    assert!(!result
        .skills
        .iter()
        .any(|r| r.path.to_string_lossy().contains("some-skill")));
}

//! `PackageManager`: install/remove/list/update of package sources against
//! the settings store.
//!
//! Scope semantics: `user` sources install into the agent directory and
//! global npm root; `project` sources install under the project config dir
//! (`.prime/agent`) and install into the project npm prefix. Local sources
//! bind directly by path and persist relative to their settings base.

use std::path::{Path, PathBuf};

use anyhow::{bail, Result};

use super::git;
use super::npm;
pub use super::source::UserOrProject;
use super::source::{parse_source, GitSource, NpmSource, ParsedSource, SourceScope};
use crate::settings::SettingsManager;

/// Progress actions reported to the callback.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ProgressAction {
    Install,
    Remove,
    Update,
    Clone,
    Pull,
}

/// Progress event kinds (`start`/`complete`/`error` in the TS surface).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ProgressEventKind {
    Start,
    Complete,
    Error,
}

/// One progress event from an install/remove/update operation.
#[derive(Debug, Clone)]
pub struct ProgressEvent {
    pub kind: ProgressEventKind,
    pub action: ProgressAction,
    pub source: String,
    pub message: Option<String>,
}

/// A configured package from user or project settings.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ConfiguredPackage {
    pub source: String,
    pub scope: UserOrProject,
    /// True when the settings entry is the object (filter) form.
    pub filtered: bool,
    pub installed_path: Option<PathBuf>,
}

/// A package with an available update (startup notices).
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct PackageUpdate {
    pub source: String,
    pub display_name: String,
    /// "npm" | "git"
    pub kind: &'static str,
    pub scope: UserOrProject,
}

/// Progress sink for install/remove/update operations.
type ProgressCallback = Box<dyn Fn(&ProgressEvent) + Send>;

/// Built-in skills directory selection: the packaged layout, disabled
/// entirely, or an explicit directory.
#[derive(Debug, Clone, Default)]
pub enum BundledSkillsDir {
    /// Exe-adjacent `skills/` (the packaged layout).
    #[default]
    Packaged,
    /// Built-in skills disabled (tests, embedded hosts).
    Disabled,
    /// An explicit directory.
    Directory(PathBuf),
}

/// Construction options for [`PackageManager`].
pub struct PackageManagerOptions {
    pub cwd: PathBuf,
    pub agent_dir: PathBuf,
    pub settings: SettingsManager,
    /// Built-in skills directory (default: the packaged layout).
    pub bundled_skills_dir: BundledSkillsDir,
    /// Extra force-exclude patterns for built-in skills (e.g. `-<server>/SKILL.md`
    /// overrides from integrations the user is not logged into).
    pub extra_builtin_skill_overrides: Vec<String>,
}

/// The package manager. Owns a settings manager; mutates the `packages`
/// arrays in the user or project scope, and resolves session resources.
pub struct PackageManager {
    cwd: PathBuf,
    agent_dir: PathBuf,
    settings: SettingsManager,
    progress: Option<ProgressCallback>,
    global_npm_root: Option<PathBuf>,
    /// `None` disables built-in skills entirely.
    bundled_skills_dir: Option<PathBuf>,
    extra_builtin_skill_overrides: Vec<String>,
}

impl PackageManager {
    pub fn new(
        cwd: impl Into<PathBuf>,
        agent_dir: impl Into<PathBuf>,
        settings: SettingsManager,
    ) -> Self {
        Self::with_options(PackageManagerOptions {
            cwd: cwd.into(),
            agent_dir: agent_dir.into(),
            settings,
            bundled_skills_dir: BundledSkillsDir::Packaged,
            extra_builtin_skill_overrides: Vec::new(),
        })
    }

    pub fn with_options(options: PackageManagerOptions) -> Self {
        let bundled_skills_dir = match options.bundled_skills_dir {
            BundledSkillsDir::Packaged => Some(super::get_bundled_skills_dir()),
            BundledSkillsDir::Disabled => None,
            BundledSkillsDir::Directory(dir) => Some(dir),
        };
        Self {
            cwd: options.cwd,
            agent_dir: options.agent_dir,
            settings: options.settings,
            progress: None,
            global_npm_root: None,
            bundled_skills_dir,
            extra_builtin_skill_overrides: options.extra_builtin_skill_overrides,
        }
    }

    pub fn settings(&self) -> &SettingsManager {
        &self.settings
    }

    /// Reload both settings scopes from storage (resolve reads live settings).
    ///
    /// # Errors
    ///
    /// Returns an error when the settings storage cannot be reloaded.
    pub fn reload_settings(&mut self) -> Result<()> {
        self.settings.reload()
    }

    pub(super) fn cwd(&self) -> &std::path::Path {
        &self.cwd
    }

    pub(super) fn agent_dir(&self) -> &std::path::Path {
        &self.agent_dir
    }

    pub(super) fn settings_npm_command(&self) -> Option<Vec<String>> {
        self.settings.settings().npm_command.clone()
    }

    /// Built-in skills directory; `None` when disabled.
    pub(super) fn bundled_skills_dir(&self) -> Option<&PathBuf> {
        self.bundled_skills_dir.as_ref()
    }

    /// Settings flag: load built-in skills (default true).
    pub(super) fn enable_builtin_skills(&self) -> bool {
        self.settings
            .settings()
            .enable_builtin_skills
            .unwrap_or(true)
    }

    /// Settings flag: the bundled websearch skill (default true).
    pub(super) fn bundled_websearch_enabled(&self) -> bool {
        self.settings
            .settings()
            .bundled_skills
            .as_ref()
            .and_then(|bundled| bundled.websearch)
            .unwrap_or(true)
    }

    /// Extra force-exclude patterns for built-in skills.
    pub(super) fn extra_builtin_skill_overrides(&self) -> &[String] {
        &self.extra_builtin_skill_overrides
    }

    pub fn set_progress_callback(&mut self, callback: ProgressCallback) {
        self.progress = Some(callback);
    }

    fn emit_progress(&self, event: ProgressEvent) {
        if let Some(callback) = &self.progress {
            callback(&event);
        }
    }

    pub(super) fn with_progress(
        &mut self,
        action: ProgressAction,
        source: &str,
        message: &str,
        operation: impl FnOnce(&mut Self) -> Result<()>,
    ) -> Result<()> {
        self.emit_progress(ProgressEvent {
            kind: ProgressEventKind::Start,
            action,
            source: source.to_string(),
            message: Some(message.to_string()),
        });
        match operation(self) {
            Ok(()) => {
                self.emit_progress(ProgressEvent {
                    kind: ProgressEventKind::Complete,
                    action,
                    source: source.to_string(),
                    message: None,
                });
                Ok(())
            }
            Err(error) => {
                self.emit_progress(ProgressEvent {
                    kind: ProgressEventKind::Error,
                    action,
                    source: source.to_string(),
                    message: Some(error.to_string()),
                });
                Err(error)
            }
        }
    }

    /// Install a source and add it to settings.
    ///
    /// # Errors
    ///
    /// Returns an error when the installation fails; settings are only
    /// updated when it succeeds.
    pub fn install_and_persist(&mut self, source: &str, scope: UserOrProject) -> Result<()> {
        self.install(source, scope)?;
        self.add_source_to_settings(source, scope);
        Ok(())
    }

    /// Install a source into its scope-appropriate location.
    ///
    /// # Errors
    ///
    /// Returns an error when the npm or git install fails, or when a local
    /// source path does not exist.
    pub fn install(&mut self, source: &str, scope: UserOrProject) -> Result<()> {
        let parsed = parse_source(source);
        self.with_progress(
            ProgressAction::Install,
            source,
            &format!("Installing {source}..."),
            |manager| match &parsed {
                ParsedSource::Npm(npm_source) => {
                    manager.install_npm(npm_source, SourceScope::from(scope), false)
                }
                ParsedSource::Git(git_source) => {
                    manager.install_git_source(git_source, SourceScope::from(scope))
                }
                ParsedSource::Local(local) => {
                    let resolved = manager.resolve_path(&local.path);
                    if !resolved.exists() {
                        bail!("Path does not exist: {}", resolved.display());
                    }
                    Ok(())
                }
            },
        )
    }

    /// Remove a source's installed files.
    ///
    /// # Errors
    ///
    /// Returns an error when the npm uninstall or git removal fails. Local
    /// sources have no installed files and always succeed.
    pub fn remove(&mut self, source: &str, scope: UserOrProject) -> Result<()> {
        let parsed = parse_source(source);
        self.with_progress(
            ProgressAction::Remove,
            source,
            &format!("Removing {source}..."),
            |manager| match &parsed {
                ParsedSource::Npm(npm_source) => {
                    manager.uninstall_npm(npm_source, SourceScope::from(scope))
                }
                ParsedSource::Git(git_source) => git::remove_git(
                    git_source,
                    SourceScope::from(scope),
                    &manager.cwd,
                    &manager.agent_dir,
                ),
                ParsedSource::Local(_) => Ok(()),
            },
        )
    }

    /// Remove a source and drop it from settings; false when the source was
    /// not configured (the CLI reports "No matching package found").
    ///
    /// # Errors
    ///
    /// Returns an error when the removal fails; settings are only updated
    /// when it succeeds.
    pub fn remove_and_persist(&mut self, source: &str, scope: UserOrProject) -> Result<bool> {
        self.remove(source, scope)?;
        Ok(self.remove_source_from_settings(source, scope))
    }

    /// Add a source to settings; false when an equivalent source is already
    /// configured.
    pub fn add_source_to_settings(&mut self, source: &str, scope: UserOrProject) -> bool {
        let current: Vec<serde_json::Value> = self.packages_for_scope(scope).unwrap_or_default();
        let normalized = self.normalize_package_source_for_settings(source, scope);
        let exists = current
            .iter()
            .any(|existing| self.package_sources_match(existing, source, scope));
        if exists {
            return false;
        }
        let mut next = current;
        next.push(serde_json::Value::String(normalized));
        self.set_packages_for_scope(scope, next);
        true
    }

    /// Drop a source from settings; true when a matching entry was removed.
    pub fn remove_source_from_settings(&mut self, source: &str, scope: UserOrProject) -> bool {
        let current: Vec<serde_json::Value> = self.packages_for_scope(scope).unwrap_or_default();
        let next: Vec<serde_json::Value> = current
            .iter()
            .filter(|existing| !self.package_sources_match(existing, source, scope))
            .cloned()
            .collect();
        if next.len() == current.len() {
            return false;
        }
        self.set_packages_for_scope(scope, next);
        true
    }

    /// Configured packages across both scopes (user first).
    pub fn list_configured_packages(&self) -> Vec<ConfiguredPackage> {
        let mut packages = Vec::new();
        for scope in [UserOrProject::User, UserOrProject::Project] {
            for entry in self.packages_for_scope(scope).unwrap_or_default() {
                let (source, filtered) = split_entry(&entry);
                packages.push(ConfiguredPackage {
                    source: source.clone(),
                    scope,
                    filtered,
                    installed_path: self.get_installed_path(&source, scope),
                });
            }
        }
        packages
    }

    /// Absolute install location for a configured source, when present.
    pub fn get_installed_path(&self, source: &str, scope: UserOrProject) -> Option<PathBuf> {
        match parse_source(source) {
            ParsedSource::Npm(npm_source) => {
                let global_root = self.global_npm_root().ok()?;
                let path =
                    npm::npm_install_path(&npm_source, scope.into(), &self.cwd, &global_root);
                path.exists().then_some(path)
            }
            ParsedSource::Git(git_source) => {
                let path =
                    git::git_install_path(&git_source, scope.into(), &self.cwd, &self.agent_dir);
                path.exists().then_some(path)
            }
            ParsedSource::Local(local) => {
                let base = self.base_dir_for_scope(SourceScope::from(scope));
                let path = self.resolve_path_from_base(&local.path, &base);
                path.exists().then_some(path)
            }
        }
    }

    // -- scoped settings helpers --------------------------------------------

    pub(super) fn packages_for_scope(
        &self,
        scope: UserOrProject,
    ) -> Option<Vec<serde_json::Value>> {
        match scope {
            UserOrProject::User => self.settings.global_settings().packages.clone(),
            UserOrProject::Project => self.settings.project_settings().packages.clone(),
        }
    }

    fn set_packages_for_scope(&mut self, scope: UserOrProject, packages: Vec<serde_json::Value>) {
        match scope {
            UserOrProject::User => self.settings.set_packages(packages),
            UserOrProject::Project => self.settings.set_project_packages(packages),
        }
    }

    pub(super) fn base_dir_for_scope(&self, scope: SourceScope) -> PathBuf {
        match scope {
            SourceScope::Project => self.cwd.join(super::CONFIG_DIR_NAME),
            SourceScope::User => self.agent_dir.clone(),
            SourceScope::Temporary => self.cwd.clone(),
        }
    }

    /// Local sources persist relative to their settings base (git/npm sources
    /// persist verbatim).
    fn normalize_package_source_for_settings(&self, source: &str, scope: UserOrProject) -> String {
        if !matches!(parse_source(source), ParsedSource::Local(_)) {
            return source.to_string();
        }
        let base = self.base_dir_for_scope(scope.into());
        let resolved = self.resolve_path(source);
        let relative = super::source::path_relative(&base, &resolved);
        if relative.is_empty() {
            ".".to_string()
        } else {
            relative
        }
    }

    /// Identity-based source comparison: an input matches a configured entry
    /// when they resolve to the same package (npm name, git host/path, or
    /// absolute local path).
    fn package_sources_match(
        &self,
        existing: &serde_json::Value,
        input_source: &str,
        scope: UserOrProject,
    ) -> bool {
        let (existing_source, _) = split_entry(existing);
        self.get_source_match_key_for_settings(&existing_source, scope)
            == self.get_source_match_key_for_input(input_source)
    }

    pub(super) fn get_source_match_key_for_input(&self, source: &str) -> String {
        match parse_source(source) {
            ParsedSource::Npm(npm_source) => format!("npm:{}", npm_source.name),
            ParsedSource::Git(git_source) => {
                format!("git:{}/{}", git_source.host, git_source.path)
            }
            ParsedSource::Local(local) => {
                format!("local:{}", self.resolve_path(&local.path).display())
            }
        }
    }

    pub(super) fn get_source_match_key_for_settings(
        &self,
        source: &str,
        scope: UserOrProject,
    ) -> String {
        match parse_source(source) {
            ParsedSource::Npm(npm_source) => format!("npm:{}", npm_source.name),
            ParsedSource::Git(git_source) => {
                format!("git:{}/{}", git_source.host, git_source.path)
            }
            ParsedSource::Local(local) => {
                let base = self.base_dir_for_scope(scope.into());
                format!(
                    "local:{}",
                    self.resolve_path_from_base(&local.path, &base).display()
                )
            }
        }
    }

    pub(super) fn resolve_path(&self, input: &str) -> PathBuf {
        let trimmed = input.trim();
        if let Some(path) = expand_tilde(trimmed) {
            return path;
        }
        super::source::lexical_resolve(&self.cwd, trimmed)
    }

    pub(super) fn resolve_path_from_base(&self, input: &str, base: &Path) -> PathBuf {
        let trimmed = input.trim();
        if let Some(path) = expand_tilde(trimmed) {
            return path;
        }
        super::source::lexical_resolve(base, trimmed)
    }

    // -- npm ------------------------------------------------------------------

    pub(super) fn global_npm_root(&self) -> Result<PathBuf> {
        if let Some(root) = &self.global_npm_root {
            return Ok(root.clone());
        }
        let (program, args) = npm::npm_command(self.settings.settings().npm_command.as_ref());
        let root = npm::discover_global_npm_root(&program, &args)?;
        Ok(root)
    }

    pub(super) fn install_npm(
        &mut self,
        source: &NpmSource,
        scope: SourceScope,
        temporary: bool,
    ) -> Result<()> {
        if scope == SourceScope::User && !temporary {
            self.run_npm_command(&["install", "-g", &source.spec], None)?;
            return Ok(());
        }
        let install_root = npm::npm_install_root(scope, &self.cwd, &self.global_npm_root()?);
        npm::ensure_npm_project(&install_root)?;
        let install_root_str = install_root.display().to_string();
        self.run_npm_command(
            &["install", &source.spec, "--prefix", &install_root_str],
            None,
        )?;
        Ok(())
    }

    fn uninstall_npm(&mut self, source: &NpmSource, scope: SourceScope) -> Result<()> {
        if scope == SourceScope::User {
            self.run_npm_command(&["uninstall", "-g", &source.name], None)?;
            return Ok(());
        }
        let install_root = npm::project_npm_root(&self.cwd);
        if !install_root.exists() {
            return Ok(());
        }
        let install_root_str = install_root.display().to_string();
        self.run_npm_command(
            &["uninstall", &source.name, "--prefix", &install_root_str],
            None,
        )?;
        Ok(())
    }

    /// Install location for an npm package in a scope (no existence check).
    pub(super) fn npm_install_path(&self, source: &NpmSource, scope: UserOrProject) -> PathBuf {
        let global_root = self.global_npm_root().unwrap_or_default();
        npm::npm_install_path(source, scope.into(), &self.cwd, &global_root)
    }

    /// `npm view <name> version --json`.
    pub(super) fn latest_npm_version(&self, name: &str) -> Result<String> {
        let (program, args) = npm::npm_command(self.settings_npm_command().as_ref());
        npm::latest_npm_version(&program, &args, name)
    }

    /// Batched npm install (`install -g specs` / project `--prefix` install).
    pub(super) fn install_npm_batch(
        &mut self,
        specs: &[String],
        scope: UserOrProject,
    ) -> Result<()> {
        if scope == UserOrProject::User {
            let specs: Vec<String> = specs.to_vec();
            self.run_npm_command(
                &{
                    let mut args = vec!["install".to_string(), "-g".to_string()];
                    args.extend(specs);
                    args
                }
                .iter()
                .map(String::as_str)
                .collect::<Vec<_>>(),
                None,
            )?;
            return Ok(());
        }
        let install_root = npm::project_npm_root(&self.cwd);
        npm::ensure_npm_project(&install_root)?;
        let install_root_str = install_root.display().to_string();
        let mut args = vec!["install".to_string()];
        args.extend(specs.iter().cloned());
        args.push("--prefix".to_string());
        args.push(install_root_str);
        self.run_npm_command(&args.iter().map(String::as_str).collect::<Vec<_>>(), None)?;
        Ok(())
    }

    fn run_npm_command(&mut self, args: &[&str], cwd: Option<&Path>) -> Result<()> {
        let (program, configured) = npm::npm_command(self.settings.settings().npm_command.as_ref());
        let mut full_args: Vec<String> = configured;
        full_args.extend(args.iter().map(std::string::ToString::to_string));
        super::process::run_command(
            &program,
            &full_args.iter().map(String::as_str).collect::<Vec<_>>(),
            cwd,
        )
    }

    pub(super) fn install_git_source(
        &mut self,
        source: &GitSource,
        scope: SourceScope,
    ) -> Result<()> {
        let npm_command = self.settings.settings().npm_command.clone();
        git::install_git(
            source,
            scope,
            &self.cwd,
            &self.agent_dir,
            npm_command.as_ref(),
        )
    }
}

/// A settings `packages` entry: a plain source string or the filter object
/// form (`{ source, extensions?, skills?, prompts?, themes? }`).
pub(super) fn split_entry(entry: &serde_json::Value) -> (String, bool) {
    match entry {
        serde_json::Value::String(source) => (source.clone(), false),
        serde_json::Value::Object(_) => (
            entry
                .get("source")
                .and_then(serde_json::Value::as_str)
                .unwrap_or_default()
                .to_string(),
            true,
        ),
        _ => (String::new(), false),
    }
}

/// Expand `~`/`~/` against the home directory (a tilde path is absolute).
fn expand_tilde(input: &str) -> Option<PathBuf> {
    let home = pa_types::platform::home_dir()?;
    if input == "~" {
        return Some(home);
    }
    input
        .strip_prefix("~/")
        .map(|rest| home.join(rest))
        .or_else(|| input.strip_prefix('~').map(|rest| home.join(rest)))
}
#[cfg(test)]
mod tests {
    use super::*;

    fn setup() -> (tempfile::TempDir, PackageManager) {
        let dir = tempfile::tempdir().unwrap();
        let agent_dir = dir.path().join("agent");
        let cwd = dir.path().join("cwd");
        std::fs::create_dir_all(&agent_dir).unwrap();
        std::fs::create_dir_all(&cwd).unwrap();
        let settings = SettingsManager::create(&cwd, &agent_dir);
        let manager = PackageManager::new(&cwd, &agent_dir, settings);
        (dir, manager)
    }

    fn read_settings(dir: &tempfile::TempDir) -> serde_json::Value {
        serde_json::from_str(
            &std::fs::read_to_string(dir.path().join("agent").join("settings.json")).unwrap(),
        )
        .unwrap()
    }

    fn make_pkg(dir: &tempfile::TempDir, relative: &str) -> std::path::PathBuf {
        let pkg = dir.path().join("cwd").join(relative);
        std::fs::create_dir_all(pkg.join("skills")).unwrap();
        std::fs::write(
            pkg.join("package.json"),
            r#"{"name":"pkg","version":"1.0.0"}"#,
        )
        .unwrap();
        pkg
    }

    #[test]
    fn install_and_remove_local_round_trip() {
        let (dir, mut manager) = setup();
        make_pkg(&dir, "local-pkg");

        manager
            .install_and_persist("./local-pkg", UserOrProject::User)
            .unwrap();

        // Settings store the path relative to the agent dir.
        let settings = read_settings(&dir);
        assert_eq!(
            settings["packages"],
            serde_json::json!(["../cwd/local-pkg"])
        );

        // list shows the resolved install path.
        let configured = manager.list_configured_packages();
        assert_eq!(configured.len(), 1);
        assert_eq!(configured[0].source, "../cwd/local-pkg");
        assert_eq!(configured[0].scope, UserOrProject::User);
        assert!(!configured[0].filtered);
        assert_eq!(
            configured[0].installed_path.as_deref(),
            Some(dir.path().join("cwd").join("local-pkg").as_path())
        );

        // Remove by the equivalent absolute form and confirm the round trip.
        assert!(manager
            .remove_and_persist(
                &dir.path()
                    .join("cwd")
                    .join("local-pkg")
                    .display()
                    .to_string(),
                UserOrProject::User
            )
            .unwrap());
        assert!(manager.list_configured_packages().is_empty());
        assert_eq!(read_settings(&dir)["packages"], serde_json::json!([]));

        // Removing again is not a match.
        assert!(!manager
            .remove_and_persist("./local-pkg", UserOrProject::User)
            .unwrap());
    }

    #[test]
    fn installing_missing_local_path_fails() {
        let (dir, mut manager) = setup();
        let error = manager
            .install_and_persist("./no-such-pkg", UserOrProject::User)
            .unwrap_err();
        assert_eq!(
            error.to_string(),
            format!(
                "Path does not exist: {}",
                dir.path().join("cwd").join("no-such-pkg").display()
            )
        );
        assert!(manager.list_configured_packages().is_empty());
    }

    #[test]
    fn duplicate_installs_are_settings_noops() {
        let (dir, mut manager) = setup();
        make_pkg(&dir, "dup-pkg");
        manager
            .install_and_persist("./dup-pkg", UserOrProject::User)
            .unwrap();
        manager
            .install_and_persist("./dup-pkg", UserOrProject::User)
            .unwrap();
        let settings = read_settings(&dir);
        assert_eq!(settings["packages"].as_array().unwrap().len(), 1);
    }

    #[test]
    fn project_scope_persists_against_project_settings_base() {
        let (dir, mut manager) = setup();
        make_pkg(&dir, "project-pkg");
        manager
            .install_and_persist("./project-pkg", UserOrProject::Project)
            .unwrap();
        let project = serde_json::from_str::<serde_json::Value>(
            &std::fs::read_to_string(
                dir.path()
                    .join("cwd")
                    .join(crate::settings::CONFIG_DIR_NAME)
                    .join("settings.json"),
            )
            .unwrap(),
        )
        .unwrap();
        assert_eq!(
            project["packages"],
            serde_json::json!(["../../project-pkg"])
        );
        // Global settings are never created by a project-scoped install.
        assert!(!dir.path().join("agent").join("settings.json").exists());

        let configured = manager.list_configured_packages();
        assert_eq!(configured.len(), 1);
        assert_eq!(configured[0].scope, UserOrProject::Project);
    }

    #[test]
    fn equivalent_local_path_forms_remove_by_identity() {
        let (dir, mut manager) = setup();
        make_pkg(&dir, "remove-pkg");
        manager
            .install_and_persist("./remove-pkg", UserOrProject::User)
            .unwrap();
        // A trailing slash resolves to the same identity.
        assert!(manager
            .remove_and_persist("./remove-pkg/", UserOrProject::User)
            .unwrap());
    }

    #[test]
    fn filtered_entries_list_and_remove_by_source() {
        let (dir, mut manager) = setup();
        std::fs::create_dir_all(dir.path().join("agent")).unwrap();
        std::fs::write(
            dir.path().join("agent").join("settings.json"),
            r#"{"packages": [{"source": "./filtered-pkg", "skills": ["skills/*.md"]}]}"#,
        )
        .unwrap();
        manager.settings.reload().unwrap();
        let configured = manager.list_configured_packages();
        assert_eq!(configured.len(), 1);
        assert!(configured[0].filtered);
        assert_eq!(configured[0].source, "./filtered-pkg");

        // Settings-local paths match by their settings-base resolution, not
        // the cwd resolution: the cwd form does not match (TS parity), the
        // absolute equivalent does.
        assert!(!manager.remove_source_from_settings("./filtered-pkg", UserOrProject::User));
        let agent_local = dir.path().join("agent").join("filtered-pkg");
        assert!(manager
            .remove_source_from_settings(&agent_local.display().to_string(), UserOrProject::User));
        assert!(manager.list_configured_packages().is_empty());
    }

    #[test]
    fn progress_events_report_start_and_error() {
        let (_dir, mut manager) = setup();
        let events = std::sync::Arc::new(std::sync::Mutex::new(Vec::new()));
        let sink = events.clone();
        manager.set_progress_callback(Box::new(move |event| {
            sink.lock().unwrap().push((
                event.kind,
                event.action,
                event.source.clone(),
                event.message.clone(),
            ));
        }));
        let error = manager
            .install_and_persist("./no-such-pkg", UserOrProject::User)
            .unwrap_err();
        assert!(!error.to_string().is_empty());
        let events = events.lock().unwrap();
        assert_eq!(events[0].0, ProgressEventKind::Start);
        assert_eq!(events[0].1, ProgressAction::Install);
        assert_eq!(events[0].3.as_deref(), Some("Installing ./no-such-pkg..."));
        assert_eq!(events[1].0, ProgressEventKind::Error);
    }
}

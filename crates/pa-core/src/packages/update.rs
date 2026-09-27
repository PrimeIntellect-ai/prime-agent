//! Package update flow: match configured packages by identity, probe npm
//! versions and git upstreams, and reinstall moved packages; plus the
//! startup-notice update check.

use anyhow::{bail, Result};

use super::manager::{PackageManager, PackageUpdate, ProgressAction};
use super::npm;
use super::source::{parse_source, GitSource, NpmSource, ParsedSource, SourceScope, UserOrProject};

impl PackageManager {
    /// Update configured packages. With a source, only packages with the same
    /// identity update; an unknown source is an error with a suggestion.
    ///
    /// # Errors
    ///
    /// Returns an error when a given source matches no configured package,
    /// or when a package's update or reinstall fails.
    pub fn update(&mut self, source: Option<&str>) -> Result<()> {
        let identity = source.map(|source| self.get_source_match_key_for_input(source));
        let mut matched = false;
        let mut update_sources: Vec<(String, UserOrProject)> = Vec::new();

        for scope in [UserOrProject::User, UserOrProject::Project] {
            for entry in self.packages_for_scope(scope).unwrap_or_default() {
                let (source_str, _) = super::manager::split_entry(&entry);
                if let Some(identity) = &identity {
                    if &self.get_source_match_key_for_settings(&source_str, scope) != identity {
                        continue;
                    }
                }
                matched = true;
                update_sources.push((source_str, scope));
            }
        }

        if let Some(source) = source {
            if !matched {
                let configured = [
                    self.packages_for_scope(UserOrProject::User)
                        .unwrap_or_default(),
                    self.packages_for_scope(UserOrProject::Project)
                        .unwrap_or_default(),
                ]
                .concat();
                bail!(self.build_no_matching_package_message(source, &configured));
            }
        }

        self.update_configured_sources(update_sources)
    }

    /// Packages (across both scopes) with an available update; project
    /// entries win over user entries for the same package.
    pub fn check_for_available_updates(&mut self) -> Vec<PackageUpdate> {
        if super::is_offline_mode_enabled() {
            return Vec::new();
        }
        let mut seen = std::collections::HashSet::new();
        let mut updates = Vec::new();
        // Project first so its entries win the identity dedupe.
        for scope in [UserOrProject::Project, UserOrProject::User] {
            for entry in self.packages_for_scope(scope).unwrap_or_default() {
                let (source, _) = super::manager::split_entry(&entry);
                if !seen.insert(self.get_source_match_key_for_settings(&source, scope)) {
                    continue;
                }
                match parse_source(&source) {
                    ParsedSource::Npm(parsed) if !parsed.pinned => {
                        if let Some(installed) = self.get_installed_path(&source, scope) {
                            if self.npm_has_available_update(&parsed, &installed) {
                                updates.push(PackageUpdate {
                                    source,
                                    display_name: parsed.name,
                                    kind: "npm",
                                    scope,
                                });
                            }
                        }
                    }
                    ParsedSource::Git(parsed) if !parsed.pinned => {
                        if let Some(installed) = self.get_installed_path(&source, scope) {
                            if super::git::git_has_available_update(&installed) {
                                updates.push(PackageUpdate {
                                    source,
                                    display_name: format!("{}/{}", parsed.host, parsed.path),
                                    kind: "git",
                                    scope,
                                });
                            }
                        }
                    }
                    _ => {}
                }
            }
        }
        updates
    }

    fn update_configured_sources(&mut self, sources: Vec<(String, UserOrProject)>) -> Result<()> {
        if super::is_offline_mode_enabled() || sources.is_empty() {
            return Ok(());
        }

        let mut npm_candidates: Vec<NpmUpdateTarget> = Vec::new();
        let mut git_candidates: Vec<GitUpdateTarget> = Vec::new();

        for (source, scope) in sources {
            match parse_source(&source) {
                ParsedSource::Local(_) => {}
                ParsedSource::Npm(parsed) if parsed.pinned => {}
                ParsedSource::Git(parsed) if parsed.pinned => {}
                ParsedSource::Npm(parsed) => npm_candidates.push(NpmUpdateTarget {
                    source,
                    parsed,
                    scope,
                }),
                ParsedSource::Git(parsed) => git_candidates.push(GitUpdateTarget {
                    source,
                    parsed,
                    scope,
                }),
            }
        }

        // Probe each npm package; missing or unreadable versions always update.
        let mut npm_updates: Vec<NpmUpdateTarget> = Vec::new();
        for candidate in npm_candidates {
            if self.should_update_npm_source(&candidate.parsed, candidate.scope) {
                npm_updates.push(candidate);
            }
        }

        let mut user_batch: Vec<&NpmUpdateTarget> = Vec::new();
        let mut project_batch: Vec<&NpmUpdateTarget> = Vec::new();
        for candidate in &npm_updates {
            match candidate.scope {
                UserOrProject::User => user_batch.push(candidate),
                UserOrProject::Project => project_batch.push(candidate),
            }
        }
        if !user_batch.is_empty() {
            self.update_npm_batch(&user_batch, UserOrProject::User)?;
        }
        if !project_batch.is_empty() {
            self.update_npm_batch(&project_batch, UserOrProject::Project)?;
        }

        for candidate in git_candidates {
            self.with_progress(
                ProgressAction::Update,
                &candidate.source,
                &format!("Updating {}...", candidate.source),
                move |manager| {
                    let npm_command = manager.settings_npm_command();
                    super::git::update_git(
                        &candidate.parsed,
                        SourceScope::from(candidate.scope),
                        manager.cwd(),
                        manager.agent_dir(),
                        npm_command.as_ref(),
                    )
                },
            )?;
        }
        Ok(())
    }

    fn should_update_npm_source(&mut self, source: &NpmSource, scope: UserOrProject) -> bool {
        let installed_path = self.npm_install_path(source, scope);
        let installed_version = if installed_path.exists() {
            npm::installed_npm_version(&installed_path)
        } else {
            None
        };
        let Some(installed_version) = installed_version else {
            return true;
        };
        match self.latest_npm_version(&source.name) {
            // Preserve the existing update policy when the lookup fails.
            Ok(latest) => latest != installed_version,
            Err(_) => true,
        }
    }

    fn npm_has_available_update(
        &mut self,
        source: &NpmSource,
        installed_path: &std::path::Path,
    ) -> bool {
        if super::is_offline_mode_enabled() {
            return false;
        }
        let Some(installed_version) = npm::installed_npm_version(installed_path) else {
            return false;
        };
        match self.latest_npm_version(&source.name) {
            Ok(latest) => latest != installed_version,
            Err(_) => false,
        }
    }

    /// One batched npm install per scope, labeled with the single source or
    /// the scope-wide label.
    fn update_npm_batch(
        &mut self,
        sources: &[&NpmUpdateTarget],
        scope: UserOrProject,
    ) -> Result<()> {
        if sources.is_empty() {
            return Ok(());
        }
        let source_label = if sources.len() == 1 {
            sources[0].source.clone()
        } else {
            format!("{} npm packages", scope.as_str())
        };
        let message = if sources.len() == 1 {
            format!("Updating {}...", sources[0].source)
        } else {
            format!("Updating {} npm packages...", scope.as_str())
        };
        let specs: Vec<String> = sources
            .iter()
            .map(|candidate| format!("{}@latest", candidate.parsed.name))
            .collect();
        self.with_progress(
            ProgressAction::Update,
            &source_label,
            &message,
            move |manager| manager.install_npm_batch(&specs, scope),
        )
    }

    /// `No matching package found for <source>` with the configured source the
    /// input most plausibly meant, if any.
    fn build_no_matching_package_message(
        &self,
        source: &str,
        configured: &[serde_json::Value],
    ) -> String {
        let trimmed = source.trim();
        for entry in configured {
            let (candidate, _) = super::manager::split_entry(entry);
            match parse_source(&candidate) {
                ParsedSource::Npm(parsed) => {
                    if trimmed == parsed.name || trimmed == parsed.spec {
                        return format!(
                            "No matching package found for {source}. Did you mean {candidate}?"
                        );
                    }
                }
                ParsedSource::Git(parsed) => {
                    let shorthand = format!("{}/{}", parsed.host, parsed.path);
                    let with_ref = parsed.r#ref.as_ref().map(|r| format!("{shorthand}@{r}"));
                    if trimmed == shorthand || with_ref.is_some_and(|with_ref| trimmed == with_ref)
                    {
                        return format!(
                            "No matching package found for {source}. Did you mean {candidate}?"
                        );
                    }
                }
                ParsedSource::Local(_) => {}
            }
        }
        format!("No matching package found for {source}")
    }
}

struct NpmUpdateTarget {
    source: String,
    parsed: NpmSource,
    scope: UserOrProject,
}

struct GitUpdateTarget {
    source: String,
    parsed: GitSource,
    scope: UserOrProject,
}

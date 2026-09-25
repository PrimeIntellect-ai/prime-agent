//! The `resolve()` methods on the package manager: configured-source
//! resolution (including missing-source install policy and temporary-git
//! refresh), settings top-level arrays, and package resource collection
//! (manifest, convention directories, and filter patterns).

use std::path::{Path, PathBuf};

use anyhow::Result;

use super::super::source::{parse_source, GitSource, NpmSource, ParsedSource, SourceScope};
use super::super::PackageManager;
use super::super::{git, npm};
use std::collections::HashMap;

use super::discovery::collect_resource_files;
use super::patterns::{apply_patterns, split_patterns};
use super::{
    settings_array, to_resolved_paths, top_level_metadata, ConfiguredSource, MetadataSource,
    MissingSourceAction, PackageFilter, PathMetadata, ResolveExtensionOptions, ResolvedPaths,
    ResourceAccumulator, ResourceOrigin, ResourceType, RESOURCE_TYPES,
};

/// Parse the object (filter) form of a `packages` settings entry.
fn parse_package_filter(entry: &serde_json::Value) -> Option<PackageFilter> {
    let object = entry.as_object()?;
    let strings = |value: Option<&serde_json::Value>| -> Option<Vec<String>> {
        match value {
            Some(serde_json::Value::Array(entries)) => Some(
                entries
                    .iter()
                    .filter_map(serde_json::Value::as_str)
                    .map(str::to_string)
                    .collect(),
            ),
            _ => None,
        }
    };
    Some(PackageFilter {
        extensions: strings(object.get("extensions")),
        skills: strings(object.get("skills")),
        prompts: strings(object.get("prompts")),
        themes: strings(object.get("themes")),
    })
}

/// Dedupe configured sources by package identity (npm name, git host/path,
/// or scope-resolved local path); a project entry replaces an equal user
/// entry (project wins).
fn dedupe_configured_sources(
    manager: &PackageManager,
    all_packages: Vec<(serde_json::Value, SourceScope)>,
) -> Vec<ConfiguredSource> {
    let mut seen: HashMap<String, usize> = HashMap::new();
    let mut deduped: Vec<ConfiguredSource> = Vec::new();
    for (entry, scope) in all_packages {
        let (source, is_object) = super::super::manager::split_entry(&entry);
        let filter = is_object.then(|| parse_package_filter(&entry)).flatten();
        let identity = match parse_source(&source) {
            ParsedSource::Npm(npm_source) => format!("npm:{}", npm_source.name),
            ParsedSource::Git(git_source) => {
                format!("git:{}/{}", git_source.host, git_source.path)
            }
            ParsedSource::Local(local) => {
                let base_dir = manager.base_dir_for_scope(scope);
                let resolved = manager.resolve_path_from_base(&local.path, &base_dir);
                format!("local:{}", resolved.display())
            }
        };
        match seen.get(&identity) {
            None => {
                seen.insert(identity, deduped.len());
                deduped.push(ConfiguredSource {
                    source,
                    scope,
                    filter,
                });
            }
            Some(existing_index) => {
                if scope == SourceScope::Project {
                    deduped[*existing_index] = ConfiguredSource {
                        source,
                        scope,
                        filter,
                    };
                }
            }
        }
    }
    deduped
}

/// Files or directory trees behind a list of paths: files pass through,
/// directories are collected per resource kind; missing paths are skipped.
pub(crate) fn collect_files_from_paths(
    paths: &[PathBuf],
    resource_type: ResourceType,
) -> Vec<PathBuf> {
    let mut files = Vec::new();
    for path in paths {
        let Ok(stats) = std::fs::metadata(path) else {
            continue;
        };
        if stats.is_file() {
            files.push(path.clone());
        } else if stats.is_dir() {
            files.extend(collect_resource_files(path, resource_type));
        }
    }
    files
}

fn installed_npm_matches_pinned_version(source: &NpmSource, installed_path: &Path) -> bool {
    let Some(installed_version) = npm::installed_npm_version(installed_path) else {
        return false;
    };
    let (_, pinned_version) = super::super::source::parse_npm_spec(&source.spec);
    match pinned_version {
        None => true,
        Some(pinned) => installed_version == pinned,
    }
}

impl PackageManager {
    /// Resolve every session resource path, installing missing configured
    /// package sources when not offline-skipped.
    ///
    /// # Errors
    ///
    /// Returns an error when a configured package source cannot be parsed,
    /// installed, or refreshed (npm/git failures, missing local paths).
    pub fn resolve(&mut self) -> Result<ResolvedPaths> {
        self.resolve_with_on_missing(None)
    }

    /// [`PackageManager::resolve`] with a missing-source policy callback
    /// (`None` installs missing sources directly, the resource-loader path).
    ///
    /// # Errors
    ///
    /// Returns an error when a configured package source cannot be parsed,
    /// installed, or refreshed (npm/git failures, missing local paths), or
    /// when the missing-source policy chooses to error.
    pub fn resolve_with_on_missing(
        &mut self,
        on_missing: Option<&mut dyn FnMut(&str) -> MissingSourceAction>,
    ) -> Result<ResolvedPaths> {
        let global = self.settings().global_settings().clone();
        let project = self.settings().project_settings().clone();
        let mut accumulator = ResourceAccumulator::default();

        // Project entries precede user entries; the dedupe keeps the project
        // entry when the same package identity appears in both scopes.
        let mut all_packages: Vec<(serde_json::Value, SourceScope)> = Vec::new();
        for entry in project.packages.iter().flatten() {
            all_packages.push((entry.clone(), SourceScope::Project));
        }
        for entry in global.packages.iter().flatten() {
            all_packages.push((entry.clone(), SourceScope::User));
        }
        let package_sources = dedupe_configured_sources(self, all_packages);
        self.resolve_package_sources(package_sources, &mut accumulator, on_missing)?;

        let global_base_dir = self.agent_dir().to_path_buf();
        let project_base_dir = self.cwd().join(super::super::CONFIG_DIR_NAME);

        for resource_type in RESOURCE_TYPES {
            let project_entries = settings_array(&project, resource_type);
            let global_entries = settings_array(&global, resource_type);
            self.resolve_local_entries(
                &project_entries,
                resource_type,
                &mut accumulator,
                top_level_metadata(MetadataSource::Local, SourceScope::Project),
                &project_base_dir,
            );
            self.resolve_local_entries(
                &global_entries,
                resource_type,
                &mut accumulator,
                top_level_metadata(MetadataSource::Local, SourceScope::User),
                &global_base_dir,
            );
        }

        self.add_auto_discovered_resources(
            &mut accumulator,
            &global,
            &project,
            &global_base_dir,
            &project_base_dir,
        );

        Ok(to_resolved_paths(accumulator))
    }

    /// Resolve a caller-supplied list of package sources (CLI extension
    /// sources) without touching settings. Unpinned temporary git sources
    /// auto-refresh from their origin.
    ///
    /// # Errors
    ///
    /// Returns an error when one of the given sources cannot be parsed,
    /// installed, or refreshed (npm/git failures, missing local paths).
    pub fn resolve_extension_sources(
        &mut self,
        sources: &[String],
        options: ResolveExtensionOptions,
    ) -> Result<ResolvedPaths> {
        let scope = if options.temporary {
            SourceScope::Temporary
        } else if options.local {
            SourceScope::Project
        } else {
            SourceScope::User
        };
        let mut accumulator = ResourceAccumulator::default();
        let configured: Vec<ConfiguredSource> = sources
            .iter()
            .map(|source| ConfiguredSource {
                source: source.clone(),
                scope,
                filter: None,
            })
            .collect();
        self.resolve_package_sources(configured, &mut accumulator, None)?;
        Ok(to_resolved_paths(accumulator))
    }

    fn resolve_package_sources(
        &mut self,
        sources: Vec<ConfiguredSource>,
        accumulator: &mut ResourceAccumulator,
        mut on_missing: Option<&mut dyn FnMut(&str) -> MissingSourceAction>,
    ) -> Result<()> {
        for configured in sources {
            let parsed = parse_source(&configured.source);
            let mut metadata = PathMetadata {
                source: MetadataSource::Package(configured.source.clone()),
                scope: configured.scope,
                origin: ResourceOrigin::Package,
                base_dir: None,
            };
            match &parsed {
                ParsedSource::Local(local) => {
                    let base_dir = self.base_dir_for_scope(configured.scope);
                    self.resolve_local_extension_source(
                        &local.path,
                        accumulator,
                        configured.filter.as_ref(),
                        &mut metadata,
                        &base_dir,
                    );
                }
                ParsedSource::Npm(npm_source) => {
                    let installed_path =
                        self.npm_install_path_for_scope(npm_source, configured.scope);
                    let needs_install = !installed_path.exists()
                        || (npm_source.pinned
                            && !installed_npm_matches_pinned_version(npm_source, &installed_path));
                    if needs_install
                        && !self.install_missing(
                            &configured.source,
                            configured.scope,
                            &mut on_missing,
                        )?
                    {
                        continue;
                    }
                    metadata.base_dir = Some(installed_path.clone());
                    self.collect_package_resources(
                        &installed_path,
                        accumulator,
                        configured.filter.as_ref(),
                        &metadata,
                    );
                }
                ParsedSource::Git(git_source) => {
                    let installed_path = git::git_install_path(
                        git_source,
                        configured.scope,
                        self.cwd(),
                        self.agent_dir(),
                    );
                    if !installed_path.exists() {
                        if !self.install_missing(
                            &configured.source,
                            configured.scope,
                            &mut on_missing,
                        )? {
                            continue;
                        }
                    } else if configured.scope == SourceScope::Temporary
                        && !git_source.pinned
                        && !super::super::is_offline_mode_enabled()
                    {
                        self.refresh_temporary_git_source(git_source, &configured.source);
                    }
                    metadata.base_dir = Some(installed_path.clone());
                    self.collect_package_resources(
                        &installed_path,
                        accumulator,
                        configured.filter.as_ref(),
                        &metadata,
                    );
                }
            }
        }
        Ok(())
    }

    /// Install a missing configured source. False skips it (offline or the
    /// `skip` action); `error` actions fail resolution.
    fn install_missing(
        &mut self,
        source: &str,
        scope: SourceScope,
        on_missing: &mut Option<&mut dyn FnMut(&str) -> MissingSourceAction>,
    ) -> Result<bool> {
        if super::super::is_offline_mode_enabled() {
            return Ok(false);
        }
        if let Some(callback) = on_missing {
            match callback(source) {
                MissingSourceAction::Skip => return Ok(false),
                MissingSourceAction::Error => anyhow::bail!("Missing source: {source}"),
                MissingSourceAction::Install => {}
            }
        }
        let parsed = parse_source(source);
        match &parsed {
            ParsedSource::Npm(npm_source) => {
                let temporary = scope == SourceScope::Temporary;
                self.install_npm(npm_source, scope, temporary)?;
            }
            ParsedSource::Git(git_source) => {
                self.install_git_source(git_source, scope)?;
            }
            ParsedSource::Local(_) => {}
        }
        Ok(true)
    }

    /// A local package source: a file binds as one extension; a directory
    /// contributes its package resources (or binds as one extension when it
    /// provides none).
    fn resolve_local_extension_source(
        &self,
        path: &str,
        accumulator: &mut ResourceAccumulator,
        filter: Option<&PackageFilter>,
        metadata: &mut PathMetadata,
        base_dir: &Path,
    ) {
        let resolved = self.resolve_path_from_base(path, base_dir);
        if !resolved.exists() {
            return;
        }
        let Ok(stats) = std::fs::metadata(&resolved) else {
            return;
        };
        if stats.is_file() {
            metadata.base_dir = resolved.parent().map(Path::to_path_buf);
            accumulator
                .extensions
                .add(&resolved, metadata.clone(), true);
            return;
        }
        if stats.is_dir() {
            metadata.base_dir = Some(resolved.clone());
            let has_resources =
                self.collect_package_resources(&resolved, accumulator, filter, metadata);
            if !has_resources {
                accumulator
                    .extensions
                    .add(&resolved, metadata.clone(), true);
            }
        }
    }

    /// Settings top-level array entries: plain paths relative to the
    /// settings base, pattern entries applied as filters.
    fn resolve_local_entries(
        &self,
        entries: &[String],
        resource_type: ResourceType,
        accumulator: &mut ResourceAccumulator,
        metadata: PathMetadata,
        base_dir: &Path,
    ) {
        if entries.is_empty() {
            return;
        }
        let (plain, pattern_entries) = split_patterns(entries);
        let resolved_plain: Vec<PathBuf> = plain
            .iter()
            .map(|path| self.resolve_path_from_base(path, base_dir))
            .collect();
        let all_files = collect_files_from_paths(&resolved_plain, resource_type);
        let enabled_paths = apply_patterns(&all_files, &pattern_entries, base_dir);
        for file in all_files {
            let enabled = enabled_paths.contains(&file);
            accumulator
                .map(resource_type)
                .add(&file, metadata.clone(), enabled);
        }
    }

    pub(super) fn npm_install_path_for_scope(
        &self,
        source: &NpmSource,
        scope: SourceScope,
    ) -> PathBuf {
        let global_root = self.global_npm_root().unwrap_or_default();
        npm::npm_install_path(source, scope, self.cwd(), &global_root)
    }

    /// Refresh an unpinned temporary git source (the cached checkout is kept
    /// when the refresh fails).
    fn refresh_temporary_git_source(&mut self, source: &GitSource, source_str: &str) {
        let npm_command = self.settings_npm_command();
        let _ = self.with_progress(
            super::super::ProgressAction::Pull,
            source_str,
            &format!("Refreshing {source_str}..."),
            |manager| {
                git::update_git(
                    source,
                    SourceScope::Temporary,
                    manager.cwd(),
                    manager.agent_dir(),
                    npm_command.as_ref(),
                )
            },
        );
    }
}

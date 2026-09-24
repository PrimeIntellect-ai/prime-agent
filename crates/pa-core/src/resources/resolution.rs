//! Resource resolution wiring: the package manager resolves configured
//! packages, settings arrays, auto-discovery, and bundled skills; the loader
//! consumes the enabled paths (skills and prompts join the session). The
//! extension runner and theme loading are downstream seams.

use std::collections::HashSet;
use std::path::{Path, PathBuf};

use anyhow::Result;

use crate::resources::ResourceLoaderOptions;
use crate::settings::SettingsManager;

use crate::packages::PathMetadata;
use crate::packages::{
    MetadataSource, PackageManager, PackageManagerOptions, ResolveExtensionOptions, ResolvedPaths,
    ResolvedResource,
};
use crate::skills::{
    create_synthetic_source_info, SourceInfo as SkillSourceInfo, SourceOrigin as SkillSourceOrigin,
    SourceScope as SkillSourceScope,
};

/// Session-facing provenance for resolved paths, keyed by resolved path
/// (ordered: first entry wins, matching the TS metadata map).
pub(crate) type SourceInfoIndex = Vec<(String, SkillSourceInfo)>;

/// Build a session-facing provenance record from resolve metadata.
fn metadata_source_info(metadata: &PathMetadata, path: &Path) -> SkillSourceInfo {
    SkillSourceInfo {
        path: path.display().to_string(),
        source: metadata.source.source_label(),
        scope: match metadata.scope {
            crate::packages::SourceScope::User => SkillSourceScope::User,
            crate::packages::SourceScope::Project => SkillSourceScope::Project,
            crate::packages::SourceScope::Temporary => SkillSourceScope::Temporary,
        },
        origin: match metadata.origin {
            crate::packages::ResourceOrigin::Package => SkillSourceOrigin::Package,
            crate::packages::ResourceOrigin::TopLevel => SkillSourceOrigin::TopLevel,
        },
        base_dir: metadata
            .base_dir
            .as_ref()
            .map(|dir| dir.display().to_string()),
    }
}

/// Record provenance for every resolved resource path (first wins).
pub(crate) fn index_source_infos(index: &mut SourceInfoIndex, resources: &[ResolvedResource]) {
    for resource in resources {
        let key = resource.path.display().to_string();
        if !index.iter().any(|(existing, _)| existing == &key) {
            index.push((
                key,
                metadata_source_info(&resource.metadata, &resource.path),
            ));
        }
    }
}

/// CLI-sourced provenance (`source: "cli"`, temporary scope).
fn index_cli_source_infos(index: &mut SourceInfoIndex, resources: &[ResolvedResource]) {
    for resource in resources {
        let key = resource.path.display().to_string();
        if !index.iter().any(|(existing, _)| existing == &key) {
            index.push((
                key.clone(),
                create_synthetic_source_info(&key, "cli", SkillSourceScope::Temporary, None),
            ));
        }
    }
}

/// The resolved-path provenance of a loaded file: exact match, else the
/// nearest parent entry (a resource directory owns the files under it).
pub(crate) fn find_source_info(
    index: &SourceInfoIndex,
    file_path: &Path,
) -> Option<SkillSourceInfo> {
    let normalized = file_path.display().to_string();
    for (key, info) in index {
        if *key == normalized {
            return Some(SkillSourceInfo {
                path: normalized,
                ..info.clone()
            });
        }
    }
    for (key, info) in index {
        if normalized.starts_with(&format!("{key}/")) {
            return Some(SkillSourceInfo {
                path: normalized,
                ..info.clone()
            });
        }
    }
    None
}

/// Auto-discovered and package skill resources that point at a directory
/// resolve to its `SKILL.md` when present.
fn map_skill_path(resource: &ResolvedResource) -> PathBuf {
    let is_mappable = resource.metadata.source == MetadataSource::Auto
        || resource.metadata.origin == crate::packages::ResourceOrigin::Package;
    if !is_mappable {
        return resource.path.clone();
    }
    let Ok(meta) = std::fs::metadata(&resource.path) else {
        return resource.path.clone();
    };
    if !meta.is_dir() {
        return resource.path.clone();
    }
    let skill_file = resource.path.join("SKILL.md");
    if skill_file.exists() {
        return skill_file;
    }
    resource.path.clone()
}

/// Enabled paths of one resolved kind.
pub(crate) fn enabled_paths(resources: &[ResolvedResource]) -> Vec<PathBuf> {
    resources
        .iter()
        .filter(|resource| resource.enabled)
        .map(|resource| resource.path.clone())
        .collect()
}

/// Deduplicate by canonicalized path, preserving first-seen order.
pub(crate) fn merge_paths(primary: &[String], additional: &[String], cwd: &Path) -> Vec<String> {
    let mut merged: Vec<String> = Vec::new();
    let mut seen: HashSet<PathBuf> = HashSet::new();
    for entry in primary.iter().chain(additional) {
        let resolved = resolve_resource_path(entry, cwd);
        let canonical = crate::skills::loader::canonicalize_path(&resolved);
        if seen.insert(canonical) {
            merged.push(resolved.display().to_string());
        }
    }
    merged
}

/// Resolve a resource path: tilde expansion, then cwd-relative
/// absolutization.
fn resolve_resource_path(input: &str, cwd: &Path) -> PathBuf {
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
    if Path::new(trimmed).is_absolute() {
        return PathBuf::from(trimmed);
    }
    cwd.join(trimmed)
}

fn home_dir() -> PathBuf {
    pa_types::platform::home_dir().unwrap_or_else(|| PathBuf::from("."))
}

/// The full resolve step of resource loading: package-manager resolution
/// plus CLI extension sources, returning the resolved paths, the enabled
/// session paths (skills mapped to `SKILL.md`), and the provenance index.
pub(crate) struct ResolutionOutput {
    pub resolved: ResolvedPaths,
    pub skill_paths: Vec<String>,
    pub prompt_paths: Vec<String>,
    pub extension_paths: Vec<String>,
    pub source_infos: SourceInfoIndex,
}

fn as_strings(paths: &[PathBuf]) -> Vec<String> {
    paths
        .iter()
        .map(|path| path.display().to_string())
        .collect()
}

pub(crate) fn resolve_session_resources(
    options: &ResourceLoaderOptions,
    settings: SettingsManager,
) -> Result<ResolutionOutput> {
    let mut manager = PackageManager::with_options(PackageManagerOptions {
        cwd: options.cwd.clone(),
        agent_dir: options.agent_dir.clone(),
        settings,
        bundled_skills_dir: options.bundled_skills_dir.clone(),
        extra_builtin_skill_overrides: options.extra_builtin_skill_overrides.clone(),
    });
    let resolved = manager.resolve()?;
    let cli = manager.resolve_extension_sources(
        &options.additional_extension_sources,
        ResolveExtensionOptions {
            temporary: true,
            ..Default::default()
        },
    )?;

    let mut source_infos: SourceInfoIndex = Vec::new();
    index_source_infos(&mut source_infos, &resolved.skills);
    index_source_infos(&mut source_infos, &resolved.prompts);
    index_source_infos(&mut source_infos, &resolved.themes);
    index_source_infos(&mut source_infos, &resolved.extensions);
    index_cli_source_infos(&mut source_infos, &cli.skills);
    index_cli_source_infos(&mut source_infos, &cli.extensions);

    let cli_skills = as_strings(&enabled_paths(&cli.skills));
    let cli_prompts = as_strings(&enabled_paths(&cli.prompts));
    let enabled_prompts = as_strings(&enabled_paths(&resolved.prompts));
    let enabled_skills: Vec<String> = resolved
        .skills
        .iter()
        .filter(|resource| resource.enabled)
        .map(map_skill_path)
        .map(|path| path.display().to_string())
        .collect();

    let prompt_paths = if options.no_prompt_templates {
        merge_paths(&cli_prompts, &options.additional_prompt_paths, &options.cwd)
    } else {
        let primary = [cli_prompts, enabled_prompts].concat();
        merge_paths(&primary, &options.additional_prompt_paths, &options.cwd)
    };

    let skill_paths = if options.no_skills {
        merge_paths(&cli_skills, &options.additional_skill_paths, &options.cwd)
    } else {
        let primary = [
            cli_skills,
            options.additional_skill_paths.clone(),
            enabled_skills,
        ]
        .concat();
        merge_paths(&primary, &[], &options.cwd)
    };

    let extension_paths = merge_paths(
        &as_strings(&enabled_paths(&cli.extensions)),
        &as_strings(&enabled_paths(&resolved.extensions)),
        &options.cwd,
    );

    Ok(ResolutionOutput {
        resolved,
        skill_paths,
        prompt_paths,
        extension_paths,
        source_infos,
    })
}

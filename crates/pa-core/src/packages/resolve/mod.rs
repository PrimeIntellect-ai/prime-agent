//! Session resource resolution (`resolve()`): precedence-ranked collection of
//! extension/skill/prompt/theme paths from configured packages (pi manifest,
//! convention directories, filter patterns), settings top-level arrays, and
//! auto-discovery (settings-base directories, `.agents/skills` ancestor
//! scan, bundled skills).
//!
//! Name collisions resolve first-wins downstream: consumers receive entries
//! ordered by [`resource_precedence_rank`] (project settings > project auto >
//! user settings > user auto > package > builtin) and deduplicated by
//! canonicalized path.

pub(crate) mod auto;
pub(crate) mod collect;
pub(crate) mod discovery;
pub(crate) mod manager;
pub(crate) mod patterns;

#[cfg(test)]
pub(crate) mod tests;

use std::path::PathBuf;

use super::SourceScope;

/// The four session resource kinds a package can provide.
#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord)]
pub enum ResourceType {
    Extensions,
    Skills,
    Prompts,
    Themes,
}

pub(crate) const RESOURCE_TYPES: [ResourceType; 4] = [
    ResourceType::Extensions,
    ResourceType::Skills,
    ResourceType::Prompts,
    ResourceType::Themes,
];

/// Where a resource came from: a package, or a top-level settings/auto slot.
#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord)]
pub enum ResourceOrigin {
    Package,
    TopLevel,
}

/// Resource provenance: `local` settings entries, `auto` discovery,
/// `builtin` bundled skills, or a configured package source string.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum MetadataSource {
    Local,
    Auto,
    Builtin,
    Package(String),
}

impl MetadataSource {
    /// The `source` label of a `SourceInfo` (the raw package source string
    /// for package resources).
    pub(crate) fn source_label(&self) -> String {
        match self {
            MetadataSource::Local => "local".to_string(),
            MetadataSource::Auto => "auto".to_string(),
            MetadataSource::Builtin => "builtin".to_string(),
            MetadataSource::Package(source) => source.clone(),
        }
    }
}

/// Provenance carried with every resolved path.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct PathMetadata {
    pub source: MetadataSource,
    pub scope: SourceScope,
    pub origin: ResourceOrigin,
    pub base_dir: Option<PathBuf>,
}

/// One resolved resource: a path, its enablement, and its provenance.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ResolvedResource {
    pub path: PathBuf,
    pub enabled: bool,
    pub metadata: PathMetadata,
}

/// The resolve() output: ranked resources per kind plus diagnostics.
#[derive(Debug, Clone, Default, PartialEq)]
pub struct ResolvedPaths {
    pub extensions: Vec<ResolvedResource>,
    pub skills: Vec<ResolvedResource>,
    pub prompts: Vec<ResolvedResource>,
    pub themes: Vec<ResolvedResource>,
    pub diagnostics: Vec<crate::skills::diagnostics::ResourceDiagnostic>,
}

/// Response to a missing configured package source during resolution.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum MissingSourceAction {
    Install,
    Skip,
    Error,
}

/// Options for [`crate::packages::PackageManager::resolve_extension_sources`]:
/// `local` puts sources in project scope; `temporary` uses the ephemeral
/// resolve-only scope (never persisted).
#[derive(Debug, Clone, Copy, Default)]
pub struct ResolveExtensionOptions {
    pub local: bool,
    pub temporary: bool,
}

/// Lower rank = higher precedence: project settings (0), project auto (1),
/// user settings (2), user auto (3), package (4), builtin (5).
pub(crate) fn resource_precedence_rank(metadata: &PathMetadata) -> u8 {
    match metadata.source {
        MetadataSource::Builtin => 5,
        _ if metadata.origin == ResourceOrigin::Package => 4,
        _ => {
            let scope_base = u8::from(metadata.scope != SourceScope::Project) * 2;
            scope_base + u8::from(metadata.source != MetadataSource::Local)
        }
    }
}

/// Per-kind filter patterns of a package entry (the object form of a
/// `packages` settings entry). An explicit empty list disables the kind.
#[derive(Debug, Clone, Default)]
pub(crate) struct PackageFilter {
    pub extensions: Option<Vec<String>>,
    pub skills: Option<Vec<String>>,
    pub prompts: Option<Vec<String>>,
    pub themes: Option<Vec<String>>,
}

impl PackageFilter {
    fn get(&self, resource_type: ResourceType) -> Option<&Vec<String>> {
        match resource_type {
            ResourceType::Extensions => self.extensions.as_ref(),
            ResourceType::Skills => self.skills.as_ref(),
            ResourceType::Prompts => self.prompts.as_ref(),
            ResourceType::Themes => self.themes.as_ref(),
        }
    }
}

/// One configured package source plus its scope and filter patterns.
pub(crate) struct ConfiguredSource {
    pub source: String,
    pub scope: SourceScope,
    pub filter: Option<PackageFilter>,
}

/// The `pi` manifest in a package's `package.json` (parse failures are no
/// manifest, per the TS product).
#[derive(Debug, Default)]
pub(crate) struct PiManifest {
    pub extensions: Option<Vec<String>>,
    pub skills: Option<Vec<String>>,
    pub prompts: Option<Vec<String>>,
    pub themes: Option<Vec<String>>,
}

impl PiManifest {
    pub(crate) fn entries(&self, resource_type: ResourceType) -> Option<Vec<String>> {
        match resource_type {
            ResourceType::Extensions => self.extensions.clone(),
            ResourceType::Skills => self.skills.clone(),
            ResourceType::Prompts => self.prompts.clone(),
            ResourceType::Themes => self.themes.clone(),
        }
    }
}

/// Insertion-ordered map of resolved paths (first insert wins per path).
#[derive(Default)]
pub(crate) struct ResourceMap {
    entries: Vec<(PathBuf, PathMetadata, bool)>,
    index: std::collections::HashMap<PathBuf, usize>,
}

impl ResourceMap {
    pub(crate) fn add(&mut self, path: &std::path::Path, metadata: PathMetadata, enabled: bool) {
        if path.as_os_str().is_empty() || self.index.contains_key(path) {
            return;
        }
        self.index.insert(path.to_path_buf(), self.entries.len());
        self.entries.push((path.to_path_buf(), metadata, enabled));
    }

    pub(crate) fn iter(&self) -> impl Iterator<Item = (&PathBuf, &PathMetadata, bool)> {
        self.entries
            .iter()
            .map(|(path, metadata, enabled)| (path, metadata, *enabled))
    }
}

/// Per-kind accumulators plus diagnostics, assembled into
/// [`ResolvedPaths`] at the end of resolution.
#[derive(Default)]
pub(crate) struct ResourceAccumulator {
    pub extensions: ResourceMap,
    pub skills: ResourceMap,
    pub prompts: ResourceMap,
    pub themes: ResourceMap,
    pub diagnostics: Vec<crate::skills::diagnostics::ResourceDiagnostic>,
}

impl ResourceAccumulator {
    pub(crate) fn map(&mut self, resource_type: ResourceType) -> &mut ResourceMap {
        match resource_type {
            ResourceType::Extensions => &mut self.extensions,
            ResourceType::Skills => &mut self.skills,
            ResourceType::Prompts => &mut self.prompts,
            ResourceType::Themes => &mut self.themes,
        }
    }
}

/// Rank, then dedupe by canonicalized path (first wins per rank tier).
pub(crate) fn to_resolved_paths(accumulator: ResourceAccumulator) -> ResolvedPaths {
    let map_to_resolved = |map: ResourceMap| -> Vec<ResolvedResource> {
        let mut resolved: Vec<ResolvedResource> = map
            .iter()
            .map(|(path, metadata, enabled)| ResolvedResource {
                path: path.clone(),
                enabled,
                metadata: metadata.clone(),
            })
            .collect();
        resolved.sort_by_key(|resource| resource_precedence_rank(&resource.metadata));
        let mut seen = std::collections::HashSet::new();
        resolved
            .into_iter()
            .filter(|resource| {
                let canonical = crate::skills::loader::canonicalize_path(&resource.path);
                seen.insert(canonical)
            })
            .collect()
    };

    ResolvedPaths {
        extensions: map_to_resolved(accumulator.extensions),
        skills: map_to_resolved(accumulator.skills),
        prompts: map_to_resolved(accumulator.prompts),
        themes: map_to_resolved(accumulator.themes),
        diagnostics: accumulator.diagnostics,
    }
}

/// The settings-array form of a resource kind (settings top-level arrays
/// hold plain paths and/or pattern entries).
pub(crate) fn settings_array(
    settings: &crate::settings::Settings,
    resource_type: ResourceType,
) -> Vec<String> {
    match resource_type {
        ResourceType::Extensions => settings.extensions.clone().unwrap_or_default(),
        ResourceType::Skills => settings.skills.clone().unwrap_or_default(),
        ResourceType::Prompts => settings.prompts.clone().unwrap_or_default(),
        ResourceType::Themes => settings.themes.clone().unwrap_or_default(),
    }
}

pub(crate) fn resource_type_dir_name(resource_type: ResourceType) -> &'static str {
    match resource_type {
        ResourceType::Extensions => "extensions",
        ResourceType::Skills => "skills",
        ResourceType::Prompts => "prompts",
        ResourceType::Themes => "themes",
    }
}

/// Metadata for a settings/auto top-level resource.
pub(crate) fn top_level_metadata(source: MetadataSource, scope: SourceScope) -> PathMetadata {
    PathMetadata {
        source,
        scope,
        origin: ResourceOrigin::TopLevel,
        base_dir: None,
    }
}

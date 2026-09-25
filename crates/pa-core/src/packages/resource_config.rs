//! Resource configuration (TS `config-selector.ts` data layer): the grouped
//! view of every resolved extension/skill/prompt/theme and the settings
//! mutation that flips one resource's enablement. The UI lives in pa-tui /
//! pa-cli; this module owns the grouping rules and the settings writes.

use std::path::{Path, PathBuf};

use anyhow::Result;

use super::resolve::{
    MetadataSource, PathMetadata, ResolvedPaths, ResolvedResource, ResourceOrigin, ResourceType,
};
use super::SourceScope;
use crate::settings::SettingsManager;

/// One resource row: path, enablement, provenance, and display naming.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ResourceItem {
    pub path: PathBuf,
    pub enabled: bool,
    pub metadata: PathMetadata,
    pub resource_type: ResourceType,
    pub display_name: String,
    pub group_key: String,
    pub subgroup_key: String,
}

/// The resources of one kind inside a group (TS `ResourceSubgroup`).
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ResourceSubgroup {
    pub resource_type: ResourceType,
    pub label: &'static str,
    pub items: Vec<ResourceItem>,
}

/// One origin/scope/source bucket (TS `ResourceGroup`).
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ResourceGroup {
    pub key: String,
    pub label: String,
    pub scope: SourceScope,
    pub origin: ResourceOrigin,
    pub source: MetadataSource,
    pub subgroups: Vec<ResourceSubgroup>,
}

/// The subgroup label for one resource kind (TS `RESOURCE_TYPE_LABELS`).
pub fn resource_type_label(resource_type: ResourceType) -> &'static str {
    match resource_type {
        ResourceType::Extensions => "Extensions",
        ResourceType::Skills => "Skills",
        ResourceType::Prompts => "Prompts",
        ResourceType::Themes => "Themes",
    }
}

/// The group heading for one provenance (TS `getGroupLabel`).
fn group_label(metadata: &PathMetadata) -> String {
    if metadata.origin == ResourceOrigin::Package {
        return format!(
            "{} ({})",
            metadata.source.source_label(),
            scope_word(metadata.scope)
        );
    }
    match metadata.source {
        MetadataSource::Builtin => "Built-in".to_string(),
        MetadataSource::Auto => {
            if metadata.scope == SourceScope::Project {
                format!("Project ({})", crate::settings::CONFIG_DIR_NAME)
            } else {
                format!("User (~/{}/)", crate::settings::CONFIG_DIR_NAME)
            }
        }
        _ => {
            if metadata.scope == SourceScope::Project {
                "Project settings".to_string()
            } else {
                "User settings".to_string()
            }
        }
    }
}

fn scope_word(scope: SourceScope) -> &'static str {
    match scope {
        SourceScope::Project => "project",
        _ => "user",
    }
}

/// The display name of one resource path (TS naming rules): extensions keep
/// their parent folder when it is not the conventional one, skills named by
/// their SKILL.md use the folder, everything else shows the file name.
fn display_name(path: &Path, resource_type: ResourceType) -> String {
    let file_name = path
        .file_name()
        .map(|name| name.to_string_lossy().to_string())
        .unwrap_or_default();
    let parent_folder = path
        .parent()
        .and_then(|parent| parent.file_name())
        .map(|name| name.to_string_lossy().to_string())
        .unwrap_or_default();
    if resource_type == ResourceType::Extensions && parent_folder != "extensions" {
        return format!("{parent_folder}/{file_name}");
    }
    if resource_type == ResourceType::Skills && file_name == "SKILL.md" {
        return parent_folder;
    }
    file_name
}

/// The grouped view of a full resolution (TS `buildGroups`): items grouped by
/// origin/scope/source, subgroups per resource kind in
/// extensions/skills/prompts/themes order, items sorted by display name.
pub fn build_groups(resolved: &ResolvedPaths) -> Vec<ResourceGroup> {
    let mut groups: Vec<ResourceGroup> = Vec::new();
    let mut add = |resource: &ResolvedResource, resource_type: ResourceType| {
        let group_key = format!(
            "{:?}:{:?}:{}",
            resource.metadata.origin,
            resource.metadata.scope,
            resource.metadata.source.source_label()
        );
        let index = groups
            .iter()
            .position(|group| group.key == group_key)
            .unwrap_or_else(|| {
                groups.push(ResourceGroup {
                    key: group_key.clone(),
                    label: group_label(&resource.metadata),
                    scope: resource.metadata.scope,
                    origin: resource.metadata.origin,
                    source: resource.metadata.source.clone(),
                    subgroups: Vec::new(),
                });
                groups.len() - 1
            });
        let subgroup_key = format!("{group_key}:{resource_type:?}");
        let group = &mut groups[index];
        let subgroup_index = group
            .subgroups
            .iter()
            .position(|subgroup| subgroup.resource_type == resource_type)
            .unwrap_or_else(|| {
                group.subgroups.push(ResourceSubgroup {
                    resource_type,
                    label: resource_type_label(resource_type),
                    items: Vec::new(),
                });
                group.subgroups.len() - 1
            });
        group.subgroups[subgroup_index].items.push(ResourceItem {
            path: resource.path.clone(),
            enabled: resource.enabled,
            metadata: resource.metadata.clone(),
            resource_type,
            display_name: display_name(&resource.path, resource_type),
            group_key,
            subgroup_key,
        });
    };
    for resource in &resolved.extensions {
        add(resource, ResourceType::Extensions);
    }
    for resource in &resolved.skills {
        add(resource, ResourceType::Skills);
    }
    for resource in &resolved.prompts {
        add(resource, ResourceType::Prompts);
    }
    for resource in &resolved.themes {
        add(resource, ResourceType::Themes);
    }
    // Groups: packages first, then user before project, then source label.
    // Enum declaration order gives the TS ordering: packages before
    // top-level sources, user before project.
    groups.sort_by(|a, b| {
        a.origin
            .cmp(&b.origin)
            .then_with(|| a.scope.cmp(&b.scope))
            .then_with(|| a.source.source_label().cmp(&b.source.source_label()))
    });
    for group in &mut groups {
        group
            .subgroups
            .sort_by_key(|subgroup| subgroup.resource_type);
        for subgroup in &mut group.subgroups {
            subgroup
                .items
                .sort_by(|a, b| a.display_name.cmp(&b.display_name));
        }
    }
    groups
}

/// Flip one resource's enablement in the settings store (TS
/// `toggleResource`): top-level resources get `+pattern`/`-pattern`
/// entries in their scope's resource array, package resources get filter
/// entries on their package's object form. Returns the written pattern.
///
/// # Errors
///
/// Returns an error when the settings update or save for the toggle fails.
pub fn toggle_resource(
    settings: &mut SettingsManager,
    cwd: &Path,
    agent_dir: &Path,
    item: &ResourceItem,
    enabled: bool,
) -> Result<String> {
    match item.metadata.origin {
        ResourceOrigin::TopLevel => toggle_top_level(settings, cwd, agent_dir, item, enabled),
        ResourceOrigin::Package => toggle_package_resource(settings, item, enabled),
    }
}

fn toggle_top_level(
    settings: &mut SettingsManager,
    cwd: &Path,
    agent_dir: &Path,
    item: &ResourceItem,
    enabled: bool,
) -> Result<String> {
    let project = item.metadata.scope == SourceScope::Project;
    let pattern = top_level_pattern(cwd, agent_dir, item);
    let disable = format!("-{pattern}");
    let enable = format!("+{pattern}");
    let existing = |settings: &SettingsManager| -> Vec<String> {
        let scope = if project {
            settings.project_settings()
        } else {
            settings.global_settings()
        };
        resource_array(scope, item.resource_type)
            .unwrap_or_default()
            .to_vec()
    };
    let mut updated: Vec<String> = existing(settings)
        .into_iter()
        .filter(|entry| strip_pattern_marker(entry) != pattern)
        .collect();
    let written = if enabled { enable } else { disable };
    updated.push(written.clone());
    write_resource_array(settings, project, item.resource_type, updated);
    Ok(written)
}

/// The settings-array pattern for a top-level resource: relative to the
/// scope's base directory, with built-ins keyed off their package dir (TS
/// `getResourcePattern`).
fn top_level_pattern(cwd: &Path, agent_dir: &Path, item: &ResourceItem) -> String {
    let base = if item.metadata.source == MetadataSource::Builtin {
        item.metadata
            .base_dir
            .as_deref()
            .unwrap_or_else(|| item.path.parent().unwrap_or(Path::new("")))
            .to_path_buf()
    } else if item.metadata.scope == SourceScope::Project {
        cwd.join(crate::settings::CONFIG_DIR_NAME)
    } else {
        agent_dir.to_path_buf()
    };
    relative_path(&base, &item.path)
}

fn toggle_package_resource(
    settings: &mut SettingsManager,
    item: &ResourceItem,
    enabled: bool,
) -> Result<String> {
    let project = item.metadata.scope == SourceScope::Project;
    let scope = if project {
        settings.project_settings()
    } else {
        settings.global_settings()
    };
    let packages = scope.packages.clone().unwrap_or_default();
    let source = item.metadata.source.source_label();
    let index = packages.iter().position(|entry| {
        entry
            .get("source")
            .and_then(serde_json::Value::as_str)
            .map_or_else(
                || entry.as_str() == Some(source.as_str()),
                |entry_source| entry_source == source,
            )
    });
    let Some(index) = index else {
        return Ok(String::new());
    };
    let mut entry = packages[index].clone();
    if entry.is_string() {
        entry = serde_json::json!({ "source": source });
    }
    let base = item
        .metadata
        .base_dir
        .clone()
        .unwrap_or_else(|| item.path.parent().unwrap_or(Path::new("")).to_path_buf());
    let pattern = relative_path(&base, &item.path);
    let array_key = resource_array_key(item.resource_type);
    let current = entry
        .get(array_key)
        .and_then(serde_json::Value::as_array)
        .cloned()
        .unwrap_or_default();
    let mut updated: Vec<serde_json::Value> = current
        .into_iter()
        .filter(|value| {
            value
                .as_str()
                .is_none_or(|entry| strip_pattern_marker(entry) != pattern)
        })
        .collect();
    let written = if enabled {
        format!("+{pattern}")
    } else {
        format!("-{pattern}")
    };
    updated.push(serde_json::Value::String(written.clone()));
    if let Some(object) = entry.as_object_mut() {
        object.insert(array_key.to_string(), serde_json::Value::Array(updated));
        let has_filters = ["extensions", "skills", "prompts", "themes"]
            .iter()
            .any(|key| object.contains_key(*key));
        if !has_filters {
            // A filter-less package collapses back to its source string.
            entry = serde_json::Value::String(source);
        }
    }
    let mut updated_packages = packages;
    updated_packages[index] = entry;
    if project {
        settings.set_project_packages(updated_packages);
    } else {
        settings.set_packages(updated_packages);
    }
    Ok(written)
}

fn resource_array(
    scope: &crate::settings::Settings,
    resource_type: ResourceType,
) -> Option<&[String]> {
    match resource_type {
        ResourceType::Extensions => scope.extensions.as_deref(),
        ResourceType::Skills => scope.skills.as_deref(),
        ResourceType::Prompts => scope.prompts.as_deref(),
        ResourceType::Themes => scope.themes.as_deref(),
    }
}

fn resource_array_key(resource_type: ResourceType) -> &'static str {
    match resource_type {
        ResourceType::Extensions => "extensions",
        ResourceType::Skills => "skills",
        ResourceType::Prompts => "prompts",
        ResourceType::Themes => "themes",
    }
}

/// Replace one scope's resource-path array in the settings store.
fn write_resource_array(
    settings: &mut SettingsManager,
    project: bool,
    resource_type: ResourceType,
    values: Vec<String>,
) {
    let field = resource_array_key(resource_type);
    if project {
        settings.set_project_resource_array(field, values);
    } else {
        settings.set_global_resource_array(field, values);
    }
}

/// Strip the enable/disable marker from one settings pattern entry.
fn strip_pattern_marker(entry: &str) -> &str {
    entry
        .strip_prefix('!')
        .or_else(|| entry.strip_prefix('+'))
        .or_else(|| entry.strip_prefix('-'))
        .unwrap_or(entry)
}

/// `path.relative(base, target)` for absolute-or-cwd-relative paths: the
/// shared prefix is dropped, remaining base components become `..`.
fn relative_path(base: &Path, target: &Path) -> String {
    let base_components: Vec<std::path::Component> = base.components().collect();
    let target_components: Vec<std::path::Component> = target.components().collect();
    let mut shared = 0usize;
    while shared < base_components.len()
        && shared < target_components.len()
        && base_components[shared] == target_components[shared]
    {
        shared += 1;
    }
    let mut parts: Vec<String> = Vec::new();
    for _ in shared..base_components.len() {
        parts.push("..".to_string());
    }
    for component in &target_components[shared..] {
        parts.push(component.as_os_str().to_string_lossy().to_string());
    }
    if parts.is_empty() {
        return ".".to_string();
    }
    parts.join("/")
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::packages::resolve::{ResolvedResource, RESOURCE_TYPES};

    fn metadata(
        source: MetadataSource,
        scope: SourceScope,
        origin: ResourceOrigin,
        base_dir: Option<PathBuf>,
    ) -> PathMetadata {
        PathMetadata {
            source,
            scope,
            origin,
            base_dir,
        }
    }

    fn resource(path: &str, metadata: PathMetadata, enabled: bool) -> ResolvedResource {
        ResolvedResource {
            path: PathBuf::from(path),
            enabled,
            metadata,
        }
    }

    fn resolved(items: Vec<ResolvedResource>) -> ResolvedPaths {
        let mut paths = ResolvedPaths::default();
        for item in items {
            match RESOURCE_TYPES
                .iter()
                .find(|kind| {
                    let is_skill = **kind == ResourceType::Skills;
                    is_skill == item.path.to_string_lossy().contains("skill")
                        || (!is_skill && item.path.extension().is_some_and(|e| e == "ts"))
                })
                .copied()
                .unwrap_or(ResourceType::Skills)
            {
                ResourceType::Extensions => paths.extensions.push(item),
                ResourceType::Skills => paths.skills.push(item),
                ResourceType::Prompts => paths.prompts.push(item),
                ResourceType::Themes => paths.themes.push(item),
            }
        }
        paths
    }

    #[test]
    fn groups_follow_ts_ordering_and_labels() {
        let paths = resolved(vec![
            resource(
                "/agent/skills/builtin/websearch/SKILL.md",
                metadata(
                    MetadataSource::Builtin,
                    SourceScope::User,
                    ResourceOrigin::TopLevel,
                    Some(PathBuf::from("/exe/skills")),
                ),
                true,
            ),
            resource(
                "/agent/skills/user-skill/SKILL.md",
                metadata(
                    MetadataSource::Auto,
                    SourceScope::User,
                    ResourceOrigin::TopLevel,
                    None,
                ),
                true,
            ),
            resource(
                "/work/.prime/agent/extensions/ext.ts",
                metadata(
                    MetadataSource::Local,
                    SourceScope::Project,
                    ResourceOrigin::TopLevel,
                    None,
                ),
                false,
            ),
            resource(
                "/work/.prime/agent/skills/project-skill/SKILL.md",
                metadata(
                    MetadataSource::Local,
                    SourceScope::Project,
                    ResourceOrigin::TopLevel,
                    None,
                ),
                true,
            ),
            resource(
                "/installed/pkg/skills/pack-skill/SKILL.md",
                metadata(
                    MetadataSource::Package("npm:foo/bar".to_string()),
                    SourceScope::User,
                    ResourceOrigin::Package,
                    Some(PathBuf::from("/installed/pkg")),
                ),
                true,
            ),
        ]);
        let groups = build_groups(&paths);
        let labels: Vec<&str> = groups.iter().map(|group| group.label.as_str()).collect();
        // Packages first, then user before project.
        // Top-level groups of equal scope order by their source string, so
        // the `auto` group precedes `builtin` (TS localeCompare order).
        assert_eq!(
            labels,
            vec![
                "npm:foo/bar (user)",
                "User (~/.prime/agent/)",
                "Built-in",
                "Project settings"
            ]
        );
        let package_group = &groups[0];
        assert_eq!(package_group.subgroups[0].label, "Skills");
        assert_eq!(
            package_group.subgroups[0].items[0].display_name,
            "pack-skill"
        );
        let project_group = groups.last().unwrap();
        // Subgroups order by kind; items by display name.
        let kinds: Vec<&str> = project_group
            .subgroups
            .iter()
            .map(|subgroup| subgroup.label)
            .collect();
        assert_eq!(kinds, vec!["Extensions", "Skills"]);
        assert_eq!(project_group.subgroups[0].items[0].display_name, "ext.ts");
    }

    #[test]
    fn extension_display_names_keep_their_parent_folder() {
        let item = resource(
            "/work/.prime/agent/extensions/my-ext/index.ts",
            metadata(
                MetadataSource::Local,
                SourceScope::Project,
                ResourceOrigin::TopLevel,
                None,
            ),
            true,
        );
        assert_eq!(
            display_name(&item.path, ResourceType::Extensions),
            "my-ext/index.ts"
        );
    }

    fn settings_fixture() -> (tempfile::TempDir, SettingsManager) {
        let root = tempfile::tempdir().unwrap();
        let agent_dir = root.path().join("agent");
        std::fs::create_dir_all(&agent_dir).unwrap();
        let cwd = root.path().join("work");
        std::fs::create_dir_all(&cwd).unwrap();
        let settings = SettingsManager::create(&cwd, &agent_dir);
        (root, settings)
    }

    fn user_skill_item(root: &Path) -> ResourceItem {
        ResourceItem {
            path: root
                .join("agent")
                .join("skills")
                .join("my-skill")
                .join("SKILL.md"),
            enabled: true,
            metadata: metadata(
                MetadataSource::Auto,
                SourceScope::User,
                ResourceOrigin::TopLevel,
                None,
            ),
            resource_type: ResourceType::Skills,
            display_name: "my-skill".to_string(),
            group_key: String::new(),
            subgroup_key: String::new(),
        }
    }

    #[test]
    fn toggling_a_user_skill_writes_the_disable_then_enable_pattern() {
        let (root, mut settings) = settings_fixture();
        let cwd = root.path().join("work");
        let agent_dir = root.path().join("agent");
        let item = user_skill_item(root.path());
        let written = toggle_resource(&mut settings, &cwd, &agent_dir, &item, false).unwrap();
        assert_eq!(written, "-skills/my-skill/SKILL.md");
        assert_eq!(
            settings.global_settings().skills,
            Some(vec!["-skills/my-skill/SKILL.md".to_string()])
        );
        // Toggling back replaces the disable pattern with the enable one.
        let written = toggle_resource(&mut settings, &cwd, &agent_dir, &item, true).unwrap();
        assert_eq!(written, "+skills/my-skill/SKILL.md");
        assert_eq!(
            settings.global_settings().skills,
            Some(vec!["+skills/my-skill/SKILL.md".to_string()])
        );
    }

    #[test]
    fn toggling_a_bundled_skill_keys_off_the_bundled_dir() {
        let (root, mut settings) = settings_fixture();
        let cwd = root.path().join("work");
        let agent_dir = root.path().join("agent");
        let mut item = user_skill_item(root.path());
        item.metadata.source = MetadataSource::Builtin;
        item.metadata.base_dir = Some(PathBuf::from("/exe/skills"));
        item.path = PathBuf::from("/exe/skills/websearch/SKILL.md");
        let written = toggle_resource(&mut settings, &cwd, &agent_dir, &item, false).unwrap();
        assert_eq!(written, "-websearch/SKILL.md");
    }

    #[test]
    fn toggling_a_project_resource_writes_the_project_scope() {
        let (root, mut settings) = settings_fixture();
        let cwd = root.path().join("work");
        let agent_dir = root.path().join("agent");
        let mut item = user_skill_item(root.path());
        item.metadata.scope = SourceScope::Project;
        item.path = cwd
            .join(crate::settings::CONFIG_DIR_NAME)
            .join("skills")
            .join("p-skill")
            .join("SKILL.md");
        let written = toggle_resource(&mut settings, &cwd, &agent_dir, &item, true).unwrap();
        assert_eq!(written, "+skills/p-skill/SKILL.md");
        assert_eq!(
            settings.project_settings().skills,
            Some(vec!["+skills/p-skill/SKILL.md".to_string()])
        );
    }

    #[test]
    fn toggling_a_package_resource_writes_a_filter_entry() {
        let (root, mut settings) = settings_fixture();
        let cwd = root.path().join("work");
        let agent_dir = root.path().join("agent");
        settings.set_packages(vec![serde_json::json!("npm:foo/bar")]);
        let item = ResourceItem {
            path: PathBuf::from("/installed/pkg/skills/pack-skill/SKILL.md"),
            enabled: true,
            metadata: metadata(
                MetadataSource::Package("npm:foo/bar".to_string()),
                SourceScope::User,
                ResourceOrigin::Package,
                Some(PathBuf::from("/installed/pkg")),
            ),
            resource_type: ResourceType::Skills,
            display_name: "pack-skill".to_string(),
            group_key: String::new(),
            subgroup_key: String::new(),
        };
        let written = toggle_resource(&mut settings, &cwd, &agent_dir, &item, false).unwrap();
        assert_eq!(written, "-skills/pack-skill/SKILL.md");
        assert_eq!(
            settings.global_settings().packages,
            Some(vec![serde_json::json!({
                "source": "npm:foo/bar",
                "skills": ["-skills/pack-skill/SKILL.md"],
            })])
        );
    }

    #[test]
    fn relative_paths_match_ts_semantics() {
        assert_eq!(
            relative_path(Path::new("/a/b"), Path::new("/a/b/c/d.md")),
            "c/d.md"
        );
        assert_eq!(
            relative_path(Path::new("/a/b"), Path::new("/a/x/d.md")),
            "../x/d.md"
        );
        assert_eq!(relative_path(Path::new("/a"), Path::new("/a")), ".");
    }
}

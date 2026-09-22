//! Auto-discovery of session resources: the settings-base convention
//! directories, the `.agents/skills` ancestor scan, and bundled skills
//! with their builtin-override exclusion patterns.

use std::path::{Path, PathBuf};

use super::super::PackageManager;
use super::discovery::{
    collect_ancestor_agents_skill_dirs, collect_auto_extension_entries,
    collect_auto_prompt_entries, collect_auto_theme_entries, collect_skill_entries,
    SkillDiscoveryMode,
};
use super::patterns::is_enabled_by_overrides;
use super::{
    resource_type_dir_name, settings_array, MetadataSource, PathMetadata, ResourceAccumulator,
    ResourceOrigin, ResourceType, RESOURCE_TYPES,
};
use crate::settings::Settings;
use crate::skills::diagnostics::ResourceDiagnostic;

fn home_dir() -> PathBuf {
    pa_types::platform::home_dir().unwrap_or_else(|| PathBuf::from("."))
}

impl PackageManager {
    /// Add settings-base convention directories (project first), the
    /// `.agents/skills` ancestor scan, and the bundled built-in skills.
    pub(super) fn add_auto_discovered_resources(
        &self,
        accumulator: &mut ResourceAccumulator,
        global: &Settings,
        project: &Settings,
        global_base_dir: &Path,
        project_base_dir: &Path,
    ) {
        let user_metadata = PathMetadata {
            source: MetadataSource::Auto,
            scope: super::super::SourceScope::User,
            origin: ResourceOrigin::TopLevel,
            base_dir: Some(global_base_dir.to_path_buf()),
        };
        let project_metadata = PathMetadata {
            source: MetadataSource::Auto,
            scope: super::super::SourceScope::Project,
            origin: ResourceOrigin::TopLevel,
            base_dir: Some(project_base_dir.to_path_buf()),
        };
        let user_overrides =
            RESOURCE_TYPES.map(|resource_type| settings_array(global, resource_type));
        let project_overrides =
            RESOURCE_TYPES.map(|resource_type| settings_array(project, resource_type));
        let project_dirs = RESOURCE_TYPES
            .map(|resource_type| project_base_dir.join(resource_type_dir_name(resource_type)));
        let user_dirs = RESOURCE_TYPES
            .map(|resource_type| global_base_dir.join(resource_type_dir_name(resource_type)));
        let user_agents_skills_dir = home_dir().join(".agents").join("skills");
        let project_agents_skill_dirs = collect_ancestor_agents_skill_dirs(self.cwd())
            .into_iter()
            .filter(|dir| *dir != user_agents_skills_dir)
            .collect::<Vec<PathBuf>>();

        let add_resources = |accumulator: &mut ResourceAccumulator,
                             resource_type: ResourceType,
                             paths: Vec<PathBuf>,
                             metadata: &PathMetadata,
                             overrides: &[String],
                             base_dir: &Path| {
            for path in paths {
                let enabled = is_enabled_by_overrides(&path, overrides, base_dir);
                accumulator
                    .map(resource_type)
                    .add(&path, metadata.clone(), enabled);
            }
        };

        add_resources(
            accumulator,
            ResourceType::Extensions,
            collect_auto_extension_entries(&project_dirs[0]),
            &project_metadata,
            &project_overrides[0],
            project_base_dir,
        );
        add_resources(
            accumulator,
            ResourceType::Skills,
            [
                collect_skill_entries(&project_dirs[1], SkillDiscoveryMode::Pi),
                project_agents_skill_dirs
                    .iter()
                    .flat_map(|dir| collect_skill_entries(dir, SkillDiscoveryMode::Agents))
                    .collect(),
            ]
            .concat(),
            &project_metadata,
            &project_overrides[1],
            project_base_dir,
        );
        add_resources(
            accumulator,
            ResourceType::Prompts,
            collect_auto_prompt_entries(&project_dirs[2]),
            &project_metadata,
            &project_overrides[2],
            project_base_dir,
        );
        add_resources(
            accumulator,
            ResourceType::Themes,
            collect_auto_theme_entries(&project_dirs[3]),
            &project_metadata,
            &project_overrides[3],
            project_base_dir,
        );

        add_resources(
            accumulator,
            ResourceType::Extensions,
            collect_auto_extension_entries(&user_dirs[0]),
            &user_metadata,
            &user_overrides[0],
            global_base_dir,
        );
        add_resources(
            accumulator,
            ResourceType::Skills,
            [
                collect_skill_entries(&user_dirs[1], SkillDiscoveryMode::Pi),
                collect_skill_entries(&user_agents_skills_dir, SkillDiscoveryMode::Agents),
            ]
            .concat(),
            &user_metadata,
            &user_overrides[1],
            global_base_dir,
        );

        if let Some(bundled_dir) = self.bundled_skills_dir() {
            if self.enable_builtin_skills() {
                let builtin_metadata = PathMetadata {
                    source: MetadataSource::Builtin,
                    scope: super::super::SourceScope::User,
                    origin: ResourceOrigin::TopLevel,
                    base_dir: Some(bundled_dir.clone()),
                };
                let builtin_entries = collect_skill_entries(bundled_dir, SkillDiscoveryMode::Pi);
                // Bundled skills must ship with the package; warn instead of
                // silently exposing none.
                if builtin_entries.is_empty() {
                    accumulator.diagnostics.push(ResourceDiagnostic::Warning {
                        message: if bundled_dir.exists() {
                            "built-in skills directory contains no skills; this build may be packaged incorrectly"
                                .to_string()
                        } else {
                            "built-in skills directory not found; this build may be packaged incorrectly"
                                .to_string()
                        },
                        path: Some(bundled_dir.display().to_string()),
                    });
                }
                let mut builtin_skill_overrides = user_overrides[1].clone();
                if !self.bundled_websearch_enabled() {
                    // Web search stays disabled until explicitly enabled.
                    builtin_skill_overrides.push("-websearch/SKILL.md".to_string());
                }
                builtin_skill_overrides
                    .extend(self.extra_builtin_skill_overrides().iter().cloned());
                add_resources(
                    accumulator,
                    ResourceType::Skills,
                    builtin_entries,
                    &builtin_metadata,
                    &builtin_skill_overrides,
                    bundled_dir,
                );
            }
        }

        add_resources(
            accumulator,
            ResourceType::Prompts,
            collect_auto_prompt_entries(&user_dirs[2]),
            &user_metadata,
            &user_overrides[2],
            global_base_dir,
        );
        add_resources(
            accumulator,
            ResourceType::Themes,
            collect_auto_theme_entries(&user_dirs[3]),
            &user_metadata,
            &user_overrides[3],
            global_base_dir,
        );
    }
}

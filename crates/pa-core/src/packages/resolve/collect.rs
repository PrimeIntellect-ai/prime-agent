//! Package resource collection: the manifest, convention-directory, and
//! filter-pattern flows behind a package's contributed resources.

use std::path::{Path, PathBuf};

use super::super::PackageManager;
use super::discovery::{collect_resource_files, read_pi_manifest};
use super::manager::collect_files_from_paths;
use super::patterns::{apply_patterns, has_glob_pattern, is_override_pattern};
use super::{
    resource_type_dir_name, PackageFilter, PathMetadata, ResourceAccumulator, ResourceType,
    RESOURCE_TYPES,
};

impl PackageManager {
    /// Collect a package's resources. True when the package contributes any
    /// resources (filter patterns always count as contributing).
    pub(super) fn collect_package_resources(
        &self,
        package_root: &Path,
        accumulator: &mut ResourceAccumulator,
        filter: Option<&PackageFilter>,
        metadata: &PathMetadata,
    ) -> bool {
        if let Some(filter) = filter {
            for resource_type in RESOURCE_TYPES {
                match filter.get(resource_type) {
                    Some(patterns) => self.apply_package_filter(
                        package_root,
                        patterns,
                        resource_type,
                        accumulator,
                        metadata,
                    ),
                    None => self.collect_default_resources(
                        package_root,
                        resource_type,
                        accumulator,
                        metadata,
                    ),
                }
            }
            return true;
        }

        let manifest = read_pi_manifest(package_root);
        if let Some(manifest) = manifest {
            for resource_type in RESOURCE_TYPES {
                let entries = manifest.entries(resource_type);
                self.add_manifest_entries(
                    entries.as_deref(),
                    package_root,
                    resource_type,
                    accumulator,
                    metadata,
                );
            }
            return true;
        }

        let mut has_any_dir = false;
        for resource_type in RESOURCE_TYPES {
            let dir = package_root.join(resource_type_dir_name(resource_type));
            if dir.exists() {
                for file in collect_resource_files(&dir, resource_type) {
                    accumulator
                        .map(resource_type)
                        .add(&file, metadata.clone(), true);
                }
                has_any_dir = true;
            }
        }
        has_any_dir
    }

    /// One resource kind of a package with user filter patterns applied on
    /// top of the package's own manifest patterns.
    fn apply_package_filter(
        &self,
        package_root: &Path,
        user_patterns: &[String],
        resource_type: ResourceType,
        accumulator: &mut ResourceAccumulator,
        metadata: &PathMetadata,
    ) {
        let all_files = self.collect_manifest_files(package_root, resource_type);
        // An explicit empty list disables this resource type.
        if user_patterns.is_empty() {
            for file in &all_files {
                accumulator
                    .map(resource_type)
                    .add(file, metadata.clone(), false);
            }
            return;
        }
        let enabled_by_user = apply_patterns(&all_files, user_patterns, package_root);
        for file in &all_files {
            let enabled = enabled_by_user.contains(file);
            accumulator
                .map(resource_type)
                .add(file, metadata.clone(), enabled);
        }
    }

    /// All files a package offers for one kind: manifest entries (filtered by
    /// the manifest's own override patterns) or the convention directory.
    fn collect_manifest_files(
        &self,
        package_root: &Path,
        resource_type: ResourceType,
    ) -> Vec<PathBuf> {
        let manifest = read_pi_manifest(package_root);
        let entries = manifest
            .as_ref()
            .and_then(|manifest| manifest.entries(resource_type))
            .unwrap_or_default();
        if !entries.is_empty() {
            let all_files =
                self.collect_files_from_manifest_entries(&entries, package_root, resource_type);
            let manifest_patterns: Vec<String> = entries
                .iter()
                .filter(|entry| is_override_pattern(entry))
                .cloned()
                .collect();
            let enabled_by_manifest = if manifest_patterns.is_empty() {
                all_files.clone()
            } else {
                apply_patterns(&all_files, &manifest_patterns, package_root)
            };
            return enabled_by_manifest;
        }

        let convention_dir = package_root.join(resource_type_dir_name(resource_type));
        if !convention_dir.exists() {
            return Vec::new();
        }
        collect_resource_files(&convention_dir, resource_type)
    }

    /// Manifest entries of one kind: non-override entries resolve to paths
    /// (plain or glob), override patterns filter them.
    fn add_manifest_entries(
        &self,
        entries: Option<&[String]>,
        root: &Path,
        resource_type: ResourceType,
        accumulator: &mut ResourceAccumulator,
        metadata: &PathMetadata,
    ) {
        let Some(entries) = entries else {
            return;
        };
        let all_files = self.collect_files_from_manifest_entries(entries, root, resource_type);
        let patterns: Vec<String> = entries
            .iter()
            .filter(|entry| is_override_pattern(entry))
            .cloned()
            .collect();
        let enabled_paths = apply_patterns(&all_files, &patterns, root);
        for file in all_files {
            if enabled_paths.contains(&file) {
                accumulator
                    .map(resource_type)
                    .add(&file, metadata.clone(), true);
            }
        }
    }

    fn collect_files_from_manifest_entries(
        &self,
        entries: &[String],
        root: &Path,
        resource_type: ResourceType,
    ) -> Vec<PathBuf> {
        let mut resolved: Vec<PathBuf> = Vec::new();
        for entry in entries.iter().filter(|entry| !is_override_pattern(entry)) {
            if has_glob_pattern(entry) {
                resolved.extend(super::patterns::glob_paths(entry, root));
            } else {
                resolved.push(super::super::source::lexical_resolve(root, entry));
            }
        }
        collect_files_from_paths(&resolved, resource_type)
    }

    /// Manifest-less default collection for one kind: manifest entries when
    /// present, else the convention directory.
    fn collect_default_resources(
        &self,
        package_root: &Path,
        resource_type: ResourceType,
        accumulator: &mut ResourceAccumulator,
        metadata: &PathMetadata,
    ) {
        let manifest = read_pi_manifest(package_root);
        let entries = manifest
            .as_ref()
            .and_then(|manifest| manifest.entries(resource_type));
        if entries.is_some() {
            self.add_manifest_entries(
                entries.as_deref(),
                package_root,
                resource_type,
                accumulator,
                metadata,
            );
            return;
        }
        let dir = package_root.join(resource_type_dir_name(resource_type));
        if dir.exists() {
            for file in collect_resource_files(&dir, resource_type) {
                accumulator
                    .map(resource_type)
                    .add(&file, metadata.clone(), true);
            }
        }
    }
}

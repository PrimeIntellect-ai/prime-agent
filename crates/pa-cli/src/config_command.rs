//! `prime-agent config`: the resource-configuration view (TS
//! `handleConfigCommand`): resolve session resources, report settings
//! errors, then open the interactive selector until Esc.

use std::path::PathBuf;

use pa_core::packages::{resource_config, PackageManager};
use pa_core::settings::SettingsManager;
use pa_tui::config_selector::{
    run_config_selector, ConfigSelector, ConfigSelectorOptions, SelectorRow,
};
use pa_tui::keybindings::KeybindingsManager;

/// Run the config command. Returns the process exit code; the TS product
/// exits 0 after the view closes (Esc) or immediately on Ctrl+C.
pub fn run() -> i32 {
    let cwd = std::env::current_dir().unwrap_or_else(|_| PathBuf::from("."));
    let agent_dir = crate::config::get_agent_dir();
    let mut resolve_settings = SettingsManager::create(&cwd, &agent_dir);
    crate::package_command::report_settings_errors(&mut resolve_settings, "config command");
    let theme_name = resolve_settings.get_theme().unwrap_or("prime").to_string();
    let mut manager = PackageManager::new(cwd.clone(), agent_dir.clone(), resolve_settings);
    let resolved = match manager.resolve() {
        Ok(resolved) => resolved,
        Err(error) => {
            eprintln!("Error: {error:#}");
            return 1;
        }
    };
    let groups = resource_config::build_groups(&resolved);
    let (rows, items) = selector_rows(&groups);
    let selector = ConfigSelector::new(rows);
    let theme = pa_tui::app::load_theme(&theme_name);
    // TS `setKeybindings(KeybindingsManager.create())` in main.ts: the
    // config selector navigates with the user's effective bindings too.
    let keybindings = KeybindingsManager::create(&agent_dir);
    let options = ConfigSelectorOptions::new(theme, keybindings);
    let mut toggle_settings = SettingsManager::create(&cwd, &agent_dir);
    let mut on_toggle = |key: &str, enabled: bool| -> anyhow::Result<()> {
        let index: usize = key
            .parse()
            .map_err(|error| anyhow::anyhow!("invalid resource selection: {error}"))?;
        let Some(item) = items.get(index) else {
            anyhow::bail!("unknown resource selection {index}");
        };
        resource_config::toggle_resource(&mut toggle_settings, &cwd, &agent_dir, item, enabled)?;
        Ok(())
    };
    match run_config_selector(selector, options, &mut on_toggle) {
        Ok(()) => 0,
        Err(error) => {
            eprintln!("Error: {error:#}");
            1
        }
    }
}

/// Flatten the resource groups into selector rows; item rows carry their
/// index in the parallel item vector as the caller's identity key.
fn selector_rows(
    groups: &[resource_config::ResourceGroup],
) -> (Vec<SelectorRow>, Vec<resource_config::ResourceItem>) {
    let mut rows: Vec<SelectorRow> = Vec::new();
    let mut items: Vec<resource_config::ResourceItem> = Vec::new();
    for group in groups {
        rows.push(SelectorRow::Group(group.label.clone()));
        for subgroup in &group.subgroups {
            rows.push(SelectorRow::Subgroup(subgroup.label.to_string()));
            for item in &subgroup.items {
                rows.push(SelectorRow::Item {
                    key: items.len().to_string(),
                    label: item.display_name.clone(),
                    checked: item.enabled,
                    type_label: resource_config::resource_type_label(item.resource_type)
                        .to_string(),
                    path: item.path.display().to_string(),
                });
                items.push(item.clone());
            }
        }
    }
    (rows, items)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn selector_rows_preserve_group_hierarchy() {
        use pa_core::packages::{MetadataSource, PathMetadata, ResourceOrigin, ResourceType};
        let item = resource_config::ResourceItem {
            path: PathBuf::from("/agent/skills/my-skill/SKILL.md"),
            enabled: true,
            metadata: PathMetadata {
                source: MetadataSource::Auto,
                scope: pa_core::packages::SourceScope::User,
                origin: ResourceOrigin::TopLevel,
                base_dir: None,
            },
            resource_type: ResourceType::Skills,
            display_name: "my-skill".to_string(),
            group_key: String::new(),
            subgroup_key: String::new(),
        };
        let group = resource_config::ResourceGroup {
            key: "g".to_string(),
            label: "User (~/.prime/agent/)".to_string(),
            scope: pa_core::packages::SourceScope::User,
            origin: ResourceOrigin::TopLevel,
            source: MetadataSource::Auto,
            subgroups: vec![resource_config::ResourceSubgroup {
                resource_type: ResourceType::Skills,
                label: "Skills",
                items: vec![item],
            }],
        };
        let (rows, items) = selector_rows(&[group]);
        assert_eq!(rows.len(), 3);
        assert!(matches!(&rows[0], SelectorRow::Group(label) if label == "User (~/.prime/agent/)"));
        assert!(matches!(&rows[1], SelectorRow::Subgroup(label) if label == "Skills"));
        match &rows[2] {
            SelectorRow::Item {
                key,
                label,
                checked,
                ..
            } => {
                assert_eq!(key, "0");
                assert_eq!(label, "my-skill");
                assert!(*checked);
            }
            other => panic!("expected an item row, got {other:?}"),
        }
        assert_eq!(items.len(), 1);
    }
}

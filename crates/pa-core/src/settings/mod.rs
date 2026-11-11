//! Settings subsystem: typed settings documents, global/project storage,
//! legacy migrations, and the manager.

pub(crate) mod interactive_settings;
pub(crate) mod load;
pub(crate) mod manager;
pub(crate) mod merge;
pub mod project_trust;
pub(crate) mod storage;
pub(crate) mod types;

#[cfg(test)]
mod persistence_tests;

pub use manager::{IdleEviction, SettingsError, SettingsManager, DEFAULT_IDLE_EVICTION_MINUTES};
pub use project_trust::{
    gated_agents_skill_dirs, project_fingerprint, project_trusted, trust_project,
    TRUSTED_PROJECTS_FILE,
};
pub use storage::{
    FileSettingsStorage, InMemorySettingsStorage, SettingsScope, SettingsStorage, CONFIG_DIR_NAME,
};
pub use types::{
    AutoRefineSettings, AutonomousSettings, CompactionSettings, QueueModeSetting, Settings,
    ThinkingLevelSetting, TransportSetting, UpdateChannel, WebSearchProvider,
};

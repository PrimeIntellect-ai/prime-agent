//! Settings subsystem: typed settings documents, global/project storage,
//! legacy migrations, and the manager.

pub(crate) mod interactive_settings;
pub(crate) mod load;
pub(crate) mod manager;
pub(crate) mod merge;
pub(crate) mod storage;
pub(crate) mod types;

pub use manager::{
    IdleEviction, SessionArchivePolicy, SettingsError, SettingsManager,
    DEFAULT_IDLE_EVICTION_MINUTES, DEFAULT_SESSION_ARCHIVE_MAX_AGE_DAYS,
    DEFAULT_SESSION_ARCHIVE_MAX_SESSIONS,
};
pub use storage::{
    FileSettingsStorage, InMemorySettingsStorage, SettingsScope, SettingsStorage, CONFIG_DIR_NAME,
};
pub use types::{
    AutoRefineSettings, AutonomousSettings, CompactionSettings, McpServerConfig, QueueModeSetting,
    Settings, ThinkingLevelSetting, TransportSetting, UpdateChannel,
};

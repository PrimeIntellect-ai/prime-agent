//! The runtime boundary: typed execution modes and options, mirroring the
//! `resolveAppMode` / `runtimeConfigFromArgs` split in `main.ts`. Crates that
//! provide the real runtime (pa-core session engine, pa-daemon workers,
//! pa-tui) plug in behind [`Runtime::run`] at merge time.

use std::path::PathBuf;

use crate::args::{Args, AutonomousConfig, Mode};

/// The process-level execution mode, mirroring `AppMode` in main.ts.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum AppMode {
    Interactive,
    Print,
    Json,
    Rpc,
    Acp,
    Daemon,
}

impl AppMode {
    /// Resolve the execution mode from parsed args and stdin TTY state,
    /// mirroring `resolveAppMode`.
    #[must_use]
    pub fn resolve(parsed: &Args, stdin_is_tty: bool) -> AppMode {
        match parsed.mode {
            Some(Mode::Daemon) => AppMode::Daemon,
            Some(Mode::Rpc) => AppMode::Rpc,
            Some(Mode::Acp) => AppMode::Acp,
            Some(Mode::Json) => AppMode::Json,
            _ => {
                if parsed.print || !stdin_is_tty {
                    AppMode::Print
                } else {
                    AppMode::Interactive
                }
            }
        }
    }

    #[must_use]
    pub fn as_str(&self) -> &'static str {
        match self {
            AppMode::Interactive => "interactive",
            AppMode::Print => "print",
            AppMode::Json => "json",
            AppMode::Rpc => "rpc",
            AppMode::Acp => "acp",
            AppMode::Daemon => "daemon",
        }
    }

    /// The print output mode, mirroring `toPrintOutputMode`.
    #[must_use]
    pub fn print_output_mode(&self) -> Mode {
        match self {
            AppMode::Json => Mode::Json,
            _ => Mode::Text,
        }
    }
}

/// A seeded persistent goal (`initialGoal` in the runtime config).
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct InitialGoal {
    pub objective: String,
    pub token_budget: Option<u32>,
}

/// The typed per-session runtime configuration, mirroring
/// `AgentSessionRuntimeConfig`. This is the API boundary the pa-core/pa-ai
/// crates consume at merge time.
#[derive(Debug, Clone, Default)]
#[allow(clippy::struct_excessive_bools)] // the mirrored `AgentSessionRuntimeConfig` API shape is deliberate
pub struct RuntimeConfig {
    pub cwd: PathBuf,
    pub agent_dir: PathBuf,
    pub session_dir: Option<PathBuf>,
    pub provider: Option<String>,
    pub model: Option<String>,
    pub api_key: Option<String>,
    pub system_prompt: Option<String>,
    pub append_system_prompt: Vec<String>,
    pub thinking: Option<pa_types::ai::ModelThinkingLevel>,
    pub models: Option<Vec<String>>,
    pub skills: Vec<PathBuf>,
    pub no_skills: bool,
    pub prompt_templates: Vec<PathBuf>,
    pub no_prompt_templates: bool,
    pub themes: Vec<PathBuf>,
    pub no_themes: bool,
    pub no_context_files: bool,
    pub autonomous: Option<AutonomousConfig>,
    pub execution_mode: Option<AppMode>,
    pub telemetry_disabled: bool,
    pub serialized_refine: bool,
    pub initial_goal: Option<InitialGoal>,
}

/// Session selection options that stay client-side.
#[derive(Debug, Clone, Default)]
#[allow(clippy::struct_excessive_bools)] // the selection's flag set is the deliberate client-side surface
pub struct SessionOptions {
    /// `--continue`/`-c`: the launch surfaces the newest saved session for
    /// the cwd through the agents view (preselected, never a blind reopen)
    /// and falls back to a fresh session without a candidate.
    pub continue_recent: bool,
    pub resume_bare: bool,
    pub resume: Option<String>,
    pub fork: Option<String>,
    pub no_session: bool,
    pub session_dir: Option<PathBuf>,
    /// True when `--cwd` selected the working directory; resumed sessions
    /// then use that directory instead of the header cwd (main.ts
    /// `explicitCwdOverride`).
    pub cwd_from_flag: bool,
}

/// Everything the CLI hands to the runtime, mirroring what `main.ts` computes
/// before entering the mode runners.
#[derive(Debug, Clone)]
pub struct RunOptions {
    pub app_mode: AppMode,
    pub config: RuntimeConfig,
    pub session: SessionOptions,
    pub messages: Vec<String>,
    pub file_args: Vec<String>,
    pub daemon_socket: Option<String>,
    pub list_models: Option<Option<String>>,
    /// The combined first prompt (stdin + @file text + first message).
    pub initial_message: Option<String>,
    /// The `@file` image attachments for the initial prompt (TS
    /// `initialImages`; only the non-interactive prompt path sends them -
    /// the interactive initial-message image arm is not yet wired).
    pub initial_images: Vec<pa_agent::types::ImageContent>,
    pub verbose: bool,
    pub offline: bool,
    pub agents_view_requested: bool,
    pub attach_agent: Option<String>,
}

/// A missing runtime subsystem, reported as a typed error instead of faked
/// output. The enum makes the merge-time work explicit.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum MissingSubsystem {
    SessionEngine,
    ModelRegistry,
    PackageManager,
}

impl MissingSubsystem {
    #[must_use]
    pub fn subsystem_name(&self) -> &'static str {
        match self {
            MissingSubsystem::SessionEngine => "the session engine (pa-core)",
            MissingSubsystem::ModelRegistry => "the model registry (pa-ai)",
            MissingSubsystem::PackageManager => "the capability package manager (pa-core)",
        }
    }

    #[must_use]
    pub fn error_message(&self) -> String {
        format!(
            "this invocation needs {}, which is not linked into the binary yet",
            self.subsystem_name()
        )
    }
}

impl std::fmt::Display for MissingSubsystem {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str(self.subsystem_name())
    }
}

impl std::error::Error for MissingSubsystem {}

/// The runtime boundary. `run` executes the requested mode; the current build
/// has only the [`UnavailableRuntime`] implementation, which produces typed
/// [`MissingSubsystem`] errors for every mode that needs unmerged crates.
pub trait Runtime {
    /// Execute the requested mode.
    ///
    /// # Errors
    /// Returns a [`MissingSubsystem`] error naming the subsystem the
    /// requested mode needs when it is not linked into the binary.
    fn run(&self, options: &RunOptions) -> Result<i32, MissingSubsystem>;
}

/// The merge-time placeholder runtime: it never fakes output, it fails loudly
/// with the precise missing subsystem for the requested mode.
#[derive(Debug, Clone, Copy, Default)]
pub struct UnavailableRuntime;

impl Runtime for UnavailableRuntime {
    fn run(&self, options: &RunOptions) -> Result<i32, MissingSubsystem> {
        if options.list_models.is_some() {
            return Err(MissingSubsystem::ModelRegistry);
        }
        let _ = options.app_mode;
        Err(MissingSubsystem::SessionEngine)
    }
}

/// TS main.ts `telemetryDisabled = isTelemetryEnabled(settings) ? undefined
/// : true`: env overrides first (`PI_OFFLINE` / `DO_NOT_TRACK` /
/// `PRIME_AGENT_TELEMETRY`), then the settings AND. Returns true when
/// telemetry is disabled for this invocation.
pub fn telemetry_disabled(settings: &pa_core::settings::SettingsManager) -> bool {
    !pa_core::session_engine::telemetry::telemetry_switch(settings).enabled()
}

/// Build the runtime config from parsed args, mirroring `runtimeConfigFromArgs`.
pub fn runtime_config_from_args(
    parsed: &Args,
    cwd: PathBuf,
    agent_dir: PathBuf,
    session_dir: Option<PathBuf>,
    app_mode: AppMode,
    telemetry_disabled: bool,
) -> RuntimeConfig {
    // isLocalPath: only npm:/git:/github:/http(s):/ssh: sources are not local;
    // everything else resolves against the session cwd (utils/paths.ts).
    let is_local_path = |value: &str| {
        let trimmed = value.trim();
        !(trimmed.starts_with("npm:")
            || trimmed.starts_with("git:")
            || trimmed.starts_with("github:")
            || trimmed.starts_with("http:")
            || trimmed.starts_with("https:")
            || trimmed.starts_with("ssh:"))
    };
    let resolve_cli_path = |paths: &[String]| -> Vec<PathBuf> {
        paths
            .iter()
            .map(|value| {
                if is_local_path(value) {
                    if std::path::Path::new(value).is_absolute() {
                        PathBuf::from(value)
                    } else {
                        cwd.join(value)
                    }
                } else {
                    PathBuf::from(value)
                }
            })
            .collect()
    };
    let skills = resolve_cli_path(&parsed.skills);
    let prompt_templates = resolve_cli_path(&parsed.prompt_templates);
    let themes = resolve_cli_path(&parsed.themes);
    RuntimeConfig {
        cwd,
        agent_dir,
        session_dir,
        provider: parsed.provider.clone(),
        model: parsed.model.clone(),
        api_key: parsed.api_key.clone(),
        system_prompt: parsed.system_prompt.clone(),
        append_system_prompt: parsed.append_system_prompt.clone(),
        thinking: parsed.thinking,
        models: parsed.models.clone(),
        skills,
        no_skills: parsed.no_skills,
        prompt_templates,
        no_prompt_templates: parsed.no_prompt_templates,
        themes,
        no_themes: parsed.no_themes,
        no_context_files: parsed.no_context_files,
        autonomous: AutonomousConfig::from_args(parsed),
        execution_mode: (app_mode != AppMode::Daemon).then_some(app_mode),
        telemetry_disabled,
        // Serialized refine is only used by print/json/rpc clients.
        serialized_refine: !matches!(app_mode, AppMode::Interactive | AppMode::Daemon),
        initial_goal: parsed.goal.as_ref().map(|objective| InitialGoal {
            objective: objective.clone(),
            token_budget: parsed.goal_token_budget,
        }),
    }
}

#[cfg(test)]
pub(crate) mod tests {
    use super::*;

    /// Run the body with the three telemetry env overrides held at a known
    /// state and restored after (an assertion panic must never leave the
    /// process env mutated, and a host-exported opt-out must not bleed in).
    pub(crate) fn with_clean_telemetry_env(body: impl FnOnce() + std::panic::UnwindSafe) {
        // The env is process-wide: tests that rewrite it take turns.
        static LOCK: std::sync::Mutex<()> = std::sync::Mutex::new(());
        let _guard = LOCK
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner);
        let vars = ["PRIME_AGENT_TELEMETRY", "DO_NOT_TRACK", "PI_OFFLINE"];
        let saved: Vec<(String, Option<String>)> = vars
            .iter()
            .map(|key| ((*key).to_string(), std::env::var(key).ok()))
            .collect();
        for key in vars {
            std::env::remove_var(key);
        }
        // Restore the env FIRST, then resume the panic: a failed
        // assertion must fail the test (never swallow), and the restore
        // must survive it.
        let outcome = std::panic::catch_unwind(body);
        for (key, value) in saved {
            match value {
                Some(value) => std::env::set_var(key, value),
                None => std::env::remove_var(key),
            }
        }
        if let Err(panic) = outcome {
            std::panic::resume_unwind(panic);
        }
    }

    /// The opt-out chain (the operator's explicit ask: nothing sends when
    /// disabled): settings `telemetry.enabled=false` disables, and the env
    /// overrides apply in the documented precedence - `DO_NOT_TRACK` and
    /// `PI_OFFLINE` disable even against `PRIME_AGENT_TELEMETRY=1`.
    #[test]
    fn telemetry_opt_out_resolves_disabled() {
        with_clean_telemetry_env(|| {
            let dir = tempfile::tempdir().unwrap();
            let agent_dir = dir.path().join("agent");
            let mut settings = pa_core::settings::SettingsManager::create(dir.path(), agent_dir);
            settings.set_telemetry_enabled(false).unwrap();
            assert!(
                telemetry_disabled(&settings),
                "settings telemetry.enabled=false opts out"
            );
        });
    }

    #[test]
    fn telemetry_env_overrides_apply_in_precedence() {
        with_clean_telemetry_env(|| {
            let dir = tempfile::tempdir().unwrap();
            let agent_dir = dir.path().join("agent");
            let settings = pa_core::settings::SettingsManager::create(dir.path(), agent_dir);
            // `PRIME_AGENT_TELEMETRY=1` re-enables over the settings default.
            std::env::set_var("PRIME_AGENT_TELEMETRY", "1");
            assert!(!telemetry_disabled(&settings));
            // But DO_NOT_TRACK outranks it: still disabled.
            std::env::set_var("DO_NOT_TRACK", "1");
            assert!(telemetry_disabled(&settings));
            // And PI_OFFLINE outranks the re-enable too.
            std::env::set_var("PI_OFFLINE", "1");
            assert!(telemetry_disabled(&settings));
        });
    }

    /// Default-on: a fresh install resolves enabled (telemetry stays on by
    /// default, matching the TS posture) with the env overrides cleared.
    #[test]
    fn telemetry_defaults_on() {
        with_clean_telemetry_env(|| {
            let dir = tempfile::tempdir().unwrap();
            let agent_dir = dir.path().join("agent");
            let settings = pa_core::settings::SettingsManager::create(dir.path(), agent_dir);
            assert!(!telemetry_disabled(&settings));
        });
    }
}

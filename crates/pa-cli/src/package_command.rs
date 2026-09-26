//! Package command validation and help, ported from
//! `package-manager-cli.ts` (`handlePackageCommand`, `parsePackageCommand`,
//! `printPackageCommandHelp`).

use pa_core::packages::{PackageManager, ProgressEvent, ProgressEventKind, UserOrProject};
use pa_core::update::version::UpdateChannel;

use crate::config::{get_agent_dir, APP_NAME, CONFIG_DIR_NAME};
use crate::self_update::SelfUpdateOptions;

use crate::public_command::{
    DAEMON_UPDATE_RESTART_COORDINATOR_FLAG, DAEMON_UPDATE_RESTART_ORIGIN_FLAG,
    DAEMON_UPDATE_RESTART_STATUS_FLAG,
};

/// Result of running a package command: printed output is handled here, and the
/// exit code is reported for the caller to propagate.
#[derive(Debug, Clone)]
pub struct PackageCommandOutcome {
    pub exit_code: Option<i32>,
}

const HANDLED_OK: PackageCommandOutcome = PackageCommandOutcome { exit_code: None };

fn fail(message: &str, hint: Option<&str>) -> PackageCommandOutcome {
    // handlePackageCommand prints its errors without the "Error: " prefix.
    eprintln!("{message}");
    if let Some(hint) = hint {
        eprintln!("{hint}");
    }
    PackageCommandOutcome { exit_code: Some(1) }
}

fn is_self_update_source(source: &str) -> bool {
    source == "self" || source == "pi" || source == APP_NAME
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum PackageCommand {
    Install,
    Remove,
    Update,
    List,
}

impl PackageCommand {
    fn usage(&self) -> String {
        match self {
            PackageCommand::Install => format!("{APP_NAME} package install <source> [--local]"),
            PackageCommand::Remove => format!("{APP_NAME} package remove <source> [--local]"),
            PackageCommand::Update => format!(
                "{APP_NAME} update [--force] [--rollback] [--nightly|--stable] or {APP_NAME} package update [source]"
            ),
            PackageCommand::List => format!("{APP_NAME} package list"),
        }
    }
}

/// What `update` targets: Prime Agent itself, installed packages, or both.
#[derive(Debug, Clone, PartialEq, Eq)]
enum UpdateTarget {
    All,
    SelfOnly,
    Extensions { source: Option<String> },
}

impl UpdateTarget {
    fn includes_self(&self) -> bool {
        matches!(self, UpdateTarget::All | UpdateTarget::SelfOnly)
    }

    fn includes_extensions(&self) -> bool {
        match self {
            UpdateTarget::Extensions { .. } | UpdateTarget::All => true,
            UpdateTarget::SelfOnly => false,
        }
    }
}

#[derive(Debug, Default)]
struct PackageCommandOptions {
    local: bool,
    help: bool,
    force: bool,
    rollback: bool,
    channel: Option<UpdateChannel>,
    update_target: Option<UpdateTarget>,
    invalid_option: Option<String>,
    invalid_argument: Option<String>,
    missing_option_value: Option<String>,
    conflicting_options: Option<String>,
    source: Option<String>,
    restart_coordinator: bool,
    restart_daemon_socket: Option<String>,
    restart_status_path: Option<String>,
    restart_origin_active_session_id: Option<String>,
}

fn parse_package_command(args: &[String]) -> Option<PackageCommandOptions> {
    let command = match args.first().map(String::as_str) {
        Some("uninstall" | "remove") => Some(PackageCommand::Remove),
        Some("install") => Some(PackageCommand::Install),
        Some("update") => Some(PackageCommand::Update),
        Some("list") => Some(PackageCommand::List),
        _ => None,
    }?;
    let rest = &args[1..];
    let mut options = PackageCommandOptions::default();
    let mut channel: Option<&str> = None;
    let mut self_flag = false;
    let mut extensions_flag = false;
    let mut extension_flag_source: Option<String> = None;
    let mut daemon_socket_seen = false;

    let mut index = 0;
    while index < rest.len() {
        let arg = rest[index].as_str();
        match arg {
            "-h" | "--help" => {
                options.help = true;
            }
            "--local" => {
                if matches!(command, PackageCommand::Install | PackageCommand::Remove) {
                    options.local = true;
                } else {
                    options
                        .invalid_option
                        .get_or_insert_with(|| arg.to_string());
                }
            }
            "--self" => {
                if command == PackageCommand::Update {
                    self_flag = true;
                } else {
                    options
                        .invalid_option
                        .get_or_insert_with(|| arg.to_string());
                }
            }
            "--extensions" => {
                if command == PackageCommand::Update {
                    extensions_flag = true;
                } else {
                    options
                        .invalid_option
                        .get_or_insert_with(|| arg.to_string());
                }
            }
            "--force" => {
                if command == PackageCommand::Update {
                    options.force = true;
                } else {
                    options
                        .invalid_option
                        .get_or_insert_with(|| arg.to_string());
                }
            }
            "--rollback" => {
                if command == PackageCommand::Update {
                    options.rollback = true;
                    self_flag = true;
                } else {
                    options
                        .invalid_option
                        .get_or_insert_with(|| arg.to_string());
                }
            }
            "--nightly" | "--stable" => {
                if command != PackageCommand::Update {
                    options
                        .invalid_option
                        .get_or_insert_with(|| arg.to_string());
                    index += 1;
                    continue;
                }
                let requested = if arg == "--nightly" {
                    "nightly"
                } else {
                    "stable"
                };
                if channel.is_some() && channel != Some(requested) {
                    options.conflicting_options.get_or_insert_with(|| {
                        "--nightly and --stable cannot be combined".to_string()
                    });
                }
                channel = Some(requested);
            }
            "--daemon-socket" => {
                if command != PackageCommand::Update {
                    options
                        .invalid_option
                        .get_or_insert_with(|| arg.to_string());
                    index += 1;
                    continue;
                }
                match rest.get(index + 1) {
                    Some(value) if !value.starts_with('-') => {
                        if daemon_socket_seen {
                            options.conflicting_options.get_or_insert_with(|| {
                                "--daemon-socket can only be provided once".to_string()
                            });
                        } else {
                            daemon_socket_seen = true;
                            options.restart_daemon_socket = Some(value.clone());
                        }
                        index += 1;
                    }
                    _ => {
                        options
                            .missing_option_value
                            .get_or_insert_with(|| arg.to_string());
                    }
                }
            }
            DAEMON_UPDATE_RESTART_COORDINATOR_FLAG => {
                if command == PackageCommand::Update {
                    options.restart_coordinator = true;
                } else {
                    options
                        .invalid_option
                        .get_or_insert_with(|| arg.to_string());
                }
            }
            DAEMON_UPDATE_RESTART_STATUS_FLAG | DAEMON_UPDATE_RESTART_ORIGIN_FLAG => {
                if command != PackageCommand::Update {
                    options
                        .invalid_option
                        .get_or_insert_with(|| arg.to_string());
                    index += 1;
                    continue;
                }
                match rest.get(index + 1) {
                    Some(value) if !value.starts_with('-') => {
                        if arg == DAEMON_UPDATE_RESTART_STATUS_FLAG {
                            options.restart_status_path = Some(value.clone());
                        } else {
                            options.restart_origin_active_session_id = Some(value.clone());
                        }
                        index += 1;
                    }
                    _ => {
                        options
                            .missing_option_value
                            .get_or_insert_with(|| arg.to_string());
                    }
                }
            }
            "--extension" => {
                if command != PackageCommand::Update {
                    options
                        .invalid_option
                        .get_or_insert_with(|| arg.to_string());
                    index += 1;
                    continue;
                }
                match rest.get(index + 1) {
                    Some(value) if !value.starts_with('-') => {
                        if extension_flag_source.is_some() {
                            options.conflicting_options.get_or_insert_with(|| {
                                "--extension can only be provided once".to_string()
                            });
                        } else {
                            extension_flag_source = Some(value.clone());
                        }
                        index += 1;
                    }
                    _ => {
                        options
                            .missing_option_value
                            .get_or_insert_with(|| arg.to_string());
                    }
                }
            }
            _ if arg.starts_with('-') => {
                options
                    .invalid_option
                    .get_or_insert_with(|| arg.to_string());
            }
            _ => {
                if options.source.is_none() {
                    options.source = Some(arg.to_string());
                } else {
                    options
                        .invalid_argument
                        .get_or_insert_with(|| arg.to_string());
                }
            }
        }
        index += 1;
    }

    if command == PackageCommand::Update {
        options.channel = channel.and_then(UpdateChannel::from_wire);
        if extension_flag_source.is_some() {
            if self_flag || extensions_flag {
                options.conflicting_options.get_or_insert_with(|| {
                    "--extension cannot be combined with --self or --extensions".to_string()
                });
            }
            if options.source.is_some() {
                options.conflicting_options.get_or_insert_with(|| {
                    "--extension cannot be combined with a positional source".to_string()
                });
            }
        } else if let Some(source) = &options.source {
            if !is_self_update_source(source) && (extensions_flag || self_flag) {
                options.conflicting_options.get_or_insert_with(|| {
                    "positional update targets cannot be combined with --self or --extensions"
                        .to_string()
                });
            }
        }
        let positional_source_not_self = options
            .source
            .as_deref()
            .is_some_and(|source| !is_self_update_source(source));
        if options.rollback
            && (extensions_flag || extension_flag_source.is_some() || positional_source_not_self)
        {
            options.conflicting_options =
                Some("--rollback only applies to Prime Agent itself".to_string());
        }
        if channel.is_some()
            && (extensions_flag || extension_flag_source.is_some() || positional_source_not_self)
        {
            options.conflicting_options.get_or_insert_with(|| {
                "--nightly and --stable only apply to Prime Agent itself".to_string()
            });
        }
    }

    if command == PackageCommand::Update {
        let update_target = if let Some(extension_source) = extension_flag_source {
            UpdateTarget::Extensions {
                source: Some(extension_source),
            }
        } else if let Some(source) = &options.source {
            if is_self_update_source(source) {
                if extensions_flag {
                    UpdateTarget::All
                } else {
                    UpdateTarget::SelfOnly
                }
            } else {
                UpdateTarget::Extensions {
                    source: Some(source.clone()),
                }
            }
        } else if self_flag && extensions_flag {
            UpdateTarget::All
        } else if self_flag {
            UpdateTarget::SelfOnly
        } else if extensions_flag {
            UpdateTarget::Extensions { source: None }
        } else {
            UpdateTarget::All
        };
        options.update_target = Some(update_target);
    }

    Some(options)
}

fn print_package_command_help(command: PackageCommand) {
    let usage = command.usage();
    match command {
        PackageCommand::Install => println!(
            "Usage:\n  {usage}\n\nInstall a package and add it to settings.\n\nOptions:\n  --local    Install project-locally ({CONFIG_DIR_NAME}/settings.json)\n\nExamples:\n  {APP_NAME} package install npm:@foo/bar\n  {APP_NAME} package install git:github.com/user/repo\n  {APP_NAME} package install git:git@github.com:user/repo\n  {APP_NAME} package install https://github.com/user/repo\n  {APP_NAME} package install ssh://git@github.com/user/repo\n  {APP_NAME} package install ./local/path\n"
        ),
        PackageCommand::Remove => println!(
            "Usage:\n  {usage}\n\nRemove a package and its source from settings.\n\nOptions:\n  --local    Remove from project settings ({CONFIG_DIR_NAME}/settings.json)\n\nExamples:\n  {APP_NAME} package remove npm:@foo/bar\n"
        ),
        PackageCommand::Update => println!(
            "Usage:\n  {usage}\n\nUpdate {APP_NAME} or installed packages.\n\nOptions:\n  --self                  Update {APP_NAME} only\n  --extensions            Update installed packages only\n  --extension <source>    Update one package only\n  --force                 Reinstall {APP_NAME} even if the current version is latest\n  --rollback              Restore the previous compiled release\n  --nightly               Switch updates to the nightly channel (unreleased builds, may be broken)\n  --stable                Return updates to the stable channel\n  --daemon-socket <path>  Restart the daemon listening on this exact socket\n\nCommands:\n  {APP_NAME} update                Update {APP_NAME}\n  {APP_NAME} package update        Update installed packages\n  {APP_NAME} package update <source> Update one package\n"
        ),
        PackageCommand::List => println!(
            "Usage:\n  {usage}\n\nList installed packages from user and project settings.\n"
        ),
    }
}

/// Run a package command, mirroring `handlePackageCommand`: validation and
/// help here, the package manager subsystem below, and the update case's
/// self target through the native self-update flow (`crate::self_update`).
pub fn handle_package_command(args: &[String]) -> PackageCommandOutcome {
    let Some(options) = parse_package_command(args) else {
        return PackageCommandOutcome { exit_code: None };
    };
    let command = match args.first().map(String::as_str) {
        Some("uninstall" | "remove") => PackageCommand::Remove,
        Some("install") => PackageCommand::Install,
        Some("update") => PackageCommand::Update,
        Some("list") => PackageCommand::List,
        _ => return PackageCommandOutcome { exit_code: None },
    };
    let command_name = match command {
        PackageCommand::Install => "install",
        PackageCommand::Remove => "remove",
        PackageCommand::Update => "update",
        PackageCommand::List => "list",
    };

    if options.help {
        print_package_command_help(command);
        return HANDLED_OK;
    }

    if let Some(invalid_option) = &options.invalid_option {
        if invalid_option == "-l"
            && matches!(command, PackageCommand::Install | PackageCommand::Remove)
        {
            return fail("Option -l was removed. Use \"--local\".", None);
        }
        return fail(
            &format!("Unknown option {invalid_option} for \"{command_name}\"."),
            Some(&format!(
                "Use \"{APP_NAME} --help\" or \"{}\".",
                command.usage()
            )),
        );
    }
    if let Some(missing) = &options.missing_option_value {
        return fail(
            &format!("Missing value for {missing}."),
            Some(&format!("Usage: {}", command.usage())),
        );
    }
    if let Some(invalid_argument) = &options.invalid_argument {
        return fail(
            &format!("Unexpected argument {invalid_argument}."),
            Some(&format!("Usage: {}", command.usage())),
        );
    }
    if let Some(conflict) = &options.conflicting_options {
        return fail(conflict, Some(&format!("Usage: {}", command.usage())));
    }
    if options.restart_coordinator {
        // The detached coordinator mode (spec §4): this process adopts the
        // staged status file and drives the FSM to a terminal state. The
        // invocation is CLI-internal (the update command spawns it).
        let (Some(socket), Some(status_path)) = (
            options.restart_daemon_socket.clone(),
            options.restart_status_path,
        ) else {
            return fail(
                "Invalid daemon update restart coordinator invocation.",
                None,
            );
        };
        let socket_path = std::path::PathBuf::from(socket);
        let status_path = std::path::PathBuf::from(status_path);
        let runtime = match tokio::runtime::Builder::new_multi_thread()
            .enable_all()
            .build()
        {
            Ok(runtime) => runtime,
            Err(error) => {
                return fail(
                    &format!("Could not start the update coordinator runtime: {error}."),
                    None,
                );
            }
        };
        let exit_code = runtime.block_on(crate::update_flow::update_command::run_coordinator_mode(
            socket_path,
            status_path,
        ));
        return match exit_code {
            Ok(code) => PackageCommandOutcome {
                exit_code: Some(code),
            },
            Err(error) => fail(&format!("{error:#}"), None),
        };
    }
    if options.restart_status_path.is_some() || options.restart_origin_active_session_id.is_some() {
        return fail(
            "Invalid daemon update restart coordinator invocation.",
            None,
        );
    }

    let source_missing = matches!(command, PackageCommand::Install | PackageCommand::Remove)
        && options.source.is_none();
    if source_missing {
        return fail(
            &format!("Missing {command_name} source."),
            Some(&format!("Usage: {}", command.usage())),
        );
    }

    // Everything past this point runs the package manager subsystem.
    let cwd = std::env::current_dir().unwrap_or_else(|_| std::path::PathBuf::from("."));
    let agent_dir = get_agent_dir();
    let mut settings = pa_core::settings::SettingsManager::create(&cwd, &agent_dir);
    report_settings_errors(&mut settings, "package command");

    let mut manager = PackageManager::new(cwd, agent_dir, settings);
    manager.set_progress_callback(Box::new(|event: &ProgressEvent| {
        if event.kind == ProgressEventKind::Start {
            if let Some(message) = &event.message {
                println!("{message}");
            }
        }
    }));

    let scope = if options.local {
        UserOrProject::Project
    } else {
        UserOrProject::User
    };

    // The TS `handlePackageCommand` shape: one outcome per case, the exit
    // code the case itself decides (the update case's two halves compose
    // abort/no-change codes of their own).
    match command {
        PackageCommand::Install => {
            let source = options.source.as_deref().expect("checked above");
            match manager.install_and_persist(source, scope) {
                Ok(()) => {
                    println!("Installed {source}");
                    HANDLED_OK
                }
                Err(error) => fail(&format!("Error: {error}"), None),
            }
        }
        PackageCommand::Remove => {
            let source = options.source.as_deref().expect("checked above");
            match manager.remove_and_persist(source, scope) {
                Ok(true) => {
                    println!("Removed {source}");
                    HANDLED_OK
                }
                Ok(false) => {
                    eprintln!("No matching package found for {source}");
                    PackageCommandOutcome { exit_code: Some(1) }
                }
                Err(error) => fail(&format!("Error: {error}"), None),
            }
        }
        PackageCommand::List => {
            print_package_list(&manager.list_configured_packages());
            HANDLED_OK
        }
        PackageCommand::Update => run_package_update(
            &mut manager,
            options,
            std::io::IsTerminal::is_terminal(&std::io::stdin()),
            &crate::self_update::run,
        ),
    }
}

/// The `package update` case (TS `handlePackageCommand`'s update case):
/// the nightly-switch confirmation runs before any update work so declining
/// changes nothing, then the extensions half, then the self target through
/// the same native flow `prime-agent update` runs — never a stub. The
/// extensions half runs first (TS order); a self-update the binary's
/// installation does not support surfaces the flow's installer-ownership
/// message instead of a misleading refusal.
fn run_package_update(
    manager: &mut PackageManager,
    options: PackageCommandOptions,
    stdin_is_terminal: bool,
    self_update: &dyn Fn(&SelfUpdateOptions, Option<String>) -> i32,
) -> PackageCommandOutcome {
    let target = options.update_target.unwrap_or(UpdateTarget::All);
    let persisted_wire = manager
        .settings()
        .get_update_channel()
        .map(crate::self_update::settings_channel_wire_name)
        .map(str::to_string);
    let abort_code = if target.includes_self() {
        crate::self_update::confirm_nightly_switch(
            options.force,
            options.channel,
            persisted_wire.as_deref(),
            stdin_is_terminal,
        )
    } else {
        None
    };
    if let Some(abort_code) = abort_code {
        return PackageCommandOutcome {
            exit_code: Some(abort_code),
        };
    }
    if target.includes_extensions() {
        let update_source = match &target {
            UpdateTarget::Extensions { source } => source.as_deref(),
            _ => None,
        };
        if let Err(error) = manager.update(update_source) {
            return fail(&format!("Error: {error}"), None);
        }
        match update_source {
            Some(source) => println!("Updated {source}"),
            None => println!("Updated packages"),
        }
    }
    if !target.includes_self() {
        return HANDLED_OK;
    }
    let invocation = SelfUpdateOptions {
        force: options.force,
        rollback: options.rollback,
        channel: options.channel,
        archive: None,
        source: None,
    };
    let code = self_update(&invocation, persisted_wire);
    if code == 0 {
        HANDLED_OK
    } else {
        PackageCommandOutcome {
            exit_code: Some(code),
        }
    }
}

/// Print the configured package list (user section, then project section).
fn print_package_list(packages: &[pa_core::packages::ConfiguredPackage]) {
    if packages.is_empty() {
        println!("No packages installed.");
        return;
    }
    let user_packages: Vec<_> = packages
        .iter()
        .filter(|package| package.scope == UserOrProject::User)
        .collect();
    let project_packages: Vec<_> = packages
        .iter()
        .filter(|package| package.scope == UserOrProject::Project)
        .collect();
    if !user_packages.is_empty() {
        println!("User packages:");
        for package in &user_packages {
            print_configured_package(package);
        }
    }
    if !project_packages.is_empty() {
        if !user_packages.is_empty() {
            println!();
        }
        println!("Project packages:");
        for package in &project_packages {
            print_configured_package(package);
        }
    }
}

fn print_configured_package(package: &pa_core::packages::ConfiguredPackage) {
    let display = if package.filtered {
        format!("{} (filtered)", package.source)
    } else {
        package.source.clone()
    };
    println!("  {display}");
    if let Some(installed_path) = &package.installed_path {
        println!("    {}", installed_path.display());
    }
}

/// Print settings-load warnings exactly once (`Warning (<context>, <scope>
/// settings): <message>`).
pub(crate) fn report_settings_errors(
    settings: &mut pa_core::settings::SettingsManager,
    context: &str,
) {
    for error in settings.drain_errors() {
        let scope = match error.scope {
            pa_core::settings::SettingsScope::Global => "global",
            pa_core::settings::SettingsScope::Project => "project",
        };
        eprintln!("Warning ({context}, {scope} settings): {}", error.message);
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn parse(args: &[&str]) -> PackageCommandOptions {
        let args: Vec<String> = args.iter().map(std::string::ToString::to_string).collect();
        parse_package_command(&args).expect("the args parse")
    }

    #[test]
    fn update_options_store_force_and_the_channel() {
        let options = parse(&["update", "--force", "--nightly"]);
        assert!(options.force, "--force must reach the self target");
        assert_eq!(options.channel, Some(UpdateChannel::Nightly));
        assert_eq!(options.update_target, Some(UpdateTarget::All));
        let options = parse(&["update", "--stable"]);
        assert_eq!(options.channel, Some(UpdateChannel::Stable));
        // The conflict survives: both channel flags never resolve to one.
        assert!(parse(&["update", "--nightly", "--stable"])
            .conflicting_options
            .is_some());
        // The other commands reject both flags outright.
        assert!(parse(&["install", "--force"]).invalid_option.is_some());
        assert!(parse(&["remove", "--nightly"]).invalid_option.is_some());
    }

    /// An empty package-manager store in its own sandbox: no configured
    /// packages, so the extensions half is a no-op and the self target is
    /// the only thing under observation.
    fn sandbox_manager(dir: &std::path::Path, update_channel: Option<&str>) -> PackageManager {
        let cwd = dir.join("cwd");
        let agent_dir = dir.join("agent");
        std::fs::create_dir_all(&cwd).unwrap();
        std::fs::create_dir_all(&agent_dir).unwrap();
        if let Some(channel) = update_channel {
            std::fs::write(
                agent_dir.join("settings.json"),
                format!(r#"{{"updateChannel": "{channel}"}}"#),
            )
            .unwrap();
        }
        let settings = pa_core::settings::SettingsManager::create(&cwd, &agent_dir);
        PackageManager::new(cwd, agent_dir, settings)
    }

    /// A recording self-update runner: the invoked options plus the
    /// persisted channel, and the exit code to hand back.
    struct RecordedSelfUpdates {
        seen: std::sync::Mutex<Vec<(SelfUpdateOptions, Option<String>)>>,
        code: i32,
    }

    impl RecordedSelfUpdates {
        fn new(code: i32) -> Self {
            Self {
                seen: std::sync::Mutex::new(Vec::new()),
                code,
            }
        }

        fn runner(&self) -> impl Fn(&SelfUpdateOptions, Option<String>) -> i32 + '_ {
            move |options, persisted| {
                self.seen.lock().unwrap().push((options.clone(), persisted));
                self.code
            }
        }

        fn invocations(&self) -> Vec<(SelfUpdateOptions, Option<String>)> {
            self.seen.lock().unwrap().clone()
        }
    }

    /// The self-update invocation the flags produce (no direct-install
    /// payload: the package path cannot carry `--archive`).
    fn expected_invocation(
        force: bool,
        rollback: bool,
        channel: Option<UpdateChannel>,
    ) -> SelfUpdateOptions {
        SelfUpdateOptions {
            force,
            rollback,
            channel,
            archive: None,
            source: None,
        }
    }

    #[test]
    fn a_declined_nightly_switch_changes_nothing() {
        let dir = tempfile::tempdir().unwrap();
        let mut manager = sandbox_manager(dir.path(), Some("stable"));
        let options = parse(&["update", "--nightly"]);
        let recorded = RecordedSelfUpdates::new(0);
        let outcome = run_package_update(
            &mut manager,
            options,
            /*stdin_is_terminal*/ false,
            &recorded.runner(),
        );
        assert_eq!(
            outcome.exit_code,
            Some(1),
            "an unconfirmed switch on a non-tty run aborts with failure"
        );
        assert!(
            recorded.invocations().is_empty(),
            "declining runs neither half"
        );
    }

    #[test]
    fn force_confirms_the_switch_and_the_self_target_sees_the_flags() {
        let dir = tempfile::tempdir().unwrap();
        let mut manager = sandbox_manager(dir.path(), Some("stable"));
        let options = parse(&["update", "--force", "--nightly"]);
        let recorded = RecordedSelfUpdates::new(0);
        let outcome = run_package_update(
            &mut manager,
            options,
            /*stdin_is_terminal*/ false,
            &recorded.runner(),
        );
        assert_eq!(outcome.exit_code, None, "a completed run exits 0");
        assert_eq!(
            recorded.invocations(),
            vec![(
                expected_invocation(true, false, Some(UpdateChannel::Nightly)),
                Some("stable".to_string())
            )]
        );
    }

    #[test]
    fn a_rollback_runs_the_self_target_only() {
        let dir = tempfile::tempdir().unwrap();
        let mut manager = sandbox_manager(dir.path(), None);
        // `--rollback` parses as the self target; with no persisted channel
        // the runner receives none either.
        let options = parse(&["update", "--rollback"]);
        let recorded = RecordedSelfUpdates::new(0);
        let outcome = run_package_update(
            &mut manager,
            options,
            /*stdin_is_terminal*/ false,
            &recorded.runner(),
        );
        assert_eq!(outcome.exit_code, None);
        assert_eq!(
            recorded.invocations(),
            vec![(expected_invocation(false, true, None), None)]
        );
    }

    #[test]
    fn the_extensions_only_target_never_runs_the_self_target() {
        let dir = tempfile::tempdir().unwrap();
        let mut manager = sandbox_manager(dir.path(), None);
        let options = parse(&["update", "--extensions"]);
        let recorded = RecordedSelfUpdates::new(0);
        let outcome = run_package_update(
            &mut manager,
            options,
            /*stdin_is_terminal*/ false,
            &recorded.runner(),
        );
        assert_eq!(outcome.exit_code, None);
        assert!(recorded.invocations().is_empty());
    }

    #[test]
    fn the_no_change_exit_code_reaches_the_caller() {
        let dir = tempfile::tempdir().unwrap();
        let mut manager = sandbox_manager(dir.path(), None);
        let options = parse(&["update", "--self"]);
        let recorded = RecordedSelfUpdates::new(75);
        let outcome = run_package_update(
            &mut manager,
            options,
            /*stdin_is_terminal*/ false,
            &recorded.runner(),
        );
        assert_eq!(
            outcome.exit_code,
            Some(75),
            "the interactive child's not-attempted code is the process exit code"
        );
    }

    #[test]
    fn a_failed_self_update_fails_the_run() {
        let dir = tempfile::tempdir().unwrap();
        let mut manager = sandbox_manager(dir.path(), None);
        let options = parse(&["update", "--self"]);
        let recorded = RecordedSelfUpdates::new(1);
        let outcome = run_package_update(
            &mut manager,
            options,
            /*stdin_is_terminal*/ false,
            &recorded.runner(),
        );
        assert_eq!(outcome.exit_code, Some(1));
    }
}

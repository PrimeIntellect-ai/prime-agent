//! Public command routing, ported from `cli/public-command.ts`.

use crate::daemon_discovery;
use std::collections::HashSet;

use crate::args::{parse_args, INTERNAL_RUNTIME_COMMAND_MARKER};
use std::io::IsTerminal as _;

use crate::command_registry::{
    find_command_suggestion, format_command_help, format_top_level_help, get_child_command_specs,
    get_command_spec, is_help_command_request, public_command_names, REMOVED_COMMAND_NAMES,
};
use crate::config::APP_NAME;
use crate::global_flags::{extract_help_command_path, rotate_global_flags_before_command};
use crate::mcp_command::run_mcp_management_command;
use crate::package_command::handle_package_command;

/// Environment flag marking an interactive self-update child process.
pub const SELF_UPDATE_INTERACTIVE_CHILD_ENV: &str = "PRIME_AGENT_INTERACTIVE_SELF_UPDATE";

/// Internal update-restart coordinator flags (`cli/daemon-update-restart.ts`).
pub const DAEMON_UPDATE_RESTART_COORDINATOR_FLAG: &str = "--internal-update-restart-coordinator";
pub const DAEMON_UPDATE_RESTART_STATUS_FLAG: &str = "--internal-update-restart-status";
pub const DAEMON_UPDATE_RESTART_ORIGIN_FLAG: &str = "--internal-update-restart-origin";

/// The outcome of routing the argv through the public command layer.
#[derive(Debug, Clone)]
pub struct PublicCommandResult {
    pub handled: bool,
    pub args: Vec<String>,
    pub explicit_agents_view: bool,
    pub attach_agent: Option<String>,
    /// The process exit code to use once handled.
    pub exit_code: Option<i32>,
}

const HANDLED: fn() -> PublicCommandResult = || PublicCommandResult {
    handled: true,
    args: vec![],
    explicit_agents_view: false,
    attach_agent: None,
    exit_code: None,
};

fn continue_with(args: Vec<String>) -> PublicCommandResult {
    PublicCommandResult {
        handled: false,
        args,
        explicit_agents_view: false,
        attach_agent: None,
        exit_code: None,
    }
}

/// The error message used when a routed command needs a runtime subsystem that
/// is not linked into this build yet.
fn fail(message: impl AsRef<str>, hint: Option<String>) -> PublicCommandResult {
    eprintln!("Error: {}", message.as_ref());
    if let Some(hint) = hint {
        eprintln!("{hint}");
    }
    PublicCommandResult {
        handled: true,
        args: vec![],
        explicit_agents_view: false,
        attach_agent: None,
        exit_code: Some(1),
    }
}

fn handled() -> PublicCommandResult {
    HANDLED()
}

/// A handled invocation whose driver already printed everything, with its own
/// process exit code (shutdown failures exit 1).
fn handled_with_exit(exit_code: i32) -> PublicCommandResult {
    PublicCommandResult {
        handled: true,
        args: vec![],
        explicit_agents_view: false,
        attach_agent: None,
        exit_code: Some(exit_code),
    }
}

/// A handled invocation whose `fail()` branch already printed an error: the
/// exit code is 1, matching `process.exitCode = 1` in the TS `fail` helper.
fn handled_failed() -> PublicCommandResult {
    PublicCommandResult {
        handled: true,
        args: vec![],
        explicit_agents_view: false,
        attach_agent: None,
        exit_code: Some(1),
    }
}

/// Route the argv through the public command layer, mirroring
/// `handlePublicCommand`. All errors are printed directly; the result reports
/// whether the invocation was fully handled and with which exit code.
pub fn handle_public_command(args: &[String]) -> PublicCommandResult {
    let public: HashSet<&str> = public_command_names().into_iter().collect();
    let removed: HashSet<&str> = REMOVED_COMMAND_NAMES.iter().copied().collect();
    let args = rotate_global_flags_before_command(args, &public, &removed);

    if args.first().map(String::as_str) == Some("help") {
        if let Some(help_path) = extract_help_command_path(&args, 1) {
            let help_path_ref: Vec<&str> = help_path.iter().map(String::as_str).collect();
            if is_help_command_request(&help_path_ref) {
                return print_requested_help(&help_path);
            }
        }
    }

    let Some(command) = args.first() else {
        return continue_with(args);
    };
    let command = command.as_str();

    if removed.contains(command) {
        return reject_removed_command(&args);
    }
    if !public.contains(command) {
        return continue_with(args.clone());
    }
    if command == "update"
        && args
            .iter()
            .any(|a| a == DAEMON_UPDATE_RESTART_COORDINATOR_FLAG)
    {
        handle_package_command(&args);
        return handled();
    }

    let separator_index = args.iter().position(|a| a == "--");
    let help_index = args.iter().enumerate().position(|(index, arg)| {
        index > 0
            && (separator_index.is_none() || index < separator_index.unwrap())
            && (arg == "--help" || arg == "-h")
    });
    if let Some(help_index) = help_index {
        return print_requested_help(&get_command_path(&args[..help_index]));
    }

    let rest: Vec<String> = args[1..].to_vec();
    match command {
        "agents" => PublicCommandResult {
            handled: false,
            args: rest,
            explicit_agents_view: true,
            attach_agent: None,
            exit_code: None,
        },
        "list" => run_internal_agent_command("list", &rest),
        "attach" => run_attach(&rest),
        "stop" => {
            if !require_operand_count(&rest, 1, Some(1), "stop") {
                return handled_failed();
            }
            run_internal_agent_command("kill", &rest)
        }
        "rename" => {
            if !require_operand_count(&rest, 2, None, "rename") {
                return handled_failed();
            }
            run_internal_agent_command("rename", &rest)
        }
        "send" => run_internal_agent_command("send", &rest),
        "schedule" => run_nested_agent_command("schedule", "cron", &rest),
        "status" => run_status(&rest),
        "doctor" => run_doctor(&rest),
        "shutdown" => run_shutdown(&rest),
        "package" => run_package(&rest),
        "mcp" => run_mcp(&rest),
        "update" => run_update(&rest),
        "model" => rewrite_nested_command("model", "list", "--list-models", &rest),
        "session" => rewrite_nested_command("session", "export", "--export", &rest),
        "prompt" => handled_with_exit(crate::prompt_command::run_prompt_command(&rest)),
        "config" => {
            if !rest.is_empty() {
                return fail(format!("Usage: {APP_NAME} config"), None);
            }
            continue_with(args.clone())
        }
        _ => continue_with(args.clone()),
    }
}

fn print_requested_help(path: &[String]) -> PublicCommandResult {
    if path.is_empty() {
        println!("{}", format_top_level_help());
        return handled();
    }
    if REMOVED_COMMAND_NAMES.contains(&path[0].as_str()) {
        return reject_removed_command(path);
    }
    let path_ref: Vec<&str> = path.iter().map(String::as_str).collect();
    if let Some(help) = format_command_help(&path_ref) {
        println!("{help}");
        return handled();
    }
    let parent: Vec<&str> = path[..path.len() - 1].iter().map(String::as_str).collect();
    let candidates: Vec<&str> = get_child_command_specs(&parent)
        .into_iter()
        .map(|spec| spec.path[spec.path.len() - 1])
        .collect();
    let suggestion = find_command_suggestion(&path[path.len() - 1], &candidates);
    let mut message = format!("Unknown command: {}", path.join(" "));
    let hint = suggestion.map(|suggestion| {
        let mut full = parent.to_vec();
        full.push(suggestion);
        format!("Did you mean \"{APP_NAME} help {}\"?", full.join(" "))
    });
    if suggestion.is_none() {
        // The exact TS message includes no hint when there is no suggestion.
        message = format!("Unknown command: {}", path.join(" "));
    }
    fail(message, hint)
}

fn get_command_path(args: &[String]) -> Vec<String> {
    let mut path: Vec<String> = Vec::new();
    for arg in args {
        let mut candidate: Vec<&str> = path.iter().map(String::as_str).collect();
        candidate.push(arg);
        if get_command_spec(&candidate).is_none() {
            break;
        }
        path.push(arg.clone());
    }
    path
}

fn reject_removed_command(args: &[String]) -> PublicCommandResult {
    let command = args.first().map(String::as_str).unwrap_or_default();
    let subcommand = args.get(1).map(String::as_str);
    let replacement = match (command, subcommand) {
        ("daemon", _) => Some("Run \"prime-agent help\" to see the agent commands.".to_string()),
        ("app", Some("update")) => Some("Use \"prime-agent update\".".to_string()),
        ("install", _) => Some("Use \"prime-agent package install\".".to_string()),
        ("remove" | "uninstall", _) => Some("Use \"prime-agent package remove\".".to_string()),
        ("manage", _) => Some("Use \"prime-agent agents\".".to_string()),
        _ => None,
    };
    let joined: Vec<&str> = args.iter().take(2).map(String::as_str).collect();
    fail(
        format!("Unknown command: {}", joined.join(" ")),
        replacement,
    )
}

/// The internal daemon client command behind a public command: `list` stays
/// `list`, `stop` becomes `kill`, and nested `schedule` becomes `cron`, like
/// `runInternalAgentCommand`/`runNestedAgentCommand` in public-command.ts.
fn run_internal_agent_command(command: &str, args: &[String]) -> PublicCommandResult {
    match crate::daemon_command::run_daemon_command(command, args) {
        Ok(()) => handled(),
        Err(error) => fail(error.to_string(), None),
    }
}

fn run_nested_agent_command(
    parent: &str,
    internal_command: &str,
    args: &[String],
) -> PublicCommandResult {
    let subcommand = args.first().map(String::as_str);
    let children: Vec<&str> = get_child_command_specs(&[parent])
        .into_iter()
        .map(|spec| spec.path[spec.path.len() - 1])
        .collect();
    let Some(subcommand) = subcommand else {
        return fail(
            format!("Missing {parent} command."),
            Some(format!("Run \"{APP_NAME} help {parent}\" for usage.")),
        );
    };
    if !children.contains(&subcommand) {
        let suggestion = find_command_suggestion(subcommand, &children);
        return fail(
            format!("Unknown {parent} command: {subcommand}"),
            Some(suggestion.map_or_else(
                || format!("Run \"{APP_NAME} help {parent}\" for usage."),
                |s| format!("Did you mean \"{APP_NAME} {parent} {s}\"?"),
            )),
        );
    }
    if parent == "schedule" && !validate_schedule_args(args) {
        return handled_failed();
    }
    run_internal_agent_command(internal_command, args)
}

fn validate_schedule_args(args: &[String]) -> bool {
    let subcommand = args[0].as_str();
    if subcommand == "list" {
        let mut agent_count = 0;
        for arg in &args[1..] {
            if arg == "--all" || arg == "-a" || arg == "--json" {
                continue;
            }
            if arg.starts_with('-') {
                fail(
                    "Usage: prime-agent schedule list [--all] [agent] [--json]",
                    None,
                );
                return false;
            }
            agent_count += 1;
            if agent_count > 1 {
                fail(
                    "Usage: prime-agent schedule list [--all] [agent] [--json]",
                    None,
                );
                return false;
            }
        }
        return true;
    }
    if subcommand == "cancel" {
        let operands: Vec<&String> = args[1..].iter().filter(|arg| *arg != "--json").collect();
        if operands.len() == 1 && !operands[0].starts_with('-') {
            return true;
        }
        fail("Usage: prime-agent schedule cancel <job-id>", None);
        return false;
    }
    true
}

/// The parsed `prime-agent update` invocation.
#[derive(Debug, Default, PartialEq, Eq)]
struct UpdateInvocation {
    force: bool,
    rollback: bool,
    channel: Option<pa_core::update::version::UpdateChannel>,
    archive: Option<std::path::PathBuf>,
    source: Option<String>,
}

/// Parse `update`'s options: the TS booleans plus the direct-install pair
/// (`--archive <path>` with the required `--source <https-url>`). Returns
/// `None` on a usage failure (already reported).
fn parse_update_options(args: &[String]) -> Option<UpdateInvocation> {
    let mut invocation = UpdateInvocation::default();
    let mut index = 0;
    let mut channel: Option<&str> = None;
    while index < args.len() {
        let arg = args[index].as_str();
        match arg {
            "--force" => invocation.force = true,
            "--rollback" => invocation.rollback = true,
            "--nightly" | "--stable" => {
                if channel.is_some() && channel != Some(arg) {
                    fail(
                        "--nightly and --stable are exclusive.",
                        Some("Pick one update channel.".to_string()),
                    );
                    return None;
                }
                channel = Some(arg);
            }
            "--archive" | "--source" => {
                let value = match args.get(index + 1) {
                    Some(value) if !value.starts_with('-') => value.clone(),
                    _ => {
                        fail(
                            format!("Missing value for {arg}."),
                            Some(format!("Run \"{APP_NAME} help update\" for usage.")),
                        );
                        return None;
                    }
                };
                if arg == "--archive" {
                    invocation.archive = Some(std::path::PathBuf::from(value));
                } else {
                    invocation.source = Some(value);
                }
                index += 1;
            }
            other => {
                fail(
                    format!("Unknown option for update: {other}"),
                    Some(format!("Run \"{APP_NAME} help update\" for usage.")),
                );
                return None;
            }
        }
        index += 1;
    }
    invocation.channel = match channel {
        Some("--nightly") => Some(pa_core::update::version::UpdateChannel::Nightly),
        Some("--stable") => Some(pa_core::update::version::UpdateChannel::Stable),
        _ => None,
    };
    if invocation.archive.is_some() {
        if invocation.rollback {
            fail(
                "--archive and --rollback are exclusive.",
                Some("Run them separately.".to_string()),
            );
            return None;
        }
        if invocation.channel.is_some() {
            fail(
                "--archive ignores the channel flags.",
                Some("A direct install does not resolve a channel.".to_string()),
            );
            return None;
        }
        if invocation.source.is_none() {
            fail(
                "--archive needs --source <https-url>.",
                Some(
                    "The install source is recorded in the release and future updates resolve from it."
                        .to_string(),
                ),
            );
            return None;
        }
        if !pa_core::update::install::install_source_is_valid(
            invocation.source.as_deref().unwrap_or_default(),
        ) {
            fail(
                "--source must be an http(s) URL.",
                Some(format!("Run \"{APP_NAME} help update\" for usage.")),
            );
            return None;
        }
    } else if invocation.source.is_some() {
        fail(
            "--source is only valid with --archive.",
            Some(format!("Run \"{APP_NAME} help update\" for usage.")),
        );
        return None;
    }
    Some(invocation)
}

fn parse_boolean_options(
    args: &[String],
    allowed: &[&str],
    command: &str,
) -> Option<HashSet<String>> {
    let mut options = HashSet::new();
    for arg in args {
        if !allowed.contains(&arg.as_str()) {
            fail(
                format!("Unknown option for {command}: {arg}"),
                Some(format!("Run \"{APP_NAME} help {command}\" for usage.")),
            );
            return None;
        }
        options.insert(arg.clone());
    }
    Some(options)
}

fn run_status(args: &[String]) -> PublicCommandResult {
    let Some(options) = parse_boolean_options(args, &["--json"], "status") else {
        return handled_failed();
    };
    daemon_discovery::run_ps(
        options.contains("--json"),
        &daemon_discovery::current_state_root(),
    );
    handled()
}

fn run_doctor(args: &[String]) -> PublicCommandResult {
    let Some(options) = parse_boolean_options(args, &["--fix", "--json"], "doctor") else {
        return handled_failed();
    };
    // `doctor` inspects; `doctor --fix` reaps clearly-safe services (TS
    // runDoctor: runReap with force=false, else runPs).
    if options.contains("--fix") {
        daemon_discovery::run_reap(
            options.contains("--json"),
            &daemon_discovery::current_state_root(),
        );
    } else {
        daemon_discovery::run_ps(
            options.contains("--json"),
            &daemon_discovery::current_state_root(),
        );
    }
    handled()
}

fn run_shutdown(args: &[String]) -> PublicCommandResult {
    let Some(options) = parse_boolean_options(args, &["--force", "--json"], "shutdown") else {
        return handled_failed();
    };
    let force = options.contains("--force");
    let json = options.contains("--json");
    // The confirmation decision (including the non-TTY failure, which TS
    // only raises once there are daemons to stop) lives with the discovery
    // driver, which knows the daemon count.
    let exit_code =
        daemon_discovery::run_shutdown_all(json, force, &daemon_discovery::current_state_root());
    handled_with_exit(exit_code)
}

fn run_mcp(args: &[String]) -> PublicCommandResult {
    match run_mcp_management_command(args) {
        Ok(message) => {
            println!("{message}");
            handled()
        }
        Err(error) => fail(error.to_string(), None),
    }
}

fn run_package(args: &[String]) -> PublicCommandResult {
    let Some(subcommand) = args.first().map(String::as_str) else {
        return fail(
            "Missing package command.",
            Some("Run \"prime-agent help package\" for usage.".to_string()),
        );
    };
    if subcommand == "uninstall" {
        return fail(
            "Unknown package command: uninstall",
            Some("Use \"prime-agent package remove\".".to_string()),
        );
    }
    let children: Vec<&str> = get_child_command_specs(&["package"])
        .into_iter()
        .map(|spec| spec.path[spec.path.len() - 1])
        .collect();
    if !children.contains(&subcommand) {
        let suggestion = find_command_suggestion(subcommand, &children);
        return fail(
            format!("Unknown package command: {subcommand}"),
            Some(suggestion.map_or_else(
                || "Run \"prime-agent help package\" for usage.".to_string(),
                |s| format!("Did you mean \"{APP_NAME} package {s}\"?"),
            )),
        );
    }
    let rest = &args[1..];
    if subcommand == "list" && !rest.is_empty() {
        return fail(format!("Usage: {APP_NAME} package list"), None);
    }
    if subcommand == "update" {
        if rest.iter().any(|arg| {
            arg == "--self" || arg == "--extensions" || arg == "--extension" || arg == "--force"
        }) {
            return fail(
                "Package updates accept only an optional source. Use \"prime-agent update --force\" to update Prime Agent.",
                None,
            );
        }
        if rest.len() > 1 {
            return fail(format!("Usage: {APP_NAME} package update [source]"), None);
        }
        if let Some(source) = rest.first() {
            if is_self_update_source(source) {
                return fail("Use \"prime-agent update\" to update Prime Agent.", None);
            }
        }
        let mut package_args: Vec<String> = vec!["update".to_string()];
        if rest.is_empty() {
            package_args.push("--extensions".to_string());
        } else {
            package_args.extend(rest.iter().cloned());
        }
        let result = handle_package_command(&package_args);
        return PublicCommandResult {
            handled: true,
            args: vec![],
            explicit_agents_view: false,
            attach_agent: None,
            exit_code: result.exit_code,
        };
    }
    let mut package_args: Vec<String> = vec![subcommand.to_string()];
    package_args.extend(rest.iter().cloned());
    let result = handle_package_command(&package_args);
    PublicCommandResult {
        handled: true,
        args: vec![],
        explicit_agents_view: false,
        attach_agent: None,
        exit_code: result.exit_code,
    }
}

fn is_self_update_source(source: &str) -> bool {
    source == "self" || source == "pi" || source == APP_NAME
}

fn run_update(args: &[String]) -> PublicCommandResult {
    // The direct-install values must never be mistaken for legacy update
    // targets: the legacy scan runs over the args with the pair consumed,
    // the parse below runs over the original argv.
    let mut stripped: Vec<String> = Vec::with_capacity(args.len());
    let mut index = 0;
    while index < args.len() {
        if args[index] == "--archive" || args[index] == "--source" {
            index += 2;
            continue;
        }
        stripped.push(args[index].clone());
        index += 1;
    }
    let has_legacy_self_target = stripped
        .iter()
        .any(|arg| arg == "--self" || is_self_update_source(arg));
    let has_legacy_package_target = stripped.iter().any(|arg| {
        arg == "--extensions"
            || arg == "--extension"
            || (!arg.starts_with('-') && !is_self_update_source(arg))
    });
    if has_legacy_self_target && has_legacy_package_target {
        return fail(
            "Prime Agent and package updates are now separate.",
            Some("Run \"prime-agent update [--force]\" and \"prime-agent package update [source]\" separately.".to_string()),
        );
    }
    if has_legacy_self_target {
        return fail(
            "An update target is no longer needed.",
            Some("Use \"prime-agent update [--force]\".".to_string()),
        );
    }
    if has_legacy_package_target {
        return fail(
            "Package updates moved to the package command.",
            Some("Use \"prime-agent package update [source]\".".to_string()),
        );
    }
    let Some(options) = parse_update_options(args) else {
        return handled_failed();
    };
    // TS package-manager-cli's update case: the persisted `updateChannel`
    // setting (`/nightly off`) is the default the update follows
    // (`options.channel ?? persistedChannel`), an explicit nightly switch
    // warns and confirms, and a completed run persists the explicit
    // switch (`commitChannel`).
    let agent_dir = crate::config::get_agent_dir();
    let persisted_wire = std::env::current_dir()
        .ok()
        .and_then(|cwd| {
            pa_core::settings::SettingsManager::create(&cwd, &agent_dir).get_update_channel()
        })
        .map(|channel| {
            match channel {
                pa_core::settings::UpdateChannel::Stable => "stable",
                pa_core::settings::UpdateChannel::Nightly => "nightly",
            }
            .to_string()
        });
    if options.channel == Some(pa_core::update::version::UpdateChannel::Nightly)
        && persisted_wire.as_deref() != Some("nightly")
    {
        println!(
            "Nightly releases are unreleased Prime Agent builds. They can be broken, and a broken update can leave Prime Agent unusable until you roll back or reinstall."
        );
        // TS `setSelfUpdateAbortedExitCode`: the interactive child's
        // marker changes the abort code (75 vs 1) so the TUI's update
        // run can tell an aborted switch from a real failure.
        let abort_code = if std::env::var(SELF_UPDATE_INTERACTIVE_CHILD_ENV).as_deref() == Ok("1") {
            75
        } else {
            1
        };
        if !options.force {
            if !std::io::stdin().is_terminal() {
                eprintln!(
                    "Switching to the nightly channel needs confirmation. Re-run with --force to proceed."
                );
                return handled_with_exit(abort_code);
            }
            if !crate::daemon_discovery::stop::prompt_yes_no(
                "Switching to the nightly channel and continue with the update?",
            ) {
                println!("Update cancelled. Nothing was changed.");
                return handled_with_exit(abort_code);
            }
        }
    }
    // The effective channel: an explicit flag wins, else the persisted
    // one, else the running version infers it.
    let channel = options.channel.or_else(|| {
        persisted_wire
            .as_deref()
            .and_then(pa_core::update::version::UpdateChannel::from_wire)
    });

    let command_options = crate::update_flow::update_command::UpdateCommandOptions {
        force: options.force,
        rollback: options.rollback,
        channel,
        archive: options.archive,
        source: options.source,
    };
    let runtime = match tokio::runtime::Builder::new_multi_thread()
        .enable_all()
        .build()
    {
        Ok(runtime) => runtime,
        Err(error) => {
            return fail(
                format!("Could not start the update runtime: {error}."),
                None,
            );
        }
    };
    match runtime.block_on(crate::update_flow::update_command::run_update_command(
        &command_options,
    )) {
        Ok(code) => {
            // TS `commitChannel`: a completed run persists an explicit
            // switch (Complete and Skipped alike — a channel pin applies
            // even when no newer release was needed) and reports it. The
            // not-attempted exit (75) reaches here only as the child-mode
            // no-change skip: a declined confirmation returns earlier and
            // never runs the update flow.
            let flag_wire = options
                .channel
                .map(pa_core::update::version::UpdateChannel::wire_name);
            if (code == 0 || code == 75)
                && flag_wire.is_some()
                && flag_wire != persisted_wire.as_deref()
            {
                let wire = flag_wire.unwrap_or_default();
                if let Ok(cwd) = std::env::current_dir() {
                    let settings_channel = match wire {
                        "nightly" => pa_core::settings::UpdateChannel::Nightly,
                        _ => pa_core::settings::UpdateChannel::Stable,
                    };
                    let mut settings = pa_core::settings::SettingsManager::create(&cwd, &agent_dir);
                    if settings.set_update_channel(settings_channel).is_ok() {
                        println!("Updates now follow the {wire} channel.");
                    }
                }
            }
            PublicCommandResult {
                handled: true,
                args: vec![],
                explicit_agents_view: false,
                attach_agent: None,
                exit_code: Some(code),
            }
        }
        Err(error) => fail(format!("{error:#}"), None),
    }
}

fn run_attach(rest: &[String]) -> PublicCommandResult {
    let Some(agent) = rest.first().filter(|agent| !agent.starts_with('-')) else {
        return fail(format!("Usage: {APP_NAME} attach <agent>"), None);
    };
    let options = &rest[1..];
    if has_positional_arguments(options) {
        return fail(format!("Usage: {APP_NAME} attach <agent>"), None);
    }
    if has_conflicting_attach_option(options) {
        return fail(
            "attach cannot be combined with --resume, --continue, or --fork.",
            None,
        );
    }
    let agent = agent.as_str();
    let mut args: Vec<String> = vec!["--resume".to_string(), agent.to_string()];
    args.extend(options.iter().cloned());
    PublicCommandResult {
        handled: false,
        args,
        explicit_agents_view: false,
        attach_agent: Some(agent.to_string()),
        exit_code: None,
    }
}

fn has_positional_arguments(args: &[String]) -> bool {
    let parsed = parse_args(args);
    !parsed.messages.is_empty() || !parsed.file_args.is_empty()
}

fn has_conflicting_attach_option(args: &[String]) -> bool {
    args.iter().any(|arg| {
        arg == "--resume"
            || arg == "-r"
            || arg.starts_with("--resume=")
            || arg == "--continue"
            || arg == "-c"
            || arg == "--fork"
    })
}

fn rewrite_nested_command(
    parent: &str,
    subcommand: &str,
    flag: &str,
    args: &[String],
) -> PublicCommandResult {
    if args.first().map(String::as_str) != Some(subcommand) {
        let candidate = args.first().map(String::as_str);
        return match candidate {
            Some(candidate) => {
                let suggestion = find_command_suggestion(candidate, &[subcommand]);
                fail(
                    format!("Unknown {parent} command: {candidate}"),
                    Some(suggestion.map_or_else(
                        || format!("Run \"{APP_NAME} help {parent}\" for usage."),
                        |s| format!("Did you mean \"{APP_NAME} {parent} {s}\"?"),
                    )),
                )
            }
            None => fail(
                format!("Missing {parent} command."),
                Some(format!("Run \"{APP_NAME} help {parent}\" for usage.")),
            ),
        };
    }
    let usage = get_command_spec(&[parent, subcommand]).map_or_else(
        || format!("{APP_NAME} {parent} {subcommand}"),
        |spec| format!("{APP_NAME} {}", spec.usage),
    );
    let Some((operands, options)) = split_operands_and_options(&args[1..]) else {
        return fail(format!("Usage: {usage}"), None);
    };
    let valid_count = if parent == "model" {
        operands.len() <= 1
    } else {
        !operands.is_empty() && operands.len() <= 2
    };
    if !valid_count {
        return fail(format!("Usage: {usage}"), None);
    }
    let mut args: Vec<String> = vec![
        INTERNAL_RUNTIME_COMMAND_MARKER.to_string(),
        flag.to_string(),
    ];
    args.extend(operands);
    args.extend(options);
    continue_with(args)
}

fn split_operands_and_options(args: &[String]) -> Option<(Vec<String>, Vec<String>)> {
    let options_start = args.iter().position(|arg| arg.starts_with('-'));
    match options_start {
        None => Some((args.to_vec(), vec![])),
        Some(start) => {
            let options = &args[start..];
            if has_positional_arguments(options) {
                return None;
            }
            Some((args[..start].to_vec(), options.to_vec()))
        }
    }
}

fn require_operand_count(
    args: &[String],
    minimum: usize,
    maximum: Option<usize>,
    command: &str,
) -> bool {
    let mut operands: Vec<&str> = Vec::new();
    let mut index = 0;
    while index < args.len() {
        let arg = args[index].as_str();
        if arg == "--json" {
            index += 1;
            continue;
        }
        if arg == "--socket" || arg == "--daemon-socket" {
            index += 2;
            continue;
        }
        if arg.starts_with('-') {
            fail(
                format!(
                    "Usage: {APP_NAME} {}",
                    get_command_spec(&[command]).map_or(command, |s| s.usage)
                ),
                None,
            );
            return false;
        }
        operands.push(arg);
        index += 1;
    }
    if operands.len() >= minimum && maximum.is_none_or(|max| operands.len() <= max) {
        return true;
    }
    fail(
        format!(
            "Usage: {APP_NAME} {}",
            get_command_spec(&[command]).map_or(command, |s| s.usage)
        ),
        None,
    );
    false
}

#[cfg(test)]
mod update_options_tests {
    use super::*;

    fn parse(args: &[&str]) -> Option<UpdateInvocation> {
        let args: Vec<String> = args.iter().map(std::string::ToString::to_string).collect();
        parse_update_options(&args)
    }

    #[test]
    fn parses_the_ts_booleans() {
        let invocation = parse(&["--force"]).unwrap();
        assert!(invocation.force && !invocation.rollback);
        assert_eq!(invocation.channel, None);
        assert_eq!(invocation.archive, None);
        let invocation = parse(&["--nightly"]).unwrap();
        assert_eq!(
            invocation.channel,
            Some(pa_core::update::version::UpdateChannel::Nightly)
        );
        assert!(parse(&["--nightly", "--stable"]).is_none());
        assert!(parse(&["--unknown"]).is_none());
    }

    #[test]
    fn parses_the_direct_install_pair() {
        let invocation = parse(&[
            "--archive",
            "/tmp/payload",
            "--source",
            "https://example.com",
        ])
        .unwrap();
        assert_eq!(
            invocation.archive,
            Some(std::path::PathBuf::from("/tmp/payload"))
        );
        assert_eq!(invocation.source.as_deref(), Some("https://example.com"));
        // The source must be an http(s) URL and must not appear alone.
        assert!(parse(&[
            "--archive",
            "/tmp/payload",
            "--source",
            "file:///tmp/payload"
        ])
        .is_none());
        assert!(parse(&["--source", "https://example.com"]).is_none());
        // The direct install is exclusive with the channel and rollback.
        assert!(parse(&[
            "--archive",
            "/tmp/payload",
            "--source",
            "https://example.com",
            "--nightly"
        ])
        .is_none());
        assert!(parse(&[
            "--archive",
            "/tmp/payload",
            "--source",
            "https://example.com",
            "--rollback"
        ])
        .is_none());
        // A missing value fails.
        assert!(parse(&["--archive"]).is_none());
        assert!(parse(&["--archive", "--source"]).is_none());
    }
}

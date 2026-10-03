//! Public command routing, ported from `cli/public-command.ts`.

use crate::daemon_discovery;
use std::collections::HashSet;

use crate::args::{parse_args, INTERNAL_RUNTIME_COMMAND_MARKER};

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
use std::io::IsTerminal as _;

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
        "sessions" => run_internal_agent_command("sessions", &rest),
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
        "telemetry" => run_telemetry(&rest),
        "incident" => run_incident_command(&rest),
        "tailscale" => run_tailscale_command(&rest),
        "shutdown" => run_shutdown(&rest),
        "package" => run_package(&rest),
        "mcp" => run_mcp(&rest),
        "update" => run_update(&rest),
        "model" => rewrite_nested_command("model", "list", "--list-models", &rest),
        "session" => rewrite_nested_command("session", "export", "--export", &rest),
        "prompt" => handled_with_exit(crate::prompt_command::run_prompt_command(&rest)),
        "factory" => handled_with_exit(crate::factory_command::run_factory_command(&rest)),
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
        let mut full = parent.clone();
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

/// Parse `update`'s options into the shared [`crate::self_update::SelfUpdateOptions`]:
/// the TS booleans plus the direct-install pair (`--archive <path>` with the
/// required `--source <https-url>`). Returns `None` on a usage failure
/// (already reported).
fn parse_update_options(args: &[String]) -> Option<crate::self_update::SelfUpdateOptions> {
    let mut invocation = crate::self_update::SelfUpdateOptions::default();
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
        // `doctor --json` stays pure JSON; the tailscale detection fact is a
        // human-mode line only.
        if !options.contains("--json") {
            for fact in crate::tailscale::tailscale_doctor_facts() {
                println!("{fact}");
            }
        }
    }
    handled()
}

/// `prime-agent tailscale` (TS `runTailscaleCommand`): parse the argv, then
/// run status (the default) or serve. Every failure path exits non-zero.
fn run_tailscale_command(args: &[String]) -> PublicCommandResult {
    match crate::tailscale::parse_tailscale_args(args) {
        crate::tailscale::TailscaleArgs::Error(message) => {
            println!("{}", crate::tailscale::format::red(&message));
            handled_failed()
        }
        crate::tailscale::TailscaleArgs::Status { json } => {
            handled_with_exit(crate::tailscale::run_tailscale_status(json))
        }
        crate::tailscale::TailscaleArgs::Serve { port, funnel } => {
            handled_with_exit(crate::tailscale::run_tailscale_serve(port, funnel))
        }
    }
}

/// `prime-agent telemetry [status|on|off]`: the same report and settings
/// switch as the `/telemetry` slash command, for the current directory's
/// settings scope.
fn run_telemetry(args: &[String]) -> PublicCommandResult {
    let usage = || fail(format!("Usage: {APP_NAME} telemetry [status|on|off]"), None);
    if args.len() > 1 {
        return usage();
    }
    let cwd = std::env::current_dir().unwrap_or_default();
    let agent_dir = crate::config::get_agent_dir();
    let mut settings = pa_core::settings::SettingsManager::create(&cwd, &agent_dir);
    let report = match args.first().map(String::as_str) {
        None | Some("status") => Ok(pa_core::session_engine::telemetry::telemetry_status_text(
            &settings, &agent_dir,
        )),
        Some(choice @ ("on" | "off")) => {
            pa_core::session_engine::telemetry::set_telemetry_enabled_text(
                &mut settings,
                &agent_dir,
                choice == "on",
            )
        }
        Some(_) => return usage(),
    };
    match report {
        Ok(report) => {
            println!("{report}");
            handled()
        }
        Err(error) => fail(format!("{error:#}"), None),
    }
}

/// `prime-agent incident` (TS `runIncidentCommand`): parse the options,
/// resolve the window once, and print the timeline.
fn run_incident_command(args: &[String]) -> PublicCommandResult {
    let options = match crate::incident::parse_incident_options(args) {
        Ok(options) => options,
        Err(error) => {
            return fail(
                error.to_string(),
                Some(format!("Run \"{APP_NAME} help incident\" for usage.")),
            )
        }
    };
    // Resolve once: re-resolving later can cross UTC midnight and render a
    // different window than the one that was validated.
    let now_ms = crate::util_time::now_ms() as i64;
    let window = match crate::incident::resolve_incident_window(&options, now_ms) {
        Ok(window) => window,
        Err(error) => {
            return fail(
                error.to_string(),
                Some(format!("Run \"{APP_NAME} help incident\" for usage.")),
            )
        }
    };
    if let Err(error) = crate::incident::run_incident(&options, Some(window)) {
        return fail(
            error.to_string(),
            Some(format!("Run \"{APP_NAME} help incident\" for usage.")),
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
                "Package updates accept only an optional source. Use \"prime-agent update\" to update Prime Agent.",
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

/// A `--check` invocation: `--check` (or `--version`) with at most one
/// `--nightly` / `--stable`. `None` when the arguments are not a check.
fn check_invocation(args: &[String]) -> Option<crate::installer_update::UpdateOptions> {
    use pa_core::update::version::UpdateChannel;
    let mut check = false;
    let mut channel = None;
    for arg in args {
        match arg.as_str() {
            "--check" | "--version" => check = true,
            "--nightly" if channel.is_none() => channel = Some(UpdateChannel::Nightly),
            "--stable" if channel.is_none() => channel = Some(UpdateChannel::Stable),
            _ => return None,
        }
    }
    check.then_some(crate::installer_update::UpdateOptions {
        check: true,
        channel,
    })
}

fn run_update(args: &[String]) -> PublicCommandResult {
    // `--check` (alias `--version`) reports without installing, optionally
    // for one channel flag; mixed with anything else the parse below
    // rejects it.
    if let Some(options) = check_invocation(args) {
        return handled_with_exit(crate::installer_update::run(&options));
    }
    let Some(options) = parse_update_options(args) else {
        return handled_failed();
    };
    let persisted_wire = std::env::current_dir()
        .ok()
        .and_then(|cwd| {
            pa_core::settings::SettingsManager::create(&cwd, crate::config::get_agent_dir())
                .get_update_channel()
        })
        .map(crate::self_update::settings_channel_wire_name)
        .map(str::to_string);
    if let Some(abort_code) = crate::self_update::confirm_nightly_switch(
        options.force,
        options.channel,
        persisted_wire.as_deref(),
        std::io::stdin().is_terminal(),
    ) {
        return handled_with_exit(abort_code);
    }
    // The installer funnel serves the bare update and the channel flags:
    // the channel is the flag, else the saved `updateChannel` setting
    // (`/nightly on|off`), else the installed one. `--rollback` and
    // `--archive` stay on the managed-install flow.
    if !options.rollback && options.archive.is_none() {
        let update = crate::installer_update::UpdateOptions {
            check: false,
            channel: options.channel,
        };
        return handled_with_exit(crate::installer_update::run(&update));
    }
    handled_with_exit(crate::self_update::run(&options, persisted_wire.as_deref()))
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

/// The incident command's dispatch contract (the TS public-command.test.ts
/// incident suite): parsed options and a once-resolved window reach
/// `run_incident`; usage errors fail with exit code 1 and the help hint.
#[cfg(test)]
mod incident_dispatch_tests {
    use super::*;

    fn args(values: &[&str]) -> Vec<String> {
        values
            .iter()
            .map(std::string::ToString::to_string)
            .collect()
    }

    #[test]
    fn routes_the_incident_command_with_parsed_window_options() {
        // The routed dispatch parses the options, resolves the window
        // once, and runs the command (over whatever logs exist under the
        // agent dir — the fixture-backed coverage lives in the incident
        // module's own tests); a routed run never fails with a usage
        // error.
        let result = handle_public_command(&args(&[
            "incident",
            "--since",
            "20:02",
            "--until=21:00",
            "--session",
            "abc",
        ]));
        assert!(result.handled);
        assert_eq!(result.exit_code, None);
        assert!(result.args.is_empty());
    }

    #[test]
    fn rejects_unknown_incident_options_with_usage_guidance() {
        let result = handle_public_command(&args(&["incident", "--json"]));
        assert!(result.handled);
        assert_eq!(result.exit_code, Some(1));
    }

    #[test]
    fn rejects_an_unordered_incident_window_with_usage_guidance() {
        let result = handle_public_command(&args(&[
            "incident",
            "--since",
            "2026-09-10T20:30",
            "--until",
            "2026-09-10T20:00",
        ]));
        assert!(result.handled);
        assert_eq!(result.exit_code, Some(1));
    }

    #[test]
    fn rejects_a_bad_incident_time_with_usage_guidance() {
        let result = handle_public_command(&args(&["incident", "--since", "yesterday"]));
        assert!(result.handled);
        assert_eq!(result.exit_code, Some(1));
    }

    #[test]
    fn shows_incident_in_the_top_level_command_list() {
        assert!(format_top_level_help().contains("incident"));
    }

    #[test]
    fn the_incident_help_matches_the_ts_spec() {
        let help = format_command_help(&["incident"]).expect("the incident spec");
        assert!(
            help.contains("Reconstruct a daemon incident from its logs"),
            "{help}"
        );
        assert!(
            help.contains("--since <time>  Window start (ISO date/time, date, or HH:MM today; default: 24h ago)"),
            "{help}"
        );
        assert!(
            help.contains("Times without a timezone are read as UTC"),
            "{help}"
        );
    }
}

#[cfg(test)]
mod update_options_tests {
    use super::*;

    fn parse(args: &[&str]) -> Option<crate::self_update::SelfUpdateOptions> {
        let args: Vec<String> = args.iter().map(std::string::ToString::to_string).collect();
        parse_update_options(&args)
    }

    /// The migration dispatch: the bare command and the report-only flag
    /// never reach the staged-flow parse (`run_update` short-circuits
    /// both before it), so the staged parse keeps its TS shape exactly.
    #[test]
    fn the_bare_and_check_invocations_short_circuit_the_staged_parse() {
        let check = ["--check"];
        let version = ["--version"];
        for args in [&check, &version] {
            let args: Vec<String> = args.iter().map(std::string::ToString::to_string).collect();
            // The staged parse rejects the new flag: only the dispatch
            // accepts it.
            assert!(parse_update_options(&args).is_none(), "{args:?}");
        }
        // The staged flags still parse (the managed-install flow keeps
        // its surface).
        assert!(parse(&["--force"]).is_some());
    }

    #[test]
    fn check_combines_with_one_channel_flag() {
        use pa_core::update::version::UpdateChannel;
        let channel = |args: &[&str]| {
            let args: Vec<String> = args.iter().map(std::string::ToString::to_string).collect();
            check_invocation(&args).map(|options| options.channel)
        };
        assert_eq!(channel(&["--check"]), Some(None));
        assert_eq!(
            channel(&["--nightly", "--version"]),
            Some(Some(UpdateChannel::Nightly))
        );
        assert_eq!(
            channel(&["--check", "--stable"]),
            Some(Some(UpdateChannel::Stable))
        );
        assert_eq!(channel(&[]), None);
        assert_eq!(channel(&["--nightly"]), None);
        assert_eq!(channel(&["--check", "--nightly", "--stable"]), None);
        assert_eq!(channel(&["--check", "--force"]), None);
        assert_eq!(channel(&["--check", "--rollback"]), None);
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

#[cfg(test)]
mod tailscale_dispatch_tests {
    use super::*;

    fn args(values: &[&str]) -> Vec<String> {
        values
            .iter()
            .map(std::string::ToString::to_string)
            .collect()
    }

    #[test]
    fn shows_tailscale_in_the_top_level_command_list() {
        assert!(format_top_level_help().contains("tailscale"));
    }

    #[test]
    fn the_tailscale_help_marks_the_subcommand_optional() {
        let help = format_command_help(&["tailscale"]).expect("the tailscale spec");
        // Bare `tailscale` and `tailscale --json` dispatch to status, so the
        // top-level usage cannot document the subcommand as required.
        assert!(
            help.contains("prime-agent tailscale [status|serve]"),
            "{help}"
        );
        assert!(!help.contains("<status|serve>"), "{help}");
        assert!(help.contains("status"), "{help}");
        assert!(help.contains("serve"), "{help}");
        let serve = format_command_help(&["tailscale", "serve"]).expect("the tailscale serve spec");
        assert!(
            serve.contains("prime-agent tailscale serve --port <n> [--funnel]"),
            "{serve}"
        );
        let status =
            format_command_help(&["tailscale", "status"]).expect("the tailscale status spec");
        assert!(
            status.contains("prime-agent tailscale status [--json]"),
            "{status}"
        );
    }

    #[test]
    fn resolves_tailscale_subcommands_in_command_help() {
        // The detection edge is the pure help route: `help tailscale serve` and
        // a trailing `--help` both resolve to the serve help without reaching
        // the tailscale binary.
        let result = handle_public_command(&args(&["--offline", "help", "tailscale", "serve"]));
        assert!(result.handled);
        assert_eq!(result.exit_code, None);
        let result = handle_public_command(&args(&[
            "--offline",
            "tailscale",
            "serve",
            "--port",
            "3000",
            "--help",
        ]));
        assert!(result.handled);
        assert_eq!(result.exit_code, None);
    }

    #[test]
    fn rejects_a_serve_invocation_without_a_port() {
        let result = handle_public_command(&args(&["tailscale", "serve"]));
        assert!(result.handled);
        assert_eq!(result.exit_code, Some(1));
    }

    #[test]
    fn rejects_json_with_serve() {
        let result =
            handle_public_command(&args(&["tailscale", "serve", "--port", "3000", "--json"]));
        assert!(result.handled);
        assert_eq!(result.exit_code, Some(1));
    }
}

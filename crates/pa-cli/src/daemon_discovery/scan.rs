//! OS-level daemon discovery scans (TS `cli/daemon-ps.ts` scan half): the
//! listening-socket census (`ss` on Linux, `lsof` on macOS), the pid census,
//! and uptime enrichment. Parsing is pure and unit-tested against the exact
//! tool output shapes; the process spawning is Unix-only behind this module
//! (Windows daemons live on one named pipe per machine, so there is nothing
//! to sweep - TS returns [] there too).

use std::collections::HashMap;
use std::path::{Path, PathBuf};

use super::{state_root_matches, DaemonStateRoot, DiscoveredDaemonProcess};

/// Linux comm names (and thus the process name `ss` reports) cap at 15 chars.
const MAX_COMM_LENGTH: usize = 15;

/// True when an `ss`/`ps`-reported process name is this product: the exact
/// app name, or its 15-char comm truncation.
fn process_name_matches(name: &str, app_name: &str) -> bool {
    name == app_name || app_name.get(..MAX_COMM_LENGTH) == Some(name)
}

/// Lexical socket identity (TS `normalizeSocketPath`): the absolute path,
/// without requiring the socket to exist.
fn normalize_socket_path(path: &str) -> PathBuf {
    let absolute = Path::new(path);
    if absolute.is_absolute() {
        absolute.to_path_buf()
    } else {
        std::env::current_dir()
            .unwrap_or_else(|_| PathBuf::from("."))
            .join(path)
    }
}

/// Parse `ss -lxp` output into the product daemons listening on unix sockets
/// (TS `parseSsListeners`): LISTEN rows with a unix socket path and an owner
/// process named like the app.
pub(crate) fn parse_ss_listeners(stdout: &str, app_name: &str) -> Vec<DiscoveredDaemonProcess> {
    let mut daemons = Vec::new();
    for line in stdout.split('\n') {
        let fields: Vec<&str> = line.split_whitespace().collect();
        if fields.len() < 5 || fields[1] != "LISTEN" {
            continue;
        }
        let socket_path = fields[4];
        if !socket_path.starts_with('/') {
            continue;
        }
        let Some((name, pid)) = ss_listener_owner(line) else {
            continue;
        };
        if !process_name_matches(name, app_name) {
            continue;
        }
        daemons.push(DiscoveredDaemonProcess {
            pid,
            socket_path: normalize_socket_path(socket_path),
            uptime_seconds: None,
        });
    }
    daemons
}

/// `users:(("name",pid=123,...))` — the first owner of a listening socket.
fn ss_listener_owner(line: &str) -> Option<(&str, u32)> {
    let marker = line.find("users:((\"")?;
    let rest = &line[marker + "users:((\"".len()..];
    let name = rest.split('"').next()?;
    let pid = rest
        .find("pid=")
        .and_then(|at| rest[at + 4..].split(|c: char| !c.is_ascii_digit()).next())
        .and_then(|digits| digits.parse().ok())?;
    Some((name, pid))
}

/// Parse `lsof -nP -F pn -U` output into listening unix socket owners, one
/// per (pid, socket) pair (TS `parseLsofListeners`).
pub(crate) fn parse_lsof_listeners(stdout: &str) -> Vec<DiscoveredDaemonProcess> {
    let mut daemons = Vec::new();
    let mut seen = std::collections::HashSet::new();
    let mut pid: Option<u32> = None;
    for line in stdout.split('\n') {
        let Some(field) = line.chars().next() else {
            continue;
        };
        let value = &line[1..];
        if field == 'p' {
            pid = value.parse().ok();
        } else if field == 'n' && value.starts_with('/') {
            let Some(pid) = pid else { continue };
            let socket_path = normalize_socket_path(value);
            if seen.insert((pid, socket_path.clone())) {
                daemons.push(DiscoveredDaemonProcess {
                    pid,
                    socket_path,
                    uptime_seconds: None,
                });
            }
        }
    }
    daemons
}

/// Parse `ps -axo pid=,comm=,args=` output into pids whose command or argv0
/// names this product (TS `parsePrimeAgentProcessIds`).
pub(crate) fn parse_prime_agent_process_ids(stdout: &str, app_name: &str) -> Vec<u32> {
    let mut pids = Vec::new();
    for line in stdout.split('\n') {
        let trimmed = line.trim_start();
        let mut fields = trimmed.splitn(2, char::is_whitespace);
        let Some(pid) = fields.next().and_then(|value| value.parse().ok()) else {
            continue;
        };
        let rest = fields.next().unwrap_or("").trim_start();
        let mut rest_fields = rest.splitn(2, char::is_whitespace);
        let command = rest_fields.next().unwrap_or("");
        let args = rest_fields.next().unwrap_or("").trim();
        let argv0 = args.split_whitespace().next().unwrap_or("");
        let command_base = Path::new(command)
            .file_name()
            .map(|name| name.to_string_lossy().to_string())
            .unwrap_or_default();
        let argv0_base = Path::new(argv0)
            .file_name()
            .map(|name| name.to_string_lossy().to_string())
            .unwrap_or_default();
        if process_name_matches(&command_base, app_name)
            || process_name_matches(&argv0_base, app_name)
        {
            pids.push(pid);
        }
    }
    pids
}

/// Parse `ps -o pid=,etimes=` output into a pid → uptime-seconds map
/// (TS `parsePsEtimes`).
pub(crate) fn parse_ps_etimes(stdout: &str) -> HashMap<u32, u64> {
    let mut uptimes = HashMap::new();
    for line in stdout.split('\n') {
        let trimmed = line.trim();
        let mut fields = trimmed.split_whitespace();
        let (Some(pid), Some(seconds)) = (fields.next(), fields.next()) else {
            continue;
        };
        if let (Ok(pid), Ok(seconds)) = (pid.parse(), seconds.parse()) {
            uptimes.insert(pid, seconds);
        }
    }
    uptimes
}

/// Run one command, capturing stdout; a missing tool or failure yields None
/// (TS `spawnSyncHidden` + error/status guards).
fn capture_stdout(program: &str, args: &[&str]) -> Option<String> {
    let output = std::process::Command::new(program)
        .args(args)
        .stdin(std::process::Stdio::null())
        .output()
        .ok()?;
    if output.status.success() {
        Some(String::from_utf8_lossy(&output.stdout).to_string())
    } else {
        None
    }
}

/// Union of discovered processes by pid + socket (TS `mergeDiscoveredDaemonProcesses`).
pub(crate) fn merge_discovered(
    groups: &[Vec<DiscoveredDaemonProcess>],
) -> Vec<DiscoveredDaemonProcess> {
    let mut by_identity = std::collections::HashMap::new();
    for group in groups {
        for daemon in group {
            by_identity.insert((daemon.pid, daemon.socket_path.clone()), daemon.clone());
        }
    }
    by_identity.into_values().collect()
}

/// Attach `ps` uptimes to the discovered daemons (TS `enrichUptimes`).
fn enrich_uptimes(mut daemons: Vec<DiscoveredDaemonProcess>) -> Vec<DiscoveredDaemonProcess> {
    if daemons.is_empty() {
        return daemons;
    }
    let pids: Vec<String> = daemons
        .iter()
        .map(|daemon| daemon.pid.to_string())
        .collect();
    let Some(stdout) = capture_stdout("ps", &["-o", "pid=,etimes=", "-p", &pids.join(",")]) else {
        return daemons;
    };
    let uptimes = parse_ps_etimes(&stdout);
    for daemon in &mut daemons {
        daemon.uptime_seconds = uptimes.get(&daemon.pid).copied();
    }
    daemons
}

/// Every listening product daemon the OS reports inside the given state
/// root (TS `scanAllListeningDaemons`): `ss -lxp` on Linux; `lsof` (by name
/// and by pid) on macOS. The root filter runs here — before the uptime
/// enrichment and before any caller sees a result — so a daemon outside the
/// root an invocation was handed is never enumerated as a target, probed,
/// or signaled. Paths on the never-touch list are excluded even when the
/// root itself points at them (see the module docs).
pub(crate) fn scan_all_listening_daemons(
    app_name: &str,
    root: &DaemonStateRoot,
) -> Vec<DiscoveredDaemonProcess> {
    let machine_wide = scan_listening_daemons_machine_wide(app_name);
    let in_root: Vec<DiscoveredDaemonProcess> = machine_wide
        .into_iter()
        .filter(|daemon| state_root_matches(root, &daemon.socket_path))
        .collect();
    enrich_uptimes(in_root)
}

/// The raw OS census, machine-wide (TS `scanAllListeningDaemons`): callers
/// must filter to a state root before acting on any result.
fn scan_listening_daemons_machine_wide(app_name: &str) -> Vec<DiscoveredDaemonProcess> {
    if let Some(stdout) = capture_stdout("ss", &["-lxp"]) {
        return parse_ss_listeners(&stdout, app_name);
    }
    let mut by_name = Vec::new();
    if let Some(stdout) = capture_stdout("lsof", &["-nP", "-F", "pn", "-U", "-a", "-c", app_name]) {
        by_name = parse_lsof_listeners(&stdout);
    }
    let mut by_pid = Vec::new();
    if let Some(stdout) = capture_stdout("ps", &["-axo", "pid=,comm=,args="]) {
        let pids = parse_prime_agent_process_ids(&stdout, app_name);
        if !pids.is_empty() {
            let pid_list = pids
                .iter()
                .map(|pid| pid.to_string())
                .collect::<Vec<_>>()
                .join(",");
            if let Some(stdout) =
                capture_stdout("lsof", &["-nP", "-F", "pn", "-U", "-a", "-p", &pid_list])
            {
                by_pid = parse_lsof_listeners(&stdout);
            }
        }
    }
    merge_discovered(&[by_name, by_pid])
}

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

/// Parse `/proc/net/unix` rows into (inode, path) pairs for *listening*
/// unix sockets: the accept-connections flag `SS_ACCEPTCONN` (kernel
/// include/uapi/linux/net.h, hex `00010000`) plus a filesystem path.
/// Format: `Num RefCount Protocol Flags Type St Inode Path`.
///
/// Byte-level on purpose: a unix socket pathname may contain any byte
/// sequence (unix(7) — one non-UTF-8 name anywhere in the file must not
/// reject the whole census), and it may contain spaces, so the first seven
/// columns parse separately and the *remainder* of each line is the path.
/// A row whose pathname is not valid UTF-8 drops out on its own (product
/// socket paths are UTF-8; the rest of the census stands). The header row
/// fails the hex flag parse and drops out; unnamed and non-listening rows
/// (no path, or no `SS_ACCEPTCONN`) drop out too.
#[cfg(target_os = "linux")]
fn parse_proc_net_unix(bytes: &[u8]) -> Vec<(String, String)> {
    const SS_ACCEPTCONN: u32 = 0x0001_0000;
    let mut listeners = Vec::new();
    for line in bytes.split(|byte| *byte == b'\n') {
        // The kernel pads the fixed columns with runs of spaces (`splitn`
        // counts every space, so a naive 8-way split reads the padding as
        // an empty column and the inode lands in the path slot): scan seven
        // whitespace-collapsed tokens, then keep the whole remainder as the
        // pathname, spaces included.
        let mut rest = line;
        let mut columns: Vec<&[u8]> = Vec::with_capacity(7);
        for _ in 0..7 {
            rest = skip_ascii_whitespace(rest);
            let Some((token, after)) = split_first_token(rest) else {
                break;
            };
            columns.push(token);
            rest = after;
        }
        if columns.len() < 7 {
            continue;
        }
        let path = skip_ascii_whitespace(rest);
        let Some(flags) = std::str::from_utf8(columns[3])
            .ok()
            .and_then(|flags| u32::from_str_radix(flags, 16).ok())
        else {
            continue;
        };
        if flags & SS_ACCEPTCONN == 0 {
            continue;
        }
        let Some(path) = std::str::from_utf8(path).ok() else {
            continue;
        };
        if !path.starts_with('/') {
            continue;
        }
        let Some(inode) = std::str::from_utf8(columns[6]).ok() else {
            continue;
        };
        listeners.push((inode.to_string(), path.to_string()));
    }
    listeners
}

/// Skip leading ASCII whitespace bytes.
#[cfg(target_os = "linux")]
fn skip_ascii_whitespace(bytes: &[u8]) -> &[u8] {
    let start = bytes
        .iter()
        .position(|byte| !byte.is_ascii_whitespace())
        .unwrap_or(bytes.len());
    &bytes[start..]
}

/// Split the first whitespace-terminated token from the front of the row:
/// the token, and the bytes after it (None when the row is exhausted).
#[cfg(target_os = "linux")]
fn split_first_token(bytes: &[u8]) -> Option<(&[u8], &[u8])> {
    if bytes.is_empty() {
        return None;
    }
    let end = bytes
        .iter()
        .position(|byte| byte.is_ascii_whitespace())
        .unwrap_or(bytes.len());
    Some((&bytes[..end], &bytes[end..]))
}

/// Every live process and the unix-socket inodes it holds, from
/// `/proc/<pid>/fd/*` symlinks shaped `socket:[<inode>]`, with the pid's
/// `/proc/<pid>/comm` name. Ascending pid order keeps the census
/// deterministic; processes whose fd directory or comm cannot be read
/// (permission, or the process exited mid-scan) are skipped silently.
#[cfg(target_os = "linux")]
fn proc_socket_inodes() -> Vec<(u32, String, std::collections::HashSet<String>)> {
    let mut processes = Vec::new();
    let Ok(entries) = std::fs::read_dir("/proc") else {
        return processes;
    };
    for entry in entries.flatten() {
        let Some(pid) = entry
            .file_name()
            .to_str()
            .and_then(|name| name.parse::<u32>().ok())
        else {
            continue;
        };
        let Ok(comm) = std::fs::read_to_string(format!("/proc/{pid}/comm")) else {
            continue;
        };
        let mut inodes = std::collections::HashSet::new();
        if let Ok(fds) = std::fs::read_dir(format!("/proc/{pid}/fd")) {
            for fd in fds.flatten() {
                let Ok(target) = fd.path().read_link() else {
                    continue;
                };
                let Some(target) = target.to_str() else {
                    continue;
                };
                if let Some(rest) = target.strip_prefix("socket:[") {
                    if let Some(inode) = rest.strip_suffix(']') {
                        inodes.insert(inode.to_string());
                    }
                }
            }
        }
        processes.push((pid, comm.trim_end().to_string(), inodes));
    }
    processes.sort_by_key(|process| process.0);
    processes
}

/// The dependency-free Linux listening census (operator-mandated fallback
/// for tool-less root-user systems; see PORTING-NOTES.md): map
/// `/proc/net/unix` listeners to their owning pids and keep those whose
/// comm name is this product. Visibility matches `ss -lxp`: uid 0 sees
/// every daemon on the machine, an unprivileged user only its own — other
/// users' `/proc/<pid>/fd` is unreadable, exactly the pid info `ss` hides
/// from non-root callers. TS has no equivalent fallback (`daemon-ps.ts`
/// yields nothing without `ss`/`lsof`), so the three discovery e2e tests
/// fail on stock root-user Linux images that ship neither tool.
#[cfg(target_os = "linux")]
fn scan_proc_listeners(app_name: &str) -> Vec<DiscoveredDaemonProcess> {
    let Ok(unix) = std::fs::read("/proc/net/unix") else {
        return Vec::new();
    };
    let listeners = parse_proc_net_unix(&unix);
    if listeners.is_empty() {
        return Vec::new();
    }
    let mut daemons = Vec::new();
    for (pid, comm, inodes) in proc_socket_inodes() {
        if !process_name_matches(&comm, app_name) {
            continue;
        }
        for (inode, path) in &listeners {
            if inodes.contains(inode) {
                daemons.push(DiscoveredDaemonProcess {
                    pid,
                    socket_path: normalize_socket_path(path),
                    uptime_seconds: None,
                });
            }
        }
    }
    daemons
}

/// Non-Linux platforms have no `/proc`; the fallback census finds nothing.
#[cfg(not(target_os = "linux"))]
fn scan_proc_listeners(_app_name: &str) -> Vec<DiscoveredDaemonProcess> {
    Vec::new()
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
/// must filter to a state root before acting on any result. The `/proc`
/// fallback joins the `lsof` groups so a system with neither `ss` nor
/// `lsof` (the stock root-user Linux images the gate runs on) still gets a
/// real census instead of a silently empty one.
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
    let from_proc = scan_proc_listeners(app_name);
    merge_discovered(&[by_name, by_pid, from_proc])
}

#[cfg(test)]
mod tests {
    use super::*;

    /// The exact `/proc/net/unix` row shapes observed on Linux 6.1
    /// (bookworm): a listening row with a path, an unnamed connected row,
    /// and a bound-but-not-listening row.
    #[cfg(target_os = "linux")]
    #[test]
    fn parse_proc_net_unix_keeps_listening_rows_with_paths_only() {
        let sample = b"Num       RefCount Protocol Flags    Type St Inode Path\n\
0000000047ecc27d: 00000002 00000000 00010000 0001 01  9703 /tmp/agent/daemon.sock\n\
0000000000ac5346: 00000003 00000000 00000000 0001 03  9700\n\
0000000047ecc280: 00000002 00000000 00000000 0001 01  9710 /tmp/agent/bound.sock\n";
        let listeners = parse_proc_net_unix(sample);
        assert_eq!(
            listeners,
            vec![("9703".to_string(), "/tmp/agent/daemon.sock".to_string())],
            "only the SS_ACCEPTCONN row with a filesystem path counts"
        );
    }

    /// A pathname with spaces must survive whole (the remainder of the line
    /// is the path), and one non-UTF-8 pathname elsewhere in the file must
    /// not reject the census (unix(7) allows arbitrary path bytes).
    #[cfg(target_os = "linux")]
    #[test]
    fn parse_proc_net_unix_keeps_spaced_and_survives_non_utf8_paths() {
        let mut sample = (*b"Num RefCount Protocol Flags Type St Inode Path\n\
0000000047ecc27d: 00000002 00000000 00010000 0001 01  9703 /tmp/agent sandbox/daemon.sock\n")
            .to_vec();
        sample.extend_from_slice(
            b"0000000047ecc280: 00000002 00000000 00010000 0001 01  9710 /tmp/agent/",
        );
        sample.push(0xff);
        sample.extend_from_slice(b"\xff/daemon.sock\n");
        let listeners = parse_proc_net_unix(&sample);
        assert_eq!(
            listeners,
            vec![("9703".to_string(), "/tmp/agent sandbox/daemon.sock".to_string())],
            "the spaced path is kept whole; the non-UTF-8 row drops out alone, never rejecting the census"
        );
    }

    /// The ss text parse and the /proc parse must agree on the same
    /// listener: same pid, same socket path.
    #[cfg(target_os = "linux")]
    #[test]
    fn proc_and_ss_parsers_agree_on_one_listener() {
        let ss_line = "u_str LISTEN 0      4096   /tmp/agent/daemon.sock 21049121            * 0    users:((\"prime-agent\",pid=123,fd=14))\n";
        let ss = parse_ss_listeners(ss_line, "prime-agent");
        let proc_rows = parse_proc_net_unix(
            b"Num RefCount Protocol Flags Type St Inode Path\n0000000047ecc27d: 00000002 00000000 00010000 0001 01  9703 /tmp/agent/daemon.sock\n",
        );
        // The /proc half maps inode 9703 to pid 123 through fd symlinks;
        // the parser-level parity check uses the matching shape directly.
        assert_eq!(ss.len(), 1);
        assert_eq!(proc_rows.len(), 1);
        assert_eq!(ss[0].socket_path.to_string_lossy(), proc_rows[0].1);
        assert_eq!(ss[0].pid, 123);
        assert!(proc_rows[0].0.contains("9703"));
    }

    #[test]
    fn ss_parse_skips_foreign_process_names() {
        let sample = "u_str LISTEN 0      4096   /tmp/bus.sock 1 * 0    users:((\"dbus-daemon\",pid=7,fd=3))\n";
        assert!(parse_ss_listeners(sample, "prime-agent").is_empty());
    }
}

//! The session-hold refusal: what a create or open answers when a live
//! process this daemon does not host holds the session file's runtime lease.
//!
//! The TS and Rust products share one session store (`~/.prime/agent`,
//! the sessions dir and its `session-leases` table) but never share a
//! daemon, so the holder of a refused file is, in the everyday case, the
//! *other* product: a session open in the TypeScript version refuses to
//! open in this one (and vice versa). The refusal names the holder's
//! product by resolving its pid to the process image and classifying the
//! executable - best-effort by design, the same contract as the liveness
//! probes: an unresolvable holder stays anonymous rather than a wrong
//! claim - and it is actionable (operator-directed): the two paths out
//! carry copy-pasteable commands, never a bare description - continue in
//! the holder's product (the exact `--resume` command for it), or take the
//! session over on this daemon (`kill` the holder, then retry). The daemon
//! logs every refused create (the supervisor's rotating log), so a
//! silent-looking failure still leaves a clear record.

use crate::lease::SessionAlreadyActiveError;
use crate::protocol::{response_failure, DaemonResponse};
use std::path::Path;

/// The live holder of a refused session file, as the lease record names
/// it: the process identity (pid) and, when the holder recorded one, its
/// active session id. Both the daemon's typed lease rejection and the
/// CLI's read-only lease probe reduce to this shape before rendering.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct HoldIdentity {
    pub pid: Option<u32>,
    pub active_session_id: Option<String>,
}

impl HoldIdentity {
    /// From the typed lease rejection (the create/open failure the
    /// worker raises against a live foreign owner).
    fn from_error(error: &SessionAlreadyActiveError) -> Self {
        Self {
            pid: error.holder_pid,
            active_session_id: error.active_session_id.clone(),
        }
    }

    /// The holder identity the refusal names: the holder's active session
    /// id when it recorded one, else the pid, else the anonymous fallback.
    fn holder_id(&self) -> String {
        if let Some(id) = self
            .active_session_id
            .as_deref()
            .filter(|id| !id.is_empty())
        {
            return id.to_string();
        }
        match self.pid {
            Some(pid) => format!("pid {pid}"),
            None => "another process".to_string(),
        }
    }
}

/// Which product a live holder's process image belongs to. The
/// classification is a claim about *what to tell the user*, not a
/// security boundary: it errs toward the generic wording whenever the
/// executable cannot be resolved or does not match a known shape.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum HolderFlavor {
    /// This Rust build (another window or daemon of the same binary, a
    /// `prime-agent-rust` install, or a cargo dev build).
    ThisBuild,
    /// The TypeScript product: its release binary is named `prime-agent`
    /// (the Mach-O and npm installs both), and source/dev installs run
    /// under node, bun, or deno.
    TypeScriptProduct,
    /// A process the classifier cannot name.
    AnotherProcess,
}

/// Resolve a live holder's process image, classified: the pid maps to
/// the executable (best-effort, the liveness-probe contract), which names
/// the product flavor and the take-over line's what-you-are-killing
/// annotation. `None` (unresolvable) classifies anonymously and resolves
/// no executable.
fn holder_process(pid: Option<u32>) -> (HolderFlavor, Option<std::path::PathBuf>) {
    let exe = pid
        .and_then(pa_types::platform::process::process_executable_path)
        .map(|path| path.canonicalize().unwrap_or(path));
    let own = std::env::current_exe()
        .ok()
        .map(|path| path.canonicalize().unwrap_or(path));
    let flavor = classify_from(exe.as_deref(), own.as_deref());
    (flavor, exe)
}

/// The classification core, factored for tests: `exe` is the holder's
/// resolved process image, `own_exe` this process's own. Order matters —
/// the rust checks run first and the TS claim is never made about a rust
/// binary — and the path checks match whole path COMPONENTS (platform
/// separators, no raw substrings): an arbitrary parent directory named
/// `target` must not claim a TypeScript holder, and a Windows cargo build
/// (`target\debug\prime-agent.exe`) classifies the same as a Unix one.
pub fn classify_from(exe: Option<&Path>, own_exe: Option<&Path>) -> HolderFlavor {
    let Some(exe) = exe else {
        return HolderFlavor::AnotherProcess;
    };
    if let Some(own) = own_exe {
        if exe == own {
            return HolderFlavor::ThisBuild;
        }
    }
    let components: Vec<String> = exe
        .components()
        .map(|component| component.as_os_str().to_string_lossy().to_lowercase())
        .collect();
    if components
        .iter()
        .any(|component| component == "prime-agent-rust")
    {
        return HolderFlavor::ThisBuild;
    }
    if let Some(index) = components
        .iter()
        .position(|component| component == "target")
    {
        // A cargo build tree answers its profile directory
        // (`<repo>/target/<profile>/...`); anything else named `target`
        // is not evidence about this product.
        let profile = components
            .get(index + 1)
            .map(String::as_str)
            .unwrap_or_default();
        if matches!(profile, "debug" | "release" | "bench" | "test") {
            return HolderFlavor::ThisBuild;
        }
    }
    let name = exe
        .file_name()
        .map(|name| name.to_string_lossy().to_lowercase())
        .unwrap_or_default();
    if name.contains("node") || name.contains("bun") || name.contains("deno") {
        return HolderFlavor::TypeScriptProduct;
    }
    if name.contains("prime-agent") {
        return HolderFlavor::TypeScriptProduct;
    }
    HolderFlavor::AnotherProcess
}

/// The user-facing refusal for a session file a live foreign process
/// holds: the holder's pid is resolved and classified live, then rendered
/// with the session's identity (the footer grounds the message in what
/// the picker names). `session_path` is the refused file (the name probe
/// is best-effort: an unreadable file renders without the name, never
/// fails the refusal).
pub fn refusal_message(hold: &HoldIdentity, session_path: Option<&Path>) -> String {
    let (flavor, holder_exe) = holder_process(hold.pid);
    refusal_for_flavor(flavor, hold, session_path, holder_exe.as_deref())
}

/// The holder's recorded identity for the footer and the `--resume`
/// commands: its active session id, else the file path the picker names.
fn session_label(hold: &HoldIdentity, session_path: Option<&Path>) -> String {
    if let Some(id) = hold
        .active_session_id
        .as_deref()
        .filter(|id| !id.is_empty())
    {
        return id.to_string();
    }
    session_path
        .map(|path| path.display().to_string())
        .unwrap_or_else(|| "this session".to_string())
}

/// The session's name from its durable file, for the footer (best-effort:
/// the lease is held, but reading the file for its name never fails the
/// refusal). A bounded-cost scan, not a full load: the refusal fires
/// while the holder is live and the file may be large or still growing,
/// so this reads line by line (constant memory) and parses only the
/// `session_info` candidates — the latest one wins, exactly like
/// `SessionFile::session_name`.
fn session_name_of(session_path: Option<&Path>) -> Option<String> {
    use std::io::BufRead;
    let path = session_path?;
    let file = std::fs::File::open(path).ok()?;
    let mut name = None;
    for line in std::io::BufReader::new(file).lines() {
        let Ok(line) = line else {
            break;
        };
        if !line.contains("\"session_info\"") {
            continue;
        }
        let Ok(value) = serde_json::from_str::<serde_json::Value>(&line) else {
            continue;
        };
        if value.get("type").and_then(serde_json::Value::as_str) != Some("session_info") {
            continue;
        }
        if let Some(found) = value.get("name").and_then(serde_json::Value::as_str) {
            let trimmed = found.trim();
            if !trimmed.is_empty() {
                name = Some(trimmed.to_string());
            }
        }
    }
    name
}

/// The take-over option: kill the holder and retry. With a resolved pid
/// the `kill` is the surgical command; without one the state-root sweep
/// (`shutdown --force`, which stops every daemon it discovers) is the
/// honest fallback. The sweep binary is the flavor's own product.
fn take_over_lines(
    hold: &HoldIdentity,
    sweep_binary: &str,
    holder_exe: Option<&Path>,
) -> Vec<String> {
    let mut lines = vec!["• Take over on this daemon:".to_string()];
    match hold.pid {
        Some(pid) => {
            // The kill line names what would be killed when the resolved
            // image is known: a stale pid could belong to a reused pid by
            // the time the user runs it, and the annotation lets a human
            // sanity-check before the signal (the retry path needs no
            // kill at all once the holder exits - the lease unlocks).
            let kill = match holder_exe
                .and_then(|exe| exe.file_name())
                .map(|name| name.to_string_lossy().to_string())
            {
                Some(image) => format!("  kill {pid} — the holder is {image}"),
                None => format!("  kill {pid}"),
            };
            lines.push(kill);
            lines.push("  Then retry — the file unlocks when the holder exits.".to_string());
        }
        None => {
            lines.push(format!("  {sweep_binary} shutdown --force"));
            lines.push("  Then retry — it stops every daemon in the state root.".to_string());
        }
    }
    lines
}

/// The footer: the session's id (or file path) with its name, the same
/// identity the session picker shows.
fn session_footer(hold: &HoldIdentity, session_path: Option<&Path>) -> String {
    let label = session_label(hold, session_path);
    match session_name_of(session_path) {
        Some(name) => format!("Session: {label} ({name})"),
        None => format!("Session: {label}"),
    }
}

/// The refusal text for a classified holder: what happened (the
/// classified headline), then the paths out with copy-pasteable commands
/// (operator-directed): continue in the holder's product, or take the
/// session over on this daemon. The TypeScript product owns the session
/// it holds, so its continue option is the TS `--resume` command — the
/// one product that daemon serves; this-build holders point at the other
/// daemon's socket (the `--daemon-socket` flag connects to it), and an
/// anonymous holder claims nothing. Split from [`refusal_message`] so the
/// exact wording stays testable against a synthetic classification, not a
/// live foreign process.
pub fn refusal_for_flavor(
    flavor: HolderFlavor,
    hold: &HoldIdentity,
    session_path: Option<&Path>,
    holder_exe: Option<&Path>,
) -> String {
    let holder_id = hold.holder_id();
    let id = hold
        .active_session_id
        .as_deref()
        .filter(|id| !id.is_empty());
    let mut lines = Vec::new();
    match flavor {
        HolderFlavor::TypeScriptProduct => {
            lines.push(format!(
                "This session is currently open in your TypeScript version of Prime Agent \
(active in {holder_id}). The Rust and TS versions share the same session store but not \
the same daemon, so this build cannot open the file while that process holds it."
            ));
            lines.push(String::new());
            lines.push("• Continue where you left off:".to_string());
            match id {
                Some(id) => {
                    lines.push(format!("  prime-agent --resume {id}"));
                    lines.push(
                        "  (switch to the TypeScript product — its daemon owns this session)"
                            .to_string(),
                    );
                }
                None => {
                    lines.push("  prime-agent --resume".to_string());
                    lines
                        .push("  (switch to the TypeScript product and pick the session — its daemon owns this session)"
                            .to_string());
                }
            }
            lines.push(String::new());
            lines.extend(take_over_lines(hold, "prime-agent", holder_exe));
        }
        HolderFlavor::ThisBuild => {
            lines.push(format!(
                "This session is currently open in another Rust build of Prime Agent \
(active in {holder_id}) — another daemon or window of this product holds the file's \
runtime lease."
            ));
            lines.push(String::new());
            lines.push("• Continue where you left off:".to_string());
            match id {
                Some(id) => {
                    lines.push(format!(
                        "  prime-agent-rust --daemon-socket <socket> --resume {id}"
                    ));
                    lines.push(
                        "  (<socket> is that instance's daemon socket, from the shell where \
you started it — that daemon owns this session)"
                            .to_string(),
                    );
                }
                None => {
                    lines.push("  prime-agent-rust --resume".to_string());
                    lines.push(
                        "  (switch to the window or shell where that instance is running — its \
daemon owns this session)"
                            .to_string(),
                    );
                }
            }
            lines.push(String::new());
            lines.extend(take_over_lines(hold, "prime-agent-rust", holder_exe));
        }
        HolderFlavor::AnotherProcess => {
            lines.push(format!(
                "This session is currently open in another process \
(active in {holder_id}) — a live process this daemon does not host holds the file's \
runtime lease."
            ));
            lines.push(String::new());
            lines.extend(take_over_lines(hold, "prime-agent-rust", holder_exe));
        }
    }
    lines.push(String::new());
    lines.push(session_footer(hold, session_path));
    lines.join("\n")
}

/// The create response for a create the runtime lease refused: the typed
/// rejection answers with the user-facing refusal and its wire info
/// (`session_already_active`, the TS `serializeDaemonError` shape); any
/// other create failure keeps its raw error text.
pub(crate) fn create_failure_response(error: &anyhow::Error) -> DaemonResponse {
    match error.downcast_ref::<SessionAlreadyActiveError>() {
        Some(active) => response_failure(
            None,
            "create",
            &refusal_message(
                &HoldIdentity::from_error(active),
                Some(Path::new(&active.session_path)),
            ),
            Some(active.error_info()),
        ),
        None => response_failure(None, "create", &error.to_string(), None),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use pa_types::daemon::DaemonErrorInfo;

    /// The full message for a TypeScript-product holder, byte-for-byte:
    /// the classified headline, the two actionable paths (continue in the
    /// TS product with the exact command; take over on this daemon with
    /// the exact kill), and the session footer. No third "open a
    /// different session" option: the user is already in the picker
    /// (operator-directed, 2026-09-24).
    #[test]
    fn the_typescript_refusal_is_exact() {
        let hold = HoldIdentity {
            pid: Some(4242),
            active_session_id: Some("ts01ab".to_string()),
        };
        let message = refusal_for_flavor(HolderFlavor::TypeScriptProduct, &hold, None, None);
        let expected = "This session is currently open in your TypeScript version of Prime Agent \
(active in ts01ab). The Rust and TS versions share the same session store but not \
the same daemon, so this build cannot open the file while that process holds it.

• Continue where you left off:
  prime-agent --resume ts01ab
  (switch to the TypeScript product — its daemon owns this session)

• Take over on this daemon:
  kill 4242
  Then retry — the file unlocks when the holder exits.

Session: ts01ab";
        assert_eq!(message, expected);
    }

    /// The this-build refusal carries the `--daemon-socket` attach shape
    /// (the exact flag a client uses to reach another daemon) and the
    /// rust sweep binary; an anonymous holder gets the take-over path
    /// only — no product is claimed for a process the classifier cannot
    /// name.
    #[test]
    fn the_thisbuild_and_anonymous_refusals_stay_actionable() {
        let hold = HoldIdentity {
            pid: Some(4300),
            active_session_id: Some("rs01cd".to_string()),
        };
        let message = refusal_for_flavor(HolderFlavor::ThisBuild, &hold, None, None);
        assert!(
            message.contains("prime-agent-rust --daemon-socket <socket> --resume rs01cd"),
            "the attach command names the flag and the session: {message}"
        );
        assert!(
            message.contains("  kill 4300"),
            "the take-over names the holder pid: {message}"
        );
        assert!(
            message.contains("Session: rs01cd"),
            "the footer names the session: {message}"
        );

        let hold = HoldIdentity {
            pid: None,
            active_session_id: None,
        };
        let message = refusal_for_flavor(HolderFlavor::AnotherProcess, &hold, None, None);
        assert!(
            message.contains("(active in another process)"),
            "the anonymous holder id renders: {message}"
        );
        assert!(
            message.contains("prime-agent-rust shutdown --force"),
            "without a pid the sweep command is the take-over path: {message}"
        );
    }

    /// The footer carries the session's name when the file resolves one
    /// (a real session file), and falls back to the file path when the
    /// holder recorded no session id.
    #[test]
    fn the_footer_reads_the_session_name_and_the_path_fallback() {
        let dir = tempfile::TempDir::new().expect("temp dir");
        let file = dir.path().join("session.jsonl");
        // One JSON object per line (JSONL): a line that continues onto
        // the next is an invalid entry the loader silently skips.
        std::fs::write(
            &file,
            concat!(
                "{\"type\":\"session\",\"version\":3,\"id\":\"sess01\",\"timestamp\":\"2026-09-24T00:00:00Z\",\"cwd\":\"/w\"}\n",
                "{\"type\":\"session_info\",\"id\":\"e1\",\"timestamp\":\"2026-09-24T00:00:01Z\",\"name\":\"lane work\"}\n"
            ),
        )
        .expect("write session file");
        let hold = HoldIdentity {
            pid: Some(4242),
            active_session_id: Some("ts01ab".to_string()),
        };
        let message = refusal_for_flavor(HolderFlavor::TypeScriptProduct, &hold, Some(&file), None);
        assert!(
            message.ends_with("Session: ts01ab (lane work)"),
            "the footer names the session and its name: {message}"
        );

        let hold = HoldIdentity {
            pid: Some(4242),
            active_session_id: None,
        };
        let message = refusal_for_flavor(HolderFlavor::TypeScriptProduct, &hold, Some(&file), None);
        assert!(
            message.ends_with(&format!("Session: {} (lane work)", file.display())),
            "without a holder id the footer names the file and its name: {message}"
        );
    }

    /// The classification matrix: this build's own exe, a
    /// `prime-agent-rust` install, a cargo dev build under `/target/`,
    /// the deployed TS Mach-O binary, a node-run TS install, and the
    /// shapes that stay anonymous. The rust shapes contain the
    /// `prime-agent` substring family, so their checks must win first.
    #[test]
    fn the_holder_classification_matrix() {
        let own = Path::new("/Users/k/.local/share/prime-agent-rust/prime-agent");
        // This build's own exe: another window of it.
        assert_eq!(classify_from(Some(own), Some(own)), HolderFlavor::ThisBuild);
        // A prime-agent-rust install elsewhere: still this product.
        assert_eq!(
            classify_from(Some(Path::new("/opt/pa/prime-agent-rust")), Some(own)),
            HolderFlavor::ThisBuild
        );
        // A cargo dev build: the /target/ shape names this product.
        assert_eq!(
            classify_from(
                Some(Path::new("/w/repo/target/release/prime-agent")),
                Some(own)
            ),
            HolderFlavor::ThisBuild
        );
        // The deployed TS release binary: the Mach-O named `prime-agent`.
        assert_eq!(
            classify_from(
                Some(Path::new(
                    "/Users/k/.local/share/prime-agent/bin/prime-agent"
                )),
                Some(own)
            ),
            HolderFlavor::TypeScriptProduct
        );
        // An npm-style TS bin.
        assert_eq!(
            classify_from(Some(Path::new("/usr/local/bin/prime-agent")), Some(own)),
            HolderFlavor::TypeScriptProduct
        );
        // A source-run TS install: node (and bun/deno) runtimes.
        assert_eq!(
            classify_from(Some(Path::new("/usr/local/bin/node")), Some(own)),
            HolderFlavor::TypeScriptProduct
        );
        assert_eq!(
            classify_from(Some(Path::new("/opt/bun/bin/bun")), Some(own)),
            HolderFlavor::TypeScriptProduct
        );
        // Unresolvable or foreign: anonymous, never a wrong claim.
        assert_eq!(classify_from(None, Some(own)), HolderFlavor::AnotherProcess);
        assert_eq!(
            classify_from(Some(Path::new("/usr/bin/less")), Some(own)),
            HolderFlavor::AnotherProcess
        );
        // The own-exe equality wins even under the prime-agent substring.
        let dev = Path::new("/w/repo/target/debug/prime-agent");
        assert_eq!(classify_from(Some(dev), Some(dev)), HolderFlavor::ThisBuild);
    }

    /// The typed create response carries the refusal and the wire info;
    /// untyped failures keep their raw text.
    #[test]
    fn the_create_failure_response_splits_typed_and_untyped() {
        let hold = SessionAlreadyActiveError {
            session_path: "/tmp/s.jsonl".to_string(),
            active_session_id: Some("ts01ab".to_string()),
            owner: "ts01ab".to_string(),
            holder_pid: Some(4242),
        };
        let response = create_failure_response(&hold.into());
        assert!(!response.success);
        assert_eq!(response.command, "create");
        assert_eq!(
            response.error_info,
            Some(DaemonErrorInfo::SessionAlreadyActive {
                session_path: "/tmp/s.jsonl".to_string(),
                active_session_id: Some("ts01ab".to_string()),
            })
        );
        let message = response.error.expect("refusal text");
        assert!(
            message.starts_with("This session is currently open"),
            "{message}"
        );

        let raw = anyhow::anyhow!("corrupt session file");
        let response = create_failure_response(&raw);
        assert_eq!(response.error.as_deref(), Some("corrupt session file"));
        assert_eq!(response.error_info, None);
    }
}

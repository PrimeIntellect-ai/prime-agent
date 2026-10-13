//! The session-hold refusal: what a create or open answers when a live
//! process this daemon does not host holds the session file's runtime lease.
//!
//! The holder is usually the other product (named best-effort from its
//! pid); the refusal stays actionable and every refused create is logged.

use crate::lease::SessionAlreadyActiveError;
use crate::protocol::{response_failure, DaemonResponse};
use std::path::Path;

/// The live holder of a refused session file, as the lease record names it:
/// the pid and, when recorded, the active session id.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct HoldIdentity {
    pub pid: Option<u32>,
    pub active_session_id: Option<String>,
}

impl HoldIdentity {
    /// From the typed lease rejection.
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
            return single_line(id);
        }
        match self.pid {
            Some(pid) => format!("pid {pid}"),
            None => "another process".to_string(),
        }
    }
}

/// Which product a live holder's process image belongs to. A claim about
/// *what to tell the user*, not a security boundary: it errs toward the
/// generic wording whenever the executable cannot be resolved.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum HolderFlavor {
    /// This Rust build (another window/daemon of this binary, the takeover
    /// or pre-takeover install dirs, or a cargo dev build).
    ThisBuild,
    /// The TypeScript product: its release binary is named `prime-agent`,
    /// and source/dev installs run under node, bun, or deno.
    TypeScriptProduct,
    /// A process the classifier cannot name.
    AnotherProcess,
}

/// Resolve a live holder's process image, classified (best-effort);
/// `None` resolves no executable.
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

/// The classification core: `exe` is the holder's resolved process image,
/// `own_exe` this process's own. Order matters (the rust checks run
/// first), and the path checks match whole path COMPONENTS.
fn classify_from(exe: Option<&Path>, own_exe: Option<&Path>) -> HolderFlavor {
    let Some(exe) = exe else {
        return HolderFlavor::AnotherProcess;
    };
    if let Some(own) = own_exe {
        if exe == own {
            return HolderFlavor::ThisBuild;
        }
    }
    let mut components: Vec<String> = exe
        .components()
        .map(|component| component.as_os_str().to_string_lossy().to_lowercase())
        .collect();
    // Linux `/proc/<pid>/exe` appends " (deleted)" for an unlinked image
    // (a daemon still running from a swept rollback tree); a procfs
    // artifact, not part of the file name.
    if components
        .last()
        .is_some_and(|last| last.ends_with(" (deleted)"))
    {
        let stripped = components
            .last()
            .unwrap()
            .trim_end_matches(" (deleted)")
            .to_string();
        *components.last_mut().unwrap() = stripped;
    }
    if components
        .iter()
        .any(|component| component == "prime-agent-rust")
    {
        return HolderFlavor::ThisBuild;
    }
    // The keyword-takeover install layout: the payload sits DIRECTLY
    // inside the share dir (`.../share/prime-agent/prime-agent`), while a
    // TS release binary sits one level deeper
    // (`.../releases/<name>/prime-agent`), so the parent component claims
    // this product.
    if components.len() >= 2 && components.last().map(String::as_str) == Some("prime-agent") {
        let parent = components[components.len() - 2].as_str();
        // The parent alone is the layout signal (a TS release binary's
        // parent is the release name, never `prime-agent`).
        let is_publish_byproduct =
            parent.starts_with("prime-agent.old.") || parent.starts_with("prime-agent.stage.");
        if parent == "prime-agent" || is_publish_byproduct {
            return HolderFlavor::ThisBuild;
        }
    }
    // The exe filename gate keeps a node/bun/deno runtime that merely runs
    // FROM a `prime-agent`-named directory from claiming this build: only
    // the payload binary named `prime-agent` is claimed.
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
/// with the session's identity.
#[must_use]
pub fn refusal_message(hold: &HoldIdentity, session_path: Option<&Path>) -> String {
    let (flavor, holder_exe) = holder_process(hold.pid);
    refusal_for_flavor(flavor, hold, session_path, holder_exe.as_deref())
}

/// The holder's recorded identity for the footer: its active session id,
/// else the file path the picker names.
fn session_label(hold: &HoldIdentity, session_path: Option<&Path>) -> String {
    if let Some(id) = hold
        .active_session_id
        .as_deref()
        .filter(|id| !id.is_empty())
    {
        return single_line(id);
    }
    session_path.map_or_else(
        || "this session".to_string(),
        |path| path.display().to_string(),
    )
}

/// The session's name from its durable file, for the footer (best-effort).
/// A bounded-cost scan, not a full load: reads line by line (constant
/// memory); the latest `session_info` candidate wins.
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

/// One paste-safe line: control characters (a session id from a hostile
/// lease could carry newlines) collapse to spaces, so no interpolated
/// value can ever re-flow the refusal's structure.
fn single_line(value: &str) -> String {
    value
        .chars()
        .map(|c| if c.is_control() { ' ' } else { c })
        .collect()
}

/// A single-quoted shell word: the recorded id cannot break out of the
/// argument, so pasting the command always runs `--resume` with exactly
/// the id the lease recorded.
fn shell_quote(value: &str) -> String {
    format!("'{}'", value.replace('\'', "'\\''"))
}

/// The take-over option: kill the holder and retry. With a resolved pid
/// the `kill` is the surgical command; without one the state-root sweep
/// (`shutdown --force`) is the honest fallback.
fn take_over_lines(
    hold: &HoldIdentity,
    sweep_binary: &str,
    holder_exe: Option<&Path>,
) -> Vec<String> {
    let mut lines = vec!["• Take over on this daemon:".to_string()];
    if let Some(pid) = hold.pid {
        // The kill line names what would be killed, behind a `#` so
        // pasting the WHOLE line still runs exactly `kill <pid>`.
        let kill = match holder_exe
            .and_then(|exe| exe.file_name())
            .map(|name| name.to_string_lossy().to_string())
            // An image with control characters cannot ride in the
            // comment at all (a newline would make the next line a
            // new pasted command): those names stay anonymous.
            .filter(|image| image.chars().all(|c| !c.is_control()))
        {
            Some(image) => format!("  kill {pid} # the holder is {image}"),
            None => format!("  kill {pid}"),
        };
        lines.push(kill);
        lines.push("  Then retry — the file unlocks when the holder exits.".to_string());
    } else {
        lines.push(format!("  {sweep_binary} shutdown --force"));
        lines.push("  Then retry — it stops every daemon in the state root.".to_string());
    }
    lines
}

/// The footer: the session's id (or file path) with its name, the same
/// identity the session picker shows.
fn session_footer(hold: &HoldIdentity, session_path: Option<&Path>) -> String {
    let label = session_label(hold, session_path);
    match session_name_of(session_path) {
        Some(name) => format!("Session: {label} ({})", single_line(&name)),
        None => format!("Session: {label}"),
    }
}

/// The refusal text for a classified holder: the classified headline,
/// then the paths out (continue in the holder's product, or take the
/// session over on this daemon). Split from [`refusal_message`] so the
/// exact wording stays testable against a synthetic classification.
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
            // The Rust port owns the `prime-agent` keyword, so naming
            // `prime-agent --resume` here would launch THIS build. The
            // continue path names the TypeScript binary that holds the
            // lease, derived from the holder's live process image.
            match (holder_exe, id) {
                // The holder binary rides quoted, and only when the image
                // IS the TypeScript payload binary (control-free, named
                // `prime-agent`): a runtime holder would be a broken
                // command, so those fall back to the takeover wording below.
                (Some(exe), Some(id))
                    if !exe.to_string_lossy().chars().any(char::is_control)
                        && exe.file_name().is_some_and(|name| name == "prime-agent") =>
                {
                    lines.push(format!(
                        "  {} --resume {}",
                        shell_quote(&exe.display().to_string()),
                        shell_quote(&single_line(id))
                    ));
                    lines.push(
                        "  (that TypeScript binary holds the lease — its daemon owns this session)"
                            .to_string(),
                    );
                }
                _ => {
                    lines.push(
                        "  (continue in the TypeScript product — its daemon owns this session; the prime-agent keyword launches this Rust build, so use the TypeScript binary from its preserved install)"
                            .to_string(),
                    );
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
            if let Some(id) = id {
                lines.push(format!(
                    "  prime-agent --daemon-socket <socket> --resume {}",
                    shell_quote(&single_line(id))
                ));
                lines.push(
                    "  (<socket> is that instance's daemon socket, from the shell where \
you started it — that daemon owns this session)"
                        .to_string(),
                );
            } else {
                lines.push("  prime-agent --resume".to_string());
                lines.push(
                    "  (switch to the window or shell where that instance is running — its \
daemon owns this session)"
                        .to_string(),
                );
            }
            lines.push(String::new());
            lines.extend(take_over_lines(hold, "prime-agent", holder_exe));
        }
        HolderFlavor::AnotherProcess => {
            lines.push(format!(
                "This session is currently open in another process \
(active in {holder_id}) — a live process this daemon does not host holds the file's \
runtime lease."
            ));
            lines.push(String::new());
            lines.extend(take_over_lines(hold, "prime-agent", holder_exe));
        }
    }
    lines.push(String::new());
    lines.push(session_footer(hold, session_path));
    lines.join("\n")
}

/// The create response for a refused create: the typed rejection answers
/// with the refusal and its wire info; other failures keep their raw text.
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

    /// No third "open a different session" option: the user is already
    /// in the picker (operator-directed, 2026-09-24).
    #[test]
    fn the_typescript_refusal_is_exact() {
        let hold = HoldIdentity {
            pid: Some(4242),
            active_session_id: Some("ts01ab".to_string()),
        };
        let message = refusal_for_flavor(
            HolderFlavor::TypeScriptProduct,
            &hold,
            None,
            Some(Path::new(
                "/home/k/.local/share/prime-agent-legacy/releases/9.9.9/prime-agent",
            )),
        );
        let expected = "This session is currently open in your TypeScript version of Prime Agent \
(active in ts01ab). The Rust and TS versions share the same session store but not \
the same daemon, so this build cannot open the file while that process holds it.

• Continue where you left off:
  '/home/k/.local/share/prime-agent-legacy/releases/9.9.9/prime-agent' --resume 'ts01ab'
  (that TypeScript binary holds the lease — its daemon owns this session)

• Take over on this daemon:
  kill 4242 # the holder is prime-agent
  Then retry — the file unlocks when the holder exits.

Session: ts01ab";
        assert_eq!(message, expected);

        let message = refusal_for_flavor(HolderFlavor::TypeScriptProduct, &hold, None, None);
        assert!(
            message.contains("the prime-agent keyword launches this Rust build"),
            "the unresolvable-exe continue path states the takeover: {message}"
        );
        assert!(
            !message.contains("prime-agent --resume"),
            "no bare `prime-agent --resume` hint remains (it launches this build): {message}"
        );
    }

    #[test]
    fn hostile_values_stay_paste_safe() {
        let hold = HoldIdentity {
            pid: Some(4242),
            active_session_id: Some("evil'; rm -rf ~".to_string()),
        };
        let message = refusal_for_flavor(
            HolderFlavor::TypeScriptProduct,
            &hold,
            None,
            Some(std::path::Path::new("/bin/hold\ner")),
        );
        assert!(
            message.contains("(active in evil'; rm -rf ~)"),
            "the headline still names the id: {message}"
        );
        assert!(
            !message.contains("/bin/hold"),
            "the newline image never reaches a command line: {message}"
        );
        assert!(
            message.lines().any(|line| line == "  kill 4242"),
            "the newline image drops the kill annotation entirely: {message}"
        );

        let message = refusal_for_flavor(
            HolderFlavor::TypeScriptProduct,
            &hold,
            None,
            Some(std::path::Path::new("/opt/hold bin/prime-agent")),
        );
        assert!(
            message.contains("'/opt/hold bin/prime-agent' --resume 'evil'\\''; rm -rf ~'"),
            "the binary and the id each ride as one quoted word: {message}"
        );

        let message = refusal_for_flavor(
            HolderFlavor::TypeScriptProduct,
            &hold,
            None,
            Some(std::path::Path::new("/usr/bin/node")),
        );
        assert!(
            !message.contains("--resume"),
            "a runtime image never becomes the resume command: {message}"
        );
        assert!(
            message.contains("the prime-agent keyword launches this Rust build"),
            "the runtime holder gets the takeover wording: {message}"
        );

        let hold = HoldIdentity {
            pid: None,
            active_session_id: Some("li\nne".to_string()),
        };
        let message = refusal_for_flavor(
            HolderFlavor::TypeScriptProduct,
            &hold,
            None,
            Some(std::path::Path::new("/opt/ts/prime-agent")),
        );
        assert!(
            message.contains("'/opt/ts/prime-agent' --resume 'li ne'"),
            "control characters in the id collapse before quoting: {message}"
        );
    }

    #[test]
    fn the_thisbuild_and_anonymous_refusals_stay_actionable() {
        let hold = HoldIdentity {
            pid: Some(4300),
            active_session_id: Some("rs01cd".to_string()),
        };
        let message = refusal_for_flavor(HolderFlavor::ThisBuild, &hold, None, None);
        assert!(
            message.contains("prime-agent --daemon-socket <socket> --resume 'rs01cd'"),
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
            message.contains("prime-agent shutdown --force"),
            "without a pid the sweep command is the take-over path: {message}"
        );
    }

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

        std::fs::write(
            &file,
            concat!(
                "{\"type\":\"session\",\"version\":3,\"id\":\"sess01\",\"timestamp\":\"2026-09-24T00:00:00Z\",\"cwd\":\"/w\"}\n",
                "{\"type\":\"session_info\",\"id\":\"e1\",\"timestamp\":\"2026-09-24T00:00:01Z\",\"name\":\"lane\\nwork\"}\n"
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
            "a newline in the persisted name collapses to one footer line: {message}"
        );
    }

    /// The classification matrix. The rust shapes contain the
    /// `prime-agent` substring family, so their checks must win first.
    #[test]
    fn the_holder_classification_matrix() {
        let own = Path::new("/Users/k/.local/share/prime-agent/prime-agent");
        assert_eq!(classify_from(Some(own), Some(own)), HolderFlavor::ThisBuild);
        assert_eq!(
            classify_from(
                Some(Path::new("/Users/k/.local/share/prime-agent/prime-agent")),
                Some(Path::new("/opt/pa/prime-agent"))
            ),
            HolderFlavor::ThisBuild
        );
        // A daemon still running from the renamed rollback tree.
        assert_eq!(
            classify_from(
                Some(Path::new(
                    "/Users/k/.local/share/prime-agent.old.123/prime-agent"
                )),
                Some(Path::new("/opt/pa/prime-agent"))
            ),
            HolderFlavor::ThisBuild
        );
        // The pre-takeover install dir: still this product.
        assert_eq!(
            classify_from(
                Some(Path::new("/opt/pa/prime-agent-rust")),
                Some(Path::new("/opt/pa/prime-agent"))
            ),
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
        // The deployed TS release binary, and the preserved legacy tree
        // after the takeover reads the same.
        assert_eq!(
            classify_from(
                Some(Path::new(
                    "/Users/k/.local/share/prime-agent/releases/9.9.9-darwin-arm64-deadbeef/prime-agent"
                )),
                Some(own)
            ),
            HolderFlavor::TypeScriptProduct
        );
        assert_eq!(
            classify_from(
                Some(Path::new(
                    "/Users/k/.local/share/prime-agent-legacy/releases/9.9.9-darwin-arm64-deadbeef/prime-agent"
                )),
                Some(own)
            ),
            HolderFlavor::TypeScriptProduct
        );
        // A node runtime running FROM a prime-agent-named directory: the
        // TypeScript product.
        assert_eq!(
            classify_from(Some(Path::new("/work/prime-agent/node")), Some(own)),
            HolderFlavor::TypeScriptProduct
        );
        // A prefix that happens to CONTAIN a `releases` component does not
        // mis-reject the flat takeover layout.
        assert_eq!(
            classify_from(
                Some(Path::new(
                    "/opt/releases/user/share/prime-agent/prime-agent"
                )),
                Some(own)
            ),
            HolderFlavor::ThisBuild
        );
        assert_eq!(
            classify_from(
                Some(Path::new(
                    "/Users/k/.local/share/prime-agent.old.123/prime-agent (deleted)"
                )),
                Some(own)
            ),
            HolderFlavor::ThisBuild
        );
        // The TS public-bin symlink shape inside a dir NAMED prime-agent:
        // still the TS product.
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
        // A TS binary one level deeper than the takeover layout never
        // claims this product.
        assert_eq!(
            classify_from(
                Some(Path::new(
                    "/opt/other/prime-agent/9.9.9-release/prime-agent"
                )),
                Some(own)
            ),
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

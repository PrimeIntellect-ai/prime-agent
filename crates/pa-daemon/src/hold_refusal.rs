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
//! claim. The daemon logs every refused create (the supervisor's rotating
//! log), so a silent-looking failure still leaves a clear record.

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

/// Classify a live holder by resolving its pid to the process image.
pub fn classify_holder(pid: Option<u32>) -> HolderFlavor {
    let exe = pid
        .and_then(pa_types::platform::process::process_executable_path)
        .map(|path| path.canonicalize().unwrap_or(path));
    let own = std::env::current_exe()
        .ok()
        .map(|path| path.canonicalize().unwrap_or(path));
    classify_from(exe.as_deref(), own.as_deref())
}

/// The classification core, factored for tests: `exe` is the holder's
/// resolved process image, `own_exe` this process's own. Order matters —
/// every rust-build shape contains the `prime-agent` substring family, so
/// the rust checks run first and the TS claim is never made about a rust
/// binary.
pub fn classify_from(exe: Option<&Path>, own_exe: Option<&Path>) -> HolderFlavor {
    let Some(exe) = exe else {
        return HolderFlavor::AnotherProcess;
    };
    if let Some(own) = own_exe {
        if exe == own {
            return HolderFlavor::ThisBuild;
        }
    }
    let path = exe.to_string_lossy().to_lowercase();
    if path.contains("prime-agent-rust") || path.contains("/target/") {
        return HolderFlavor::ThisBuild;
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
/// holds: the holder's pid is resolved and classified live, then rendered.
pub fn refusal_message(hold: &HoldIdentity) -> String {
    refusal_for_flavor(classify_holder(hold.pid), hold)
}

/// The refusal text for a classified holder. The TypeScript wording is
/// the product's specified text byte-for-byte; the other flavors keep
/// the same shape (what happened, the holder, the next step) without the
/// cross-product sentence, which would be a wrong claim about them.
/// Split from [`refusal_message`] so the exact wording stays testable
/// against a synthetic classification, not a live foreign process.
pub fn refusal_for_flavor(flavor: HolderFlavor, hold: &HoldIdentity) -> String {
    let holder_id = hold.holder_id();
    match flavor {
        HolderFlavor::TypeScriptProduct => format!(
            "This session is currently open in your TypeScript version of Prime Agent \
(active in {holder_id}). Close it there first, or open a different session. \
The Rust and TS versions share the same session store but not the same daemon."
        ),
        HolderFlavor::ThisBuild => format!(
            "This session is currently open in another Rust build of Prime Agent \
(active in {holder_id}). Close it there first, or open a different session."
        ),
        HolderFlavor::AnotherProcess => format!(
            "This session is currently open in another process \
(active in {holder_id}). Close it there first, or open a different session."
        ),
    }
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
            &refusal_message(&HoldIdentity::from_error(active)),
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
    /// the product-specified refusal, with the holder id in the
    /// parenthetical.
    #[test]
    fn the_typescript_refusal_is_exact() {
        let hold = HoldIdentity {
            pid: Some(4242),
            active_session_id: Some("ts01ab".to_string()),
        };
        assert_eq!(
            refusal_for_flavor(HolderFlavor::TypeScriptProduct, &hold),
            "This session is currently open in your TypeScript version of Prime Agent \
(active in ts01ab). Close it there first, or open a different session. \
The Rust and TS versions share the same session store but not the same daemon."
        );
    }

    /// The holder id falls back to the pid when the holder recorded no
    /// active session id, and to the anonymous wording without a pid.
    #[test]
    fn the_holder_id_falls_back_pid_then_anonymous() {
        let hold = HoldIdentity {
            pid: Some(4242),
            active_session_id: None,
        };
        assert!(
            refusal_for_flavor(HolderFlavor::TypeScriptProduct, &hold)
                .contains("(active in pid 4242)"),
            "the pid holder id renders"
        );
        let hold = HoldIdentity {
            pid: None,
            active_session_id: None,
        };
        assert!(
            refusal_for_flavor(HolderFlavor::AnotherProcess, &hold)
                .contains("(active in another process)"),
            "the anonymous holder id renders"
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

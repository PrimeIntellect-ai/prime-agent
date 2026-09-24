//! The `/update` command (TS `handleUpdateCommand`): the busy guard, the
//! child-process update runs, and the self-update relaunch. The Rust CLI
//! splits TS's single `update` target surface in two (`prime-agent update`
//! for the binary, `prime-agent package update` for extensions), so the
/// TS target parse maps onto the two child invocations — packages first,
/// the binary last, because the self-update relaunch ends this process.
use std::pin::Pin;

/// The package-update half of one `/update` run.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum PackageUpdate {
    /// All installed packages (TS `--extensions`).
    All,
    /// One package's source (TS `--extension <src>` / a positional source).
    Source(String),
}

/// One parsed `/update` invocation.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct UpdatePlan {
    /// Whether the run updates the binary (TS `updateTargetIncludesSelf`:
    /// `--self`, a self positional, or no positional at all).
    pub includes_self: bool,
    /// The package half, when the args ask for it.
    pub package: Option<PackageUpdate>,
    /// The self-update flags to pass through (`--force`, `--rollback`,
    /// `--nightly`, `--stable`).
    pub flags: Vec<String>,
}

/// TS `isSelfUpdateSource`.
fn is_self_update_source(source: &str) -> bool {
    source == "self" || source == "pi" || source == "prime-agent"
}

/// TS `updateArgsIncludeSelf` (verbatim parse).
pub fn update_args_include_self(args: &[String]) -> bool {
    let mut self_flag = false;
    let mut extensions_only_flag = false;
    let mut positional: Option<&str> = None;
    let mut index = 0;
    while index < args.len() {
        let arg = &args[index];
        if arg == "--self" {
            self_flag = true;
        } else if arg == "--extensions" {
            extensions_only_flag = true;
        } else if arg == "--extension" {
            extensions_only_flag = true;
            index += 1;
        } else if arg == "--daemon-socket" {
            index += 1;
        } else if !arg.starts_with('-') && positional.is_none() {
            positional = Some(arg);
        }
        index += 1;
    }
    if self_flag {
        return true;
    }
    if extensions_only_flag {
        return false;
    }
    match positional {
        None => true,
        Some(positional) => is_self_update_source(positional),
    }
}

/// Parse `/update`'s arguments (TS `parsePackageCommand`'s target
/// resolution over the split CLI: `--self`/`--extensions`/`--extension
/// <source>`/positionals resolve the same way; the default target is TS's
/// "all", which runs packages then the binary).
pub fn parse_update_args(args: &[String]) -> UpdatePlan {
    let includes_self = update_args_include_self(args);
    let mut self_flag = false;
    let mut extensions_flag = false;
    let mut extension_source: Option<String> = None;
    let mut positional: Option<String> = None;
    let mut flags: Vec<String> = Vec::new();
    let mut index = 0;
    while index < args.len() {
        let arg = &args[index];
        match arg.as_str() {
            "--self" => self_flag = true,
            "--extensions" => extensions_flag = true,
            "--extension" => {
                index += 1;
                if let Some(source) = args.get(index) {
                    extension_source = Some(source.clone());
                }
            }
            "--daemon-socket" => index += 1,
            "--force" | "--rollback" | "--nightly" | "--stable" => flags.push(arg.clone()),
            other if !other.starts_with('-') && positional.is_none() => {
                positional = Some(other.to_string());
            }
            _ => {}
        }
        index += 1;
    }
    // The TS target resolution (`parsePackageCommand`'s `updateTarget`).
    let package = if extension_source.is_some() {
        extension_source.map(PackageUpdate::Source)
    } else if let Some(positional) = positional.as_deref() {
        if is_self_update_source(positional) {
            // TS: a self positional with `--extensions` is the "all"
            // target; alone it is self-only.
            extensions_flag.then_some(PackageUpdate::All)
        } else {
            Some(PackageUpdate::Source(positional.to_string()))
        }
    } else if extensions_flag {
        // `--extensions` alone or with `--self` (the TS "all" target):
        // packages run either way.
        Some(PackageUpdate::All)
    } else if self_flag {
        None
    } else {
        // The default target ("all"): packages plus the binary.
        Some(PackageUpdate::All)
    };
    UpdatePlan {
        includes_self,
        package,
        flags,
    }
}

/// TS `argsIncludeSessionSelection`: a relaunch that already selects a
/// session keeps its own selection.
pub fn args_include_session_selection(args: &[String]) -> bool {
    args.iter().any(|arg| {
        matches!(
            arg.as_str(),
            "--resume" | "-r" | "--continue" | "-c" | "--fork"
        )
    })
}

/// The boxed-future shape of [`UpdateCommands::run_cli_child`].
pub type UpdateChildFuture =
    Pin<Box<dyn std::future::Future<Output = std::io::Result<i32>> + Send>>;

/// The update child runs the composition root owns: spawning the CLI
/// with inherited stdio and replacing this process after a self-update.
pub trait UpdateCommands: Send + Sync {
    /// Run one CLI child invocation with inherited stdio (TS
    /// `spawnSync(..., { stdio: "inherit" })`) and report its exit code.
    fn run_cli_child(&self, args: Vec<String>) -> UpdateChildFuture;
    /// Replace this process with the updated CLI (TS
    /// `tryExecUpdateRelaunch` and its child-relaunch fallback). Returns
    /// only when the relaunch itself failed; a successful replacement
    /// never returns.
    fn relaunch(&self, args: Vec<String>) -> !;
}

/// The handle the interactive options carry.
#[derive(Clone)]
pub struct UpdateCommandsHandle(pub std::sync::Arc<dyn UpdateCommands>);

impl std::fmt::Debug for UpdateCommandsHandle {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("UpdateCommandsHandle").finish()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn args(values: &[&str]) -> Vec<String> {
        values.iter().map(ToString::to_string).collect()
    }

    #[test]
    fn the_default_target_is_the_ts_all_target() {
        let plan = parse_update_args(&args(&[]));
        assert!(plan.includes_self);
        assert_eq!(plan.package, Some(PackageUpdate::All));

        let plan = parse_update_args(&args(&["--force"]));
        assert!(plan.includes_self);
        assert_eq!(plan.package, Some(PackageUpdate::All));
        assert_eq!(plan.flags, vec!["--force".to_string()]);
    }

    #[test]
    fn self_targets_run_the_binary_only() {
        for target in ["--self", "self", "pi", "prime-agent"] {
            let plan = parse_update_args(&args(&[target]));
            assert!(plan.includes_self, "{target}");
            assert_eq!(plan.package, None, "{target}");
        }
    }

    #[test]
    fn extension_targets_run_packages_only() {
        let plan = parse_update_args(&args(&["--extensions"]));
        assert!(!plan.includes_self);
        assert_eq!(plan.package, Some(PackageUpdate::All));

        let plan = parse_update_args(&args(&["--extension", "npm:@foo/bar"]));
        assert!(!plan.includes_self);
        assert_eq!(
            plan.package,
            Some(PackageUpdate::Source("npm:@foo/bar".to_string()))
        );
        assert!(!update_args_include_self(&args(&[
            "--extension",
            "npm:@foo/bar"
        ])));

        let plan = parse_update_args(&args(&["npm:@foo/bar"]));
        assert!(!plan.includes_self);
        assert_eq!(
            plan.package,
            Some(PackageUpdate::Source("npm:@foo/bar".to_string()))
        );
    }

    #[test]
    fn the_channel_flags_pass_through_to_the_self_child() {
        let plan = parse_update_args(&args(&["--nightly"]));
        assert_eq!(plan.flags, vec!["--nightly".to_string()]);
        let plan = parse_update_args(&args(&["--self", "--rollback", "--stable"]));
        assert!(plan.includes_self);
        assert_eq!(
            plan.flags,
            vec!["--rollback".to_string(), "--stable".to_string()]
        );
    }

    #[test]
    fn the_busy_guard_reads_the_same_target_as_ts() {
        // TS `updateArgsIncludeSelf`: the default and --self include self;
        // extension targets do not.
        assert!(update_args_include_self(&args(&[])));
        assert!(update_args_include_self(&args(&["--self"])));
        assert!(update_args_include_self(&args(&[
            "--daemon-socket",
            "/x.sock"
        ])));
        assert!(!update_args_include_self(&args(&["--extensions"])));
        assert!(!update_args_include_self(&args(&["my-package"])));
    }

    #[test]
    fn the_relaunch_keeps_an_explicit_session_selection() {
        assert!(args_include_session_selection(&args(&[
            "--resume", "/s.jsonl"
        ])));
        assert!(args_include_session_selection(&args(&["-c"])));
        assert!(!args_include_session_selection(&args(&["--model", "m"])));
    }
}

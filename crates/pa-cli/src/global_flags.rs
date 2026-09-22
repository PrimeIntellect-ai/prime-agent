//! Leading global-flag scanning, ported from `cli/global-flags.ts`. Both the
//! public command router and the arg parser must agree on which token is the
//! subcommand, so flag consumption mirrors `parse_args` exactly.

use std::collections::HashSet;

/// Global flags that consume the next argument as their value.
pub const GLOBAL_VALUE_FLAGS: [&str; 26] = [
    "--mode",
    "--daemon-socket",
    "--provider",
    "--model",
    "--api-key",
    "--cwd",
    "--system-prompt",
    "--append-system-prompt",
    "--fork",
    "--session-dir",
    "--models",
    "--tools",
    "-t",
    "--thinking",
    "--extension",
    "-e",
    "--skill",
    "--prompt-template",
    "--theme",
    "--autonomous-gate",
    "--autonomous-gate-retries",
    "--autonomous-gate-timeout-ms",
    "--autonomous-max-continuations",
    "--autonomous-max-turns",
    "--autonomous-max-tokens",
    "--autonomous-timeout-ms",
];

/// Value flags that also appear in GLOBAL_VALUE_FLAGS.
const FREEFORM_VALUE_FLAGS: [&str; 2] = ["--goal", "--autonomous-gate"];
/// Prompt value flags whose text may look like a long option.
const PROMPT_VALUE_FLAGS: [&str; 2] = ["--system-prompt", "--append-system-prompt"];

/// Flags that mark a one-shot prompt run; their positional is a message.
pub const PROMPT_RUN_FLAGS: [&str; 4] =
    ["--print", "-p", "--system-prompt", "--append-system-prompt"];

/// parseArgs-known long flags that take no separate value.
const GLOBAL_BOOLEAN_FLAGS: [&str; 14] = [
    "--help",
    "--version",
    "--continue",
    "--no-session",
    "--no-tools",
    "--no-builtin-tools",
    "--no-extensions",
    "--no-skills",
    "--no-prompt-templates",
    "--no-themes",
    "--no-context-files",
    "--autonomous",
    "--verbose",
    "--offline",
];

/// True when parseArgs consumes the token after `args[index]` as part of the
/// flag at `args[index]`, mirroring `consumesFollowingToken` in global-flags.ts.
fn consumes_following_token(args: &[String], index: usize) -> bool {
    let Some(next) = args.get(index + 1) else {
        return false;
    };
    if next == "--" {
        return false;
    }
    let arg = args[index].as_str();
    if GLOBAL_VALUE_FLAGS.contains(&arg) {
        if PROMPT_VALUE_FLAGS.contains(&arg) {
            return true;
        }
        return if FREEFORM_VALUE_FLAGS.contains(&arg) {
            !next.starts_with("--")
        } else {
            !next.starts_with('-')
        };
    }
    if arg == "--resume" || arg == "-r" {
        return !next.starts_with('-') && !next.starts_with('@');
    }
    if arg == "--print" || arg == "-p" {
        return !next.starts_with('@') && (!next.starts_with('-') || next.starts_with("---"));
    }
    arg.starts_with("--")
        && !arg.contains('=')
        && !GLOBAL_BOOLEAN_FLAGS.contains(&arg)
        && !next.starts_with('-')
        && !next.starts_with('@')
}

/// The first positional argument, skipping global flags the way parseArgs does.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct FirstPositionalArgument {
    pub index: usize,
    pub value: String,
    /// True when the token only became positional because of a `--` terminator.
    pub after_separator: bool,
}

/// Find the first positional argument, mirroring `findFirstPositionalArgument`.
pub fn find_first_positional_argument(args: &[String]) -> Option<FirstPositionalArgument> {
    let mut index = 0;
    while index < args.len() {
        let arg = args[index].as_str();
        if arg == "--" {
            return args.get(index + 1).map(|value| FirstPositionalArgument {
                index: index + 1,
                value: value.clone(),
                after_separator: true,
            });
        }
        if arg.starts_with('-') {
            if consumes_following_token(args, index) {
                index += 1;
            }
            index += 1;
            continue;
        }
        return Some(FirstPositionalArgument {
            index,
            value: arg.to_string(),
            after_separator: false,
        });
    }
    None
}

/// True when the first positional names a command instead of a message.
pub fn is_command_positional(
    positional: Option<&FirstPositionalArgument>,
    public_commands: &HashSet<&str>,
    removed_commands: &HashSet<&str>,
) -> bool {
    match positional {
        None => false,
        Some(p) if p.after_separator => false,
        Some(p) => {
            let value = p.value.as_str();
            public_commands.contains(value) || removed_commands.contains(value)
        }
    }
}

/// Move leading global flags behind the subcommand they were written in front
/// of, mirroring `rotateGlobalFlagsBeforeCommand`. Arguments are returned
/// unchanged when no known command is present, when `--` already escaped the
/// token, and for one-shot prompt runs.
pub fn rotate_global_flags_before_command(
    args: &[String],
    public_commands: &HashSet<&str>,
    removed_commands: &HashSet<&str>,
) -> Vec<String> {
    let positional = find_first_positional_argument(args);
    let Some(positional) = positional else {
        return args.to_vec();
    };
    if positional.index == 0
        || !is_command_positional(Some(&positional), public_commands, removed_commands)
    {
        return args.to_vec();
    }
    if args[..positional.index]
        .iter()
        .any(|arg| PROMPT_RUN_FLAGS.contains(&arg.as_str()) || arg == "--version" || arg == "-v")
    {
        return args.to_vec();
    }
    let moved = &args[..positional.index];
    let rest = &args[positional.index + 1..];
    let separator_index = rest.iter().position(|arg| arg == "--");
    let mut rotated = vec![positional.value.clone()];
    match separator_index {
        None => {
            rotated.extend(rest.iter().cloned());
            rotated.extend(moved.iter().cloned());
        }
        Some(sep) => {
            rotated.extend(rest[..sep].iter().cloned());
            rotated.extend(moved.iter().cloned());
            rotated.extend(rest[sep..].iter().cloned());
        }
    }
    rotated
}

/// The command path a `help` request names, with global run flags (and their
/// values) excluded, mirroring `extractHelpCommandPath`. Returns `None` when
/// the tail contains `--` or a bare explicit `--help`/`-h`.
pub fn extract_help_command_path(args: &[String], from: usize) -> Option<Vec<String>> {
    let mut path: Vec<String> = Vec::new();
    let mut index = from;
    while index < args.len() {
        let arg = args[index].as_str();
        if arg == "--" {
            return None;
        }
        if arg == "--help" || arg == "-h" {
            return if path.is_empty() { None } else { Some(path) };
        }
        if arg.starts_with('-') {
            if consumes_following_token(args, index) {
                index += 1;
            }
            index += 1;
            continue;
        }
        path.push(arg.to_string());
        index += 1;
    }
    Some(path)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn args(list: &[&str]) -> Vec<String> {
        list.iter().map(|s| s.to_string()).collect()
    }

    fn sets() -> (HashSet<&'static str>, HashSet<&'static str>) {
        let mut public = HashSet::new();
        public.insert("status");
        let mut removed = HashSet::new();
        removed.insert("daemon");
        (public, removed)
    }

    #[test]
    fn rotates_flags_before_command() {
        let (public, removed) = sets();
        let rotated =
            rotate_global_flags_before_command(&args(&["--offline", "status"]), &public, &removed);
        assert_eq!(rotated, args(&["status", "--offline"]));
    }

    #[test]
    fn keeps_flags_for_prompt_runs() {
        let (public, removed) = sets();
        let rotated =
            rotate_global_flags_before_command(&args(&["-p", "status"]), &public, &removed);
        assert_eq!(rotated, args(&["-p", "status"]));
    }

    #[test]
    fn keeps_version_ahead_of_routing() {
        let (public, removed) = sets();
        let rotated =
            rotate_global_flags_before_command(&args(&["--version", "status"]), &public, &removed);
        assert_eq!(rotated, args(&["--version", "status"]));
    }

    #[test]
    fn skips_consumed_flag_values() {
        let (public, removed) = sets();
        let rotated = rotate_global_flags_before_command(
            &args(&["--provider", "status", "status"]),
            &public,
            &removed,
        );
        assert_eq!(rotated, args(&["status", "--provider", "status"]));
    }

    #[test]
    fn extracts_help_path_skipping_flag_values() {
        let path = extract_help_command_path(&args(&["--offline", "status"]), 1);
        assert_eq!(path, Some(args(&["status"])));
        // `help --resume status` asks about nothing: status is the resume selector.
        let path = extract_help_command_path(&args(&["help", "--resume", "status"]), 1);
        assert_eq!(path, Some(Vec::<String>::new()));
        let path = extract_help_command_path(&args(&["help", "--offline", "status"]), 1);
        assert_eq!(path, Some(args(&["status"])));
        let path = extract_help_command_path(&args(&["help", "--", "status"]), 1);
        assert_eq!(path, None);
    }
}

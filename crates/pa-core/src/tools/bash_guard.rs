//! Destructive-git discard guard: detects git commands that discard uncommitted
//! working-tree changes, resolves which repository each discard targets (cd
//! chains, `git -C`, inline env assignments), and formats the dirty-tree refusal.

/// Bypass env var for the destructive-git dirty-tree guard.
pub(crate) const BASH_DESTRUCTIVE_GIT_BYPASS_ENV: &str = "PI_BASH_ALLOW_DESTRUCTIVE_GIT";

/// How many dirty paths the refusal lists before eliding the rest.
pub(crate) const MAX_DIRTY_PATHS_LISTED: usize = 10;

/// JavaScript `\s` character class.
const S: &str = r"[\t\n\x0B\f\r \u{00A0}\u{1680}\u{2000}-\u{200A}\u{2028}\u{2029}\u{202F}\u{205F}\u{3000}\u{FEFF}]";

/// JS `str.split(/\s+/)` (leading/trailing empty tokens removed).
fn split_ws(text: &str) -> Vec<&str> {
    let pattern = format!("^{S}+|{S}+");
    let re = fancy_regex::Regex::new(&pattern).expect("split_ws regex");
    let mut parts = Vec::new();
    let mut rest = text;
    while let Some(m) = re.find(rest).ok().flatten() {
        if m.start() > 0 {
            parts.push(&rest[..m.start()]);
        }
        rest = &rest[m.end()..];
    }
    if !rest.is_empty() {
        parts.push(rest);
    }
    parts
}

/// git global options between `git` and the subcommand.
const GIT_GLOBAL_OPTIONS: &str = r#"(?:-{1,2}[^\s;&|]+(?:\s+(?:"[^"]*"|'[^']*'|[^\s;&|]+))?\s+)*"#;

fn discard_checkout_pattern() -> fancy_regex::Regex {
    fancy_regex::Regex::new(&format!(
        r"\bgit\s+{GIT_GLOBAL_OPTIONS}checkout\s+(?:(?:(?:-[fm]|--ours|--theirs|--conflict=\S+)\s+)*(?:--\s+)?(?:\.\/?|:\/)|[^\s;&|()]+\s+(?:--\s+)?(?:\.\/?|:\/)|(?:-f|--force)\s+[^\s;&|()]+)(?=\s|$|[;&|)])"
    ))
    .expect("checkout discard regex")
}

fn discard_restore_pattern() -> fancy_regex::Regex {
    fancy_regex::Regex::new(&format!(
        r"\bgit\s+{GIT_GLOBAL_OPTIONS}restore\s+(?:(?:--source|--worktree)(?:=\S+)?\s+|-s(?:\s+\S+|[^\s]+)\s+|-W\s+|--\s+)?(?:\.\/?|:\/)(?=\s|$|[;&|)])"
    ))
    .expect("restore discard regex")
}

fn discard_reset_pattern() -> fancy_regex::Regex {
    fancy_regex::Regex::new(&format!(
        r"\bgit\s+{GIT_GLOBAL_OPTIONS}reset\s+(?:(?:-[^\s;&|]+)\s+)*--hard\b"
    ))
    .expect("reset discard regex")
}

fn discard_clean_pattern() -> fancy_regex::Regex {
    fancy_regex::Regex::new(&format!(r"\bgit\s+{GIT_GLOBAL_OPTIONS}clean\s+([^;&|]*)"))
        .expect("clean discard regex")
}

fn is_forced_clean_segment(args: &str) -> bool {
    let tokens: Vec<&str> = split_ws(args);
    let option_end = tokens.iter().position(|t| *t == "--");
    let option_tokens: &[&str] = match option_end {
        Some(end) => &tokens[..end],
        None => &tokens,
    };
    let forces: Vec<&&str> = option_tokens
        .iter()
        .filter(|arg| {
            if arg.starts_with("--") {
                arg.starts_with("--force")
            } else {
                arg.starts_with('-') && arg.contains('f')
            }
        })
        .collect();
    if forces.is_empty() {
        return false;
    }
    !option_tokens.iter().any(|arg| {
        *arg == "--dry-run" || (arg.starts_with('-') && !arg.starts_with("--") && arg.contains('n'))
    })
}

/// Replace characters inside single- or double-quoted spans with spaces so the discard matcher
/// cannot match quoted data; character positions stay identical. Command substitution (`$(...)`,
/// backticks) is left live because it executes; unquoted `#` at a word boundary starts a comment.
fn mask_quoted_spans(command: &str) -> Vec<char> {
    let mut chars: Vec<char> = command.chars().collect();
    let mut quote: Option<char> = None;
    let len = chars.len();
    let mut i = 0usize;
    while i < len {
        let ch = chars[i];
        if quote.is_none() {
            let prev = if i > 0 { Some(chars[i - 1]) } else { None };
            if ch == '#'
                && (i == 0
                    || prev.is_none_or(|p| {
                        p.is_whitespace() || matches!(p, ';' | '&' | '|' | '(' | ')' | '{' | '}')
                    }))
            {
                let mut j = i;
                while j < len && chars[j] != '\n' {
                    chars[j] = ' ';
                    j += 1;
                }
                i = j;
                continue;
            }
            if ch == '"' || ch == '\'' {
                quote = Some(ch);
            }
        } else if quote == Some('\'') {
            if ch == '\'' {
                quote = None;
            } else {
                chars[i] = ' ';
            }
        } else if ch == '"' {
            quote = None;
        } else if ch == '\\' && i + 1 < len {
            chars[i] = ' ';
            chars[i + 1] = ' ';
            i += 1;
        } else if ch == '$' && i + 1 < len && chars[i + 1] == '(' {
            let mut depth = 0i32;
            let mut j = i;
            while j < len {
                if chars[j] == '(' {
                    depth += 1;
                } else if chars[j] == ')' {
                    depth -= 1;
                    if depth == 0 {
                        break;
                    }
                }
                j += 1;
            }
            i = j.saturating_sub(1);
        } else if ch == '`' {
            let mut j = i + 1;
            while j < len && chars[j] != '`' {
                j += 1;
            }
            i = j.saturating_sub(1);
        } else {
            chars[i] = ' ';
        }
        i += 1;
    }
    chars
}

/// Find every destructive git discard command in `command`, returning the
/// byte index where each `git` token starts (empty when none match).
pub fn find_destructive_git_discard_commands(command: &str) -> Vec<usize> {
    let masked: String = mask_quoted_spans(command).into_iter().collect();
    let mut indices: Vec<usize> = Vec::new();
    for pattern in [
        discard_checkout_pattern(),
        discard_restore_pattern(),
        discard_reset_pattern(),
    ] {
        for m in pattern.find_iter(&masked).flatten() {
            indices.push(m.start());
        }
    }
    for caps in discard_clean_pattern().captures_iter(&masked).flatten() {
        if let Some(args) = caps.get(1) {
            if is_forced_clean_segment(args.as_str()) {
                indices.push(caps.get(0).map(|m| m.start()).unwrap_or_default());
            }
        }
    }
    indices.sort_unstable();
    indices
}

/// True when `command` contains a git discard command.
#[allow(dead_code)]
pub fn is_destructive_git_discard_command(command: &str) -> bool {
    !find_destructive_git_discard_commands(command).is_empty()
}

/// Where a discard command's probe must run.
#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct DiscardProbeTarget {
    /// Shell prefix relocating the probe, for example `cd sub && `.
    pub relocation_prefix: Option<String>,
    /// git status command for this discard.
    pub git_status_command: String,
}

/// Result of resolving a discard command's probe location.
#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) enum DiscardProbeResolution {
    /// No relocation is needed; probe in the tool cwd.
    NotRelocated,
    /// The target repository cannot be resolved safely; refuse.
    Unresolvable,
    /// Probe must run with the given relocation.
    Target(DiscardProbeTarget),
}

/// Shell separators treated by segment splitting.
const SEPARATORS: [&str; 5] = ["&&", "||", ";", "|", "\n"];

/// Split keeping separators (TS: `split(/(&&|\|\||;|\||\n)/)`). Runs on
/// every bash command before execution, so it must stay linear: the old
/// per-position `chars[i..]` collection made it quadratic, and a
/// 100,000-character heredoc stalled the agent for seconds before the
/// command even ran.
fn split_with_separators(text: &str) -> Vec<String> {
    let chars: Vec<char> = text.chars().collect();
    let len = chars.len();
    let mut parts = Vec::new();
    let mut current = String::new();
    let mut i = 0usize;
    while i < len {
        let sep = match chars[i] {
            '&' if i + 1 < len && chars[i + 1] == '&' => Some("&&"),
            '|' if i + 1 < len && chars[i + 1] == '|' => Some("||"),
            '|' => Some("|"),
            ';' => Some(";"),
            '\n' => Some("\n"),
            _ => None,
        };
        if let Some(sep) = sep {
            if !current.is_empty() {
                parts.push(std::mem::take(&mut current));
            }
            parts.push(sep.to_string());
            i += sep.chars().count();
        } else {
            current.push(chars[i]);
            i += 1;
        }
    }
    if !current.is_empty() {
        parts.push(current);
    }
    parts
}

/// Split on separators, dropping them (TS: `split(/&&|\|\||;|\||\n/)`).
fn split_on_separators(text: &str) -> Vec<String> {
    split_with_separators(text)
        .into_iter()
        .filter(|part| !SEPARATORS.contains(&part.as_str()))
        .collect()
}

pub fn resolve_discard_probe_target(
    command: &str,
    discard_index: usize,
    user_command_start: usize,
) -> DiscardProbeResolution {
    let prefix = &command[..discard_index];
    let invocation = &command[discard_index..];
    // A discard inside the configured command prefix would be replayed by the
    // probe itself; refuse instead of executing it during probing.
    if user_command_start > 0 && discard_index < user_command_start {
        return DiscardProbeResolution::Unresolvable;
    }
    let tokens = split_ws(invocation);

    // git -C <dir> (or repository-relocating global options) on the discard invocation itself.
    let mut dash_c_dir: Option<String> = None;
    let mut subcommand_index: Option<usize> = None;
    for (index, token) in tokens.iter().enumerate() {
        if index == 0 {
            continue; // "git"
        }
        if *token == "reset" || *token == "checkout" || *token == "clean" || *token == "restore" {
            subcommand_index = Some(index);
            break;
        }
        if *token == "-C" {
            let dir = tokens.get(index + 1).copied();
            // A quoted, escaped, or substituted path cannot be replayed as a
            // single token; refuse rather than probe a truncated directory.
            let Some(dir) = dir else {
                return DiscardProbeResolution::Unresolvable;
            };
            if dir.contains(['"', '\'', '\\', '$', '`']) {
                return DiscardProbeResolution::Unresolvable;
            }
            // Repeated -C paths are relative to the preceding one.
            dash_c_dir = Some(match dash_c_dir {
                Some(existing) => format!("{existing} -C {dir}"),
                None => dir.to_string(),
            });
        } else if token.starts_with("--git-dir")
            || token.starts_with("--work-tree")
            || token.starts_with("--prefix")
        {
            return DiscardProbeResolution::Unresolvable;
        } else if *token == "-c" {
            let config = tokens.get(index + 1).copied();
            // core.worktree/core.bare relocate the repository.
            if let Some(config) = config {
                if config.starts_with("core.worktree") || config.starts_with("core.bare") {
                    let relocates = config
                        .strip_prefix("core.worktree")
                        .or_else(|| config.strip_prefix("core.bare"))
                        .is_some_and(|rest| rest.is_empty() || rest.starts_with('='));
                    if relocates {
                        return DiscardProbeResolution::Unresolvable;
                    }
                }
            }
        }
        // Other flags do not relocate.
    }

    // git clean -x/-X also deletes ignored files, so its probe includes them.
    let mut clean_removes_ignored = false;
    if let Some(sub_index) = subcommand_index {
        if tokens[sub_index] == "clean" {
            for token in &tokens[sub_index + 1..] {
                if *token == "--" {
                    break; // everything after -- is a pathspec
                }
                if token.starts_with("--") {
                    continue;
                }
                if token.starts_with('-') && token[1..].contains(['x', 'X']) {
                    clean_removes_ignored = true;
                    break;
                }
            }
        }
    }

    // Inline env assignments directly before the git invocation relocate the
    // target repository; replay them in the probe, or refuse when they cannot.
    let last_segment = split_on_separators(prefix).pop().unwrap_or_default();
    let leading_tokens: Vec<&str> = split_ws(last_segment.trim());
    let assignment_re = fancy_regex::Regex::new(r#"^[A-Za-z_][A-Za-z0-9_]*=[^\s$`;&|()<>"!]+$"#)
        .expect("assignment regex");
    for token in &leading_tokens {
        if assignment_re.is_match(token).unwrap_or(false) {
            continue; // replayable assignment
        }
        // Wrappers that cannot change directory or select another repository.
        if *token == "sudo"
            || *token == "env"
            || *token == "command"
            || *token == "builtin"
            || token.ends_with('/')
        {
            continue;
        }
        return DiscardProbeResolution::Unresolvable;
    }
    let assignments: Vec<&str> = leading_tokens
        .iter()
        .copied()
        .filter(|token| token.contains('='))
        .collect();
    let env_prefix = if assignments.is_empty() {
        String::new()
    } else {
        format!("{} ", assignments.join(" "))
    };

    // cd relocations earlier in the command.
    let cd_re = fancy_regex::Regex::new(r"\b(cd|pushd)\b").expect("cd regex");
    let has_cd = cd_re.is_match(prefix).unwrap_or(false) || prefix.contains('(');
    let mut persistent_cd_args: Vec<String> = Vec::new();
    let mut grouped_cd_args: Vec<String> = Vec::new();
    let mut saw_cd = false;
    let mut paren_depth: i64 = 0;
    let mut cd_pending_separator = false;
    if has_cd {
        let mut offset = 0usize;
        for part in split_with_separators(prefix) {
            let start = offset;
            offset += part.len();
            if start < user_command_start {
                continue; // command-prefix region: replayed as-is
            }
            let is_separator = SEPARATORS.contains(&part.as_str());
            if is_separator {
                if cd_pending_separator && (part == ";" || part == "\n") {
                    // The discard's directory depends on the cd succeeding.
                    return DiscardProbeResolution::Unresolvable;
                }
                if part == "||" || part == "|" {
                    if saw_cd {
                        return DiscardProbeResolution::Unresolvable;
                    }
                    continue;
                }
                cd_pending_separator = false;
                continue;
            }
            let trimmed = part.trim();
            let opens = part.matches('(').count() as i64;
            let closes = part.matches(')').count() as i64;
            let inside_group = paren_depth > 0 || opens > 0;
            paren_depth = 0.max(paren_depth + opens - closes);
            if inside_group {
                let stripped: String = trimmed
                    .trim_start_matches(|c: char| c == '(' || c.is_whitespace())
                    .trim_end_matches(|c: char| c == ')' || c.is_whitespace())
                    .to_string();
                if let Some(arg) = stripped.strip_prefix("cd") {
                    let arg = arg.trim();
                    if !arg.is_empty()
                        && arg.contains(['$', '`', ';', '&', '|', '(', ')', '<', '>', '#', '"'])
                    {
                        return DiscardProbeResolution::Unresolvable;
                    }
                    saw_cd = true;
                    cd_pending_separator = true;
                    grouped_cd_args.push(arg.to_string());
                } else if cd_re.is_match(trimmed).unwrap_or(false) {
                    return DiscardProbeResolution::Unresolvable;
                }
                if paren_depth == 0 {
                    grouped_cd_args.clear();
                }
                continue;
            }
            if trimmed == "pushd" || trimmed.starts_with("pushd ") {
                return DiscardProbeResolution::Unresolvable;
            }
            let Some(arg) = trimmed.strip_prefix("cd") else {
                cd_pending_separator = false;
                continue; // not a cd: cannot change cwd
            };
            let arg = arg.trim();
            // An arg we cannot replay safely leaves the target repository
            // unknown; refuse rather than probe blindly.
            let balanced = arg.matches('"').count() % 2 == 0 && arg.matches('\'').count() % 2 == 0;
            if !balanced
                || (!arg.is_empty()
                    && arg.contains(['$', '`', ';', '&', '|', '(', ')', '<', '>', '#']))
            {
                return DiscardProbeResolution::Unresolvable;
            }
            saw_cd = true;
            cd_pending_separator = true;
            persistent_cd_args.push(arg.to_string());
        }
    }
    let cd_args = if paren_depth > 0 {
        let mut args = persistent_cd_args.clone();
        args.extend(grouped_cd_args);
        args
    } else {
        persistent_cd_args
    };

    if cd_args.is_empty() && dash_c_dir.is_none() && !clean_removes_ignored && env_prefix.is_empty()
    {
        return DiscardProbeResolution::NotRelocated;
    }
    let ignored = if clean_removes_ignored {
        " --ignored=matching"
    } else {
        ""
    };
    let cd_prefix = if cd_args.is_empty() {
        String::new()
    } else {
        let joins = cd_args
            .iter()
            .map(|arg| {
                if arg.is_empty() {
                    "cd".to_string()
                } else {
                    format!("cd {arg}")
                }
            })
            .collect::<Vec<_>>()
            .join(" && ");
        format!("{joins} && ")
    };
    let relocation = format!("{cd_prefix}{env_prefix}");
    DiscardProbeResolution::Target(DiscardProbeTarget {
        relocation_prefix: if relocation.is_empty() {
            None
        } else {
            Some(relocation)
        },
        git_status_command: format!(
            "{}status --porcelain --untracked-files=all{ignored}",
            match dash_c_dir.as_deref() {
                Some(dir) => format!("git -C {dir} "),
                None => "git ".to_string(),
            }
        ),
    })
}

pub(crate) fn is_truthy_env_value(value: Option<&String>) -> bool {
    match value {
        Some(v) => !v.is_empty() && v != "0",
        None => false,
    }
}

pub(crate) fn format_dirty_tree_refusal(
    dirty_paths: &[String],
    includes_ignored_files: bool,
) -> String {
    let listed_count = dirty_paths.len().min(MAX_DIRTY_PATHS_LISTED);
    let listed = &dirty_paths[..listed_count];
    let elided = dirty_paths.len() - listed_count;
    let noun = if includes_ignored_files {
        "uncommitted or ignored file(s)"
    } else {
        "uncommitted change(s)"
    };
    let mut lines = vec![format!(
        "Refusing to run this destructive git command: the working tree has {} {noun}.",
        dirty_paths.len()
    )];
    lines.extend(listed.iter().map(|line| format!("  {line}")));
    if elided > 0 {
        lines.push(format!("  ... and {elided} more"));
    }
    lines.push(String::new());
    lines.push("Commit, stash, or stage your work first.".to_string());
    lines.push(format!(
        "To discard these changes intentionally, retry with allowDestructiveGit: true, or set {BASH_DESTRUCTIVE_GIT_BYPASS_ENV}=1."
    ));
    lines.join("\n")
}

/// Env var opt-in: seconds for the auto-timeout applied to matching unbounded
/// scans; unset or non-positive means off (the scan still runs, only warned).
pub(crate) const SCAN_TIMEOUT_ENV: &str = "PRIME_AGENT_SCAN_TIMEOUT";

/// A home-scale scan root: the home tree itself (`~`, `~/`, `$HOME`,
/// `${HOME}`) or one component below it (`~/Documents`, the incident dirs)
/// walks a top-level home subtree, so a recursive scan there costs minutes,
/// not milliseconds. Deeper `~`-rooted paths (`~/work/repo/src`) are
/// ordinary project trees and stay quiet. Exact-name tests keep other env
/// vars (`$HOMEDIR`, `${HOMEBREW_PREFIX}`) out.
fn is_home_scale_root(token: &str) -> bool {
    // A grouping paren glued to the token (`(rg pattern $HOME)`) is
    // stripped first — only ')': "${HOME}"'s closing brace is part of
    // the expansion.
    let token = token.trim_end_matches(')');
    if matches!(
        token,
        "~" | "~/" | "$HOME" | "$HOME/" | "${HOME}" | "${HOME}/"
    ) {
        return true;
    }
    // One component below the root, no deeper: `~/Documents` is a top-level
    // home subtree, `~/work/repo/src` is a project tree.
    let rest = token
        .strip_prefix("~/")
        .or_else(|| token.strip_prefix("$HOME/"))
        .or_else(|| token.strip_prefix("${HOME}/"))
        .unwrap_or("");
    let rest = rest.trim_end_matches('/');
    !rest.is_empty() && !rest.contains('/')
}

/// rg's depth bounds: `--max-depth[=]N`/`-d N`/`-dN` with a numeric
/// argument. A bare token (the filename `maxdepth.txt`) never counts.
fn is_rg_depth_bound(token: &str, next: Option<&str>) -> bool {
    let is_number = |s: &str| !s.is_empty() && s.chars().all(|c| c.is_ascii_digit());
    ((token == "--max-depth" || token == "-d") && next.is_some_and(is_number))
        || token.strip_prefix("--max-depth=").is_some_and(is_number)
        || token.strip_prefix("-d").is_some_and(is_number)
}

/// find's depth bound: `-maxdepth N` with a numeric argument.
fn is_find_depth_bound(token: &str, next: Option<&str>) -> bool {
    let is_number = |s: &str| !s.is_empty() && s.chars().all(|c| c.is_ascii_digit());
    token == "-maxdepth" && next.is_some_and(is_number)
}

/// Redirection operators: the token after one is a target file, not a scan
/// root, so a project-local scan writing to ~ must not warn. Mirrors the
/// Python kernel helper.
fn is_redirect_operator(token: &str) -> bool {
    let op = token.trim_start_matches(|c: char| c.is_ascii_digit());
    matches!(
        op,
        ">" | ">>" | "<" | "<>" | ">|" | ">&" | "<&" | "&>" | "&>>"
    )
}

/// find's global options precede the paths, so they do not start the
/// expression; a bare `-O`/`-D` consumes its operand token.
fn is_find_global_option(token: &str) -> bool {
    matches!(token, "-H" | "-L" | "-P" | "-X" | "-d" | "-s" | "-x" | "--")
        || token.starts_with("-O")
        || token.starts_with("-D")
}

/// Masked quoted arguments leave this placeholder token behind: bash saw an
/// argument, and the scanner's positional pattern-skip skips the placeholder
/// instead of a scan root that follows it.
const MASK_PLACEHOLDER: char = '\u{1}';

/// Mask single-quoted spans, double-quoted literal data, unquoted comments,
/// and heredoc bodies. Double quotes still expand `$HOME`/`${HOME}` and run
/// command substitution, so a double-quoted span that starts with a home
/// expansion stays fully live (`find "$HOME/Documents"` is a home-scale
/// scan) while embedded expansions and other literal data are masked
/// (`grep -rl "docs$HOME" src/` has no home root). All-digit quoted spans
/// stay visible (a quoted `--max-depth "3"` argument is a bound, not
/// data). Heredoc bodies are input text, never executed, so the whole body
/// through the delimiter line is masked — except that an unquoted delimiter
/// still expands, so `$(...)` and backticks in its body stay live.
/// Heredoc bodies masked per command: each one scans forward for its
/// terminator line, so a malformed command full of `<<` operators must not
/// turn the preflight scan quadratic.
const HEREDOC_MASK_CAP: usize = 8;

fn mask_scan_literals(command: &str) -> String {
    let mut chars: Vec<char> = command.chars().collect();
    let len = chars.len();
    let mut heredocs_masked = 0usize;
    let mut i = 0usize;
    while i < len {
        let ch = chars[i];
        if ch == '\'' {
            // An all-digit quoted span is an argument (`-maxdepth '2'`), not
            // data: keep the digits visible for bound detection.
            let mut j = i + 1;
            while j < len && chars[j].is_ascii_digit() {
                j += 1;
            }
            if j > i + 1 && chars.get(j) == Some(&'\'') {
                chars[i] = ' ';
                chars[j] = ' ';
                i = j + 1;
                continue;
            }
            let mut j = i + 1;
            while j < len && chars[j] != '\'' {
                chars[j] = ' ';
                j += 1;
            }
            // The masked argument leaves a placeholder token: bash saw an
            // argument here, and the scanner's positional pattern-skip must
            // skip the placeholder, not a scan root that follows it.
            chars[i] = MASK_PLACEHOLDER;
            if j < len {
                chars[j] = ' ';
            }
            i = j + 1;
            continue;
        }
        if ch == '$' && chars.get(i + 1) == Some(&'(') && chars.get(i + 2) == Some(&'(') {
            // Arithmetic expansion `$((...))` is not command text for the
            // guard: skip it whole so a `<<` shift inside it (`$((a<<b))`)
            // cannot read as a heredoc operator.
            let mut depth = 0i32;
            let mut j = i + 1;
            while j < len {
                if chars[j] == '(' {
                    depth += 1;
                } else if chars[j] == ')' {
                    depth -= 1;
                    if depth == 0 {
                        break;
                    }
                }
                j += 1;
            }
            i = if j < len { j + 1 } else { len };
            continue;
        }
        if ch == '<'
            && chars.get(i + 1) == Some(&'<')
            && chars.get(i + 2) != Some(&'<')
            && (i == 0 || chars[i - 1] != '<')
            && heredocs_masked < HEREDOC_MASK_CAP
        {
            heredocs_masked += 1;
            // Heredoc `<<[-]DELIM` in all its spellings (`cat<<EOF`,
            // `2<<EOF`, `<< EOF`, `<< 'EOF'`): the body until the delimiter
            // line is input text, never executed, so mask it. Any nonempty
            // delimiter word counts (`<<123` too): arithmetic shifts live
            // inside `$((...))`, which this scan skips whole, so `1<<2`
            // never reaches this branch. `<<<` here-strings supply one word,
            // never body lines.
            let mut j = i + 2;
            let mut tabbed = false;
            if chars.get(j) == Some(&'-') {
                tabbed = true;
                j += 1;
            }
            while j < len && (chars[j] == ' ' || chars[j] == '\t') {
                j += 1;
            }
            let mut word = String::new();
            let mut backslashed = false;
            while j < len {
                // The delimiter word stops at shell operators outside quoted
                // text, so `<<EOF; cmd` leaves `; cmd` live on the start
                // line (`<<'EOF;'` keeps the quoted semicolon). A backslash
                // quotes the next character (`<<\EOF` is the quoted
                // delimiter `EOF`).
                let c = chars[j];
                if c == '\'' || c == '"' {
                    word.push(c);
                    j += 1;
                    while j < len && chars[j] != c {
                        word.push(chars[j]);
                        j += 1;
                    }
                    if j < len {
                        word.push(chars[j]);
                        j += 1;
                    }
                } else if c == '\\' && j + 1 < len {
                    backslashed = true;
                    word.push(chars[j + 1]);
                    j += 2;
                } else if c.is_whitespace() || matches!(c, ';' | '&' | '|' | '(' | ')' | '<' | '>')
                {
                    break;
                } else {
                    word.push(c);
                    j += 1;
                }
            }
            // Shell quote removal across the whole delimiter word:
            // `E'OF'` is `EOF`, and any quoting or escaping anywhere in the
            // word disables expansion in the body.
            let quoted = word.contains('\'') || word.contains('"') || backslashed;
            let delim: String = word.chars().filter(|c| *c != '\'' && *c != '"').collect();
            // A present (even empty, `<<''`) delimiter word is a heredoc;
            // a missing one is not.
            let is_delimiter = !word.is_empty();
            if is_delimiter {
                let mut body = j;
                while body < len && chars[body] != '\n' {
                    body += 1;
                }
                if body < len {
                    body += 1; // first char of the body
                               // The terminator line ends the heredoc even in the
                               // middle of a substitution; find it on the raw text.
                    let mut probe = body;
                    let region_end = loop {
                        let mut eol = probe;
                        while eol < len && chars[eol] != '\n' {
                            eol += 1;
                        }
                        let mut start = probe;
                        if tabbed {
                            while start < eol && chars[start] == '\t' {
                                start += 1;
                            }
                        }
                        if chars[start..eol].iter().collect::<String>() == delim {
                            break probe; // terminator line: body ends here
                        }
                        if eol >= len {
                            break len; // no terminator: bash reads to EOF
                        }
                        probe = eol + 1;
                    };
                    // Mask the whole body region in one pass: with an
                    // unquoted delimiter, $(...) and backticks stay live
                    // (bash runs them in the body, and a substitution may
                    // span lines); an escaped \$(...) or \` is literal and
                    // masked; everything else is data. The terminator line
                    // is data too.
                    let mut term_eol = region_end;
                    while term_eol < len && chars[term_eol] != '\n' {
                        term_eol += 1;
                    }
                    if quoted {
                        for c in &mut chars[body..term_eol] {
                            *c = ' ';
                        }
                    } else {
                        let mut k = body;
                        let mut sub_depth = 0i32;
                        let mut sub_quote: Option<char> = None;
                        while k < region_end {
                            let c = chars[k];
                            if sub_depth > 0 {
                                // Inside a live command substitution; the
                                // paren depth carries across body lines, and
                                // quoted parens do not count toward it.
                                if let Some(qc) = sub_quote {
                                    if c == qc {
                                        sub_quote = None;
                                    }
                                } else if c == '\'' || c == '"' {
                                    sub_quote = Some(c);
                                } else if c == '(' {
                                    sub_depth += 1;
                                } else if c == ')' {
                                    sub_depth -= 1;
                                }
                                k += 1;
                            } else if c == '\\'
                                && k + 1 < region_end
                                && matches!(chars[k + 1], '$' | '`' | '\\')
                            {
                                // An escaped \$, \`, or \\ is literal.
                                chars[k] = ' ';
                                chars[k + 1] = ' ';
                                k += 2;
                            } else if c == '$' && k + 1 < region_end && chars[k + 1] == '(' {
                                sub_depth = 1;
                                k += 2;
                            } else if c == '`' {
                                k += 1;
                                while k < region_end && chars[k] != '`' {
                                    k += 1;
                                }
                                k += 1;
                            } else {
                                chars[k] = ' ';
                                k += 1;
                            }
                        }
                        for c in &mut chars[region_end..term_eol] {
                            *c = ' ';
                        }
                    }
                }
            }
            i += 2;
            continue;
        }
        if ch == '"' {
            // An all-digit quoted span is an argument (`--max-depth "3"`),
            // not data: keep the digits visible for bound detection.
            let mut j = i + 1;
            while j < len && chars[j].is_ascii_digit() {
                j += 1;
            }
            if j > i + 1 && chars.get(j) == Some(&'"') {
                chars[i] = ' ';
                chars[j] = ' ';
                i = j + 1;
                continue;
            }
            // A span that starts with a home expansion is a path argument:
            // keep the whole span live so the expansion is never split into
            // its own token (`grep -rl "$HOME/needle" src/` keeps the
            // pattern whole for the positional pattern-skip in the scanner),
            // but mask separator characters inside it — quoted separators are
            // data and must not split the command into segments.
            if starts_with_home_expansion(&chars, i + 1) {
                let mut j = i + 1;
                while j < len && chars[j] != '"' {
                    j += 1;
                }
                let close = j;
                // Mask separator characters outside substitutions: quoted
                // separators are data, but a $(...)/backtick inside the span
                // still executes and its body must stay intact for the
                // substitution scan.
                let mut k = i + 1;
                let mut sub_depth = 0i32;
                let mut backtick = false;
                while k < close {
                    let c = chars[k];
                    if sub_depth > 0 {
                        if c == '(' {
                            sub_depth += 1;
                        } else if c == ')' {
                            sub_depth -= 1;
                        }
                        k += 1;
                    } else if backtick {
                        if c == '`' {
                            backtick = false;
                        }
                        k += 1;
                    } else if c == '$' && chars.get(k + 1) == Some(&'(') {
                        sub_depth = 1;
                        k += 2;
                    } else if c == '`' {
                        backtick = true;
                        k += 1;
                    } else {
                        // Quoted separators and spaces are data: replace them
                        // with the non-whitespace placeholder so the span
                        // stays ONE token (`"$HOME/a|$HOME/b"` never splits
                        // into a root-looking fragment).
                        if c.is_whitespace() {
                            chars[k] = MASK_PLACEHOLDER;
                        }
                        k += 1;
                    }
                }
                chars[i] = ' ';
                if close < len {
                    chars[close] = ' ';
                }
                i = close + 1;
                continue;
            }
            chars[i] = MASK_PLACEHOLDER;
            i += 1;
            while i < len && chars[i] != '"' {
                if chars[i] == '\\' && i + 1 < len {
                    chars[i] = ' ';
                    chars[i + 1] = ' ';
                    i += 2;
                } else if chars[i] == '$' && i + 1 < len && chars[i + 1] == '(' {
                    let mut depth = 0i32;
                    let mut dq_quote: Option<char> = None;
                    let mut j = i;
                    while j < len {
                        let qc = chars[j];
                        match dq_quote {
                            // Quoted parens do not count toward the depth.
                            Some(q) => {
                                if qc == q {
                                    dq_quote = None;
                                }
                            }
                            None => {
                                if qc == '\'' || qc == '"' {
                                    dq_quote = Some(qc);
                                } else if qc == '(' {
                                    depth += 1;
                                } else if qc == ')' {
                                    depth -= 1;
                                    if depth == 0 {
                                        break;
                                    }
                                }
                            }
                        }
                        j += 1;
                    }
                    i = if j < len { j + 1 } else { len };
                } else if chars[i] == '`' {
                    i += 1;
                    while i < len && chars[i] != '`' {
                        i += 1;
                    }
                    i += 1;
                } else {
                    chars[i] = ' ';
                    i += 1;
                }
            }
            if i < len {
                chars[i] = ' '; // closing quote
            }
            i += 1;
            continue;
        }
        if ch == '#'
            && (i == 0
                || chars[i - 1].is_whitespace()
                || matches!(chars[i - 1], ';' | '&' | '|' | '(' | ')' | '<' | '>'))
        {
            // `#` starts a comment at a word boundary, including right
            // after a shell operator (`echo ok;# comment`).
            while i < len && chars[i] != '\n' {
                chars[i] = ' ';
                i += 1;
            }
            continue;
        }
        i += 1;
    }
    chars.into_iter().collect()
}

/// True when `chars[at..]` starts with the `$HOME` or `${HOME}` expansion.
/// A following variable-name character (`$HOMEDIR`) is a different variable.
fn starts_with_home_expansion(chars: &[char], at: usize) -> bool {
    let is_name_char = |c: char| c.is_ascii_alphanumeric() || c == '_';
    if chars.get(at + 1) == Some(&'{') {
        let rest: String = chars[at..chars.len().min(at + 7)].iter().collect();
        rest.starts_with("${HOME}")
    } else {
        let rest: String = chars[at..chars.len().min(at + 5)].iter().collect();
        rest == "$HOME" && chars.get(at + 5).is_none_or(|c| !is_name_char(*c))
    }
}

/// True when `command` runs a recursive scan (grep -r, rg, find) over a
/// home-scale root with no bound: no tool timeout, no `timeout` prefix, and no
/// depth limit. Output caps (`| head`) never bound scan time — a no-match scan
/// still walks every file — so this is the incident shape: a recursive grep
/// over six home-scale directories piped to `head` held a turn for 13 minutes.
/// The bash tool call is awaited inline by the agent loop, so an unbounded
/// scan stalls the whole turn; callers warn (never block), because searches
/// are legitimate.
pub(crate) fn is_unbounded_home_scan(command: &str, tool_timeout: Option<f64>) -> bool {
    // A non-positive tool timeout is no deadline for the executor
    // (bash_local filters `t > 0.0`), so it does not bound the scan.
    if tool_timeout.is_some_and(|t| t > 0.0) {
        return false;
    }
    scan_command_text(command)
}

/// Substitution nesting deeper than this is not scanned: a malformed
/// deeply-nested command must stay cheap on both stack and time, and no
/// real agent command nests scans this deep.
const SUBSTITUTION_DEPTH_CAP: usize = 8;

/// Scan-detect on the masked command plus every command-substitution body:
/// `echo "$(grep -rl needle ~/Documents)"` runs the scan in a subshell, so a
/// substitution body is a command too (and so are its own substitutions).
/// Iterative worklist with a depth cap: recursion would overflow the agent's
/// stack on deeply nested malformed input before the executor ever starts,
/// and an uncapped walk would spend quadratic time on it.
fn scan_command_text(command: &str) -> bool {
    let mut worklist: Vec<(String, usize)> = vec![(command.to_string(), 0)];
    while let Some((text, depth)) = worklist.pop() {
        let masked = mask_scan_literals(&text);
        let (parent, bodies) = extract_substitutions(&masked);
        if segments_contain_unbounded_scan(&parent) {
            return true;
        }
        if depth + 1 < SUBSTITUTION_DEPTH_CAP {
            for body in bodies {
                worklist.push((body, depth + 1));
            }
        }
    }
    false
}

/// Replace every `$(...)` span (paren-depth matched, quote-aware) and
/// backtick span in a masked command with a placeholder, returning the
/// parent text with bodies blanked plus the bodies themselves: the bodies
/// execute, so they are command text — but they are scanned separately, so
/// a quoted separator inside one must never split the parent command.
/// A backslash-escaped `\$(` or `` \` `` is literal data, not a
/// substitution opener.
fn is_escaped_at(chars: &[char], at: usize) -> bool {
    chars[..at].iter().rev().take_while(|&&c| c == '\\').count() % 2 == 1
}

fn extract_substitutions(masked: &str) -> (String, Vec<String>) {
    let mut chars: Vec<char> = masked.chars().collect();
    let len = chars.len();
    let mut bodies = Vec::new();
    let mut i = 0usize;
    while i < len {
        if chars[i] == '$' && chars.get(i + 1) == Some(&'(') && !is_escaped_at(&chars, i) {
            let mut depth = 0i32;
            let mut quote: Option<char> = None;
            let mut j = i + 1;
            while j < len {
                let c = chars[j];
                match quote {
                    // Quoted parens (`$(echo '(')`) do not count toward the
                    // depth; the substitution still closes at its real `)`.
                    Some(q) => {
                        if c == q {
                            quote = None;
                        }
                    }
                    None => {
                        if c == '\'' || c == '"' {
                            quote = Some(c);
                        } else if c == '(' {
                            depth += 1;
                        } else if c == ')' {
                            depth -= 1;
                            if depth == 0 {
                                let body: String = chars[i + 2..j].iter().collect();
                                if !body.trim().is_empty() {
                                    bodies.push(body);
                                }
                                // Blank the whole span in the parent: the
                                // body is scanned on its own.
                                for c in &mut chars[i..=j] {
                                    *c = ' ';
                                }
                                chars[i] = MASK_PLACEHOLDER;
                                i = j;
                                break;
                            }
                        }
                    }
                }
                j += 1;
            }
            // An unmatched `$(` has no closing paren anywhere ahead: the
            // remaining suffix is its unclosed body, so stop scanning there
            // instead of rescanning it for every later `$(` (quadratic).
            if j >= len {
                break;
            }
        } else if chars[i] == '`' && !is_escaped_at(&chars, i) {
            if let Some(j) = chars[i + 1..].iter().position(|&c| c == '`') {
                let end = i + 1 + j;
                let body: String = chars[i + 1..end].iter().collect();
                if !body.trim().is_empty() {
                    bodies.push(body);
                }
                for c in &mut chars[i..=end] {
                    *c = ' ';
                }
                chars[i] = MASK_PLACEHOLDER;
                i = end;
            }
        }
        i += 1;
    }
    (chars.into_iter().collect(), bodies)
}

fn segments_contain_unbounded_scan(masked: &str) -> bool {
    for segment in split_on_separators(masked) {
        let mut tokens = split_ws(segment.trim());
        // Leading grouping operators: `(find ...)` and `{ ...; }` run the
        // same command, so the shape must survive grouping. Walk by index
        // and strip all prefixes at once: popping the head is quadratic in
        // the number of prefixes.
        let mut command_start = 0;
        while let Some(first) = tokens.get(command_start).copied() {
            let stripped = first.trim_start_matches(['(', '{']);
            if stripped.is_empty() {
                command_start += 1;
            } else {
                tokens[command_start] = stripped;
                break;
            }
        }
        let Some((first, rest)) = tokens[command_start..].split_first() else {
            continue;
        };
        if *first == "timeout" {
            continue; // bounded by the timeout(1) prefix
        }
        let rest: &[&str] = match *first {
            "grep" | "egrep" | "fgrep" => {
                let recursive = rest.iter().any(|t| {
                    t.starts_with("--recursive")
                        || (t.starts_with('-')
                            && !t.starts_with("--")
                            && t.len() > 1
                            && t.to_ascii_lowercase().contains('r'))
                });
                if recursive {
                    rest
                } else {
                    continue;
                }
            }
            // rg and find recurse by default.
            "rg" | "find" => rest,
            _ => continue,
        };
        // Depth bounds are tool-specific: rg takes --max-depth/-d, find
        // takes -maxdepth; the grep family has no depth option at all (a
        // `-d2` after `-e` is the pattern, not a bound).
        let bounded = match *first {
            "rg" => rest
                .iter()
                .enumerate()
                .any(|(i, t)| is_rg_depth_bound(t, rest.get(i + 1).copied())),
            "find" => rest
                .iter()
                .enumerate()
                .any(|(i, t)| is_find_depth_bound(t, rest.get(i + 1).copied())),
            _ => false,
        };
        if bounded {
            continue;
        }
        if *first == "find" {
            // find's syntax is `find [path...] [expression]`: a `-`-led
            // token starts the expression, and everything after it (-exec
            // bodies, -newer operands, ...) is operands, not scan roots —
            // so `find . -exec cp {} ~/backup/ \;` stays quiet. BSD's
            // `-f path` names the hierarchy itself. A redirection's target
            // is a file to write, never a scan root.
            let mut root_tokens: Vec<&str> = Vec::new();
            let mut expression = false;
            let mut i = 0;
            while i < rest.len() {
                let t = rest[i];
                if is_redirect_operator(t) {
                    i += 2; // the operator and its target
                    continue;
                }
                if expression {
                    i += 1;
                    continue;
                }
                if is_find_global_option(t) {
                    // A bare `-O`/`-D` consumes its operand token.
                    i += if t == "-O" || t == "-D" { 2 } else { 1 };
                    continue;
                }
                if t == "-f" {
                    if let Some(hierarchy) = rest.get(i + 1).copied() {
                        root_tokens.push(hierarchy);
                    }
                    i += 2;
                    continue;
                }
                if t.starts_with('-') {
                    expression = true;
                } else {
                    root_tokens.push(t);
                }
                i += 1;
            }
            if !root_tokens.iter().any(|t| is_home_scale_root(t)) {
                continue;
            }
            return true;
        }
        // grep-family and rg take their pattern as the first non-option
        // argument — it is pattern text, not a scan root, and a quoted
        // pattern containing $HOME (`grep -rl "$HOME/needle" src/`) must
        // not count as a home root (a masked pattern leaves a placeholder
        // in its position). Pattern options (`-e`, `--regexp`, `-f`,
        // `--file`) supply the pattern instead: their operands are skipped,
        // not roots. rg's `--files` listing mode takes no pattern at all, so
        // every positional is a path.
        // Pattern options belong to grep-family and rg only: BSD find's
        // `-f` supplies the hierarchy to walk, not a pattern file.
        let takes_pattern_options = matches!(*first, "grep" | "egrep" | "fgrep" | "rg");
        let rg_files_mode = *first == "rg" && rest.contains(&"--files");
        let pattern_from_option = takes_pattern_options
            && rest.iter().any(|t| {
                *t == "-e"
                    || *t == "--regexp"
                    || *t == "-f"
                    || *t == "--file"
                    || t.starts_with("--regexp=")
                    || t.starts_with("--file=")
            });
        let mut root_tokens: Vec<&str> = Vec::new();
        let mut skip_next = false;
        let mut pattern_skipped = rg_files_mode || pattern_from_option;
        let mut seen_ddash = false;
        for t in rest {
            if skip_next {
                skip_next = false; // the operand of a pattern option
                continue;
            }
            if is_redirect_operator(t) {
                skip_next = true; // its target is a file to write, not a root
                continue;
            }
            if !seen_ddash && *t == "--" {
                // `--` ends option parsing: the next positional is the
                // pattern even when it starts with `-`.
                seen_ddash = true;
                continue;
            }
            if !seen_ddash
                && takes_pattern_options
                && (*t == "-e" || *t == "--regexp" || *t == "-f" || *t == "--file")
            {
                skip_next = true;
                continue;
            }
            if takes_pattern_options && (t.starts_with("--regexp=") || t.starts_with("--file=")) {
                continue;
            }
            if !pattern_skipped
                && matches!(*first, "grep" | "egrep" | "fgrep" | "rg")
                && (seen_ddash || !t.starts_with('-'))
            {
                pattern_skipped = true; // the positional pattern
                continue;
            }
            root_tokens.push(t);
        }
        if !root_tokens.iter().any(|t| is_home_scale_root(t)) {
            continue; // project-local scans are bounded by the tree size
        }
        return true;
    }
    false
}

/// The opted-in auto-timeout for matching scans from the environment, if set.
pub(crate) fn scan_timeout_from_env(
    env: &std::collections::HashMap<String, String>,
) -> Option<f64> {
    env.get(SCAN_TIMEOUT_ENV)
        .and_then(|value| value.parse::<f64>().ok())
        .filter(|secs| {
            // `Duration::from_secs_f64` panics on values it cannot represent,
            // and `Instant::now() + duration` (the executor's deadline) panics
            // when the deadline cannot be represented on this platform
            // (Windows QPC ticks, macOS/Linux tv_sec) — reject both here so
            // only a usable timeout ever reaches the executor.
            *secs > 0.0
                && std::time::Duration::try_from_secs_f64(*secs)
                    .is_ok_and(|duration| std::time::Instant::now().checked_add(duration).is_some())
        })
}

/// The scan-cost warning: names the fix, never blocks the search.
pub(crate) fn format_scan_cost_warning(auto_timeout: Option<f64>) -> String {
    let base = "Warning: this recursive scan of home-scale directories is unbounded in time; output caps (like `| head`) do not bound scan time. Bound it with this tool's `timeout` parameter (not the shell `timeout` prefix, which stock macOS lacks while `2>/dev/null` masks its failure), a depth bound (`--max-depth` for rg, `-maxdepth` for find), or a narrower directory.";
    match auto_timeout {
        Some(secs) => {
            format!("{base} A {SCAN_TIMEOUT_ENV} scan timeout of {secs}s applies to this command.")
        }
        None => base.to_string(),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Process env is process-wide; the tests that read or mutate
    /// `PRIME_AGENT_SCAN_TIMEOUT` serialize on one lock (the `env_lock`
    /// convention from `agent_traces/tests.rs`), so the transient deadline a
    /// test sets across an await cannot reach a parallel `execute_bash`
    /// test in the same binary.
    fn env_lock() -> std::sync::MutexGuard<'static, ()> {
        static LOCK: std::sync::Mutex<()> = std::sync::Mutex::new(());
        LOCK.lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner)
    }

    /// `PRIME_AGENT_SCAN_TIMEOUT` set for the held scope, with the prior
    /// value (or its absence) restored on drop — including on assertion
    /// panics, which would otherwise skip a trailing remove.
    struct ScanTimeoutEnv(Option<std::ffi::OsString>);

    impl ScanTimeoutEnv {
        fn set(value: &str) -> Self {
            let guard = Self(std::env::var_os(SCAN_TIMEOUT_ENV));
            std::env::set_var(SCAN_TIMEOUT_ENV, value);
            guard
        }
    }

    impl Drop for ScanTimeoutEnv {
        fn drop(&mut self) {
            match self.0.take() {
                Some(value) => std::env::set_var(SCAN_TIMEOUT_ENV, value),
                None => std::env::remove_var(SCAN_TIMEOUT_ENV),
            }
        }
    }

    /// The incident command (session 01a15735): a recursive grep over six
    /// home-scale trees piped to `head`, held a turn for 13 minutes.
    const INCIDENT: &str = r"grep -rli -e 'training metrics' -e 'advanced dashboard' ~/Documents ~/Desktop ~/Claude ~/environments ~/outputs ~/Downloads 2>/dev/null | grep -viE '\.(pdf|jsonl|log|txt)$' | head -10; echo done";

    #[test]
    fn home_redirect_targets_and_find_expression_operands_do_not_warn() {
        // A redirection target or a find expression operand is not a scan
        // root (Cursor Bugbot round on the merge head): a project-local
        // scan writing to ~ must not warn or get the env auto-timeout.
        assert!(!is_unbounded_home_scan(
            "grep -rl needle . > ~/out.txt",
            None
        ));
        assert!(!is_unbounded_home_scan(
            "grep -rl needle src/ 2>> ~/err.log",
            None
        ));
        assert!(!is_unbounded_home_scan(
            "rg pattern . >> ~/results.txt",
            None
        ));
        assert!(!is_unbounded_home_scan(
            "cat < ~/in.txt | grep -rl needle . > ~/out.txt",
            None
        ));
        assert!(!is_unbounded_home_scan(
            r"find . -name '*.log' -exec cp {} ~/backup/ \;",
            None
        ));
        assert!(!is_unbounded_home_scan("find . -newer ~/stamp", None));
        // Real home roots still warn, redirects and all.
        assert!(is_unbounded_home_scan(
            "grep -rl needle ~/Documents > ~/out.txt",
            None
        ));
        assert!(is_unbounded_home_scan(
            "grep -rl needle ~/Documents 2> ~/err.log",
            None
        ));
        assert!(is_unbounded_home_scan(
            "find ~/Documents -name '*.pdf' > ~/out.txt",
            None
        ));
        assert!(is_unbounded_home_scan("find -f ~/Documents", None));
        // find's global options precede the paths, so a home root behind
        // -L/-H/-P/--/-O is still a scan root (bot round on the fix head).
        assert!(is_unbounded_home_scan(
            "find -L ~/Documents -name '*.pdf'",
            None
        ));
        assert!(is_unbounded_home_scan("find -H ~/Documents", None));
        assert!(is_unbounded_home_scan("find -P ~/Documents", None));
        assert!(is_unbounded_home_scan("find -- ~/Documents", None));
        assert!(is_unbounded_home_scan("find -X ~/Documents", None));
        assert!(is_unbounded_home_scan("find -O3 ~/Documents", None));
        assert!(is_unbounded_home_scan("find -O 3 ~/Documents", None));
        assert!(!is_unbounded_home_scan("find -L . -newer ~/stamp", None));
        assert!(!is_unbounded_home_scan(
            r"find -L . -name '*.log' -exec cp {} ~/backup/ \;",
            None
        ));
    }

    #[test]
    fn grouped_scans_warn_like_their_ungrouped_forms() {
        // A grouping operator before the command must not hide the shape
        // (Macroscope round on the fix head).
        assert!(is_unbounded_home_scan(
            "(find ~/Documents) | head -10",
            None
        ));
        assert!(is_unbounded_home_scan("{ find ~/Documents; }", None));
        assert!(is_unbounded_home_scan("((find ~/Documents))", None));
        assert!(is_unbounded_home_scan(
            "(grep -rl needle ~/Documents)",
            None
        ));
        assert!(!is_unbounded_home_scan(
            "(timeout 60 find ~/Documents)",
            None
        ));
        assert!(is_unbounded_home_scan("{ rg pattern ~/Documents; }", None));
        assert!(!is_unbounded_home_scan("(grep -rl needle .)", None));
        assert!(!is_unbounded_home_scan(r"{ find . -name '*.log'; }", None));
        // A grouping closer glued to an exact $HOME root does not hide it
        // (bot round on the fix head), and many grouped prefixes stay
        // linear in the preflight (Macroscope round on the fix head).
        assert!(is_unbounded_home_scan("(rg pattern $HOME)", None));
        // "${HOME}"'s closing brace is part of the expansion: the paren
        // strip must not eat it (Macroscope round on the fix head).
        assert!(is_unbounded_home_scan("grep -rl needle \"${HOME}\"", None));
        assert!(is_unbounded_home_scan("grep -rl needle \"${HOME}/\"", None));
        assert!(is_unbounded_home_scan("(rg pattern \"${HOME}\")", None));
        assert!(is_unbounded_home_scan("((rg pattern $HOME))", None));
        assert!(is_unbounded_home_scan("(grep -rl needle $HOME)", None));
        assert!(is_unbounded_home_scan("(find $HOME)", None));
        assert!(!is_unbounded_home_scan(&"(".repeat(100_000), None));
        assert!(!is_unbounded_home_scan(
            &format!("{}true", "( ".repeat(100_000)),
            None
        ));
        assert!(is_unbounded_home_scan(
            &format!("({}find ~/Documents", "(".repeat(100_000)),
            None
        ));
    }

    #[test]
    fn the_incident_scan_shape_warns() {
        assert!(is_unbounded_home_scan(INCIDENT, None));
        // `| head` is an output cap, not a scan bound: it still warns.
        assert!(is_unbounded_home_scan(
            "grep -rl needle ~/Documents | head -10",
            None
        ));
    }

    #[test]
    fn time_or_depth_bounds_suppress_the_warning() {
        assert!(!is_unbounded_home_scan(
            "timeout 60 grep -rli -e 'training metrics' ~/Documents",
            None
        ));
        assert!(!is_unbounded_home_scan(
            "grep -rli -e 'training metrics' ~/Documents",
            Some(60.0)
        ));
        assert!(!is_unbounded_home_scan(
            "rg --max-depth 3 pattern ~/Downloads",
            None
        ));
        assert!(!is_unbounded_home_scan("rg -d 2 pattern ~/Downloads", None));
        assert!(!is_unbounded_home_scan(
            "find ~/Documents -maxdepth 2 -name '*.pdf'",
            None
        ));
    }

    #[test]
    fn scan_warning_bounds_portably_not_via_the_shell_timeout() {
        // Stock macOS has no GNU `timeout`, and the incident-style
        // `timeout 60 grep ... 2>/dev/null` masks its command-not-found
        // failure, so the warning must point at the tool's own bounds.
        let warning = format_scan_cost_warning(None);
        assert!(warning.contains("this tool's `timeout` parameter"));
        assert!(warning.contains("`--max-depth`"));
        assert!(warning.contains("`-maxdepth`"));
        assert!(!warning.contains("timeout 60"));
    }

    #[test]
    fn project_local_and_quoted_scans_do_not_warn() {
        assert!(!is_unbounded_home_scan(
            "grep -rli pattern . | head -10",
            None
        ));
        assert!(!is_unbounded_home_scan(
            "grep -rl pattern src/ crates/",
            None
        ));
        assert!(!is_unbounded_home_scan("rg pattern .", None));
        assert!(!is_unbounded_home_scan("find . -name '*.log'", None));
        // Quoted data and comments never masquerade as scans.
        assert!(!is_unbounded_home_scan(
            "echo 'grep -r pattern ~/Documents'",
            None
        ));
        assert!(!is_unbounded_home_scan(
            "grep -rl pattern src # scan ~/Documents",
            None
        ));
    }

    #[test]
    fn unflagged_grep_stays_quiet_but_default_recursive_scanners_warn() {
        assert!(!is_unbounded_home_scan("grep -l pattern ~/Documents", None));
        assert!(is_unbounded_home_scan(
            "find ~/Downloads -name '*.pdf'",
            None
        ));
        assert!(is_unbounded_home_scan("rg pattern ~/Documents", None));
    }

    /// Regression coverage for the bot-review shapes (PR review round 1):
    /// double-quoted $HOME is a home root, filename look-alikes are not depth
    /// bounds, other env vars are not home roots, a non-positive tool timeout
    /// is no deadline, and unrepresentable scan timeouts are rejected.
    #[test]
    fn bot_review_scan_shapes() {
        // Double quotes still expand $HOME: the quoted incident form warns.
        assert!(is_unbounded_home_scan(
            "grep -rl needle \"$HOME/Documents\"",
            None
        ));
        assert!(is_unbounded_home_scan("find \"$HOME\" -name '*.pdf'", None));
        // A filename containing maxdepth is not a depth bound.
        assert!(is_unbounded_home_scan(
            "find ~/Documents -name maxdepth.txt",
            None
        ));
        // Exact home roots only: other env vars are not home-scale.
        assert!(is_unbounded_home_scan(
            "grep -rl needle $HOME/Documents",
            None
        ));
        assert!(is_unbounded_home_scan(
            "grep -rl needle ${HOME}/Downloads",
            None
        ));
        assert!(!is_unbounded_home_scan("grep -rl needle $HOMEDIR", None));
        assert!(!is_unbounded_home_scan(
            "grep -rl needle ${HOMEBREW_PREFIX}/docs",
            None
        ));
        // A non-positive tool timeout is no deadline for the executor.
        assert!(is_unbounded_home_scan(
            "grep -rl needle ~/Documents",
            Some(0.0)
        ));
        assert!(is_unbounded_home_scan(
            "grep -rl needle ~/Documents",
            Some(-5.0)
        ));
        // A quoted segment with a pipe inside is not a scan pipeline.
        assert!(!is_unbounded_home_scan(
            "echo 'example | grep -r needle ~/Documents'",
            None
        ));
        // =-joined and numeric-argument depth bounds stay quiet.
        assert!(!is_unbounded_home_scan(
            "rg --max-depth=3 needle ~/Downloads",
            None
        ));
        assert!(!is_unbounded_home_scan("rg -d2 needle ~/Downloads", None));
    }

    /// Regression coverage for the second bot-review round: double-quoted
    /// literal data (pipes, tilde look-alikes, scan text) is data, only the
    /// expansions bash actually performs inside double quotes stay live, and
    /// separator splitting stays linear on heredoc-sized commands.
    #[test]
    fn quoted_literal_data_stays_data_but_expansions_warn() {
        // A quoted pipe does not split the scanner away from its home root.
        assert!(is_unbounded_home_scan(
            "grep -rl needle \"foo|bar\" ~/Documents",
            None
        ));
        // Quoted scan text is data, not a command.
        assert!(!is_unbounded_home_scan(
            "echo \"grep -rl needle ~/Documents\"",
            None
        ));
        // Tilde inside double quotes is literal: not a home-scale root.
        assert!(!is_unbounded_home_scan(
            "grep -rl needle \"~/Documents\"",
            None
        ));
        // `$HOME` inside double quotes still expands: the scan warns.
        assert!(is_unbounded_home_scan("grep -rl needle \"$HOME\"", None));
        assert!(is_unbounded_home_scan("find \"$HOME\" -name '*.pdf'", None));
        // `$HOMEDIR` is a different variable, not a home root.
        assert!(!is_unbounded_home_scan(
            "grep -rl needle \"$HOMEDIR\"",
            None
        ));
        // A `#` inside double quotes is quoted data, not a comment.
        assert!(is_unbounded_home_scan(
            "grep -rl needle \"#\" ~/Documents",
            None
        ));
    }

    /// A heredoc-sized command splits linearly: the guard runs before every
    /// bash command, so a quadratic splitter stalled the agent on large
    /// inputs. The bound is generous (the quadratic splitter needed minutes).
    #[test]
    fn separator_splitting_is_linear_on_heredoc_sized_commands() {
        let heredoc = "x".repeat(100_000);
        let command = format!("cat <<EOF\n{heredoc}\nEOF\ngrep -rl needle ~/Documents");
        let start = std::time::Instant::now();
        let parts = split_with_separators(&command);
        let elapsed = start.elapsed();
        assert_eq!(
            parts,
            vec![
                "cat <<EOF".to_string(),
                "\n".to_string(),
                heredoc,
                "\n".to_string(),
                "EOF".to_string(),
                "\n".to_string(),
                "grep -rl needle ~/Documents".to_string(),
            ]
        );
        assert!(
            elapsed.as_secs() < 10,
            "split took {elapsed:?} on a 100k-char command"
        );
        // An unmatched substitution must not rescan its suffix either.
        let malformed = "$(".repeat(50_000);
        let start = std::time::Instant::now();
        assert!(extract_substitutions(&malformed).1.is_empty());
        let elapsed = start.elapsed();
        assert!(
            elapsed.as_secs() < 10,
            "substitution scan took {elapsed:?} on a 100k-char command"
        );
    }

    /// Regression coverage for the third bot-review round: heredoc bodies are
    /// input text (never executed by the shell), command-substitution bodies
    /// run in a subshell, and quoted numeric arguments are bounds, not data.
    #[test]
    fn heredoc_bodies_and_substitutions_scan_correctly() {
        // A heredoc body is input data, not a command: no warning, so the
        // opted-in scan timeout cannot kill an unrelated `cat` either.
        assert!(!is_unbounded_home_scan(
            "cat >example.sh <<'EOF'\ngrep -rl needle ~/Documents\nEOF",
            None
        ));
        assert!(!is_unbounded_home_scan(
            "cat <<EOF\ngrep -rl needle ~/Documents\nEOF\necho done",
            None
        ));
        // A scan inside a command substitution runs in a subshell: it warns.
        assert!(is_unbounded_home_scan(
            "echo \"$(grep -rl needle ~/Documents)\"",
            None
        ));
        assert!(is_unbounded_home_scan(
            "files=$(grep -rl needle ~/Documents); echo $files",
            None
        ));
        assert!(is_unbounded_home_scan(
            "echo \"before $(grep -rl needle ~/Documents) after\"",
            None
        ));
        // Quoted numeric depth arguments are bounds, not data.
        assert!(!is_unbounded_home_scan(
            "rg --max-depth \"3\" needle ~/Documents",
            None
        ));
        assert!(!is_unbounded_home_scan(
            "find ~/Documents -maxdepth '2'",
            None
        ));
        // Arithmetic shifts are not heredocs.
        assert!(!is_unbounded_home_scan("echo $((1<<2))", None));
    }

    /// Regression coverage for the fourth bot-review round: quoted patterns
    /// are pattern text, heredoc delimiters come in many spellings, unquoted
    /// heredoc bodies still run substitutions, quoted patterns inside
    /// substitutions survive re-masking, and quoted look-alikes do not start
    /// heredocs.
    #[test]
    fn quoted_patterns_and_heredoc_spellings_scan_correctly() {
        // A quoted pattern containing $HOME is pattern text, not a root.
        assert!(!is_unbounded_home_scan(
            "grep -rl \"$HOME/needle\" src/",
            None
        ));
        assert!(!is_unbounded_home_scan("grep -rl \"docs$HOME\" src/", None));
        // The quoted incident form still warns (pattern skipped, root kept).
        assert!(is_unbounded_home_scan("grep -rl needle \"$HOME\"", None));
        assert!(is_unbounded_home_scan(
            "grep -rl needle \"$HOME/Documents\"",
            None
        ));
        // Heredoc delimiters in all their spellings mask the body.
        for start in [
            "cat << EOF",
            "cat<<EOF",
            "cat 2<<EOF",
            "cat << 'EOF'",
            "cat <<\"EOF\"",
        ] {
            let command = format!("{start}\ngrep -rl needle ~/Documents\nEOF");
            assert!(
                !is_unbounded_home_scan(&command, None),
                "heredoc body leaked for {start:?}"
            );
        }
        // An unquoted heredoc body still runs command substitution.
        assert!(is_unbounded_home_scan(
            "cat <<EOF\n$(grep -rl needle ~/Documents)\nEOF",
            None
        ));
        // A quoted heredoc body never runs anything.
        assert!(!is_unbounded_home_scan(
            "cat <<'EOF'\n$(grep -rl needle ~/Documents)\nEOF",
            None
        ));
        // A quoted pattern inside a substitution survives re-masking.
        assert!(is_unbounded_home_scan(
            "files=$(grep -rl 'needle' ~/Documents)",
            None
        ));
        // Nested substitutions inside double quotes are extracted.
        assert!(is_unbounded_home_scan(
            "echo \"$(echo $(grep -rl needle ~/Documents))\"",
            None
        ));
        // An escaped $HOME inside double quotes is literal, not a root.
        assert!(!is_unbounded_home_scan("grep -rl \"\\$HOME\" src/", None));
        // Quoted look-alikes and comments do not start heredocs.
        assert!(is_unbounded_home_scan(
            "echo \"use <<EOF in scripts\"; grep -rl needle ~/Documents",
            None
        ));
        assert!(is_unbounded_home_scan(
            "echo 'cat <<EOF'; grep -rl needle ~/Documents",
            None
        ));
        assert!(is_unbounded_home_scan(
            "# cat <<EOF\ngrep -rl needle ~/Documents",
            None
        ));
    }

    /// Regression coverage for the fifth bot-review round: quote removal
    /// across a heredoc delimiter word, and arithmetic shifts with named
    /// operands.
    #[test]
    fn partially_quoted_delimiters_and_named_shifts_scan_correctly() {
        // `E'OF'` is the delimiter `EOF` with expansion disabled: the body
        // masks through the real terminator line, and later commands stay
        // live (previously the unmatched `E'OF` masked everything after it).
        let command = "cat <<E'OF'\nbody\nEOF\nfind \"$HOME\" -name '*.pdf'";
        assert!(!is_unbounded_home_scan(
            "cat <<E'OF'\ngrep -rl needle ~/Documents\nEOF",
            None
        ));
        assert!(is_unbounded_home_scan(command, None));
        // A named-operand arithmetic shift is not a heredoc.
        assert!(!is_unbounded_home_scan("echo $((a<<b))", None));
        assert!(is_unbounded_home_scan(
            "echo $((a<<b))\ngrep -rl needle ~/Documents",
            None
        ));
        // Quote anywhere in the delimiter disables body expansion.
        assert!(!is_unbounded_home_scan(
            "cat <<E'OF'\n$(grep -rl needle ~/Documents)\nEOF",
            None
        ));
    }

    /// Regression coverage for the sixth bot-review round: escaped
    /// substitutions are literal in heredoc bodies, substitutions may span
    /// body lines, two substitutions on one line both count, and `<<EOF;`
    /// does not swallow the same-line command.
    #[test]
    fn escaped_and_multiline_heredoc_substitutions_scan_correctly() {
        // An escaped \$(...) in an unquoted heredoc is literal, not a scan.
        assert!(!is_unbounded_home_scan(
            "cat <<EOF\n\\$(grep -rl needle ~/Documents)\nEOF\nsleep 120",
            None
        ));
        // A substitution spanning body lines still executes.
        assert!(is_unbounded_home_scan(
            "cat <<EOF\n$(\nfind ~/Documents\n)\nEOF",
            None
        ));
        // A second substitution on the same body line is detected too.
        assert!(is_unbounded_home_scan(
            "cat <<EOF\n$(echo hi) $(grep -rl needle ~/Documents)\nEOF",
            None
        ));
        // `<<EOF;` stops at the semicolon: the same-line command stays
        // live, and a command after the heredoc block is still detected.
        assert!(is_unbounded_home_scan(
            "cat <<EOF; find \"$HOME\" -name '*.pdf'\nbody\nEOF",
            None
        ));
        assert!(is_unbounded_home_scan(
            "cat <<EOF; echo\nbody\nEOF\nfind \"$HOME\" -name '*.pdf'",
            None
        ));
    }

    /// Regression coverage for the seventh bot-review round: digit-led
    /// heredoc delimiters, here-strings, unclosed heredocs, and quoted
    /// patterns ahead of two scan roots.
    #[test]
    fn digit_delimiters_here_strings_and_unclosed_heredocs_scan_correctly() {
        // `<<123` is a real heredoc: the body is data.
        assert!(!is_unbounded_home_scan(
            "cat <<123\ngrep -rl needle ~/Documents\n123",
            None
        ));
        // A here-string supplies one word: following lines stay live.
        assert!(is_unbounded_home_scan(
            "cat <<<hello\nfind ~/Documents -name '*.pdf'",
            None
        ));
        // An unclosed heredoc reads to EOF: the last line's substitution
        // still runs.
        assert!(is_unbounded_home_scan(
            "cat <<EOF\n$(grep -rl needle ~/Documents)",
            None
        ));
        // A quoted pattern ahead of two roots keeps every root: the masked
        // pattern leaves a placeholder for the positional pattern-skip.
        assert!(is_unbounded_home_scan(
            "grep -rl 'needle' ~/Documents src/",
            None
        ));
        assert!(is_unbounded_home_scan(
            "grep -rl \"needle\" ~/Documents src/",
            None
        ));
        // `<<\EOF` is the quoted delimiter `EOF`: expansion is disabled and
        // the real terminator line matches.
        assert!(!is_unbounded_home_scan(
            "cat <<\\EOF\ngrep -rl needle ~/Documents\nEOF",
            None
        ));
        assert!(!is_unbounded_home_scan(
            "cat <<\\EOF\n$(grep -rl needle ~/Documents)\nEOF",
            None
        ));
    }

    /// Regression coverage for the ninth bot-review round: per-tool depth
    /// bounds, pattern options, quote-aware substitution matching, and an
    /// iterative depth-capped substitution walk.
    #[test]
    fn tool_bounds_pattern_options_and_capped_nesting_scan_correctly() {
        // The grep family has no depth option: `-d2` after `-e` is a pattern.
        assert!(is_unbounded_home_scan("grep -rl -e -d2 ~/Documents", None));
        // A pattern supplied by --regexp= leaves every positional a root.
        assert!(is_unbounded_home_scan(
            "grep -rl --regexp=needle ~/Documents src/",
            None
        ));
        // A lone pattern is not a scan (grep reads stdin, nothing recurses).
        assert!(!is_unbounded_home_scan("grep -rl \"$HOME\"", None));
        // Quoted parens inside a substitution do not confuse the matcher:
        // a later sibling substitution is still extracted.
        assert!(is_unbounded_home_scan(
            "echo \"$(echo '(')\" $(grep -rl needle ~/Documents)",
            None
        ));
        // Deeply nested malformed input stays cheap and off the stack.
        let deep = format!("{}{}", "$(".repeat(50_000), ")".repeat(50_000));
        let start = std::time::Instant::now();
        assert!(!is_unbounded_home_scan(&deep, None));
        let elapsed = start.elapsed();
        assert!(
            elapsed.as_secs() < 10,
            "nested scan took {elapsed:?} on a 100k-char command"
        );
    }

    /// Regression coverage for the tenth bot-review round: heredoc-count
    /// work bound, escaped backticks, operator-adjacent comments, rg
    /// --files, and pattern-option operands.
    #[test]
    fn heredoc_bounds_escapes_comments_and_files_mode_scan_correctly() {
        // A line full of `<<` operators stays cheap: each body scan is
        // forward-only and capped.
        let many = format!("cat {}", "<<A ".repeat(20_000));
        let start = std::time::Instant::now();
        assert!(!is_unbounded_home_scan(&many, None));
        let elapsed = start.elapsed();
        assert!(
            elapsed.as_secs() < 10,
            "heredoc preflight took {elapsed:?} on a many-heredoc command"
        );
        // Escaped backticks are literal data, not substitutions.
        assert!(!is_unbounded_home_scan(
            "printf '%s\\n' \\`grep -rl needle ~/Documents\\`; sleep 120",
            None
        ));
        // `#` right after a shell operator starts a comment.
        assert!(!is_unbounded_home_scan(
            "echo ok;# example | grep -rl needle ~/Documents",
            None
        ));
        // rg --files lists files with no pattern: every positional is a path.
        assert!(is_unbounded_home_scan("rg --files ~/Documents", None));
        // A pattern-option operand is not a scan root.
        assert!(!is_unbounded_home_scan(
            "grep -rl -e \"$HOME/needle\" src/",
            None
        ));
    }

    /// Regression coverage for the eleventh bot-review round: separators
    /// inside a home-prefixed quoted span are data, and `--` ends option
    /// parsing.
    #[test]
    fn quoted_separators_and_ddash_scan_correctly() {
        // A quoted semicolon inside a home-prefixed span never splits the
        // command into segments.
        assert!(!is_unbounded_home_scan(
            "printf '%s\\n' \"$HOME/example;grep -rl needle ~/Documents\"; sleep 120",
            None
        ));
        // `--` ends option parsing: `-needle` is the pattern, the home
        // directory is the root.
        assert!(is_unbounded_home_scan(
            "grep -rl -- -needle ~/Documents",
            None
        ));
        assert!(!is_unbounded_home_scan("grep -rl -- \"$HOME\" src/", None));
        // BSD find -f supplies the hierarchy, not a pattern file (round 12).
        assert!(is_unbounded_home_scan("find -f ~/Documents", None));
        // An empty quoted delimiter is a real heredoc: the body ends at the
        // empty line.
        assert!(!is_unbounded_home_scan(
            "cat <<''\ngrep -rl needle ~/Documents\n\n",
            None
        ));
        // Separators inside substitutions embedded in a home span stay
        // intact: the nested scan still warns.
        assert!(is_unbounded_home_scan(
            "\"$HOME/x; $(echo a; grep -rl needle ~/Documents)\"",
            None
        ));
    }

    /// Regression coverage for the thirteenth bot-review round: a quoted
    /// separator inside a substitution argument never splits the parent.
    #[test]
    fn substitution_bodies_are_masked_in_the_parent() {
        assert!(!is_unbounded_home_scan(
            "echo \"$(printf '%s' 'x; find ~/Documents')\"; sleep 120",
            None
        ));
        // The body itself is still scanned with its own masking.
        assert!(is_unbounded_home_scan(
            "echo \"$(grep -rl 'needle' ~/Documents)\"",
            None
        ));
    }

    /// Regression coverage for the fourteenth bot-review round: a quoted
    /// multi-home pattern stays one token; a quoted root with spaces still
    /// warns.
    #[test]
    fn home_spans_stay_single_tokens() {
        assert!(!is_unbounded_home_scan(
            "grep -rl \"$HOME/a|$HOME/b\" src/",
            None
        ));
        assert!(is_unbounded_home_scan(
            "grep -rl needle \"$HOME/docs with spaces\"",
            None
        ));
    }

    /// Regression pins for the review round on unrestricted `~`/`$HOME`
    /// prefixes: a home-scale root is the home tree itself or one component
    /// below it (the incident dirs), and deeper `~`-rooted project paths
    /// must not warn or get the env auto-timeout.
    #[test]
    fn home_scale_root_is_home_or_one_component_below() {
        // The reviewer's ordinary project scans stay quiet, with or without
        // expansions.
        assert!(!is_unbounded_home_scan(
            "grep -rn foo ~/work/repo/src",
            None
        ));
        assert!(!is_unbounded_home_scan("rg pat ~/.config/app/x.toml", None));
        assert!(!is_unbounded_home_scan(
            "grep -rn foo $HOME/work/repo/src",
            None
        ));
        assert!(!is_unbounded_home_scan(
            "grep -rn foo ${HOME}/work/repo/src",
            None
        ));
        assert!(!is_unbounded_home_scan(
            "find ~/proj/src -name '*.py'",
            None
        ));
        // The home tree itself and one component below it still warn: the
        // incident command's roots are all `~/<one component>`.
        assert!(is_unbounded_home_scan("grep -rl needle ~", None));
        assert!(is_unbounded_home_scan("grep -rl needle ~/", None));
        assert!(is_unbounded_home_scan("grep -rl needle $HOME", None));
        assert!(is_unbounded_home_scan("grep -rl needle $HOME/", None));
        assert!(is_unbounded_home_scan(
            "grep -rl needle ${HOME}/Documents",
            None
        ));
        assert!(is_unbounded_home_scan("grep -rn foo ~/Documents/", None));
        assert!(is_unbounded_home_scan("find ~/proj -name '*.py'", None));
    }

    #[test]
    fn scan_timeout_env_parses_only_positive_seconds() {
        let env = |v: &str| {
            let mut env = std::collections::HashMap::new();
            env.insert(SCAN_TIMEOUT_ENV.to_string(), v.to_string());
            scan_timeout_from_env(&env)
        };
        assert_eq!(env("30"), Some(30.0));
        assert_eq!(env("0.5"), Some(0.5));
        assert_eq!(env("0"), None);
        assert_eq!(env("-5"), None);
        assert_eq!(env("abc"), None);
        // A duration `Duration::from_secs_f64` cannot represent must not
        // reach the executor (it would panic instead of timing out).
        assert_eq!(env("1e30"), None);
        // A duration whose deadline `Instant::now() + duration` cannot
        // represent must not reach the executor either (checked_add fails on
        // every platform for this value; smaller values are platform-bound).
        assert_eq!(env("1e19"), None);
        assert_eq!(
            scan_timeout_from_env(&std::collections::HashMap::new()),
            None
        );
    }

    /// Runs the real tool: the incident shape carries the warning on the
    /// model-facing text, project-local scans do not, and the opted-in
    /// `PRIME_AGENT_SCAN_TIMEOUT` bounds the command. Mutates process env
    /// under the module's env lock, so the transient deadline never
    /// reaches a parallel `execute_bash` test in this binary.
    #[tokio::test]
    // The env lock is held across awaits by design (env must stay stable).
    #[allow(clippy::await_holding_lock)]
    async fn execute_bash_warns_on_unbounded_scans_and_env_timeouts_them() {
        use crate::tools::bash::{execute_bash, BashToolOptions};
        let _env = env_lock();
        let cwd = tempfile::tempdir().expect("tempdir");
        let cwd_path = cwd.path().to_string_lossy().into_owned();

        // The warning rides the failing result; the search itself still ran.
        let result = execute_bash(
            &cwd_path,
            &BashToolOptions::default(),
            "grep -rl needle ~/pa-scan-guard-nonexistent-xyz 2>/dev/null",
            None,
            None,
            None,
            None,
        )
        .await;
        let err = result.expect_err("the missing scan root must fail");
        assert!(
            err.to_string()
                .contains("Warning: this recursive scan of home-scale directories"),
            "no scan warning on: {err}"
        );

        // A project-local scan carries no warning.
        std::fs::write(cwd.path().join("a.txt"), "needle").expect("write fixture");
        let result = execute_bash(
            &cwd_path,
            &BashToolOptions::default(),
            "grep -rl needle .",
            None,
            None,
            None,
            None,
        )
        .await
        .expect("project-local grep");
        let text = result.content[0].as_text().expect("text block");
        assert!(text.contains("a.txt"), "grep -l output lost: {text}");
        assert!(
            !text.contains("Warning: this recursive scan"),
            "unexpected warning on project-local scan: {text}"
        );

        // The opt-in env applies its timeout to the matching command and the
        // warning names it.
        let _scan_timeout = ScanTimeoutEnv::set("0.5");
        let result = execute_bash(
            &cwd_path,
            &BashToolOptions::default(),
            "grep -rl needle ~/pa-scan-guard-nonexistent-xyz 2>/dev/null || sleep 2",
            None,
            None,
            None,
            None,
        )
        .await;
        let err = result.expect_err("the scan timeout must fire");
        assert!(
            err.to_string().contains("scan timeout of 0.5s"),
            "warning must name the applied scan timeout: {err}"
        );
        assert!(
            err.to_string()
                .contains("Command timed out after 0.5 seconds"),
            "the env timeout must bound the command: {err}"
        );
    }

    /// `PRRT_kwDOSXZbXs6u6Jas`: the env test sets its transient deadline on
    /// the process env across an await; a failed assertion unwinds through
    /// the guard, so the prior value (or its absence) is restored even
    /// though the panic escaped with the deadline live — the unwind cannot
    /// leave the binary's other `execute_bash` tests racing a deadline no
    /// test asked for.
    #[test]
    fn a_failed_assertion_restores_the_scan_timeout_env() {
        let _env = env_lock();
        let before = std::env::var_os(SCAN_TIMEOUT_ENV);
        let unwind = std::panic::catch_unwind(|| {
            // Creation order mirrors the env test: the guard, then the
            // transient deadline, so the unwind restores what the panic
            // left live.
            let _scan_timeout = ScanTimeoutEnv::set("0.5");
            assert_eq!(
                std::env::var(SCAN_TIMEOUT_ENV).as_deref(),
                Ok("0.5"),
                "the guard must hold the transient deadline"
            );
            panic!("simulate a failed assertion while the deadline is live");
        });
        assert!(unwind.is_err(), "the simulated assertion must unwind");
        assert_eq!(
            std::env::var_os(SCAN_TIMEOUT_ENV),
            before,
            "the guard must restore the prior value after the unwind"
        );
    }

    /// `PRRT_kwDOSXZbXs6u6JaU`: the scan-cost warning rides the dispatch
    /// `ToolUpdate` (kernel parity: `_note_scan_cost` before the shell runs),
    /// not only the result text after the command finishes — an unbounded
    /// scan holds the turn, so the warning must be visible while it runs.
    #[tokio::test]
    // The env lock is held across awaits by design (env must stay stable).
    #[allow(clippy::await_holding_lock)]
    async fn execute_bash_delivers_scan_warning_at_dispatch() {
        use crate::tools::bash::{execute_bash, BashToolOptions};
        use crate::tools::tool_definition::{OnUpdate, ToolUpdate};
        use std::sync::{Arc, Mutex};

        // execute_bash reads the process env; the shared lock keeps the
        // env-mutating scan test's transient deadline out of this command.
        let _env = env_lock();

        let cwd = tempfile::tempdir().expect("tempdir");
        let cwd_path = cwd.path().to_string_lossy().into_owned();

        let texts: Arc<Mutex<Vec<String>>> = Arc::new(Mutex::new(Vec::new()));
        let sink = texts.clone();
        let on_update: OnUpdate = Arc::new(move |update: ToolUpdate| {
            for block in &update.content {
                if let Some(text) = block.as_text() {
                    sink.lock().unwrap().push(text.to_string());
                }
            }
        });

        // The detected scan shape with a quiet tail: grep fails instantly on
        // the missing root, then the sleep holds the call open so the
        // dispatch warning is observed mid-run, not after completion.
        let signal = crate::tools::tool_definition::AbortSignal::new();
        let exec = {
            let signal = signal.clone();
            let on_update = on_update.clone();
            let cwd_path = cwd_path.clone();
            let command = "grep -rl needle ~/pa-scan-guard-nonexistent-xyz 2>/dev/null || sleep 10"
                .to_string();
            tokio::spawn(async move {
                execute_bash(
                    &cwd_path,
                    &BashToolOptions::default(),
                    &command,
                    None,
                    None,
                    Some(signal),
                    Some(on_update),
                )
                .await
            })
        };

        let mut dispatched = None;
        for _ in 0..400 {
            if let Some(first) = texts.lock().unwrap().first() {
                dispatched = Some(first.clone());
                break;
            }
            tokio::time::sleep(std::time::Duration::from_millis(10)).await;
        }
        let dispatched = dispatched.expect("no streamed scan warning mid-run");
        assert!(
            dispatched.contains("Warning: this recursive scan of home-scale directories"),
            "the dispatch update must carry the scan warning: {dispatched}"
        );
        assert!(
            !exec.is_finished(),
            "the scan warning arrived only after the command finished"
        );

        signal.cancel();
        let err = exec
            .await
            .expect("join the aborted scan")
            .expect_err("the aborted scan must fail");
        assert!(
            err.to_string().contains("Command aborted"),
            "unexpected abort error: {err}"
        );
    }
}

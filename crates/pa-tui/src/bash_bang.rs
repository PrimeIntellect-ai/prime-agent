//! The `!`/`!!` bash-from-chat shortcut (TS interactive-mode `onSubmit`):
//! `!command` runs bash directly — no model turn — and the output enters
//! the session context (the daemon records the durable `bashExecution`
//! row, so follow-up prompts see it); `!!command` runs the same way but
//! stays excluded from the context; a bare `!`/`!!` is bash mode with
//! nothing to run and is never sent as a prompt.

use std::fmt::Write;
/// The tail-truncation budget shared with the bash tool (TS
/// `truncateTail` defaults): the last 2000 lines within 50KB win, so a
/// pane-mounted run cannot seed a follow-up with unbounded output.
const TAIL_MAX_LINES: usize = 2000;
const TAIL_MAX_BYTES: usize = 50 * 1024;

/// One `!`/`!!` submission: the command and whether the run is excluded
/// from the session context.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct BashShortcut {
    pub command: String,
    pub excluded: bool,
}

/// A submission routed through the bash shortcut.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum BashBang {
    /// A bare `!`/`!!` with nothing after it: bash mode with nothing to
    /// run (TS returns without sending a prompt).
    Bare,
    /// A command to run through the user-bash slot.
    Run(BashShortcut),
}

/// TS `getBashPromptInfo` (custom-editor.ts): the prompt prefix the
/// editor renders in place of a leading `!`/`!!`, and how many
/// characters of the typed line stay hidden behind it (the leading
/// whitespace plus the prefix, one wider when the user typed its
/// trailing space).
pub fn bash_prompt_info(line: &str) -> Option<(&'static str, usize)> {
    let trimmed = line.trim_start();
    let leading = line.chars().count() - trimmed.chars().count();
    if trimmed.starts_with("!!") {
        let hidden = leading + if trimmed.starts_with("!! ") { 3 } else { 2 };
        Some(("!! ", hidden))
    } else if trimmed.starts_with('!') {
        let hidden = leading + if trimmed.starts_with("! ") { 2 } else { 1 };
        Some(("! ", hidden))
    } else {
        None
    }
}

/// Parse a submitted text through the bash shortcut (TS `text.startsWith("!")`
/// ladder). `None` for submissions that do not start with `!`.
pub fn parse_bash_bang(text: &str) -> Option<BashBang> {
    let rest = match text.strip_prefix("!!") {
        Some(rest) => rest,
        None if text.starts_with('!') => &text[1..],
        None => return None,
    };
    let command = rest.trim();
    if command.is_empty() {
        return Some(BashBang::Bare);
    }
    let excluded = text.starts_with("!!");
    Some(BashBang::Run(BashShortcut {
        command: command.to_string(),
        excluded,
    }))
}

/// Format bash output for the follow-up seed text (TS `bashOutputToText`):
/// the fenced output (the fence outgrows any backtick run in it so
/// command output cannot terminate it early), then the cancellation or
/// exit-code suffix and the truncation notice.
pub fn bash_output_to_text(
    output: &str,
    exit_code: Option<i64>,
    truncated: bool,
    full_output_path: Option<&str>,
) -> String {
    let mut text = if output.is_empty() {
        "(no output)".to_string()
    } else {
        let longest = output
            .match_indices('`')
            .map(|(start, _)| {
                output[start..]
                    .chars()
                    .take_while(|character| *character == '`')
                    .count()
            })
            .max()
            .unwrap_or(0);
        let fence = "`".repeat(longest.saturating_add(1).max(3));
        format!("{fence}\n{output}\n{fence}")
    };
    match exit_code {
        Some(code) if code != 0 => {
            let _ = write!(text, "\n\nCommand exited with code {code}");
        }
        _ => {}
    }
    if truncated {
        match full_output_path {
            Some(path) => {
                let _ = write!(text, "\n\n[Output truncated. Full output: {path}]");
            }
            None => text.push_str("\n\n[Output truncated.]"),
        }
    }
    text
}

/// The tail truncation the side pane applies to a run's raw output before
/// seeding a follow-up (TS `truncateTail`): the last `TAIL_MAX_LINES`
/// lines within `TAIL_MAX_BYTES` win.
pub fn truncate_tail(content: &str) -> (String, bool) {
    let total_bytes = content.len();
    let lines: Vec<&str> = content.split('\n').collect();
    if lines.len() <= TAIL_MAX_LINES && total_bytes <= TAIL_MAX_BYTES {
        return (content.to_string(), false);
    }
    let mut collected: Vec<&str> = Vec::new();
    let mut used_bytes = 0usize;
    for line in lines.iter().rev() {
        if collected.len() >= TAIL_MAX_LINES {
            break;
        }
        let line_bytes = line.len() + usize::from(!collected.is_empty());
        if used_bytes + line_bytes > TAIL_MAX_BYTES {
            break;
        }
        collected.push(line);
        used_bytes += line_bytes;
    }
    collected.reverse();
    (collected.join("\n"), true)
}

#[cfg(test)]
mod tests {
    use super::*;

    /// `!command` runs and joins the context; `!!command` runs excluded;
    /// a bare `!`/`!!` (whitespace only counts as bare) is inert; other
    /// submissions do not route through the shortcut at all.
    #[test]
    fn parses_the_variants() {
        assert_eq!(
            parse_bash_bang("!echo hi"),
            Some(BashBang::Run(BashShortcut {
                command: "echo hi".to_string(),
                excluded: false
            }))
        );
        assert_eq!(
            parse_bash_bang("!!echo hi"),
            Some(BashBang::Run(BashShortcut {
                command: "echo hi".to_string(),
                excluded: true
            }))
        );
        assert_eq!(parse_bash_bang("!"), Some(BashBang::Bare));
        assert_eq!(parse_bash_bang("!!"), Some(BashBang::Bare));
        assert_eq!(parse_bash_bang("!   "), Some(BashBang::Bare));
        assert_eq!(parse_bash_bang("echo hi"), None);
        assert_eq!(parse_bash_bang("/help"), None);
    }

    /// A `!!`-prefixed command still parses its own body for a second `!`
    /// (the variant is the leading prefix, not the whole text).
    #[test]
    fn double_bang_keeps_the_command_body() {
        assert_eq!(
            parse_bash_bang("!! !nested"),
            Some(BashBang::Run(BashShortcut {
                command: "!nested".to_string(),
                excluded: true
            }))
        );
    }

    /// The seed text fences the output, names the fence longer than any
    /// backtick run inside the output, and carries the exit-code and
    /// truncation suffixes. The fence floor is 3 and it grows past a
    /// run only by one (TS `Math.max(3, longest + 1)`).
    #[test]
    fn seed_text_matches_the_ts_shape() {
        assert_eq!(
            bash_output_to_text("hi", Some(0), false, None),
            "```\nhi\n```"
        );
        assert_eq!(
            bash_output_to_text("``x", Some(2), true, Some("/tmp/spill.log")),
            "```\n``x\n```\n\nCommand exited with code 2\n\n[Output truncated. Full output: /tmp/spill.log]"
        );
        assert_eq!(
            bash_output_to_text("```x", Some(0), false, None),
            "````\n```x\n````"
        );
        assert_eq!(bash_output_to_text("", None, false, None), "(no output)");
    }

    /// `bash_prompt_info` (TS `getBashPromptInfo`): `!!` outranks `!`,
    /// leading whitespace counts toward the hidden prefix, and a typed
    /// trailing space makes the prefix one wider.
    #[test]
    fn bash_prompt_info_matches_the_ts_ladder() {
        assert_eq!(bash_prompt_info("!echo hi"), Some(("! ", 1)));
        assert_eq!(bash_prompt_info("!!echo hi"), Some(("!! ", 2)));
        assert_eq!(bash_prompt_info("! echo hi"), Some(("! ", 2)));
        assert_eq!(bash_prompt_info("!! echo hi"), Some(("!! ", 3)));
        assert_eq!(bash_prompt_info("  !echo"), Some(("! ", 3)));
        assert_eq!(bash_prompt_info("!"), Some(("! ", 1)));
        assert_eq!(bash_prompt_info("echo hi"), None);
        assert_eq!(bash_prompt_info(""), None);
    }

    /// Tail truncation keeps the last lines within the byte budget.
    #[test]
    fn tail_truncation_keeps_the_tail() {
        let long = vec!["line"; 3000].join("\n");
        let (kept, truncated) = truncate_tail(&long);
        assert!(truncated);
        assert!(kept.starts_with("line") && kept.lines().count() <= TAIL_MAX_LINES);
        let (same, truncated) = truncate_tail("short");
        assert_eq!(same, "short");
        assert!(!truncated);
    }
}

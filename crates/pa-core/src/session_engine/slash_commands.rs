//! Session-side slash-command handling: which commands execute in the session
//! engine and how their arguments parse. The command table itself is shared
//! vocabulary living in `pa_types::slash_commands` (the TUI cannot import
//! pa-core, and one table serves every surface).

pub use pa_types::slash_commands::{
    find_slash_command_suggestion, is_session_slash_command_name, parse_slash_command,
    BuiltinSlashCommand, ResolvedSlashCommand, SlashCommandExecution, SlashCommandRegistry,
    SESSION_SLASH_COMMAND_NAMES,
};

/// A parsed session slash command (compact/refine/goal/autonomous).
#[derive(Debug, Clone, PartialEq)]
pub struct SessionSlashCommand {
    pub name: &'static str,
    pub args: String,
    pub text: String,
}

/// Parse a session command from input; None for non-session commands.
pub fn parse_session_command(
    registry: &SlashCommandRegistry,
    text: &str,
) -> Option<SessionSlashCommand> {
    let resolved = registry.parse(text)?;
    if !is_session_slash_command_name(resolved.name) {
        return None;
    }
    Some(SessionSlashCommand {
        name: resolved.name,
        args: resolved.args.clone(),
        text: text.to_string(),
    })
}

/// Parsed `/refine` options.
#[derive(Debug, Default, PartialEq)]
pub struct RefineCommandOptions {
    pub instructions: Option<String>,
    pub rollback_id: Option<String>,
    pub global: bool,
}

/// Parse `/refine [--global] [instructions]` and `/refine rollback <id>`.
pub fn parse_refine_command_options(args: &str) -> Result<RefineCommandOptions, String> {
    let mut rest = args.trim();
    let mut global = false;
    if rest.starts_with("--global")
        && matches!(rest.as_bytes().get(8), None | Some(b' ') | Some(b'\t'))
    {
        global = true;
        rest = rest["--global".len()..].trim();
    }
    if rest == "rollback" {
        return Err("Usage: /refine rollback <refinement-id>".to_string());
    }
    if let Some(tail) = rest.strip_prefix("rollback") {
        if tail.starts_with('\t') || tail.starts_with(' ') {
            let mut rollback_id = rest["rollback".len()..].trim().to_string();
            if rollback_id == "--global" {
                return Err("Usage: /refine rollback <refinement-id>".to_string());
            }
            if rollback_id.ends_with(" --global") {
                global = true;
                rollback_id = rollback_id.trim_end_matches(" --global").trim().to_string();
            }
            if rollback_id.is_empty() {
                return Err("Usage: /refine rollback <refinement-id>".to_string());
            }
            return Ok(RefineCommandOptions {
                instructions: None,
                rollback_id: Some(rollback_id),
                global,
            });
        }
    }
    Ok(RefineCommandOptions {
        instructions: (!rest.is_empty()).then(|| rest.to_string()),
        rollback_id: None,
        global,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn refine_options_parsing() {
        assert_eq!(
            parse_refine_command_options("do the thing").unwrap(),
            RefineCommandOptions {
                instructions: Some("do the thing".to_string()),
                rollback_id: None,
                global: false,
            }
        );
        assert_eq!(
            parse_refine_command_options("").unwrap(),
            RefineCommandOptions::default()
        );
        assert_eq!(
            parse_refine_command_options("--global tweak").unwrap(),
            RefineCommandOptions {
                instructions: Some("tweak".to_string()),
                rollback_id: None,
                global: true,
            }
        );
        assert_eq!(
            parse_refine_command_options("rollback ref_123").unwrap(),
            RefineCommandOptions {
                instructions: None,
                rollback_id: Some("ref_123".to_string()),
                global: false,
            }
        );
        assert!(
            parse_refine_command_options("--global rollback ref_123")
                .unwrap()
                .global
        );
        assert_eq!(
            parse_refine_command_options("rollback").unwrap_err(),
            "Usage: /refine rollback <refinement-id>"
        );
        assert_eq!(
            parse_refine_command_options("rollback ").unwrap_err(),
            "Usage: /refine rollback <refinement-id>"
        );
    }

    #[test]
    fn session_command_extraction() {
        let registry = SlashCommandRegistry::builtin();
        let command = parse_session_command(&registry, "/compact focus on tests").unwrap();
        assert_eq!(command.name, "compact");
        assert_eq!(command.args, "focus on tests");
        // Non-session commands are not session commands.
        assert!(parse_session_command(&registry, "/model").is_none());
        assert!(parse_session_command(&registry, "/unknown x").is_none());
    }
}

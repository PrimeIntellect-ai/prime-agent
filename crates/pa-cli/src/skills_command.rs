//! `prime-agent skills`: list every discovered skill and why it is or is not
//! part of a session started in a directory, from the same resolution the
//! session and `prime-agent prompt` use.

use crate::config::get_agent_dir;

/// The command's parsed arguments.
#[derive(Debug, Default, PartialEq, Eq)]
struct SkillsCommandArgs {
    cwd: Option<String>,
    json: bool,
}

fn parse_args(args: &[String]) -> Result<SkillsCommandArgs, String> {
    let mut parsed = SkillsCommandArgs::default();
    let mut rest = args.iter();
    while let Some(arg) = rest.next() {
        match arg.as_str() {
            "--json" => parsed.json = true,
            "--cwd" => {
                let Some(value) = rest.next() else {
                    return Err("--cwd requires a value".to_string());
                };
                parsed.cwd = Some(value.clone());
            }
            other => return Err(format!("unknown option {other:?}")),
        }
    }
    Ok(parsed)
}

/// Run the `skills` command; returns the process exit code.
pub fn run_skills_command(args: &[String]) -> i32 {
    let parsed = match parse_args(args) {
        Ok(parsed) => parsed,
        Err(error) => {
            eprintln!("Error: {error}");
            eprintln!("Run `prime-agent help skills` for usage.");
            return 1;
        }
    };
    let cwd = parsed
        .cwd
        .map(std::path::PathBuf::from)
        .or_else(|| std::env::current_dir().ok())
        .unwrap_or_else(|| std::path::PathBuf::from("."));
    let resources = match crate::prompt_command::load_session_resources(&cwd, &get_agent_dir()) {
        Ok((_settings, resources, _generic_servers)) => resources,
        Err(error) => {
            eprintln!("Error: {error:#}");
            return 1;
        }
    };
    if parsed.json {
        println!(
            "{}",
            serde_json::json!({ "skills": resources.skill_statuses })
        );
    } else {
        for status in &resources.skill_statuses {
            println!(
                "{}  {}\n    {}",
                status.name,
                status.describe(),
                status.path
            );
        }
    }
    0
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_flags() {
        assert_eq!(
            parse_args(&["--cwd".to_string(), "/w".to_string(), "--json".to_string()]),
            Ok(SkillsCommandArgs {
                cwd: Some("/w".to_string()),
                json: true,
            })
        );
        assert_eq!(
            parse_args(&["--bogus".to_string()]),
            Err("unknown option \"--bogus\"".to_string())
        );
    }
}

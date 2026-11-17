//! Skill discovery, validation, and prompt formatting.

pub mod diagnostics;
pub mod discovery;
pub mod frontmatter;
pub mod loader;
pub mod prompt_templates;

use std::path::PathBuf;

use serde::Serialize;

/// Max name length per the Agent Skills spec.
pub const MAX_NAME_LENGTH: usize = 64;
/// Max description length per the Agent Skills spec.
pub const MAX_DESCRIPTION_LENGTH: usize = 1024;

pub use diagnostics::{ResourceCollision, ResourceDiagnostic};
pub use discovery::load_skills_from_dir;
pub use loader::{load_skills, LoadSkillsOptions, LoadSkillsResult};
pub use pa_types::slash_commands::parse_slash_command;
pub use prompt_templates::{
    expand_prompt_template, load_prompt_templates, parse_command_args, substitute_args,
    LoadPromptTemplatesOptions, PromptTemplate,
};

/// Source provenance for a resource (the TS source-info shape).
#[derive(Debug, Clone, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct SourceInfo {
    pub path: String,
    pub source: String,
    pub scope: SourceScope,
    pub origin: SourceOrigin,
    pub base_dir: Option<String>,
}

#[derive(Debug, Clone, Copy, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub enum SourceScope {
    User,
    Project,
    Temporary,
}

#[derive(Debug, Clone, Copy, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub enum SourceOrigin {
    Package,
    TopLevel,
}

/// Markdown entry test: the file name carries a lowercase `.md` extension
/// (TS `endsWith('.md')` parity: mixed-case suffixes stay undiscovered, and
/// a bare `.md` name has no extension and does not count).
#[must_use]
pub fn skill_markdown_name(name: &str) -> bool {
    std::path::Path::new(name)
        .extension()
        .is_some_and(|ext| ext == "md")
}

pub fn create_synthetic_source_info(
    path: &str,
    source: &str,
    scope: SourceScope,
    base_dir: Option<&str>,
) -> SourceInfo {
    SourceInfo {
        path: path.to_string(),
        source: source.to_string(),
        scope,
        origin: SourceOrigin::TopLevel,
        base_dir: base_dir.map(str::to_string),
    }
}

/// Python runtime metadata for a Python-backed skill.
#[derive(Debug, Clone, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct SkillPythonMetadata {
    pub import_name: String,
    pub package_path: PathBuf,
    pub pyproject_path: PathBuf,
}

/// A discovered skill.
#[derive(Debug, Clone, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct Skill {
    pub name: String,
    pub description: String,
    pub file_path: PathBuf,
    pub base_dir: PathBuf,
    pub source_info: SourceInfo,
    pub disable_model_invocation: bool,
    pub kind: SkillKind,
    pub python: Option<SkillPythonMetadata>,
}

#[derive(Debug, Clone, Copy, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub enum SkillKind {
    Markdown,
    Python,
}

impl Skill {
    #[must_use]
    pub fn is_python(&self) -> bool {
        self.kind == SkillKind::Python
    }

    /// The kind label the prompt inventory and telemetry share
    /// (`<type>` in `format_skills_for_prompt`, `skill_kind` in events).
    #[must_use]
    pub fn kind_label(&self) -> &'static str {
        if self.is_python() {
            "python"
        } else {
            "markdown"
        }
    }
}

/// Runtime info for kernel-side Python skill preparation.
#[derive(Debug, Clone, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct PythonSkillRuntimeInfo {
    pub name: String,
    pub import_name: String,
    pub package_path: PathBuf,
    pub pyproject_path: PathBuf,
}

/// The runtime info for every Python skill in the list.
///
/// # Panics
///
/// The `expect` cannot fire: a skill is marked `Python` only when its metadata was parsed.
#[must_use]
pub fn get_python_skill_runtime_info(skills: &[Skill]) -> Vec<PythonSkillRuntimeInfo> {
    skills
        .iter()
        .filter(|skill| skill.is_python() && skill.source_info.scope != SourceScope::Project)
        .map(|skill| {
            let python = skill.python.as_ref().expect("python skill has metadata");
            PythonSkillRuntimeInfo {
                name: skill.name.clone(),
                import_name: python.import_name.clone(),
                package_path: python.package_path.clone(),
                pyproject_path: python.pyproject_path.clone(),
            }
        })
        .collect()
}

pub(crate) fn validate_name(name: &str, parent_dir_name: &str) -> Vec<String> {
    let mut errors = Vec::new();
    if name != parent_dir_name {
        errors.push(format!(
            "name \"{name}\" does not match parent directory \"{parent_dir_name}\""
        ));
    }
    if name.len() > MAX_NAME_LENGTH {
        errors.push(format!(
            "name exceeds {MAX_NAME_LENGTH} characters ({})",
            name.len()
        ));
    }
    if !name
        .chars()
        .all(|c| c.is_ascii_lowercase() || c.is_ascii_digit() || c == '-')
        || name.is_empty()
    {
        errors.push(
            "name contains invalid characters (must be lowercase a-z, 0-9, hyphens only)"
                .to_string(),
        );
    }
    if name.starts_with('-') || name.ends_with('-') {
        errors.push("name must not start or end with a hyphen".to_string());
    }
    if name.contains("--") {
        errors.push("name must not contain consecutive hyphens".to_string());
    }
    errors
}

pub(crate) fn validate_description(description: &str) -> Vec<String> {
    let mut errors = Vec::new();
    if description.trim().is_empty() {
        errors.push("description is required".to_string());
    } else if description.len() > MAX_DESCRIPTION_LENGTH {
        errors.push(format!(
            "description exceeds {MAX_DESCRIPTION_LENGTH} characters ({})",
            description.len()
        ));
    }
    errors
}

pub(crate) use validate_description as validate_skill_description;
pub(crate) use validate_name as validate_skill_name;

/// Format skills for a system prompt (Agent Skills XML standard); skills
/// with `disable-model-invocation` are excluded.
#[must_use]
pub fn format_skills_for_prompt(skills: &[Skill]) -> String {
    let visible: Vec<&Skill> = skills
        .iter()
        .filter(|skill| !skill.disable_model_invocation)
        .collect();
    if visible.is_empty() {
        return String::new();
    }
    let mut lines = vec![
        "\n\nThe following skills provide specialized instructions for specific tasks.".to_string(),
        "Use python_repl to inspect a skill's file when the task matches its description.".to_string(),
        "Skills with a python_import are prepared in the persistent Python kernel when available and can be called directly by that import name.".to_string(),
        "When a skill file references a relative path, resolve it against the skill directory (parent of SKILL.md / dirname of the path) and use that absolute path in tool commands.".to_string(),
        String::new(),
        "<available_skills>".to_string(),
    ];
    for skill in visible {
        lines.push("  <skill>".to_string());
        lines.push(format!("    <name>{}</name>", escape_xml(&skill.name)));
        lines.push(format!("    <type>{}</type>", skill.kind_label()));
        if let Some(python) = &skill.python {
            lines.push(format!(
                "    <python_import>{}</python_import>",
                escape_xml(&python.import_name)
            ));
        }
        lines.push(format!(
            "    <description>{}</description>",
            escape_xml(&skill.description)
        ));
        lines.push(format!(
            "    <location>{}</location>",
            escape_xml(&skill.file_path.display().to_string())
        ));
        lines.push("  </skill>".to_string());
    }
    lines.push("</available_skills>".to_string());
    lines.join("\n")
}

pub(crate) fn escape_xml(value: &str) -> String {
    value
        .replace('&', "&amp;")
        .replace('<', "&lt;")
        .replace('>', "&gt;")
        .replace('"', "&quot;")
        .replace('\'', "&apos;")
}

/// The `<skill ...>` message block for a skill: its file's body,
/// frontmatter stripped. `None` when the file cannot be read.
fn skill_block(skill: &Skill) -> Option<String> {
    let content = std::fs::read_to_string(&skill.file_path).ok()?;
    let body = frontmatter::strip_frontmatter(&content).trim().to_string();
    Some(format!(
        "<skill name=\"{}\" location=\"{}\">\nReferences are relative to {}.\n\n{}\n</skill>",
        skill.name,
        skill.file_path.display(),
        skill.base_dir.display(),
        body
    ))
}

/// Expand the `/skill:<name>` references of a message into `<skill ...>`
/// blocks, each skill once (hidden skills included). A message that starts
/// with a known `/skill:<name>` becomes its block followed by the rest of
/// the message after a blank line; references elsewhere (standalone words
/// outside code, see [`pa_types::skill_blocks::skill_references`]) prepend
/// their blocks and leave the user's text as written. Unknown names, an
/// unreadable skill file, and an already-expanded message pass through.
/// Returns the skills the expansion used.
#[must_use]
pub fn expand_skill_command<'a>(text: &str, skills: &'a [Skill]) -> (String, Vec<&'a Skill>) {
    if pa_types::skill_blocks::parse_skill_block(text).is_some() {
        return (text.to_string(), Vec::new());
    }
    let find = |name: &str| skills.iter().find(|skill| skill.name == name);
    let leading = parse_slash_command(text).and_then(|(name, args)| {
        let skill = find(name.strip_prefix("skill:")?)?;
        Some((skill, args))
    });
    let mut used: Vec<&Skill> = leading.iter().map(|(skill, _)| *skill).collect();
    for name in pa_types::skill_blocks::skill_references(text) {
        if let Some(skill) = find(name) {
            if !used.iter().any(|known| known.name == skill.name) {
                used.push(skill);
            }
        }
    }
    let mut blocks: Vec<String> = Vec::new();
    used.retain(|skill| match skill_block(skill) {
        Some(block) => {
            blocks.push(block);
            true
        }
        None => false,
    });
    let leading_used = leading
        .as_ref()
        .is_some_and(|(leading, _)| used.first().is_some_and(|first| first.name == leading.name));
    let message = match leading {
        Some((_, args)) if leading_used => args,
        _ => text.to_string(),
    };
    if blocks.is_empty() {
        return (text.to_string(), used);
    }
    if !message.is_empty() {
        blocks.push(message);
    }
    (blocks.join("\n\n"), used)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn name_validation_rules() {
        assert!(validate_name("web-search", "web-search").is_empty());
        assert!(!validate_name("web_search", "web_search").is_empty());
        assert!(!validate_name("-lead", "-lead").is_empty());
        assert!(!validate_name("a--b", "a--b").is_empty());
        assert!(!validate_name("web", "other").is_empty());
    }

    #[test]
    fn description_validation_rules() {
        assert_eq!(validate_description(""), vec!["description is required"]);
        assert!(validate_description("ok").is_empty());
        let long = "x".repeat(MAX_DESCRIPTION_LENGTH + 1);
        assert_eq!(validate_description(&long).len(), 1);
    }

    fn temp_skill(name: &str, dir: &std::path::Path) -> Skill {
        let file_path = dir.join("SKILL.md");
        std::fs::write(
            &file_path,
            format!("---\nname: {name}\ndescription: test skill\n---\nUse {name} well."),
        )
        .expect("write skill file");
        Skill {
            name: name.to_string(),
            description: "test skill".to_string(),
            file_path: file_path.clone(),
            base_dir: dir.to_path_buf(),
            source_info: create_synthetic_source_info(
                &file_path.display().to_string(),
                "user",
                SourceScope::User,
                None,
            ),
            disable_model_invocation: false,
            kind: SkillKind::Markdown,
            python: None,
        }
    }

    #[test]
    fn expands_a_known_skill_command_with_and_without_args() {
        let dir = tempfile::tempdir().expect("tempdir");
        let skill = temp_skill("web-search", dir.path());
        let skills = [skill];
        let (expanded, used) = expand_skill_command("/skill:web-search", &skills);
        assert_eq!(used, vec![&skills[0]]);
        let parsed = pa_types::skill_blocks::parse_skill_block(&expanded).expect("parses");
        assert_eq!(parsed.name, "web-search");
        // TS block shape: the references note rides inside the body,
        // ahead of the frontmatter-stripped skill content.
        assert_eq!(
            parsed.content,
            format!(
                "References are relative to {}.\n\nUse web-search well.",
                dir.path().display()
            )
        );
        assert_eq!(parsed.user_message, None);
        assert!(parsed.location.ends_with("SKILL.md"));

        let (expanded, used) = expand_skill_command("/skill:web-search find rust tuis", &skills);
        assert_eq!(used, vec![&skills[0]]);
        let parsed = pa_types::skill_blocks::parse_skill_block(&expanded).expect("parses");
        assert_eq!(
            parsed.user_message.as_deref(),
            Some("find rust tuis"),
            "args follow the block after a blank line"
        );
    }

    #[test]
    fn an_empty_frontmatter_block_is_a_warned_skip_not_a_panic() {
        // TS no-frontmatter semantics: the whole document is the body, the
        // description is missing, the skill is NOT loaded (warning).
        let dir = tempfile::tempdir().expect("tempdir");
        let skill_dir = dir.path().join("bare");
        std::fs::create_dir_all(&skill_dir).expect("mkdir");
        std::fs::write(skill_dir.join("SKILL.md"), "---\n---\nUse it well.").expect("write");
        let result = crate::skills::load_skills_from_dir(dir.path(), "user");
        assert!(result.skills.is_empty());
        assert!(result.diagnostics.iter().any(
            |d| matches!(d, crate::skills::ResourceDiagnostic::Warning { message, .. }
                if message == "description is required")
        ));
    }

    #[test]
    fn invalid_yaml_frontmatter_reports_the_parse_error() {
        // An unquoted `: ` inside a plain scalar (the shipped factory skill's
        // old description) is invalid YAML: the warning carries the parser's
        // error instead of a misleading missing-description complaint.
        let dir = tempfile::tempdir().expect("tempdir");
        let skill_dir = dir.path().join("colon");
        std::fs::create_dir_all(&skill_dir).expect("mkdir");
        let yaml = "name: colon\ndescription: Run workflows: store and resume them";
        std::fs::write(
            skill_dir.join("SKILL.md"),
            format!("---\n{yaml}\n---\nbody"),
        )
        .expect("write");
        let yaml_error = serde_yaml::from_str::<serde_yaml::Value>(yaml).unwrap_err();
        let result = crate::skills::load_skills_from_dir(dir.path(), "user");
        assert!(result.skills.is_empty());
        assert_eq!(
            result.diagnostics,
            vec![crate::skills::ResourceDiagnostic::Warning {
                message: format!("invalid YAML frontmatter: {yaml_error}"),
                path: Some(skill_dir.join("SKILL.md").display().to_string()),
            }]
        );
    }

    #[test]
    fn an_empty_frontmatter_name_falls_back_to_the_parent_directory() {
        // TS `frontmatter.name || parentDirName`.
        let dir = tempfile::tempdir().expect("tempdir");
        let skill_dir = dir.path().join("named-dir");
        std::fs::create_dir_all(&skill_dir).expect("mkdir");
        std::fs::write(
            skill_dir.join("SKILL.md"),
            "---\nname: \"\"\ndescription: The named dir skill\n---\nbody",
        )
        .expect("write");
        let result = crate::skills::load_skills_from_dir(dir.path(), "user");
        assert_eq!(
            result
                .skills
                .iter()
                .map(|skill| skill.name.as_str())
                .collect::<Vec<_>>(),
            vec!["named-dir"]
        );
    }

    #[test]
    fn non_skill_and_unknown_inputs_pass_through() {
        let dir = tempfile::tempdir().expect("tempdir");
        let skills = [temp_skill("web-search", dir.path())];
        for text in [
            "hello world",
            "/compact",
            "/skill:missing do something",
            "/skill:",
            "see `/skill:web-search` inline",
            "```\n/skill:web-search\n```",
            "read /skill:web-search/SKILL.md",
        ] {
            let (expanded, used) = expand_skill_command(text, &skills);
            assert_eq!(expanded, text, "{text} must pass through");
            assert!(used.is_empty(), "{text} must not report a skill");
        }
    }

    #[test]
    fn hidden_skills_expand_at_the_start_and_anywhere_in_the_message() {
        let hidden_dir = tempfile::tempdir().expect("tempdir");
        let other_dir = tempfile::tempdir().expect("tempdir");
        let mut hidden = temp_skill("hidden-one", hidden_dir.path());
        hidden.disable_model_invocation = true;
        let skills = [hidden, temp_skill("other", other_dir.path())];
        let block = |skill: &Skill| skill_block(skill).expect("readable");

        let (expanded, used) = expand_skill_command("/skill:hidden-one go", &skills);
        assert_eq!(expanded, format!("{}\n\ngo", block(&skills[0])));
        assert_eq!(used, vec![&skills[0]]);

        let text = "use /skill:other, then /skill:hidden-one\nand /skill:other again";
        let (expanded, used) = expand_skill_command(text, &skills);
        assert_eq!(
            expanded,
            format!("{}\n\n{}\n\n{text}", block(&skills[0]), block(&skills[1])),
            "each referenced skill's block once, in first-use order, before the text"
        );
        assert_eq!(used, vec![&skills[0], &skills[1]]);
        assert_eq!(
            expand_skill_command(&expanded, &skills),
            (expanded.clone(), Vec::new()),
            "an expanded message passes through"
        );
    }

    #[test]
    fn an_unreadable_skill_file_passes_through() {
        let dir = tempfile::tempdir().expect("tempdir");
        let mut skill = temp_skill("gone", dir.path());
        std::fs::remove_file(&skill.file_path).expect("remove skill file");
        skill.file_path = dir.path().join("missing-SKILL.md");
        let skills = [skill];
        let (expanded, used) = expand_skill_command("/skill:gone", &skills);
        assert_eq!(expanded, "/skill:gone");
        assert!(used.is_empty());
    }

    #[test]
    fn prompt_formatting_excludes_hidden() {
        let skill = |name: &str, disable: bool| Skill {
            name: name.to_string(),
            description: format!("Does {name}"),
            file_path: PathBuf::from("/s/SKILL.md"),
            base_dir: PathBuf::from("/s"),
            source_info: create_synthetic_source_info("/s", "user", SourceScope::User, None),
            disable_model_invocation: disable,
            kind: SkillKind::Markdown,
            python: None,
        };
        let hidden = format_skills_for_prompt(&[skill("hidden", true)]);
        assert_eq!(hidden, "");
        let formatted = format_skills_for_prompt(&[skill("web-search", false)]);
        assert!(formatted.contains("<name>web-search</name>"));
        assert!(formatted.contains("<type>markdown</type>"));
        assert!(formatted.contains("<description>Does web-search</description>"));
    }
}

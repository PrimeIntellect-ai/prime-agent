//! Per-model system-prompt additions: a TOML rule map from model selectors to markdown files.
//! Shipped rules run before the user's `<agent_dir>/model-prompts.toml` rules; any problem in
//! either layer disables all additions for the session and is reported, never blocking.

use std::collections::BTreeMap;
use std::io;
use std::path::{Component, Path};

use pa_types::session::CustomMessage;
use serde::Deserialize;

pub const MODEL_PROMPTS_TOML: &str = include_str!("layers/model_prompts.toml");

const MODEL_PROMPT_FILES: &[(&str, &str)] = &[];

const USER_MODEL_PROMPTS_TOML: &str = "model-prompts.toml";

/// `display: true` rows of this type are dropped from LLM context by `messages::convert_to_llm`.
pub const MODEL_PROMPT_ERROR_CUSTOM_TYPE: &str = "model_prompt_error";

const SHIPPED_SOURCE: &str = "shipped model_prompts.toml";

/// `extras` is `None` whenever `errors` is non-empty.
#[derive(Debug, Default, PartialEq, Eq)]
pub struct ModelPromptResolution {
    pub extras: Option<String>,
    pub errors: Vec<String>,
}

#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields)]
struct Rule {
    r#match: Vec<String>,
    files: Vec<String>,
}

#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields)]
struct ModelPromptsDoc {
    #[serde(default)]
    rule: Vec<Rule>,
}

struct ParsedRule {
    patterns: Vec<globset::GlobMatcher>,
    files: Vec<String>,
}

fn compile_pattern(pattern: &str) -> Result<globset::GlobMatcher, String> {
    globset::GlobBuilder::new(pattern)
        .literal_separator(true)
        .case_insensitive(true)
        .build()
        .map_err(|error| format!("pattern {pattern:?}: {error}"))
        .map(|glob| glob.compile_matcher())
}

fn parse_layer(toml_text: &str, source: &str) -> (Vec<ParsedRule>, Vec<String>) {
    let doc = match toml::from_str::<ModelPromptsDoc>(toml_text) {
        Ok(doc) => doc,
        Err(error) => return (Vec::new(), vec![format!("{source}: {error}")]),
    };
    let mut rules = Vec::new();
    let mut errors = Vec::new();
    for rule in doc.rule {
        let mut patterns = Vec::new();
        for pattern in rule.r#match {
            match compile_pattern(&pattern) {
                Ok(matcher) => patterns.push(matcher),
                Err(error) => errors.push(format!("{source}: {error}")),
            }
        }
        let mut files = Vec::new();
        for name in rule.files {
            if Path::new(&name).components().all(|c| {
                !matches!(
                    c,
                    Component::ParentDir | Component::RootDir | Component::Prefix(_)
                )
            }) {
                // Normalize equivalent spellings before resolution and deduplication.
                let normalized = Path::new(&name)
                    .components()
                    .filter(|component| !matches!(component, Component::CurDir))
                    .map(|component| component.as_os_str().to_string_lossy())
                    .collect::<Vec<_>>()
                    .join("/");
                files.push(normalized);
            } else {
                errors.push(format!(
                    "{source}: file {name:?} must be a relative path inside the agent directory"
                ));
            }
        }
        rules.push(ParsedRule { patterns, files });
    }
    (rules, errors)
}

/// Strips a trailing `:<level>` only when it parses as a thinking level, mirroring the model
/// parser.
fn selector_segments(selector: &str) -> Vec<&str> {
    let selector = match selector.rsplit_once(':') {
        Some((prefix, suffix)) if crate::models::resolver::is_valid_thinking_level(suffix) => {
            prefix
        }
        _ => selector,
    };
    selector.split('/').collect()
}

fn rule_applies(rule: &ParsedRule, segments: &[&str]) -> bool {
    rule.patterns.iter().any(|matcher| {
        (1..=segments.len())
            .any(|count| matcher.is_match(segments[segments.len() - count..].join("/")))
    })
}

// Check the file type before opening: opening a FIFO can wait forever for a writer.
fn read_regular_file(path: &Path) -> io::Result<String> {
    if !std::fs::metadata(path)?.is_file() {
        return Err(io::Error::new(
            io::ErrorKind::InvalidInput,
            "expected a regular file",
        ));
    }
    std::fs::read_to_string(path)
}

fn resolve_layer_files(
    rules: &[ParsedRule],
    source: &str,
    agent_dir: &Path,
    shipped_files: &[(&str, &str)],
    contents: &mut BTreeMap<String, String>,
) -> Vec<String> {
    let mut errors = Vec::new();
    for rule in rules {
        for name in &rule.files {
            if contents.contains_key(name) {
                continue;
            }
            let user_file = agent_dir.join(name);
            let content = user_file.canonicalize().and_then(|resolved| {
                let root = agent_dir.canonicalize()?;
                if !resolved.starts_with(root) {
                    return Err(io::Error::new(
                        io::ErrorKind::InvalidInput,
                        "file resolves outside the agent directory",
                    ));
                }
                read_regular_file(&resolved)
            });
            match content {
                Ok(content) => {
                    contents.insert(name.clone(), content);
                }
                Err(error) if error.kind() == io::ErrorKind::NotFound => {
                    if let Some((_, content)) = shipped_files
                        .iter()
                        .find(|(shipped_name, _)| shipped_name == &name.as_str())
                    {
                        contents.insert(name.clone(), (*content).to_string());
                    } else {
                        errors.push(format!("{source}: missing file {name:?}"));
                    }
                }
                Err(error) => {
                    errors.push(format!("{source}: {}: {error}", user_file.display()));
                }
            }
        }
    }
    errors
}

fn resolve_model_prompts(
    selector: Option<&str>,
    shipped_toml: &str,
    shipped_files: &[(&str, &str)],
    agent_dir: &Path,
) -> ModelPromptResolution {
    // Both layers are validated regardless; the selector only gates which
    // rules match, so `prime-agent prompt` with no `--model` still reports
    // a broken map.
    let segments = selector.map(selector_segments);
    let mut errors = Vec::new();

    let (shipped_rules, mut layer_errors) = parse_layer(shipped_toml, SHIPPED_SOURCE);
    errors.append(&mut layer_errors);
    let user_path = agent_dir.join(USER_MODEL_PROMPTS_TOML);
    let user_layer = user_path.display().to_string();
    let user_rules = match read_regular_file(&user_path) {
        Ok(text) => {
            let (rules, mut layer_errors) = parse_layer(&text, &user_layer);
            errors.append(&mut layer_errors);
            rules
        }
        Err(error) if error.kind() == io::ErrorKind::NotFound => Vec::new(),
        Err(error) => {
            errors.push(format!("{}: {error}", user_path.display()));
            Vec::new()
        }
    };

    let mut contents: BTreeMap<String, String> = BTreeMap::new();
    for (rules, source) in [
        (&shipped_rules, SHIPPED_SOURCE),
        (&user_rules, user_layer.as_str()),
    ] {
        errors.extend(resolve_layer_files(
            rules,
            source,
            agent_dir,
            shipped_files,
            &mut contents,
        ));
    }
    if !errors.is_empty() {
        return ModelPromptResolution {
            extras: None,
            errors,
        };
    }

    let mut included: Vec<&str> = Vec::new();
    for rule in shipped_rules.iter().chain(user_rules.iter()) {
        if segments
            .as_deref()
            .is_some_and(|segments| rule_applies(rule, segments))
        {
            for name in &rule.files {
                if !included.contains(&name.as_str()) {
                    included.push(name.as_str());
                }
            }
        }
    }
    let parts = included
        .iter()
        .map(|name| contents[*name].trim())
        .filter(|text| !text.is_empty())
        .collect::<Vec<_>>();
    let extras = (!parts.is_empty()).then(|| parts.join("\n\n"));
    ModelPromptResolution { extras, errors }
}

#[must_use]
pub fn load_model_prompts(selector: Option<&str>, agent_dir: &Path) -> ModelPromptResolution {
    resolve_model_prompts(selector, MODEL_PROMPTS_TOML, MODEL_PROMPT_FILES, agent_dir)
}

#[must_use]
pub fn model_prompt_error_message(errors: &[String]) -> CustomMessage {
    let list = errors
        .iter()
        .map(|error| format!("- {error}"))
        .collect::<Vec<_>>()
        .join("\n");
    CustomMessage {
        custom_type: MODEL_PROMPT_ERROR_CUSTOM_TYPE.to_string(),
        content: pa_types::ai::UserContent::Text(format!(
            "[model-prompt-error]\n\nPer-model system prompt additions were not applied:\n{list}"
        )),
        display: true,
        details: None,
        timestamp: crate::session_engine::refine::now_millis(),
        rest: serde_json::Map::default(),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn write_file(dir: &std::path::Path, name: &str, content: &str) {
        std::fs::write(dir.join(name), content).unwrap();
    }

    fn user_layer(toml_rules: &str) -> tempfile::TempDir {
        let dir = tempfile::tempdir().unwrap();
        write_file(dir.path(), USER_MODEL_PROMPTS_TOML, toml_rules);
        dir
    }

    #[test]
    fn documented_selector_examples_match() {
        let cases = [
            ("glm-5.3", "z-ai/glm-5.3", true),
            ("glm-5.3", "internal/glm-5.3-fast", false),
            ("glm-5.3*", "internal/glm-5.3-fast", true),
            (
                "internal/glm-5.3*",
                "prime-inference/internal/glm-5.3-fast",
                true,
            ),
            ("internal/glm-5.3*", "z-ai/glm-5.3-fast", false),
            ("internal/*", "prime-inference/internal/glm-5.3", true),
            (
                "prime-inference/anthropic/claude-fable-5.1",
                "prime-inference/anthropic/claude-fable-5.1",
                true,
            ),
            (
                "prime-inference/anthropic/claude-fable-5.1",
                "anthropic/claude-fable-5.1",
                false,
            ),
            (
                "anthropic/claude-sonnet-4",
                "anthropic/claude-sonnet-4",
                true,
            ),
            (
                "anthropic/claude-sonnet-4",
                "prime-inference/anthropic/claude-sonnet-4",
                true,
            ),
            // case-insensitive
            ("GLM-5.3*", "z-ai/glm-5.3-fast", true),
            // a trailing thinking level is stripped from the selector
            ("glm-5.3", "z-ai/glm-5.3:high", true),
            ("glm-5.3*", "z-ai/glm-5.3-fast:xhigh", true),
            // dots are literal (a regex `.` would match the `-`)
            ("claude-sonnet-3.5", "anthropic/claude-sonnet-3-5", false),
            // `?` matches exactly one character
            ("claude-sonnet-?", "anthropic/claude-sonnet-4", true),
            ("claude-sonnet-?", "anthropic/claude-sonnet-4.5", false),
            // a brace pattern applies when any alternative fits the final
            // segments, even though the pattern string spans more slashes
            ("{anthropic/claude-*,z-ai/glm-*}", "z-ai/glm-5.3", true),
        ];
        for (pattern, selector, expected) in cases {
            let (rules, _) =
                parse_layer(&format!("[[rule]]\nmatch = [{pattern:?}]\nfiles = []"), "t");
            assert_eq!(
                rule_applies(&rules[0], &selector_segments(selector)),
                expected,
                "pattern {pattern:?} against {selector:?}"
            );
        }
    }

    #[test]
    fn every_matching_rule_applies_and_shared_files_dedupe_first() {
        let dir = user_layer(
            r#"
[[rule]]
match = ["glm-5.3"]
files = ["a.md", "b.md"]

[[rule]]
match = ["glm-5.3*"]
files = ["./b.md", "c.md", "././a.md"]

[[rule]]
match = ["claude-*"]
files = ["a.md"]
"#,
        );
        write_file(dir.path(), "a.md", "A");
        write_file(dir.path(), "b.md", "B");
        write_file(dir.path(), "c.md", "C");
        let resolution = resolve_model_prompts(Some("z-ai/glm-5.3"), "", &[], dir.path());
        assert!(resolution.errors.is_empty());
        assert_eq!(resolution.extras.as_deref(), Some("A\n\nB\n\nC"));
    }

    #[test]
    fn user_files_override_shipped_and_user_rules_run_last() {
        let dir = user_layer(
            r#"
[[rule]]
match = ["glm-5.3"]
files = ["shared.md", "user-only.md"]
"#,
        );
        write_file(dir.path(), "shared.md", "USER");
        write_file(dir.path(), "user-only.md", "USER-ONLY");
        let shipped_toml = "[[rule]]\nmatch = [\"glm-5.3\"]\nfiles = [\"shared.md\"]\n";
        let shipped_files = [("shared.md", "SHIPPED")];
        let resolution = resolve_model_prompts(
            Some("z-ai/glm-5.3"),
            shipped_toml,
            &shipped_files,
            dir.path(),
        );
        assert!(resolution.errors.is_empty());
        assert_eq!(resolution.extras.as_deref(), Some("USER\n\nUSER-ONLY"));

        let clean = tempfile::tempdir().unwrap();
        let resolution = resolve_model_prompts(
            Some("z-ai/glm-5.3"),
            shipped_toml,
            &shipped_files,
            clean.path(),
        );
        assert_eq!(resolution.extras.as_deref(), Some("SHIPPED"));
    }

    #[test]
    fn layer_problems_disable_extras_and_name_the_source() {
        let empty = tempfile::tempdir().unwrap();
        let resolution = resolve_model_prompts(Some("z-ai/glm-5.3"), "", &[], empty.path());
        assert_eq!(resolution, ModelPromptResolution::default());

        let cases = [
            ("not a rule map [", USER_MODEL_PROMPTS_TOML),
            (
                "[[rule]]\nmatches = [\"glm-5.3\"]\nfiles = [\"a.md\"]\n",
                USER_MODEL_PROMPTS_TOML,
            ),
            (
                "[[rule]]\nmatch = [\"glm-5.3\"]\nfiles = [\"missing.md\"]\n",
                "missing.md",
            ),
            (
                "[[rule]]\nmatch = [\"glm-5.3[\"]\nfiles = [\"a.md\"]\n",
                "glm-5.3[",
            ),
        ];
        for (toml_text, named) in cases {
            let dir = user_layer(toml_text);
            write_file(dir.path(), "a.md", "A");
            let resolution = resolve_model_prompts(Some("z-ai/glm-5.3"), "", &[], dir.path());
            assert!(resolution.extras.is_none(), "extras survived {toml_text:?}");
            assert!(
                resolution
                    .errors
                    .iter()
                    .any(|error| error.contains(named) && error.contains(USER_MODEL_PROMPTS_TOML)),
                "{toml_text:?}: errors {:#?} do not name {named} in {USER_MODEL_PROMPTS_TOML}",
                resolution.errors
            );
        }

        let dir = user_layer("[[rule]]\nmatch = [\"claude-*\"]\nfiles = [\"missing-user.md\"]\n");
        let resolution = resolve_model_prompts(
            Some("z-ai/glm-5.3"),
            "[[rule]]\nmatch = [\"glm-5.3\"]\nfiles = [\"missing-shipped.md\"]\n",
            &[],
            dir.path(),
        );
        assert!(resolution.extras.is_none());
        assert!(resolution
            .errors
            .iter()
            .any(|error| error.contains("missing-user.md")));
        assert!(resolution
            .errors
            .iter()
            .any(|error| error.contains("missing-shipped.md")));

        let dir = user_layer("not a rule map [");
        let resolution = resolve_model_prompts(None, "", &[], dir.path());
        assert!(resolution.extras.is_none());
        assert!(resolution
            .errors
            .iter()
            .any(|error| error.contains(USER_MODEL_PROMPTS_TOML)));
    }

    #[test]
    fn the_shipped_map_is_valid() {
        let empty = tempfile::tempdir().unwrap();
        let resolution = load_model_prompts(Some("z-ai/glm-5.3"), empty.path());
        assert!(resolution.errors.is_empty());
    }

    #[test]
    fn file_entries_outside_the_agent_dir_are_rejected() {
        let root = tempfile::tempdir().unwrap();
        write_file(root.path(), "outside.md", "OUTSIDE");
        let agent_dir = root.path().join("agent");
        std::fs::create_dir(&agent_dir).unwrap();
        write_file(&agent_dir, "inside.md", "INSIDE");

        let outside = root.path().join("outside.md").display().to_string();
        let cases = [
            ("inside.md", Some("INSIDE"), false),
            ("./inside.md", Some("INSIDE"), false),
            ("../outside.md", None, true),
            (outside.as_str(), None, true),
        ];
        let mut failures = Vec::new();
        for (name, extras, rejected) in cases {
            write_file(
                &agent_dir,
                USER_MODEL_PROMPTS_TOML,
                &format!("[[rule]]\nmatch = [\"glm-5.3\"]\nfiles = [{name:?}]\n"),
            );
            let resolution = resolve_model_prompts(Some("z-ai/glm-5.3"), "", &[], &agent_dir);
            let leaked = resolution.extras.as_deref();
            if leaked != extras {
                failures.push(format!(
                    "file {name:?}: extras {leaked:?}, expected {extras:?}"
                ));
            }
            let named = resolution
                .errors
                .iter()
                .any(|error| error.contains(&format!("{name:?}")));
            if named != rejected {
                failures.push(format!("file {name:?}: errors {:#?}", resolution.errors));
            }
        }
        assert!(failures.is_empty(), "{failures:#?}");
    }

    #[test]
    fn normalized_names_resolve_shipped_files() {
        let dir = user_layer("[[rule]]\nmatch = [\"*\"]\nfiles = [\"./a.md\", \"a.md\"]\n");
        let resolution = resolve_model_prompts(Some("model"), "", &[("a.md", "A")], dir.path());
        assert_eq!(
            resolution,
            ModelPromptResolution {
                extras: Some("A".to_string()),
                errors: Vec::new(),
            }
        );
    }

    #[cfg(unix)]
    #[test]
    fn symlink_targets_must_stay_inside_agent_directory() {
        use std::os::unix::fs::symlink;

        let root = tempfile::tempdir().unwrap();
        let agent_dir = root.path().join("agent");
        std::fs::create_dir(&agent_dir).unwrap();
        write_file(root.path(), "outside.md", "OUTSIDE");
        write_file(&agent_dir, "inside.md", "INSIDE");
        symlink(root.path().join("outside.md"), agent_dir.join("escape.md")).unwrap();
        symlink(root.path(), agent_dir.join("escape-dir")).unwrap();
        symlink(agent_dir.join("inside.md"), agent_dir.join("safe.md")).unwrap();
        for name in ["escape.md", "escape-dir/outside.md", "safe.md"] {
            write_file(
                &agent_dir,
                USER_MODEL_PROMPTS_TOML,
                &format!("[[rule]]\nmatch = [\"*\"]\nfiles = [{name:?}]\n"),
            );
            let resolution = resolve_model_prompts(Some("model"), "", &[], &agent_dir);
            if name == "safe.md" {
                assert_eq!(
                    resolution,
                    ModelPromptResolution {
                        extras: Some("INSIDE".to_string()),
                        errors: Vec::new(),
                    }
                );
            } else {
                assert!(resolution.extras.is_none());
                assert!(resolution
                    .errors
                    .iter()
                    .any(|error| error.contains("outside the agent directory")));
            }
        }
    }

    #[cfg(unix)]
    #[test]
    fn fifos_are_rejected_without_opening_them() {
        // Keep a writer available so a regression fails assertions instead of hanging the suite.
        for name in [USER_MODEL_PROMPTS_TOML, "fifo.md"] {
            let dir =
                user_layer("[[rule]]\nmatch = [\"different-model\"]\nfiles = [\"fifo.md\"]\n");
            let path = dir.path().join(name);
            if name == USER_MODEL_PROMPTS_TOML {
                std::fs::remove_file(&path).unwrap();
            }
            nix::unistd::mkfifo(
                &path,
                nix::sys::stat::Mode::S_IRUSR | nix::sys::stat::Mode::S_IWUSR,
            )
            .unwrap();
            let writer_path = path.clone();
            let writer = std::thread::spawn(move || {
                // Nonblocking open succeeds only if the loader incorrectly opened the FIFO.
                use std::os::unix::fs::OpenOptionsExt;
                loop {
                    if let Ok(file) = std::fs::OpenOptions::new()
                        .write(true)
                        .custom_flags(libc::O_NONBLOCK)
                        .open(&writer_path)
                    {
                        drop(file);
                        break;
                    }
                    if !writer_path.exists() {
                        break;
                    }
                    std::thread::yield_now();
                }
            });
            let resolution = resolve_model_prompts(Some("model"), "", &[], dir.path());
            std::fs::remove_file(&path).unwrap();
            writer.join().unwrap();
            assert!(resolution.extras.is_none());
            assert!(resolution
                .errors
                .iter()
                .any(|error| error.contains("expected a regular file")));
        }
    }
}

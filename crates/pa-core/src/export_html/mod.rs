//! Session HTML export: the standalone viewer file a session export
//! produces. The template (HTML + CSS + JS, plus vendored markdown and
//! syntax-highlight libraries, see `assets/export-html/NOTICE.md`) is the
//! product export template, embedded verbatim; the session data rides inside
//! the file as a base64 JSON blob the template decodes and renders
//! client-side (message rows, tool cards, code blocks, the session tree
//! sidebar).
//!
//! Two entry points:
//! - [`export_session_to_html`] exports a live session (the daemon worker's
//!   `export_html` command, driven by the TUI `/export` and `/share`).
//! - [`export_from_file`] exports an arbitrary session file (the CLI
//!   `session export` command).
//!
//! Rendering of an exported session is the template's job; this module owns
//! the data shape (`SessionExportData`) and the file write.

use std::path::Path;
use std::sync::Arc;

use anyhow::{bail, Result};
use base64::Engine as _;
use serde::Serialize;
use serde_json::Value;

use crate::session::manager::SessionManager;
use pa_types::session::FileEntry;

use self::theme::resolve_export_theme;

pub mod ansi_to_html;
mod theme;
pub mod tool_render;

pub use self::tool_render::{
    pre_render_custom_tools, RenderedToolHtml, RenderedToolResult, ToolHtmlRenderer,
};

/// The app name in generated export file names.
pub const EXPORT_APP_NAME: &str = "prime-agent";

const TEMPLATE_HTML: &str = include_str!("../../assets/export-html/template.html");
const TEMPLATE_CSS: &str = include_str!("../../assets/export-html/template.css");
const TEMPLATE_JS: &str = include_str!("../../assets/export-html/template.js");
const MARKED_JS: &str = include_str!("../../assets/export-html/vendor/marked.min.js");
const HIGHLIGHT_JS: &str = include_str!("../../assets/export-html/vendor/highlight.min.js");

/// The session data embedded into an exported file. Field names are the
/// template's wire contract (`template.js` decodes the base64 blob and
/// destructures these keys): `header`, `entries`, `leafId`, `systemPrompt`,
/// `tools`, `renderedTools`. Absent optional sections serialize to `null`,
/// which the template treats as "not present".
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SessionExportData {
    /// The session header entry (`type: "session"` line), as written.
    pub header: Value,
    /// Every non-header entry in file order, as written.
    pub entries: Vec<Value>,
    /// The current leaf entry id (the exported tree's default position).
    pub leaf_id: Option<String>,
    /// The session's assembled system prompt, when the exporter knows it.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub system_prompt: Option<String>,
    /// The session's registered tools (`name`/`description`/`parameters`),
    /// when the exporter knows them.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub tools: Option<Vec<Value>>,
    /// Pre-rendered HTML for custom tool calls/results, keyed by
    /// tool-call id ([`pre_render_custom_tools`] output). The template
    /// falls back to its generic tool rendering for entries without an
    /// entry here. Omitted (not `null`) like the TS `JSON.stringify`
    /// drops undefined fields.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub rendered_tools: Option<Value>,
}

/// The `.jsonl` suffix of a session file name, without the extension (TS
/// `basename(sessionFile, ".jsonl")`).
fn session_basename(session_file: &Path) -> String {
    let name = session_file
        .file_name()
        .map(|name| name.to_string_lossy().into_owned())
        .unwrap_or_default();
    match name.strip_suffix(".jsonl") {
        Some(stripped) => stripped.to_string(),
        None => name,
    }
}

/// The default HTML output file name (TS
/// `` `${APP_NAME}-session-${basename}.html` ``), relative like the TS one.
pub fn default_html_output_path(session_file: &Path) -> String {
    format!(
        "{EXPORT_APP_NAME}-session-{}.html",
        session_basename(session_file)
    )
}

/// Fill the export template: the CSS block, the inline scripts, and the
/// base64 session data (TS `generateHtml`; each placeholder appears once, so
/// substitution is first-occurrence like the TS `replace`).
fn generate_html(data: &SessionExportData, theme: &theme::ExportTheme) -> String {
    let session_data = serde_json::to_string(data).unwrap_or_default();
    let session_data = base64::engine::general_purpose::STANDARD.encode(session_data);
    let css = TEMPLATE_CSS
        .replacen("{{THEME_VARS}}", &theme.theme_vars, 1)
        .replacen("{{BODY_BG}}", &theme.body_bg, 1)
        .replacen("{{CONTAINER_BG}}", &theme.container_bg, 1)
        .replacen("{{INFO_BG}}", &theme.info_bg, 1);
    TEMPLATE_HTML
        .replacen("{{CSS}}", &css, 1)
        .replacen("{{JS}}", TEMPLATE_JS, 1)
        .replacen("{{SESSION_DATA}}", &session_data, 1)
        .replacen("{{MARKED_JS}}", MARKED_JS, 1)
        .replacen("{{HIGHLIGHT_JS}}", HIGHLIGHT_JS, 1)
}

/// Write the export file and return the output path as the caller will
/// report it (the given path verbatim, or the default name).
fn write_export(html: &str, session_file: &Path, output_path: Option<&str>) -> Result<String> {
    let output = output_path.map_or_else(|| default_html_output_path(session_file), str::to_string);
    std::fs::write(&output, html)?;
    Ok(output)
}

/// Export a session to HTML (the daemon worker's `export_html` command).
///
/// `theme_name` is the session's configured theme (settings), resolved like
/// the TS exporter against `agent_dir`; `session_file` is the session's
/// JSONL path, which names the default output file; a given `output_path`
/// is used verbatim (the caller resolves it against the session's cwd).
///
/// # Errors
///
/// Returns an error when the configured theme cannot be resolved or the
/// export file cannot be written.
pub fn export_session_to_html(
    data: &SessionExportData,
    theme_name: Option<&str>,
    agent_dir: &Path,
    session_file: &Path,
    output_path: Option<&str>,
) -> Result<String> {
    let theme = resolve_export_theme(theme_name, agent_dir)?;
    let html = generate_html(data, &theme);
    write_export(&html, session_file, output_path)
}

/// Export an arbitrary session file to HTML (the CLI `session export`
/// command). Loads the file exactly like a session open (repair and
/// migration included), so the exported data is what a resume would see.
///
/// # Errors
///
/// Returns an error when the input file does not exist, cannot be loaded or
/// migrated, when the default theme cannot be resolved, or when the export
/// file cannot be written.
pub fn export_from_file(
    input_path: &Path,
    output_path: Option<&str>,
    agent_dir: &Path,
) -> Result<String> {
    if !input_path.exists() {
        bail!("File not found: {}", input_path.display());
    }
    let data = session_data_from_file(input_path)?;
    let theme = resolve_export_theme(None, agent_dir)?;
    let html = generate_html(&data, &theme);
    write_export(&html, input_path, output_path)
}

/// The export's tools section: each tool's model-facing contract
/// (name/description/JSON-schema parameters), exactly the TS exporter's
/// `state.tools.map` — the template renders these into its
/// "Available Tools" list.
pub fn tools_section(tools: &[Arc<dyn pa_agent::types::AgentTool>]) -> Vec<Value> {
    tools
        .iter()
        .map(|tool| {
            serde_json::json!({
                "name": tool.name(),
                "description": tool.description(),
                "parameters": tool.parameters(),
            })
        })
        .collect()
}

/// Build the export data from a session file: the header entry, every other
/// entry in file order, and the last entry's id as the leaf (the TS
/// `SessionManager` index build).
fn session_data_from_file(input_path: &Path) -> Result<SessionExportData> {
    let cwd = std::env::current_dir().unwrap_or_default();
    let mut manager = SessionManager::in_memory(&cwd);
    manager.set_session_file(input_path.to_path_buf(), None);
    let entries = manager.get_all_entries();
    let header = entries
        .iter()
        .find_map(|entry| match entry {
            FileEntry::Header { .. } => Some(serde_json::to_value(entry)),
            _ => None,
        })
        .transpose()?;
    let body: Vec<Value> = entries
        .iter()
        .filter(|entry| !matches!(entry, FileEntry::Header { .. }))
        .map(serde_json::to_value)
        .collect::<Result<_, serde_json::Error>>()?;
    let leaf_id = body
        .last()
        .and_then(|entry| entry.get("id"))
        .and_then(Value::as_str)
        .map(str::to_string);
    Ok(SessionExportData {
        header: header.unwrap_or(Value::Null),
        entries: body,
        leaf_id,
        system_prompt: None,
        tools: None,
        rendered_tools: None,
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::Write;

    fn fixture_session(dir: &Path) -> std::path::PathBuf {
        let path = dir.join("fixture-session.jsonl");
        let mut file = std::fs::File::create(&path).expect("create fixture");
        writeln!(
            file,
            r#"{{"type":"session","id":"sess-1","version":3,"timestamp":"2026-01-01T00:00:00.000Z","cwd":"/tmp"}}"#
        )
        .expect("write header");
        writeln!(
            file,
            r#"{{"type":"message","id":"e1","parentId":null,"timestamp":"2026-01-01T00:00:01.000Z","message":{{"role":"user","content":"hello"}}}}"#
        )
        .expect("write user message");
        writeln!(
            file,
            r#"{{"type":"message","id":"e2","parentId":"e1","timestamp":"2026-01-01T00:00:02.000Z","message":{{"role":"assistant","content":[{{"type":"text","text":"hi there"}}]}}}}"#
        )
        .expect("write assistant message");
        path
    }

    /// A fixture session exports to a self-contained HTML file: the template
    /// scaffolding, the theme CSS variables, and the base64 session data
    /// decoding to the exact header/entries/leaf shape.
    #[test]
    fn export_from_file_shape() {
        let dir = tempfile::TempDir::new().expect("temp dir");
        let agent_dir = dir.path().join("agent");
        std::fs::create_dir_all(&agent_dir).expect("agent dir");
        let session = fixture_session(dir.path());
        let out = dir.path().join("out.html");
        let returned =
            export_from_file(&session, Some(out.to_str().unwrap()), &agent_dir).expect("export");
        assert_eq!(returned, out.to_string_lossy());
        let html = std::fs::read_to_string(&out).expect("read export");
        assert!(html.contains("Session Export"));
        assert!(html.contains("--accent: #7c6faf;"));
        assert!(html.contains("marked.min.js") || html.contains("marked"));
        // The embedded session data decodes to the session's rows.
        let start = html
            .find("session-data\" type=\"application/json\">")
            .expect("session data element");
        let blob = &html[start + "session-data\" type=\"application/json\">".len()..];
        let blob = blob.split('<').next().expect("script end");
        let data: Value = serde_json::from_slice(
            &base64::engine::general_purpose::STANDARD
                .decode(blob.trim())
                .expect("valid base64"),
        )
        .expect("valid json");
        assert_eq!(data["header"]["type"], "session");
        assert_eq!(data["header"]["id"], "sess-1");
        assert_eq!(data["entries"].as_array().map(Vec::len), Some(2));
        assert_eq!(data["entries"][0]["message"]["role"], "user");
        assert_eq!(data["entries"][0]["message"]["content"], "hello");
        assert_eq!(data["entries"][1]["message"]["content"][0]["type"], "text");
        assert_eq!(data["leafId"], "e2");
        assert!(
            data.get("systemPrompt").is_none(),
            "absent sections are omitted: {data}"
        );
    }

    /// The default output name is the branded session basename (TS
    /// `` `${APP_NAME}-session-<basename>.html` ``) and the file lands in
    /// the working directory.
    #[test]
    fn default_output_name() {
        let dir = tempfile::TempDir::new().expect("temp dir");
        let agent_dir = dir.path().join("agent");
        std::fs::create_dir_all(&agent_dir).expect("agent dir");
        let session = fixture_session(dir.path());
        let cwd = tempfile::TempDir::new().expect("cwd");
        let previous = std::env::current_dir().expect("cwd");
        std::env::set_current_dir(cwd.path()).expect("chdir");
        let returned = export_from_file(&session, None, &agent_dir).expect("export");
        std::env::set_current_dir(previous).expect("restore cwd");
        assert_eq!(returned, "prime-agent-session-fixture-session.html");
        assert!(cwd.path().join(&returned).exists());
    }

    /// A missing input file is the TS error, verbatim.
    #[test]
    fn missing_input_file() {
        let dir = tempfile::TempDir::new().expect("temp dir");
        let agent_dir = dir.path().join("agent");
        std::fs::create_dir_all(&agent_dir).expect("agent dir");
        let error = export_from_file(&dir.path().join("nope.jsonl"), None, &agent_dir)
            .expect_err("missing file must fail");
        assert!(
            error.to_string().starts_with("File not found:"),
            "unexpected: {error}"
        );
    }

    /// The tools section maps each tool to its model-facing contract,
    /// with the template's `name`/`description`/`parameters` keys.
    #[test]
    fn tools_section_wire_shape() {
        use pa_agent::types::{AgentTool, AgentToolResult};
        struct EchoTool {
            schema: serde_json::Value,
        }
        impl AgentTool for EchoTool {
            fn name(&self) -> &'static str {
                "echo"
            }
            fn description(&self) -> &'static str {
                "Echoes input."
            }
            fn parameters(&self) -> &serde_json::Value {
                &self.schema
            }
            fn execute(
                self: Arc<Self>,
                _id: String,
                _params: serde_json::Value,
                _signal: pa_agent::abort::AbortSignal,
                _on_update: pa_agent::types::AgentToolUpdateCallback,
            ) -> pa_agent::BoxFut<'static, anyhow::Result<AgentToolResult>> {
                unreachable!("no test executes the export registry")
            }
        }
        let tools: Vec<Arc<dyn AgentTool>> = vec![Arc::new(EchoTool {
            schema: serde_json::json!({
                "type": "object",
                "required": ["text"],
                "properties": { "text": { "type": "string" } },
            }),
        })];
        let section = tools_section(&tools);
        assert_eq!(
            serde_json::to_value(&section).unwrap(),
            serde_json::json!([{
                "name": "echo",
                "description": "Echoes input.",
                "parameters": {
                    "type": "object",
                    "required": ["text"],
                    "properties": { "text": { "type": "string" } },
                },
            }])
        );
    }

    /// The export data shape serializes with the template's wire keys
    /// (camelCase, header/entries/leafId order).
    #[test]
    fn export_data_wire_keys() {
        let data = SessionExportData {
            header: serde_json::json!({"type": "session", "id": "s"}),
            entries: vec![],
            leaf_id: None,
            system_prompt: Some("the prompt".to_string()),
            tools: None,
            rendered_tools: None,
        };
        let raw = serde_json::to_string(&data).expect("serialize");
        assert!(raw.contains("\"systemPrompt\":\"the prompt\""));
        assert!(raw.contains("\"leafId\":null"));
        // Absent optional sections are omitted, not null (TS JSON.stringify).
        assert!(!raw.contains("renderedTools"));
        assert!(!raw.contains("\"tools\""));
    }
}

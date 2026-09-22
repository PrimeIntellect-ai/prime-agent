//! The custom-tool pre-render step of the HTML export: walks the export
//! entries and pre-renders every tool call/result whose tool is not one
//! of the template-rendered tools, through the caller's renderer seam.
//! The renderer (the session layer, like the TS `createToolHtmlRenderer`)
//! produces the tool's line-oriented representation; ANSI styling
//! converts to HTML here, at the export step.

use serde::Serialize;
use serde_json::{Map, Value};

/// Tools the export template renders natively (its `bash`/`edit` cards);
/// their calls and results never go through the pre-render.
pub const TEMPLATE_RENDERED_TOOLS: [&str; 2] = ["bash", "edit"];

/// Pre-rendered HTML for one custom tool call and result: the export
/// data's `renderedTools` entry (template.js reads these keys).
#[derive(Debug, Default, Clone, Serialize, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RenderedToolHtml {
    /// The tool-call header row.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub call_html: Option<String>,
    /// The collapsed tool-output preview (present when it differs from the
    /// expanded render; TS drops a `collapsed === expanded` duplicate).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub result_html_collapsed: Option<String>,
    /// The full tool-output render.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub result_html_expanded: Option<String>,
}

/// A renderer's collapsed/expanded result pair; `None` sections are
/// omitted (the TS `undefined` values `JSON.stringify` drops).
#[derive(Debug, Clone)]
pub struct RenderedToolResult {
    pub collapsed: Option<String>,
    pub expanded: Option<String>,
}

/// The render seam for custom tools in the export: resolves the tool and
/// renders its call/result to styled HTML (implementers convert their
/// line-oriented output with [`ansi_lines_to_html`]). Mirrors the TS
/// `ToolHtmlRenderer` the session builds at export time: `None` means the
/// tool has no custom renderer and the export falls back to the
/// template's generic tool rendering.
pub trait ToolHtmlRenderer {
    /// Render a tool call to HTML.
    fn render_call(&self, tool_call_id: &str, tool_name: &str, args: &Value) -> Option<String>;
    /// Render a tool result to collapsed/expanded HTML.
    fn render_result(
        &self,
        tool_call_id: &str,
        tool_name: &str,
        result: &[Value],
        details: &Value,
        is_error: bool,
    ) -> Option<RenderedToolResult>;
}

/// A message content array guard for entries without one.
const NO_BLOCKS: &[Value] = &[];

/// Whether a rendered line is blank once SGR sequences strip away (the
/// TS `isBlankRenderedLine`; only SGR escapes count, other control bytes
/// are visible content).
fn is_blank_rendered_line(line: &str) -> bool {
    let mut plain = String::with_capacity(line.len());
    let mut rest = line;
    while let Some(start) = rest.find('\x1b') {
        let after = &rest[start + 1..];
        let is_sgr = after.starts_with('[') && {
            let params = &after[1..];
            match params.find(|c: char| !c.is_ascii_digit() && c != ';') {
                Some(idx) => params.as_bytes()[idx] == b'm',
                None => false,
            }
        };
        plain.push_str(&rest[..start]);
        if is_sgr {
            // Consume the whole SGR sequence.
            let params_len = after[1..]
                .find(|c: char| !c.is_ascii_digit() && c != ';')
                .unwrap_or(after[1..].len());
            rest = &rest[start + 2 + params_len + 1..];
        } else {
            plain.push('\x1b');
            rest = &rest[start + 1..];
        }
    }
    plain.push_str(rest);
    plain.trim().is_empty()
}

/// Trim leading/trailing blank lines from a rendered result (the TS
/// `trimRenderedResultLines`).
pub fn trim_rendered_result_lines(lines: &[String]) -> &[String] {
    let mut start = 0;
    let mut end = lines.len();
    while start < end && is_blank_rendered_line(&lines[start]) {
        start += 1;
    }
    while end > start && is_blank_rendered_line(&lines[end - 1]) {
        end -= 1;
    }
    &lines[start..end]
}

/// Walk the export entries and pre-render custom-tool calls/results
/// through `renderer`, keyed by tool-call id (the TS
/// `preRenderCustomTools`): assistant `toolCall` blocks outside
/// [`TEMPLATE_RENDERED_TOOLS`] render their call; `toolResult` messages
/// for tools outside that set (or with a pre-rendered call) render their
/// result, merged onto any existing entry.
///
/// `None` when nothing rendered — the export omits the section entirely
/// (the TS exporter drops an empty map to `undefined`).
pub fn pre_render_custom_tools(
    entries: &[Value],
    renderer: &dyn ToolHtmlRenderer,
) -> Option<Value> {
    let mut rendered: Map<String, Value> = Map::new();
    for entry in entries {
        let Some(message) = entry.get("message") else {
            continue;
        };
        let blocks = message
            .get("content")
            .and_then(Value::as_array)
            .map(|blocks| blocks.as_slice())
            .unwrap_or(NO_BLOCKS);
        let role = message.get("role").and_then(Value::as_str);
        if role == Some("assistant") {
            for block in blocks {
                if block.get("type").and_then(Value::as_str) != Some("toolCall") {
                    continue;
                }
                let (Some(id), Some(name)) = (
                    block.get("id").and_then(Value::as_str),
                    block.get("name").and_then(Value::as_str),
                ) else {
                    continue;
                };
                if TEMPLATE_RENDERED_TOOLS.contains(&name) {
                    continue;
                }
                let no_args = Value::Null;
                let args = block.get("arguments").unwrap_or(&no_args);
                // A render failure skips the entry, like the TS
                // `try { } catch { return undefined }` around the renderer.
                if let Some(call_html) = renderer.render_call(id, name, args) {
                    let tool_html = RenderedToolHtml {
                        call_html: Some(call_html),
                        ..RenderedToolHtml::default()
                    };
                    rendered.insert(id.to_string(), serde_json::to_value(tool_html).ok()?);
                }
            }
        }
        if role == Some("toolResult") {
            let Some(tool_call_id) = message.get("toolCallId").and_then(Value::as_str) else {
                continue;
            };
            let tool_name = message
                .get("toolName")
                .and_then(Value::as_str)
                .unwrap_or_default();
            // TS: `existing || !TEMPLATE_RENDERED_TOOLS.has(toolName)` — a
            // template-rendered tool only renders when its call already did
            // (e.g. an extension overriding the name).
            let existing = rendered.get(tool_call_id).cloned();
            if existing.is_none() && TEMPLATE_RENDERED_TOOLS.contains(&tool_name) {
                continue;
            }
            let result: Vec<Value> = message
                .get("content")
                .and_then(Value::as_array)
                .cloned()
                .unwrap_or_default();
            let no_details = Value::Null;
            let details = message.get("details").unwrap_or(&no_details);
            let is_error = message
                .get("isError")
                .and_then(Value::as_bool)
                .unwrap_or(false);
            if let Some(rendered_result) =
                renderer.render_result(tool_call_id, tool_name, &result, details, is_error)
            {
                // Merge onto the existing entry (TS spreads `...existing`),
                // replacing the result sections.
                let mut merged = existing
                    .and_then(|value| serde_json::from_value::<RenderedToolHtml>(value).ok())
                    .unwrap_or_default();
                merged.result_html_collapsed = rendered_result.collapsed;
                merged.result_html_expanded = rendered_result.expanded;
                rendered.insert(tool_call_id.to_string(), serde_json::to_value(merged).ok()?);
            }
        }
    }
    if rendered.is_empty() {
        None
    } else {
        Some(Value::Object(rendered))
    }
}

#[cfg(test)]
mod tests {
    use super::super::ansi_to_html::ansi_lines_to_html;
    use super::*;
    use serde_json::json;

    /// A test renderer: renders ANSI-styled call/result HTML for tools
    /// whose name starts with `custom`, both through
    /// [`ansi_lines_to_html`]; nothing for anything else.
    struct TestRenderer;

    fn call_row(tool_call_id: &str, name: &str) -> String {
        ansi_lines_to_html(&[format!("\x1b[1m{name}\x1b[0m {tool_call_id}")])
    }

    fn result_rows(text: &str, expanded_extra: Option<&str>) -> RenderedToolResult {
        let collapsed = ansi_lines_to_html(&[text.to_string()]);
        let mut lines = vec![text.to_string()];
        lines.extend(expanded_extra.map(str::to_string));
        RenderedToolResult {
            collapsed: Some(collapsed),
            expanded: Some(ansi_lines_to_html(&lines)),
        }
    }

    impl ToolHtmlRenderer for TestRenderer {
        fn render_call(&self, id: &str, name: &str, _args: &Value) -> Option<String> {
            name.starts_with("custom").then(|| call_row(id, name))
        }

        fn render_result(
            &self,
            _id: &str,
            name: &str,
            _result: &[Value],
            _details: &Value,
            _is_error: bool,
        ) -> Option<RenderedToolResult> {
            if !name.starts_with("custom") {
                return None;
            }
            Some(result_rows("output", Some("more detail")))
        }
    }

    fn tool_call(id: &str, name: &str) -> Value {
        json!({
            "type": "message",
            "id": format!("m-{id}"),
            "message": {
                "role": "assistant",
                "content": [{ "type": "toolCall", "id": id, "name": name,
                              "arguments": { "query": "x" } }],
            },
        })
    }

    fn tool_result(id: &str, name: &str) -> Value {
        json!({
            "type": "message",
            "id": format!("r-{id}"),
            "message": {
                "role": "toolResult",
                "toolCallId": id,
                "toolName": name,
                "content": [{ "type": "text", "text": "output" }],
                "isError": false,
            },
        })
    }

    /// A custom tool's call and result pre-render, keyed by tool-call id,
    /// with the merged call/result sections.
    #[test]
    fn renders_custom_call_and_result() {
        let entries = vec![
            tool_call("tc1", "custom_tool"),
            tool_result("tc1", "custom_tool"),
        ];
        let rendered =
            pre_render_custom_tools(&entries, &TestRenderer).expect("custom tool renders");
        let entry = &rendered["tc1"];
        assert_eq!(
            entry["callHtml"],
            "<div class=\"ansi-line\"><span style=\"font-weight:bold\">custom_tool</span> tc1</div>"
        );
        assert!(entry["resultHtmlCollapsed"]
            .as_str()
            .is_some_and(|html| html.contains("output")));
        assert!(entry["resultHtmlExpanded"]
            .as_str()
            .is_some_and(|html| html.contains("more detail")));
    }

    /// Template-rendered tools never pre-render; a call for them leaves
    /// the map empty so the export omits the section.
    #[test]
    fn template_tools_and_empty_map_omit_the_section() {
        let entries = vec![
            tool_call("t1", "bash"),
            tool_result("t1", "bash"),
            tool_call("t2", "edit"),
        ];
        assert_eq!(pre_render_custom_tools(&entries, &TestRenderer), None);
        // A message without tool blocks changes nothing.
        let plain = vec![json!({
            "type": "message",
            "message": { "role": "assistant", "content": [{ "type": "text", "text": "hi" }] },
        })];
        assert_eq!(pre_render_custom_tools(&plain, &TestRenderer), None);
    }

    /// A tool result without a call still renders its sections (the
    /// entry has no `callHtml`).
    #[test]
    fn result_without_call() {
        let entries = vec![tool_result("tc9", "custom_tool")];
        let rendered = pre_render_custom_tools(&entries, &TestRenderer).expect("renders");
        assert!(rendered["tc9"].get("callHtml").is_none());
        assert!(rendered["tc9"]["resultHtmlExpanded"].is_string());
    }

    /// Blank leading/trailing lines trim away before conversion (the TS
    /// `trimRenderedResultLines` behavior sits with the renderer; the
    /// helper is the shared piece).
    #[test]
    fn blank_lines_trim() {
        let lines = vec![
            "  \x1b[0m  ".to_string(),
            "content".to_string(),
            String::new(),
        ];
        assert_eq!(trim_rendered_result_lines(&lines), &["content".to_string()]);
        // Non-SGR control bytes are visible content, not blankness.
        let cursor = vec!["\x1b[2J".to_string()];
        assert_eq!(trim_rendered_result_lines(&cursor), &cursor[..1]);
    }
}

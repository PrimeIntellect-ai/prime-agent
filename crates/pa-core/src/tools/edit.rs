//! The `edit` tool: exact text replacement in a single file.
//!
//! Port of `packages/coding-agent/src/core/tools/edit.ts` (TUI preview
//! renderers excluded; the execution and model-facing contract is identical).

use std::sync::Arc;

use crate::tools::edit_diff::{
    apply_edits_to_normalized_content, detect_line_ending, generate_diff_string_default,
    normalize_to_lf, restore_line_endings, strip_bom, Edit,
};
use crate::tools::file_mutation_queue::with_file_mutation_queue;
use crate::tools::path_utils::resolve_to_cwd;
use crate::tools::tool_definition::{ToolContentBlock, ToolDefinition, ToolExecutionResult};
use serde_json::json;

pub fn edit_tool_schema() -> serde_json::Value {
    json!({
        "type": "object",
        "required": ["path", "edits"],
        "properties": {
            "path": {
                "type": "string",
                "description": "Path to the file to edit (relative or absolute)"
            },
            "edits": {
                "type": "array",
                "items": {
                    "type": "object",
                    "required": ["oldText", "newText"],
                    "properties": {
                        "oldText": {
                            "type": "string",
                            "description": "Exact text for one targeted replacement. It must be unique in the original file and must not overlap with any other edits[].oldText in the same call."
                        },
                        "newText": {
                            "type": "string",
                            "description": "Replacement text for this targeted edit."
                        }
                    },
                    "additionalProperties": false
                },
                "description": "One or more targeted replacements. Each edit is matched against the original file, not incrementally. Do not include overlapping or nested edits. If two changes touch the same block or nearby lines, merge them into one edit instead."
            }
        },
        "additionalProperties": false
    })
}

pub fn edit_tool_description() -> &'static str {
    "Edit a single file using exact text replacement. Every edits[].oldText must match a unique, non-overlapping region of the original file. If two changes affect the same block or nearby lines, merge them into one edit instead of emitting overlapping edits. Do not include large unchanged regions just to connect distant changes."
}

/// Detailed result metadata: unified diff plus first changed line.
pub fn edit_tool_details(diff: &str, first_changed_line: Option<usize>) -> serde_json::Value {
    let mut details = json!({ "diff": diff });
    if let Some(line) = first_changed_line {
        details["firstChangedLine"] = json!(line);
    }
    details
}

/// Pluggable file operations for the edit tool (TS: `EditOperations`).
///
/// The default is the local filesystem; override to delegate to remote
/// systems. Error messages must match Node `fs/promises` shapes (see the
/// local impl) because they surface verbatim to the model.
///
/// Object-safe on purpose (`&dyn` injection without generics).
pub trait EditOperations: Send + Sync {
    /// Read file contents, matching Node `fs/promises` error messages.
    fn read_file(&self, absolute_path: &str) -> std::io::Result<Vec<u8>>;
    /// Write content as UTF-8.
    fn write_file(&self, absolute_path: &str, content: &str) -> std::io::Result<()>;
    /// Check the file is readable and writable; error code mirrors Node `access`.
    fn access(&self, absolute_path: &str) -> std::io::Result<()>;
}

pub struct LocalEditOperations;

impl EditOperations for LocalEditOperations {
    fn read_file(&self, absolute_path: &str) -> std::io::Result<Vec<u8>> {
        std::fs::read(absolute_path)
    }

    fn write_file(&self, absolute_path: &str, content: &str) -> std::io::Result<()> {
        std::fs::write(absolute_path, content)
    }

    fn access(&self, absolute_path: &str) -> std::io::Result<()> {
        // Mirror Node fs.access(path, R_OK | W_OK).
        let path = std::path::Path::new(absolute_path);
        if crate::platform::perms::is_readable_writable(path) {
            Ok(())
        } else {
            Err(std::io::Error::last_os_error())
        }
    }
}

/// Normalize tool arguments (TS: `prepareEditArguments`):
/// - `edits` sent as a JSON string is parsed into an array.
/// - Legacy top-level `oldText`/`newText` is appended to `edits`.
pub fn prepare_edit_arguments(mut input: serde_json::Value) -> serde_json::Value {
    let Some(obj) = input.as_object_mut() else {
        return input;
    };

    if let Some(edits) = obj.get("edits") {
        if edits.is_string() {
            if let Some(parsed) = serde_json::from_str::<serde_json::Value>(edits.as_str().unwrap())
                .ok()
                .filter(serde_json::Value::is_array)
            {
                obj.insert("edits".to_string(), parsed);
            }
        }
    }

    let legacy_old = obj
        .get("oldText")
        .and_then(serde_json::Value::as_str)
        .map(str::to_string);
    let legacy_new = obj
        .get("newText")
        .and_then(serde_json::Value::as_str)
        .map(str::to_string);
    let (Some(old_text), Some(new_text)) = (legacy_old, legacy_new) else {
        return input;
    };

    let mut edits: Vec<serde_json::Value> = match obj.get("edits") {
        Some(serde_json::Value::Array(arr)) => arr.clone(),
        _ => Vec::new(),
    };
    edits.push(json!({ "oldText": old_text, "newText": new_text }));
    obj.remove("oldText");
    obj.remove("newText");
    obj.insert("edits".to_string(), serde_json::Value::Array(edits));
    input
}

fn validate_edit_input(input: &serde_json::Value) -> anyhow::Result<(String, Vec<Edit>)> {
    let path = input
        .get("path")
        .and_then(serde_json::Value::as_str)
        .ok_or_else(|| {
            anyhow::anyhow!(
                "Edit tool input is invalid. edits must contain at least one replacement."
            )
        })?
        .to_string();
    let edits = input
        .get("edits")
        .and_then(serde_json::Value::as_array)
        .ok_or_else(|| {
            anyhow::anyhow!(
                "Edit tool input is invalid. edits must contain at least one replacement."
            )
        })?;
    if edits.is_empty() {
        return Err(anyhow::anyhow!(
            "Edit tool input is invalid. edits must contain at least one replacement."
        ));
    }
    let edits: Vec<Edit> = edits
        .iter()
        .map(|e| Edit {
            old_text: e
                .get("oldText")
                .and_then(serde_json::Value::as_str)
                .unwrap_or("")
                .to_string(),
            new_text: e
                .get("newText")
                .and_then(serde_json::Value::as_str)
                .unwrap_or("")
                .to_string(),
        })
        .collect();
    Ok((path, edits))
}

/// Node-style error message for a failed read of the edited file.
fn read_error_message(err: &std::io::Error, absolute_path: &str) -> String {
    if err.kind() == std::io::ErrorKind::IsADirectory {
        // Node fs/promises.readFile on a directory reports the read syscall.
        return "EISDIR: illegal operation on a directory, read".to_string();
    }
    let code = crate::tools::edit_diff::errno_name(err);
    let reason = match code.as_str() {
        "ENOENT" => "no such file or directory",
        "EACCES" => "permission denied",
        "ENOTDIR" => "not a directory",
        "ELOOP" => "too many levels of symbolic links",
        "EISDIR" => "illegal operation on a directory",
        "EROFS" => "read-only file system",
        _ => return format!("Error code: {code}."),
    };
    format!("{code}: {reason}, open '{absolute_path}'")
}

/// Run the edit tool against the given filesystem operations.
///
/// Returns the model-facing result, or an error whose message is the
/// model-facing error text (TS: the thrown error).
#[tracing::instrument(
    level = "debug",
    name = "tool_edit_execute",
    skip(cwd, ops, signal)
    fields(path),
)]
pub async fn execute_edit(
    cwd: &str,
    ops: &dyn EditOperations,
    input: &serde_json::Value,
    signal: Option<crate::tools::tool_definition::AbortSignal>,
) -> anyhow::Result<ToolExecutionResult> {
    let (path, edits) = validate_edit_input(input)?;
    let absolute_path = resolve_to_cwd(&path, cwd);

    let path_for_task = path.clone();
    let edits_for_task = edits.clone();
    let input_path = absolute_path.clone();

    with_file_mutation_queue(&absolute_path, || {
        execute_edit_locked(
            &path_for_task,
            &input_path,
            ops,
            &edits_for_task,
            signal.clone(),
        )
    })
    .await
}

async fn execute_edit_locked(
    path: &str,
    absolute_path: &str,
    ops: &dyn EditOperations,
    edits: &[Edit],
    signal: Option<crate::tools::tool_definition::AbortSignal>,
) -> anyhow::Result<ToolExecutionResult> {
    if let Some(signal) = &signal {
        if signal.is_cancelled() {
            return Err(anyhow::anyhow!("Operation aborted"));
        }
    }
    if let Err(err) = ops.access(absolute_path) {
        let code = crate::tools::edit_diff::errno_name(&err);
        return Err(anyhow::anyhow!(
            "Could not edit file: {path}. Error code: {code}."
        ));
    }
    if let Some(signal) = &signal {
        if signal.is_cancelled() {
            return Err(anyhow::anyhow!("Operation aborted"));
        }
    }

    let raw = ops
        .read_file(absolute_path)
        .map_err(|err| anyhow::anyhow!("{}", read_error_message(&err, absolute_path)))?;
    let raw_content = String::from_utf8_lossy(&raw).into_owned();

    // Strip BOM before matching: the model will not include an invisible BOM.
    let (bom, content) = strip_bom(&raw_content);
    let original_ending = detect_line_ending(content);
    let normalized_content = normalize_to_lf(content);
    let applied = apply_edits_to_normalized_content(&normalized_content, edits, path)
        .map_err(anyhow::Error::msg)?;

    let final_content = format!(
        "{}{}",
        bom,
        restore_line_endings(&applied.new_content, original_ending)
    );
    ops.write_file(absolute_path, &final_content)
        .map_err(|err| {
            anyhow::anyhow!("Error code: {}.", crate::tools::edit_diff::errno_name(&err))
        })?;

    let diff = generate_diff_string_default(&applied.base_content, &applied.new_content);
    let details = edit_tool_details(&diff.diff, diff.first_changed_line);

    Ok(ToolExecutionResult {
        content: vec![ToolContentBlock::text(format!(
            "Successfully replaced {} block(s) in {path}.",
            edits.len()
        ))],
        details: Some(details),
        is_error: false,
    })
}

/// The `edit` tool definition: exact name, schema, and description.
pub fn create_edit_tool_definition(cwd: &str) -> ToolDefinition {
    let cwd = cwd.to_string();
    let execute: crate::tools::tool_definition::ExecuteFn = {
        Arc::new(move |_tool_call_id, params, signal, _on_update| {
            let cwd = cwd.clone();
            Box::pin(async move { execute_edit(&cwd, &LocalEditOperations, &params, signal).await })
        })
    };
    ToolDefinition {
        name: "edit".to_string(),
        label: "edit".to_string(),
        description: edit_tool_description().to_string(),
        prompt_snippet: "Make precise file edits with exact text replacement, including multiple disjoint edits in one call".to_string(),
        parameters: edit_tool_schema(),
        execution_mode: None,
        prepare_arguments: Some(prepare_edit_arguments),
        execute,
    }
}

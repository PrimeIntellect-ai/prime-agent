//! Golden differential tests: replay the corpus recorded from the REAL
//! TypeScript tools (see `tests/golden/harness.mjs`) against the Rust port
//! and assert identical model-facing output.
//!
//! Corpus cases cover fuzzy edits, file-not-found, bash timeouts and
//! truncation boundaries, destructive-git refusals, ipython result
//! composition, and the exact tool schemas.

#![cfg(test)]
use std::path::Path;
use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::{Arc, Mutex};

use crate::tools::bash::{self, BashToolOptions};
use crate::tools::code_preview::preview_bash_command;
use crate::tools::code_preview_python::preview_ipython_code;
use crate::tools::edit::{create_edit_tool_definition, execute_edit, LocalEditOperations};
use crate::tools::ipython::{
    self, ExecuteResult, ExecuteStatus, IpythonKernelProvisioner, IpythonToolOptions,
    IpythonToolUi, KernelAttachment, KernelBusyAfterInterruptError, KernelErrorInfo,
    KernelExecError, KernelExecuteOptions, KernelExecutor,
};
use crate::tools::tool_definition::ToolDefinition;
use crate::tools::truncate::{truncate_head, truncate_tail, TruncationOptions};

const CORPUS_DIR: &str = concat!(env!("CARGO_MANIFEST_DIR"), "/tests/golden/corpus");

fn corpus(name: &str) -> serde_json::Value {
    let path = Path::new(CORPUS_DIR).join(format!("{name}.json"));
    serde_json::from_str(&std::fs::read_to_string(path).expect("corpus file")).expect("corpus JSON")
}

/// Normalize temp paths the same way harness.mjs does.
fn norm_string(s: &str, tmp: &str) -> String {
    let out = s.replace(&format!("{tmp}/"), "<TMP>/");
    let re = regex_lite("golden-[A-Za-z0-9_]{6}");
    let out = re.replace_all(&out, "golden-<ID>").into_owned();
    let re = regex_lite(r"pi-(?:bash|output)-[0-9a-f]+\.log");
    let out = re.replace_all(&out, "pi-<ID>.log").into_owned();
    let re = regex_lite(r"tmp-stdout-[0-9A-Za-z_]+");
    re.replace_all(&out, "tmp-stdout-<ID>").into_owned()
}

/// Deep-normalize all strings in a JSON value.
fn deep_norm(value: serde_json::Value, tmp: &str) -> serde_json::Value {
    match value {
        serde_json::Value::String(s) => serde_json::Value::String(norm_string(&s, tmp)),
        serde_json::Value::Array(items) => {
            serde_json::Value::Array(items.into_iter().map(|v| deep_norm(v, tmp)).collect())
        }
        serde_json::Value::Object(map) => serde_json::Value::Object(
            map.into_iter()
                .map(|(k, v)| (k, deep_norm(v, tmp)))
                .collect(),
        ),
        other => other,
    }
}

fn tmp_root() -> &'static str {
    static TMP: std::sync::OnceLock<String> = std::sync::OnceLock::new();
    TMP.get_or_init(|| {
        std::env::temp_dir()
            .to_str()
            .expect("utf-8 tmpdir")
            .trim_end_matches('/')
            .to_string()
    })
}

fn regex_lite(pattern: &str) -> fancy_regex::Regex {
    fancy_regex::Regex::new(pattern).expect("normalization regex")
}

/// Fixture setup: files + fixture commands, in a fresh temp dir.
fn make_fixture(case: &serde_json::Value) -> (tempfile::TempDir, String) {
    let dir = tempfile::Builder::new()
        .prefix("golden-")
        .tempdir()
        .expect("tempdir");
    if let Some(files) = case.get("files").and_then(serde_json::Value::as_object) {
        for (name, content) in files {
            let path = dir.path().join(name);
            if let Some(parent) = path.parent() {
                std::fs::create_dir_all(parent).expect("mkdir");
            }
            std::fs::write(&path, content.as_str().expect("file content is a string"))
                .expect("write fixture file");
        }
    }
    if let Some(commands) = case.get("fixture").and_then(serde_json::Value::as_array) {
        for command in commands {
            let command = command.as_str().expect("fixture command");
            let status = std::process::Command::new("/bin/bash")
                .arg("-c")
                .arg(command)
                .current_dir(dir.path())
                .status()
                .expect("run fixture command");
            assert!(status.success(), "fixture command failed: {command}");
        }
    }
    let dir_path = dir.path().to_string_lossy().into_owned();
    (dir, dir_path)
}

fn truncation_json(result: &crate::tools::truncate::TruncationResult) -> serde_json::Value {
    bash::truncation_to_json(result)
}

fn assert_json_eq(actual: serde_json::Value, expected: serde_json::Value, what: &str) {
    if actual != expected {
        panic!("{what} mismatch\nexpected: {expected}\n  actual: {actual}");
    }
}

// ---------------------------------------------------------------------------

#[tokio::test]
async fn golden_edit_group_matches_ts() {
    let corpus = corpus("edit");
    let mut checked = 0;
    for case in corpus["cases"].as_array().expect("cases array") {
        let name = case["name"].as_str().expect("name");
        let (dir, dir_path) = make_fixture(case);
        let mut input = case["input"].clone();
        if case["applyPrepareArguments"].as_bool().unwrap_or(false) {
            input = crate::tools::edit::prepare_edit_arguments(input);
            // The TS harness records the prepared input for such cases.
            assert_json_eq(
                input.clone(),
                case["preparedInput"].clone(),
                "edit/{name} preparedInput",
            );
        }
        let result = execute_edit(&dir_path, &LocalEditOperations, &input, None).await;
        let recorded = &case["result"];
        match result {
            Ok(result) => {
                assert!(
                    recorded["ok"].as_bool().expect("ok"),
                    "edit/{name}: TS failed, Rust succeeded"
                );
                let text = result.content[0].as_text().expect("text block").to_string();
                assert_eq!(
                    text,
                    recorded["text"].as_str().expect("text"),
                    "edit/{name} text"
                );
                let details = deep_norm(result.details.clone().unwrap_or_default(), tmp_root());
                let recorded_details = recorded["details"].clone();
                if recorded_details.is_null() {
                    assert!(result.details.is_none(), "edit/{name} unexpected details");
                } else {
                    assert_json_eq(details, recorded_details, "edit/{name} details");
                }
            }
            Err(err) => {
                assert!(
                    !recorded["ok"].as_bool().expect("ok"),
                    "edit/{name}: TS succeeded, Rust failed: {err}"
                );
                assert_eq!(
                    err.to_string(),
                    recorded["error"].as_str().expect("error"),
                    "edit/{name} error"
                );
            }
        }
        // Final file content must match too.
        let path = case["input"]["path"].as_str().expect("path");
        match std::fs::read(dir.path().join(path)) {
            Ok(bytes) => {
                let content = String::from_utf8_lossy(&bytes).into_owned();
                let recorded = case["finalContent"].as_str().expect("finalContent");
                assert_eq!(content, recorded, "edit/{name} finalContent");
            }
            Err(_) => assert!(case["finalContent"].is_null(), "edit/{name} finalContent"),
        }
        checked += 1;
    }
    assert_eq!(checked, corpus["caseCount"].as_u64().expect("caseCount"));
}

// ---------------------------------------------------------------------------

#[tokio::test]
async fn golden_bash_group_matches_ts() {
    let corpus = corpus("bash");
    let cases = corpus["cases"].as_array().expect("cases array").clone();
    // All bash cases run sequentially in one task: the env-bypass case mutates
    // process env (get_shell_env inherits it) and must not race other cases.
    let mut checked = 0;
    for case in &cases {
        let name = case["name"].as_str().expect("name");
        if case.get("cwdIsDeleted").is_some() {
            let (dir, dir_path) = make_fixture(case);
            drop(dir);
            std::fs::remove_dir_all(&dir_path).ok();
            let result = bash::execute_bash(
                &dir_path,
                &BashToolOptions::default(),
                case["command"].as_str().expect("command"),
                case.get("timeout").and_then(serde_json::Value::as_f64),
                case.get("allowDestructiveGit")
                    .and_then(serde_json::Value::as_bool),
                None,
                None,
            )
            .await;
            let err = result.expect_err("cwd-missing must fail");
            assert_eq!(
                err.to_string(),
                format!(
                    "Working directory does not exist: {dir_path}\nCannot execute bash commands."
                ),
                "bash/{name}"
            );
            checked += 1;
            continue;
        }
        let (dir, dir_path) = make_fixture(case);
        if case
            .get("envBypass")
            .and_then(serde_json::Value::as_bool)
            .unwrap_or(false)
        {
            std::env::set_var("PI_BASH_ALLOW_DESTRUCTIVE_GIT", "1");
        }
        let result = bash::execute_bash(
            &dir_path,
            &BashToolOptions::default(),
            case["command"].as_str().expect("command"),
            case.get("timeout").and_then(serde_json::Value::as_f64),
            case.get("allowDestructiveGit")
                .and_then(serde_json::Value::as_bool),
            None,
            None,
        )
        .await;
        if case.get("envBypass").is_some() {
            std::env::remove_var("PI_BASH_ALLOW_DESTRUCTIVE_GIT");
        }
        let recorded = &case["result"];
        match result {
            Ok(result) => {
                assert!(
                    recorded["ok"].as_bool().expect("ok"),
                    "bash/{name}: TS failed, Rust succeeded"
                );
                let text =
                    norm_string(result.content[0].as_text().expect("text block"), tmp_root());
                let expected_text = recorded["text"].as_str().expect("text");
                if text != expected_text {
                    // Stdout/stderr interleaving is OS-timing dependent in
                    // both implementations; the same multiset of lines is
                    // accepted, anything else is a mismatch.
                    let mut actual_lines: Vec<&str> = text.lines().collect();
                    let mut expected_lines: Vec<&str> = expected_text.lines().collect();
                    actual_lines.sort_unstable();
                    expected_lines.sort_unstable();
                    assert_eq!(
                        (actual_lines, name),
                        (expected_lines, name),
                        "bash/{name} text mismatch\nexpected: {expected_text}\n  actual: {text}"
                    );
                }
                let details = deep_norm(result.details.clone().unwrap_or_default(), tmp_root());
                let recorded_details = recorded["details"].clone();
                if recorded_details.is_null() {
                    assert!(result.details.is_none(), "bash/{name} unexpected details");
                } else {
                    assert_json_eq(details, recorded_details, "bash/{name} details");
                }
                // Truncated runs must advertise a real, non-empty full-output file.
                if let Some(record) = recorded.get("fullOutputFile") {
                    let raw_path = result
                        .details
                        .as_ref()
                        .and_then(|d| d.get("fullOutputPath"))
                        .and_then(serde_json::Value::as_str)
                        .map(str::to_string);
                    assert!(
                        record["exists"].as_bool().unwrap_or(false),
                        "bash/{name} full output file must exist"
                    );
                    let path = raw_path.expect("fullOutputPath present");
                    let bytes = std::fs::metadata(&path).expect("full output file").len();
                    assert!(bytes > 0, "bash/{name} full output file must be non-empty");
                    if let Some(recorded_bytes) = record["bytes"].as_u64() {
                        assert_eq!(bytes, recorded_bytes, "bash/{name} full output bytes");
                    }
                }
            }
            Err(err) => {
                assert!(
                    !recorded["ok"].as_bool().expect("ok"),
                    "bash/{name}: TS succeeded, Rust failed: {err}"
                );
                assert_eq!(
                    norm_string(&err.to_string(), tmp_root()),
                    norm_string(recorded["error"].as_str().expect("error"), tmp_root()),
                    "bash/{name} error"
                );
            }
        }
        drop(dir);
        checked += 1;
    }
    assert_eq!(checked, corpus["caseCount"].as_u64().expect("caseCount"));
}

// ---------------------------------------------------------------------------

#[test]
fn golden_truncate_group_matches_ts() {
    let corpus = corpus("truncate");
    let mut checked = 0;
    for case in corpus["cases"].as_array().expect("cases array") {
        let name = case["name"].as_str().expect("name");
        let content = case["content"].as_str().expect("content");
        let options = TruncationOptions::with_limits(
            case["maxLines"].as_u64().expect("maxLines") as usize,
            case["maxBytes"].as_u64().expect("maxBytes") as usize,
        );
        let head = truncate_head(content, options);
        let tail = truncate_tail(content, options);
        assert_json_eq(
            truncation_json(&head),
            case["head"].clone(),
            &format!("truncate/{name} head"),
        );
        assert_json_eq(
            truncation_json(&tail),
            case["tail"].clone(),
            &format!("truncate/{name} tail"),
        );
        checked += 1;
    }
    assert_eq!(checked, corpus["caseCount"].as_u64().expect("caseCount"));
}

#[test]
fn golden_preview_group_matches_ts() {
    let corpus = corpus("preview");
    let mut checked = 0;
    for case in corpus["cases"].as_array().expect("cases array") {
        let input = case["input"].as_str().expect("input");
        let language = |l: crate::tools::code_preview::CodePreviewLanguage| {
            serde_json::json!({
                "language": match l {
                    crate::tools::code_preview::CodePreviewLanguage::Bash => "bash",
                    crate::tools::code_preview::CodePreviewLanguage::Python => "python",
                },
            })
        };
        let preview = preview_bash_command(input);
        let actual = serde_json::json!({
            "language": language(preview.language)["language"],
            "text": preview.text,
        });
        assert_json_eq(actual, case["bash"].clone(), "preview bash");
        let preview = preview_ipython_code(input);
        let actual = serde_json::json!({
            "language": language(preview.language)["language"],
            "text": preview.text,
        });
        assert_json_eq(actual, case["ipython"].clone(), "preview ipython");
        checked += 1;
    }
    assert_eq!(checked, corpus["caseCount"].as_u64().expect("caseCount"));
}

// ---------------------------------------------------------------------------

struct MockKernel {
    executions: Mutex<Vec<MockOutcome>>,
    exec_calls: AtomicUsize,
    next_index: AtomicUsize,
}

#[derive(Clone)]
enum MockOutcome {
    Ok(Box<ExecuteResult>),
    Busy,
}

#[derive(Clone)]
struct ClonableKernel(Arc<MockKernel>);

impl KernelExecutor for ClonableKernel {
    fn execute(
        &self,
        code: &str,
        options: KernelExecuteOptions<'_>,
    ) -> std::pin::Pin<
        Box<dyn std::future::Future<Output = Result<ExecuteResult, KernelExecError>> + Send>,
    > {
        self.0.execute(code, options)
    }
}

impl MockKernel {
    fn clone_kernel(self: &Arc<Self>) -> ClonableKernel {
        ClonableKernel(self.clone())
    }
}

impl KernelExecutor for MockKernel {
    fn execute(
        &self,
        _code: &str,
        _options: KernelExecuteOptions<'_>,
    ) -> std::pin::Pin<
        Box<dyn std::future::Future<Output = Result<ExecuteResult, KernelExecError>> + Send>,
    > {
        self.exec_calls.fetch_add(1, Ordering::SeqCst);
        // TS harness: executions[min(i++, len-1)] — the last item repeats.
        let item = {
            let executions = self.executions.lock().unwrap();
            if executions.is_empty() {
                MockOutcome::Ok(Box::default())
            } else {
                let last = executions.len() - 1;
                executions[self.next_index.fetch_add(1, Ordering::SeqCst).min(last)].clone()
            }
        };
        let item = match item {
            MockOutcome::Ok(result) => Ok(*result),
            MockOutcome::Busy => Err(KernelExecError::BusyAfterInterrupt(
                KernelBusyAfterInterruptError::default(),
            )),
        };
        Box::pin(std::future::ready(item))
    }
}

struct MockProvisioner {
    kernel: Arc<MockKernel>,
    ensure_calls: AtomicUsize,
    kill_calls: AtomicUsize,
}

impl IpythonKernelProvisioner for MockProvisioner {
    fn ensure(
        &self,
        _on_progress: Option<std::sync::Arc<dyn Fn(&str) + Send + Sync>>,
        _signal: Option<crate::tools::tool_definition::AbortSignal>,
    ) -> std::pin::Pin<
        Box<dyn std::future::Future<Output = anyhow::Result<Box<dyn KernelExecutor>>> + Send>,
    > {
        self.ensure_calls.fetch_add(1, Ordering::SeqCst);
        let kernel = self.kernel.clone();
        let executor: Box<dyn KernelExecutor> = Box::new(kernel.clone_kernel());
        Box::pin(std::future::ready(Ok(executor)))
    }

    fn kill(&self) -> std::pin::Pin<Box<dyn std::future::Future<Output = ()> + Send>> {
        self.kill_calls.fetch_add(1, Ordering::SeqCst);
        Box::pin(std::future::ready(()))
    }
}

struct KillChoiceUi;

impl IpythonToolUi for KillChoiceUi {
    fn select(
        &self,
        _prompt: &str,
        choices: &[&str],
        _signal: Option<&crate::tools::tool_definition::AbortSignal>,
    ) -> std::pin::Pin<Box<dyn std::future::Future<Output = Option<String>> + Send>> {
        let choice = choices
            .iter()
            .find(|c| **c == ipython::BUSY_KERNEL_KILL_CHOICE)
            .map(std::string::ToString::to_string);
        Box::pin(std::future::ready(choice))
    }

    fn set_working_message(&self, _message: Option<&str>) {}
}

fn mock_execution(entry: &serde_json::Value) -> MockOutcome {
    if entry.get("thrown").is_some() {
        return MockOutcome::Busy;
    }
    let mut result = ExecuteResult {
        status: match entry["status"].as_str().unwrap_or("ok") {
            "ok" => ExecuteStatus::Ok,
            "error" => ExecuteStatus::Error,
            "aborted" => ExecuteStatus::Aborted,
            other => panic!("unknown status {other}"),
        },
        stdout: entry["stdout"].as_str().unwrap_or("").to_string(),
        stderr: entry["stderr"].as_str().unwrap_or("").to_string(),
        result: entry
            .get("result")
            .and_then(serde_json::Value::as_str)
            .map(str::to_string),
        duration_ms: entry.get("durationMs").and_then(serde_json::Value::as_u64),
        background_output: entry
            .get("backgroundOutput")
            .and_then(serde_json::Value::as_str)
            .map(str::to_string),
        ..ExecuteResult::default()
    };
    if let Some(error) = entry.get("error") {
        result.error = Some(KernelErrorInfo {
            ename: error["ename"].as_str().unwrap_or("").to_string(),
            evalue: error["evalue"].as_str().unwrap_or("").to_string(),
            traceback: error["traceback"]
                .as_array()
                .map(|lines| {
                    lines
                        .iter()
                        .map(|l| l.as_str().unwrap_or("").to_string())
                        .collect()
                })
                .unwrap_or_default(),
        });
    }
    result.attachments = Vec::<KernelAttachment>::new();
    result.sent_agent_messages = entry["sentAgentMessages"]
        .as_array()
        .map(|rows| {
            rows.iter()
                .filter_map(crate::kernel::shared::parse_sent_agent_message)
                .collect()
        })
        .unwrap_or_default();
    MockOutcome::Ok(Box::new(result))
}

#[tokio::test]
async fn golden_ipython_group_matches_ts() {
    let corpus = corpus("ipython");
    let mut checked = 0;
    for case in corpus["cases"].as_array().expect("cases array") {
        let name = case["name"].as_str().expect("name");
        let executions: Vec<MockOutcome> = case["mockResults"]
            .as_array()
            .expect("mockResults")
            .iter()
            .map(mock_execution)
            .collect();
        let kernel = Arc::new(MockKernel {
            executions: Mutex::new(executions),
            exec_calls: AtomicUsize::new(0),
            next_index: AtomicUsize::new(0),
        });
        let provisioner = Arc::new(MockProvisioner {
            kernel: kernel.clone(),
            ensure_calls: AtomicUsize::new(0),
            kill_calls: AtomicUsize::new(0),
        });
        let options = IpythonToolOptions {
            provisioner: provisioner.clone(),
            ui: if case["ctxMode"].as_str() == Some("ui-kill") {
                Some(Arc::new(KillChoiceUi))
            } else {
                None
            },
        };
        let result =
            ipython::execute_ipython(&options, case["code"].as_str().expect("code"), None, None)
                .await;
        let recorded = &case["result"];
        match result {
            Ok(result) => {
                assert!(
                    recorded["ok"].as_bool().expect("ok"),
                    "ipython/{name}: TS failed, Rust succeeded"
                );
                assert_eq!(
                    result.is_error,
                    recorded["isError"].as_bool().expect("isError"),
                    "ipython/{name} isError"
                );
                let text = result.content[0].as_text().expect("text block");
                assert_eq!(
                    text,
                    recorded["outputText"].as_str().expect("outputText"),
                    "ipython/{name} outputText"
                );
            }
            Err(err) => {
                assert!(
                    !recorded["ok"].as_bool().expect("ok"),
                    "ipython/{name}: TS succeeded, Rust failed: {err}"
                );
                assert_eq!(
                    err.to_string(),
                    recorded["error"].as_str().expect("error"),
                    "ipython/{name} error"
                );
            }
        }
        let calls = serde_json::json!({
            "ensure": provisioner.ensure_calls.load(Ordering::SeqCst),
            "execute": kernel.exec_calls.load(Ordering::SeqCst),
            "kill": provisioner.kill_calls.load(Ordering::SeqCst),
        });
        assert_json_eq(
            calls,
            case["provisionerCalls"].clone(),
            "ipython/{name} calls",
        );
        checked += 1;
    }
    assert_eq!(checked, corpus["caseCount"].as_u64().expect("caseCount"));
}

// ---------------------------------------------------------------------------

#[test]
fn golden_schema_group_matches_ts() {
    let corpus = corpus("schema");
    let mut checked = 0;
    for case in corpus["cases"].as_array().expect("cases array") {
        let tool = case["tool"].as_str().expect("tool");
        let definition: ToolDefinition = match tool {
            "bash" => bash::create_bash_tool_definition("/tmp"),
            "edit" => create_edit_tool_definition("/tmp"),
            "ipython" => crate::tools::ipython::create_ipython_tool_definition(
                "/tmp",
                IpythonToolOptions {
                    provisioner: Arc::new(MockProvisioner {
                        kernel: Arc::new(MockKernel {
                            executions: Mutex::new(Vec::new()),
                            exec_calls: AtomicUsize::new(0),
                            next_index: AtomicUsize::new(0),
                        }),
                        ensure_calls: AtomicUsize::new(0),
                        kill_calls: AtomicUsize::new(0),
                    }),
                    ui: None,
                },
            ),
            other => panic!("unknown tool {other}"),
        };
        let mut actual = serde_json::json!({
            "tool": tool,
            "name": definition.name,
            "label": definition.label,
            "description": definition.description,
            "promptSnippet": definition.prompt_snippet,
        });
        if let Some(mode) = definition.execution_mode {
            actual["executionMode"] = serde_json::json!(match mode {
                crate::tools::tool_definition::ExecutionMode::Sequential => "sequential",
            });
        }
        actual["parameters"] = definition.parameters.clone();
        assert_json_eq(actual, case.clone(), "schema/{tool}");
        checked += 1;
    }
    assert_eq!(checked, corpus["caseCount"].as_u64().expect("caseCount"));
}

// ---------------------------------------------------------------------------
// Small direct checks of guard parsing (subsumed by the bash golden group).

#[test]
fn destructive_git_discard_detection_examples() {
    assert!(crate::tools::bash_guard::is_destructive_git_discard_command("git reset --hard"));
    assert!(crate::tools::bash_guard::is_destructive_git_discard_command("git checkout -- ."));
    assert!(crate::tools::bash_guard::is_destructive_git_discard_command("git clean -fd"));
    assert!(crate::tools::bash_guard::is_destructive_git_discard_command("git -C sub restore ."));
    assert!(
        !crate::tools::bash_guard::is_destructive_git_discard_command("echo 'git reset --hard'")
    );
    assert!(
        !crate::tools::bash_guard::is_destructive_git_discard_command(
            "echo done # git reset --hard"
        )
    );
    assert!(!crate::tools::bash_guard::is_destructive_git_discard_command("git status"));
    assert!(!crate::tools::bash_guard::is_destructive_git_discard_command("git clean -n"));
    assert!(
        !crate::tools::bash_guard::is_destructive_git_discard_command("git clean --dry-run -f")
    );
}

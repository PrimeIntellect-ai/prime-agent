//! Golden differential tests: replay the corpus recorded from the REAL
//! TypeScript tools (frozen in `tests/golden/corpus/`) against the Rust port
//! and assert identical model-facing output.
//!
//! Corpus cases cover ipython result composition and the exact tool schema.

#![cfg(test)]
use std::path::Path;
use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::{Arc, Mutex};

use crate::tools::ipython::{
    self, ExecuteResult, ExecuteStatus, IpythonKernelProvisioner, IpythonToolOptions,
    IpythonToolUi, KernelAttachment, KernelBusyAfterInterruptError, KernelErrorInfo,
    KernelExecError, KernelExecuteOptions, KernelExecutor,
};
use crate::tools::tool_definition::ToolDefinition;

const CORPUS_DIR: &str = concat!(env!("CARGO_MANIFEST_DIR"), "/tests/golden/corpus");

fn corpus(name: &str) -> serde_json::Value {
    let path = Path::new(CORPUS_DIR).join(format!("{name}.json"));
    serde_json::from_str(&std::fs::read_to_string(path).expect("corpus file")).expect("corpus JSON")
}

fn assert_json_eq(actual: &serde_json::Value, expected: &serde_json::Value, what: &str) {
    assert!(
        actual == expected,
        "{what} mismatch\nexpected: {expected}\n  actual: {actual}"
    );
}

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
            on_late_sent_agent_message: None,
        };
        let result = ipython::execute_ipython(
            &options,
            case["code"].as_str().expect("code"),
            None,
            None,
            None,
            None,
        )
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
            &calls,
            &case["provisionerCalls"].clone(),
            "ipython/{name} calls",
        );
        checked += 1;
    }
    assert_eq!(checked, corpus["caseCount"].as_u64().expect("caseCount"));
}

#[test]
fn golden_schema_group_matches_ts() {
    let corpus = corpus("schema");
    let mut checked = 0;
    for case in corpus["cases"].as_array().expect("cases array") {
        let tool = case["tool"].as_str().expect("tool");
        let definition: ToolDefinition = match tool {
            "ipython" => crate::tools::ipython::create_ipython_tool_definition(
                "/tmp",
                IpythonToolOptions {
                    on_late_sent_agent_message: None,
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
        assert_json_eq(&actual, &case.clone(), "schema/{tool}");
        checked += 1;
    }
    assert_eq!(checked, corpus["caseCount"].as_u64().expect("caseCount"));
}

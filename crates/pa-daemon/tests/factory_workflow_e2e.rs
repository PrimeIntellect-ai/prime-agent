//! End-to-end factory workflow tests over the real kernel bridge.
//!
//! Port of the TS-era `test/factory-workflow-e2e.test.ts` (#2485): the
//! python-side executor tests fake the kernel host, so they cannot catch
//! a daemon that never registered a host request, or a kernel payload
//! that drifted from the host handler's contract — the exact class of bug
//! a fake host passes silently. This suite closes that gap for the
//! factory stack: a real `pa-daemon` supervisor, real worker sessions
//! with real Python kernels, harness state seeded into the local
//! `harness_state.json` the kernels load through `RLM_HARNESS_STATE_DIR`,
//! and real child worker sessions spawned through the product
//! `rlm.spawn` host path (`rlm.run` -> supervisor child sessions) — with
//! scripted engines (no live model, no tokens).
//!
//! Deviations from the TS-era suite, both forced by seams this port owns:
//! - The scripted-engine seam serves one ordered response list per child
//!   session, so every child of one parent answers the same text; the
//!   loop scenario therefore closes on bounded re-entry (`max_entries`)
//!   rather than an approval switch, and its scenarios carry multi-key
//!   JSON answers (the executor's named-output parse binds each state's
//!   output from the same block). The optional-input re-binding — the
//!   heart of the TS loop scenario — is proven through the real bridge
//!   by reading the spawned children's prompts off disk: round 1 renders
//!   the null sentinel, round 2 renders the fixer's JSON report.
//! - The `factory.progress` notice-injection lane is deliberately
//!   unported from the factory core port (#3199; it arrives with the
//!   daemon notice-injection follow-up), so milestone notices stay in
//!   the ledger (the dead-bridge path) instead of waking the parent turn:
//!   this suite asserts exactly that contract, and the "finished notice
//!   arrives as its own wake" assertion lands with that follow-up.
//!
//! Kernel python: pinned by the shared resolver
//! (`PA_E2E_KERNEL_PYTHON` / the caller's `PRIME_AGENT_KERNEL_PYTHON`,
//! the checkout-local runtime venv, or the shared kernel venv with this
//! checkout's runtime source prepended on `PYTHONPATH`). A pinned python
//! is never rebuilt, so pinning keeps a dev checkout from rebuilding the
//! shared `~/.prime/agent/kernel-venv` that live sessions run on. When no
//! candidate probes factory-capable and a shared venv exists, the suite
//! refuses to boot (the venv recipe) instead of letting the standard
//! bootstrap rebuild it; with no shared venv at all (CI) the standard
//! bootstrap builds it from this checkout's runtime.
//!
//! Unix-only e2e (`AF_UNIX` sockets).
// Pedantic-gate dispositions (fleet-uniform ruling; see this lane's PR for
// the full rationale).
// Stack-resident futures by design on the daemon's hot paths; boxing the
// call sites for a lint tick is a perf regression with zero correctness gain.
#![allow(clippy::large_futures)]
// 64-bit-only targets; the narrowing casts sit at OS boundaries
// (pid/fd/time/size) where the values are bounded by the kernel - the
// dead-guard expect()s would add panic paths where silent wrap was
// deliberate.
#![allow(
    clippy::cast_possible_truncation,
    clippy::cast_possible_wrap,
    clippy::cast_sign_loss,
    clippy::cast_precision_loss
)]
// The fn-length threshold is a style gate, not correctness; the structure
// campaign owns the god-fn splits as a follow-up. The scenario tests read
// as one narrative each.
#![allow(clippy::too_many_lines)]
// API-shape opinions, not defects; the surfaces are deliberate.
#![allow(
    clippy::unnecessary_wraps,
    clippy::zero_sized_map_values,
    clippy::struct_excessive_bools,
    clippy::struct_field_names
)]
#![cfg(unix)]

use std::io::{BufRead, BufReader, Write};
use std::os::unix::net::UnixStream;
use std::path::{Path, PathBuf};
use std::process::{Child, Command, Stdio};
use std::time::{Duration, Instant};

use pa_core::factory_eval::resolve_factory_kernel_python;
use serde_json::{json, Value};

struct Daemon {
    child: Child,
    #[allow(dead_code)]
    socket: PathBuf,
}

impl Drop for Daemon {
    fn drop(&mut self) {
        let _ = self.child.kill();
        let _ = self.child.wait();
    }
}

/// One scenario harness: an isolated temp tree, a seeded harness store,
/// one real supervisor, and a JSONL client on its socket.
struct Harness {
    root: PathBuf,
    agent_dir: PathBuf,
    #[allow(dead_code)]
    socket: PathBuf,
    daemon: Daemon,
    client: Client,
}

impl Drop for Harness {
    fn drop(&mut self) {
        // Kill the supervisor, reap it, remove the scenario tree — the same
        // teardown shape every other daemon e2e harness's tempfile::TempDir
        // performs. A worker whose supervisor died can still write one
        // journal fragment into the removed tree inside its orphan-exit
        // window (the fleet-wide 15s behavior); the fragment is inert and
        // dies with the worker.
        let _ = self.daemon.child.kill();
        let _ = self.daemon.child.wait();
        let _ = std::fs::remove_dir_all(&self.root);
    }
}

struct Client {
    reader: BufReader<UnixStream>,
    writer: UnixStream,
}

impl Client {
    fn connect(socket: &Path) -> (Self, Value) {
        let stream = UnixStream::connect(socket).expect("connect supervisor");
        let write_stream = stream.try_clone().expect("clone socket");
        let mut client = Client {
            reader: BufReader::new(stream),
            writer: write_stream,
        };
        let hello = client.read_line();
        (client, hello)
    }

    fn read_line(&mut self) -> Value {
        let mut line = String::new();
        let deadline = Instant::now() + Duration::from_mins(1);
        self.reader
            .get_mut()
            .set_read_timeout(Some(Duration::from_millis(100)))
            .expect("set timeout");
        loop {
            line.clear();
            match self.reader.read_line(&mut line) {
                Ok(0) => panic!("supervisor closed the connection"),
                Ok(_) if line.trim().is_empty() => {}
                Ok(_) => return serde_json::from_str(line.trim()).expect("parse line"),
                Err(error) => {
                    assert!(
                        Instant::now() < deadline,
                        "timed out waiting for a supervisor line: {error}"
                    );
                }
            }
        }
    }

    fn send_command(&mut self, id: &str, command: &Value) {
        let envelope = json!({
            "type": "command",
            "id": id,
            "protocol": { "name": "prime-agent.daemon", "version": 7 },
            "command": command,
        });
        let mut line = serde_json::to_string(&envelope).expect("serialize command");
        line.push('\n');
        self.writer
            .write_all(line.as_bytes())
            .unwrap_or_else(|error| panic!("send command {id}: {error}"));
        self.writer
            .flush()
            .unwrap_or_else(|error| panic!("flush command {id}: {error}"));
    }

    /// Read lines until the response for `id` arrives, skipping broadcast
    /// frames. Every line waits on the remaining wall budget, so a slow
    /// worker boot answers inside the same window.
    fn read_response(&mut self, id: &str, budget: Duration) -> Value {
        let deadline = Instant::now() + budget;
        loop {
            let remaining = deadline.saturating_duration_since(Instant::now());
            assert!(!remaining.is_zero(), "no response for id {id}");
            let line = self.read_line_with_budget(remaining);
            if line.get("id").and_then(Value::as_str) == Some(id) {
                return line;
            }
        }
    }

    fn read_line_with_budget(&mut self, budget: Duration) -> Value {
        let mut line = String::new();
        let deadline = Instant::now() + budget;
        self.reader
            .get_mut()
            .set_read_timeout(Some(Duration::from_millis(100)))
            .expect("set timeout");
        loop {
            line.clear();
            match self.reader.read_line(&mut line) {
                Ok(0) => panic!("supervisor closed the connection"),
                Ok(_) if line.trim().is_empty() => {}
                Ok(_) => return serde_json::from_str(line.trim()).expect("parse line"),
                Err(error) => {
                    assert!(
                        Instant::now() < deadline,
                        "timed out waiting for a supervisor line: {error}"
                    );
                }
            }
        }
    }

    fn send(&mut self, id: &str, command: &Value) -> Value {
        self.send_command(id, command);
        self.read_response(id, Duration::from_mins(2))
    }
}

/// The memoized kernel-python resolution (the probe spawns a python
/// import of the whole runtime; the suite asks once).
static KERNEL_PYTHON: std::sync::OnceLock<Option<pa_core::factory_eval::FactoryKernelPython>> =
    std::sync::OnceLock::new();

/// Resolve the kernel python the suite pins: the fleet's explicit override,
/// the caller's product pin, then the shared resolver's candidates. The
/// None-when-no-shared-venv case means CI: the standard bootstrap builds
/// the venv from this checkout's runtime.
fn kernel_python() -> Option<pa_core::factory_eval::FactoryKernelPython> {
    KERNEL_PYTHON
        .get_or_init(|| {
            let explicit = std::env::var_os("PA_E2E_KERNEL_PYTHON")
                .or_else(|| std::env::var_os("PRIME_AGENT_KERNEL_PYTHON"))
                .map(PathBuf::from);
            resolve_kernel_python(explicit)
        })
        .clone()
}

fn resolve_kernel_python(
    explicit: Option<PathBuf>,
) -> Option<pa_core::factory_eval::FactoryKernelPython> {
    let (kernel, shared_venv_exists) = resolve_factory_kernel_python(explicit);
    if kernel.is_none() && shared_venv_exists {
        // A shared venv exists but no candidate probes factory-capable:
        // skip with the recipe instead of letting the standard bootstrap
        // rebuild the shared kernel venv that live sessions run on. (With
        // no shared venv at all, the standard bootstrap builds it from
        // this checkout's runtime — safe; nothing live depends on it.)
        eprintln!(
            "No factory-capable kernel python: point PA_E2E_KERNEL_PYTHON at one, or create \
             the checkout-local venv ({}), or refresh the shared kernel venv. Skipping: \
             pinning is what keeps this suite from rebuilding the shared kernel venv that \
             live sessions run on.",
            pa_core::factory_eval::FACTORY_KERNEL_VENV_RECIPE
        );
    }
    kernel
}

/// The five machines this file seeds into the harness store. The loop
/// scenario creates its own over the bridge (`rlm.harness.create_factory`).
fn seeded_factory_entries() -> serde_json::Map<String, Value> {
    let mut entries = serde_json::Map::new();
    let now = "2026-01-01T00:00:00.000Z";
    let seed =
        |entries: &mut serde_json::Map<String, Value>, id: &str, title: &str, spec: Value| {
            entries.insert(
                id.to_string(),
                json!({
                    "id": id,
                    "kind": "factory",
                    "title": title,
                    "content": format!("{title} (factory workflow e2e)"),
                    "path": "factory-workflow-e2e",
                    "scope": "local",
                    "reference": {},
                    "arguments": spec,
                    "metadata": { "source": "factory-workflow-e2e" },
                    "source": "agent",
                    "created_at": now,
                    "updated_at": now,
                    "version": 1
                }),
            );
        };
    seed(
        &mut entries,
        "e2e-diamond",
        "diamond fan-out and join",
        json!({ "machine": diamond_machine() }),
    );
    seed(
        &mut entries,
        "e2e-escalation",
        "escalation pause and resume",
        json!({ "machine": escalation_machine() }),
    );
    seed(
        &mut entries,
        "e2e-stop-mid-run",
        "stop mid-run",
        json!({ "machine": stop_machine() }),
    );
    seed(
        &mut entries,
        "e2e-dag-chain",
        "dag chain through the compiler",
        json!({ "dag": dag_chain() }),
    );
    seed(
        &mut entries,
        "e2e-nonblocking",
        "nonblocking admission",
        json!({ "machine": nonblocking_machine() }),
    );
    entries
}

// -- the scenario machines -------------------------------------------------

/// The review/fix loop machine (the #2485 scenario-1 shape): reviewing
/// re-enters with an optional `fix_report` input that binds the null
/// sentinel on the first review and the fixer's json report on every
/// re-entry. The scripted children all answer the same multi-key `json`
/// block (verdict and `fix_report`), so the loop closes on bounded re-entry:
/// reviewing runs to `max_entries` 4 while fixing exhausts `max_entries` 3
/// and the last reviewing->fixing transition is recorded as blocked.
fn loop_machine() -> Value {
    json!({
        "run": { "failure_policy": "continue", "max_parallel": 4 },
        "states": [
            {
                "id": "draft",
                "entry": true,
                "subagent": { "prompt": "E2E-STATE:DRAFT Write the draft.", "name": "e2e-draft" },
                "outputs": [{ "name": "draft", "type": "text" }]
            },
            {
                "id": "reviewing",
                "subagent": {
                    "prompt": "E2E-STATE:REVIEWING Review the draft.\nDraft: {draft}\nFix report: {fix_report}\nReturn one fenced JSON verdict.",
                    "name": "e2e-reviewing"
                },
                "inputs": [
                    { "name": "draft", "type": "text", "from": "draft.draft" },
                    { "name": "fix_report", "type": "json", "from": "fixing.fix_report", "optional": true }
                ],
                "outputs": [{ "name": "verdict", "type": "json" }],
                "max_entries": 4
            },
            {
                "id": "fixing",
                "subagent": {
                    "prompt": "E2E-STATE:FIXING Fix the findings.\nVerdict: {verdict}\nReturn one fenced JSON fix report.",
                    "name": "e2e-fixing"
                },
                "inputs": [{ "name": "verdict", "type": "json", "from": "reviewing.verdict" }],
                "outputs": [{ "name": "fix_report", "type": "json" }],
                "max_entries": 3
            }
        ],
        "transitions": [
            { "from": "draft", "to": "reviewing" },
            {
                "from": "reviewing",
                "to": "fixing",
                "when": { "output": "verdict", "path": "approved", "op": "eq", "value": false }
            },
            { "from": "fixing", "to": "reviewing" }
        ]
    })
}

/// One settle fans two transitions out; both branches run; the join waits
/// for both and re-binds both inputs into one prompt (the second join edge
/// is max_entries-blocked).
fn diamond_machine() -> Value {
    json!({
        "run": { "failure_policy": "continue", "max_parallel": 4 },
        "states": [
            {
                "id": "split",
                "entry": true,
                "subagent": { "prompt": "E2E-STATE:SPLIT Produce the fan-out value.", "name": "e2e-split" },
                "outputs": [{ "name": "fan", "type": "text" }]
            },
            {
                "id": "left",
                "subagent": { "prompt": "E2E-STATE:LEFT Left branch: {fan}", "name": "e2e-left" },
                "inputs": [{ "name": "fan", "type": "text", "from": "split.fan" }],
                "outputs": [{ "name": "left_out", "type": "text" }]
            },
            {
                "id": "right",
                "subagent": { "prompt": "E2E-STATE:RIGHT Right branch: {fan}", "name": "e2e-right" },
                "inputs": [{ "name": "fan", "type": "text", "from": "split.fan" }],
                "outputs": [{ "name": "right_out", "type": "text" }]
            },
            {
                "id": "join",
                "subagent": { "prompt": "E2E-STATE:JOIN Left: {left_in}\nRight: {right_in}", "name": "e2e-join" },
                "inputs": [
                    { "name": "left_in", "type": "text", "from": "left.left_out" },
                    { "name": "right_in", "type": "text", "from": "right.right_out" }
                ],
                "outputs": [{ "name": "joined", "type": "text" }]
            }
        ],
        "transitions": [
            { "from": "split", "to": "left" },
            { "from": "split", "to": "right" },
            { "from": "left", "to": "join" },
            { "from": "right", "to": "join" }
        ]
    })
}

/// A state that fails at spawn admission: an unsupported thinking level makes
/// the real `rlm.run` host call throw (the production admission-failure
/// shape — no child session starts, no network).
fn escalation_machine() -> Value {
    json!({
        "run": { "failure_policy": "escalate", "max_parallel": 4 },
        "states": [
            {
                "id": "flaky",
                "entry": true,
                "subagent": {
                    "prompt": "E2E-STATE:FLAKY Do the risky thing.",
                    "name": "e2e-flaky",
                    "thinking": "e2e-unsupported-thinking"
                },
                "failure_policy": "escalate"
            },
            {
                "id": "fixer",
                "subagent": { "prompt": "E2E-STATE:FIXER Clean up after the failure.", "name": "e2e-fixer" },
                "outputs": [{ "name": "fixed", "type": "text" }]
            }
        ],
        "transitions": [{ "from": "flaky", "to": "fixer" }]
    })
}

fn stop_machine() -> Value {
    json!({
        "run": { "failure_policy": "continue", "max_parallel": 4 },
        "states": [
            { "id": "hold", "entry": true, "subagent": { "prompt": "E2E-STATE:HOLD Work slowly.", "name": "e2e-hold" } },
            { "id": "after", "subagent": { "prompt": "E2E-STATE:AFTER Follow up.", "name": "e2e-after" } }
        ],
        "transitions": [{ "from": "hold", "to": "after" }]
    })
}

fn nonblocking_machine() -> Value {
    json!({
        "run": { "failure_policy": "continue", "max_parallel": 4 },
        "states": [
            {
                "id": "slowgate",
                "entry": true,
                "subagent": { "prompt": "E2E-STATE:SLOWGATE Take your time.", "name": "e2e-slowgate" },
                "outputs": [{ "name": "go", "type": "text" }]
            },
            {
                "id": "final",
                "subagent": { "prompt": "E2E-STATE:FINAL Finish: {go}", "name": "e2e-final" },
                "inputs": [{ "name": "go", "type": "text", "from": "slowgate.go" }]
            }
        ],
        "transitions": [{ "from": "slowgate", "to": "final" }]
    })
}

fn dag_chain() -> Value {
    json!({
        "run": { "failure_policy": "continue", "max_parallel": 4 },
        "nodes": [
            {
                "id": "alpha",
                "subagent": { "prompt": "E2E-STATE:ALPHA Start the chain.", "name": "e2e-alpha" },
                "outputs": [{ "name": "alpha_out", "type": "text" }]
            },
            {
                "id": "beta",
                "subagent": { "prompt": "E2E-STATE:BETA Continue: {alpha_out}", "name": "e2e-beta" },
                "inputs": [{ "name": "alpha_out", "type": "text", "from": "alpha.alpha_out" }],
                "outputs": [{ "name": "beta_out", "type": "text" }]
            },
            {
                "id": "gamma",
                "subagent": { "prompt": "E2E-STATE:GAMMA Finish: {beta_out}", "name": "e2e-gamma" },
                "inputs": [{ "name": "beta_out", "type": "text", "from": "beta.beta_out" }]
            }
        ]
    })
}

// -- kernel cells (each writes exactly one JSON receipt) -------------------

/// Create the machine over the bridge (`rlm.harness.create_factory`) and
/// start the run; the receipt records the admission result. The cell does
/// NOT poll: the parent's turns stay short, because a child session's task
/// prompt releases at the parent's turn boundary (`on_turn_done`) — the
/// scenario drives the run's settle waves with short poll turns.
fn create_and_run_cell(
    entry_id: &str,
    machine: &Value,
    receipt: &Path,
    error_receipt: &Path,
) -> String {
    let machine_literal =
        serde_json::to_string(&machine.to_string()).expect("quote the machine json");
    format!(
        "import json, traceback\ntry:\n    machine = json.loads({machine_literal})\n    spec = rlm.harness.create_factory(\"{entry_id} machine\", \"created over the bridge\", id={entry_id:?}, machine=machine)\n    started = await rlm.factory.run(spec.id)\n    early = await rlm.factory.status(started[\"run_id\"])\n    open({receipt:?}, \"w\").write(json.dumps({{\"spec_id\": spec.id, \"run_id\": started[\"run_id\"], \"started\": sorted(started[\"started\"]), \"nodes\": started[\"nodes\"], \"early_state\": early[\"state\"]}}))\nexcept Exception:\n    open({error_receipt:?}, \"w\").write(traceback.format_exc())\n    raise",
        machine_literal = machine_literal,
        entry_id = entry_id,
        receipt = receipt.display().to_string(),
        error_receipt = error_receipt.display().to_string(),
    )
}

/// Start a seeded spec; the receipt records the admission result plus the
/// early status (the nonblocking proof: taken right after `run` returned).
fn run_cell(entry_id: &str, receipt: &Path, error_receipt: &Path) -> String {
    format!(
        "import json, traceback\ntry:\n    started = await rlm.factory.run({entry_id:?})\n    early = await rlm.factory.status(started[\"run_id\"])\n    open({receipt:?}, \"w\").write(json.dumps({{\"run_id\": started[\"run_id\"], \"started\": sorted(started[\"started\"]), \"nodes\": started[\"nodes\"], \"early_state\": early[\"state\"], \"early_usage\": early[\"usage\"]}}))\nexcept Exception:\n    open({error_receipt:?}, \"w\").write(traceback.format_exc())\n    raise",
        entry_id = entry_id,
        receipt = receipt.display().to_string(),
        error_receipt = error_receipt.display().to_string(),
    )
}

// -- faux scripts -----------------------------------------------------------

fn tool_call_cell(code: &str, id: &str) -> Value {
    json!({ "content": [
        { "type": "toolCall", "name": "ipython", "id": id, "arguments": { "code": code } }
    ] })
}

fn text_response(text: &str) -> Value {
    json!({ "text": text })
}

fn child_script(text: &str, delay_ms: u64) -> Value {
    json!({ "engine": "faux", "responses": [ { "text": text, "delayMs": delay_ms } ] })
}

/// Write one script file and return its path.
fn write_script(dir: &Path, name: &str, script: &Value) -> PathBuf {
    let path = dir.join(name);
    std::fs::write(&path, script.to_string())
        .unwrap_or_else(|error| panic!("write script {}: {error}", path.display()));
    path
}

// -- the harness ------------------------------------------------------------

// The timeout panic path cannot wait on the child; the test process exits
// immediately afterwards, reaping it.
#[allow(clippy::zombie_processes)]
fn spawn_supervisor(
    socket: &Path,
    agent_dir: &Path,
    harness_dir: &Path,
    kernel: Option<&pa_core::factory_eval::FactoryKernelPython>,
) -> Daemon {
    let binary = env!("CARGO_BIN_EXE_pa-daemon");
    let log_file =
        std::fs::File::create(socket.with_extension("supervisor.log")).expect("log file");
    let log_err = log_file.try_clone().expect("clone log file");
    let mut command = Command::new(binary);
    command
        .arg("supervisor")
        .arg("--socket")
        .arg(socket)
        .arg("--agent-dir")
        .arg(agent_dir)
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::from(log_err))
        // Hermetic agent dir: the ambient environment exports a real agent
        // dir; point every fallback at the test sandbox instead.
        .env("PRIME_AGENT_CODING_AGENT_DIR", agent_dir)
        // The harness store the kernels load: the seeded factory specs.
        .env("RLM_HARNESS_STATE_DIR", harness_dir)
        .env_remove("PRIME_API_KEY")
        .env_remove("RLM_DEPTH")
        // A supervisor killed at teardown must not leak its session workers
        // into later test binaries: the worker's supervisor-lost exit runs
        // on this short window instead of the 5-minute default.
        .env(
            pa_daemon::worker::WORKER_SUPERVISOR_LOST_EXIT_MS_ENV,
            "15000",
        );
    if let Some(kernel) = kernel {
        command.env("PRIME_AGENT_KERNEL_PYTHON", &kernel.python);
        if let Some(path) = &kernel.python_path {
            command.env("PYTHONPATH", path);
        }
    }
    let child = command.spawn().expect("spawn pa-daemon supervisor");
    let deadline = Instant::now() + Duration::from_secs(10);
    while Instant::now() < deadline {
        if socket.exists() {
            return Daemon {
                child,
                socket: socket.to_path_buf(),
            };
        }
        std::thread::sleep(Duration::from_millis(20));
    }
    panic!("supervisor socket never appeared at {}", socket.display());
}

/// Build one scenario harness: the temp tree, the seeded harness store, the
/// supervisor, and a connected client. Each scenario gets its own tree so
/// a failure never poisons the next one.
fn harness(label: &str, kernel: Option<&pa_core::factory_eval::FactoryKernelPython>) -> Harness {
    let root = std::env::temp_dir().join(format!(
        "pi-factory-e2e-{label}-{}",
        std::process::id()
            ^ std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap_or_default()
                .subsec_nanos()
    ));
    std::fs::create_dir_all(&root).expect("temp root");
    let agent_dir = root.join("agent");
    std::fs::create_dir_all(&agent_dir).expect("agent dir");
    // The factory namespace is opt-in on the kernel side (`factory.enabled`
    // in the agent dir's settings.json, default off -- the refusal every
    // factory write raises while it is off). Exercising the namespace is
    // this suite's whole purpose, so the sandbox opts in itself: the
    // hermetic agent dir the supervisor exports carries the setting.
    std::fs::write(
        agent_dir.join("settings.json"),
        json!({ "factory": { "enabled": true } }).to_string(),
    )
    .expect("opt the sandbox into the factory");
    let harness_dir = root.join("harness");
    std::fs::create_dir_all(&harness_dir).expect("harness dir");
    std::fs::write(
        harness_dir.join("harness_state.json"),
        json!({
            "schema": 1,
            "entries": {
                "prompt": {},
                "memory": {},
                "skill": {},
                "subagent": {},
                "factory": seeded_factory_entries()
            },
            "refinements": []
        })
        .to_string(),
    )
    .expect("seed harness state");
    let socket = root.join(format!("{label}.sock"));
    let spawned = spawn_supervisor(&socket, &agent_dir, &harness_dir, kernel);
    let (client, hello) = Client::connect(&socket);
    assert_eq!(hello["type"], "daemon_hello");
    Harness {
        root,
        agent_dir,
        socket,
        daemon: spawned,
        client,
    }
}

impl Harness {
    /// Create one scripted parent session; its children inherit the child
    /// script (the harness seam mirroring the TS child runtime's inherited
    /// sessionConfig, so every factory child is a scripted worker too).
    /// Returns the parent's (worker id, session uuid) pair: the worker id
    /// addresses the session on the wire, the session uuid keys the
    /// children's session-artifacts tree.
    fn create_parent(
        &mut self,
        label: &str,
        parent_script: &Path,
        child_script: &Path,
    ) -> (String, String) {
        let scenario_dir = self.root.join(label);
        let sessions_dir = scenario_dir.join("sessions");
        std::fs::create_dir_all(&sessions_dir).expect("scenario session dir");
        let created = self.client.send(
            &format!("create-{label}"),
            &json!({
                "type": "create",
                "name": format!("factory-e2e-{label}"),
                "config": {
                    "cwd": scenario_dir.to_string_lossy(),
                    "sessionDir": sessions_dir.to_string_lossy(),
                    "script": parent_script.to_string_lossy(),
                    "childScript": child_script.to_string_lossy(),
                },
            }),
        );
        assert_eq!(created["success"], true, "create parent failed: {created}");
        let data = created["data"].clone();
        let active_session_id = data
            .get("activeSessionId")
            .and_then(Value::as_str)
            .or_else(|| data.get("id").and_then(Value::as_str))
            .expect("active session id in create response")
            .to_string();
        let Some(session_uuid) = data.get("sessionId").and_then(Value::as_str) else {
            panic!("session id in create response: {created}");
        };
        let session_uuid = session_uuid.to_string();
        (active_session_id, session_uuid)
    }

    /// Prompt the parent and wait for its turn to complete. The whole
    /// scenario runs inside the turn (kernel boot + factory run + polls),
    /// so the budget is the scenario's outer wall bound: ten minutes,
    /// bounded — a hang here is a finding, never something to wait out.
    fn prompt_and_wait(&mut self, label: &str, session_id: &str) {
        self.client.send_command(
            &format!("prompt-{label}"),
            &json!({ "type": "prompt_and_wait", "activeSessionId": session_id, "message": "run the factory scenario" }),
        );
        let prompted = self
            .client
            .read_response(&format!("prompt-{label}"), Duration::from_mins(10));
        assert_eq!(prompted["success"], true, "parent turn failed: {prompted}");
    }

    fn receipts_dir(&self, label: &str) -> PathBuf {
        self.root.join(label).join("receipts")
    }

    /// Read a receipt fresh (each poll turn overwrites it). `None` while it
    /// has not appeared yet; an error receipt fails the test.
    fn read_receipt(&self, label: &str, name: &str) -> Option<Value> {
        let receipt = self.receipts_dir(label).join(format!("{name}.json"));
        let error_receipt = receipt.with_extension("error");
        if let Ok(content) = std::fs::read_to_string(&error_receipt) {
            panic!("cell {name} raised:\n{content}");
        }
        std::fs::read_to_string(&receipt).ok().and_then(|content| {
            serde_json::from_str(&content)
                .map_err(|error| panic!("receipt {name} is not JSON: {error}"))
                .ok()
        })
    }

    /// Drive the scenario's settle waves: prompt the parent's next short
    /// turn (which releases the wave's child prompts at the turn boundary)
    /// and re-read the poll receipt until the predicate holds. Bounded by
    /// the turn count and the wall budget — a hang here is a finding,
    /// never something to wait out.
    fn drive_to_state(
        &mut self,
        label: &str,
        session_id: &str,
        receipt_name: &str,
        budget: Duration,
        done: impl Fn(&Value) -> bool,
    ) -> Value {
        let deadline = Instant::now() + budget;
        let mut request_id = 0_u64;
        loop {
            request_id += 1;
            self.prompt_and_wait(&format!("{label}-{request_id}"), session_id);
            if let Some(receipt) = self.read_receipt(label, receipt_name) {
                if done(&receipt) {
                    return receipt;
                }
            }
            assert!(
                Instant::now() < deadline,
                "the scenario never reached the expected state at {label}"
            );
            // Pace the drive loop: the faux engine answers instantly, so
            // unpaced polls burn the script's pairs before the run's settle
            // waves progress (each wave releases at a turn boundary, and
            // the waves themselves take real wall time — child boots and
            // delayed answers). One paced turn per wave-boundary check.
            std::thread::sleep(Duration::from_millis(1_500));
        }
    }

    /// Poll for a receipt (bounded): an error receipt fails the test with
    /// the traceback it carries, a missing receipt fails on the deadline.
    fn await_receipt(&self, label: &str, name: &str, budget: Duration) -> Value {
        let receipt = self.receipts_dir(label).join(format!("{name}.json"));
        let error_receipt = receipt.with_extension("error");
        let deadline = Instant::now() + budget;
        loop {
            if let Ok(content) = std::fs::read_to_string(&error_receipt) {
                panic!("cell {name} raised:\n{content}");
            }
            if let Ok(content) = std::fs::read_to_string(&receipt) {
                return serde_json::from_str(&content)
                    .unwrap_or_else(|error| panic!("receipt {name} is not JSON: {error}"));
            }
            assert!(
                Instant::now() < deadline,
                "receipt {name} never appeared at {}",
                receipt.display()
            );
            std::thread::sleep(Duration::from_millis(50));
        }
    }

    /// Every user-message text the children of one parent session received
    /// (the rendered prompts, read off disk through the real bridge).
    fn child_prompts(&self, parent_session_id: &str) -> Vec<String> {
        let artifacts = self
            .agent_dir
            .join("session-artifacts")
            .join(parent_session_id);
        let mut prompts = Vec::new();
        let Ok(children) = std::fs::read_dir(&artifacts) else {
            return prompts;
        };
        for child in children.filter_map(Result::ok) {
            let Ok(files) = std::fs::read_dir(child.path()) else {
                continue;
            };
            for file in files.filter_map(Result::ok) {
                let path = file.path();
                if path.extension().and_then(|extension| extension.to_str()) != Some("jsonl") {
                    continue;
                }
                let Ok(content) = std::fs::read_to_string(&path) else {
                    continue;
                };
                for line in content.lines() {
                    let Ok(row) = serde_json::from_str::<Value>(line) else {
                        continue;
                    };
                    if row.get("type").and_then(Value::as_str) != Some("message") {
                        continue;
                    }
                    // The persisted row shape: {"type": "message", ...,
                    // "message": {"role": ..., "content": ...}}.
                    let Some(message) = row
                        .get("message")
                        .or_else(|| row.get("fields").and_then(|fields| fields.get("message")))
                    else {
                        continue;
                    };
                    if message.get("role").and_then(Value::as_str) != Some("user") {
                        continue;
                    }
                    let content = message.get("content");
                    let text = match content {
                        Some(Value::String(text)) => text.clone(),
                        Some(Value::Array(blocks)) => blocks
                            .iter()
                            .filter_map(|block| block.get("text").and_then(Value::as_str))
                            .collect::<Vec<_>>()
                            .join("\n"),
                        _ => continue,
                    };
                    if !text.is_empty() {
                        prompts.push(text);
                    }
                }
            }
        }
        prompts
    }

    /// Poll the supervisor roster until no session matches the predicate.
    fn wait_until_roster_drops(&mut self, still_there: impl Fn(&Value) -> bool, budget: Duration) {
        let deadline = Instant::now() + budget;
        loop {
            let list = self.client.send("roster", &json!({ "type": "list" }));
            let sessions = list["data"]["sessions"]
                .as_array()
                .cloned()
                .unwrap_or_default();
            if !sessions.iter().any(&still_there) {
                return;
            }
            assert!(
                Instant::now() < deadline,
                "the cancelled child never left the roster: {sessions:?}"
            );
            std::thread::sleep(Duration::from_millis(100));
        }
    }
}

/// One state's report from a status JSON.
fn state_report<'a>(status: &'a Value, id: &str) -> &'a Value {
    status["nodes"]
        .as_array()
        .expect("nodes")
        .iter()
        .find(|node| node["id"] == id)
        .unwrap_or_else(|| panic!("state {id} in the report: {status}"))
}

fn events_of<'a>(status: &'a Value, kind: &str) -> Vec<&'a Value> {
    status["events"]
        .as_array()
        .expect("events")
        .iter()
        .filter(|event| event["kind"] == kind)
        .collect()
}

/// The poll-cell body shared by every driven scenario: reads the run id
/// from the setup receipt (the run id is only known after the setup turn)
/// and writes the fresh status JSON to the poll receipt.
fn poll_code_for(receipts: &Path) -> String {
    format!(
        "import json, traceback\ntry:\n    run_id = json.load(open({run_receipt:?}))[\"run_id\"]\n    status = await rlm.factory.status(run_id)\n    open({poll_receipt:?}, \"w\").write(json.dumps(status))\nexcept Exception:\n    open({poll_error:?}, \"w\").write(traceback.format_exc())\n    raise",
        run_receipt = receipts.join("run.json").display().to_string(),
        poll_receipt = receipts.join("poll.json").display().to_string(),
        poll_error = receipts.join("poll.error").display().to_string(),
    )
}

/// The scenario scripts: the setup turn's responses first (a cell, then a
/// text response that ends the turn), then the poll pairs that drive the
/// settle waves; the last pair repeats for any further turn.
///
/// The response queue is consumed ACROSS turns (one turn ends on a text
/// response), and the setup turn's own responses sit at the front — the
/// first `prompt_and_wait` runs the setup cell, the drive loop's turns
/// run the poll pairs. The poll cell reads the run id from the setup
/// receipt, so no id is baked into the script.
fn driven_script(
    setup_cells: &[String],
    ids: &[&str],
    poll_code: &str,
    poll_pairs: usize,
) -> Value {
    let mut responses: Vec<Value> = setup_cells
        .iter()
        .zip(ids)
        .map(|(code, id)| tool_call_cell(code, id))
        .collect();
    if setup_cells.is_empty() {
        responses.push(text_response("scenario ready"));
    } else {
        for _ in 0..setup_cells.len() {
            responses.push(text_response("setup turn done"));
        }
    }
    for index in 0..poll_pairs {
        responses.push(tool_call_cell(poll_code, &format!("toolu-poll-{index}")));
        responses.push(text_response("poll turn done"));
    }
    json!({ "engine": "faux", "repeatLastResponse": true, "responses": responses })
}

// -- scenario 1: the guarded review/fix loop over the real bridge ----------

#[test]
fn factory_loop_machine_creates_runs_and_re_binds_over_the_real_bridge() {
    let Some(kernel) = kernel_python() else {
        eprintln!("skipping: no factory-capable kernel python");
        return;
    };
    let mut harness = harness("loop", Some(&kernel));
    let label = "loop";
    let receipts = harness.receipts_dir(label);
    std::fs::create_dir_all(&receipts).expect("receipts dir");
    // The shared child answer: one fenced block carrying every state's
    // named output (verdict + fix_report), so reviewing and fixing both
    // bind from their own children's identical scripted answers.
    let answer = "```json\n{\"verdict\": {\"approved\": false, \"findings\": [\"finding-1\"]}, \"fix_report\": {\"fixed\": [\"finding-1\"], \"marker\": \"FIX-REPORT-PRESENT\"}}\n```";
    let setup = create_and_run_cell(
        "e2e-loop-machine",
        &loop_machine(),
        &receipts.join("run.json"),
        &receipts.join("run.error"),
    );
    let poll_code = poll_code_for(&receipts);
    let parent = write_script(
        &harness.root,
        "loop-parent.json",
        &driven_script(&[setup], &["toolu-loop-run"], &poll_code, 60),
    );
    let child = write_script(&harness.root, "loop-child.json", &child_script(answer, 30));
    let (session_id, session_uuid) = harness.create_parent(label, &parent, &child);

    // Turn 1 creates the machine over the bridge and starts the run; the
    // drive loop's short turns then release each settle wave's children at
    // the turn boundary until the run reaches a terminal state.
    let status = harness.drive_to_state(
        label,
        &session_id,
        "poll",
        Duration::from_mins(9),
        |status| matches!(status["state"].as_str(), Some("done" | "failed")),
    );
    let run = harness
        .read_receipt(label, "run")
        .expect("the setup receipt");
    assert_eq!(
        run["spec_id"], "e2e-loop-machine",
        "created over the bridge: {run}"
    );
    assert_eq!(run["nodes"], 3);
    assert_eq!(
        run["started"],
        json!(["draft"]),
        "admission enters the entry state"
    );

    // The loop closed on bounded re-entry: reviewing ran to max_entries 4
    // while fixing exhausted max_entries 3 (the scripted children all
    // reject, so the approval switch never fires — the TS-era approval
    // closure is covered by the executor's machine-loop unit tests).
    assert_eq!(
        status["state"], "done",
        "the loop run reaches done: {status}"
    );
    assert_eq!(
        state_report(&status, "reviewing")["entries_used"],
        4,
        "reviewing re-entered to max_entries"
    );
    assert_eq!(
        state_report(&status, "fixing")["entries_used"],
        3,
        "fixing exhausted max_entries"
    );
    assert_eq!(
        status["usage"]["transitions_fired"], 7,
        "draft->rev, rev->fix x3, fix->rev x3"
    );
    let blocked = events_of(&status, "transition_blocked");
    assert_eq!(
        blocked.len(),
        1,
        "the last reviewing->fixing transition is max_entries-blocked"
    );
    assert_eq!(blocked[0]["from"], "reviewing");
    assert_eq!(blocked[0]["to"], "fixing");

    // The finished milestone lands in the ledger but never as a shown notice:
    // the notice-injection lane is deliberately unported (the dead-bridge
    // path the factory core port tested), so the parent's turns above ended
    // on their own scripted text, not on a factory-progress wake.
    let milestones: Vec<&Value> = status["events"]
        .as_array()
        .expect("events")
        .iter()
        .filter(|event| event["kind"] == "milestone" && event["milestone"] == "finished")
        .collect();
    assert_eq!(milestones.len(), 1, "one finished milestone per run");
    assert_ne!(
        milestones[0]["stage"], "shown",
        "the notice lane is unported; the milestone stays ledger-only"
    );

    // The optional fix_report input re-binds on every re-entry through the
    // real bridge: round 1 renders the null sentinel (the fixer never
    // settled), rounds 2-4 render the fixer's JSON report. The child files
    // are collected in directory order, so the assertions are per-round
    // COUNTS (one null-sentinel round, three re-bound rounds), not
    // positional.
    let prompts = harness.child_prompts(&session_uuid);
    let reviewing: Vec<&String> = prompts
        .iter()
        .filter(|prompt| prompt.contains("E2E-STATE:REVIEWING"))
        .collect();
    assert_eq!(
        reviewing.len(),
        4,
        "one reviewing child per review round: {prompts:?}"
    );
    let null_rounds: Vec<&&String> = reviewing
        .iter()
        .filter(|prompt| prompt.contains("Fix report: null"))
        .collect();
    assert_eq!(
        null_rounds.len(),
        1,
        "exactly round 1 binds the null sentinel: {reviewing:?}"
    );
    // The re-bound marker is the rendered `Fix report: {` line — the marker
    // string itself also appears in the draft's captured answer (the shared
    // child text), so only the Fix-report BIND distinguishes the rounds.
    let re_bound_rounds: Vec<&&String> = reviewing
        .iter()
        .filter(|prompt| prompt.contains("Fix report: {"))
        .collect();
    assert_eq!(
        re_bound_rounds.len(),
        3,
        "rounds 2-4 re-bind the fixer's report: {reviewing:?}"
    );
    assert!(
        reviewing
            .iter()
            .all(|prompt| prompt.contains("\"verdict\":")),
        "every review binds the draft state's captured answer"
    );
    let fixing: Vec<&String> = prompts
        .iter()
        .filter(|prompt| prompt.contains("E2E-STATE:FIXING"))
        .collect();
    assert_eq!(fixing.len(), 3, "one fixing child per fix round");
    assert!(
        fixing.iter().all(|prompt| prompt.contains("approved")),
        "the fixing prompt carries the verdict json"
    );
}

// -- scenario 2: the fan-out diamond and the join ---------------------------

#[test]
fn factory_diamond_fans_out_and_joins_both_answers() {
    let Some(kernel) = kernel_python() else {
        eprintln!("skipping: no factory-capable kernel python");
        return;
    };
    let mut harness = harness("diamond", Some(&kernel));
    let label = "diamond";
    let receipts = harness.receipts_dir(label);
    std::fs::create_dir_all(&receipts).expect("receipts dir");
    // Every child answers the same fan-out value: the join's proof is that
    // BOTH branch inputs re-bind into ONE prompt (the second join edge is
    // max_entries-blocked while the pending entry re-binds).
    let setup = run_cell(
        "e2e-diamond",
        &receipts.join("run.json"),
        &receipts.join("run.error"),
    );
    let poll_code = poll_code_for(&receipts);
    let parent = write_script(
        &harness.root,
        "diamond-parent.json",
        &driven_script(&[setup], &["toolu-diamond-run"], &poll_code, 60),
    );
    let child = write_script(
        &harness.root,
        "diamond-child.json",
        &child_script("FAN-OUT-VALUE", 30),
    );
    let (session_id, session_uuid) = harness.create_parent(label, &parent, &child);
    let status = harness.drive_to_state(
        label,
        &session_id,
        "poll",
        Duration::from_mins(8),
        |status| matches!(status["state"].as_str(), Some("done" | "failed")),
    );

    assert_eq!(
        status["state"], "done",
        "the diamond run completes: {status}"
    );
    // split->left, split->right, then one join fire; the second join edge is
    // blocked by max_entries and the pending entry re-binds both inputs.
    assert_eq!(status["usage"]["transitions_fired"], 3);
    let blocked = events_of(&status, "transition_blocked");
    assert_eq!(
        blocked.len(),
        1,
        "the second join edge is blocked: {status}"
    );
    // Whichever branch settles second holds the blocked edge (the two
    // branches run in parallel and their settle order is not fixed).
    assert!(
        matches!(blocked[0]["from"].as_str(), Some("left" | "right")),
        "the blocked edge is one of the branch joins: {blocked:?}"
    );
    assert_eq!(blocked[0]["to"], "join");
    for node in ["split", "left", "right", "join"] {
        assert_eq!(
            state_report(&status, node)["entries_used"],
            1,
            "one entry each: {node}"
        );
        assert_eq!(
            state_report(&status, node)["status"],
            "done",
            "settled: {node}"
        );
    }
    // The join prompt bound BOTH branch outputs into one prompt.
    let prompts = harness.child_prompts(&session_uuid);
    let join: Vec<&String> = prompts
        .iter()
        .filter(|prompt| prompt.contains("E2E-STATE:JOIN"))
        .collect();
    assert_eq!(
        join.len(),
        1,
        "one join child (the second edge was blocked)"
    );
    assert_eq!(
        join[0].matches("FAN-OUT-VALUE").count(),
        2,
        "both inputs re-bound into the single join prompt: {}",
        join[0]
    );
}

// -- scenario 3: escalation pauses, resume completes -------------------------

#[test]
fn factory_escalation_pauses_the_run_and_resume_completes_it() {
    let Some(kernel) = kernel_python() else {
        eprintln!("skipping: no factory-capable kernel python");
        return;
    };
    let mut harness = harness("escalation", Some(&kernel));
    let label = "escalation";
    let receipts = harness.receipts_dir(label);
    std::fs::create_dir_all(&receipts).expect("receipts dir");
    // The resume cell rides the script after the poll pairs' front: setup
    // turn (run), poll turn (confirm paused), resume turn, then poll
    // pairs to the terminal state.
    let setup = run_cell(
        "e2e-escalation",
        &receipts.join("run.json"),
        &receipts.join("run.error"),
    );
    let poll_code = poll_code_for(&receipts);
    let resume_code = format!(
        "import json, traceback\ntry:\n    run_id = json.load(open({run_receipt:?}))[\"run_id\"]\n    resumed = await rlm.factory.resume(run_id)\n    status = await rlm.factory.status(run_id)\n    open({receipt:?}, \"w\").write(json.dumps({{\"resumed\": resumed, \"status\": status}}))\nexcept Exception:\n    open({error_receipt:?}, \"w\").write(traceback.format_exc())\n    raise",
        run_receipt = receipts.join("run.json").display().to_string(),
        receipt = receipts.join("resume.json").display().to_string(),
        error_receipt = receipts.join("resume.error").display().to_string(),
    );
    let parent = write_script(
        &harness.root,
        "escalation-parent.json",
        &driven_script(
            &[setup, poll_code.clone(), resume_code],
            &["toolu-esc-run", "toolu-esc-poll", "toolu-esc-resume"],
            &poll_code,
            60,
        ),
    );
    let child = write_script(
        &harness.root,
        "escalation-child.json",
        &child_script("FIXED-UP", 30),
    );
    let (session_id, _session_uuid) = harness.create_parent(label, &parent, &child);

    // Turn 1 starts the run (the flaky admission fails immediately — the
    // run pauses inside the setup cell's own awaits); turn 2 reads the
    // paused status; turn 3 resumes.
    harness.prompt_and_wait("escalation-1", &session_id);
    let run = harness.await_receipt(label, "run", Duration::from_mins(2));
    assert_eq!(
        run["early_state"], "paused",
        "the escalate policy paused the run at admission: {run}"
    );
    let paused = {
        harness.prompt_and_wait("escalation-2", &session_id);
        harness.await_receipt(label, "poll", Duration::from_mins(2))
    };
    let flaky = state_report(&paused, "flaky");
    assert_eq!(
        paused["state"], "paused",
        "the escalation policy pauses: {paused}"
    );
    assert_eq!(flaky["status"], "error");
    let error = flaky["error"].as_str().unwrap_or_default();
    assert!(
        error.contains("thinking"),
        "the recorded error is the unsupported-thinking admission failure: {error}"
    );
    assert_eq!(
        state_report(&paused, "fixer")["entries_used"],
        0,
        "the fixer never started while paused"
    );
    let paused_milestones: Vec<&Value> = paused["events"]
        .as_array()
        .expect("events")
        .iter()
        .filter(|event| event["kind"] == "milestone" && event["milestone"] == "paused")
        .collect();
    assert_eq!(
        paused_milestones.len(),
        1,
        "the paused milestone is in the ledger"
    );

    // The resume completes the run: the fixer runs (the error settle fired
    // the guard-less flaky->fixer transition) and the run ends failed with
    // the recorded state error, matching the executor's escalate semantics.
    harness.prompt_and_wait("escalation-3", &session_id);
    let resumed = harness.await_receipt(label, "resume", Duration::from_mins(2));
    assert_eq!(
        resumed["resumed"]["state"], "running",
        "the resume un-pauses the run"
    );
    let final_status = harness.drive_to_state(
        label,
        &session_id,
        "poll",
        Duration::from_mins(8),
        |status| matches!(status["state"].as_str(), Some("done" | "failed")),
    );
    assert_eq!(
        final_status["state"], "failed",
        "a run with a state error reports failed: {final_status}"
    );
    let fixer = state_report(&final_status, "fixer");
    assert_eq!(fixer["status"], "done", "the fixer ran after the resume");
    assert_eq!(fixer["entries_used"], 1);
}

// -- scenario 4: stop() mid-run cancels through the real delete path ---------

#[test]
fn factory_stop_mid_run_cancels_the_child_over_the_real_delete_path() {
    let Some(kernel) = kernel_python() else {
        eprintln!("skipping: no factory-capable kernel python");
        return;
    };
    let mut harness = harness("stop", Some(&kernel));
    let label = "stop";
    let receipts = harness.receipts_dir(label);
    std::fs::create_dir_all(&receipts).expect("receipts dir");
    // The hold child's answer is delayed far past the stop, so the child is
    // in flight when stop() fires (the setup turn's boundary releases its
    // prompt; the stop turn lands seconds later, mid-delay).
    let setup = run_cell(
        "e2e-stop-mid-run",
        &receipts.join("run.json"),
        &receipts.join("run.error"),
    );
    let stop_code = format!(
        "import json, traceback\ntry:\n    run_id = json.load(open({run_receipt:?}))[\"run_id\"]\n    stopped = await rlm.factory.stop(run_id)\n    status = await rlm.factory.status(run_id)\n    open({receipt:?}, \"w\").write(json.dumps({{\"stopped\": stopped, \"status\": status}}))\nexcept Exception:\n    open({error_receipt:?}, \"w\").write(traceback.format_exc())\n    raise",
        run_receipt = receipts.join("run.json").display().to_string(),
        receipt = receipts.join("stop.json").display().to_string(),
        error_receipt = receipts.join("stop.error").display().to_string(),
    );
    let parent = write_script(
        &harness.root,
        "stop-parent.json",
        &driven_script(
            &[setup, stop_code],
            &["toolu-stop-run", "toolu-stop-stop"],
            "",
            20,
        ),
    );
    let child = write_script(
        &harness.root,
        "stop-child.json",
        &child_script("hold done", 30_000),
    );
    let (session_id, _session_uuid) = harness.create_parent(label, &parent, &child);

    harness.prompt_and_wait("stop-1", &session_id);
    let run = harness.await_receipt(label, "run", Duration::from_mins(2));
    assert_eq!(
        run["started"],
        json!(["hold"]),
        "admission starts the gated child"
    );
    harness.prompt_and_wait("stop-2", &session_id);
    let receipt = harness.await_receipt(label, "stop", Duration::from_mins(2));
    let stopped = &receipt["stopped"];
    assert_eq!(
        stopped["state"], "stopped",
        "stop() reports stopped: {receipt}"
    );
    let cancelled = stopped["cancelled"].as_array().expect("cancelled list");
    assert!(
        cancelled.iter().any(|entry| entry == "hold"),
        "the in-flight hold child is cancelled: {cancelled:?}"
    );
    let status = &receipt["status"];
    assert_eq!(status["state"], "stopped");
    let hold = state_report(status, "hold");
    assert_eq!(
        hold["status"], "cancelled",
        "the status reports the cancelled child"
    );
    assert_eq!(
        state_report(status, "after")["entries_used"],
        0,
        "the follow-up state never ran"
    );
    // The cancellation cascaded through the real rlm.delete_subagent path:
    // the child worker disappears from the supervisor roster.
    harness.wait_until_roster_drops(
        |summary| {
            summary["runtimeKind"] == "subagent"
                && summary["sessionName"]
                    .as_str()
                    .is_some_and(|name| name.contains("hold"))
        },
        Duration::from_secs(20),
    );
}

// -- scenario 5: the dag form through the compiler path ---------------------

#[test]
fn factory_dag_form_compiles_and_binds_through_the_real_bridge() {
    let Some(kernel) = kernel_python() else {
        eprintln!("skipping: no factory-capable kernel python");
        return;
    };
    let mut harness = harness("dag", Some(&kernel));
    let label = "dag";
    let receipts = harness.receipts_dir(label);
    std::fs::create_dir_all(&receipts).expect("receipts dir");
    let setup = run_cell(
        "e2e-dag-chain",
        &receipts.join("run.json"),
        &receipts.join("run.error"),
    );
    let poll_code = poll_code_for(&receipts);
    let parent = write_script(
        &harness.root,
        "dag-parent.json",
        &driven_script(&[setup], &["toolu-dag-run"], &poll_code, 60),
    );
    let child = write_script(
        &harness.root,
        "dag-child.json",
        &child_script("CHAIN-STEP-ANSWER", 30),
    );
    let (session_id, session_uuid) = harness.create_parent(label, &parent, &child);
    let status = harness.drive_to_state(
        label,
        &session_id,
        "poll",
        Duration::from_mins(8),
        |status| matches!(status["state"].as_str(), Some("done" | "failed")),
    );

    assert_eq!(
        status["state"], "done",
        "the compiled chain completes: {status}"
    );
    for node in ["alpha", "beta", "gamma"] {
        assert_eq!(
            state_report(&status, node)["status"],
            "done",
            "{node} settled"
        );
        assert_eq!(state_report(&status, node)["entries_used"], 1);
    }
    // The dag sugar compiled to machine form: the fired transitions are the
    // chain's effective edges (alpha->beta, beta->gamma).
    assert_eq!(status["usage"]["transitions_fired"], 2);
    // Typed input binding through the real bridge: beta's prompt carries
    // alpha's captured answer, gamma's carries beta's.
    let prompts = harness.child_prompts(&session_uuid);
    let beta: Vec<&String> = prompts
        .iter()
        .filter(|prompt| prompt.contains("E2E-STATE:BETA"))
        .collect();
    assert_eq!(beta.len(), 1);
    assert!(
        beta[0].contains("CHAIN-STEP-ANSWER"),
        "beta's prompt binds alpha's captured answer: {}",
        beta[0]
    );
    let gamma: Vec<&String> = prompts
        .iter()
        .filter(|prompt| prompt.contains("E2E-STATE:GAMMA"))
        .collect();
    assert_eq!(gamma.len(), 1);
    assert!(
        gamma[0].contains("CHAIN-STEP-ANSWER"),
        "gamma's prompt binds beta's captured answer: {}",
        gamma[0]
    );
}

// -- scenario 6: nonblocking admission ---------------------------------------

#[test]
fn factory_run_is_nonblocking_and_completes_in_the_background() {
    let Some(kernel) = kernel_python() else {
        eprintln!("skipping: no factory-capable kernel python");
        return;
    };
    let mut harness = harness("nonblocking", Some(&kernel));
    let label = "nonblocking";
    let receipts = harness.receipts_dir(label);
    std::fs::create_dir_all(&receipts).expect("receipts dir");
    // The gated child settles long after admission; the setup cell's
    // receipt records the early status taken immediately after `run`
    // returned (the nonblocking proof), then the drive loop polls to done.
    let setup = run_cell(
        "e2e-nonblocking",
        &receipts.join("run.json"),
        &receipts.join("run.error"),
    );
    let poll_code = poll_code_for(&receipts);
    let parent = write_script(
        &harness.root,
        "nonblocking-parent.json",
        &driven_script(&[setup], &["toolu-nonblocking-run"], &poll_code, 60),
    );
    let child = write_script(
        &harness.root,
        "nonblocking-child.json",
        &child_script("GATED-DONE", 8_000),
    );
    let (session_id, _session_uuid) = harness.create_parent(label, &parent, &child);

    // The setup turn: the run was admitted and the early status (taken
    // inside the cell, right after `run` returned) shows the child still
    // in flight — `run` returned before any child settled.
    harness.prompt_and_wait("nonblocking-1", &session_id);
    let run = harness.await_receipt(label, "run", Duration::from_mins(2));
    assert_eq!(
        run["started"],
        json!(["slowgate"]),
        "admission starts the gated child"
    );
    assert_eq!(
        run["early_state"], "running",
        "the run is still in flight right after run() returned (nonblocking): {run}"
    );
    // The run completes in the background while the parent's own turns go
    // on (the drive loop's polls observed the finished state, not a parent
    // wake: the notice lane is unported on this stack).
    let status = harness.drive_to_state(
        label,
        &session_id,
        "poll",
        Duration::from_mins(8),
        |status| matches!(status["state"].as_str(), Some("done" | "failed")),
    );
    assert_eq!(
        status["state"], "done",
        "the gated run completes in the background: {status}"
    );
    for node in ["slowgate", "final"] {
        assert_eq!(
            state_report(&status, node)["status"],
            "done",
            "{node} settled"
        );
    }
    let milestones: Vec<&Value> = status["events"]
        .as_array()
        .expect("events")
        .iter()
        .filter(|event| event["kind"] == "milestone" && event["milestone"] == "finished")
        .collect();
    assert_eq!(milestones.len(), 1);
    assert_ne!(
        milestones[0]["stage"], "shown",
        "the finished milestone stays in the ledger (the notice lane is unported)"
    );
}

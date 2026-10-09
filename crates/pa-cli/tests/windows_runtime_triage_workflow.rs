// large_futures: stack futures on hot paths by design. too_many_lines:
// style gate only.
#![allow(clippy::large_futures, clippy::too_many_lines)]

//! The windows-runtime-triage workflow's contract gates (the operator's
//! 2026-10-08 ask: "we need to give you an easy way to test things" - a
//! repeatable Windows test surface for the fleet). The workflow IS the
//! test surface, so this file pins its contract the same way
//! `release_workflow.rs` pins the release pipeline's:
//!
//!   - the PR trigger: every Windows-touched PR (crate source, the
//!     Windows installers, the workflow itself, the build manifests) runs
//!     the battery before review;
//!   - the nightly trigger: main gets the battery every night even when
//!     no PR touched it;
//!   - the `windows-runtime-tui-battery` job: the freshly-built binary
//!     driven through the three scripted TUI scenarios
//!     (`windows_runtime_triage_e2e.rs`), with the captured pane dumps
//!     uploaded as a run artifact (`if: always()` - the fleet reads the
//!     dumps from a red run too);
//!   - the runner pin: windows-2022, never the mutable `windows-latest`
//!     (the reviewed-baseline rule the release build already carries);
//!   - the deep `windows-battery` job stays the on-demand/nightly loop,
//!     not a per-PR gate (the full pa-cli e2e set runs past three hours
//!     on that runner - measured twice).
//!
//! The battery source file's three scenario tests are asserted by name, so
//! the workflow and the battery it claims to run cannot drift apart.

use std::fs;
use std::path::PathBuf;

/// The repo root (crates/pa-cli -> crates -> root): the workflow and the
/// battery live there.
fn repo_root() -> PathBuf {
    PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .ancestors()
        .nth(2)
        .map(PathBuf::from)
        .expect("worktree root")
}

/// The committed windows-runtime-triage workflow, parsed as YAML. YAML 1.1
/// readers may hand back the `on` key as a boolean (`true`), so the trigger
/// accessor handles both spellings.
fn workflow_yaml() -> (serde_yaml::Value, serde_yaml::Value) {
    let text = fs::read_to_string(repo_root().join(".github/workflows/windows-runtime-triage.yml"))
        .expect("read .github/workflows/windows-runtime-triage.yml");
    let workflow: serde_yaml::Value =
        serde_yaml::from_str(&text).expect("windows-runtime-triage.yml parses as YAML");
    let triggers = workflow
        .get("on")
        .or_else(|| workflow.get("true"))
        .cloned()
        .expect("the workflow declares its triggers");
    (workflow, triggers)
}

/// One job's definition by name.
fn job(workflow: &serde_yaml::Value, name: &str) -> serde_yaml::Value {
    workflow
        .get("jobs")
        .and_then(|jobs| jobs.get(name))
        .cloned()
        .unwrap_or_else(|| panic!("the workflow carries the {name:?} job"))
}

/// The steps' `run:` scripts of one job, in order.
fn step_runs(job: &serde_yaml::Value) -> Vec<String> {
    job.get("steps")
        .and_then(serde_yaml::Value::as_sequence)
        .map(|steps| {
            steps
                .iter()
                .map(|step| {
                    step.get("run")
                        .and_then(serde_yaml::Value::as_str)
                        .unwrap_or_default()
                        .to_string()
                })
                .collect()
        })
        .unwrap_or_default()
}

/// The battery's scenario test names: the workflow must drive exactly
/// these, and the battery file must keep defining them.
const SCENARIO_TESTS: [&str; 3] = [
    "tui_reopen_renders_the_old_history",
    "subagent_session_stays_a_distinct_store_entry",
    "agent_message_rows_dump_their_glyphs",
];

#[test]
fn the_battery_source_defines_the_three_scenarios() {
    let battery =
        fs::read_to_string(repo_root().join("crates/pa-cli/tests/windows_runtime_triage_e2e.rs"))
            .expect("read the battery source");
    for scenario in SCENARIO_TESTS {
        assert!(
            battery.contains(&format!("async fn {scenario}")),
            "the battery defines the {scenario} test"
        );
    }
    assert!(
        !battery.contains("#![cfg(unix)]"),
        "the battery is the Windows surface: a whole-file unix gate would skip it on windows"
    );
}

#[test]
fn the_pr_wave_runs_on_windows_touched_paths() {
    let (_, triggers) = workflow_yaml();
    let pull_request = triggers
        .get("pull_request")
        .expect("the workflow carries the pull_request trigger");
    let branches = pull_request
        .get("branches")
        .and_then(serde_yaml::Value::as_sequence)
        .expect("the pull_request trigger names its branches");
    assert!(
        branches
            .iter()
            .any(|branch| branch.as_str() == Some("main")),
        "the PR wave gates main: {branches:?}"
    );
    let paths = pull_request
        .get("paths")
        .and_then(serde_yaml::Value::as_sequence)
        .expect("the pull_request trigger carries a Windows-touched paths filter");
    let paths: Vec<&str> = paths.iter().filter_map(serde_yaml::Value::as_str).collect();
    assert!(
        paths.contains(&"crates/**"),
        "every crate-source PR is Windows-touched: {paths:?}"
    );
    assert!(
        paths
            .iter()
            .any(|path| path.ends_with("windows-runtime-triage.yml")),
        "workflow edits re-run the workflow: {paths:?}"
    );
    assert!(
        paths.contains(&"install.ps1"),
        "the Windows installer is Windows-touched: {paths:?}"
    );
}

#[test]
fn the_nightly_wave_runs_on_main() {
    let (_, triggers) = workflow_yaml();
    let schedule = triggers
        .get("schedule")
        .and_then(serde_yaml::Value::as_sequence)
        .expect("the workflow carries the nightly schedule");
    assert!(
        schedule.iter().any(|entry| entry.get("cron").is_some()),
        "a nightly cron entry exists: {schedule:?}"
    );
}

#[test]
fn the_dispatch_loop_stays_available() {
    let (_, triggers) = workflow_yaml();
    assert!(
        triggers.get("workflow_dispatch").is_some(),
        "the on-demand triage dispatch stays (the fast fix->push->dispatch loop)"
    );
}

#[test]
fn the_tui_battery_job_boots_the_binary_and_dumps_the_panes() {
    let (workflow, _) = workflow_yaml();
    let job = job(&workflow, "windows-runtime-tui-battery");

    // The runner pin: windows-2022, never the mutable windows-latest (the
    // reviewed-baseline rule the release build's job comment carries).
    let runs_on = job
        .get("runs-on")
        .and_then(serde_yaml::Value::as_str)
        .expect("the job pins its runner");
    assert_eq!(
        runs_on, "windows-2022",
        "the battery runs on the pinned image, not the mutable label"
    );

    // The contributor-trust gate: PR authors must be vouched (the ci.yml
    // trust job's own class - an unvouched author must not bill a
    // windows runner).
    let needs = job
        .get("needs")
        .map(|needs| match needs {
            serde_yaml::Value::Sequence(entries) => entries
                .iter()
                .filter_map(serde_yaml::Value::as_str)
                .collect::<Vec<_>>(),
            serde_yaml::Value::String(single) => vec![single.as_str()],
            _ => Vec::new(),
        })
        .unwrap_or_default();
    assert!(
        needs.contains(&"trust"),
        "the battery job needs the trust gate: {needs:?}"
    );
    let condition = job
        .get("if")
        .and_then(serde_yaml::Value::as_str)
        .expect("the job gates itself on the trust verdict");
    assert!(
        condition.contains("outputs.allowed == 'true'"),
        "the job runs only for allowed authors: {condition}"
    );
    assert!(
        condition.contains("draft"),
        "draft PRs do not bill the runner: {condition}"
    );

    // The freshly-built binary: the daemon the battery boots IS the
    // freshly-built binary, so the job builds it first.
    let runs = step_runs(&job);
    let build = runs
        .iter()
        .find(|run| run.contains("cargo build --locked -p pa-cli --bin prime-agent"))
        .expect("the job builds the freshly-built binary");
    assert!(
        build.contains("--target x86_64-pc-windows-msvc")
            || build.contains("-p pa-cli --bin prime-agent"),
        "the build step names the binary: {build}"
    );

    // Console mode regression; CI stdout may be redirected.
    runs.iter()
        .find(|run| run.contains("cargo test --locked -p pa-types --lib console"))
        .expect("the job runs the pa-types console battery on the runner");

    // The battery: the three scripted TUI scenarios, with the dump dir the
    // panes land in for the artifact.
    let battery = runs
        .iter()
        .find(|run| run.contains("--test windows_runtime_triage_e2e"))
        .expect("the job runs the windows_runtime_triage_e2e battery");
    assert!(
        battery.contains("cargo test --locked -p pa-cli"),
        "the battery runs locked: {battery}"
    );
    assert!(
        battery.contains("WINDOWS_RUNTIME_TRIAGE_DUMP_DIR"),
        "the battery writes its pane dumps to the artifact dir: {battery}"
    );

    // The panes ride the artifact: the icon dump the fleet downloads and
    // inspects, uploaded on red runs too.
    let steps = job
        .get("steps")
        .and_then(serde_yaml::Value::as_sequence)
        .expect("the job carries steps");
    let upload = steps
        .iter()
        .find(|step| {
            step.get("uses")
                .and_then(serde_yaml::Value::as_str)
                .is_some_and(|uses| uses.starts_with("actions/upload-artifact"))
        })
        .expect("the job uploads the pane dumps");
    let upload_if = upload
        .get("if")
        .and_then(serde_yaml::Value::as_str)
        .expect("the upload step carries its condition");
    assert!(
        upload_if.contains("always()"),
        "the dumps upload on red runs too: {upload_if}"
    );
    let upload_name = upload
        .get("with")
        .and_then(|with| with.get("name"))
        .and_then(serde_yaml::Value::as_str)
        .expect("the upload names its artifact");
    assert!(
        upload_name.starts_with("windows-tui-dumps-"),
        "the artifact is the windows-tui-dumps set: {upload_name}"
    );
    let upload_path = upload
        .get("with")
        .and_then(|with| with.get("path"))
        .and_then(serde_yaml::Value::as_str)
        .expect("the upload names its path");
    assert!(
        upload_path.contains("win-tui-dumps"),
        "the upload carries the dump dir: {upload_path}"
    );
}

#[test]
fn the_deep_battery_stays_off_the_pr_wave() {
    let (workflow, _) = workflow_yaml();
    let job = job(&workflow, "windows-battery");
    let condition = job
        .get("if")
        .and_then(serde_yaml::Value::as_str)
        .expect("the deep battery job keeps its dispatch/nightly gating");
    assert!(
        condition.contains("github.event_name != 'pull_request'"),
        "the deep battery (the multi-hour debug loop) must not bill on every PR: {condition}"
    );
}

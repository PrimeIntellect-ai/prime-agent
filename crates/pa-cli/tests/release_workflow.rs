// The Tier-C/D ruling (fleet-uniform, 2026-09-28): stack-resident futures
// by design on hot paths (boxing 130 fns is allocation-churn with zero
// correctness gain); the fn-length threshold is a style gate, not
// correctness (the harness fns are intentionally linear); 64-bit targets -
// the narrowing sits at OS/protocol boundaries where the values are
// bounded (pid syscalls, epoch/elapsed milliseconds, calendar math,
// guarded parses), and checked conversions would add panic paths where
// silent wrap was deliberate (the one genuinely-suspect family, args.rs's
// parse_positive_u32 lacking its u32::MAX bound, is flagged in the lane
// dossier for the conductor).
#![allow(
    clippy::large_futures,
    clippy::too_many_lines,
    clippy::cast_possible_truncation,
    clippy::cast_possible_wrap,
    clippy::cast_sign_loss,
    clippy::cast_precision_loss
)]

//! Release workflow assertion gates - the port of the TS repo's
//! `packages/coding-agent/test/release-workflow.test.ts` (TS PR #2319 for
//! bug #2265): the promote job's artifact-download layout must stay
//! deterministic no matter how many artifacts the build matrix uploaded.
//!
//! `actions/download-artifact@v8` (the pinned revision) places a single
//! artifact's files directly in `path` and only nests one directory per
//! artifact when the run uploaded more than one (`src/download-artifact.ts`:
//! the `artifacts.length === 1` branch of the download-path ternary). A
//! one-target release run would therefore land flat in `incoming/`, where the
//! promote gates iterate one directory per artifact - hash continuity would
//! silently verify zero archives and the merge would emit an empty manifest.
//! That is the release-side form of the TS bug: beta-only or stable-only
//! releases validating against a layout their validation step did not expect.
//!
//! The structural gates run everywhere. The behavior gates execute the
//! workflow's own step scripts against simulated downloads for both layout
//! modes (the port of the TS test's per-channel triad: production-only,
//! beta-only, both - here one target, five targets, none) and skip with a
//! logged reason where the box's python3 is below the floor the step
//! scripts need (python 3.12: the merge step unpacks with
//! `extractall(filter=)`; the promote runner's ubuntu-24.04 provides it).

use std::fmt::Write as _;
use std::fs;
use std::path::{Path, PathBuf};
use std::process::{Command, Output};

use serde::Deserialize;
use sha2::{Digest, Sha256};

/// The fixture version the assembled artifacts carry.
const VERSION: &str = "0.9.9";

/// The promote step that refuses archives a TS 0.9.8 updater would install.
const TS_GUARD_STEP: &str = "Refuse archives the TypeScript updater would install";

/// The promote step that checks the merged SHA256SUMS before anything is
/// attested, attached to the GitHub release, or uploaded to R2.
const CHECKSUM_STEP: &str = "Verify SHA256SUMS before attest, attach, or upload";

/// The current build matrix (release.yml's `build-gnu` + `build-darwin` +
/// `build-windows` jobs): the five standalone targets. The single-artifact
/// case stands in for a trimmed matrix; the five-target case is today's
/// full release.
const TARGETS: [&str; 5] = [
    "x86_64-unknown-linux-gnu",
    "aarch64-unknown-linux-gnu",
    "aarch64-apple-darwin",
    "x86_64-apple-darwin",
    "x86_64-pc-windows-msvc",
];

/// The release-platform alias (`assemble_artifacts.py` `TARGET_ALIASES`).
fn platform_alias(target: &str) -> &'static str {
    match target {
        "x86_64-unknown-linux-gnu" => "linux-x64",
        "aarch64-unknown-linux-gnu" => "linux-arm64",
        "aarch64-apple-darwin" => "darwin-arm64",
        "x86_64-apple-darwin" => "darwin-x64",
        "x86_64-pc-windows-msvc" => "win32-x64",
        _ => panic!("no fixture alias for target {target}"),
    }
}

/// The staged payload binary name for one target
/// (`assemble_artifacts.py` `binary_name_for_target`): the MSVC build
/// ships `prime-agent.exe`.
fn binary_name(target: &str) -> &'static str {
    match target {
        "x86_64-pc-windows-msvc" => "prime-agent.exe",
        _ => "prime-agent",
    }
}

/// The repo root (crates/pa-cli -> crates -> root): the workflows live there.
fn repo_root() -> PathBuf {
    PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .ancestors()
        .nth(2)
        .map(Path::to_path_buf)
        .expect("worktree root")
}

#[derive(Clone, Deserialize)]
struct Workflow {
    jobs: std::collections::BTreeMap<String, Job>,
}

#[derive(Clone, Deserialize)]
struct Job {
    #[serde(default)]
    steps: Vec<Step>,
}

#[derive(Clone, Deserialize)]
struct Step {
    name: Option<String>,
    uses: Option<String>,
    run: Option<String>,
    #[serde(default)]
    with: Option<serde_yaml::Value>,
}

/// The promote job's steps from the committed `.github/workflows/release.yml`.
fn promote_steps() -> Vec<Step> {
    let text = fs::read_to_string(repo_root().join(".github/workflows/release.yml"))
        .expect("read .github/workflows/release.yml");
    let workflow: Workflow = serde_yaml::from_str(&text).expect("release.yml parses as YAML");
    workflow
        .jobs
        .get("promote")
        .expect("release.yml carries the promote job")
        .steps
        .clone()
}

/// A step's position by its exact name.
fn step_position(steps: &[Step], name: &str) -> usize {
    steps
        .iter()
        .position(|step| step.name.as_deref() == Some(name))
        .unwrap_or_else(|| panic!("release.yml promote is missing the step {name:?}"))
}

/// The python3 interpreter when it is at least `min_version`, or None
/// otherwise (the behavior gates skip with a logged reason; the step
/// scripts are python heredocs). The merge step unpacks with
/// `tar.extractall(..., filter="data")`, a python 3.12 API - the
/// ubuntu-24.04 promote runner provides 3.12, bookworm ships 3.11 - so
/// the full-script gates need (3, 12) and the normalize-only zero-artifact
/// gate accepts any python 3.
fn python3_binary(min_version: (u8, u8)) -> Option<PathBuf> {
    let output = Command::new("python3").arg("--version").output();
    let Ok(status) = output else {
        return None;
    };
    if !status.status.success() {
        return None;
    }
    let version = String::from_utf8_lossy(&status.stdout).trim().to_owned();
    let digits: Vec<u8> = version
        .split_whitespace()
        .nth(1)
        .map(|rest| {
            rest.split('.')
                .filter_map(|part| part.parse::<u8>().ok())
                .take(2)
                .collect()
        })
        .unwrap_or_default();
    if digits.len() == 2 && (digits[0], digits[1]) >= min_version {
        Some(PathBuf::from("python3"))
    } else {
        eprintln!(
            "skipping: python3 {version} is below the {min_version:?} the promote step scripts need"
        );
        None
    }
}

/// Run one workflow step script (its committed `run:` text) in `cwd`.
fn run_step(cwd: &Path, step: &Step) -> Output {
    let script = step.run.as_deref().expect("the step carries a run script");
    Command::new("bash")
        .arg("-c")
        .arg(script)
        .current_dir(cwd)
        .output()
        .expect("bash executes the step script")
}

fn assert_success(output: &Output, step: &str) -> String {
    let stdout = String::from_utf8_lossy(&output.stdout).into_owned();
    let stderr = String::from_utf8_lossy(&output.stderr).into_owned();
    assert!(
        output.status.success(),
        "the promote step {step:?} failed\nstdout:\n{stdout}\nstderr:\n{stderr}"
    );
    stdout
}

fn assert_failure(output: &Output, step: &str) -> String {
    let stdout = String::from_utf8_lossy(&output.stdout).into_owned();
    let stderr = String::from_utf8_lossy(&output.stderr).into_owned();
    assert!(
        !output.status.success(),
        "the promote step {step:?} unexpectedly succeeded\nstdout:\n{stdout}\nstderr:\n{stderr}"
    );
    format!("{stdout}{stderr}")
}

fn sha256_file(path: &Path) -> String {
    let mut hasher = Sha256::new();
    hasher.update(fs::read(path).expect("read the fixture archive"));
    format!("{:x}", hasher.finalize())
}

/// One real (extractable) tar.gz archive: the staged payload binary
/// (`prime-agent` — or `prime-agent.exe` on the MSVC target) with
/// deterministic member metadata, the `assemble_artifacts.py` shape, plus
/// any `extra_members`.
fn write_fixture_tarball(out_path: &Path, payload_name: &str, extra_members: &[&str]) {
    let file = fs::File::create(out_path).expect("create the fixture archive");
    let encoder = flate2::write::GzEncoder::new(file, flate2::Compression::default());
    let mut archive = tar::Builder::new(encoder);
    let payload = VERSION.as_bytes().to_vec();
    for name in std::iter::once(payload_name).chain(extra_members.iter().copied()) {
        let mut header = tar::Header::new_gnu();
        header.set_size(payload.len() as u64);
        header.set_mode(0o755);
        header.set_uid(0);
        header.set_gid(0);
        header.set_mtime(0);
        header.set_cksum();
        archive
            .append_data(&mut header, name, payload.as_slice())
            .expect("stage the fixture payload");
    }
    archive
        .into_inner()
        .expect("finish the tar stream")
        .finish()
        .expect("finish the gzip stream");
}

/// One build-job artifact in `dir`: the tarball, its checksum line, and the
/// per-target manifest (`assemble_artifacts.py`'s schema). Returns the manifest
/// row the merged manifest must carry back.
fn write_artifact(dir: &Path, target: &str) -> serde_json::Value {
    write_artifact_with(dir, target, &[])
}

fn write_artifact_with(dir: &Path, target: &str, extra_members: &[&str]) -> serde_json::Value {
    fs::create_dir_all(dir).expect("create the artifact directory");
    // The archive name the channel contract requires: the PLATFORM ALIAS,
    // never the target triple (the update reader drops a triple-named row).
    let archive_name = format!("prime-agent-{VERSION}-{}.tar.gz", platform_alias(target));
    write_fixture_tarball(&dir.join(&archive_name), binary_name(target), extra_members);
    let sha256 = sha256_file(&dir.join(&archive_name));
    fs::write(
        dir.join("SHA256SUMS"),
        format!("{sha256}  {archive_name}\n"),
    )
    .expect("write the checksum line");
    let row = serde_json::json!({
        "version": format!("v{VERSION}"),
        "platform": platform_alias(target),
        "target": target,
        "file": archive_name,
        "sha256": sha256,
        "executableSha256": "0".repeat(64),
    });
    fs::write(
        dir.join("manifest.json"),
        serde_json::to_string_pretty(&serde_json::json!({
            "version": format!("v{VERSION}"),
            "binaries": [row],
        }))
        .expect("serialize the fixture manifest"),
    )
    .expect("write the fixture manifest");
    row
}

/// The merged manifest the merge step must produce for `rows`, with the
/// merge script's own ordering (binaries sorted by `file`).
fn expected_merged_manifest(rows: &[serde_json::Value]) -> serde_json::Value {
    let mut rows: Vec<serde_json::Value> = rows.to_vec();
    rows.sort_by(|a, b| a["file"].as_str().cmp(&b["file"].as_str()));
    serde_json::json!({"version": format!("v{VERSION}"), "binaries": rows})
}

/// The merged SHA256SUMS text the merge step must produce for `rows`.
fn expected_merged_sums(rows: &[serde_json::Value]) -> String {
    let mut rows: Vec<&serde_json::Value> = rows.iter().collect();
    rows.sort_by(|a, b| a["file"].as_str().cmp(&b["file"].as_str()));
    let mut sums = String::new();
    for row in rows {
        let _ = writeln!(
            sums,
            "{}  {}",
            row["sha256"].as_str().unwrap(),
            row["file"].as_str().unwrap()
        );
    }
    sums
}

/// Execute the normalize -> verify -> merge -> checksum chain in `cwd` and
/// return the normalize step's stdout plus the merged manifest the workflow
/// would attach.
fn run_promote_gates(cwd: &Path, steps: &[Step]) -> (String, serde_json::Value) {
    let normalize = &steps[step_position(
        steps,
        "Normalize download layout (single-artifact runs land flat)",
    )];
    let verify = &steps[step_position(
        steps,
        "Verify hash continuity (artifacts match build-job manifests)",
    )];
    let ts_guard = &steps[step_position(steps, TS_GUARD_STEP)];
    let merge = &steps[step_position(steps, "Merge per-target manifests + SHA256SUMS")];

    let normalize_stdout = assert_success(&run_step(cwd, normalize), "normalize download layout");
    let verify_stdout = assert_success(&run_step(cwd, verify), "verify hash continuity");
    assert!(
        verify_stdout.contains("hash continuity verified for all archives"),
        "hash continuity must report verifying the archives"
    );
    assert_success(&run_step(cwd, ts_guard), TS_GUARD_STEP);
    assert_success(&run_step(cwd, merge), "merge per-target manifests");
    assert_success(
        &run_step(cwd, &steps[step_position(steps, CHECKSUM_STEP)]),
        CHECKSUM_STEP,
    );

    let merged: serde_json::Value = serde_json::from_str(
        &fs::read_to_string(cwd.join("release-out/manifest.json"))
            .expect("read the merged manifest"),
    )
    .expect("parse the merged manifest");
    (normalize_stdout, merged)
}

/// The Windows build job's structural contract: the MSVC target builds on
/// its own runner (never inside build-gnu's linux container), the livecheck
/// names the `.exe` binary, promote needs the job, and the channel
/// completeness gate refuses a manifest that dropped a platform row.
#[test]
fn windows_build_job_contract() {
    let text = fs::read_to_string(repo_root().join(".github/workflows/release.yml"))
        .expect("read release.yml");
    let workflow: Workflow = serde_yaml::from_str(&text).expect("release.yml parses as YAML");
    let windows = workflow
        .jobs
        .get("build-windows")
        .expect("the build-windows job exists");
    assert!(
        windows.steps.iter().any(|step| {
            step.name.as_deref() == Some("Livecheck gate: --version prints the tag version")
                && step
                    .run
                    .as_deref()
                    .is_some_and(|run| run.contains("release/prime-agent.exe"))
        }),
        "the Windows livecheck must name the .exe binary Cargo's MSVC linker emits"
    );
    assert!(
        windows
            .steps
            .iter()
            .any(|step| step.run.as_deref().is_some_and(|run| {
                run.contains("cargo build --release --locked --target")
                    && !run.contains("dist/prime-agent")
            })),
        "the Windows build compiles the MSVC target (the split-debug step is linux-only)"
    );
    // promote's needs list and route gate must include build-windows (it
    // builds on both routes): the YAML schema of this test reads jobs'
    // steps; needs/if are asserted through the raw text (the Workflow
    // struct does not model them).
    assert!(
        text.contains("needs: [build-gnu, build-darwin, build-windows, reuse-continuous]")
            && text.contains("needs.build-windows.result == 'success'"),
        "promote must wait for the Windows build on both routes"
    );
    let promote = workflow
        .jobs
        .get("promote")
        .expect("the promote job exists");
    // The completeness gate: the emission refuses a missing platform row
    // (the platform list the installer reads must match the built set).
    let emit = promote
        .steps
        .iter()
        .find(|step| {
            step.name.as_deref()
                == Some("Emit the channel manifest (latest.json stable / beta.json nightly)")
        })
        .expect("the channel-manifest emission step exists")
        .run
        .as_deref()
        .expect("the emission runs a script");
    assert!(
        emit.contains("missing artifact rows"),
        "the emission must refuse a manifest missing a known platform's row"
    );
    // The R2 publish renders + serves the PowerShell installer pair.
    let publish = promote
        .steps
        .iter()
        .find(|step| step.name.as_deref() == Some("Publish the R2 channel"))
        .expect("the R2 publish step exists")
        .run
        .as_deref()
        .expect("the publish runs a script");
    assert!(
        publish.contains("render_installer_ps1") && publish.contains("install.ps1"),
        "the publish must render + serve the PowerShell installer pair"
    );
}

/// The structural gate: one count-independent download-all step, pinned to
/// `incoming`, followed by the normalize step before the per-artifact gates.
#[test]
fn promote_download_layout_contract() {
    let steps = promote_steps();

    let downloads: Vec<&Step> = steps
        .iter()
        .filter(|step| {
            step.uses
                .as_deref()
                .is_some_and(|uses| uses.starts_with("actions/download-artifact@"))
        })
        .collect();
    assert_eq!(
        downloads.len(),
        1,
        "the promote job must have exactly one artifact download"
    );
    let download = downloads[0];
    assert_eq!(
        download.name.as_deref(),
        Some("Download all build artifacts")
    );
    let with = download
        .with
        .as_ref()
        .expect("the download declares inputs");
    assert_eq!(
        with.get("path").and_then(serde_yaml::Value::as_str),
        Some("incoming"),
        "the download must target the promote job's incoming directory"
    );
    assert!(
        with.get("pattern").is_none(),
        "pattern downloads flip their layout on the match count (TS #2265 root cause)"
    );
    assert!(
        with.get("name").is_none(),
        "a named download would hardcode the moving build matrix"
    );
    assert_ne!(
        with.get("merge-multiple")
            .and_then(serde_yaml::Value::as_bool),
        Some(true),
        "merge-multiple would collide the per-target manifests and sums"
    );

    let download = step_position(&steps, "Download all build artifacts");
    let normalize = step_position(
        &steps,
        "Normalize download layout (single-artifact runs land flat)",
    );
    let verify = step_position(
        &steps,
        "Verify hash continuity (artifacts match build-job manifests)",
    );
    let merge = step_position(&steps, "Merge per-target manifests + SHA256SUMS");
    assert!(
        download < normalize && normalize < verify && verify < merge,
        "the layout must be normalized between the download and the per-artifact gates"
    );
    let ts_guard = step_position(&steps, TS_GUARD_STEP);
    assert!(
        normalize < ts_guard && ts_guard < merge,
        "the TS-updater gate must check every archive before anything is merged or published"
    );
}

/// The merged SHA256SUMS is checked in its own step right after the merge,
/// before the provenance attestation, the GitHub release attach (the
/// installer downloads from there), and the R2 publish.
#[test]
fn checksum_gate_runs_before_attest_attach_and_publish() {
    let steps = promote_steps();
    let checksum = step_position(&steps, CHECKSUM_STEP);
    assert!(
        steps[checksum]
            .run
            .as_deref()
            .is_some_and(|run| run.contains("(cd release-out && sha256sum --check SHA256SUMS)")),
        "the checksum step must check the merged SHA256SUMS"
    );
    let merge = step_position(&steps, "Merge per-target manifests + SHA256SUMS");
    let attest = step_position(&steps, "Attest build provenance (SLSA)");
    let attach = step_position(&steps, "Attach to GitHub release");
    let publish = step_position(&steps, "Publish the R2 channel");
    assert!(
        merge < checksum && checksum < attest && attest < attach && attach < publish,
        "the checksum gate must pass after the merge and before anything is attested, \
         attached, or uploaded"
    );
}

/// A merged archive whose bytes no longer match SHA256SUMS fails the
/// checksum gate.
#[test]
fn a_mismatched_archive_fails_the_checksum_gate() {
    let Some(_python3) = python3_binary((3, 12)) else {
        return;
    };
    let steps = promote_steps();
    let cwd = tempfile::tempdir().expect("scratch dir");
    let incoming = cwd.path().join("incoming");
    for target in &TARGETS[..2] {
        write_artifact(&incoming.join(format!("artifacts-{target}")), target);
    }
    run_promote_gates(cwd.path(), &steps);

    // The archive names carry the platform alias (the channel contract),
    // so the corruption must target the alias-named merged archive, not
    // the triple main's fixture layout never produced.
    let corrupted = format!(
        "prime-agent-{VERSION}-{}.tar.gz",
        platform_alias(TARGETS[1])
    );
    fs::write(cwd.path().join("release-out").join(&corrupted), b"corrupt")
        .expect("corrupt a merged archive");
    let output = assert_failure(
        &run_step(cwd.path(), &steps[step_position(&steps, CHECKSUM_STEP)]),
        CHECKSUM_STEP,
    );
    assert!(
        output.contains(&format!("{corrupted}: FAILED")),
        "the checksum gate must name the mismatched archive\n{output}"
    );
}

/// A TS 0.9.8 updater installs any archive that carries install.sh (plus
/// three other files the Rust archive lacks) into the TS layout. The promote
/// gate must refuse an archive with a root-level install.sh, and only that
/// root-level file: the same name deeper in the tree is not what TS reads.
#[test]
fn an_archive_with_a_root_install_sh_fails_the_ts_updater_gate() {
    let Some(_python3) = python3_binary((3, 0)) else {
        return;
    };
    let steps = promote_steps();
    let ts_guard = &steps[step_position(&steps, TS_GUARD_STEP)];

    let cwd = tempfile::tempdir().expect("scratch dir");
    let incoming = cwd.path().join("incoming");
    write_artifact(
        &incoming.join(format!("artifacts-{}", TARGETS[0])),
        TARGETS[0],
    );
    write_artifact_with(
        &incoming.join(format!("artifacts-{}", TARGETS[1])),
        TARGETS[1],
        &["skills/install.sh"],
    );
    let output = assert_success(&run_step(cwd.path(), ts_guard), TS_GUARD_STEP);
    assert!(output.contains("no archive carries the TypeScript installer layout"));

    write_artifact_with(
        &incoming.join(format!("artifacts-{}", TARGETS[2])),
        TARGETS[2],
        &["install.sh"],
    );
    let output = assert_failure(&run_step(cwd.path(), ts_guard), TS_GUARD_STEP);
    assert!(
        output.contains(&format!(
            "prime-agent-{VERSION}-{}.tar.gz: contains a root-level install.sh",
            platform_alias(TARGETS[2])
        )),
        "the gate must name the offending archive\n{output}"
    );
    assert!(
        !output.contains(platform_alias(TARGETS[1])),
        "a nested install.sh must not trip the gate\n{output}"
    );
}

/// A one-target release (the TS test's beta-only/stable-only case): the
/// single artifact lands flat in `incoming/`, and the gates must still
/// verify its hashes and attach a complete manifest for it.
#[test]
fn single_artifact_release_finds_the_downloaded_manifest() {
    let Some(_python3) = python3_binary((3, 12)) else {
        return;
    };
    let steps = promote_steps();
    let cwd = tempfile::tempdir().expect("scratch dir");
    let incoming = cwd.path().join("incoming");
    fs::create_dir_all(&incoming).expect("create incoming");

    // The pinned action's single-artifact layout: the files land flat.
    let row = write_artifact(&incoming, TARGETS[0]);
    assert!(
        incoming.join("manifest.json").is_file(),
        "fixture assumption: the single artifact lands flat"
    );

    let (normalize_stdout, merged) = run_promote_gates(cwd.path(), &steps);
    assert!(
        normalize_stdout.contains(
            "normalized the flat single-artifact layout into artifacts-x86_64-unknown-linux-gnu/"
        ),
        "the normalize step must hoist the flat layout into the artifact directory"
    );
    assert_eq!(
        merged,
        expected_merged_manifest(std::slice::from_ref(&row)),
        "the merged manifest must carry the single target's binary"
    );
    assert_eq!(
        fs::read_to_string(cwd.path().join("release-out/SHA256SUMS"))
            .expect("read the merged sums"),
        expected_merged_sums(std::slice::from_ref(&row)),
        "the merged sums must carry the single target's checksum line"
    );
    assert!(cwd
        .path()
        .join("release-unpacked/x86_64-unknown-linux-gnu/prime-agent")
        .is_file());
}

/// The full five-target release (the TS test's both-channels case): every
/// artifact arrives in its own named directory, the merged manifest must
/// carry all five binaries (the Windows row included), and every
/// platform's payload unpacks under its target triple with the staged
/// binary name (`prime-agent.exe` on the MSVC target).
#[test]
fn five_target_release_finds_all_downloaded_manifests() {
    let Some(_python3) = python3_binary((3, 12)) else {
        return;
    };
    let steps = promote_steps();
    let cwd = tempfile::tempdir().expect("scratch dir");
    let incoming = cwd.path().join("incoming");
    fs::create_dir_all(&incoming).expect("create incoming");

    // The pinned action's multi-artifact layout: one directory per artifact.
    let rows: Vec<serde_json::Value> = TARGETS
        .iter()
        .map(|target| {
            let dir = incoming.join(format!("artifacts-{target}"));
            let row = write_artifact(&dir, target);
            assert!(dir.join("manifest.json").is_file());
            row
        })
        .collect();

    let (normalize_stdout, merged) = run_promote_gates(cwd.path(), &steps);
    assert!(
        normalize_stdout.is_empty(),
        "the nested layout needs no normalization"
    );
    assert_eq!(
        merged,
        expected_merged_manifest(&rows),
        "the merged manifest must carry all five targets' binaries"
    );
    assert_eq!(
        fs::read_to_string(cwd.path().join("release-out/SHA256SUMS"))
            .expect("read the merged sums"),
        expected_merged_sums(&rows),
        "every target's checksum line must survive the merge"
    );
    for target in TARGETS {
        assert!(
            cwd.path()
                .join(format!("release-unpacked/{target}/{}", binary_name(target)))
                .is_file(),
            "the {target} payload unpacks with its staged binary name"
        );
    }
}

/// A release whose artifacts never arrived must fail loudly at the normalize
/// gate - never pass hash continuity having verified zero archives.
#[test]
fn zero_artifacts_fail_loudly_instead_of_verifying_nothing() {
    let Some(_python3) = python3_binary((3, 0)) else {
        return;
    };
    let steps = promote_steps();
    let cwd = tempfile::tempdir().expect("scratch dir");
    fs::create_dir_all(cwd.path().join("incoming")).expect("create incoming");

    let normalize = &steps[step_position(
        steps.as_slice(),
        "Normalize download layout (single-artifact runs land flat)",
    )];
    let output = assert_failure(
        &run_step(cwd.path(), normalize),
        "normalize download layout",
    );
    assert!(
        output.contains("no build artifacts downloaded"),
        "the normalize gate must name the missing artifacts"
    );
}

/// The publish step's guard (its script before the first upload) plus its
/// `render_installer` function, writing into `cwd` instead of `/tmp`.
fn publish_guard_and_render() -> String {
    let steps = promote_steps();
    let run = steps[step_position(&steps, "Publish the R2 channel")]
        .run
        .clone()
        .expect("the publish step carries a run script");
    let guard = run
        .split("RELEASE_PREFIX=")
        .next()
        .expect("the publish step uploads under RELEASE_PREFIX");
    let mut render = String::new();
    let mut inside = false;
    for line in run.lines() {
        inside = inside || line.trim() == "render_installer() {";
        if inside {
            render.push_str(&line.replace("/tmp/", "./"));
            render.push('\n');
            if line.trim() == "}" {
                break;
            }
        }
    }
    assert!(
        !render.is_empty(),
        "the publish step defines render_installer"
    );
    format!("{guard}\n{render}\nrender_installer stable\nrender_installer beta\n")
}

/// The official download base has ONE definition, install-rust.sh's
/// `DOWNLOAD_BASE_URL_DEFAULT`: pa-core's `DEFAULT_DOWNLOAD_BASE_URL`
/// equals it, the publish serves it unchanged in both rendered installers,
/// and a bucket whose public address differs refuses to publish before
/// anything is uploaded. The installer and the updater then agree on which
/// base's archives come from the GitHub release.
#[test]
fn the_official_download_base_has_one_definition() {
    let official = pa_core::update::installer::DEFAULT_DOWNLOAD_BASE_URL;
    let installer =
        fs::read_to_string(repo_root().join("install-rust.sh")).expect("read install-rust.sh");
    let default_line = format!("DOWNLOAD_BASE_URL_DEFAULT=\"{official}\"");
    assert!(
        installer.lines().any(|line| line == default_line),
        "install-rust.sh's DOWNLOAD_BASE_URL_DEFAULT must equal pa-core's DEFAULT_DOWNLOAD_BASE_URL"
    );
    let script = publish_guard_and_render();
    let publish = |public_base: &str| {
        let cwd = tempfile::tempdir().expect("scratch dir");
        fs::create_dir_all(cwd.path().join("verification-source")).expect("create checkout");
        fs::write(
            cwd.path().join("verification-source/install-rust.sh"),
            &installer,
        )
        .expect("copy the installer");
        let output = Command::new("bash")
            .arg("-c")
            .arg(&script)
            .current_dir(cwd.path())
            .env("R2_BUCKET", "bucket")
            .env("R2_ENDPOINT_URL", "https://r2.example.com")
            .env("R2_PUBLIC_BASE_URL", public_base)
            .output()
            .expect("bash executes the publish guard");
        (cwd, output)
    };

    for public_base in [official.to_string(), format!("{official}/")] {
        let (cwd, output) = publish(&public_base);
        assert_success(&output, "publish the R2 channel");
        for channel in ["stable", "beta"] {
            let rendered = fs::read_to_string(cwd.path().join(format!("install-{channel}.sh")))
                .expect("read the rendered installer");
            let expected = installer.replace(
                "\nRELEASE_CHANNEL_DEFAULT=\"stable\"\n",
                &format!("\nRELEASE_CHANNEL_DEFAULT={channel}\n"),
            );
            assert_eq!(
                rendered, expected,
                "the {channel} render must change only the channel default"
            );
        }
    }

    let (cwd, output) = publish("https://pub-another-bucket.r2.dev");
    let output = assert_failure(&output, "publish the R2 channel");
    assert!(
        output.contains("vars.R2_PUBLIC_BASE_URL"),
        "the refusal must name the mismatched variable: {output}"
    );
    assert!(
        !cwd.path().join("install-stable.sh").exists(),
        "a mismatched bucket must refuse before rendering anything"
    );
}

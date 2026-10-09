// large_futures: stack-resident futures on hot paths by design.
// too_many_lines: style gate, not correctness. Casts: 64-bit targets;
// narrowing sits at bounded OS/protocol boundaries.
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

/// The promote step that validates the archive contract of shipped TS updaters.
const NATIVE_COMPAT_STEP: &str = "Verify historical native updater compatibility";

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
    #[serde(default)]
    env: Option<serde_yaml::Value>,
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
/// otherwise (the behavior gates skip with a logged reason). The merge step
/// unpacks with `tar.extractall(..., filter="data")`, a python 3.12 API.
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
    if step.name.as_deref() == Some(NATIVE_COMPAT_STEP) {
        let scripts = cwd.join("verification-source/scripts/release");
        fs::create_dir_all(&scripts).expect("create verification source directory");
        fs::copy(
            repo_root().join("scripts/release/native_compat.py"),
            scripts.join("native_compat.py"),
        )
        .expect("copy the compatibility verifier from the checked-out release source");
    }
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

/// An extractable release archive with authentic historical installer assets.
/// `omitted_members` allows a regression case to remove a required file.
fn write_fixture_tarball(
    out_path: &Path,
    payload_name: &str,
    version: &str,
    omitted_members: &[&str],
) {
    let file = fs::File::create(out_path).expect("create the fixture archive");
    let encoder = flate2::write::GzEncoder::new(file, flate2::Compression::default());
    let mut archive = tar::Builder::new(encoder);
    let mut members = vec![
        (payload_name, version.as_bytes().to_vec()),
        (
            "package.json",
            serde_json::to_vec(&serde_json::json!({"name": "prime-agent", "version": version}))
                .expect("serialize package metadata"),
        ),
    ];
    if payload_name != "prime-agent.exe" {
        members.extend([
            (
                "install.sh",
                fs::read(repo_root().join("install-rust.sh")).expect("read the repair installer"),
            ),
            (
                "prime-agent-runtime/pyproject.toml",
                b"[project]\n".to_vec(),
            ),
            (
                "prime-agent-runtime/src/rlm/repl.py",
                b"# fixture runtime\n".to_vec(),
            ),
        ]);
        for name in [
            "theme/prime.json",
            "export-html/template.html",
            "photon_rs_bg.wasm",
            "PHOTON-LICENSE.md",
        ] {
            members.push((
                name,
                fs::read(repo_root().join("scripts/release/native-compat").join(name))
                    .expect("read the historical compatibility asset"),
            ));
        }
    }
    for (name, payload) in members {
        if omitted_members.contains(&name) {
            continue;
        }
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

/// One build-job artifact in `dir` (the `assemble_artifacts.py` schema):
/// the tarball, checksum line, and per-target manifest. Returns the row the merge must carry back.
fn write_artifact(dir: &Path, target: &str) -> serde_json::Value {
    write_artifact_with(dir, target, &[])
}

/// Run one workflow step script in `cwd` with extra environment variables
/// (the promote steps read the workflow's `env`; the emission step reads
/// `RELEASE_VERSION`, the tag the release cut runs under).
fn run_step_with_env(cwd: &Path, step: &Step, env: &[(&str, &str)]) -> Output {
    let script = step.run.as_deref().expect("the step carries a run script");
    let mut command = Command::new("bash");
    command.arg("-c").arg(script).current_dir(cwd);
    for (key, value) in env {
        command.env(key, value);
    }
    command.output().expect("bash executes the step script")
}

fn write_artifact_with(dir: &Path, target: &str, omitted_members: &[&str]) -> serde_json::Value {
    fs::create_dir_all(dir).expect("create the artifact directory");
    // The archive name the channel contract requires: the PLATFORM ALIAS,
    // never the target triple (the update reader drops a triple-named row).
    let archive_name = format!("prime-agent-{VERSION}-{}.tar.gz", platform_alias(target));
    write_fixture_tarball(
        &dir.join(&archive_name),
        binary_name(target),
        VERSION,
        omitted_members,
    );
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

/// One build-job artifact in `dir`, pinned to `version` (the consume route
/// restamps the continuous artifacts to the beta tag's version, so a
/// fixture tree must be able to carry any tag-shaped version).
fn write_artifact_version(dir: &Path, target: &str, version: &str) -> serde_json::Value {
    fs::create_dir_all(dir).expect("create the artifact directory");
    // The archive name the channel contract requires: the PLATFORM ALIAS,
    // never the target triple (the update reader drops a triple-named row).
    let archive_name = format!("prime-agent-{version}-{}.tar.gz", platform_alias(target));
    write_fixture_tarball(&dir.join(&archive_name), binary_name(target), version, &[]);
    let sha256 = sha256_file(&dir.join(&archive_name));
    fs::write(
        dir.join("SHA256SUMS"),
        format!("{sha256}  {archive_name}\n"),
    )
    .expect("write the checksum line");
    let row = serde_json::json!({
        "version": format!("v{version}"),
        "platform": platform_alias(target),
        "target": target,
        "file": archive_name,
        "sha256": sha256,
        "executableSha256": "0".repeat(64),
    });
    fs::write(
        dir.join("manifest.json"),
        serde_json::to_string_pretty(&serde_json::json!({
            "version": format!("v{version}"),
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

/// Execute the normalize -> verify -> merge chain in `cwd` and return the
/// normalize step's stdout plus the merged manifest the workflow would attach.
fn run_promote_gates(cwd: &Path, steps: &[Step]) -> (String, serde_json::Value) {
    let normalize = &steps[step_position(
        steps,
        "Normalize download layout (single-artifact runs land flat)",
    )];
    let verify = &steps[step_position(
        steps,
        "Verify hash continuity (artifacts match build-job manifests)",
    )];
    let ts_guard = &steps[step_position(steps, NATIVE_COMPAT_STEP)];
    let merge = &steps[step_position(steps, "Merge per-target manifests + SHA256SUMS")];

    let normalize_stdout = assert_success(&run_step(cwd, normalize), "normalize download layout");
    let verify_stdout = assert_success(&run_step(cwd, verify), "verify hash continuity");
    assert!(
        verify_stdout.contains("hash continuity verified for all archives"),
        "hash continuity must report verifying the archives"
    );
    assert_success(&run_step(cwd, ts_guard), NATIVE_COMPAT_STEP);
    assert_success(&run_step(cwd, merge), "merge per-target manifests");

    let merged: serde_json::Value = serde_json::from_str(
        &fs::read_to_string(cwd.join("release-out/manifest.json"))
            .expect("read the merged manifest"),
    )
    .expect("parse the merged manifest");
    (normalize_stdout, merged)
}

/// Native release jobs must exercise the current channel installer as well
/// as the retained TypeScript updater before their artifacts reach promotion.
#[test]
fn native_release_jobs_gate_fresh_and_legacy_installation() {
    let text = fs::read_to_string(repo_root().join(".github/workflows/release.yml"))
        .expect("read release.yml");
    let workflow: Workflow = serde_yaml::from_str(&text).expect("release.yml parses as YAML");
    for job_name in ["build-gnu", "build-darwin"] {
        let steps = &workflow.jobs.get(job_name).expect("native build job").steps;
        let fresh = step_position(steps, "Verify fresh channel install and reinstall");
        let legacy = step_position(steps, "Verify the shipped TypeScript update command");
        let upload = steps
            .iter()
            .position(|step| {
                step.uses
                    .as_deref()
                    .is_some_and(|uses| uses.starts_with("actions/upload-artifact@"))
            })
            .expect("artifact upload step");
        assert!(
            fresh < upload && legacy < upload,
            "installation gates precede artifact upload"
        );
        let run = steps[fresh]
            .run
            .as_deref()
            .expect("fresh installation script");
        assert!(run.contains("scripts/release/test_channel_install.py"));
        assert!(run.contains("--installer install-rust.sh"));
        assert!(run.contains("--archive") && run.contains("channel-install.json"));
    }
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
        .find(|step| {
            step.name.as_deref()
                == Some("Publish the R2 channel (the channel serves no GitHub URL)")
        })
        .expect("the R2 publish step exists")
        .run
        .as_deref()
        .expect("the publish runs a script");
    assert!(
        publish.contains("render_installer_ps1") && publish.contains("install.ps1"),
        "the publish must render + serve the PowerShell installer pair"
    );
}

/// The shipped Windows binary must link the STATIC VC runtime: the
/// MSVC target links vcruntime dynamically by default, the windows-2022
/// runner image carries vcruntime140.dll, and a stock Windows machine does
/// not - the dynamically linked launcher dies at process start
/// (0xC0000135, `STATUS_DLL_NOT_FOUND`, exit -1073741515) before main runs.
/// The operator hit exactly that on a real box (2026-10-06), so the
/// crt-static pin is the build step's own env: only the SHIPPED binary is
/// static, and never through Cargo.toml, whose dev builds stay dynamic.
#[test]
fn the_windows_build_links_the_static_vc_runtime() {
    let text = fs::read_to_string(repo_root().join(".github/workflows/release.yml"))
        .expect("read release.yml");
    let workflow: Workflow = serde_yaml::from_str(&text).expect("release.yml parses as YAML");
    let windows = workflow
        .jobs
        .get("build-windows")
        .expect("the build-windows job exists");
    let build = windows
        .steps
        .iter()
        .find(|step| {
            step.name.as_deref() == Some("Build (release, locked)")
                && step
                    .run
                    .as_deref()
                    .is_some_and(|run| run.contains("cargo build --release --locked"))
        })
        .expect("the build-windows job's Build step exists");
    let rustflags = build
        .env
        .as_ref()
        .and_then(|env| env.get("RUSTFLAGS"))
        .and_then(serde_yaml::Value::as_str)
        .expect("the Windows build step must set RUSTFLAGS");
    assert!(
        rustflags.contains("target-feature=+crt-static"),
        "the Windows build must link the static VC runtime (RUSTFLAGS carries target-feature=+crt-static), got: {rustflags}"
    );
    // The pin is the Windows build step's alone: the gnu and darwin release
    // builds stay exactly as they are (crt-static would trade their libc
    // contract for nothing a shipped binary needs).
    for job in ["build-gnu", "build-darwin"] {
        for step in &workflow.jobs.get(job).expect("job exists").steps {
            if let Some(run) = step.run.as_deref() {
                if run.contains("cargo build --release --locked") {
                    assert!(
                        !step
                            .env
                            .as_ref()
                            .and_then(|env| env.get("RUSTFLAGS"))
                            .and_then(serde_yaml::Value::as_str)
                            .is_some_and(|flags| flags.contains("crt-static")),
                        "crt-static is the Windows launcher's fix, never a gnu/darwin flag"
                    );
                }
            }
        }
    }
    // Dev builds stay dynamic: the pin lives in the release workflow alone,
    // never in Cargo.toml (whose every target and profile would go static).
    let cargo_toml = fs::read_to_string(repo_root().join("Cargo.toml")).expect("read Cargo.toml");
    assert!(
        !cargo_toml.contains("crt-static"),
        "crt-static belongs to the release workflow's Windows build step, not Cargo.toml: dev builds link the runtime dynamically"
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
    let ts_guard = step_position(&steps, NATIVE_COMPAT_STEP);
    assert!(
        normalize < ts_guard && ts_guard < merge,
        "the TS-updater gate must check every archive before anything is merged or published"
    );
}

/// The promote gate accepts a usable historical installer layout and rejects
/// an archive missing a required asset before any release is published.
#[test]
fn historical_native_updater_gate_requires_the_compatibility_assets() {
    let Some(_python3) = python3_binary((3, 9)) else {
        return;
    };
    let steps = promote_steps();
    let compat = &steps[step_position(&steps, NATIVE_COMPAT_STEP)];
    let cwd = tempfile::tempdir().expect("scratch dir");
    let incoming = cwd.path().join("incoming");
    for target in TARGETS {
        write_artifact(&incoming.join(format!("artifacts-{target}")), target);
    }
    let output = assert_success(&run_step(cwd.path(), compat), NATIVE_COMPAT_STEP);
    assert_eq!(
        output.matches("Native compatibility verified:").count(),
        TARGETS.len()
    );

    write_artifact_with(
        &incoming.join(format!("artifacts-{}", TARGETS[2])),
        TARGETS[2],
        &["theme/prime.json"],
    );
    let output = assert_failure(&run_step(cwd.path(), compat), NATIVE_COMPAT_STEP);
    assert!(
        output.contains("missing regular compatibility asset: theme/prime.json"),
        "the gate must name the missing compatibility asset\n{output}"
    );
}

/// A one-target release: the single artifact lands flat in `incoming/` and
/// the gates must still verify its hashes and attach a manifest.
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

/// A release whose artifacts never arrived must fail loudly at the normalize gate.
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

/// Production installer updates require a stable release on both platforms;
/// beta releases publish only the explicitly selected beta installer pair.
#[test]
fn production_installers_are_published_only_by_stable_releases() {
    let text = fs::read_to_string(repo_root().join(".github/workflows/release.yml"))
        .expect("read release.yml");
    let workflow: Workflow = serde_yaml::from_str(&text).expect("release.yml parses as YAML");
    let publish = workflow
        .jobs
        .get("promote")
        .expect("the promote job exists")
        .steps
        .iter()
        .find(|step| {
            step.name.as_deref()
                == Some("Publish the R2 channel (the channel serves no GitHub URL)")
        })
        .expect("the R2 publish step exists")
        .run
        .as_deref()
        .expect("the publish runs a script");
    // The route halves are delimited by their channel markers; each marker
    // names its block exactly once in the publish script.
    let beta_marker = "# THE BETA CHANNEL";
    let stable_marker = "# THE STABLE CHANNEL";
    let beta_start = publish
        .find(beta_marker)
        .expect("the publish names the beta channel block");
    let stable_start = publish
        .find(stable_marker)
        .expect("the publish names the stable channel block");
    let beta_block = &publish[beta_start..stable_start];
    let stable_block = &publish[stable_start..];
    assert!(
        beta_block.contains("render_installer beta")
            && beta_block.contains("aws s3 cp /tmp/install-beta.ps1")
            && beta_block.contains("aws s3 cp /tmp/install-beta.sh"),
        "the beta route keeps its own installer pair"
    );
    assert!(
        !beta_block.contains("aws s3 cp /tmp/install-stable.sh")
            && !beta_block.contains("aws s3 cp /tmp/install-stable.ps1"),
        "beta releases must preserve both production installers"
    );
    assert!(
        stable_block
            .contains(r#"aws s3 cp /tmp/install-stable.ps1 "s3://${R2_BUCKET}/install.ps1""#)
            && stable_block
                .contains(r#"aws s3 cp /tmp/install-stable.sh "s3://${R2_BUCKET}/install.sh""#),
        "stable releases publish both production installers"
    );
}

/// The channel-manifest emission, executed against a real merged fixture
/// tree (the python-in-workflow step): the win32-x64 row the build-windows
/// job contributed rides `binaries_v2` on BOTH channels, while the v1
/// `binaries` list keeps the TS-parity four (the platforms the TS
/// installer served). The live stable channel stays TS-only until the
/// first Rust stable cut re-publishes latest.json; this pins the
/// emission's half of that contract — when that cut lands, the stable
/// manifest carries the Windows row under `binaries_v2`.
#[test]
fn the_channel_manifest_carries_the_windows_row_on_both_channels() {
    let Some(_python3) = python3_binary((3, 12)) else {
        return;
    };
    let steps = promote_steps();
    let emit = &steps[step_position(
        &steps,
        "Emit the channel manifest (latest.json stable / beta.json nightly)",
    )];

    // The beta cut (the consume route's restamped shape: the artifacts
    // carry the beta tag's version): beta.json carries the Windows row.
    let beta_tag = "v0.9.9-beta.7";
    let cwd = tempfile::tempdir().expect("scratch dir");
    let incoming = cwd.path().join("incoming");
    fs::create_dir_all(&incoming).expect("create incoming");
    let rows: Vec<serde_json::Value> = TARGETS
        .iter()
        .map(|target| {
            write_artifact_version(
                &incoming.join(format!("artifacts-{target}")),
                target,
                beta_tag.trim_start_matches('v'),
            )
        })
        .collect();
    let (.., merged) = run_promote_gates(cwd.path(), &steps);
    let mut expected: Vec<serde_json::Value> = rows.clone();
    expected.sort_by(|a, b| a["file"].as_str().cmp(&b["file"].as_str()));
    assert_eq!(
        merged["binaries"],
        serde_json::json!(expected),
        "the merged manifest must carry all five targets' binaries"
    );
    let stdout = assert_success(
        &run_step_with_env(cwd.path(), emit, &[("RELEASE_VERSION", beta_tag)]),
        "emit the channel manifest",
    );
    assert!(
        stdout.contains("channel manifest beta.json: v0.9.9-beta.7, 5 artifacts"),
        "the emission must report all five artifacts\n{stdout}"
    );
    let document: serde_json::Value = serde_json::from_str(
        &fs::read_to_string(cwd.path().join("release-out/beta.json"))
            .expect("read the emitted beta.json"),
    )
    .expect("parse the emitted beta.json");
    assert_eq!(document["version"], "v0.9.9-beta.7");
    assert_eq!(document["package"], "prime-agent");
    assert_eq!(
        document["tarball"],
        "releases/v0.9.9-beta.7/prime-agent-0.9.9-beta.7.tgz"
    );
    let v2 = document["binaries_v2"]
        .as_array()
        .expect("binaries_v2 rows");
    assert_eq!(v2.len(), 5, "binaries_v2 carries every platform row");
    let win_row = v2
        .iter()
        .find(|row| row["platform"] == "win32-x64")
        .expect("the beta manifest carries the win32-x64 row");
    assert_eq!(
        win_row["file"], "prime-agent-0.9.9-beta.7-win32-x64.tar.gz",
        "the Windows row must use the channel naming contract"
    );
    let windows_row = rows
        .iter()
        .find(|row| row["platform"] == "win32-x64")
        .expect("the fixture carries the windows row");
    assert_eq!(
        win_row["sha256"], windows_row["sha256"],
        "the Windows row must carry the artifact's own checksum"
    );
    let v1 = document["binaries"].as_array().expect("v1 binaries rows");
    assert_eq!(
        v1.len(),
        4,
        "the v1 binaries list keeps the TS-parity platforms"
    );
    assert!(
        v1.iter().all(|row| row["platform"] != "win32-x64"),
        "the v1 binaries list never carries the Windows row"
    );

    // The stable cut (the build route's shape: the artifacts carry the
    // stable tag's version): latest.json carries the Windows row too.
    let stable_tag = format!("v{VERSION}");
    let cwd = tempfile::tempdir().expect("scratch dir");
    let incoming = cwd.path().join("incoming");
    fs::create_dir_all(&incoming).expect("create incoming");
    let rows: Vec<serde_json::Value> = TARGETS
        .iter()
        .map(|target| {
            write_artifact_version(
                &incoming.join(format!("artifacts-{target}")),
                target,
                VERSION,
            )
        })
        .collect();
    let (.., merged) = run_promote_gates(cwd.path(), &steps);
    let mut expected: Vec<serde_json::Value> = rows;
    expected.sort_by(|a, b| a["file"].as_str().cmp(&b["file"].as_str()));
    assert_eq!(
        merged["binaries"],
        serde_json::json!(expected),
        "the merged manifest must carry all five targets' binaries"
    );
    assert_success(
        &run_step_with_env(
            cwd.path(),
            emit,
            &[("RELEASE_VERSION", stable_tag.as_str())],
        ),
        "emit the channel manifest",
    );
    let document: serde_json::Value = serde_json::from_str(
        &fs::read_to_string(cwd.path().join("release-out/latest.json"))
            .expect("read the emitted latest.json"),
    )
    .expect("parse the emitted latest.json");
    assert_eq!(document["version"], stable_tag.as_str());
    assert_eq!(document["package"], "prime-agent");
    assert_eq!(
        document["tarball"],
        format!("releases/v{VERSION}/prime-agent-{VERSION}.tgz")
    );
    assert!(
        document["binaries_v2"]
            .as_array()
            .expect("binaries_v2 rows")
            .iter()
            .any(|row| row["platform"] == "win32-x64"),
        "the stable manifest carries the win32-x64 row in binaries_v2"
    );
    assert!(
        document["binaries"]
            .as_array()
            .expect("v1 binaries rows")
            .iter()
            .all(|row| row["platform"] != "win32-x64"),
        "the v1 binaries list keeps the TS-parity platforms on stable too"
    );
}

/// A tree that dropped the windows artifact (a skipped build-windows leg, a
/// build-job regression) must never publish a shrunken channel manifest:
/// the completeness gate refuses the release and names the missing
/// platform — a Windows install stranded on the old channel version is
/// worse than a failed cut.
#[test]
fn the_channel_manifest_refuses_a_release_missing_the_windows_row() {
    let Some(_python3) = python3_binary((3, 12)) else {
        return;
    };
    let steps = promote_steps();
    let emit = &steps[step_position(
        &steps,
        "Emit the channel manifest (latest.json stable / beta.json nightly)",
    )];
    let cwd = tempfile::tempdir().expect("scratch dir");
    let incoming = cwd.path().join("incoming");
    fs::create_dir_all(&incoming).expect("create incoming");
    // Four targets: the windows leg never uploaded its artifact.
    for target in TARGETS.iter().take(4) {
        write_artifact(&incoming.join(format!("artifacts-{target}")), target);
    }
    run_promote_gates(cwd.path(), &steps);
    let output = assert_failure(
        &run_step_with_env(
            cwd.path(),
            emit,
            &[("RELEASE_VERSION", format!("v{VERSION}").as_str())],
        ),
        "emit the channel manifest",
    );
    assert!(
        output.contains("the release is missing artifact rows for ['win32-x64']"),
        "the refusal must name the missing win32-x64 row\n{output}"
    );
}

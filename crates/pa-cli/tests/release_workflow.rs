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
//! beta-only, both - here one target, four targets, none) and skip with a
//! logged reason where the box has no python3, mirroring the extension-host
//! tests' node guard.

use std::fs;
use std::path::{Path, PathBuf};
use std::process::{Command, Output};

use serde::Deserialize;
use sha2::{Digest, Sha256};

/// The fixture version the assembled artifacts carry.
const VERSION: &str = "0.9.9";

/// The current build matrix (release.yml `build`): the four standalone
/// targets. The single-artifact case stands in for a trimmed matrix; the
/// four-target case is today's full release.
const TARGETS: [&str; 4] = [
    "x86_64-unknown-linux-gnu",
    "aarch64-unknown-linux-gnu",
    "aarch64-apple-darwin",
    "x86_64-apple-darwin",
];

/// The TS release-platform alias (assemble_artifacts.py `TARGET_ALIASES`).
fn platform_alias(target: &str) -> &'static str {
    match target {
        "x86_64-unknown-linux-gnu" => "linux-x64",
        "aarch64-unknown-linux-gnu" => "linux-arm64",
        "aarch64-apple-darwin" => "darwin-arm64",
        "x86_64-apple-darwin" => "darwin-x64",
        _ => panic!("no fixture alias for target {target}"),
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

/// The python3 interpreter, or None when the box has none (the behavior
/// gates skip; the step scripts are python heredocs).
fn python3_binary() -> Option<PathBuf> {
    let output = Command::new("python3").arg("--version").output();
    match output {
        Ok(status) if status.status.success() => Some(PathBuf::from("python3")),
        _ => None,
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

/// One real (extractable) tar.gz archive: the staged `prime-agent` payload
/// with deterministic member metadata, the assemble_artifacts.py shape.
fn write_fixture_tarball(out_path: &Path) {
    let file = fs::File::create(out_path).expect("create the fixture archive");
    let encoder = flate2::write::GzEncoder::new(file, flate2::Compression::default());
    let mut archive = tar::Builder::new(encoder);
    let payload = VERSION.as_bytes().to_vec();
    let mut header = tar::Header::new_gnu();
    header.set_size(payload.len() as u64);
    header.set_mode(0o755);
    header.set_uid(0);
    header.set_gid(0);
    header.set_mtime(0);
    header.set_cksum();
    archive
        .append_data(&mut header, "prime-agent", payload.as_slice())
        .expect("stage the fixture payload");
    archive
        .into_inner()
        .expect("finish the tar stream")
        .finish()
        .expect("finish the gzip stream");
}

/// One build-job artifact in `dir`: the tarball, its checksum line, and the
/// per-target manifest (assemble_artifacts.py's schema). Returns the manifest
/// row the merged manifest must carry back.
fn write_artifact(dir: &Path, target: &str) -> serde_json::Value {
    fs::create_dir_all(dir).expect("create the artifact directory");
    let archive_name = format!("prime-agent-{VERSION}-{target}.tar.gz");
    write_fixture_tarball(&dir.join(&archive_name));
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
        sums.push_str(&format!(
            "{}  {}\n",
            row["sha256"].as_str().unwrap(),
            row["file"].as_str().unwrap()
        ));
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
    let merge = &steps[step_position(steps, "Merge per-target manifests + SHA256SUMS")];

    let normalize_stdout = assert_success(&run_step(cwd, normalize), "normalize download layout");
    let verify_stdout = assert_success(&run_step(cwd, verify), "verify hash continuity");
    assert!(
        verify_stdout.contains("hash continuity verified for all archives"),
        "hash continuity must report verifying the archives"
    );
    assert_success(&run_step(cwd, merge), "merge per-target manifests");

    let merged: serde_json::Value = serde_json::from_str(
        &fs::read_to_string(cwd.join("release-out/manifest.json"))
            .expect("read the merged manifest"),
    )
    .expect("parse the merged manifest");
    (normalize_stdout, merged)
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
}

/// A one-target release (the TS test's beta-only/stable-only case): the
/// single artifact lands flat in `incoming/`, and the gates must still
/// verify its hashes and attach a complete manifest for it.
#[test]
fn single_artifact_release_finds_the_downloaded_manifest() {
    let Some(_python3) = python3_binary() else {
        eprintln!("skipping: python3 is not available (the promote scripts are python heredocs)");
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

/// The full four-target release (the TS test's both-channels case): every
/// artifact arrives in its own named directory, and the merged manifest
/// must carry all four binaries.
#[test]
fn four_target_release_finds_all_downloaded_manifests() {
    let Some(_python3) = python3_binary() else {
        eprintln!("skipping: python3 is not available (the promote scripts are python heredocs)");
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
        "the merged manifest must carry all four targets' binaries"
    );
    assert_eq!(
        fs::read_to_string(cwd.path().join("release-out/SHA256SUMS"))
            .expect("read the merged sums"),
        expected_merged_sums(&rows),
        "every target's checksum line must survive the merge"
    );
    for target in TARGETS {
        assert!(cwd
            .path()
            .join(format!("release-unpacked/{target}/prime-agent"))
            .is_file());
    }
}

/// A release whose artifacts never arrived must fail loudly at the normalize
/// gate - never pass hash continuity having verified zero archives.
#[test]
fn zero_artifacts_fail_loudly_instead_of_verifying_nothing() {
    let Some(_python3) = python3_binary() else {
        eprintln!("skipping: python3 is not available (the promote scripts are python heredocs)");
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

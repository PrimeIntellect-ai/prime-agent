#![cfg(unix)]
//! The release pipeline's channel-manifest producer, gated against the
//! update reader it feeds.
//!
//! The read side (`pa_core::update::release::latest_release`, the TS
//! `getLatestPiRelease` port) fetches `<download-base>/latest.json` (the
//! stable channel) or `<download-base>/beta.json` (the nightly channel)
//! and keeps an artifact row only when it satisfies the channel contract:
//! a known platform, `file == prime-agent-<version>-<platform>.tar.gz`,
//! and a 64-hex `sha256`. `.github/workflows/release.yml` is the producer
//! that publishes those manifests; these tests pin that producer the way
//! the TS repo pins its release workflow (`release-workflow.test.ts`):
//! parse the workflow, run the promote job's real step code against a
//! fixture tree, and prove the emitted manifest parses with the exact
//! reader (`parse_channel_manifest`) while the archive files it names
//! exist with the digests it claims.

use std::collections::BTreeMap;
use std::os::unix::fs::PermissionsExt;
use std::path::{Path, PathBuf};
use std::process::Command;

use pa_core::update::release::{
    parse_channel_manifest, sha256_hex, LatestRelease, ReleaseArtifact,
};

/// The workspace root (crates/pa-core -> crates -> root): the workflow and
/// the release scripts live there.
fn workspace_root() -> PathBuf {
    Path::new(env!("CARGO_MANIFEST_DIR"))
        .ancestors()
        .nth(2)
        .expect("the workspace root")
        .to_path_buf()
}

#[derive(serde::Deserialize)]
struct Workflow {
    #[serde(default)]
    concurrency: Option<Concurrency>,
    jobs: BTreeMap<String, Job>,
}

#[derive(serde::Deserialize)]
struct Concurrency {
    group: Option<String>,
}

#[derive(serde::Deserialize)]
struct Job {
    #[serde(default)]
    needs: Option<serde::de::IgnoredAny>,
    #[serde(default)]
    r#if: Option<String>,
    #[serde(default)]
    concurrency: Option<Concurrency>,
    steps: Vec<Step>,
}

#[derive(serde::Deserialize)]
struct Step {
    name: Option<String>,
    #[serde(default)]
    r#if: Option<String>,
    #[serde(default)]
    run: Option<String>,
    #[serde(default)]
    with: Option<With>,
}

#[derive(serde::Deserialize)]
struct With {
    #[serde(default)]
    files: Option<String>,
    #[serde(default)]
    prerelease: Option<String>,
}

fn load_workflow() -> (String, Workflow) {
    let text = std::fs::read_to_string(workspace_root().join(".github/workflows/release.yml"))
        .expect("read .github/workflows/release.yml");
    let workflow: Workflow =
        serde_yaml::from_str(&text).expect("release.yml parses as the expected schema");
    (text, workflow)
}

fn step<'a>(job: &'a Job, name: &str) -> &'a Step {
    job.steps
        .iter()
        .find(|step| step.name.as_deref() == Some(name))
        .unwrap_or_else(|| panic!("the workflow has no step named {name}"))
}

fn step_position(job: &Job, name: &str) -> usize {
    job.steps
        .iter()
        .position(|step| step.name.as_deref() == Some(name))
        .unwrap_or_else(|| panic!("the workflow has no step named {name}"))
}

/// Run one workflow `run:` block with bash in `cwd` (the TS
/// release-workflow test pattern: the real step code, fixture inputs).
fn run_step(script: &str, cwd: &Path, release_version: &str) -> std::process::Output {
    let path = cwd.join("step.sh");
    std::fs::write(&path, script).expect("write the step script");
    Command::new("bash")
        .arg("-e")
        .arg("-o")
        .arg("pipefail")
        .arg(&path)
        .current_dir(cwd)
        .env("RELEASE_VERSION", release_version)
        .output()
        .expect("run the workflow step with bash")
}

fn python(script: &Path, args: &[&std::ffi::OsStr]) -> std::process::Output {
    Command::new("python3")
        .arg(script)
        .args(args)
        .current_dir(workspace_root())
        .output()
        .expect("run the release script")
}

/// The platforms a fixture release carries: the four v1 installer
/// platforms, win32-x64 (known to the reader, v2-only), and a future
/// musl platform the reader skips.
const FIXTURE_PLATFORMS: &[&str] = &[
    "darwin-arm64",
    "darwin-x64",
    "linux-arm64",
    "linux-x64",
    "win32-x64",
    "linux-x64-musl",
];

/// Stage `release-out/` the way the promote job receives it: the merged
/// manifest plus one real fixture archive per row.
fn stage_merged_manifest(dir: &Path, version: &str, lying_file: bool) -> PathBuf {
    let out = dir.join("release-out");
    std::fs::create_dir_all(&out).expect("release-out");
    let mut rows = Vec::new();
    for platform in FIXTURE_PLATFORMS {
        let file = format!("prime-agent-{version}-{platform}.tar.gz");
        let payload = format!("fixture archive for {platform}");
        std::fs::write(out.join(&file), payload.as_bytes()).expect("fixture archive");
        rows.push(serde_json::json!({
            "version": format!("v{version}"),
            "platform": platform,
            "target": format!("triple-{platform}"),
            "file": if lying_file && *platform == "linux-x64" {
                format!("prime-agent-{version}-x86_64-unknown-linux-gnu.tar.gz")
            } else {
                file
            },
            "sha256": sha256_hex(payload.as_bytes()),
            "executableSha256": "e".repeat(64),
        }));
    }
    let merged = serde_json::json!({"version": format!("v{version}"), "binaries": rows});
    std::fs::write(
        out.join("manifest.json"),
        serde_json::to_string_pretty(&merged).expect("serialize the merged manifest"),
    )
    .expect("write the merged manifest");
    out
}

fn read_channel_manifest(out: &Path, name: &str) -> (Vec<u8>, serde_json::Value) {
    let path = out.join(name);
    let bytes = std::fs::read(&path).unwrap_or_else(|error| panic!("read {name}: {error}"));
    let json: serde_json::Value =
        serde_json::from_slice(&bytes).expect("the channel manifest is JSON");
    (bytes, json)
}

/// The channel-manifest emission step in release.yml's promote job.
fn channel_step_run(workflow: &Workflow) -> &str {
    let promote = workflow
        .jobs
        .get("promote")
        .expect("the promote job exists");
    step(
        promote,
        "Emit the channel manifest (latest.json stable / beta.json nightly)",
    )
    .run
    .as_deref()
    .expect("the channel-manifest step runs a script")
}

#[test]
fn the_workflow_wires_the_channel_manifest_producer() {
    let (text, workflow) = load_workflow();
    // The tag trigger accepts the stable pattern and the -beta* (nightly)
    // pattern the read side resolves (resolve_update_channel parity).
    assert!(
        text.contains("- \"v[0-9]+.[0-9]+.[0-9]+\""),
        "the stable tag trigger is missing"
    );
    assert!(
        text.contains("- \"v[0-9]+.[0-9]+.[0-9]+-beta*\""),
        "the nightly (-beta*) tag trigger is missing"
    );
    // The tag-check job refuses prereleases the reader would never install.
    let tag_check = workflow
        .jobs
        .get("tag-check")
        .expect("the tag-check job exists");
    let validate = step(tag_check, "Validate tag matches workspace version");
    let run = validate
        .run
        .as_deref()
        .expect("the tag check runs a script");
    assert!(
        run.contains("-beta*"),
        "the tag check does not gate the channel a prerelease publishes"
    );
    // The promote job emits the channel manifest between the manifest
    // merge and the release attach (the manifest must exist before attach,
    // after the merged rows exist).
    let promote = workflow
        .jobs
        .get("promote")
        .expect("the promote job exists");
    let merge = step_position(promote, "Merge per-target manifests + SHA256SUMS");
    let emit = step_position(
        promote,
        "Emit the channel manifest (latest.json stable / beta.json nightly)",
    );
    let attach = step_position(promote, "Attach to GitHub release");
    assert!(merge < emit && emit < attach);
    let emit_run = channel_step_run(&workflow);
    assert!(
        emit_run.contains("release-out/manifest.json"),
        "the emission reads the merged manifest"
    );
    assert!(
        emit_run.contains("RELEASE_VERSION"),
        "the emission decides the channel from the tag"
    );
    // The attach list must carry the channel manifest with a glob that
    // matches whichever name the tag published (exactly one of
    // latest.json/beta.json exists per release).
    let attach_step = step(promote, "Attach to GitHub release");
    let files = attach_step
        .with
        .as_ref()
        .and_then(|with| with.files.as_deref())
        .expect("the attach step lists files");
    assert!(files.contains("release-out/prime-agent-*.tar.gz"));
    assert!(files.contains("release-out/SHA256SUMS"));
    assert!(
        files.contains("release-out/*.json"),
        "the attach list must carry the channel manifest via a json glob"
    );
    // A -beta* tag attaches as a GitHub PRE-RELEASE so the nightly can never
    // take the Latest pointer; the stable channel's download base
    // (.../releases/latest/download/) keeps serving the last stable
    // release's latest.json (Bugbot: beta tags steal GitHub Latest).
    let prerelease = attach_step
        .with
        .as_ref()
        .and_then(|with| with.prerelease.as_deref())
        .expect("the attach step must decide prerelease-ness");
    assert_eq!(
        prerelease, "${{ contains(github.ref_name, '-') }}",
        "the attach step must mark prerelease-tag releases as prereleases"
    );
    // Every tag promotes under its own group: a queued promotion is never
    // canceled by another tag's push, so every published tag gets its
    // release (Bugbot: a shared group drops queued promotions).
    let group = workflow
        .concurrency
        .as_ref()
        .and_then(|concurrency| concurrency.group.as_deref())
        .expect("the workflow declares a concurrency group");
    assert_eq!(
        group, "release-${{ github.ref }}",
        "per-tag concurrency: promotions never queue-supersede each other"
    );
}

#[test]
fn the_rolling_nightly_refresh_is_a_serialized_job() {
    let (_, workflow) = load_workflow();
    let refresh = workflow
        .jobs
        .get("nightly-refresh")
        .expect("the nightly-refresh job exists");
    assert_eq!(
        refresh.r#if.as_deref(),
        Some("contains(github.ref_name, '-')"),
        "only -beta* tags refresh the rolling nightly release"
    );
    // The refresh is the workflow's only shared mutable state, so it alone
    // serializes (a queued refresh superseded by a newer tag is harmless:
    // the newest beta's refresh wins; no per-tag promotion is ever
    // canceled).
    assert_eq!(
        refresh
            .concurrency
            .as_ref()
            .and_then(|concurrency| concurrency.group.as_deref()),
        Some("rolling-nightly-refresh"),
        "the refresh serializes in its own group"
    );
    assert!(refresh.needs.is_some(), "the refresh needs the promote job");
    let run = step(refresh, "Refresh the rolling nightly release")
        .run
        .as_deref()
        .expect("the refresh step runs a script");
    assert!(run.contains("gh release upload nightly"), "{run}");
    assert!(run.contains("release-out/beta.json"), "{run}");
    assert!(run.contains("--clobber"), "{run}");
    assert!(run.contains("--prerelease"), "{run}");
    assert!(run.contains("release-out/prime-agent-*.tar.gz"), "{run}");
    // The newest-wins guard: re-runs of an older tag must never clobber a
    // newer rolling beta.json; gh release download's destination flag is
    // --dir (Bugbot: --output-dir was discarded and never wrote the guard
    // file).
    assert!(run.contains("sort -V"), "{run}");
    assert!(run.contains("skipping the refresh"), "{run}");
    assert!(run.contains(r#"--dir "$guard""#), "{run}");
    assert!(!run.contains("--output-dir"), "{run}");
    // The promote job hands the refresh its payload as an artifact.
    let promote = workflow
        .jobs
        .get("promote")
        .expect("the promote job exists");
    let payload = step(
        promote,
        "Upload the nightly refresh payload (the rolling release step consumes it)",
    );
    assert_eq!(
        payload.r#if.as_deref(),
        Some("contains(github.ref_name, '-')"),
        "only -beta* tags upload the refresh payload"
    );
}

#[test]
fn the_producer_emits_a_stable_manifest_the_reader_accepts() {
    let (_, workflow) = load_workflow();
    let emit_run = channel_step_run(&workflow);
    let fixture = tempfile::tempdir().expect("fixture dir");
    let out = stage_merged_manifest(fixture.path(), "1.2.3", false);

    let result = run_step(emit_run, fixture.path(), "v1.2.3");
    assert!(
        result.status.success(),
        "the emission step failed: {}",
        String::from_utf8_lossy(&result.stderr)
    );

    assert!(
        out.join("latest.json").is_file(),
        "stable tag -> latest.json"
    );
    assert!(
        !out.join("beta.json").exists(),
        "stable tag publishes no beta.json"
    );
    let (bytes, json) = read_channel_manifest(&out, "latest.json");
    assert_eq!(json["version"], "v1.2.3");
    let v1: Vec<&str> = json["binaries"]
        .as_array()
        .expect("the v1 binaries list")
        .iter()
        .map(|row| row["platform"].as_str().expect("platform"))
        .collect();
    // The v1 list stays limited to the original installer platforms (TS
    // manifestV1Platforms parity): win32-x64 and the musl platform are v2-only.
    assert_eq!(
        v1,
        ["darwin-arm64", "darwin-x64", "linux-arm64", "linux-x64"]
    );
    assert_eq!(json["binaries_v2"].as_array().expect("v2 list").len(), 6);

    // The byte compatibility assertion: the real reader parses the
    // producer's bytes and keeps every row it can verify.
    let release = parse_channel_manifest(&bytes).expect("the reader accepts the manifest");
    assert_eq!(release.version, "1.2.3");
    // The reader skips the unknown musl platform; the other five survive.
    assert_eq!(release.artifacts.len(), 5);
    assert_reader_artifacts_are_truthful(&release, &out);
}

#[test]
fn the_producer_emits_a_nightly_manifest_the_reader_accepts() {
    let (_, workflow) = load_workflow();
    let emit_run = channel_step_run(&workflow);
    let fixture = tempfile::tempdir().expect("fixture dir");
    let out = stage_merged_manifest(fixture.path(), "1.2.3-beta.1", false);

    let result = run_step(emit_run, fixture.path(), "v1.2.3-beta.1");
    assert!(
        result.status.success(),
        "the emission step failed: {}",
        String::from_utf8_lossy(&result.stderr)
    );

    assert!(out.join("beta.json").is_file(), "beta tag -> beta.json");
    assert!(
        !out.join("latest.json").exists(),
        "beta tag publishes no latest.json"
    );
    let (bytes, json) = read_channel_manifest(&out, "beta.json");
    assert_eq!(json["version"], "v1.2.3-beta.1");

    let release = parse_channel_manifest(&bytes).expect("the reader accepts the manifest");
    assert_eq!(release.version, "1.2.3-beta.1");
    assert_reader_artifacts_are_truthful(&release, &out);
}

#[test]
fn the_producer_refuses_rows_the_reader_rejects() {
    let (_, workflow) = load_workflow();
    let emit_run = channel_step_run(&workflow);
    let fixture = tempfile::tempdir().expect("fixture dir");
    // One row names the target triple instead of the platform alias: the
    // exact shape the reader would drop (and the producer must refuse).
    let out = stage_merged_manifest(fixture.path(), "1.2.3", true);

    let result = run_step(emit_run, fixture.path(), "v1.2.3");
    assert!(
        !result.status.success(),
        "the emission must fail on a row the reader rejects"
    );
    let stderr = String::from_utf8_lossy(&result.stderr);
    assert!(
        stderr.contains("the update reader rejects artifact row"),
        "the failure explains the contract: {stderr}"
    );
    assert!(
        stderr.contains("prime-agent-1.2.3-linux-x64.tar.gz"),
        "the failure names the file the reader expects: {stderr}"
    );
    assert!(
        !out.join("latest.json").exists(),
        "no channel manifest is published from rejected rows"
    );
}

/// Every artifact row the reader kept must name a real archive whose bytes
/// hash to the claimed digest (a manifest that lies is worse than none).
fn assert_reader_artifacts_are_truthful(release: &LatestRelease, out: &Path) {
    for artifact in &release.artifacts {
        let path = out.join(&artifact.file);
        let bytes = std::fs::read(&path)
            .unwrap_or_else(|error| panic!("archive {} exists: {error}", artifact.file));
        assert_eq!(
            sha256_hex(&bytes),
            artifact.sha256,
            "artifact {} carries its real digest",
            artifact.file
        );
        assert_eq!(
            artifact.file,
            format!(
                "prime-agent-{}-{}.tar.gz",
                release.version, artifact.platform
            )
        );
    }
}

#[test]
fn assembled_archives_carry_the_platform_alias_the_reader_demands() {
    let (_, workflow) = load_workflow();
    let emit_run = channel_step_run(&workflow);
    let fixture = tempfile::tempdir().expect("fixture dir");

    // A minimal repo tree the assembler accepts (the same shape
    // scripts/release/test_catalog_assets.py stages).
    let repo = fixture.path().join("synrepo");
    std::fs::create_dir_all(repo.join("prime-agent-runtime")).expect("runtime dir");
    std::fs::write(
        repo.join("prime-agent-runtime/pyproject.toml"),
        "# fixture\n",
    )
    .expect("runtime manifest");
    std::fs::create_dir_all(repo.join("skills")).expect("skills dir");
    std::fs::create_dir_all(repo.join("docs")).expect("docs dir");
    std::fs::write(repo.join("LICENSE"), "fixture license\n").expect("LICENSE");
    std::fs::write(repo.join("README.md"), "fixture readme\n").expect("README.md");
    let binary = repo.join("prime-agent");
    std::fs::write(&binary, "#!/bin/sh\necho 1.2.3\n").expect("fixture binary");
    std::fs::set_permissions(&binary, std::fs::Permissions::from_mode(0o755)).expect("exec bit");

    let scripts = workspace_root().join("scripts/release");
    let catalog = fixture.path().join("catalog-assets");
    let generated = python(
        &scripts.join("bundle_catalog.py"),
        &[
            "generate".as_ref(),
            "--fixture".as_ref(),
            "--out".as_ref(),
            catalog.as_os_str(),
        ],
    );
    assert!(
        generated.status.success(),
        "catalog fixture generation failed: {}",
        String::from_utf8_lossy(&generated.stderr)
    );

    let dist = fixture.path().join("dist");
    let assembled = python(
        &scripts.join("assemble_artifacts.py"),
        &[
            "--repo-root".as_ref(),
            repo.as_os_str(),
            "--version".as_ref(),
            "1.2.3".as_ref(),
            "--target".as_ref(),
            "x86_64-unknown-linux-gnu".as_ref(),
            "--binary".as_ref(),
            binary.as_os_str(),
            "--catalog-assets".as_ref(),
            catalog.as_os_str(),
            "--out-dir".as_ref(),
            dist.as_os_str(),
        ],
    );
    assert!(
        assembled.status.success(),
        "assemble_artifacts.py failed: {}",
        String::from_utf8_lossy(&assembled.stderr)
    );

    // The archive name is the platform alias the channel contract demands;
    // the target triple would be unreadable to the update flow.
    let archive = dist.join("prime-agent-1.2.3-linux-x64.tar.gz");
    assert!(archive.is_file(), "the alias-named archive exists");
    assert!(
        !dist
            .join("prime-agent-1.2.3-x86_64-unknown-linux-gnu.tar.gz")
            .exists(),
        "the triple-named archive must not be published"
    );
    let manifest: serde_json::Value = serde_json::from_str(
        &std::fs::read_to_string(dist.join("manifest.json")).expect("the per-target manifest"),
    )
    .expect("manifest.json is JSON");
    let row = &manifest["binaries"][0];
    assert_eq!(row["platform"], "linux-x64");
    assert_eq!(row["target"], "x86_64-unknown-linux-gnu");
    assert_eq!(row["file"], "prime-agent-1.2.3-linux-x64.tar.gz");
    let archive_bytes = std::fs::read(&archive).expect("read the archive");
    assert_eq!(row["sha256"], sha256_hex(&archive_bytes));

    // The full chain: the promote emission over the assembled row, then
    // the reader over the emitted manifest.
    let out = stage_merged_manifest(fixture.path(), "1.2.3", false);
    std::fs::copy(&archive, out.join("prime-agent-1.2.3-linux-x64.tar.gz"))
        .expect("stage the real archive");
    let merged = serde_json::json!({"version": "v1.2.3", "binaries": [row]});
    std::fs::write(
        out.join("manifest.json"),
        serde_json::to_string_pretty(&merged).expect("serialize"),
    )
    .expect("write the merged manifest");
    let result = run_step(emit_run, fixture.path(), "v1.2.3");
    assert!(
        result.status.success(),
        "the emission step failed: {}",
        String::from_utf8_lossy(&result.stderr)
    );
    let (bytes, json) = read_channel_manifest(&out, "latest.json");
    assert_eq!(json["version"], "v1.2.3");
    let release = parse_channel_manifest(&bytes).expect("the reader accepts the manifest");
    assert_eq!(release.version, "1.2.3");
    assert_eq!(release.artifacts.len(), 1);
    let artifact: &ReleaseArtifact = &release.artifacts[0];
    assert_eq!(artifact.platform, "linux-x64");
    assert_eq!(artifact.file, "prime-agent-1.2.3-linux-x64.tar.gz");
    assert_eq!(artifact.sha256, sha256_hex(&archive_bytes));
}

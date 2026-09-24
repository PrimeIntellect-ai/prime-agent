//! Kernel-packaging e2e: the packaged (exe-adjacent) release layout boots a
//! session with NO `PI_PACKAGE_DIR`, and the packaging script produces the
//! release artifact.
//!
//! The staged layout is the TS native packaging contract (install.sh +
//! copy-binary-assets.mjs): the binary plus `package.json` (the version
//! manifest), the `prime-agent-runtime/` sidecar, `skills/`, and `docs/`
//! beside it, all resolved at runtime from the executable's directory.

use std::path::{Path, PathBuf};
use std::process::Command;

/// The repo root (crates/pa-cli -> crates -> root): the vendored
/// prime-agent-runtime sidecar and skills live there.
fn repo_root() -> PathBuf {
    PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .ancestors()
        .nth(2)
        .map(Path::to_path_buf)
        .expect("worktree root")
}

/// These tests stage full packaged layouts and boot the kernel; they are
/// heavy and contend on a small box, so each one holds this lock for its
/// whole body.
static TEST_LOCK: std::sync::Mutex<()> = std::sync::Mutex::new(());

fn serial_lock() -> std::sync::MutexGuard<'static, ()> {
    match TEST_LOCK.lock() {
        Ok(guard) => guard,
        Err(poisoned) => poisoned.into_inner(),
    }
}

/// Stage the packaged layout into `dir`: the binary, the version manifest,
/// and the shipped assets. `with_runtime` controls whether the
/// prime-agent-runtime sidecar is present (the failure-UX scenario removes
/// it).
fn stage_packaged_layout(dir: &Path, with_runtime: bool) {
    std::fs::create_dir_all(dir).expect("stage dir");
    let binary = dir.join("prime-agent");
    std::fs::copy(env!("CARGO_BIN_EXE_prime-agent"), &binary).expect("copy binary");
    set_executable(&binary);
    std::fs::write(
        dir.join("package.json"),
        format!(
            r#"{{"name":"prime-agent","version":"{}","piConfig":{{"name":"prime-agent","configDir":".prime/agent"}}}}"#,
            env!("CARGO_PKG_VERSION")
        ),
    )
    .expect("version manifest");
    for asset in ["skills", "docs", "README.md"] {
        let source = repo_root().join(asset);
        let target = dir.join(asset);
        if source.is_dir() {
            copy_dir(&source, &target);
        } else {
            std::fs::copy(&source, &target).expect("copy asset");
        }
    }
    if with_runtime {
        copy_dir(
            &repo_root().join("prime-agent-runtime"),
            &dir.join("prime-agent-runtime"),
        );
    }
}

fn copy_dir(source: &Path, target: &Path) {
    std::fs::create_dir_all(target).expect("asset target dir");
    for entry in std::fs::read_dir(source).expect("read asset dir") {
        let entry = entry.expect("asset entry");
        let path = entry.path();
        let destination = target.join(entry.file_name());
        if path.is_dir() {
            std::fs::create_dir_all(&destination).expect("asset dir");
            copy_dir(&path, &destination);
        } else {
            std::fs::copy(&path, &destination).unwrap_or_else(|error| {
                panic!("copy asset file {path:?} -> {destination:?}: {error}")
            });
        }
    }
}

#[cfg(unix)]
fn set_executable(path: &Path) {
    use std::os::unix::fs::PermissionsExt;
    let mut permissions = std::fs::metadata(path)
        .expect("staged binary metadata")
        .permissions();
    permissions.set_mode(0o755);
    std::fs::set_permissions(path, permissions).expect("staged binary permissions");
}

#[cfg(not(unix))]
fn set_executable(path: &Path) {
    let _ = path;
}

/// The kernel Python with prime-agent-runtime installed (the interpreter the
/// TS product's kernel venv bootstraps). Skipped (with a note) on machines
/// without a live install; `PA_E2E_KERNEL_PYTHON` points at an explicit one.
fn kernel_python() -> Option<PathBuf> {
    if let Some(explicit) = std::env::var_os("PA_E2E_KERNEL_PYTHON") {
        let explicit = PathBuf::from(explicit);
        assert!(
            explicit.exists(),
            "PA_E2E_KERNEL_PYTHON {explicit:?} not found"
        );
        return Some(explicit);
    }
    let candidate = PathBuf::from(
        std::env::var("HOME")
            .map(|home| format!("{home}/.prime/agent/kernel-venv/bin/python"))
            .unwrap_or_else(|_| "/home/ubuntu/.prime/agent/kernel-venv/bin/python".to_string()),
    );
    if candidate.exists() {
        return Some(candidate);
    }
    eprintln!("kernel python {candidate:?} not found; skipping live kernel e2e");
    None
}

struct Sandbox {
    home: tempfile::TempDir,
    agent_dir: PathBuf,
    cwd: PathBuf,
}

fn sandbox() -> Sandbox {
    let home = tempfile::TempDir::new().expect("sandbox home");
    let agent_dir = home.path().join("agent");
    let cwd = home.path().join("work");
    std::fs::create_dir_all(&agent_dir).expect("agent dir");
    std::fs::create_dir_all(&cwd).expect("cwd");
    Sandbox {
        home,
        agent_dir,
        cwd,
    }
}

impl Sandbox {
    /// The packaged binary with a hermetic environment: sandboxed HOME and
    /// agent dir, no ambient `PI_PACKAGE_DIR`, no ambient API keys.
    fn command(&self, staged: &Path) -> Command {
        let mut command = Command::new(staged.join("prime-agent"));
        command
            .env("HOME", self.home.path())
            .env("PRIME_AGENT_CODING_AGENT_DIR", &self.agent_dir)
            .env_remove("PI_PACKAGE_DIR")
            .env_remove("PRIME_AGENT_SESSION_DIR")
            .env_remove("PRIME_AGENT_CODING_AGENT_SESSION_DIR")
            .env_remove("PRIME_API_KEY")
            .current_dir(&self.cwd);
        command
    }
}

/// The turn script: one ipython cell that proves the kernel runs, then the
/// closing text turn.
fn kernel_boot_script(receipt: &Path) -> serde_json::Value {
    let cell = format!(
        "import json\nfrom rlm import rlm as _r\npayload = {{\n  \"kernel_boot\": True,\n  \"rlm_available\": _r is not None,\n  \"spawn\": callable(_r.spawn),\n}}\nopen({receipt:?}, \"w\").write(json.dumps(payload))\nprint(\"KERNEL_BOOT_OK\")",
        receipt = receipt.display().to_string(),
    );
    serde_json::json!({
        "responses": [
            { "content": [ { "type": "toolCall", "name": "ipython", "arguments": {
                "code": cell,
            } } ] },
            // The next assistant message echoes the request's system prompt:
            // binary-level proof that the staged skills dir reached the
            // session's skill inventory.
            { "systemPrompt": true },
            { "text": "kernel boot verified" },
        ],
    })
}

fn run_json_turn(
    command: &mut Command,
    script: &serde_json::Value,
) -> (String, String, Option<i32>) {
    let output = command
        .arg("--mode")
        .arg("json")
        .arg("-p")
        .arg("use the kernel")
        .env("PRIME_AGENT_FAUX_SCRIPT", script.to_string())
        .output()
        .expect("run packaged binary");
    (
        String::from_utf8_lossy(&output.stdout).into_owned(),
        String::from_utf8_lossy(&output.stderr).into_owned(),
        output.status.code(),
    )
}

/// A packaged session boots the kernel with the exe-adjacent layout and no
/// `PI_PACKAGE_DIR`: the ipython cell runs through the staged binary, the
/// bundled skills resolve from the staged `skills/` directory, and the
/// staged version manifest reports the pinned version.
#[test]
fn packaged_session_boots_kernel_without_pi_package_dir() {
    let _guard = serial_lock();
    let Some(kernel_python) = kernel_python() else {
        return;
    };
    let dir = tempfile::TempDir::new().expect("stage dir");
    let staged = dir.path();
    stage_packaged_layout(staged, true);
    // A marker skill that exists ONLY in the staged layout: proves the
    // bundled skills resolved exe-adjacent (not from the source checkout).
    let marker = staged.join("skills").join("staged-packaging-marker");
    std::fs::create_dir_all(&marker).expect("marker skill dir");
    std::fs::write(
        marker.join("SKILL.md"),
        "---\nname: staged-packaging-marker\ndescription: Only in the staged layout\n---\nMarker.",
    )
    .expect("marker skill");

    let box_ = sandbox();
    let receipt = box_.home.path().join("kernel-receipt.json");
    let script = kernel_boot_script(&receipt);

    let mut command = box_.command(staged);
    command.env("PRIME_AGENT_KERNEL_PYTHON", &kernel_python);
    let (stdout, stderr, code) = run_json_turn(&mut command, &script);
    assert_eq!(code, Some(0), "stdout: {stdout}\nstderr: {stderr}");
    // The ipython tool result carried the cell output.
    assert!(
        stdout.contains("KERNEL_BOOT_OK"),
        "kernel cell output missing; stdout: {stdout}\nstderr: {stderr}"
    );
    // The receipt proves the cell executed with a live rlm surface.
    let payload: serde_json::Value =
        serde_json::from_str(&std::fs::read_to_string(&receipt).unwrap_or_default())
            .unwrap_or(serde_json::Value::Null);
    assert_eq!(
        payload["kernel_boot"],
        serde_json::Value::Bool(true),
        "receipt: {payload}"
    );
    assert_eq!(
        payload["rlm_available"],
        serde_json::Value::Bool(true),
        "receipt: {payload}"
    );
    assert_eq!(
        payload["spawn"],
        serde_json::Value::Bool(true),
        "receipt: {payload}"
    );
    // The staged marker skill reached the session's skill inventory.
    assert!(
        stdout.contains("staged-packaging-marker"),
        "staged skill missing from the session output; stdout: {stdout}"
    );
}

/// The staged version manifest reports the pinned version (TS `--version`
/// reads the packaged package.json at runtime).
#[test]
fn packaged_binary_reports_manifest_version() {
    let _guard = serial_lock();
    let dir = tempfile::TempDir::new().expect("stage dir");
    let staged = dir.path();
    stage_packaged_layout(staged, false);
    // A re-pinned manifest: the binary must report it, not the compiled-in
    // fallback.
    std::fs::write(
        staged.join("package.json"),
        r#"{"name":"prime-agent","version":"9.8.7-test"}"#,
    )
    .expect("version manifest");
    let box_ = sandbox();
    let output = box_
        .command(staged)
        .arg("--version")
        .output()
        .expect("run packaged binary");
    assert_eq!(output.status.code(), Some(0));
    assert_eq!(
        String::from_utf8_lossy(&output.stdout).trim(),
        "9.8.7-test",
        "the packaged manifest version must win"
    );
}

/// A missing sidecar (broken install) surfaces the actionable bootstrap
/// failure: the TS-matching base text plus the missing
/// prime-agent-runtime hint, not a raw uv/pip error.
#[test]
fn missing_sidecar_reports_actionable_bootstrap_error() {
    let _guard = serial_lock();
    let dir = tempfile::TempDir::new().expect("stage dir");
    let staged = dir.path();
    stage_packaged_layout(staged, false);
    let box_ = sandbox();
    let output = box_
        .command(staged)
        .arg("--prime-agent-bootstrap")
        // No uv anywhere the bootstrap looks (PATH and ~/.local/bin under
        // the sandboxed HOME), so the failure is the resolution error, not
        // an install attempt against the network.
        .env("PATH", "/usr/bin:/bin")
        .output()
        .expect("run packaged binary");
    assert_eq!(output.status.code(), Some(1));
    let stderr = String::from_utf8_lossy(&output.stderr);
    assert!(
        stderr.contains("Failed to set up the Python kernel runtime"),
        "TS bootstrap failure text missing: {stderr}"
    );
    assert!(
        stderr.contains("prime-agent-runtime directory was not found"),
        "missing-sidecar hint missing: {stderr}"
    );
    assert!(
        stderr.contains(staged.to_string_lossy().as_ref()),
        "the hint must name the executable directory: {stderr}"
    );
}

/// A `PRIME_AGENT_KERNEL_PYTHON` that lacks the runtime reports the
/// TS-matching override error (the existing UX path, asserted end to end
/// through the packaged binary).
#[test]
fn invalid_kernel_python_override_reports_ts_error() {
    let _guard = serial_lock();
    let dir = tempfile::TempDir::new().expect("stage dir");
    let staged = dir.path();
    stage_packaged_layout(staged, false);
    let box_ = sandbox();
    let bogus = box_.home.path().join("not-a-kernel-python");
    let output = box_
        .command(staged)
        .arg("--prime-agent-bootstrap")
        .env("PRIME_AGENT_KERNEL_PYTHON", &bogus)
        .output()
        .expect("run packaged binary");
    assert_eq!(output.status.code(), Some(1));
    let stderr = String::from_utf8_lossy(&output.stderr);
    assert!(
        stderr.contains("PRIME_AGENT_KERNEL_PYTHON points to a Python missing"),
        "TS override error missing: {stderr}"
    );
}

/// The packaging dry-run produces the release artifact: staged layout,
/// tarball, manifest, integrity sums — and no dev caches (a stale `.venv`
/// must not ride the artifact).
#[test]
fn packaging_dry_run_produces_artifact() {
    let _guard = serial_lock();
    if !Command::new("python3")
        .arg("--version")
        .output()
        .map(|o| o.status.success())
        .unwrap_or(false)
    {
        eprintln!("python3 not available; skipping the packaging dry-run e2e");
        return;
    }
    // A synthetic tree: the packaging must ship the sidecar without its
    // .venv or bytecode caches.
    let tree = tempfile::TempDir::new().expect("packaging tree");
    let runtime = tree.path().join("prime-agent-runtime");
    std::fs::create_dir_all(runtime.join("src").join("rlm")).expect("runtime tree");
    std::fs::write(runtime.join("pyproject.toml"), "[project]\nname = \"x\"\n").unwrap();
    std::fs::write(
        runtime.join("src").join("rlm").join("repl.py"),
        "def main():\n    pass\n",
    )
    .unwrap();
    std::fs::create_dir_all(runtime.join(".venv").join("lib")).expect("venv");
    std::fs::write(runtime.join(".venv").join("lib").join("stale.so"), "cache").unwrap();
    std::fs::create_dir_all(runtime.join("src").join("rlm").join("__pycache__")).expect("pycache");
    std::fs::write(
        runtime
            .join("src")
            .join("rlm")
            .join("__pycache__")
            .join("repl.pyc"),
        "cache",
    )
    .unwrap();
    let skills = tree.path().join("skills").join("greet");
    std::fs::create_dir_all(&skills).expect("skills tree");
    std::fs::write(
        skills.join("SKILL.md"),
        "---\nname: greet\ndescription: hi\n---\nHi.",
    )
    .unwrap();
    let docs = tree.path().join("docs");
    std::fs::create_dir_all(&docs).expect("docs tree");
    std::fs::write(docs.join("MODEL-SURFACE.md"), "# surface\n").unwrap();
    std::fs::write(tree.path().join("README.md"), "# readme\n").unwrap();
    std::fs::write(tree.path().join("LICENSE"), "Apache-2.0\n").unwrap();
    std::fs::write(
        tree.path().join("Cargo.toml"),
        "[workspace.package]\nversion = \"0.1.0\"\n",
    )
    .unwrap();

    // The bundled catalog assets (catalog port C): the packer hard-fails
    // without validated assets, so the dry-run generates the offline
    // fixture snapshot first (deterministic, stdlib-only — the same mode
    // the CI build jobs use) and passes it through.
    let assets = tempfile::TempDir::new().expect("catalog assets dir");
    let bundle = Command::new("python3")
        .arg(
            repo_root()
                .join("scripts")
                .join("release")
                .join("bundle_catalog.py"),
        )
        .arg("generate")
        .arg("--fixture")
        .arg("--out")
        .arg(assets.path())
        .output()
        .expect("generate the bundled catalog fixture");
    assert_eq!(
        bundle.status.code(),
        Some(0),
        "fixture generation failed: {}",
        String::from_utf8_lossy(&bundle.stderr)
    );

    let out = tempfile::TempDir::new().expect("packaging out dir");
    let result = Command::new("python3")
        .arg(repo_root().join("scripts").join("package_release.py"))
        .arg("--root")
        .arg(tree.path())
        .arg("--binary")
        .arg(env!("CARGO_BIN_EXE_prime-agent"))
        .arg("--catalog-assets")
        .arg(assets.path())
        .arg("--out-dir")
        .arg(out.path())
        .output()
        .expect("run the packaging script");
    assert_eq!(
        result.status.code(),
        Some(0),
        "packaging failed: {}",
        String::from_utf8_lossy(&result.stderr)
    );

    let version = env!("CARGO_PKG_VERSION");
    let stage = out.path().join(format!("prime-agent-{version}-linux-x64"));
    assert!(stage.join("prime-agent").is_file(), "staged binary missing");
    let manifest: serde_json::Value = serde_json::from_str(
        &std::fs::read_to_string(stage.join("package.json")).expect("version manifest"),
    )
    .expect("manifest json");
    assert_eq!(manifest["version"], version, "version pin: {manifest}");
    assert_eq!(manifest["piConfig"]["name"], "prime-agent");
    assert!(
        stage
            .join("prime-agent-runtime")
            .join("pyproject.toml")
            .is_file(),
        "sidecar manifest missing"
    );
    assert!(
        stage
            .join("prime-agent-runtime")
            .join("src")
            .join("rlm")
            .join("repl.py")
            .is_file(),
        "sidecar REPL entry point missing"
    );
    assert!(
        stage
            .join("skills")
            .join("greet")
            .join("SKILL.md")
            .is_file(),
        "skills missing"
    );
    assert!(stage.join("LICENSE").is_file(), "license missing");
    // The bundled catalog assets ride beside the executable (spec §3.2
    // layer 2: the runtime resolves <packageDir>/models.bundled.json).
    assert!(
        stage.join("models.bundled.json").is_file(),
        "bundled model catalog missing from the staged layout"
    );
    assert!(
        stage.join("mcp-services.bundled.json").is_file(),
        "bundled MCP service catalog missing from the staged layout"
    );
    // .venv handling (the TS installer exclusion set): dev caches never ship.
    assert!(
        !stage.join("prime-agent-runtime").join(".venv").exists(),
        ".venv rode the artifact"
    );
    assert!(
        !stage
            .join("prime-agent-runtime")
            .join("src")
            .join("rlm")
            .join("__pycache__")
            .exists(),
        "__pycache__ rode the artifact"
    );

    // Integrity: SHA256SUMS covers the tarball, binaries.json pins the
    // version and hashes, and the tarball lists the staged layout exactly.
    let archive = out
        .path()
        .join(format!("prime-agent-{version}-linux-x64.tar.gz"));
    assert!(archive.is_file(), "tarball missing");
    let sums = std::fs::read_to_string(out.path().join("SHA256SUMS")).expect("SHA256SUMS");
    let sha256 = sha256_file(&archive);
    assert!(
        sums.contains(&sha256),
        "SHA256SUMS does not cover the tarball"
    );
    let manifest: serde_json::Value = serde_json::from_str(
        &std::fs::read_to_string(out.path().join("binaries.json")).expect("binaries.json"),
    )
    .expect("binaries.json");
    assert_eq!(manifest["version"], format!("v{version}"));
    let binaries = manifest["binaries"].as_array().expect("binaries array");
    assert_eq!(binaries.len(), 1);
    assert_eq!(binaries[0]["sha256"], sha256.as_str());
    assert_eq!(binaries[0]["platform"], "linux-x64");
    let executable_sha = sha256_file(&stage.join("prime-agent"));
    assert_eq!(binaries[0]["executableSha256"], executable_sha.as_str());
}

fn sha256_file(path: &Path) -> String {
    // A tiny pure-std sha256 (the test dependency set stays minimal).
    let bytes = std::fs::read(path).expect("hash input");
    let digest = sha256(&bytes);
    digest.iter().map(|byte| format!("{byte:02x}")).collect()
}

/// SHA-256 (FIPS 180-4), pure std so the e2e needs no extra dev-dependency.
fn sha256(data: &[u8]) -> [u8; 32] {
    const K: [u32; 64] = [
        0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1, 0x923f82a4,
        0xab1c5ed5, 0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3, 0x72be5d74, 0x80deb1fe,
        0x9bdc06a7, 0xc19bf174, 0xe49b69c1, 0xefbe4786, 0x0fc19dc6, 0x240ca1cc, 0x2de92c6f,
        0x4a7484aa, 0x5cb0a9dc, 0x76f988da, 0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7,
        0xc6e00bf3, 0xd5a79147, 0x06ca6351, 0x14292967, 0x27b70a85, 0x2e1b2138, 0x4d2c6dfc,
        0x53380d13, 0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85, 0xa2bfe8a1, 0xa81a664b,
        0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070, 0x19a4c116,
        0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a, 0x5b9cca4f, 0x682e6ff3,
        0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208, 0x90befffa, 0xa4506ceb, 0xbef9a3f7,
        0xc67178f2,
    ];
    let mut h: [u32; 8] = [
        0x6a09e667, 0xbb67ae85, 0x3c6ef372, 0xa54ff53a, 0x510e527f, 0x9b05688c, 0x1f83d9ab,
        0x5be0cd19,
    ];
    let mut message = data.to_vec();
    let bit_length = (data.len() as u64).wrapping_mul(8);
    message.push(0x80);
    while message.len() % 64 != 56 {
        message.push(0);
    }
    message.extend_from_slice(&bit_length.to_be_bytes());
    for chunk in message.chunks(64) {
        let mut w = [0u32; 64];
        for (index, word) in chunk.chunks(4).enumerate() {
            w[index] = u32::from_be_bytes([word[0], word[1], word[2], word[3]]);
        }
        for index in 16..64 {
            let s0 = w[index - 15].rotate_right(7)
                ^ w[index - 15].rotate_right(18)
                ^ (w[index - 15] >> 3);
            let s1 = w[index - 2].rotate_right(17)
                ^ w[index - 2].rotate_right(19)
                ^ (w[index - 2] >> 10);
            w[index] = w[index - 16]
                .wrapping_add(s0)
                .wrapping_add(w[index - 7])
                .wrapping_add(s1);
        }
        let (mut a, mut b, mut c, mut d, mut e, mut f, mut g, mut hh) =
            (h[0], h[1], h[2], h[3], h[4], h[5], h[6], h[7]);
        for index in 0..64 {
            let s1 = e.rotate_right(6) ^ e.rotate_right(11) ^ e.rotate_right(25);
            let ch = (e & f) ^ ((!e) & g);
            let temp1 = hh
                .wrapping_add(s1)
                .wrapping_add(ch)
                .wrapping_add(K[index])
                .wrapping_add(w[index]);
            let s0 = a.rotate_right(2) ^ a.rotate_right(13) ^ a.rotate_right(22);
            let maj = (a & b) ^ (a & c) ^ (b & c);
            let temp2 = s0.wrapping_add(maj);
            hh = g;
            g = f;
            f = e;
            e = d.wrapping_add(temp1);
            d = c;
            c = b;
            b = a;
            a = temp1.wrapping_add(temp2);
        }
        h[0] = h[0].wrapping_add(a);
        h[1] = h[1].wrapping_add(b);
        h[2] = h[2].wrapping_add(c);
        h[3] = h[3].wrapping_add(d);
        h[4] = h[4].wrapping_add(e);
        h[5] = h[5].wrapping_add(f);
        h[6] = h[6].wrapping_add(g);
        h[7] = h[7].wrapping_add(hh);
    }
    let mut digest = [0u8; 32];
    for (index, word) in h.iter().enumerate() {
        digest[index * 4..index * 4 + 4].copy_from_slice(&word.to_be_bytes());
    }
    digest
}

/// Heavy (network + uv): the packaged sidecar bootstraps a fresh kernel venv
/// with no `PRIME_AGENT_KERNEL_PYTHON` and no `PI_PACKAGE_DIR`, then boots a
/// session on it. Run explicitly:
/// `cargo test -p pa-cli --test packaged_layout_e2e -- --ignored`
#[test]
#[ignore = "network + uv bootstrap (~minutes); the lane verifier runs it explicitly"]
fn bootstrap_kernel_venv_from_packaged_sidecar() {
    let dir = tempfile::TempDir::new().expect("stage dir");
    let staged = dir.path();
    stage_packaged_layout(staged, true);
    let box_ = sandbox();
    let venv = box_.home.path().join("kernel-venv");

    // --prime-agent-bootstrap (the installer handoff) builds the venv from
    // the exe-adjacent sidecar.
    let output = box_
        .command(staged)
        .arg("--prime-agent-bootstrap")
        .env("PRIME_AGENT_KERNEL_VENV", &venv)
        .output()
        .expect("run packaged binary");
    assert_eq!(
        output.status.code(),
        Some(0),
        "bootstrap failed: {}",
        String::from_utf8_lossy(&output.stderr)
    );
    let stdout = String::from_utf8_lossy(&output.stdout);
    assert!(
        stdout.contains("kernel python:"),
        "bootstrap stdout: {stdout}"
    );
    let venv_python = venv.join("bin").join("python");
    assert!(venv_python.exists(), "kernel venv python missing");

    // A session boots on the fresh venv: the same kernel-cell proof as the
    // ambient-venv test, this time without any kernel python override.
    let receipt = box_.home.path().join("kernel-receipt.json");
    let script = kernel_boot_script(&receipt);
    let mut command = box_.command(staged);
    command.env("PRIME_AGENT_KERNEL_VENV", &venv);
    let (stdout, stderr, code) = run_json_turn(&mut command, &script);
    assert_eq!(code, Some(0), "stdout: {stdout}\nstderr: {stderr}");
    assert!(
        stdout.contains("KERNEL_BOOT_OK"),
        "kernel cell output missing; stdout: {stdout}\nstderr: {stderr}"
    );
    let payload: serde_json::Value =
        serde_json::from_str(&std::fs::read_to_string(&receipt).unwrap_or_default())
            .unwrap_or(serde_json::Value::Null);
    assert_eq!(
        payload["kernel_boot"],
        serde_json::Value::Bool(true),
        "receipt: {payload}"
    );
}

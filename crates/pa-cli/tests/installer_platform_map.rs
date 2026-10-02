//! The installer's platform map, pinned against the script's own text:
//! the uname rows install-rust.sh resolves (the MSYS/Cygwin/MINGW Windows
//! arm included) and the Windows contract install.ps1 serves. The map is
//! the load-bearing seam the mission names — a user on an unsupported
//! machine must see the honest refusal, and a Windows user (Git Bash,
//! MSYS2, Cygwin) must land on the MSVC build's win32-x64 channel row.
//!
//! The detection block is EXTRACTED from install-rust.sh and driven through
//! `sh` with a stubbed uname (the release-workflow test pattern: the real
//! step code, fixture inputs), so the pin holds the shipped text, not a
//! copy of it.

#![cfg(unix)]

use std::path::{Path, PathBuf};
use std::process::{Command, Output};

/// The repo root (crates/pa-cli -> crates -> root): install-rust.sh and
/// install.ps1 live there.
fn repo_root() -> PathBuf {
    PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .ancestors()
        .nth(2)
        .map(Path::to_path_buf)
        .expect("worktree root")
}

/// The script's platform-detection block, verbatim: from the uname reads
/// through the `BINARY_NAME` if/else.
fn platform_block(script: &str) -> String {
    let text =
        std::fs::read_to_string(repo_root().join(script)).expect("read the installer script");
    let start = text.find("OS=\"$(uname -s)\"").expect("the uname -s read");
    let name_at = start
        + text[start..]
            .find("BINARY_NAME=")
            .expect("the BINARY_NAME block");
    let fi_at = name_at + text[name_at..].find("\nfi\n").expect("the block's fi");
    text[start..fi_at + "\nfi".len()].to_string()
}

/// Drive the extracted block under `sh` with one fake uname pair; the
/// harness stubs `die` (the full script's function) and prints the
/// resolved map row.
fn detect(os: &str, arch: &str) -> Output {
    let block = platform_block("install-rust.sh");
    let harness = format!(
        "#!/bin/sh\n\
         die() {{ printf '%s\n' \"$1\" >&2; exit 1; }}\n\
         uname() {{\n\
         \x20 case \"$1\" in\n\
         \x20   -s) printf '%s\\n' \"$FAKE_OS\" ;;\n\
         \x20   -m) printf '%s\\n' \"$FAKE_ARCH\" ;;\n\
         \x20   *) printf 'stub\\n' ;;\n\
         \x20 esac\n\
         }}\n\
         {block}\n\
         printf '%s|%s|%s|%s\\n' \"$TARGET\" \"$CHANNEL_PLATFORM\" \"$WINDOWS\" \"$BINARY_NAME\"\n"
    );
    let dir = tempfile::tempdir().expect("scratch dir");
    let path = dir.path().join("harness.sh");
    std::fs::write(&path, harness).expect("write the harness");
    Command::new("sh")
        .arg(&path)
        .env("FAKE_OS", os)
        .env("FAKE_ARCH", arch)
        .output()
        .expect("run the detection harness")
}

fn map_row(output: &Output) -> String {
    String::from_utf8_lossy(&output.stdout).trim().to_string()
}

/// The five published platforms resolve to their channel rows; the Windows
/// uname family (Git Bash, MSYS2, Cygwin) lands on the MSVC build with the
/// `.exe` binary name.
#[test]
fn the_uname_map_resolves_the_published_platforms() {
    let cases = [
        (
            "Darwin",
            "arm64",
            "aarch64-apple-darwin|darwin-arm64|no|prime-agent",
        ),
        (
            "Darwin",
            "x86_64",
            "x86_64-apple-darwin|darwin-x64|no|prime-agent",
        ),
        (
            "Linux",
            "x86_64",
            "x86_64-unknown-linux-gnu|linux-x64|no|prime-agent",
        ),
        (
            "Linux",
            "aarch64",
            "aarch64-unknown-linux-gnu|linux-arm64|no|prime-agent",
        ),
        (
            "MINGW64_NT-10.0-19045",
            "x86_64",
            "x86_64-pc-windows-msvc|win32-x64|yes|prime-agent.exe",
        ),
        (
            "MSYS_NT-10.0-19045",
            "x86_64",
            "x86_64-pc-windows-msvc|win32-x64|yes|prime-agent.exe",
        ),
        (
            "CYGWIN_NT-10.0-19045",
            "x86_64",
            "x86_64-pc-windows-msvc|win32-x64|yes|prime-agent.exe",
        ),
    ];
    for (os, arch, expected) in cases {
        let output = detect(os, arch);
        assert!(
            output.status.success(),
            "the {os}:{arch} row must resolve: {}",
            String::from_utf8_lossy(&output.stderr)
        );
        assert_eq!(map_row(&output), expected, "the {os}:{arch} row");
    }
}

/// An unsupported machine gets the honest refusal: the full matrix — the
/// MSVC build named — plus the Windows entry points, so the die tells the
/// user exactly what ships.
#[test]
fn the_uname_map_refuses_unsupported_machines_with_the_matrix() {
    for (os, arch) in [
        ("Windows_NT", "x86_64"),
        ("MINGW32_NT-10.0-19045", "i686"),
        ("FreeBSD", "amd64"),
    ] {
        let output = detect(os, arch);
        assert!(!output.status.success(), "the {os}:{arch} pair must refuse");
        let stderr = String::from_utf8_lossy(&output.stderr);
        assert!(
            stderr.contains("no rust build is published for"),
            "the {os}:{arch} refusal names the gap: {stderr}"
        );
        assert!(
            stderr.contains("x86_64-pc-windows-msvc"),
            "the refusal names the Windows build: {stderr}"
        );
        assert!(
            stderr.contains("install.ps1"),
            "the refusal names the Windows-native installer: {stderr}"
        );
    }
}

/// install.ps1's Windows contract: the win32-x64 channel row (the TS
/// `NATIVE_PLATFORMS` spelling the manifest reader keeps), the ARM64
/// refusal, and the two render lines the release pipeline's publish step
/// stamps (the sed + grep contract in release.yml's promote job).
#[test]
fn install_ps1_carries_the_windows_contract() {
    let text = std::fs::read_to_string(repo_root().join("install.ps1")).expect("read install.ps1");
    // The channel row.
    assert!(
        text.contains("$platform = 'win32-x64'"),
        "the ps1 serves win32-x64"
    );
    assert!(
        text.contains("prime-agent-$version-$platform.tar.gz"),
        "the ps1 validates the channel-named artifact row"
    );
    // The arch refusal: an ARM64 Windows machine fails loudly.
    assert!(
        text.contains("PROCESSOR_ARCHITECTURE") && text.contains("build only"),
        "the ps1 refuses non-x86_64 machines loudly"
    );
    // The publish render's stamp lines (release.yml's render_installer_ps1
    // sed + grep targets): both must exist verbatim at line starts.
    assert!(
        text.contains("$DownloadBaseUrlDefault = '"),
        "the base-URL default line the publish stamps must exist"
    );
    assert!(
        text.contains("$ReleaseChannelDefault = '"),
        "the channel-default line the publish stamps must exist"
    );
    // The same layout as install-rust.sh (share\prime-agent + bin):
    // the two routes must interoperate on one install.
    assert!(
        text.contains("share\\prime-agent") && text.contains("prime-agent.exe"),
        "the ps1 publishes the same payload layout with the .exe name"
    );
    // The marker write: the same ownership proof the sh installer writes
    // (the update funnel's channel-stickiness read keys on its shape).
    assert!(
        text.contains("install-rust.sh channel"),
        "the ps1 writes the funnel-readable install marker"
    );
}

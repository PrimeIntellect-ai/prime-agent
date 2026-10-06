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

/// install.ps1's download discipline: Invoke-WebRequest under the default
/// Progress/Verbose preferences leaks the raw .NET transfer records onto
/// the caller's console (the progress bar and the "Writing web request /
/// Writing request stream..." verbose chatter), and under `irm | iex` the
/// script shares the caller's session - the operator's real-machine report
/// (2026-10-06). The installer pins both preferences to `SilentlyContinue`
/// around its download calls, prints its own one-line progress instead
/// (the file name plus the size, install-rust.sh's discipline), and
/// restores the caller's values after: the quiet zone is the download,
/// never the session.
#[test]
fn install_ps1_pins_the_download_preferences_around_the_downloads() {
    let text = std::fs::read_to_string(repo_root().join("install.ps1")).expect("read install.ps1");
    // The download block: the two staged file names through the checksum
    // verify that follows it.
    let block_start = text
        .find("$tarball = Join-Path $download $expectedFile")
        .expect("the download block stages the tarball");
    let block_end = text
        .find("$sumsLine = Get-Content")
        .expect("the checksum verify follows the download");
    let block = &text[block_start..block_end];
    let markers: [(&str, &str); 8] = [
        (
            "save of the caller's progress preference",
            "$callerProgressPreference = $ProgressPreference",
        ),
        (
            "save of the caller's verbose preference",
            "$callerVerbosePreference = $VerbosePreference",
        ),
        ("progress pin", "$ProgressPreference = 'SilentlyContinue'"),
        ("verbose pin", "$VerbosePreference = 'SilentlyContinue'"),
        (
            "payload download",
            "Save-Release -Uri \"$baseUrl/$releasePrefix/$expectedFile\" -OutFile $tarball",
        ),
        ("restore on the failure path too", "} finally {"),
        (
            "restore of the caller's progress preference",
            "$ProgressPreference = $callerProgressPreference",
        ),
        (
            "restore of the caller's verbose preference",
            "$VerbosePreference = $callerVerbosePreference",
        ),
    ];
    let mut positions: Vec<usize> = Vec::new();
    for (what, marker) in markers {
        positions.push(
            block.find(marker).unwrap_or_else(|| {
                panic!("the download block must carry its {what} line: {marker}")
            }),
        );
    }
    for pair in positions.windows(2) {
        assert!(
            pair[0] < pair[1],
            "the download block's discipline is ordered save -> pin -> download -> restore"
        );
    }
    // The installer's own progress: the download's name before it starts,
    // the name plus the size after it lands (install-rust.sh's
    // step_start/step_ok "Downloaded <MB>" discipline).
    let download_at = positions[4];
    let announcing = block
        .find("Write-Host \"downloading $expectedFile\"")
        .expect("the installer announces the download by name");
    assert!(
        announcing < download_at,
        "the installer's own progress line prints before the download starts"
    );
    assert!(
        block.contains("downloaded: $expectedFile") && block.contains("1MB"),
        "the installer reports the downloaded file's name and size"
    );
}

/// The installer's console output is ASCII-only: the Windows console's
/// default codepage renders non-ASCII bytes as mojibake (the operator's
/// 2026-10-06 report: an em-dash printed as an a-circumflex), so every
/// string the installer EMITS - Write-Host, Write-Warning, and Fail's
/// thrown message - must be plain ASCII. The script's comments and the
/// launcher files it writes are out of scope: neither lands on the console.
#[test]
fn install_ps1_emits_only_ascii_output() {
    let text = std::fs::read_to_string(repo_root().join("install.ps1")).expect("read install.ps1");
    let mut offenders: Vec<(usize, &str)> = Vec::new();
    for (index, line) in text.lines().enumerate() {
        let trimmed = line.trim_start();
        if trimmed.starts_with('#') {
            continue;
        }
        let emits = line.contains("Write-Host")
            || line.contains("Write-Warning")
            || line.contains("Write-Error")
            || line.contains("WriteErrorLine")
            || trimmed.starts_with("Fail ")
            || trimmed.starts_with("throw ");
        if emits && !line.is_ascii() {
            offenders.push((index + 1, trimmed));
        }
    }
    assert!(
        offenders.is_empty(),
        "install.ps1 emits non-ASCII output (the Windows console mojibakes it): {offenders:?}"
    );
}

/// The post-install smoke test's DLL-not-found class must not lie: a
/// launcher that fails --version with 0xC0000135 (`STATUS_DLL_NOT_FOUND`,
/// exit -1073741515) never started its process - a runtime DLL the binary
/// links is missing - so the venv-bootstrap claim ("the first run
/// bootstraps the kernel venv, re-run it") would send the user chasing a
/// bootstrap that cannot fix a missing DLL. With the static-runtime build
/// the class should not occur at all; if it does, the message must say
/// what actually happened.
#[test]
fn install_ps1_names_the_dll_not_found_failure_honestly() {
    let text = std::fs::read_to_string(repo_root().join("install.ps1")).expect("read install.ps1");
    let verify_at = text
        .find("# --- verify: the launcher must answer --version")
        .expect("the smoke test section exists");
    let dll_exit = text.find("-1073741515").expect(
        "the smoke test must branch on the DLL-not-found exit code (0xC0000135, -1073741515)",
    );
    assert!(
        dll_exit > verify_at,
        "the DLL-not-found branch belongs to the smoke test"
    );
    let warning_at = text[dll_exit..]
        .find("Write-Warning")
        .expect("the DLL-not-found branch prints a warning");
    let line_end = text[dll_exit + warning_at..]
        .find('\n')
        .map_or(text.len(), |at| dll_exit + warning_at + at);
    let dll_warning = &text[dll_exit..line_end];
    assert!(
        dll_warning.contains("0xC0000135") && dll_warning.contains("runtime"),
        "the DLL-not-found warning must name the missing runtime dependency:\n{dll_warning}"
    );
    assert!(
        !dll_warning.contains("bootstraps the kernel venv"),
        "the DLL-not-found class must not claim the kernel-venv bootstrap:\n{dll_warning}"
    );
    assert!(
        text.contains("the first run bootstraps the kernel venv"),
        "the non-DLL failure classes keep their honest venv-bootstrap hint"
    );
}

/// install.ps1's PATH parity (the operator's smoothness ask, 2026-10-06):
/// a Linux box almost always carries ~/.local/bin on PATH already, so the
/// sh installer only prints a profile note - but a Windows box has no
/// %USERPROFILE%\\.local\\bin, and a printed-only note leaves the fresh
/// install unusable until the user edits their environment by hand.
/// Windows HAS a canonical user-PATH setting (the registry's User scope,
/// no admin needed), so the installer ADDS the launcher's bin dir there
/// itself: idempotent (appended only when the entry is absent, never
/// duplicated), mirrored into the CURRENT session so `prime-agent` works
/// in the same console immediately, and the printed hint says a NEW
/// terminal gets it automatically instead of telling the user to go edit
/// the registry by hand.
#[test]
fn install_ps1_adds_bin_to_the_user_path_and_the_session_path() {
    let text = std::fs::read_to_string(repo_root().join("install.ps1")).expect("read install.ps1");
    let section_start = text
        .find("# --- the PATH add")
        .expect("the PATH-add section exists");
    let section_end = text
        .find("# --- verify: the launcher must answer --version")
        .expect("the smoke test section exists");
    let section = &text[section_start..section_end];
    let markers: [(&str, &str); 6] = [
        ("the session PATH add", "$env:PATH = \"$env:PATH;$bin\""),
        (
            "the user PATH read",
            "[Environment]::GetEnvironmentVariable('Path', 'User')",
        ),
        (
            "the idempotent absent check (a whole-entry compare, never a substring: a sibling entry like C:\\Tools\\bin-old must not mask C:\\Tools\\bin)",
            "if (-not (Test-PathEntry $userPath $bin))",
        ),
        (
            "the durable user PATH write",
            "[Environment]::SetEnvironmentVariable('Path', $newUserPath, 'User')",
        ),
        ("the change broadcast", "SendMessageTimeout([IntPtr]0xffff"),
        ("the new-terminal hint", "picks it up automatically"),
    ];
    let mut positions: Vec<usize> = Vec::new();
    for (what, marker) in markers {
        positions.push(
            section
                .find(marker)
                .unwrap_or_else(|| panic!("the PATH section must carry its {what} line: {marker}")),
        );
    }
    for pair in positions.windows(2) {
        assert!(
            pair[0] < pair[1],
            "the PATH add's discipline is session first, then the durable user write: {markers:?}"
        );
    }
    // The printed note never tells the user to edit their own PATH by hand
    // anymore: the installer did it.
    assert!(
        !section.contains("add it for the prime-agent command"),
        "the PATH note must not tell the user to edit their own PATH by hand"
    );
}

/// The install ledger + the streaming download (the operator's
/// flow-parity ask, 2026-10-06): install-rust.sh runs a real progress UI -
/// `step_ok` / `step_fail` lines plus a download bar fed by the fetched
/// bytes - while the ps1's download was one silent web-cmdlet call. The
/// ps1's mirror, as far as PowerShell sensibly allows: an ASCII step
/// ledger around the phases, and the payload streams through a
/// `HttpClient` copy loop that repaints one short line in place (the
/// file's name, the landed bytes, the percent) with three attempts - the
/// .NET transfer records stay silent the whole time (the download-block
/// pins test covers the silencing).
#[test]
fn install_ps1_runs_a_step_ledger_and_its_own_download_progress() {
    let text = std::fs::read_to_string(repo_root().join("install.ps1")).expect("read install.ps1");
    // The ledger functions exist.
    assert!(
        text.contains("function Step-Ok"),
        "the installer must define Step-Ok (install-rust.sh's step_ok)"
    );
    assert!(
        text.contains("function Step-Fail"),
        "the installer must define Step-Fail (install-rust.sh's step_fail)"
    );
    // The streaming helper: a `HttpClient` copy loop with the installer's
    // own in-place progress line and the sh installer's three-attempt
    // retry.
    let helper_start = text
        .find("function Save-Release")
        .expect("the streaming download helper must exist");
    let helper = &text[helper_start..];
    let helper = &helper[..helper.find("\n}\n").map_or(helper.len(), |at| at + 3)];
    assert!(
        helper.contains("System.Net.Http.HttpClient"),
        "the helper streams with HttpClient, which emits no cmdlet progress records"
    );
    assert!(
        helper.contains("`r"),
        "the helper repaints its progress line in place (a carriage return, never a newline)"
    );
    assert!(
        helper.contains("%)"),
        "the progress line carries the percent"
    );
    assert!(
        helper.contains("-NoNewline"),
        "the progress line does not scroll"
    );
    assert!(
        helper.contains("attempt"),
        "the helper retries like the sh installer's fetch (three attempts)"
    );
    // The payload download goes through the helper; the raw web cmdlet for
    // the payload is gone.
    let block_start = text
        .find("$tarball = Join-Path $download $expectedFile")
        .expect("the download block stages the tarball");
    let block_end = text
        .find("$sumsLine = Get-Content")
        .expect("the checksum verify follows");
    let block = &text[block_start..block_end];
    assert!(
        block.contains(
            "Save-Release -Uri \"$baseUrl/$releasePrefix/$expectedFile\" -OutFile $tarball"
        ),
        "the payload download must stream through the helper"
    );
    assert!(
        !block.contains("Invoke-WebRequest -Uri \"$baseUrl/$releasePrefix/$expectedFile\""),
        "the payload download must not be the noisy web cmdlet anymore"
    );
    // The ledger marks the phases (install-rust.sh's step_ok lines).
    for (phase, marker) in [
        ("checksum", "Step-Ok 'checksum verified'"),
        ("extract", "Step-Ok 'extracted'"),
        ("publish", "Step-Ok 'published'"),
        ("uv", "Step-Ok 'uv installed'"),
        ("kernel", "Step-Ok 'kernel ready'"),
    ] {
        assert!(
            text.contains(marker),
            "the ledger must mark the {phase} phase: {marker}"
        );
    }
}

/// The uv parity (the operator's ask, 2026-10-06): install-rust.sh INSTALLS
/// uv when it is missing (the astral one-liner with the destination
/// passed explicitly via `UV_INSTALL_DIR`, the fetch and the script run
/// checked SEPARATELY so a dead network cannot masquerade as success) and
/// then pre-warms the kernel (`prime-agent --prime-agent-bootstrap`); the
/// ps1 only printed a note. The ps1 mirrors the whole flow: the astral
/// installer is FETCHED (into a file, checked non-empty), RUN with
/// `UV_INSTALL_DIR` set explicitly, and its verdict is never trusted - the
/// `uv.exe` FILE decides; the uv bin dir rides the session PATH
/// (install-rust.sh's pre-warm PATH fix), and a failure degrades to the
/// honest note plus the exact manual command (the sh installer's
/// note/todo shape).
#[test]
fn install_ps1_installs_uv_like_the_linux_installer() {
    let text = std::fs::read_to_string(repo_root().join("install.ps1")).expect("read install.ps1");
    let section_start = text
        .find("# --- the kernel pre-warm")
        .expect("the pre-warm section exists");
    let section_end = text
        .find("# --- the PATH add")
        .expect("the PATH-add section follows");
    let section = &text[section_start..section_end];
    let markers: [(&str, &str); 7] = [
        ("the uv target", "Join-Path $HOME '.local\\bin'"),
        (
            "the astral installer fetch",
            "Invoke-WebRequest -Uri 'https://astral.sh/uv/install.ps1' -OutFile $uvInstallerPath",
        ),
        (
            "the fetch checked before the run",
            "(Get-Item -LiteralPath $uvInstallerPath).Length -gt 0",
        ),
        (
            "the explicit destination",
            "$env:UV_INSTALL_DIR = $uvInstallDir",
        ),
        (
            "the script run (a child process, never Invoke-Expression: the astral script exits 1 on its own failures, and under Invoke-Expression that exit would leave this installer's control flow)",
            "& $childShell -NoProfile -NonInteractive -ExecutionPolicy Bypass -EncodedCommand $childEncoded",
        ),
        (
            "the binary decides (the verdict gate, in the negated-first shape)",
            "if (-not (Test-Path $uvExe -PathType Leaf)) {",
        ),
        (
            "the session PATH fix",
            "$env:PATH = \"$uvInstallDir;$env:PATH\"",
        ),
    ];
    let mut positions: Vec<usize> = Vec::new();
    for (what, marker) in markers {
        positions.push(
            section
                .find(marker)
                .unwrap_or_else(|| panic!("the uv flow must carry its {what} line: {marker}")),
        );
    }
    for pair in positions.windows(2) {
        assert!(
            pair[0] < pair[1],
            "the uv flow's discipline is fetch, then run, then verify by the file: {markers:?}"
        );
    }
    // The pre-warm itself and the honest fallbacks.
    assert!(
        section.contains("--prime-agent-bootstrap"),
        "the pre-warm still runs the kernel bootstrap"
    );
    assert!(
        section.contains("irm https://astral.sh/uv/install.ps1 | iex"),
        "the manual fallback command is named (the astral one-liner)"
    );
    assert!(
        section.contains("could not install uv; the kernel pre-warm was skipped"),
        "the honest offline note names what was skipped"
    );
}

/// The Windows install e2e must exercise the SHIPPED link mode (the
/// reviewer's pre-bar finding): the harness builds its own artifact, so a
/// plain `cargo build --release` there produces the DYNAMIC binary the
/// workflow stopped shipping - and the runner image carries the VC
/// runtime, so that smoke passes even on a machine that would never run
/// the shipped one. The e2e builds with the workflow's step-scoped
/// `crt-static` flag, rejects any vcruntime import in the built PE (the
/// stock-box 0xC0000135 regression guard), gates on the uv install the
/// ps1 route promises, and restores the User PATH it dirtied.
#[test]
fn windows_install_e2e_builds_the_shipped_link_mode() {
    let harness = std::fs::read_to_string(
        repo_root()
            .join("scripts")
            .join("release")
            .join("test_windows_install.ps1"),
    )
    .expect("read test_windows_install.ps1");
    assert!(
        harness.contains("target-feature=+crt-static"),
        "the e2e must build its artifact with the workflow's step-scoped crt-static flag"
    );
    assert!(
        harness.contains("vcruntime"),
        "the e2e must reject a vcruntime import in the built release binary (the runner's own VC runtime would mask the stock-box regression)"
    );
    assert!(
        harness.contains(".local\\bin\\uv.exe"),
        "the e2e must gate on the uv executable the ps1 route promises to install"
    );
    assert!(
        harness.contains("[Environment]::SetEnvironmentVariable('Path', $userPathBefore, 'User')"),
        "the e2e must snapshot and restore the User PATH its installs dirty"
    );
}

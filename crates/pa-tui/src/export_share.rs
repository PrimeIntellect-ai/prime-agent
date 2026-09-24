//! The `/export` and `/share` client commands (TS `handleExportCommand` /
//! `handleShareCommand`): the `/export` path-argument parsing, the GitHub CLI
//! gating and gist spawn for `/share`, the gist URL parse, and the share
//! viewer URL. The exported file itself is the daemon-side exporter (the
//! `export_html`/`export_jsonl` commands); this module owns only the
//! client-side pieces.

use std::path::Path;

/// Parse the path argument of `/export` (TS `getPathCommandArgument`):
/// `None` for no argument; a quoted argument runs to its closing quote; an
/// unquoted one ends at the first whitespace.
pub fn path_command_argument(text: &str, command: &str) -> Option<String> {
    if text == command {
        return None;
    }
    let rest = text.strip_prefix(&format!("{command} "))?;
    let rest = rest.trim_start();
    let first = rest.chars().next()?;
    if first == '"' || first == '\'' {
        let quoted = rest.chars().skip(1).collect::<String>();
        let close = quoted.find(first)?;
        return Some(quoted[..close].to_string());
    }
    match rest.find(char::is_whitespace) {
        Some(index) => Some(rest[..index].to_string()),
        None => Some(rest.to_string()),
    }
}

/// The share viewer URL for a gist id (TS `getShareViewerUrl`): the
/// `PI_SHARE_VIEWER_URL` override, else the product default, with the id as
/// the fragment.
///
/// The default URL and the env var are the TS product's wire identifiers
/// (the viewer service the exported page integrates with); they stay
/// byte-identical until the product renames them.
pub fn share_viewer_url(gist_id: &str) -> String {
    let base = std::env::var("PI_SHARE_VIEWER_URL")
        .ok()
        .filter(|value| !value.is_empty())
        .unwrap_or_else(|| DEFAULT_SHARE_VIEWER_URL.to_string());
    format!("{base}#{gist_id}")
}

const DEFAULT_SHARE_VIEWER_URL: &str = "https://pi.dev/session/";

/// The gist id from the URL `gh gist create` prints (the last path
/// segment, TS `gistUrl.split("/").pop()`): an empty segment (a trailing
/// slash) is no gist id.
pub fn gist_id_from_url(url: &str) -> Option<&str> {
    let url = url.trim();
    let segment = url.rsplit('/').next()?;
    (!segment.is_empty()).then_some(segment)
}

/// The GitHub CLI availability (TS `gh auth status` probe).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum GhAuthStatus {
    /// `gh` exists and reports a logged-in account.
    Ok,
    /// `gh` exists but no account is logged in.
    NotLoggedIn,
    /// `gh` is not installed.
    NotInstalled,
}

/// Probe the GitHub CLI (TS `spawnSyncHidden("gh", ["auth", "status"])`):
/// a non-zero exit means not logged in, a spawn failure means not
/// installed. The probe never opens a window (hidden spawn).
pub fn probe_gh_auth() -> GhAuthStatus {
    let output = match gh_probe_command().args(["auth", "status"]).output() {
        Ok(output) => output,
        Err(_) => return GhAuthStatus::NotInstalled,
    };
    if output.status.success() {
        GhAuthStatus::Ok
    } else {
        GhAuthStatus::NotLoggedIn
    }
}

/// The result of one `gh gist create` run.
#[derive(Debug, Clone, PartialEq)]
pub struct GistOutcome {
    /// The gist URL `gh` printed on success.
    pub gist_url: String,
    /// The share viewer URL derived from the gist id.
    pub preview_url: String,
}

/// Wait for a spawned `gh gist create` and turn its output into the share
/// result (TS: stdout is the gist URL; stderr is the failure message).
/// Both pipes drain concurrently (`wait_with_output`), so a chatty `gh`
/// cannot deadlock the wait.
pub async fn gist_outcome(child: tokio::process::Child) -> Result<GistOutcome, String> {
    let output = child
        .wait_with_output()
        .await
        .map_err(|error| error.to_string())?;
    if !output.status.success() {
        let message = String::from_utf8_lossy(&output.stderr);
        let message = message.trim();
        return Err(if message.is_empty() {
            "Unknown error".to_string()
        } else {
            message.to_string()
        });
    }
    let gist_url = String::from_utf8_lossy(&output.stdout).trim().to_string();
    let gist_id = gist_id_from_url(&gist_url)
        .map(str::to_string)
        .ok_or_else(|| "Failed to parse gist ID from gh output".to_string())?;
    Ok(GistOutcome {
        gist_url,
        preview_url: share_viewer_url(&gist_id),
    })
}

/// Spawn `gh gist create --public=false <file>` (TS `spawnHidden`): output
/// is piped, no terminal window on Windows. The child is killed when
/// dropped mid-wait, so aborting the upload task terminates `gh`.
pub fn spawn_gist_create(file: &Path) -> std::io::Result<tokio::process::Child> {
    gh_command()
        .args(["gist", "create", "--public=false"])
        .arg(file)
        .stdin(std::process::Stdio::null())
        .stdout(std::process::Stdio::piped())
        .stderr(std::process::Stdio::piped())
        .kill_on_drop(true)
        .spawn()
}

/// The async `gh` command with Windows hidden-window creation flags applied
/// (TS `spawnHidden`; a no-op on Unix).
#[cfg(windows)]
fn gh_command() -> tokio::process::Command {
    let mut command = tokio::process::Command::new("gh");
    // CREATE_NO_WINDOW: the loader surfaces the wait, not a console window.
    const CREATE_NO_WINDOW: u32 = 0x0800_0000;
    command.creation_flags(CREATE_NO_WINDOW);
    command
}

#[cfg(unix)]
fn gh_command() -> tokio::process::Command {
    tokio::process::Command::new("gh")
}

/// The blocking `gh` probe command, hidden on Windows the same way.
#[cfg(windows)]
fn gh_probe_command() -> std::process::Command {
    let mut command = std::process::Command::new("gh");
    const CREATE_NO_WINDOW: u32 = 0x0800_0000;
    use std::os::windows::process::CommandExt;
    command.creation_flags(CREATE_NO_WINDOW);
    command
}

#[cfg(unix)]
fn gh_probe_command() -> std::process::Command {
    std::process::Command::new("gh")
}

#[cfg(test)]
mod tests {
    use super::*;

    /// The `/export` path argument parses exactly like the TS helper:
    /// missing, bare, quoted, and whitespace-terminated arguments.
    #[test]
    fn path_arguments_parse() {
        assert_eq!(path_command_argument("/export", "/export"), None);
        assert_eq!(
            path_command_argument("/export out.html", "/export"),
            Some("out.html".to_string())
        );
        assert_eq!(
            path_command_argument("/export   out.html  ", "/export"),
            Some("out.html".to_string())
        );
        assert_eq!(
            path_command_argument("/export \"my file.html\"", "/export"),
            Some("my file.html".to_string())
        );
        assert_eq!(
            path_command_argument("/export 'my file.jsonl' extra", "/export"),
            Some("my file.jsonl".to_string())
        );
        assert_eq!(
            path_command_argument("/export a b c", "/export"),
            Some("a".to_string())
        );
        // An unclosed quote is no argument at all (TS returns undefined).
        assert_eq!(path_command_argument("/export \"unclosed", "/export"), None);
    }

    /// The gist id is the URL's last path segment.
    #[test]
    fn gist_ids_parse() {
        assert_eq!(
            gist_id_from_url("https://gist.github.com/user/abc123"),
            Some("abc123")
        );
        assert_eq!(gist_id_from_url("abc123"), Some("abc123"));
        assert_eq!(
            gist_id_from_url("https://gist.github.com/user/abc123/"),
            None
        );
    }

    /// The share viewer URL is the base plus the fragment, and the env
    /// override wins while it is non-empty.
    #[test]
    fn share_viewer_urls() {
        // SAFETY: single-threaded test setup for a std::env var.
        std::env::remove_var("PI_SHARE_VIEWER_URL");
        assert_eq!(share_viewer_url("abc123"), "https://pi.dev/session/#abc123");
        std::env::set_var("PI_SHARE_VIEWER_URL", "https://example.test/view/");
        assert_eq!(
            share_viewer_url("abc123"),
            "https://example.test/view/#abc123"
        );
        std::env::set_var("PI_SHARE_VIEWER_URL", "");
        assert_eq!(share_viewer_url("abc123"), "https://pi.dev/session/#abc123");
        std::env::remove_var("PI_SHARE_VIEWER_URL");
    }

    /// The full gh spawn path against a stub `gh` (the e2e harness uses the
    /// same stub): the upload file must exist and the printed URL becomes
    /// the gist + viewer pair. Unix-only (the stub is a shell script).
    #[cfg(unix)]
    #[tokio::test]
    async fn gist_spawn_against_stub_gh() {
        let dir = tempfile::TempDir::new().expect("temp dir");
        let stub = r#"#!/bin/bash
case "$1" in
  auth) exit 0 ;;
  gist)
    if [ $# -lt 4 ] || [ ! -f "$4" ]; then
      echo "gist: upload file missing" >&2
      exit 1
    fi
    echo "https://gist.github.com/testuser/abc123"
    ;;
  *) echo "unsupported: $1" >&2; exit 1 ;;
esac
"#;
        use std::os::unix::fs::PermissionsExt;
        std::fs::write(dir.path().join("gh"), stub).expect("write stub");
        let mut permissions = std::fs::metadata(dir.path().join("gh"))
            .expect("stat")
            .permissions();
        permissions.set_mode(0o755);
        std::fs::set_permissions(dir.path().join("gh"), permissions).expect("chmod");
        let upload = dir.path().join("session.html");
        std::fs::write(&upload, "<html></html>").expect("write upload");

        let previous = std::env::var("PATH").unwrap_or_default();
        std::env::set_var("PATH", format!("{}:{}", dir.path().display(), previous));
        assert_eq!(probe_gh_auth(), GhAuthStatus::Ok);
        let child = spawn_gist_create(&upload).expect("spawn gh");
        let outcome = gist_outcome(child).await.expect("gist outcome");
        std::env::set_var("PATH", previous.clone());
        assert_eq!(outcome.gist_url, "https://gist.github.com/testuser/abc123");
        assert_eq!(outcome.preview_url, "https://pi.dev/session/#abc123");

        // A missing upload file is the stub's failure, surfaced verbatim.
        std::env::set_var("PATH", format!("{}:{}", dir.path().display(), previous));
        let child = spawn_gist_create(&dir.path().join("nope.html")).expect("spawn gh");
        let error = gist_outcome(child)
            .await
            .expect_err("missing upload must fail");
        std::env::set_var("PATH", previous.clone());
        assert_eq!(error, "gist: upload file missing");
    }
}

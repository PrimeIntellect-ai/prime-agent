//! Browser launch for clicked hyperlinks (TS `tui.ts` `openHyperlink`'s
//! platform table — darwin `open`, Windows `rundll32
//! url.dll,FileProtocolHandler`, otherwise `xdg-open`).
//!
//! Terminals gate their native link handling while mouse reporting is
//! active (Ghostty only refreshes link hover when reporting is off or
//! shift is held), so clicks the TUI consumes must open their OSC 8
//! targets themselves. pa-tui stays pa-types-only: this is the TUI
//! package's own opener (the composition root's login flows carry theirs
//! in pa-core), exactly like TS where tui.ts and the login dialog each
//! build the same command table.

use std::process::{Command, Stdio};

/// The opener program and its argument list for one URL (the platform
/// table, one arm per compiled target).
fn opener(url: &str) -> (&'static str, Vec<String>) {
    #[cfg(target_os = "macos")]
    {
        ("open", vec![url.to_string()])
    }
    #[cfg(all(unix, not(target_os = "macos")))]
    {
        ("xdg-open", vec![url.to_string()])
    }
    #[cfg(windows)]
    {
        let system_root = std::env::var("SystemRoot").unwrap_or_else(|_| "C:\\Windows".to_string());
        let rundll32 = std::path::Path::new(&system_root)
            .join("System32")
            .join("rundll32.exe");
        (
            "rundll32",
            vec![
                rundll32.to_string_lossy().into_owned(),
                "url.dll,FileProtocolHandler".to_string(),
                url.to_string(),
            ],
        )
    }
}

/// Open `url` in the user's browser. Fire-and-forget like TS
/// `openHyperlink` (`execFile` with a swallowed callback): the link
/// stays visible in the transcript, so a failed launch (no desktop
/// session, no opener) never fails the click.
pub fn open_in_browser(url: &str) {
    let (program, args) = opener(url);
    let _ = Command::new(program)
        .args(&args)
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .spawn();
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_opener_table_targets_the_url() {
        let (program, args) = opener("https://example.com/docs");
        assert!(!program.is_empty());
        assert!(args.iter().any(|arg| arg.contains("example.com")));
    }
}

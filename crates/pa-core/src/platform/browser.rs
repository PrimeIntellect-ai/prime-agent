//! Browser launch for OAuth login URLs: the platform opener (the TS
//! login dialog's command table — darwin `open`, Windows
//! `rundll32 url.dll,FileProtocolHandler`, otherwise `xdg-open`).

use std::process::{Command, Stdio};

/// The opener program and its argument list for one URL.
#[cfg(target_os = "macos")]
fn opener(url: &str) -> (&'static str, Vec<String>) {
    ("open", vec![url.to_string()])
}

/// The opener program and its argument list for one URL.
#[cfg(all(unix, not(target_os = "macos")))]
fn opener(url: &str) -> (&'static str, Vec<String>) {
    ("xdg-open", vec![url.to_string()])
}

/// The opener program and its argument list for one URL.
#[cfg(windows)]
fn opener(url: &str) -> (&'static str, Vec<String>) {
    // Absolute System32 path (the TS dialog resolves it from
    // `SystemRoot`, defaulting to `C:\Windows`).
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

/// Open `url` in the user's browser. Fire-and-forget like the TS dialog
/// (`execFileHidden` with a swallowed callback): the caller also shows the
/// URL itself, so a failed launch (no desktop session, no opener) never
/// fails the login. The spawn result is deliberately not an error surface.
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
    fn opener_selection() {
        // The command table per platform; the program matches the TS dialog.
        let (program, args) = opener("https://example.com/login");
        assert!(!program.is_empty());
        assert!(!args.is_empty());
        assert!(args.iter().any(|arg| arg.contains("example.com")));
    }
}

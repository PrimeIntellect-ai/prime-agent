//! Browser launch for clicked hyperlinks: darwin `open`, Windows
//! `rundll32 url.dll,FileProtocolHandler`, otherwise `xdg-open` — the TUI opens them itself because
//! terminals gate native link handling while mouse reporting is active. The opener always resolves
//! to an absolute path: a bare name would search the inherited `PATH`.

use std::path::PathBuf;
use std::process::{Command, Stdio};

/// The fixed `xdg-open` tool slots — searched in order, the first that
/// exists wins.
#[cfg(all(unix, not(target_os = "macos")))]
const XDG_OPEN_SLOTS: [&str; 3] = [
    "/usr/bin/xdg-open",
    "/usr/local/bin/xdg-open",
    "/bin/xdg-open",
];

/// The absolute opener path and its argument list for one URL, or `None`
/// when the platform's tool is not installed.
fn opener(url: &str) -> Option<(PathBuf, Vec<String>)> {
    #[cfg(target_os = "macos")]
    {
        Some((PathBuf::from("/usr/bin/open"), vec![url.to_string()]))
    }
    #[cfg(all(unix, not(target_os = "macos")))]
    {
        let path = XDG_OPEN_SLOTS
            .into_iter()
            .map(PathBuf::from)
            .find(|path| path.exists())?;
        Some((path, vec![url.to_string()]))
    }
    #[cfg(windows)]
    {
        // Absolute System32 path (the TS dialog resolves it from
        // `SystemRoot`, defaulting to `C:\Windows`).
        let system_root = std::env::var("SystemRoot").unwrap_or_else(|_| "C:\\Windows".to_string());
        let rundll32 = std::path::Path::new(&system_root)
            .join("System32")
            .join("rundll32.exe");
        Some((
            rundll32,
            vec!["url.dll,FileProtocolHandler".to_string(), url.to_string()],
        ))
    }
}

/// Open `url` in the user's browser. Fire-and-forget: a failed launch never fails the click.
/// The child is reaped on a parked thread — an unwaited spawn would leak one zombie per click in
/// the long-running TUI.
pub(crate) fn open_in_browser(url: &str) {
    let Some((program, args)) = opener(url) else {
        return;
    };
    let Ok(mut child) = Command::new(program)
        .args(&args)
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .spawn()
    else {
        return;
    };
    std::thread::spawn(move || {
        let _ = child.wait();
    });
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_opener_resolves_an_absolute_path_and_targets_the_url() {
        let (program, args) = opener("https://example.com/docs").expect("the platform opener");
        assert!(
            program.is_absolute(),
            "the opener never resolves through PATH: {program:?}"
        );
        assert!(args.iter().any(|arg| arg.contains("example.com")));
    }
}

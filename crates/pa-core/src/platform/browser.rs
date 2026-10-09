//! Browser launch for OAuth login URLs: the platform opener (the TS
//! login dialog's command table — darwin `open`, Windows
//! `rundll32 url.dll,FileProtocolHandler`, otherwise `xdg-open`).

use std::process::{Command, Stdio};

#[cfg(target_os = "macos")]
fn opener(url: &str) -> (&'static str, Vec<String>) {
    ("open", vec![url.to_string()])
}

#[cfg(all(unix, not(target_os = "macos")))]
fn opener(url: &str) -> (&'static str, Vec<String>) {
    ("xdg-open", vec![url.to_string()])
}

#[cfg(windows)]
fn opener(url: &str) -> (String, Vec<String>) {
    // Absolute System32 path (the TS dialog resolves it from
    // `SystemRoot`, defaulting to `C:\Windows`).
    let system_root = std::env::var("SystemRoot").unwrap_or_else(|_| "C:\\Windows".to_string());
    let rundll32 = std::path::Path::new(&system_root)
        .join("System32")
        .join("rundll32.exe");
    (
        rundll32.to_string_lossy().into_owned(),
        vec!["url.dll,FileProtocolHandler".to_string(), url.to_string()],
    )
}

/// Open `url` in the user's browser. Fire-and-forget like the TS dialog:
/// the caller also shows the URL itself, so a failed launch never fails
/// the login.
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
        let (program, args) = opener("https://example.com/login");
        assert!(!program.is_empty());
        assert!(!args.is_empty());
        assert!(args.iter().any(|arg| arg.contains("example.com")));
    }

    #[cfg(windows)]
    #[test]
    fn browser_launch_uses_system32_program_and_dll_entrypoint_arguments() {
        let url = "https://example.com/login?state=a%20b&code=c";
        let (program, args) = opener(url);
        let command = Command::new(&program);
        let system_root = std::env::var("SystemRoot").unwrap_or_else(|_| "C:\\Windows".to_string());
        let expected_program = std::path::Path::new(&system_root)
            .join("System32")
            .join("rundll32.exe");
        assert_eq!(
            (command.get_program(), args),
            (
                expected_program.as_os_str(),
                vec!["url.dll,FileProtocolHandler".to_string(), url.to_string()],
            )
        );
    }
}

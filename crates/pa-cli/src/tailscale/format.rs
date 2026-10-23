//! ANSI styling for the `tailscale` command output. Colors follow chalk's
//! auto-detection (the TS `chalk.red/yellow/green/bold`): styled output only
//! when stdout is a terminal and `NO_COLOR` is unset. Piped output is plain.

/// `chalk.red`.
pub(crate) fn red(text: &str) -> String {
    paint("31", text)
}

/// `chalk.yellow`.
pub(crate) fn yellow(text: &str) -> String {
    paint("33", text)
}

/// `chalk.green`.
pub(crate) fn green(text: &str) -> String {
    paint("32", text)
}

/// `chalk.bold`.
pub(crate) fn bold(text: &str) -> String {
    paint("1", text)
}

/// The ANSI wrapper honoring chalk's enable rule (TTY + no `NO_COLOR`), with
/// chalk's reset codes (bold/dim close with 22, colors with 39).
fn paint(code: &str, text: &str) -> String {
    if use_color() {
        format!("\x1b[{code}m{text}\x1b[{}m", reset_code(code))
    } else {
        text.to_string()
    }
}

fn use_color() -> bool {
    std::env::var_os("NO_COLOR").is_none() && std::io::IsTerminal::is_terminal(&std::io::stdout())
}

/// Chalk's reset code per open code.
fn reset_code(code: &str) -> &'static str {
    match code {
        "1" | "2" => "22",
        _ => "39",
    }
}

//! `prime-agent tailscale ...` argv parsing: the mode, port, funnel, and
//! `--json` flag every invocation resolves to, with every malformed form
//! rejected as an error instead of guessed.

/// The parsed `prime-agent tailscale ...` invocation (TS `TailscaleArgs`).
#[derive(Debug, Clone, PartialEq)]
pub(crate) enum TailscaleArgs {
    Serve { port: f64, funnel: bool },
    Status { json: bool },
    Error(String),
}

/// Parse `prime-agent tailscale ...` argv into a mode, port, funnel, and json
/// flag (TS `parseTailscaleArgs`).
pub(crate) fn parse_tailscale_args(args: &[String]) -> TailscaleArgs {
    let json = args.iter().any(|arg| arg == "--json");
    let rest: Vec<&str> = args
        .iter()
        .filter(|arg| arg.as_str() != "--json")
        .map(String::as_str)
        .collect();
    if rest.is_empty() || (rest.len() == 1 && rest[0] == "status") {
        return TailscaleArgs::Status { json };
    }
    // --json was stripped above, so a serve request carrying it would silently
    // run serve with human output; machine-readable output is status-only.
    if json
        && (rest.contains(&"serve")
            || rest.contains(&"--funnel")
            || rest
                .iter()
                .any(|arg| *arg == "--port" || arg.starts_with("--port=")))
    {
        return error_args("tailscale: --json is only supported for status");
    }
    let mut port: Option<f64> = None;
    let mut funnel = false;
    let mut saw_serve = false;
    let mut saw_status = false;
    let mut index = 0;
    while index < rest.len() {
        let token = rest[index];
        match token {
            "serve" => {
                if saw_serve || saw_status {
                    return error_args(format!("tailscale: {token} appears more than once"));
                }
                saw_serve = true;
            }
            "status" => {
                if saw_status || saw_serve {
                    return error_args(format!("tailscale: {token} appears more than once"));
                }
                saw_status = true;
            }
            "--funnel" => {
                if funnel {
                    return error_args("tailscale: --funnel appears more than once");
                }
                funnel = true;
            }
            _ if token == "--port" || token.starts_with("--port=") => {
                if port.is_some() {
                    return error_args("tailscale: --port appears more than once");
                }
                let value = if let Some(inline) = token.strip_prefix("--port=") {
                    Some(inline)
                } else {
                    index += 1;
                    rest.get(index).copied()
                };
                let Some(parsed) = value.and_then(js_number) else {
                    return error_args("--port requires a numeric value (1-65535)");
                };
                port = Some(parsed);
            }
            _ if token.starts_with('-') => {
                return error_args(format!("tailscale: unrecognized option {token}"));
            }
            _ => return error_args(format!("tailscale: unexpected argument {token}")),
        }
        index += 1;
    }
    if saw_status {
        if port.is_some() || funnel {
            return error_args("tailscale: status takes no serve flags");
        }
        return TailscaleArgs::Status { json };
    }
    if saw_serve || port.is_some() || funnel {
        let Some(port) = port else {
            return error_args(
                "tailscale serve requires --port <n> (the LOCAL port to expose); \
                 refusing to guess a default",
            );
        };
        return TailscaleArgs::Serve { port, funnel };
    }
    error_args(format!("tailscale: unknown subcommand {}", rest[0]))
}

fn error_args(message: impl Into<String>) -> TailscaleArgs {
    TailscaleArgs::Error(message.into())
}

/// JS `Number(value)`: `None` stands for `NaN` (the parse-rejection case).
fn js_number(value: &str) -> Option<f64> {
    let trimmed = value.trim();
    if trimmed.is_empty() {
        return Some(0.0);
    }
    trimmed
        .parse::<f64>()
        .ok()
        .filter(|parsed| !parsed.is_nan())
}

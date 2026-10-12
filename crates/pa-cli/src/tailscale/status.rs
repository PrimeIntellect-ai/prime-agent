//! The `tailscale status` command: the tailnet overview (human or `--json`),
//! including the served-endpoint rows read from `tailscale serve status`.

use std::ffi::OsStr;
use std::io::Write;

use serde_json::Value;

use super::format::{bold, red, yellow};
use super::{parse_serve_status, probe_tailscale, run_tailscale, TailscaleProbe};

/// Print the tailnet overview (human or `--json`; TS `runTailscaleStatus`).
pub(crate) async fn run_status(program: &OsStr, json: bool) -> i32 {
    let mut stdout = std::io::stdout();
    run_status_to(&mut stdout, program, json).await
}

pub(crate) async fn run_status_to<W: Write>(out: &mut W, program: &OsStr, json: bool) -> i32 {
    let probe = probe_tailscale(program).await;
    if json {
        let _ = writeln!(out, "{}", status_json(&probe));
        return i32::from(probe.cli_path.is_none() || !probe.on_tailnet || probe.error.is_some());
    }
    if let Some(error) = &probe.error {
        let _ = writeln!(
            out,
            "{}",
            red(&format!("tailscale reported a problem: {error}"))
        );
        return 1;
    }
    if probe.cli_path.is_none() {
        let _ = writeln!(out, "{}", yellow("tailscale CLI not found on PATH"));
        let _ = writeln!(out, "Install Tailscale: https://tailscale.com/download");
        return 1;
    }
    if !probe.on_tailnet {
        // offlineButUp implies onTailnet, so an offline node reaches the success
        // path (which prints its state); this branch is genuinely not up.
        let _ = writeln!(
            out,
            "{}",
            yellow("Tailscale is installed but this machine is not up on a tailnet")
        );
        let _ = writeln!(out, "Run `tailscale up` first (or log in), then retry.");
        return 1;
    }
    let _ = writeln!(
        out,
        "{}: {}",
        bold("Tailnet"),
        if probe.offline_but_up {
            "up (currently offline)"
        } else {
            "on (this machine is online)"
        }
    );
    let _ = writeln!(
        out,
        "{}: {}",
        bold("MagicDNS suffix"),
        probe.magic_dns_suffix.as_deref().unwrap_or("unknown")
    );
    let _ = writeln!(
        out,
        "{}: {}",
        bold("This node"),
        probe.hostname.as_deref().unwrap_or("unknown")
    );
    let serve = run_tailscale(program, &["serve", "status", "--json"]).await;
    if serve.code != 0 {
        let _ = writeln!(
            out,
            "{}",
            yellow(&format!(
                "tailscale serve status failed (exit {}); served-local status is unavailable",
                serve.code
            ))
        );
        // The probe already confirmed this node is on a tailnet; a missing serve
        // capability is a warning, not a hard failure (matches --json behavior).
        return 0;
    }
    if let Ok(parsed) = parse_serve_status(&serve.stdout) {
        let rows = serve_rows(&parsed);
        if rows.is_empty() {
            let _ = writeln!(
                out,
                "{}: nothing (see `prime-agent help tailscale`)",
                bold("Served locally")
            );
        } else {
            let _ = writeln!(out, "{}:", bold("Served locally"));
            for row in rows {
                let _ = writeln!(out, "{row}");
            }
        }
    } else {
        let _ = writeln!(
            out,
            "{}",
            yellow(
                "tailscale serve status output was unparseable; served-local status is unavailable"
            )
        );
        // The probe already confirmed this node is on a tailnet; unparseable
        // serve output is a warning, not a hard failure.
    }
    0
}

/// Machine-readable status for `--json` (TS `tailscaleStatusJson`).
fn status_json(probe: &TailscaleProbe) -> String {
    serde_json::to_string_pretty(&serde_json::json!({
        "cli": &probe.cli_path,
        "onTailnet": probe.on_tailnet,
        "offlineButUp": probe.offline_but_up,
        "magicDnsSuffix": &probe.magic_dns_suffix,
        "hostname": &probe.hostname,
        "error": &probe.error,
    }))
    .unwrap_or_default()
}

/// The `listen -> target` rows of a serve status payload: only a real
/// `TCPForward` is a raw TCP forward (an HTTPS/HTTP listener lands in `TCP`
/// with no `TCPForward`; its target is the `Web` row printed beside it), and
/// each `Web` handler prints as `listen/path -> target`.
fn serve_rows(parsed: &Value) -> Vec<String> {
    let mut rows = Vec::new();
    if let Some(tcp) = parsed.get("TCP").and_then(Value::as_object) {
        for (listen, entry) in tcp {
            if let Some(forward) = entry.get("TCPForward").and_then(Value::as_str) {
                rows.push(format!("  {listen} -> {forward}"));
            }
        }
    }
    if let Some(web) = parsed.get("Web").and_then(Value::as_object) {
        for (listen, server) in web {
            if let Some(handlers) = server.get("Handlers").and_then(Value::as_object) {
                for (path, handler) in handlers {
                    let target = handler
                        .get("Proxy")
                        .and_then(Value::as_str)
                        .or_else(|| handler.get("Path").and_then(Value::as_str))
                        .or_else(|| handler.get("Text").and_then(Value::as_str))
                        .unwrap_or("static");
                    rows.push(format!("  {listen}{path} -> {target}"));
                }
            }
        }
    }
    rows
}

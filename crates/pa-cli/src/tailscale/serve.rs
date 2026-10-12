//! The `tailscale serve` command: expose a local port on the tailnet
//! (`serve` or `funnel`, in the background), then verify the serve status
//! really lists the target - `tailscale` can exit 0 after only printing an
//! interactive enable URL.

use std::ffi::OsStr;
use std::io::Write;
use std::time::Duration;

use serde_json::Value;

use super::format::{green, red, yellow};
use super::{parse_serve_status, probe_tailscale, run_tailscale, trim_trailing_dots};

/// Bound on the interactive serve/funnel call (TS `timeout: 60000`).
const SERVE_TIMEOUT: Duration = Duration::from_mins(1);

/// Expose a local port on the tailnet (TS `runTailscaleServe`).
pub(crate) async fn run_serve(program: &OsStr, port: f64, funnel: bool) -> i32 {
    let mut stdout = std::io::stdout();
    run_serve_to(&mut stdout, program, port, funnel).await
}

pub(crate) async fn run_serve_to<W: Write>(
    out: &mut W,
    program: &OsStr,
    port: f64,
    funnel: bool,
) -> i32 {
    if !valid_port(port) {
        let _ = writeln!(
            out,
            "{}",
            red(&format!("--port must be 1-65535, got {port}"))
        );
        return 1;
    }
    // Validated: an integer in 1..=65535.
    let port = port as u16;
    let probe = probe_tailscale(program).await;
    if let Some(error) = &probe.error {
        let _ = writeln!(out, "{}", red(&format!("tailscale status failed: {error}")));
        return 1;
    }
    if probe.cli_path.is_none() {
        let _ = writeln!(out, "{}", yellow("tailscale CLI not found on PATH"));
        let _ = writeln!(out, "Install Tailscale: https://tailscale.com/download");
        return 1;
    }
    if !probe.on_tailnet {
        let _ = writeln!(
            out,
            "{}",
            yellow("This machine is not up on a tailnet (run `tailscale up` first)")
        );
        return 1;
    }
    if probe.offline_but_up {
        let _ = writeln!(
            out,
            "{}",
            yellow(
                "This node is up on a tailnet but currently offline - restore connectivity \
                 before serving"
            )
        );
        return 1;
    }
    let target = format!("localhost:{port}");
    let args: Vec<&str> = if funnel {
        vec!["funnel", "--bg", target.as_str()]
    } else {
        vec!["serve", "--bg", target.as_str()]
    };
    let _ = writeln!(out, "Running tailscale {} ...", args.join(" "));
    let code = spawn_serve(program, &args).await;
    if code != 0 {
        let _ = writeln!(
            out,
            "{}",
            red("tailscale did not accept the serve/funnel command (see its output above)")
        );
        return code;
    }
    // tailscale can exit 0 after only printing an interactive enable URL
    // (enableFeatureInteractive) without configuring anything; verify the target
    // is really served, matching the local endpoint EXACTLY (port 80 must not
    // match localhost:8000).
    let verify = run_tailscale(program, &["serve", "status", "--json"]).await;
    if verify.code != 0 {
        let _ = writeln!(
            out,
            "{}",
            red(&format!(
                "post-serve verification failed: tailscale serve status exited {}",
                verify.code
            ))
        );
        return 1;
    }
    let (served_exactly, funnel_enabled) = if let Ok(parsed) = parse_serve_status(&verify.stdout) {
        verify_served(&parsed, port)
    } else {
        // Serve-status output was unparseable: report the parse failure
        // (matching the status command), not a pending-enable flow.
        let _ = writeln!(
            out,
            "{}",
            red("post-serve verification failed: tailscale serve status output was unparseable")
        );
        return 1;
    };
    if !served_exactly {
        let _ = writeln!(
            out,
            "{}",
            yellow(
                "tailscale exited 0 but the target does not appear in `tailscale serve status` \
                 - an interactive enable flow (URL printed above) may still be pending; re-run \
                 this command after enabling."
            )
        );
        return 1;
    }
    if funnel && !funnel_enabled {
        let _ = writeln!(
            out,
            "{}",
            yellow(
                "the local target is served, but `tailscale serve status` reports the endpoint \
                 as NOT funnel-enabled - check your tailnet funnel ACL and the enable URL \
                 printed above, then re-run."
            )
        );
        return 1;
    }
    let _ = writeln!(out);
    // Advertise only a REAL tailnet host: the reachability line needs both a
    // usable hostname and the tailnet's real MagicDNS suffix. A missing
    // suffix must skip the line (like the missing-hostname case) instead of
    // composing a made-up domain: a short `HostName` under `ts.net` is not
    // this node's MagicDNS name, so `{hostname}.ts.net` would not reach
    // the node.
    if let (Some(hostname), Some(raw_suffix)) = (&probe.hostname, &probe.magic_dns_suffix) {
        let suffix = trim_trailing_dots(raw_suffix);
        // Exact domain-suffix match: the hostname must end with ".<suffix>" (or
        // equal it).
        let host = if hostname.ends_with(&format!(".{suffix}")) || hostname == suffix {
            hostname.clone()
        } else {
            format!("{hostname}.{suffix}")
        };
        let _ = writeln!(
            out,
            "{}",
            green(&format!("Now reachable on your tailnet as {host}"))
        );
        if funnel {
            let _ = writeln!(out, "Public URL: https://{host}/");
        }
    }
    let _ = writeln!(
        out,
        "Stop with: tailscale serve status, then tailscale serve off (or funnel off)"
    );
    0
}

/// Whether a port is an integer in 1-65535 (TS `Number.isInteger(port) || ...`).
fn valid_port(port: f64) -> bool {
    port.is_finite() && port.fract().abs() < f64::EPSILON && (1.0..=65535.0).contains(&port)
}

/// Run the interactive serve/funnel call (TS `stdio: "inherit"`: stdin, stdout,
/// and stderr are inherited so funnel's first-enable prompt works). Returns the
/// exit code, or 1 when the spawn fails or the call times out.
async fn spawn_serve(program: &OsStr, args: &[&str]) -> i32 {
    let status = tokio::process::Command::new(program)
        .args(args)
        .kill_on_drop(true)
        .status();
    match tokio::time::timeout(SERVE_TIMEOUT, status).await {
        Ok(Ok(status)) => status.code().unwrap_or(1),
        Ok(Err(_)) | Err(_) => 1,
    }
}

/// Whether the target appears in a serve status payload (exact match), and
/// whether the matched endpoint is funnel-enabled.
fn verify_served(parsed: &Value, port: u16) -> (bool, bool) {
    let mut served_exactly = false;
    let mut funnel_enabled = false;
    let tcp_port = format!("{port}");
    if let Some(tcp) = parsed.get("TCP").and_then(Value::as_object) {
        for entry in tcp.values() {
            if let Some(forward) = entry.get("TCPForward").and_then(Value::as_str) {
                if forward == format!("127.0.0.1:{tcp_port}")
                    || forward == format!("localhost:{tcp_port}")
                {
                    served_exactly = true;
                }
            }
        }
    }
    if let Some(web) = parsed.get("Web").and_then(Value::as_object) {
        let allow_funnel = parsed.get("AllowFunnel").and_then(Value::as_object);
        for (listen, server) in web {
            let Some(handlers) = server.get("Handlers").and_then(Value::as_object) else {
                continue;
            };
            for handler in handlers.values() {
                let Some(proxy) = handler.get("Proxy").and_then(Value::as_str) else {
                    continue;
                };
                let Some(target) = proxy_target(proxy) else {
                    continue;
                };
                if target.port == port && target.loopback {
                    served_exactly = true;
                    if allow_funnel
                        .and_then(|map| map.get(listen))
                        .and_then(Value::as_bool)
                        == Some(true)
                    {
                        funnel_enabled = true;
                    }
                }
            }
        }
    }
    (served_exactly, funnel_enabled)
}

/// A parsed serve proxy target.
struct ProxyTarget {
    port: u16,
    loopback: bool,
}

/// The loopback host and port of a serve proxy target (TS `new URL(proxy)`,
/// for the `scheme://host[:port]` targets tailscale writes). `None` when the
/// target has no scheme or a non-numeric/explicit port above 65535.
fn proxy_target(proxy: &str) -> Option<ProxyTarget> {
    let (scheme, rest) = proxy.split_once("://")?;
    let authority = rest.split(['/', '?', '#']).next().unwrap_or_default();
    let (host, explicit_port) = split_authority(authority);
    let port = match explicit_port {
        Some(text) => text.parse::<u16>().ok()?,
        // `URL.port` is "" for default ports (80 for http:, 443 for https:).
        None => {
            if scheme.eq_ignore_ascii_case("https") {
                443
            } else {
                80
            }
        }
    };
    Some(ProxyTarget {
        port,
        loopback: is_loopback_host(host),
    })
}

/// Split a URL authority into host and explicit port, honoring IPv6 brackets.
fn split_authority(authority: &str) -> (&str, Option<&str>) {
    if let Some(rest) = authority.strip_prefix('[') {
        return match rest.split_once(']') {
            Some((host, tail)) => (host, tail.strip_prefix(':').filter(|port| !port.is_empty())),
            None => (authority, None),
        };
    }
    match authority.rsplit_once(':') {
        Some((host, port))
            if !port.is_empty() && port.bytes().all(|byte| byte.is_ascii_digit()) =>
        {
            (host, Some(port))
        }
        _ => (authority, None),
    }
}

fn is_loopback_host(host: &str) -> bool {
    matches!(host, "127.0.0.1" | "localhost" | "::1")
}

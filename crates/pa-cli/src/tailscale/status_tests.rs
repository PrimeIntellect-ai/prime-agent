//! `tailscale status` tests: the exit codes and the printed overview,
//! including the served-endpoint rows and the `null` serve-status case.

use super::super::status::run_status_to;
use super::super::*;
use super::*;

#[tokio::test]
async fn status_exits_one_with_the_install_hint_when_the_cli_is_missing() {
    let dir = missing_binary();
    let missing = dir.path().join("tailscale");
    assert_eq!(run_status(missing.as_os_str(), false).await, 1);
    assert_eq!(run_status(missing.as_os_str(), true).await, 1);
}

#[tokio::test]
async fn status_exits_one_when_the_backend_is_stopped() {
    let stopped = serde_json::json!({
        "BackendState": "Stopped",
        "Self": { "Online": false },
    })
    .to_string();
    let shim = Shim::write(&stopped, "{}");
    let program = shim.path();
    assert_eq!(run_status(program.as_os_str(), false).await, 1);
    assert_eq!(run_status(program.as_os_str(), true).await, 1);
}

#[tokio::test]
async fn status_exits_zero_and_prints_forwards_and_web_rows() {
    let serve_status = serde_json::json!({
        "TCP": {
            "10000": { "TCPForward": "127.0.0.1:9000" },
            "443": { "HTTPS": true },
        },
        "Web": {
            "milk.tailnet.ts.net:443": {
                "Handlers": { "/": { "Proxy": "http://127.0.0.1:3000" } }
            }
        },
        "AllowFunnel": {},
    })
    .to_string();
    let shim = Shim::write(ONLINE, &serve_status);
    let program = shim.path();
    let mut json_buf = Vec::new();
    assert_eq!(
        run_status_to(&mut json_buf, program.as_os_str(), true).await,
        0
    );
    let mut buf = Vec::new();
    assert_eq!(run_status_to(&mut buf, program.as_os_str(), false).await, 0);
    let text = String::from_utf8(buf).expect("utf8");
    assert!(text.contains("127.0.0.1:9000"), "{text}");
    assert!(
        text.contains("milk.tailnet.ts.net:443/ -> http://127.0.0.1:3000"),
        "{text}"
    );
    // The HTTPS listener must not read as a TCP forward.
    assert!(!text.contains("-> tcp"), "{text}");
}

#[tokio::test]
async fn status_reads_a_null_serve_status_as_nothing_served() {
    // `tailscale serve status --json` answers a bare `null` when nothing is
    // served.
    let shim = Shim::write(ONLINE, "null");
    let program = shim.path();
    let mut buf = Vec::new();
    assert_eq!(run_status_to(&mut buf, program.as_os_str(), false).await, 0);
    let text = String::from_utf8(buf).expect("utf8");
    assert!(text.contains("nothing"), "{text}");
    assert!(!text.contains("unparseable"), "{text}");
}

#[tokio::test]
async fn status_returns_zero_when_serve_status_is_unavailable_after_a_successful_probe() {
    let shim = Shim::raw(&format!(
        "#!/bin/sh\n\
         [ \"$1\" = version ] && exit 0\n\
         if [ \"$1\" = status ]; then printf '%s' '{ONLINE}'; exit 0; fi\n\
         echo err >&2\nexit 1\n"
    ));
    assert_eq!(run_status(shim.path().as_os_str(), false).await, 0);
}

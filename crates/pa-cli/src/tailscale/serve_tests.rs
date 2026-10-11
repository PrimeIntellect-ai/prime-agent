//! `tailscale serve` tests: port validation before any spawn, the exact
//! serve/funnel argv, and the post-serve verification traps (a substring
//! port must not match, `tailscale` exiting 0 without serving must fail).
use super::super::serve::run_serve_to;
use super::super::*;
use super::*;

#[tokio::test]
async fn serve_refuses_ports_outside_the_valid_range_before_anything_else() {
    let shim = Shim::write(ONLINE, &serve_status_for(3000));
    let program = shim.path();
    assert_eq!(run_serve(program.as_os_str(), 0.0, false).await, 1);
    assert_eq!(run_serve(program.as_os_str(), 65536.0, false).await, 1);
    assert_eq!(run_serve(program.as_os_str(), 3000.5, false).await, 1);
    assert!(
        shim.argvs().is_empty(),
        "an invalid port must not spawn: {:?}",
        shim.argvs()
    );
}

#[tokio::test]
async fn serve_refuses_when_the_cli_is_missing() {
    let dir = missing_binary();
    let missing = dir.path().join("tailscale");
    assert_eq!(run_serve(missing.as_os_str(), 3000.0, false).await, 1);
}

#[tokio::test]
async fn serve_builds_serve_and_funnel_background_argv() {
    let shim = Shim::write(ONLINE, &serve_status_for(3000));
    let program = shim.path();
    assert_eq!(run_serve(program.as_os_str(), 3000.0, false).await, 0);
    assert_eq!(run_serve(program.as_os_str(), 3000.0, true).await, 0);
    let spawned: Vec<Vec<String>> = shim
        .argvs()
        .into_iter()
        .filter(|argv| {
            matches!(argv.first().map(String::as_str), Some("serve" | "funnel"))
                && argv.get(1).map(String::as_str) != Some("status")
        })
        .collect();
    assert_eq!(
        spawned,
        vec![
            vec![
                "serve".to_string(),
                "--bg".to_string(),
                "localhost:3000".to_string()
            ],
            vec![
                "funnel".to_string(),
                "--bg".to_string(),
                "localhost:3000".to_string()
            ],
        ]
    );
    // funnel requested, endpoint not funnel-enabled -> failure.
    let not_public = Shim::write(
        ONLINE,
        &serve_status_for(3000).replace(
            "\"milk.tailnet.ts.net:443\":true",
            "\"milk.tailnet.ts.net:443\":false",
        ),
    );
    assert_eq!(
        run_serve(not_public.path().as_os_str(), 3000.0, true).await,
        1
    );
}

#[tokio::test]
async fn post_serve_verification_does_not_match_a_longer_port_via_substring() {
    let longer = Shim::write(
        ONLINE,
        &serde_json::json!({
            "Web": {
                "milk.ts.net:443": {
                    "Handlers": { "/": { "Proxy": "http://localhost:8000" } }
                }
            }
        })
        .to_string(),
    );
    assert_eq!(run_serve(longer.path().as_os_str(), 80.0, false).await, 1);
    let exact_tcp = Shim::write(
        ONLINE,
        &serde_json::json!({ "TCP": { "443": { "TCPForward": "127.0.0.1:80" } } }).to_string(),
    );
    assert_eq!(
        run_serve(exact_tcp.path().as_os_str(), 80.0, false).await,
        0
    );
    let default_port = Shim::write(
        ONLINE,
        &serve_status_for(80).replace("http://127.0.0.1:80", "http://127.0.0.1"),
    );
    assert_eq!(
        run_serve(default_port.path().as_os_str(), 80.0, false).await,
        0
    );
}

#[tokio::test]
async fn post_serve_verification_treats_a_bare_https_proxy_target_as_port_443() {
    let shim = Shim::write(
        ONLINE,
        &serde_json::json!({
            "Web": {
                "milk.ts.net:443": {
                    "Handlers": { "/": { "Proxy": "https://127.0.0.1" } }
                }
            }
        })
        .to_string(),
    );
    assert_eq!(run_serve(shim.path().as_os_str(), 443.0, false).await, 0);
}

#[tokio::test]
async fn serve_fails_when_tailscale_exits_zero_without_serving_the_target() {
    let pending = Shim::write(ONLINE, "{}");
    assert_eq!(
        run_serve(pending.path().as_os_str(), 3000.0, false).await,
        1
    );
    let served = Shim::write(ONLINE, &serve_status_for(3000));
    assert_eq!(run_serve(served.path().as_os_str(), 3000.0, false).await, 0);
}

#[tokio::test]
async fn serve_treats_a_null_serve_status_as_nothing_served_not_a_parse_failure() {
    let shim = Shim::write(ONLINE, "null");
    let program = shim.path();
    let mut buf = Vec::new();
    assert_eq!(
        run_serve_to(&mut buf, program.as_os_str(), 3000.0, false).await,
        1
    );
    let text = String::from_utf8(buf).expect("utf8");
    assert!(text.contains("interactive enable flow"), "{text}");
    assert!(!text.contains("unparseable"), "{text}");
}

#[tokio::test]
async fn serve_never_advertises_an_empty_host_as_the_tailnet_url() {
    // A dot-only DNSName with no usable HostName reads as nameless, so the
    // success path skips the reachability line instead of advertising the
    // tailnet URL as `.<suffix>`.
    let nameless = serde_json::json!({
        "BackendState": "Running",
        "Self": { "Online": true, "DNSName": "." },
        "CurrentTailnet": { "MagicDNSSuffix": "tailnet.ts.net." },
    })
    .to_string();
    let shim = Shim::write(&nameless, &serve_status_for(3000));
    let program = shim.path();
    let mut buf = Vec::new();
    assert_eq!(
        run_serve_to(&mut buf, program.as_os_str(), 3000.0, false).await,
        0
    );
    let text = String::from_utf8(buf).expect("utf8");
    assert!(!text.contains("Now reachable"), "{text}");
    assert!(!text.contains(".tailnet.ts.net as"), "{text}");
    assert!(!text.contains("Public URL: https://."), "{text}");
}

#[tokio::test]
async fn serve_never_invents_a_host_when_no_real_suffix_exists() {
    // A missing MagicDNS suffix must skip the reachability line (like the
    // missing-hostname case) instead of composing a made-up domain: a
    // short `HostName` under `ts.net` is not this node's MagicDNS name, so
    // `{hostname}.ts.net` would not reach the node.
    let no_suffix = serde_json::json!({
        "BackendState": "Running",
        "Self": { "Online": true, "HostName": "milk" },
    })
    .to_string();
    let shim = Shim::write(&no_suffix, &serve_status_for(3000));
    let program = shim.path();
    let mut buf = Vec::new();
    assert_eq!(
        run_serve_to(&mut buf, program.as_os_str(), 3000.0, true).await,
        0
    );
    let text = String::from_utf8(buf).expect("utf8");
    assert!(!text.contains("Now reachable"), "{text}");
    assert!(!text.contains("milk.ts.net"), "{text}");
    assert!(!text.contains("Public URL: https://milk"), "{text}");
    // The funnel command still succeeds and prints its stop line.
    assert!(text.contains("Stop with:"), "{text}");
}

#[tokio::test]
async fn serve_uses_a_real_suffix_instead_of_advertising_a_trailing_dot_host() {
    // A present-but-empty CurrentTailnet.MagicDNSSuffix must yield to the
    // top-level one: an empty suffix used as present would trim to no
    // domain and advertise the reachability URL as the trailing-dot host
    // `milk.` instead of `milk.tailnet.ts.net`.
    let payload = serde_json::json!({
        "BackendState": "Running",
        "Self": { "Online": true, "DNSName": "milk." },
        "MagicDNSSuffix": "tailnet.ts.net.",
        "CurrentTailnet": { "MagicDNSSuffix": "" },
    })
    .to_string();
    let shim = Shim::write(&payload, &serve_status_for(3000));
    let program = shim.path();
    let mut buf = Vec::new();
    let code = run_serve_to(&mut buf, program.as_os_str(), 3000.0, false).await;
    let text = String::from_utf8(buf).expect("utf8");
    // The serve output rides the assertion: a transient spawn failure exits
    // 1 through one of the failure branches, and the printed branch is the
    // diagnosis the CI log needs (the exit code alone says nothing).
    assert_eq!(code, 0, "serve must succeed: {text}");
    assert!(
        text.contains("Now reachable on your tailnet as milk.tailnet.ts.net\n"),
        "{text}"
    );
    assert!(!text.contains("milk.\n"), "{text}");
}

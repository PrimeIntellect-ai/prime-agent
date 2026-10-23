//! Shared fixtures for the tailscale suites: a fake `tailscale` binary on
//! disk exercises the real spawn/capture path (large-tailnet payloads
//! included); the per-area suites live in the sibling `*_tests.rs` files and
//! reach these through `use super::*`.

use std::fs;
use std::os::unix::fs::PermissionsExt;
use std::path::{Path, PathBuf};

use tempfile::TempDir;

/// A realistic online status payload.
const ONLINE: &str = concat!(
    r#"{"BackendState":"Running","Self":{"Online":true,"HostName":"milk","#,
    r#""DNSName":"milk.tailnet.ts.net."},"MagicDNSSuffix":"tailnet.ts.net."}"#,
);

fn args(values: &[&str]) -> Vec<String> {
    values.iter().map(|value| (*value).to_string()).collect()
}

fn write_executable(path: &Path, contents: &str) {
    fs::write(path, contents).expect("write shim");
    let mut permissions = fs::metadata(path).expect("stat shim").permissions();
    permissions.set_mode(0o755);
    fs::set_permissions(path, permissions).expect("chmod shim");
}

/// A fake `tailscale` binary: answers `version` (exit 0), `status` with the
/// given payload, and `serve status` with the given payload; appends every
/// argv to `argv.log`.
struct Shim {
    dir: TempDir,
}

impl Shim {
    fn write(status_json: &str, serve_json: &str) -> Shim {
        let dir = tempfile::tempdir().expect("temp dir");
        fs::write(dir.path().join("status.json"), status_json).expect("status payload");
        fs::write(dir.path().join("serve.json"), serve_json).expect("serve payload");
        let script = format!(
            "#!/bin/sh\n\
             printf '%s\\n' \"$*\" >> '{log}'\n\
             [ \"$1\" = version ] && exit 0\n\
             if [ \"$1\" = status ]; then cat '{status}'; exit 0; fi\n\
             if [ \"$1\" = serve ] && [ \"$2\" = status ]; then cat '{serve}'; exit 0; fi\n\
             case \"$1\" in serve|funnel) exit 0;; esac\n\
             exit 1\n",
            log = dir.path().join("argv.log").display(),
            status = dir.path().join("status.json").display(),
            serve = dir.path().join("serve.json").display(),
        );
        write_executable(&dir.path().join("tailscale"), &script);
        Shim { dir }
    }

    /// A shim whose whole behavior is the given script.
    fn raw(script: &str) -> Shim {
        let dir = tempfile::tempdir().expect("temp dir");
        write_executable(&dir.path().join("tailscale"), script);
        Shim { dir }
    }

    fn path(&self) -> PathBuf {
        self.dir.path().join("tailscale")
    }

    /// The directory the shim lives in: a trusted `PATH` entry in the
    /// resolution tests.
    fn dir(&self) -> PathBuf {
        self.dir.path().to_path_buf()
    }

    fn argvs(&self) -> Vec<Vec<String>> {
        fs::read_to_string(self.dir.path().join("argv.log"))
            .map(|log| {
                log.lines()
                    .map(|line| line.split_whitespace().map(str::to_string).collect())
                    .collect()
            })
            .unwrap_or_default()
    }
}

/// A serve-status payload whose Web map proxies the given local port.
fn serve_status_for(port: u32) -> String {
    serde_json::json!({
        "Web": {
            "milk.tailnet.ts.net:443": {
                "Handlers": { "/": { "Proxy": format!("http://127.0.0.1:{port}") } }
            }
        },
        "AllowFunnel": { "milk.tailnet.ts.net:443": true },
    })
    .to_string()
}

/// A realistic `status --json` payload for a `peer_count`-node tailnet: the
/// real one carries every peer (~1 KiB of JSON each), so this is the shape
/// a large-tailnet read must survive without truncating.
fn large_tailnet_status(peer_count: usize) -> String {
    let mut peers = serde_json::Map::new();
    for index in 0..peer_count {
        let ip = format!("100.64.{}.{}", index % 250, (index * 7) % 250);
        let public_key = format!("nodekey:{}{index:04x}", "a1b2c3d4e5f60718".repeat(3));
        peers.insert(
            public_key.clone(),
            serde_json::json!({
                "ID": format!("n{index}CNTRL"),
                "PublicKey": public_key,
                "HostName": format!("build-{index}"),
                "DNSName": format!("build-{index}.tailnet.ts.net."),
                "OS": if index % 3 == 0 { "linux" } else { "macOS" },
                "UserID": 123_456_789_u64,
                "TailscaleIPs": [ip, "fd7a:115c:a1e0:ab12:4843:cd96:6258:1c2d"],
                "AllowedIPs": [
                    format!("{ip}/32"),
                    "fd7a:115c:a1e0:ab12:4843:cd96:6258:1c2d/128"
                ],
                "Addrs": [format!("192.168.{}:41641", index % 250)],
                "CurAddr": format!("192.168.{}:41641", (index * 3) % 250),
                "Relay": "nyc",
                "RxBytes": 123_456_789_u64 + index as u64,
                "TxBytes": 98_765_432_u64 + index as u64,
                "Created": "2024-01-05T12:34:56.789012345Z",
                "LastSeen": "2026-09-28T19:00:00Z",
                "LastHandshake": "2026-09-28T18:59:00Z",
                "Online": true,
                "ExitNode": false,
                "ExitNodeOption": false,
                "Active": false,
                "PeerAPIURL": [format!("http://{ip}:43210")],
            }),
        );
    }
    serde_json::json!({
        "BackendState": "Running",
        "Self": { "Online": true, "HostName": "milk", "DNSName": "milk.tailnet.ts.net." },
        "MagicDNSSuffix": "tailnet.ts.net.",
        "CurrentTailnet": { "Name": "example.com", "MagicDNSSuffix": "tailnet.ts.net." },
        "Peer": serde_json::Value::Object(peers),
    })
    .to_string()
}

fn missing_binary() -> TempDir {
    tempfile::tempdir().expect("temp dir")
}

#[path = "args_tests.rs"]
mod args_tests;
#[path = "probe_tests.rs"]
mod probe_tests;
#[path = "serve_tests.rs"]
mod serve_tests;
#[path = "status_tests.rs"]
mod status_tests;

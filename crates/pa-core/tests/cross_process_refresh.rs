//! The OAuth refresh single-flight across processes: two daemon workers
//! (one worker process per session) resolving the same expired OAuth
//! credential must spend the single-use refresh token exactly once — the
//! backend's cross-process refresh lock serializes the re-check, fetch,
//! and write, and the peer that waited serves the winner's fresh
//! credential instead of re-fetching.
use std::sync::Arc;
use std::time::{Duration, Instant};

use pa_core::auth::{AuthCredential, AuthStorage, AuthStorageData, OAuthIntegration};

const CHILD_ENV: &str = "PA_CROSS_PROCESS_REFRESH_CHILD_DIR";

/// Records every token-endpoint call and holds the fetch open until a peer
/// process also enters its fetch (or the deadline passes): a serialized
/// peer never enters its fetch while one holds the refresh lock, so
/// exactly one call is the correct, serialized outcome — and a racing
/// double-spend (the head behavior) records two.
struct CountingRefresh {
    dir: std::path::PathBuf,
}

impl CountingRefresh {
    fn calls(&self) -> usize {
        std::fs::read_to_string(self.dir.join("refresh-calls"))
            .map_or(0, |text| text.lines().count())
    }
}

impl OAuthIntegration for CountingRefresh {
    fn api_key_for(&self, _provider: &str, credential: &AuthCredential) -> Option<String> {
        match credential {
            AuthCredential::Oauth { access, .. } => Some(access.clone()),
            _ => None,
        }
    }

    fn refresh(&self, provider: &str, credentials: &AuthStorageData) -> Option<AuthCredential> {
        use std::io::Write as _;
        let spent = match credentials.credential(provider) {
            Some(AuthCredential::Oauth { refresh, .. }) => refresh.unwrap_or_default(),
            _ => String::new(),
        };
        let mut file = std::fs::OpenOptions::new()
            .create(true)
            .append(true)
            .open(self.dir.join("refresh-calls"))
            .expect("the counter file opens");
        writeln!(
            file,
            "pid={} spent_refresh_token={spent}",
            std::process::id()
        )
        .expect("the call is recorded");
        drop(file);
        let deadline = Instant::now() + Duration::from_secs(5);
        while self.calls() < 2 && Instant::now() < deadline {
            std::thread::sleep(Duration::from_millis(20));
        }
        Some(AuthCredential::Oauth {
            access: format!("fresh-{}", std::process::id()),
            refresh: Some(format!("rotated-{}", std::process::id())),
            expires: 4_102_444_800_000,
            account_id: None,
            enterprise_url: None,
            endpoint: None,
            token_endpoint: None,
            client_id: None,
            resource: None,
            issuer: None,
            audience_mode: None,
        })
    }
}

fn resolve(dir: &std::path::Path) -> Option<String> {
    let mut auth = AuthStorage::create_with_oauth(
        dir,
        Arc::new(CountingRefresh {
            dir: dir.to_path_buf(),
        }),
    );
    auth.get_api_key_with_source_token("battery", false).api_key
}

/// Child role only: the parent test re-executes this binary.
#[test]
fn child_resolver() {
    let Ok(dir) = std::env::var(CHILD_ENV) else {
        return;
    };
    let key = resolve(std::path::Path::new(&dir));
    println!("CHILD_KEY={key:?}");
}

/// Two processes resolving one expired OAuth credential spend the
/// single-use refresh token exactly once: the cross-process refresh lock
/// serializes them, and the peer that waited serves the winner's fresh
/// credential.
#[test]
fn two_processes_spend_one_refresh_token() {
    let dir = tempfile::TempDir::new().unwrap();
    std::fs::write(
        dir.path().join("auth.json"),
        serde_json::json!({
            "battery": { "type": "oauth", "access": "expired-access",
                "refresh": "r-original", "expires": 1 }
        })
        .to_string(),
    )
    .unwrap();
    let child = std::process::Command::new(std::env::current_exe().unwrap())
        .args(["--exact", "child_resolver", "--nocapture"])
        .env(CHILD_ENV, dir.path())
        .stdout(std::process::Stdio::piped())
        .spawn()
        .unwrap();
    let parent_key = resolve(dir.path());
    let child_out = child.wait_with_output().unwrap();
    let calls = std::fs::read_to_string(dir.path().join("refresh-calls")).unwrap_or_default();
    let child_key = String::from_utf8_lossy(&child_out.stdout)
        .lines()
        .find_map(|line| line.strip_prefix("CHILD_KEY="))
        .map(str::to_string);
    assert_eq!(
        calls.lines().count(),
        1,
        "the refresh token is spent once across the two processes:\n{calls}"
    );
    assert_eq!(
        parent_key,
        Some(format!("fresh-{}", std::process::id())),
        "the parent resolved a fresh credential"
    );
    assert!(
        child_key
            .as_deref()
            .is_some_and(|key| key.starts_with("Some(")),
        "the child resolved a fresh credential too: {child_key:?}"
    );
    let stored = std::fs::read_to_string(dir.path().join("auth.json")).unwrap();
    assert!(
        stored.contains("fresh-"),
        "the refreshed credential landed in the store"
    );
}

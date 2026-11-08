//! The OAuth refresh single-flight across processes: two daemon workers
//! (one worker process per session) resolving the same expired OAuth
//! credential must spend the single-use refresh token exactly once — the
//! backend's cross-process refresh lock serializes the re-check, fetch,
//! and write, and the peer that waited serves the winner's fresh
//! credential instead of re-fetching. The lock is owner-recorded: a stale
//! lock is reclaimed only from a provably dead holder, so a live worker
//! paused past the staleness window keeps it and its peer waits instead
//! of spending the token a second time.
use std::sync::Arc;
use std::time::{Duration, Instant};

use pa_core::auth::{AuthCredential, AuthStorage, AuthStorageData, OAuthIntegration};

const CHILD_ENV: &str = "PA_CROSS_PROCESS_REFRESH_CHILD_DIR";
#[cfg(unix)]
const PAUSED_CHILD_ENV: &str = "PA_CROSS_PROCESS_REFRESH_PAUSED_CHILD_DIR";

/// The token-endpoint calls recorded so far.
fn recorded_calls(dir: &std::path::Path) -> usize {
    std::fs::read_to_string(dir.join("refresh-calls")).map_or(0, |text| text.lines().count())
}

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
        recorded_calls(&self.dir)
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

/// Records the token-endpoint call and returns a fresh credential, pausing
/// the caller (SIGSTOP) after the successful fetch and before the credential
/// write when asked: the schedule a stale-lock steal needs a live holder in.
#[cfg(unix)]
struct PausingRefresh {
    dir: std::path::PathBuf,
    pause: bool,
}

#[cfg(unix)]
impl OAuthIntegration for PausingRefresh {
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
        let fresh = AuthCredential::Oauth {
            access: format!("fresh-{}", std::process::id()),
            refresh: Some("rotated".to_string()),
            expires: 4_102_444_800_000,
            account_id: None,
            enterprise_url: None,
            endpoint: None,
            token_endpoint: None,
            client_id: None,
            resource: None,
            issuer: None,
            audience_mode: None,
        };
        if self.pause {
            std::fs::write(self.dir.join("paused-ready"), "ready").unwrap();
            // A scheduling pause at the successful-fetch/commit boundary,
            // not a slow HTTP request: the holder stays live and stopped.
            assert_eq!(unsafe { libc::raise(libc::SIGSTOP) }, 0);
        }
        Some(fresh)
    }
}

/// The stored `battery` access token, the credential the winner landed.
fn stored_access(dir: &std::path::Path) -> String {
    let stored: serde_json::Value =
        serde_json::from_str(&std::fs::read_to_string(dir.join("auth.json")).unwrap()).unwrap();
    stored["battery"]["access"]
        .as_str()
        .expect("the refreshed credential landed in the store")
        .to_string()
}

/// The child's printed `CHILD_KEY=Some("...")` value.
fn child_key(output: &std::process::Output) -> Option<String> {
    String::from_utf8_lossy(&output.stdout)
        .lines()
        .find_map(|line| line.strip_prefix("CHILD_KEY=Some(\""))
        .and_then(|rest| rest.strip_suffix("\")"))
        .map(str::to_string)
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

/// Resolve the expired credential through a [`PausingRefresh`]; `pause`
/// selects the paused-holder child role.
#[cfg(unix)]
fn resolve_with_pausing_refresh(
    dir: &std::path::Path,
    /*pause*/ pause: bool,
) -> Option<String> {
    let mut auth = AuthStorage::create_with_oauth(
        dir,
        Arc::new(PausingRefresh {
            dir: dir.to_path_buf(),
            pause,
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

/// Child role only (the paused-holder schedule).
#[cfg(unix)]
#[test]
fn paused_child_resolver() {
    let Ok(dir) = std::env::var(PAUSED_CHILD_ENV) else {
        return;
    };
    let key = resolve_with_pausing_refresh(std::path::Path::new(&dir), /*pause*/ true);
    println!("CHILD_KEY={key:?}");
}

/// Two processes resolving one expired OAuth credential spend the
/// single-use refresh token exactly once: the cross-process refresh lock
/// serializes them, and the peer that waited serves the winner's fresh
/// credential. Either process may legitimately win the lock — this test
/// deterministically selects the child-first schedule (the child fetches
/// while the parent waits on the lock) and asserts the CONTRACT, not the
/// winner's identity: one spend, and both processes serve the credential
/// that landed in the store.
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
    // Wait until the child records its fetch: it holds the refresh lock
    // while its fetch waits for a peer, so this process cannot resolve
    // first — the child-first schedule, where the parent-PID outcome
    // would be wrong (the child legitimately refreshed first).
    let deadline = Instant::now() + Duration::from_secs(10);
    while recorded_calls(dir.path()) < 1 {
        assert!(
            Instant::now() < deadline,
            "the child never recorded its fetch"
        );
        std::thread::sleep(Duration::from_millis(20));
    }
    let parent_key = resolve(dir.path());
    let child_out = child.wait_with_output().unwrap();
    let calls = std::fs::read_to_string(dir.path().join("refresh-calls")).unwrap_or_default();
    assert_eq!(
        calls.lines().count(),
        1,
        "the refresh token is spent once across the two processes:\n{calls}"
    );
    let stored_access = stored_access(dir.path());
    assert_eq!(
        parent_key.as_deref(),
        Some(stored_access.as_str()),
        "the parent serves the winning stored credential"
    );
    assert_eq!(
        child_key(&child_out).as_deref(),
        Some(stored_access.as_str()),
        "the child serves the winning stored credential: {:?}",
        child_key(&child_out)
    );
}

/// The refresh lock is owner-recorded: a worker `SIGSTOP`ped between its
/// successful token fetch and the credential write stays the lock's live
/// holder past the staleness window. A peer resolving the same expiry must
/// NOT reclaim the stale lock and spend the single-use refresh token a
/// second time — it waits, the paused holder finishes its commit, and the
/// peer serves the holder's fresh credential.
#[cfg(unix)]
#[test]
fn a_stale_refresh_lock_is_not_stolen_from_a_live_paused_holder() {
    let dir = tempfile::TempDir::new().unwrap();
    std::fs::write(
        dir.path().join("auth.json"),
        serde_json::json!({
            "battery": { "type": "oauth", "access": "expired",
                "refresh": "r-once", "expires": 1 }
        })
        .to_string(),
    )
    .unwrap();
    let child = std::process::Command::new(std::env::current_exe().unwrap())
        .args(["--exact", "paused_child_resolver", "--nocapture"])
        .env(PAUSED_CHILD_ENV, dir.path())
        .stdout(std::process::Stdio::piped())
        .spawn()
        .unwrap();
    // The child takes the refresh lock, records its token spend, and
    // pauses before the write.
    let deadline = Instant::now() + Duration::from_secs(10);
    while !dir.path().join("paused-ready").exists() {
        assert!(Instant::now() < deadline, "the child never paused");
        std::thread::sleep(Duration::from_millis(20));
    }
    // Resolve from this process concurrently with the paused holder.
    let parent_dir = dir.path().to_path_buf();
    let parent = std::thread::spawn(move || {
        resolve_with_pausing_refresh(&parent_dir, /*pause*/ false)
    });
    // Let the lock age past the staleness window, plus a margin that
    // guarantees a stealing implementation has already re-fetched (a
    // steal happens on the first acquire attempt past staleness) before
    // the holder resumes.
    let lock = dir.path().join("auth.json.refresh.lock");
    let stale_by = Instant::now() + Duration::from_secs(30);
    loop {
        let age = std::time::SystemTime::now()
            .duration_since(
                std::fs::metadata(&lock)
                    .expect("the refresh lock exists while the holder is paused")
                    .modified()
                    .unwrap(),
            )
            .unwrap_or_default();
        if age > Duration::from_secs(12) {
            break;
        }
        assert!(
            Instant::now() < stale_by,
            "the refresh lock never aged past staleness"
        );
        std::thread::sleep(Duration::from_millis(20));
    }
    std::thread::sleep(Duration::from_millis(500));
    assert_eq!(
        unsafe { libc::kill(child.id().cast_signed(), libc::SIGCONT) },
        0,
        "the paused holder resumes"
    );
    let parent_key = parent.join().expect("the parent resolution thread");
    let child_out = child.wait_with_output().unwrap();
    assert!(child_out.status.success(), "the child role exits cleanly");
    let calls = std::fs::read_to_string(dir.path().join("refresh-calls")).unwrap_or_default();
    println!("parent_key={parent_key:?}\ncalls={calls}");
    assert_eq!(
        calls.lines().count(),
        1,
        "a live holder's stale lock must not be stolen: the token was spent twice\n{calls}"
    );
    let stored_access = stored_access(dir.path());
    assert_eq!(
        parent_key.as_deref(),
        Some(stored_access.as_str()),
        "the peer serves the paused holder's landed credential"
    );
    assert_eq!(
        child_key(&child_out).as_deref(),
        Some(stored_access.as_str()),
        "the holder serves its own landed credential"
    );
}

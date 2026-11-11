//! The OAuth refresh single-flight across processes: two daemon workers
//! (one worker process per session) resolving the same expired OAuth
//! credential must spend the single-use refresh token exactly once — the
//! backend's cross-process refresh lock serializes the re-check, fetch,
//! and write, and the peer that waited serves the winner's fresh
//! credential instead of re-fetching. The lock is process-released (an
//! OS file lock): the kernel drops a dead holder's lock with its
//! process, and a live holder — even one paused past any staleness
//! window — keeps it until it finishes, so a peer always waits instead
//! of spending the token a second time. One lock file per provider: a
//! stalled refresh of one provider's token never blocks another's.
use std::sync::Arc;
use std::time::{Duration, Instant};

use pa_core::auth::{AuthCredential, AuthStorage, AuthStorageData, OAuthIntegration};

const CHILD_ENV: &str = "PA_CROSS_PROCESS_REFRESH_CHILD_DIR";
#[cfg(unix)]
const PAUSED_CHILD_ENV: &str = "PA_CROSS_PROCESS_REFRESH_PAUSED_CHILD_DIR";
const DEAD_CHILD_ENV: &str = "PA_CROSS_PROCESS_REFRESH_DEAD_CHILD_DIR";
const HELD_CHILD_ENV: &str = "PA_CROSS_PROCESS_REFRESH_HELD_CHILD_DIR";

/// The token-endpoint calls recorded so far.
fn recorded_calls(dir: &std::path::Path) -> usize {
    std::fs::read_to_string(dir.join("refresh-calls")).map_or(0, |text| text.lines().count())
}

/// Records every token-endpoint call and holds the fetch open until a peer
/// process also enters its fetch (or the deadline passes): a serialized
/// peer never enters its fetch while one holds the refresh lock, so
/// exactly one call is the correct, serialized outcome — and a racing
/// double-spend would record two.
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

    fn refresh(
        &self,
        provider: &str,
        credentials: &AuthStorageData,
    ) -> Result<AuthCredential, String> {
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
        Ok(AuthCredential::Oauth {
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

    fn refresh(
        &self,
        provider: &str,
        credentials: &AuthStorageData,
    ) -> Result<AuthCredential, String> {
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
        Ok(fresh)
    }
}

/// The stored provider access token, the credential the winner landed.
fn stored_access_for(dir: &std::path::Path, provider: &str) -> String {
    let stored: serde_json::Value =
        serde_json::from_str(&std::fs::read_to_string(dir.join("auth.json")).unwrap()).unwrap();
    stored[provider]["access"]
        .as_str()
        .expect("the refreshed credential landed in the store")
        .to_string()
}

/// The stored `battery` access token.
fn stored_access(dir: &std::path::Path) -> String {
    stored_access_for(dir, "battery")
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
    resolve_with(
        dir,
        "battery",
        Arc::new(CountingRefresh {
            dir: dir.to_path_buf(),
        }),
    )
}

/// Resolve one provider's credential through a custom OAuth integration.
fn resolve_with(
    dir: &std::path::Path,
    provider: &str,
    oauth: Arc<dyn OAuthIntegration>,
) -> Option<String> {
    let mut auth = AuthStorage::create_with_oauth(dir, oauth);
    auth.get_api_key_with_source_token(provider, false).api_key
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

/// The refresh lock is process-released: a worker `SIGSTOP`ped between
/// its successful token fetch and the credential write — a live holder
/// paused past any staleness window — keeps the lock. A peer resolving
/// the same expiry must NOT reclaim the lock and spend the single-use
/// refresh token a second time — it waits, the paused holder finishes
/// its commit, and the peer serves the holder's fresh credential.
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
    // Hold the pause through a stretch of the peer's acquisition wait:
    // the refresh lock is process-released with no staleness window, so
    // the pause only has to prove the LIVE holder keeps it while paused
    // and hands it to the still-waiting peer on resume. The resume stays
    // well inside the peer's 150x100ms acquisition budget.
    std::thread::sleep(Duration::from_secs(4));
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

/// Records the token-endpoint call, then exits the process while the
/// refresh lock is held inside the fetch: a crashed worker mid-fetch.
struct ExitingRefresh {
    dir: std::path::PathBuf,
}

impl OAuthIntegration for ExitingRefresh {
    fn api_key_for(&self, _provider: &str, credential: &AuthCredential) -> Option<String> {
        match credential {
            AuthCredential::Oauth { access, .. } => Some(access.clone()),
            _ => None,
        }
    }

    fn refresh(
        &self,
        _provider: &str,
        _credentials: &AuthStorageData,
    ) -> Result<AuthCredential, String> {
        use std::io::Write as _;
        let mut file = std::fs::OpenOptions::new()
            .create(true)
            .append(true)
            .open(self.dir.join("dead-calls"))
            .expect("the counter file opens");
        writeln!(file, "pid={}", std::process::id()).expect("the call is recorded");
        std::process::exit(6);
    }
}

/// Records the token-endpoint call, announces it, and holds the fetch
/// open until released: the schedule a stalled token endpoint produces
/// (the MCP OAuth fetch has no HTTP deadline).
struct HeldRefresh {
    dir: std::path::PathBuf,
}

impl OAuthIntegration for HeldRefresh {
    fn api_key_for(&self, _provider: &str, credential: &AuthCredential) -> Option<String> {
        match credential {
            AuthCredential::Oauth { access, .. } => Some(access.clone()),
            _ => None,
        }
    }

    fn refresh(
        &self,
        _provider: &str,
        _credentials: &AuthStorageData,
    ) -> Result<AuthCredential, String> {
        use std::io::Write as _;
        let mut file = std::fs::OpenOptions::new()
            .create(true)
            .append(true)
            .open(self.dir.join("held-calls"))
            .expect("the counter file opens");
        writeln!(file, "pid={}", std::process::id()).expect("the call is recorded");
        drop(file);
        std::fs::write(self.dir.join("mcp-entered"), "entered").expect("the entered gate");
        let deadline = Instant::now() + Duration::from_secs(30);
        while !self.dir.join("release-mcp").exists() {
            assert!(
                Instant::now() < deadline,
                "the held fetch was never released"
            );
            std::thread::sleep(Duration::from_millis(20));
        }
        Ok(AuthCredential::Oauth {
            access: format!("fresh-mcp-{}", std::process::id()),
            refresh: Some("rotated-mcp".to_string()),
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

/// Records the token-endpoint call and answers immediately.
struct ImmediateRefresh {
    dir: std::path::PathBuf,
}

impl OAuthIntegration for ImmediateRefresh {
    fn api_key_for(&self, _provider: &str, credential: &AuthCredential) -> Option<String> {
        match credential {
            AuthCredential::Oauth { access, .. } => Some(access.clone()),
            _ => None,
        }
    }

    fn refresh(
        &self,
        _provider: &str,
        _credentials: &AuthStorageData,
    ) -> Result<AuthCredential, String> {
        use std::io::Write as _;
        let mut file = std::fs::OpenOptions::new()
            .create(true)
            .append(true)
            .open(self.dir.join("refresh-calls"))
            .expect("the counter file opens");
        writeln!(file, "pid={}", std::process::id()).expect("the call is recorded");
        Ok(AuthCredential::Oauth {
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

/// Child role only: the dead-holder schedule — exit inside the fetch.
#[test]
fn dead_child_resolver() {
    let Ok(dir) = std::env::var(DEAD_CHILD_ENV) else {
        return;
    };
    let dir = std::path::PathBuf::from(dir);
    let integration_dir = dir.clone();
    resolve_with(
        &dir,
        "deadbattery",
        Arc::new(ExitingRefresh {
            dir: integration_dir,
        }),
    );
}

/// Child role only: the held-fetch schedule — block inside the fetch
/// until released.
#[test]
fn held_child_resolver() {
    let Ok(dir) = std::env::var(HELD_CHILD_ENV) else {
        return;
    };
    let dir = std::path::PathBuf::from(dir);
    let integration_dir = dir.clone();
    let key = resolve_with(
        &dir,
        "mcp:slow",
        Arc::new(HeldRefresh {
            dir: integration_dir,
        }),
    );
    println!("CHILD_KEY={key:?}");
}

/// A holder that dies inside its fetch (a crashed worker) releases the
/// refresh lock with its process: the kernel drops the OS file lock, so
/// a peer refreshes immediately — no staleness window, no reclaim step
/// between observing a dead owner and removing its lock.
#[test]
fn a_dead_holder_releases_the_refresh_lock_with_its_process() {
    let dir = tempfile::TempDir::new().unwrap();
    std::fs::write(
        dir.path().join("auth.json"),
        serde_json::json!({
            "deadbattery": { "type": "oauth", "access": "expired-access",
                "refresh": "r-once", "expires": 1 }
        })
        .to_string(),
    )
    .unwrap();
    let mut child = std::process::Command::new(std::env::current_exe().unwrap())
        .args(["--exact", "dead_child_resolver", "--nocapture"])
        .env(DEAD_CHILD_ENV, dir.path())
        .stdout(std::process::Stdio::piped())
        .spawn()
        .unwrap();
    // The child records its token call and dies holding the lock.
    let deadline = Instant::now() + Duration::from_secs(10);
    loop {
        let recorded: usize = std::fs::read_to_string(dir.path().join("dead-calls"))
            .map_or(0, |text| text.lines().count());
        if recorded >= 1 {
            break;
        }
        assert!(
            Instant::now() < deadline,
            "the child never entered its fetch"
        );
        std::thread::sleep(Duration::from_millis(20));
    }
    child.wait().expect("the child exits inside its fetch");
    // The peer refreshes immediately: the process death released the lock.
    let start = Instant::now();
    let key = resolve_with(
        dir.path(),
        "deadbattery",
        Arc::new(ImmediateRefresh {
            dir: dir.path().to_path_buf(),
        }),
    );
    let elapsed = start.elapsed();
    assert_eq!(
        key.as_deref(),
        Some(stored_access_for(dir.path(), "deadbattery").as_str()),
        "the peer's own refresh serves"
    );
    assert!(
        elapsed < Duration::from_secs(5),
        "a dead holder releases the lock with its process, no staleness window: {elapsed:?}"
    );
}

/// One refresh lock per provider: an `mcp:slow` refresh stalled inside
/// its token fetch holds only its own lock, so an unrelated expired
/// credential refreshes immediately — a lock shared across auth.json
/// would stall the peer for the whole acquisition budget (15s) and
/// leave it serving no key.
#[test]
fn a_stalled_mcp_refresh_never_blocks_another_provider() {
    let dir = tempfile::TempDir::new().unwrap();
    std::fs::write(
        dir.path().join("auth.json"),
        serde_json::json!({
            "mcp:slow": { "type": "oauth", "access": "expired-mcp",
                "refresh": "r-mcp", "expires": 1 },
            "livebattery": { "type": "oauth", "access": "expired-battery",
                "refresh": "r-battery", "expires": 1 }
        })
        .to_string(),
    )
    .unwrap();
    let child = std::process::Command::new(std::env::current_exe().unwrap())
        .args(["--exact", "held_child_resolver", "--nocapture"])
        .env(HELD_CHILD_ENV, dir.path())
        .stdout(std::process::Stdio::piped())
        .spawn()
        .unwrap();
    // The child enters its stalled fetch holding the mcp:slow lock.
    let deadline = Instant::now() + Duration::from_secs(10);
    while !dir.path().join("mcp-entered").exists() {
        assert!(
            Instant::now() < deadline,
            "the child never entered its fetch"
        );
        std::thread::sleep(Duration::from_millis(20));
    }
    // The unrelated livebattery credential refreshes through its own
    // lock. (Distinct provider ids per test: the process-local refresh
    // flight is keyed by provider, so parallel tests sharing one provider
    // would serialize on the flight instead of their own locks.)
    let start = Instant::now();
    let key = resolve_with(
        dir.path(),
        "livebattery",
        Arc::new(ImmediateRefresh {
            dir: dir.path().to_path_buf(),
        }),
    );
    let elapsed = start.elapsed();
    assert_eq!(
        key.as_deref(),
        Some(stored_access_for(dir.path(), "livebattery").as_str()),
        "the livebattery refresh serves immediately"
    );
    assert!(
        elapsed < Duration::from_secs(5),
        "an unrelated provider's refresh never waits on a stalled mcp refresh: {elapsed:?}"
    );
    // Release the stalled fetch and reap the child.
    std::fs::write(dir.path().join("release-mcp"), "released").unwrap();
    let out = child.wait_with_output().unwrap();
    assert!(
        out.status.success(),
        "the held child exits cleanly: {out:?}"
    );
    let battery_calls =
        std::fs::read_to_string(dir.path().join("refresh-calls")).unwrap_or_default();
    assert_eq!(
        battery_calls.lines().count(),
        1,
        "one livebattery token call"
    );
    let mcp_calls = std::fs::read_to_string(dir.path().join("held-calls")).unwrap_or_default();
    assert_eq!(mcp_calls.lines().count(), 1, "one mcp token call");
}

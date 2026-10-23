//! AWS `credential_process` support: a profile in the AWS config file names a command that prints
//! version 1 credential JSON (`AccessKeyId`, `SecretAccessKey`, `SessionToken`, `Expiration`). The
//! result is cached per profile and command until shortly before it expires.

use std::collections::HashMap;
use std::sync::{LazyLock, Mutex};

use serde_json::Value;

use crate::providers::bedrock::auth::{profile_section_matches, AwsCredentials};

/// Refresh this long before the credentials expire so a request never signs with a dead token.
const REFRESH_MARGIN_SECS: u64 = 300;

struct CachedCredentials {
    credentials: AwsCredentials,
    /// `None` when the process reported no `Expiration` (non-expiring credentials).
    expires_at: Option<u64>,
}

/// Keyed by profile name and command, so an edited `credential_process` never serves the old
/// command's credentials.
static CACHE: LazyLock<Mutex<HashMap<String, CachedCredentials>>> =
    LazyLock::new(|| Mutex::new(HashMap::new()));

/// When the process output's `Expiration` says the credentials lapse.
enum Expiry {
    Never,
    At(u64),
    /// Present but not a timestamp we can read: use the credentials once, never cache them.
    Unknown,
}

/// The `credential_process` command of `profile` in an AWS config file.
fn find_command(config: &str, profile: &str) -> Option<String> {
    let mut in_section = false;
    for line in config.lines() {
        let trimmed = line.trim();
        if trimmed.starts_with('[') && trimmed.ends_with(']') {
            in_section = profile_section_matches(trimmed[1..trimmed.len() - 1].trim(), profile);
            continue;
        }
        if !in_section {
            continue;
        }
        if let Some((key, value)) = trimmed.split_once('=') {
            if key.trim() == "credential_process" && !value.trim().is_empty() {
                return Some(value.trim().to_string());
            }
        }
    }
    None
}

/// Seconds since the Unix epoch for an RFC 3339 timestamp (`Z` or a `±HH:MM` offset); fractional
/// seconds are ignored.
fn parse_rfc3339(text: &str) -> Option<u64> {
    let (date, rest) = text.trim().split_once(['T', 't'])?;
    let (time, offset_secs) = if let Some(time) = rest.strip_suffix(['Z', 'z']) {
        (time, 0)
    } else {
        let split = rest.rfind(['+', '-'])?;
        let (time, offset) = rest.split_at(split);
        let sign = if offset.starts_with('-') { -1 } else { 1 };
        let (hours, minutes) = offset[1..].split_once(':')?;
        let hours: i64 = hours.parse().ok()?;
        let minutes: i64 = minutes.parse().ok()?;
        (time, sign * (hours * 3600 + minutes * 60))
    };
    let mut date_parts = date.split('-');
    let year: i64 = date_parts.next()?.parse().ok()?;
    let month: i64 = date_parts.next()?.parse().ok()?;
    let day: i64 = date_parts.next()?.parse().ok()?;
    let mut time_parts = time.split('.').next()?.split(':');
    let hour: i64 = time_parts.next()?.parse().ok()?;
    let minute: i64 = time_parts.next()?.parse().ok()?;
    let second: i64 = time_parts.next()?.parse().ok()?;
    if date_parts.next().is_some() || time_parts.next().is_some() || !(1..=12).contains(&month) {
        return None;
    }
    // Howard Hinnant's days_from_civil, the inverse of `auth::civil_from_unix`.
    let y = if month <= 2 { year - 1 } else { year };
    let era = y.div_euclid(400);
    let yoe = y.rem_euclid(400);
    let mp = (month + 9) % 12;
    let doy = (153 * mp + 2) / 5 + day - 1;
    let doe = yoe * 365 + yoe / 4 - yoe / 100 + doy;
    let days = era * 146_097 + doe - 719_468;
    u64::try_from(days * 86_400 + hour * 3600 + minute * 60 + second - offset_secs).ok()
}

/// Parse what a `credential_process` prints (the AWS version 1 JSON document).
fn parse_output(stdout: &[u8]) -> Option<(AwsCredentials, Expiry)> {
    let value: Value = serde_json::from_slice(stdout).ok()?;
    let field = |name: &str| {
        value
            .get(name)
            .and_then(Value::as_str)
            .filter(|text| !text.is_empty())
            .map(str::to_string)
    };
    let credentials = AwsCredentials {
        access_key_id: field("AccessKeyId")?,
        secret_access_key: field("SecretAccessKey")?,
        session_token: field("SessionToken"),
    };
    let expiry = match field("Expiration") {
        None => Expiry::Never,
        Some(text) => parse_rfc3339(&text).map_or(Expiry::Unknown, Expiry::At),
    };
    Some((credentials, expiry))
}

/// Dropping the returned future kills the spawned shell (and the command, when the shell runs it
/// in place), so a caller that stops waiting (cancellation, timeout) is not tied to a stalled
/// `credential_process`.
async fn run(command: &str) -> Option<Vec<u8>> {
    let mut process = if cfg!(windows) {
        let mut process = tokio::process::Command::new("cmd");
        process.args(["/C", command]);
        process
    } else {
        let mut process = tokio::process::Command::new("sh");
        process.args(["-c", command]);
        process
    };
    // stderr stays off the terminal: the TUI owns the screen.
    let output = process
        .stdin(std::process::Stdio::null())
        .stderr(std::process::Stdio::null())
        .kill_on_drop(true)
        .output()
        .await
        .ok()?;
    if !output.status.success() {
        tracing::warn!(status = %output.status, "AWS credential_process exited unsuccessfully");
        return None;
    }
    Some(output.stdout)
}

fn unix_now() -> u64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map_or(0, |duration| duration.as_secs())
}

/// Credentials from `profile`'s `credential_process` in the AWS config file text, served from the
/// cache while they stay valid for more than `REFRESH_MARGIN_SECS`.
pub(crate) async fn credentials_from_process(
    profile: &str,
    config: &str,
) -> Option<AwsCredentials> {
    let now = unix_now();
    let command = find_command(config, profile)?;
    let cache_key = format!("{profile}\0{command}");
    if let Ok(cache) = CACHE.lock() {
        if let Some(entry) = cache.get(&cache_key) {
            if entry
                .expires_at
                .is_none_or(|expires_at| expires_at > now + REFRESH_MARGIN_SECS)
            {
                return Some(entry.credentials.clone());
            }
        }
    }
    let Some((credentials, expiry)) = run(&command).await.as_deref().and_then(parse_output) else {
        tracing::warn!("AWS credential_process printed no usable credentials");
        return None;
    };
    let expires_at = match expiry {
        Expiry::Never => None,
        Expiry::At(expires_at) => Some(expires_at),
        Expiry::Unknown => Some(now),
    };
    if let Ok(mut cache) = CACHE.lock() {
        cache.insert(
            cache_key,
            CachedCredentials {
                credentials: credentials.clone(),
                expires_at,
            },
        );
    }
    Some(credentials)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn finds_the_command_for_the_named_profile_only() {
        let config = "[profile a]\ncredential_process = echo a\n\n[profile b]\nregion = x\ncredential_process=/bin/b --flag\n\n[default]\ncredential_process = echo d\n";
        assert_eq!(find_command(config, "a").as_deref(), Some("echo a"));
        assert_eq!(find_command(config, "b").as_deref(), Some("/bin/b --flag"));
        assert_eq!(find_command(config, "default").as_deref(), Some("echo d"));
        assert_eq!(find_command(config, "missing"), None);
    }

    #[test]
    fn parses_rfc3339_timestamps() {
        assert_eq!(parse_rfc3339("1970-01-01T00:00:00Z"), Some(0));
        assert_eq!(parse_rfc3339("2000-03-01T00:00:00.123Z"), Some(951_868_800));
        assert_eq!(
            parse_rfc3339("2026-10-12T23:20:44+00:00"),
            Some(1_791_847_244)
        );
        assert_eq!(
            parse_rfc3339("2026-10-13T01:20:44+02:00"),
            Some(1_791_847_244)
        );
        assert_eq!(
            parse_rfc3339("2026-10-12T22:20:44-01:00"),
            Some(1_791_847_244)
        );
        assert_eq!(parse_rfc3339("tomorrow"), None);
    }

    #[cfg(unix)]
    fn stub_script(dir: &std::path::Path, body: &str) -> std::path::PathBuf {
        use std::os::unix::fs::PermissionsExt as _;
        let path = dir.join("credential-process.sh");
        std::fs::write(&path, format!("#!/bin/sh\n{body}\n")).expect("write stub");
        std::fs::set_permissions(&path, std::fs::Permissions::from_mode(0o755))
            .expect("chmod stub");
        path
    }

    /// A profile whose only credential source is a `credential_process` stub script resolves to
    /// the script's credentials, and a second request is served from the cache.
    #[cfg(unix)]
    #[tokio::test]
    async fn a_credential_process_profile_runs_its_stub_script_once() {
        let dir = tempfile::tempdir().expect("tempdir");
        let runs = dir.path().join("runs");
        let script = stub_script(
            dir.path(),
            &format!(
                "echo run >> '{}'\nprintf '%s' '{{\"Version\":1,\"AccessKeyId\":\"AKIDSTUB\",\"SecretAccessKey\":\"stub-secret\",\"SessionToken\":\"stub-token\",\"Expiration\":\"2999-01-01T00:00:00Z\"}}'",
                runs.display()
            ),
        );
        let config = format!(
            "[default]\nregion = us-east-1\n\n[profile cp-stub-cached]\nregion = us-west-2\ncredential_process = {}\n",
            script.display()
        );

        let first = credentials_from_process("cp-stub-cached", &config)
            .await
            .expect("process runs");
        let second = credentials_from_process("cp-stub-cached", &config)
            .await
            .expect("cached");

        let expected = AwsCredentials {
            access_key_id: "AKIDSTUB".into(),
            secret_access_key: "stub-secret".into(),
            session_token: Some("stub-token".into()),
        };
        assert_eq!((first, second), (expected.clone(), expected));
        let runs = std::fs::read_to_string(runs).expect("runs log");
        assert_eq!(runs.lines().count(), 1);
    }

    /// Credentials inside the refresh margin are fetched again rather than reused.
    #[cfg(unix)]
    #[tokio::test]
    async fn expiring_process_credentials_are_refreshed() {
        let dir = tempfile::tempdir().expect("tempdir");
        let runs = dir.path().join("runs");
        let script = stub_script(
            dir.path(),
            &format!(
                "echo run >> '{}'\nprintf '%s' '{{\"Version\":1,\"AccessKeyId\":\"AKIDSOON\",\"SecretAccessKey\":\"s\",\"Expiration\":\"2000-01-01T00:00:00Z\"}}'",
                runs.display()
            ),
        );
        let config = format!(
            "[profile cp-stub-expiring]\ncredential_process = {}\n",
            script.display()
        );

        assert!(credentials_from_process("cp-stub-expiring", &config)
            .await
            .is_some());
        assert!(credentials_from_process("cp-stub-expiring", &config)
            .await
            .is_some());
        let runs = std::fs::read_to_string(runs).expect("runs log");
        assert_eq!(runs.lines().count(), 2);
    }

    /// Editing a profile's `credential_process` runs the new command instead of serving the old
    /// command's cached credentials.
    #[cfg(unix)]
    #[tokio::test]
    async fn a_changed_command_does_not_reuse_the_old_commands_credentials() {
        let credential_json = |key: &str| {
            format!(
                "printf '%s' '{{\"Version\":1,\"AccessKeyId\":\"{key}\",\"SecretAccessKey\":\"s\"}}'"
            )
        };
        let (old_dir, new_dir) = (
            tempfile::tempdir().expect("tempdir"),
            tempfile::tempdir().expect("tempdir"),
        );
        let old = stub_script(old_dir.path(), &credential_json("AKIDOLD"));
        let new = stub_script(new_dir.path(), &credential_json("AKIDNEW"));
        let config_for = |script: &std::path::Path| {
            format!(
                "[profile cp-stub-edited]\ncredential_process = {}\n",
                script.display()
            )
        };

        let before = credentials_from_process("cp-stub-edited", &config_for(&old))
            .await
            .expect("old command runs");
        let after = credentials_from_process("cp-stub-edited", &config_for(&new))
            .await
            .expect("new command runs");

        assert_eq!(
            (before.access_key_id, after.access_key_id),
            ("AKIDOLD".to_string(), "AKIDNEW".to_string())
        );
    }

    /// A caller that stops waiting on a stalled process (cancellation or timeout drops the future)
    /// kills it rather than leaving it running.
    #[cfg(unix)]
    #[tokio::test]
    async fn dropping_a_stalled_resolution_kills_the_process() {
        let dir = tempfile::tempdir().expect("tempdir");
        let pid_file = dir.path().join("pid");
        // The shell records its own pid, then becomes the stalled command in place.
        let config = format!(
            "[profile cp-stub-stalled]\ncredential_process = echo $$ > '{}'; exec sleep 600\n",
            pid_file.display()
        );

        let resolution = credentials_from_process("cp-stub-stalled", &config);
        let pid = tokio::select! {
            credentials = resolution => panic!("a stalled process resolved: {credentials:?}"),
            pid = async {
                loop {
                    if let Some(pid) = std::fs::read_to_string(&pid_file)
                        .ok()
                        .and_then(|text| text.trim().parse::<u32>().ok())
                    {
                        break pid;
                    }
                    tokio::time::sleep(std::time::Duration::from_millis(10)).await;
                }
            } => pid,
        };

        // The resolution future is dropped once the select returns; its process must exit.
        let deadline = std::time::Instant::now() + std::time::Duration::from_secs(10);
        loop {
            let state = std::process::Command::new("ps")
                .args(["-o", "stat=", "-p", &pid.to_string()])
                .output()
                .expect("ps runs");
            let state = String::from_utf8_lossy(&state.stdout);
            if state.trim().is_empty() || state.trim_start().starts_with('Z') {
                break;
            }
            assert!(
                std::time::Instant::now() < deadline,
                "credential_process {pid} still running: {state}"
            );
            tokio::time::sleep(std::time::Duration::from_millis(10)).await;
        }
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn a_failing_or_malformed_process_yields_no_credentials() {
        let dir = tempfile::tempdir().expect("tempdir");
        let failing = stub_script(dir.path(), "exit 1");
        let config = format!(
            "[profile cp-stub-failing]\ncredential_process = {}\n[profile cp-stub-malformed]\ncredential_process = echo '{{\"AccessKeyId\":\"x\"}}'\n",
            failing.display()
        );
        assert_eq!(
            credentials_from_process("cp-stub-failing", &config).await,
            None
        );
        assert_eq!(
            credentials_from_process("cp-stub-malformed", &config).await,
            None
        );
    }
}

//! AWS `credential_process` support: a profile in the AWS config file names a command that prints
//! version 1 credential JSON (`AccessKeyId`, `SecretAccessKey`, `SessionToken`, `Expiration`). The
//! result is cached per profile until shortly before it expires.

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

/// Keyed by profile name.
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

fn run(command: &str) -> Option<Vec<u8>> {
    let mut process = if cfg!(windows) {
        let mut process = std::process::Command::new("cmd");
        process.args(["/C", command]);
        process
    } else {
        let mut process = std::process::Command::new("sh");
        process.args(["-c", command]);
        process
    };
    // stderr stays off the terminal: the TUI owns the screen.
    let output = process
        .stdin(std::process::Stdio::null())
        .stderr(std::process::Stdio::null())
        .output()
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
pub(crate) fn credentials_from_process(profile: &str, config: &str) -> Option<AwsCredentials> {
    let now = unix_now();
    if let Ok(cache) = CACHE.lock() {
        if let Some(entry) = cache.get(profile) {
            if entry
                .expires_at
                .is_none_or(|expires_at| expires_at > now + REFRESH_MARGIN_SECS)
            {
                return Some(entry.credentials.clone());
            }
        }
    }
    let command = find_command(config, profile)?;
    let Some((credentials, expiry)) = run(&command).as_deref().and_then(parse_output) else {
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
            profile.to_string(),
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
    #[test]
    fn a_credential_process_profile_runs_its_stub_script_once() {
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

        let first = credentials_from_process("cp-stub-cached", &config).expect("process runs");
        let second = credentials_from_process("cp-stub-cached", &config).expect("cached");

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
    #[test]
    fn expiring_process_credentials_are_refreshed() {
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

        assert!(credentials_from_process("cp-stub-expiring", &config).is_some());
        assert!(credentials_from_process("cp-stub-expiring", &config).is_some());
        let runs = std::fs::read_to_string(runs).expect("runs log");
        assert_eq!(runs.lines().count(), 2);
    }

    #[cfg(unix)]
    #[test]
    fn a_failing_or_malformed_process_yields_no_credentials() {
        let dir = tempfile::tempdir().expect("tempdir");
        let failing = stub_script(dir.path(), "exit 1");
        let config = format!(
            "[profile cp-stub-failing]\ncredential_process = {}\n[profile cp-stub-malformed]\ncredential_process = echo '{{\"AccessKeyId\":\"x\"}}'\n",
            failing.display()
        );
        assert_eq!(credentials_from_process("cp-stub-failing", &config), None);
        assert_eq!(credentials_from_process("cp-stub-malformed", &config), None);
    }
}

//! Bedrock authentication and endpoint resolution.
//!
//! Ports the `SigV4` request signing used by `@aws-sdk/client-bedrock-runtime`
//! for `POST /model/{modelId}/converse-stream`, plus the region / endpoint /
//! credential resolution rules from `packages/ai/src/providers/amazon-bedrock.ts`.

use hmac::{Hmac, Mac};
use sha2::{Digest, Sha256};

use crate::providers::bedrock::BedrockOptions;
use crate::types::Model;

type HmacSha256 = Hmac<Sha256>;

/// Resolved AWS credentials (env vars, profile config, or SigV4-skip dummy).
#[derive(Clone, Debug)]
pub struct AwsCredentials {
    pub access_key_id: String,
    pub secret_access_key: String,
    pub session_token: Option<String>,
}

fn env(name: &str) -> Option<String> {
    std::env::var(name).ok().filter(|value| !value.is_empty())
}

/// Parse an AWS credentials-style ini file: `[section-name]` headers with
/// `key = value` pairs (only the two credential lines are needed).
fn parse_ini_credentials(text: &str, section: &str) -> Option<AwsCredentials> {
    let mut in_section = false;
    let mut access_key_id = None;
    let mut secret_access_key = None;
    let mut session_token = None;
    for line in text.lines() {
        let trimmed = line.trim();
        if trimmed.starts_with('[') && trimmed.ends_with(']') {
            let name = trimmed[1..trimmed.len() - 1].trim();
            // AWS credential files use `[profile name]` (config) or `[name]`.
            in_section = name == section
                || name == format!("profile {section}")
                || name.split_whitespace().last() == Some(section);
            continue;
        }
        if !in_section {
            continue;
        }
        let Some((key, value)) = trimmed.split_once('=') else {
            continue;
        };
        let value = value.trim().to_string();
        match key.trim() {
            "aws_access_key_id" => access_key_id = Some(value),
            "aws_secret_access_key" => secret_access_key = Some(value),
            "aws_session_token" => session_token = Some(value),
            _ => {}
        }
    }
    Some(AwsCredentials {
        access_key_id: access_key_id?,
        secret_access_key: secret_access_key?,
        session_token,
    })
}

/// Port of the SDK credential chain used by the TS provider: SigV4-skip dummy
/// keys, static env credentials, then the shared credentials file (default or
/// `AWS_PROFILE` / `options.profile`).
pub fn resolve_credentials(profile: Option<&str>) -> Option<AwsCredentials> {
    if std::env::var("AWS_BEDROCK_SKIP_AUTH").as_deref() == Ok("1") {
        return Some(AwsCredentials {
            access_key_id: "dummy-access-key".to_string(),
            secret_access_key: "dummy-secret-key".to_string(),
            session_token: None,
        });
    }
    if let (Some(access_key_id), Some(secret_access_key)) =
        (env("AWS_ACCESS_KEY_ID"), env("AWS_SECRET_ACCESS_KEY"))
    {
        return Some(AwsCredentials {
            access_key_id,
            secret_access_key,
            session_token: env("AWS_SESSION_TOKEN"),
        });
    }
    let profile = profile
        .map(std::string::ToString::to_string)
        .or_else(|| env("AWS_PROFILE"))
        .unwrap_or_else(|| "default".to_string());
    let home = pa_types::platform::home_dir()?;
    let path = home.join(".aws/credentials");
    let text = std::fs::read_to_string(path).ok()?;
    parse_ini_credentials(&text, &profile)
}

fn sha256_hex(bytes: &[u8]) -> String {
    hex::encode(Sha256::digest(bytes))
}

fn hmac_sha256(key: &[u8], data: &[u8]) -> Vec<u8> {
    let mut mac = HmacSha256::new_from_slice(key).expect("hmac accepts any key length");
    mac.update(data);
    mac.finalize().into_bytes().to_vec()
}

/// UTC timestamp in `SigV4` formats: `x-amz-date` (20250101T000000Z) and date
/// stamp (20250101). Uses std time to avoid a chrono dependency.
fn now_utc_parts() -> (String, String) {
    let seconds = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map_or(0, |duration| duration.as_secs());
    let (year, month, day, hour, minute, second) = civil_from_unix(seconds);
    (
        format!("{year:04}{month:02}{day:02}T{hour:02}{minute:02}{second:02}Z"),
        format!("{year:04}{month:02}{day:02}"),
    )
}

/// Convert a Unix timestamp to civil UTC date-time (Howard Hinnant's algorithm).
fn civil_from_unix(secs: u64) -> (i64, u32, u32, u32, u32, u32) {
    let days = (secs / 86_400) as i64;
    let secs_of_day = secs % 86_400;
    let z = days + 719_468;
    let era = z.div_euclid(146_097);
    let doe = z.rem_euclid(146_097);
    let yoe = (doe - doe / 1460 + doe / 36_524 - doe / 146_096) / 365;
    let y = yoe + era * 400;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let d = (doy - (153 * mp + 2) / 5 + 1) as u32;
    let m = if mp < 10 { mp + 3 } else { mp - 9 } as u32;
    let year = if m <= 2 { y + 1 } else { y };
    (
        year,
        m,
        d,
        (secs_of_day / 3600) as u32,
        ((secs_of_day % 3600) / 60) as u32,
        (secs_of_day % 60) as u32,
    )
}

/// Produce the `SigV4` auth headers for a request.
/// Returns `(x-amz-date, authorization, x-amz-security-token)`.
pub struct SigV4Params<'a> {
    pub method: &'a str,
    /// Path with query string, starting with `/`.
    pub path_and_query: &'a str,
    pub host: &'a str,
    pub region: &'a str,
    pub service: &'a str,
    pub body: &'a [u8],
    /// Extra headers included in the signed header list (lowercase names).
    pub extra_signed_headers: &'a [(String, String)],
}

/// Produce the `SigV4` auth headers for a request.
/// Returns `(x-amz-date, authorization, x-amz-security-token)`.
pub fn sigv4_headers(
    params: &SigV4Params<'_>,
    credentials: &AwsCredentials,
) -> (String, String, Option<String>) {
    let (amz_date, date_stamp) = now_utc_parts();
    let payload_hash = sha256_hex(params.body);

    let mut canonical_headers: Vec<(String, String)> = vec![
        ("content-type".to_string(), "application/json".to_string()),
        ("host".to_string(), params.host.to_string()),
        ("x-amz-date".to_string(), amz_date.clone()),
    ];
    for (name, value) in params.extra_signed_headers {
        canonical_headers.push((name.to_lowercase(), value.to_string()));
    }
    if let Some(token) = &credentials.session_token {
        canonical_headers.push(("x-amz-security-token".to_string(), token.clone()));
    }
    canonical_headers.sort_by(|a, b| a.0.cmp(&b.0));

    let signed_headers = canonical_headers
        .iter()
        .map(|(name, _)| name.as_str())
        .collect::<Vec<_>>()
        .join(";");
    let canonical_headers_text = canonical_headers
        .iter()
        .map(|(name, value)| format!("{name}:{value}\n"))
        .collect::<String>();

    let canonical_request = format!(
        "{}\n{}\n{canonical_headers_text}\n{signed_headers}\n{payload_hash}",
        params.method, params.path_and_query
    );

    let credential_scope = format!(
        "{}/{}/{}/aws4_request",
        date_stamp, params.region, params.service
    );
    let string_to_sign = format!(
        "AWS4-HMAC-SHA256\n{amz_date}\n{credential_scope}\n{}",
        sha256_hex(canonical_request.as_bytes())
    );

    let date_key = hmac_sha256(
        format!("AWS4{}", credentials.secret_access_key).as_bytes(),
        date_stamp.as_bytes(),
    );
    let region_key = hmac_sha256(&date_key, params.region.as_bytes());
    let service_key = hmac_sha256(&region_key, params.service.as_bytes());
    let signing_key = hmac_sha256(&service_key, b"aws4_request");
    let signature = hex::encode(hmac_sha256(&signing_key, string_to_sign.as_bytes()));

    let authorization = format!(
        "AWS4-HMAC-SHA256 Credential={}/{}, SignedHeaders={}, Signature={}",
        credentials.access_key_id, credential_scope, signed_headers, signature
    );

    (amz_date, authorization, credentials.session_token.clone())
}

/// Port of `getConfiguredBedrockRegion`.
pub fn get_configured_bedrock_region(region: Option<&str>) -> Option<String> {
    region
        .map(std::string::ToString::to_string)
        .or_else(|| env("AWS_REGION"))
        .or_else(|| env("AWS_DEFAULT_REGION"))
}

/// Port of `hasConfiguredBedrockProfile`.
pub fn has_configured_bedrock_profile() -> bool {
    env("AWS_PROFILE").is_some()
}

/// Port of `getStandardBedrockEndpointRegion`.
pub fn get_standard_bedrock_endpoint_region(base_url: &str) -> Option<String> {
    let hostname = url::Url::parse(base_url).ok()?.host_str()?.to_lowercase();
    let suffix_stripped = hostname
        .strip_prefix("bedrock-runtime-fips")
        .or_else(|| hostname.strip_prefix("bedrock-runtime"))?;
    let rest = suffix_stripped.strip_prefix('.')?;
    let region = rest
        .strip_suffix(".amazonaws.com")
        .or_else(|| rest.strip_suffix(".amazonaws.com.cn"))?;
    if region.is_empty()
        || !region
            .chars()
            .all(|c| c.is_ascii_lowercase() || c.is_ascii_digit() || c == '-')
    {
        return None;
    }
    Some(region.to_string())
}

/// Port of `shouldUseExplicitBedrockEndpoint`.
pub fn should_use_explicit_bedrock_endpoint(
    base_url: &str,
    configured_region: Option<&str>,
    has_configured_profile: bool,
) -> bool {
    let endpoint_region = get_standard_bedrock_endpoint_region(base_url);
    match endpoint_region {
        None => true,
        Some(_) => configured_region.is_none() && !has_configured_profile,
    }
}

/// Resolve the request endpoint and region: explicit model baseUrl (custom
/// gateways, fips, `GovCloud`) or the standard regional endpoint.
pub(crate) fn resolve_endpoint(model: &Model, options: &BedrockOptions) -> (String, String) {
    let configured_region = get_configured_bedrock_region(options.region.as_deref());
    let has_profile = has_configured_bedrock_profile();
    let use_explicit_endpoint = should_use_explicit_bedrock_endpoint(
        &model.base_url,
        configured_region.as_deref(),
        has_profile,
    );

    if use_explicit_endpoint && !model.base_url.is_empty() {
        // Region resolution mirrors the TS: explicit option > env vars >
        // endpoint hostname > (profile-resolved) > us-east-1.
        let region = configured_region
            .or_else(|| {
                crate::providers::bedrock::auth::get_standard_bedrock_endpoint_region(
                    &model.base_url,
                )
            })
            .or_else(env_region_or_profile)
            .unwrap_or_else(|| "us-east-1".to_string());
        return (model.base_url.trim_end_matches('/').to_string(), region);
    }

    let region = configured_region
        .or_else(env_region_or_profile)
        .unwrap_or_else(|| "us-east-1".to_string());
    (
        format!("https://bedrock-runtime.{region}.amazonaws.com"),
        region,
    )
}

/// AWS_PROFILE-resolved region from `~/.aws/config`, else None.
fn env_region_or_profile() -> Option<String> {
    if let Some(region) = std::env::var("AWS_REGION").ok().filter(|v| !v.is_empty()) {
        return Some(region);
    }
    if let Some(region) = std::env::var("AWS_DEFAULT_REGION")
        .ok()
        .filter(|v| !v.is_empty())
    {
        return Some(region);
    }
    let profile = std::env::var("AWS_PROFILE")
        .ok()
        .filter(|v| !v.is_empty())?;
    let home = pa_types::platform::home_dir()?;
    let text = std::fs::read_to_string(home.join(".aws/config")).ok()?;
    let mut in_section = false;
    for line in text.lines() {
        let trimmed = line.trim();
        if trimmed.starts_with('[') && trimmed.ends_with(']') {
            let name = trimmed[1..trimmed.len() - 1].trim();
            in_section = name == format!("profile {profile}") || name == profile;
            continue;
        }
        if !in_section {
            continue;
        }
        if let Some((key, value)) = trimmed.split_once('=') {
            if key.trim() == "region" {
                return Some(value.trim().to_string());
            }
        }
    }
    None
}

//! Prime Inference login, API-key surface: the auth endpoints (the whoami
//! access check, the team list), and the production prime-cli config
//! reuse. Port of the API-key paths of prime-inference-auth.ts; the
//! browser challenge (the RSA-encrypted `auth_challenge` flow) is not
//! ported — the interactive flow prompts for a pasted key instead.

use std::future::Future;
use std::path::{Path, PathBuf};
use std::pin::Pin;
use std::time::Duration;

use super::types::PrimeTeamCredential;

/// TS `DEFAULT_PRIME_API_BASE_URL`: the Prime API the login talks to.
pub const DEFAULT_PRIME_API_BASE_URL: &str = "https://api.primeintellect.ai";
/// TS `DEFAULT_PRIME_FRONTEND_URL`: the browser challenge target (the
/// production guard consults it; the flow itself does not open it).
pub const DEFAULT_PRIME_FRONTEND_URL: &str = "https://app.primeintellect.ai";
/// TS `DEFAULT_PRIME_INFERENCE_URL` (module-local there too): the value
/// the prime-cli config's `inference_url` must carry to count as
/// production.
const DEFAULT_PRIME_INFERENCE_URL: &str = "https://api.pinference.ai/api/v1";
/// TS `DEFAULT_REQUEST_TIMEOUT_MS`.
pub const DEFAULT_REQUEST_TIMEOUT_MS: u64 = 30_000;

/// The login's challenge config (TS `PrimeChallengeConfig`): the API the
/// access check and team list run against, and the frontend URL the
/// production guard compares.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct PrimeInferenceAuthConfig {
    pub base_url: String,
    pub frontend_url: String,
}

impl PrimeInferenceAuthConfig {
    /// The production guard (TS `loginPrimeInference`'s candidate rule):
    /// the prime-cli config is only reused when both URLs stay stock.
    pub fn is_production(&self) -> bool {
        self.base_url == DEFAULT_PRIME_API_BASE_URL
            && self.frontend_url == DEFAULT_PRIME_FRONTEND_URL
    }
}

/// TS `resolvePrimeInferenceAuthConfig`: the env overrides over the
/// production URLs (`PRIME_AGENT_INFERENCE_API_BASE_URL`,
/// `PRIME_AGENT_INFERENCE_FRONTEND_URL`).
pub fn resolve_prime_inference_auth_config() -> PrimeInferenceAuthConfig {
    PrimeInferenceAuthConfig {
        base_url: normalize_base_url(
            std::env::var("PRIME_AGENT_INFERENCE_API_BASE_URL")
                .ok()
                .as_deref(),
        ),
        frontend_url: normalize_url(
            std::env::var("PRIME_AGENT_INFERENCE_FRONTEND_URL")
                .ok()
                .as_deref(),
            DEFAULT_PRIME_FRONTEND_URL,
        ),
    }
}

/// TS `normalizeBaseUrl`: trim, strip trailing slashes and the `/api/v1`
/// suffix, defaulting to the production API.
pub(super) fn normalize_base_url(value: Option<&str>) -> String {
    let fallback = match value.map(str::trim).filter(|value| !value.is_empty()) {
        Some(value) => value,
        None => DEFAULT_PRIME_API_BASE_URL,
    };
    fallback
        .trim_end_matches('/')
        .trim_end_matches("/api/v1")
        .trim_end_matches('/')
        .to_string()
}

/// TS `normalizeUrl`: trim, strip trailing slashes, defaulting to the
/// fallback when empty.
fn normalize_url(value: Option<&str>, fallback: &str) -> String {
    match value.map(str::trim).filter(|value| !value.is_empty()) {
        Some(value) => value.trim_end_matches('/').to_string(),
        None => fallback.to_string(),
    }
}

/// One GET's answer over the Prime API: the HTTP status and the body.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct PrimeHttpResponse {
    pub status: u16,
    pub body: String,
}

/// The login's HTTP transport (TS's injectable `fetchFn`; the production
/// default is reqwest). The timeout surfaces as
/// `Prime Inference request timed out`.
pub trait PrimeHttp: Send + Sync {
    fn get(
        &self,
        url: &str,
        api_key: &str,
        timeout_ms: u64,
    ) -> Pin<Box<dyn Future<Output = Result<PrimeHttpResponse, String>> + Send>>;

    /// One POST of a JSON body (TS the browser challenge's generate and
    /// status requests over `fetchPrimeAuth`): the bearer carries the
    /// challenge's status token or is absent for the generate request.
    fn post_json<'a>(
        &'a self,
        url: &'a str,
        body: &'a str,
        bearer: Option<&'a str>,
        timeout_ms: u64,
    ) -> Pin<Box<dyn Future<Output = Result<PrimeHttpResponse, String>> + Send + 'a>>;
}

/// The production transport (reqwest over rustls, the catalog fetch's
/// shape).
pub struct ReqwestPrimeHttp;

impl PrimeHttp for ReqwestPrimeHttp {
    fn get(
        &self,
        url: &str,
        api_key: &str,
        timeout_ms: u64,
    ) -> Pin<Box<dyn Future<Output = Result<PrimeHttpResponse, String>> + Send>> {
        let url = url.to_string();
        let api_key = api_key.to_string();
        Box::pin(async move {
            let client = reqwest::Client::builder()
                .timeout(Duration::from_millis(timeout_ms))
                .build()
                .map_err(|error| error.to_string())?;
            let response = client
                .get(url)
                .header("authorization", format!("Bearer {api_key}"))
                .header("accept", "application/json")
                .send()
                .await
                .map_err(|error| {
                    if error.is_timeout() {
                        "Prime Inference request timed out".to_string()
                    } else {
                        error.to_string()
                    }
                })?;
            let status = response.status().as_u16();
            let body = response.text().await.map_err(|error| error.to_string())?;
            Ok(PrimeHttpResponse { status, body })
        })
    }

    fn post_json<'a>(
        &'a self,
        url: &'a str,
        body: &'a str,
        bearer: Option<&'a str>,
        timeout_ms: u64,
    ) -> Pin<Box<dyn Future<Output = Result<PrimeHttpResponse, String>> + Send + 'a>> {
        Box::pin(async move {
            let client = reqwest::Client::builder()
                .timeout(Duration::from_millis(timeout_ms))
                .build()
                .map_err(|error| error.to_string())?;
            let mut request = client
                .post(url)
                .header("content-type", "application/json")
                .header("accept", "application/json")
                .body(body.to_string());
            if let Some(bearer) = bearer {
                request = request.header("authorization", format!("Bearer {bearer}"));
            }
            let response = request.send().await.map_err(|error| {
                if error.is_timeout() {
                    "Prime Inference request timed out".to_string()
                } else {
                    error.to_string()
                }
            })?;
            let status = response.status().as_u16();
            let body = response.text().await.map_err(|error| error.to_string())?;
            Ok(PrimeHttpResponse { status, body })
        })
    }
}

/// The prime-cli credential reuse candidate (TS `PrimeCliConfig` +
/// `importedPrimeTeam`): `team: None` is the personal account.
#[derive(Debug, Clone, PartialEq)]
pub struct PrimeCliConfig {
    pub api_key: Option<String>,
    pub team: Option<PrimeTeamCredential>,
}

/// TS `getPrimeCliConfigPath`'s default: `~/.prime/config.json`.
pub fn default_prime_cli_config_path() -> PathBuf {
    pa_types::platform::home_dir()
        .unwrap_or_else(|| PathBuf::from("."))
        .join(".prime")
        .join("config.json")
}

/// A trimmed, non-empty string field (TS `stringField`).
fn string_field(data: &serde_json::Value, key: &str) -> Option<String> {
    data.as_object()?
        .get(key)?
        .as_str()
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(str::to_string)
}

/// TS `readResponseMessage`: the error body's `error.message`, `detail`,
/// or `message`, the raw text, or the status phrase.
pub(super) fn read_response_message(status: u16, body: &str) -> String {
    if body.trim().is_empty() {
        return reqwest::StatusCode::from_u16(status)
            .ok()
            .and_then(|status| status.canonical_reason())
            .unwrap_or("Unknown error")
            .to_string();
    }
    if let Ok(parsed) = serde_json::from_str::<serde_json::Value>(body) {
        if let Some(message) = parsed
            .get("error")
            .and_then(|error| string_field(error, "message"))
        {
            return message;
        }
        for field in ["detail", "message"] {
            if let Some(message) = string_field(&parsed, field) {
                return message;
            }
        }
    }
    body.trim().to_string()
}

/// One denial of Prime Inference access (TS `PrimeInferenceAccessResult`'s
/// `ok: false` arm): the HTTP status when the API answered, and the
/// response's message.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct PrimeAccessFailure {
    pub status: Option<u16>,
    pub message: String,
}

impl PrimeAccessFailure {
    /// TS `formatAccessFailure`: `HTTP {status}: {message}` (the status
    /// prefix drops when the API never answered).
    pub fn format(&self) -> String {
        match self.status {
            Some(status) => format!("HTTP {status}: {}", self.message),
            None => self.message.clone(),
        }
    }
}

/// The access check's error (TS: the `ok: false` result vs the thrown
/// transport/parse errors).
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum PrimeAccessError {
    /// The API denied the key (TS `{ ok: false, status?, message }`).
    Denied(PrimeAccessFailure),
    /// The check could not run (TS's thrown errors).
    Failed(String),
}

/// TS `parsePrimeTeam`: one team of the teams response.
fn parse_prime_team(value: &serde_json::Value) -> Option<PrimeTeamCredential> {
    let team_id = string_field(value, "teamId")?;
    Some(PrimeTeamCredential {
        team_id,
        name: string_field(value, "name").unwrap_or_else(|| "Unknown".to_string()),
        slug: string_field(value, "slug"),
        role: string_field(value, "role"),
        created_at: string_field(value, "createdAt"),
    })
}

/// TS `checkPrimeScopeAccess`: the stored or pasted key must carry the
/// scope's write permission (the error text names the scope label).
pub(super) async fn check_prime_scope_access(
    http: &dyn PrimeHttp,
    base_url: &str,
    api_key: &str,
    timeout_ms: u64,
    scope_name: &str,
    scope_label: &str,
) -> Result<(), PrimeAccessError> {
    let url = format!("{}/api/v1/user/whoami", normalize_base_url(Some(base_url)));
    let response = http
        .get(&url, api_key, timeout_ms)
        .await
        .map_err(PrimeAccessError::Failed)?;
    if !(200..300).contains(&response.status) {
        return Err(PrimeAccessError::Denied(PrimeAccessFailure {
            status: Some(response.status),
            message: read_response_message(response.status, &response.body),
        }));
    }
    let data: serde_json::Value = serde_json::from_str(&response.body)
        .map_err(|_| {
            PrimeAccessError::Failed("Prime whoami returned an invalid response".to_string())
        })
        .and_then(|data: serde_json::Value| {
            data.is_object().then_some(data).ok_or_else(|| {
                PrimeAccessError::Failed("Prime whoami returned an invalid response".to_string())
            })
        })?;
    let Some(user) = data.get("data").filter(|user| user.is_object()) else {
        return Err(PrimeAccessError::Denied(PrimeAccessFailure {
            status: None,
            message: "Prime whoami response missing user data".to_string(),
        }));
    };
    let Some(scope) = user.get("scope").filter(|scope| scope.is_object()) else {
        return Err(PrimeAccessError::Denied(PrimeAccessFailure {
            status: None,
            message: "Prime token is missing permission scope data".to_string(),
        }));
    };
    let Some(scoped) = scope.get(scope_name).filter(|scoped| scoped.is_object()) else {
        return Err(PrimeAccessError::Denied(PrimeAccessFailure {
            status: None,
            message: format!("Prime token is missing {scope_label} permissions"),
        }));
    };
    if scoped.get("write") != Some(&serde_json::Value::Bool(true)) {
        return Err(PrimeAccessError::Denied(PrimeAccessFailure {
            status: None,
            message: format!("Prime token does not have {scope_label} write permission"),
        }));
    }
    Ok(())
}

/// TS `checkPrimeInferenceAccess` (scope `inference`): the stored or pasted
/// key must carry the inference write permission.
pub async fn check_prime_inference_access(
    http: &dyn PrimeHttp,
    base_url: &str,
    api_key: &str,
    timeout_ms: u64,
) -> Result<(), PrimeAccessError> {
    check_prime_scope_access(
        http,
        base_url,
        api_key,
        timeout_ms,
        "inference",
        "inference",
    )
    .await
}

/// TS `fetchPrimeTeams`: the key's teams, paginated at 100 a page.
pub async fn fetch_prime_teams(
    http: &dyn PrimeHttp,
    base_url: &str,
    api_key: &str,
    timeout_ms: u64,
) -> Result<Vec<PrimeTeamCredential>, String> {
    let base_url = normalize_base_url(Some(base_url));
    let mut teams = Vec::new();
    let mut offset: u64 = 0;
    loop {
        let url = format!("{base_url}/api/v1/user/teams?offset={offset}&limit=100");
        let response = http.get(&url, api_key, timeout_ms).await?;
        if !(200..300).contains(&response.status) {
            return Err(format!(
                "Failed to fetch Prime teams: {}",
                read_response_message(response.status, &response.body)
            ));
        }
        let data: serde_json::Value = serde_json::from_str(&response.body)
            .map_err(|_| "Prime teams returned an invalid response".to_string())
            .and_then(|data: serde_json::Value| {
                data.is_object()
                    .then_some(data)
                    .ok_or_else(|| "Prime teams returned an invalid response".to_string())
            })?;
        let Some(batch) = data.get("data").and_then(|data| data.as_array()) else {
            return Err("Prime teams response missing team data".to_string());
        };
        for item in batch {
            if let Some(team) = parse_prime_team(item) {
                teams.push(team);
            }
        }
        let total = data
            .get("total_count")
            .and_then(|count| count.as_u64())
            .unwrap_or(teams.len() as u64);
        if batch.is_empty() || teams.len() as u64 >= total {
            return Ok(teams);
        }
        offset += 100;
    }
}

/// TS `loadProductionPrimeCliConfig`: the prime CLI's saved credential,
/// but only when its URL overrides (if any) stay production. A missing or
/// unparseable file is no candidate, not an error.
pub fn read_prime_cli_config(path: &Path) -> Option<PrimeCliConfig> {
    let content = std::fs::read_to_string(path).ok()?;
    let parsed: serde_json::Value = serde_json::from_str(&content).ok()?;
    if !parsed.is_object() {
        return None;
    }
    let urls = [
        ("base_url", DEFAULT_PRIME_API_BASE_URL),
        ("frontend_url", DEFAULT_PRIME_FRONTEND_URL),
        ("inference_url", DEFAULT_PRIME_INFERENCE_URL),
    ];
    for (field, expected) in urls {
        if let Some(value) = parsed.get(field) {
            let value = value.as_str().map(str::trim).filter(|v| !v.is_empty())?;
            let normalized = if field == "base_url" {
                normalize_base_url(Some(value))
            } else {
                normalize_url(Some(value), expected)
            };
            if normalized != expected {
                return None;
            }
        }
    }
    let team = string_field(&parsed, "team_id").map(|team_id| PrimeTeamCredential {
        name: string_field(&parsed, "team_name").unwrap_or_else(|| "Prime team".to_string()),
        role: string_field(&parsed, "team_role"),
        team_id,
        slug: None,
        created_at: None,
    });
    Some(PrimeCliConfig {
        api_key: string_field(&parsed, "api_key"),
        team,
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::collections::VecDeque;
    use std::sync::Mutex;
    use tokio::io::{AsyncReadExt, AsyncWriteExt};
    use tokio::net::TcpListener;

    /// A scripted transport: exact URL -> response, in call order.
    struct ScriptedHttp(Mutex<VecDeque<(String, PrimeHttpResponse)>>);

    impl PrimeHttp for ScriptedHttp {
        fn get(
            &self,
            url: &str,
            _api_key: &str,
            _timeout_ms: u64,
        ) -> Pin<Box<dyn Future<Output = Result<PrimeHttpResponse, String>> + Send>> {
            let url = url.to_string();
            let entry = self.0.lock().unwrap().pop_front();
            Box::pin(async move {
                match entry {
                    Some((expected_url, response)) if expected_url == url => Ok(response),
                    Some((expected_url, _)) => {
                        panic!("unexpected request {url}, scripted {expected_url}")
                    }
                    None => panic!("no scripted response for {url}"),
                }
            })
        }

        fn post_json<'a>(
            &'a self,
            url: &'a str,
            _body: &'a str,
            _bearer: Option<&'a str>,
            _timeout_ms: u64,
        ) -> Pin<Box<dyn Future<Output = Result<PrimeHttpResponse, String>> + Send + 'a>> {
            let url = url.to_string();
            let entry = self.0.lock().unwrap().pop_front();
            Box::pin(async move {
                match entry {
                    Some((expected_url, response)) if expected_url == url => Ok(response),
                    Some((expected_url, _)) => {
                        panic!("unexpected request {url}, scripted {expected_url}")
                    }
                    None => panic!("no scripted response for {url}"),
                }
            })
        }
    }

    fn scripted(responses: Vec<(&str, u16, &str)>) -> ScriptedHttp {
        ScriptedHttp(Mutex::new(
            responses
                .into_iter()
                .map(|(url, status, body)| {
                    (
                        url.to_string(),
                        PrimeHttpResponse {
                            status,
                            body: body.to_string(),
                        },
                    )
                })
                .collect(),
        ))
    }

    #[test]
    fn the_config_resolution_matches_ts_normalization() {
        assert_eq!(
            normalize_base_url(None),
            DEFAULT_PRIME_API_BASE_URL,
            "an unset base falls back to the production API"
        );
        assert_eq!(
            normalize_base_url(Some("https://api.example/")),
            "https://api.example"
        );
        assert_eq!(
            normalize_base_url(Some("https://api.example/api/v1/")),
            "https://api.example"
        );
        assert_eq!(
            normalize_url(Some("https://app.example/"), DEFAULT_PRIME_FRONTEND_URL),
            "https://app.example"
        );
        assert_eq!(
            normalize_url(None, DEFAULT_PRIME_FRONTEND_URL),
            DEFAULT_PRIME_FRONTEND_URL
        );
    }

    #[tokio::test]
    async fn the_access_check_sends_the_ts_request_and_reads_the_scope() {
        let http = scripted(vec![(
            "https://api.example/api/v1/user/whoami",
            200,
            r#"{"data":{"scope":{"inference":{"write":true}}}}"#,
        )]);
        check_prime_inference_access(
            &http,
            "https://api.example",
            "sk-prime",
            DEFAULT_REQUEST_TIMEOUT_MS,
        )
        .await
        .expect("write access passes");
    }

    #[tokio::test]
    async fn the_access_check_reports_each_denial_with_the_ts_message() {
        // A denied HTTP answer carries the status prefix and the body's
        // error message.
        let http = scripted(vec![(
            "https://api.example/api/v1/user/whoami",
            403,
            r#"{"error":{"message":"not allowed"}}"#,
        )]);
        assert_eq!(
            check_prime_inference_access(&http, "https://api.example", "sk", 1).await,
            Err(PrimeAccessError::Denied(PrimeAccessFailure {
                status: Some(403),
                message: "not allowed".to_string(),
            }))
        );
        // A user without the scope object denies with the TS wording.
        let http = scripted(vec![(
            "https://api.example/api/v1/user/whoami",
            200,
            r#"{"data":{}}"#,
        )]);
        assert_eq!(
            check_prime_inference_access(&http, "https://api.example", "sk", 1).await,
            Err(PrimeAccessError::Denied(PrimeAccessFailure {
                status: None,
                message: "Prime token is missing permission scope data".to_string(),
            }))
        );
        // A read-only token denies with the TS wording.
        let http = scripted(vec![(
            "https://api.example/api/v1/user/whoami",
            200,
            r#"{"data":{"scope":{"inference":{"write":false}}}}"#,
        )]);
        assert_eq!(
            check_prime_inference_access(&http, "https://api.example", "sk", 1).await,
            Err(PrimeAccessError::Denied(PrimeAccessFailure {
                status: None,
                message: "Prime token does not have inference write permission".to_string(),
            }))
        );
        // A non-object body fails the parse with the TS wording.
        let http = scripted(vec![(
            "https://api.example/api/v1/user/whoami",
            200,
            "[1,2]",
        )]);
        assert_eq!(
            check_prime_inference_access(&http, "https://api.example", "sk", 1).await,
            Err(PrimeAccessError::Failed(
                "Prime whoami returned an invalid response".to_string()
            ))
        );
    }

    #[tokio::test]
    async fn the_team_list_paginates_the_ts_way() {
        // Two pages: a 100-team batch then the tail.
        let page = (0..100)
            .map(|index| {
                format!(
                    r#"{{"teamId":"t{index}","name":"Team {index}","slug":"t{index}","role":"member"}}"#
                )
            })
            .collect::<Vec<_>>()
            .join(",");
        let page = format!(r#"{{"total_count":101,"data":[{page}]}}"#);
        let http = scripted(vec![
            (
                "https://api.example/api/v1/user/teams?offset=0&limit=100",
                200,
                &page,
            ),
            (
                "https://api.example/api/v1/user/teams?offset=100&limit=100",
                200,
                r#"{"total_count":101,"data":[{"teamId":"tail","name":"Tail"}]}"#,
            ),
        ]);
        let teams = fetch_prime_teams(&http, "https://api.example", "sk-prime", 1)
            .await
            .expect("teams");
        assert_eq!(teams.len(), 101);
        assert_eq!(
            teams[0],
            PrimeTeamCredential {
                team_id: "t0".to_string(),
                name: "Team 0".to_string(),
                slug: Some("t0".to_string()),
                role: Some("member".to_string()),
                created_at: None,
            }
        );
        assert_eq!(teams[100].team_id, "tail");
    }

    #[tokio::test]
    async fn the_team_list_errors_with_the_ts_messages() {
        let http = scripted(vec![(
            "https://api.example/api/v1/user/teams?offset=0&limit=100",
            500,
            "boom",
        )]);
        assert_eq!(
            fetch_prime_teams(&http, "https://api.example", "sk", 1).await,
            Err("Failed to fetch Prime teams: boom".to_string())
        );
        let http = scripted(vec![(
            "https://api.example/api/v1/user/teams?offset=0&limit=100",
            200,
            r#"{"data":{}}"#,
        )]);
        assert_eq!(
            fetch_prime_teams(&http, "https://api.example", "sk", 1).await,
            Err("Prime teams response missing team data".to_string())
        );
    }

    /// The production transport's wire shape: the request head the real
    /// client sends.
    #[tokio::test]
    async fn the_reqwest_transport_sends_the_ts_request() {
        let listener = TcpListener::bind("127.0.0.1:0").await.expect("bind");
        let port = listener.local_addr().unwrap().port();
        tokio::spawn(async move {
            let Ok((mut socket, _)) = listener.accept().await else {
                return;
            };
            let mut buffer = [0u8; 4096];
            let mut read = 0usize;
            let head = loop {
                let Ok(n) = socket.read(&mut buffer[read..]).await else {
                    return;
                };
                read += n;
                let head = String::from_utf8_lossy(&buffer[..read]).to_string();
                if head.contains("\r\n\r\n") {
                    break head;
                }
            };
            let reply =
                "HTTP/1.1 200 OK\r\ncontent-type: application/json\r\ncontent-length: 2\r\n\r\n{}";
            let _ = socket.write_all(reply.as_bytes()).await;
            let head = head.to_lowercase();
            assert!(
                head.starts_with("get /api/v1/user/whoami http/1.1"),
                "the request hits the whoami path: {head}"
            );
            assert!(head.contains("authorization: bearer sk-wire"));
            assert!(head.contains("accept: application/json"));
        });
        let response = ReqwestPrimeHttp
            .get(
                &format!("http://127.0.0.1:{port}/api/v1/user/whoami"),
                "sk-wire",
                DEFAULT_REQUEST_TIMEOUT_MS,
            )
            .await
            .expect("the mock answered");
        assert_eq!(
            response,
            PrimeHttpResponse {
                status: 200,
                body: "{}".to_string()
            }
        );
    }

    #[test]
    fn the_prime_cli_config_reuse_only_accepts_production() {
        let dir = tempfile::tempdir().expect("temp dir");
        let config = dir.path().join("config.json");
        // The production shape carries the key and the team.
        std::fs::write(
            &config,
            serde_json::json!({
                "api_key": " sk-cli ",
                "team_id": "team-1",
                "team_name": "The Team",
                "team_role": "owner"
            })
            .to_string(),
        )
        .expect("write config");
        assert_eq!(
            read_prime_cli_config(&config),
            Some(PrimeCliConfig {
                api_key: Some("sk-cli".to_string()),
                team: Some(PrimeTeamCredential {
                    team_id: "team-1".to_string(),
                    name: "The Team".to_string(),
                    slug: None,
                    role: Some("owner".to_string()),
                    created_at: None,
                }),
            })
        );
        // A non-production URL override disqualifies the whole config.
        std::fs::write(
            &config,
            serde_json::json!({"api_key": "sk-cli", "base_url": "https://api.example"}).to_string(),
        )
        .expect("write config");
        assert_eq!(read_prime_cli_config(&config), None);
        // Matching URL overrides stay eligible.
        std::fs::write(
            &config,
            serde_json::json!({
                "api_key": "sk-cli",
                "base_url": DEFAULT_PRIME_API_BASE_URL,
                "inference_url": DEFAULT_PRIME_INFERENCE_URL
            })
            .to_string(),
        )
        .expect("write config");
        assert_eq!(
            read_prime_cli_config(&config),
            Some(PrimeCliConfig {
                api_key: Some("sk-cli".to_string()),
                team: None,
            })
        );
        // A missing file is no candidate.
        assert_eq!(read_prime_cli_config(&dir.path().join("missing")), None);
    }
}

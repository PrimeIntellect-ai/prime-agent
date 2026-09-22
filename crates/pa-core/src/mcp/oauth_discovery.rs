//! OAuth discovery for MCP servers: RFC 9728 protected-resource metadata
//! before the origin-level authorization-server fallback, RFC 8414/OIDC
//! metadata, dynamic client registration, PKCE, and token exchange.
//!
//! Every request goes through the [`OAuthHttp`] transport seam so the flow
//! is hermetically testable; validation errors carry the TS wording
//! (they surface in login dialogs).

use anyhow::{anyhow, bail, Context, Result};
use base64::Engine as _;
use sha2::{Digest, Sha256};
use url::Url;

use super::oauth_http::{OAuthHttp, OAuthHttpMethod, OAuthHttpRequest};

/// The MCP endpoint's label in validation errors.
const ENDPOINT_LABEL: &str = "MCP endpoint";
/// Bearer-token expiry head start: a token never dies mid-request.
pub(crate) const TOKEN_EXPIRY_BUFFER_MS: i64 = 5 * 60 * 1000;

/// An absolute HTTPS URL without credentials or a fragment.
pub(crate) fn validated_https_url(value: &str, name: &str) -> Result<Url> {
    let url = Url::parse(value).map_err(|_| anyhow!("{name} must be an absolute HTTPS URL"))?;
    if url.scheme() != "https"
        || !url.username().is_empty()
        || url.password().is_some()
        || url.fragment().is_some()
    {
        bail!("{name} must be an absolute HTTPS URL without credentials or a fragment");
    }
    Ok(url)
}

/// The RFC 9728 resource indicator for an MCP endpoint: the origin when the
/// path is the root and no query is present, else origin+path+query.
pub(crate) fn canonical_resource(url: &Url) -> String {
    if url.path() == "/" && url.query().is_none() {
        return url.origin().ascii_serialization();
    }
    let mut resource = url.origin().ascii_serialization();
    resource.push_str(url.path());
    if let Some(query) = url.query() {
        resource.push('?');
        resource.push_str(query);
    }
    resource
}

/// RFC 8414 + pathful OIDC metadata candidates for one issuer.
fn authorization_server_metadata_urls(issuer: &Url) -> Vec<String> {
    if issuer.query().is_some() {
        // The caller rejects query-carrying issuers before this runs.
        return Vec::new();
    }
    let path = if issuer.path() == "/" {
        String::new()
    } else {
        issuer.path().trim_end_matches('/').to_string()
    };
    vec![
        format!(
            "{}/.well-known/oauth-authorization-server{path}",
            issuer.origin().ascii_serialization()
        ),
        format!(
            "{}{path}/.well-known/openid-configuration",
            issuer.origin().ascii_serialization()
        ),
    ]
}

/// Authorization-server metadata (RFC 8414 shape).
#[derive(Debug, Clone, PartialEq)]
pub(crate) struct AuthServerMetadata {
    pub issuer: String,
    pub authorization_endpoint: String,
    pub token_endpoint: String,
    pub registration_endpoint: Option<String>,
    pub scopes_supported: Option<Vec<String>>,
}

/// Validate one metadata document against its issuer.
fn authorization_server_metadata(
    value: &serde_json::Value,
    issuer: &str,
    require_exact_issuer: bool,
) -> Result<AuthServerMetadata> {
    let Some(object) = value.as_object() else {
        bail!("Authorization server metadata for {issuer} is invalid");
    };
    let Some(metadata_issuer) = object.get("issuer").and_then(|v| v.as_str()) else {
        bail!("Authorization server metadata for {issuer} is missing its issuer");
    };
    if require_exact_issuer {
        if metadata_issuer != issuer {
            bail!("Authorization server metadata issuer does not exactly match {issuer}");
        }
    } else {
        let advertised =
            validated_https_url(metadata_issuer, "Authorization server metadata issuer")?;
        let expected = validated_https_url(issuer, "Authorization server issuer")?;
        if advertised.origin() != expected.origin() || advertised.query().is_some() {
            bail!(
                "Origin authorization server metadata issuer must stay on {}",
                expected.origin().ascii_serialization()
            );
        }
    }
    let Some(authorization_endpoint) = object
        .get("authorization_endpoint")
        .and_then(|v| v.as_str())
    else {
        bail!("Authorization server metadata for {issuer} is missing required endpoints");
    };
    let Some(token_endpoint) = object.get("token_endpoint").and_then(|v| v.as_str()) else {
        bail!("Authorization server metadata for {issuer} is missing required endpoints");
    };
    validated_https_url(authorization_endpoint, "Authorization endpoint")?;
    validated_https_url(token_endpoint, "Token endpoint")?;
    let registration_endpoint = match object.get("registration_endpoint") {
        None => None,
        Some(value) => {
            let endpoint = value.as_str().unwrap_or_default();
            validated_https_url(endpoint, "Registration endpoint")?;
            Some(endpoint.to_string())
        }
    };
    let scopes_supported = object
        .get("scopes_supported")
        .and_then(|value| value.as_array())
        .map(|scopes| {
            scopes
                .iter()
                .filter_map(|scope| scope.as_str().map(str::to_string))
                .collect::<Vec<String>>()
        });
    Ok(AuthServerMetadata {
        issuer: metadata_issuer.to_string(),
        authorization_endpoint: authorization_endpoint.to_string(),
        token_endpoint: token_endpoint.to_string(),
        registration_endpoint,
        scopes_supported,
    })
}

/// A JSON metadata document: 200 with an `application/json` body.
async fn json_metadata(
    response: &super::oauth_http::OAuthHttpResponse,
    url: &str,
) -> Result<serde_json::Value> {
    if response.status != 200 {
        bail!("GET {url} failed: {}", response.status);
    }
    if response.content_type().as_deref() != Some("application/json") {
        bail!("GET {url} did not return application/json");
    }
    serde_json::from_str(&response.body)
        .map_err(|_| anyhow!("GET {url} did not return application/json"))
}

/// Discover the authorization-server metadata for an issuer, trying both
/// candidate locations (404 continues to the next).
async fn discover_authorization_server(
    http: &dyn OAuthHttp,
    issuer: &str,
    require_exact_issuer: bool,
) -> Result<AuthServerMetadata> {
    let issuer_url = validated_https_url(issuer, "Authorization server issuer")?;
    if issuer_url.query().is_some() {
        bail!("Authorization server issuer must not contain a query string");
    }
    let candidates = authorization_server_metadata_urls(&issuer_url);
    let mut last_error: Option<String> = None;
    for candidate in &candidates {
        let request = OAuthHttpRequest {
            method: OAuthHttpMethod::Get,
            url: candidate.clone(),
            headers: Vec::new(),
            body: None,
        };
        match http.request(request).await {
            Ok(response) => {
                if response.status == 404 {
                    continue;
                }
                match json_metadata(&response, candidate).await.and_then(|value| {
                    authorization_server_metadata(&value, issuer, require_exact_issuer)
                }) {
                    Ok(metadata) => return Ok(metadata),
                    Err(error) => last_error = Some(error.to_string()),
                }
            }
            Err(error) => last_error = Some(error.to_string()),
        }
    }
    bail!(
        "Could not discover OAuth metadata for {issuer}. Tried {}. Last error: {}",
        candidates.join(", "),
        last_error.unwrap_or_default()
    )
}

/// Protected-resource metadata (RFC 9728 shape).
#[derive(Debug)]
struct ProtectedResourceMetadata {
    resource: String,
    authorization_servers: Vec<String>,
}

fn resource_metadata(
    value: &serde_json::Value,
    resource: &str,
) -> Result<ProtectedResourceMetadata> {
    let Some(object) = value.as_object() else {
        bail!("Protected-resource metadata is invalid");
    };
    if object.get("resource").and_then(|v| v.as_str()) != Some(resource) {
        bail!("Protected-resource metadata resource does not exactly match {resource}");
    }
    let Some(servers) = object
        .get("authorization_servers")
        .and_then(|value| value.as_array())
    else {
        bail!("Protected-resource metadata has no authorization_servers");
    };
    if servers.is_empty() {
        bail!("Protected-resource metadata has no authorization_servers");
    }
    let mut issuers = Vec::new();
    for server in servers {
        let Some(issuer) = server.as_str() else {
            bail!("Protected-resource metadata has an invalid authorization server");
        };
        validated_https_url(issuer, "Authorization server issuer")?;
        issuers.push(issuer.to_string());
    }
    Ok(ProtectedResourceMetadata {
        resource: resource.to_string(),
        authorization_servers: issuers,
    })
}

/// The RFC 9728 well-known location for one resource.
fn resource_metadata_url(resource: &Url) -> String {
    let path = if resource.path() == "/" {
        String::new()
    } else {
        resource.path().to_string()
    };
    let mut url = format!(
        "{}/.well-known/oauth-protected-resource{path}",
        resource.origin().ascii_serialization()
    );
    if let Some(query) = resource.query() {
        url.push('?');
        url.push_str(query);
    }
    url
}

/// The `resource_metadata` pointer in a `WWW-Authenticate` header, with the
/// quoted-pair escapes removed.
fn header_resource_metadata(value: Option<&str>) -> Option<String> {
    static POINTER: std::sync::OnceLock<fancy_regex::Regex> = std::sync::OnceLock::new();
    let pointer = POINTER.get_or_init(|| {
        fancy_regex::Regex::new(r#"(?i)(?:^|[,\s])resource_metadata\s*=\s*"((?:[^"\\]|\\.)*)""#)
            .expect("static resource_metadata pattern is valid")
    });
    let value = value?;
    let captured = pointer.captures(value).ok()?.and_then(|c| c.get(1));
    let raw = captured?.as_str();
    let mut out = String::with_capacity(raw.len());
    let mut chars = raw.chars();
    while let Some(character) = chars.next() {
        if character == '\\' {
            if let Some(escaped) = chars.next() {
                out.push(escaped);
            }
            continue;
        }
        out.push(character);
    }
    Some(out)
}

/// What discovery resolved for one MCP endpoint.
pub(crate) struct Discovery {
    pub metadata: AuthServerMetadata,
    /// The RFC 9728 resource indicator when the login is PRM-based.
    pub resource: Option<String>,
    /// The RFC 8414/OIDC issuer a PRM-based login selected.
    pub issuer: Option<String>,
}

/// Discover RFC 9728 protected-resource metadata before the origin-level
/// authorization-server fallback.
pub(crate) async fn discover(http: &dyn OAuthHttp, url: &str) -> Result<Discovery> {
    let resource_url = validated_https_url(url, ENDPOINT_LABEL)?;
    let protected = try_protected_resource_metadata(http, &resource_url).await?;
    if let Some((metadata, resource, issuer)) = protected {
        return Ok(Discovery {
            metadata,
            resource: Some(resource),
            issuer: Some(issuer),
        });
    }
    Ok(Discovery {
        metadata: discover_authorization_server(
            http,
            &resource_url.origin().ascii_serialization(),
            false,
        )
        .await?,
        resource: None,
        issuer: None,
    })
}

type ProtectedDiscovery = Option<(AuthServerMetadata, String, String)>;

/// Probe protected-resource metadata: the `WWW-Authenticate`
/// `resource_metadata` pointer first, then the RFC well-known location.
/// `None` when the server serves no RFC 9728 metadata.
async fn try_protected_resource_metadata(
    http: &dyn OAuthHttp,
    resource_url: &Url,
) -> Result<ProtectedDiscovery> {
    // This probe deliberately has no Authorization header; it must never
    // leak an existing token. A failing probe is not an error (the server
    // need not support a GET probe).
    let probe = OAuthHttpRequest {
        method: OAuthHttpMethod::Get,
        url: resource_url.to_string(),
        headers: Vec::new(),
        body: None,
    };
    let header_url = match http.request(probe).await {
        Ok(response) => header_resource_metadata(response.header("www-authenticate")),
        Err(_) => None,
    };
    let candidate = match &header_url {
        Some(pointer) => validated_https_url(pointer, "resource_metadata")?.to_string(),
        None => resource_metadata_url(resource_url),
    };
    let request = OAuthHttpRequest {
        method: OAuthHttpMethod::Get,
        url: candidate.clone(),
        headers: Vec::new(),
        body: None,
    };
    let response = http.request(request).await?;
    if response.status == 404 && header_url.is_none() {
        return Ok(None);
    }
    let resource = canonical_resource(resource_url);
    let metadata = resource_metadata(&json_metadata(&response, &candidate).await?, &resource)?;
    let issuer = metadata.authorization_servers[0].clone();
    let server = discover_authorization_server(http, &issuer, true).await?;
    Ok(Some((server, metadata.resource, issuer)))
}

/// RFC 7591 dynamic client registration.
pub(crate) async fn register_client(
    http: &dyn OAuthHttp,
    registration_endpoint: &str,
    label: &str,
) -> Result<String> {
    validated_https_url(registration_endpoint, "Registration endpoint")?;
    let body = serde_json::json!({
        "client_name": format!("Prime Agent ({label})"),
        "redirect_uris": super::oauth_callback::all_redirect_uris(),
        "grant_types": ["authorization_code", "refresh_token"],
        "response_types": ["code"],
        "token_endpoint_auth_method": "none",
    });
    let request = OAuthHttpRequest {
        method: OAuthHttpMethod::Post,
        url: registration_endpoint.to_string(),
        headers: vec![("Content-Type".to_string(), "application/json".to_string())],
        body: Some(body.to_string()),
    };
    let response = http.request(request).await?;
    if !(200..300).contains(&response.status) {
        bail!("POST {registration_endpoint} failed: {}", response.status);
    }
    let value: serde_json::Value = serde_json::from_str(&response.body)
        .with_context(|| format!("POST {registration_endpoint} returned invalid JSON"))?;
    let client_id = value.get("client_id").and_then(|v| v.as_str());
    match client_id {
        Some(id) if !id.is_empty() => Ok(id.to_string()),
        _ => bail!("Dynamic client registration at {registration_endpoint} returned no client_id"),
    }
}

/// A token endpoint response: the fields the flow persists.
#[derive(Debug, Clone, PartialEq)]
pub(crate) struct TokenResponse {
    pub access_token: String,
    pub refresh_token: Option<String>,
    pub expires_in: Option<i64>,
}

/// POST one token grant; the response is validated the way the TS flow does.
pub(crate) async fn exchange_token(
    http: &dyn OAuthHttp,
    token_endpoint: &str,
    params: &[(String, String)],
) -> Result<TokenResponse> {
    validated_https_url(token_endpoint, "Token endpoint")?;
    let body = url::form_urlencoded::Serializer::new(String::new())
        .extend_pairs(params.iter().map(|(k, v)| (k.as_str(), v.as_str())))
        .finish();
    let request = OAuthHttpRequest {
        method: OAuthHttpMethod::Post,
        url: token_endpoint.to_string(),
        headers: vec![(
            "Content-Type".to_string(),
            "application/x-www-form-urlencoded".to_string(),
        )],
        body: Some(body),
    };
    let response = http.request(request).await?;
    if !(200..300).contains(&response.status) {
        bail!(
            "Token request to {token_endpoint} failed: {}",
            response.status
        );
    }
    let token: serde_json::Value = serde_json::from_str(&response.body)
        .map_err(|_| anyhow!("Token request to {token_endpoint} returned invalid JSON"))?;
    let access_token = token.get("access_token").and_then(|v| v.as_str());
    let access_token = match access_token {
        Some(token) if !token.is_empty() => token.to_string(),
        _ => bail!("Token request to {token_endpoint} returned no access_token"),
    };
    let refresh_token = match token.get("refresh_token") {
        None => None,
        Some(value) => match value.as_str() {
            Some(token) => Some(token.to_string()),
            None => bail!("Token request to {token_endpoint} returned an invalid refresh_token"),
        },
    };
    let expires_in = match token.get("expires_in") {
        None => None,
        Some(value) => match value.as_i64() {
            Some(seconds) => Some(seconds),
            None => bail!("Token request to {token_endpoint} returned an invalid expires_in"),
        },
    };
    Ok(TokenResponse {
        access_token,
        refresh_token,
        expires_in,
    })
}

/// URL-safe random bytes (the TS `btoa`-style encoding, padding stripped).
fn base64url(bytes: &[u8]) -> String {
    base64::engine::general_purpose::URL_SAFE_NO_PAD.encode(bytes)
}

fn random_bytes(len: usize) -> Vec<u8> {
    let mut bytes = vec![0u8; len];
    getrandom::fill(&mut bytes).expect("system entropy is unavailable");
    bytes
}

/// A PKCE pair: the verifier is the token-exchange secret, the challenge
/// travels in the authorization URL.
pub(crate) fn generate_pkce() -> (String, String) {
    let verifier = base64url(&random_bytes(32));
    let challenge = base64url(Sha256::digest(verifier.as_bytes()).as_slice());
    (verifier, challenge)
}

/// A random, URL-safe CSRF `state`, independent of the PKCE verifier.
pub(crate) fn random_state() -> String {
    base64url(&random_bytes(32))
}

/// The pasted authorization input: a full redirect URL, a query string, or
/// a bare code. A `state` that disagrees with the login's own is an error.
pub(crate) fn parse_redirect_input(input: &str, expected_state: &str) -> Result<(String, String)> {
    let value = input.trim();
    let (code, state) = if let Ok(url) = Url::parse(value) {
        let get = |name: &str| {
            url.query_pairs()
                .find(|(key, _)| key == name)
                .map(|(_, value)| value.to_string())
        };
        (get("code"), get("state"))
    } else if value.contains('=') {
        let get = |name: &str| {
            url::form_urlencoded::parse(value.as_bytes())
                .find(|(key, _)| key == name)
                .map(|(_, value)| value.to_string())
        };
        (get("code"), get("state"))
    } else {
        (Some(value.to_string()), None)
    };
    if let Some(state) = &state {
        if state != expected_state {
            bail!("OAuth state mismatch");
        }
    }
    match code {
        Some(code) if !code.is_empty() => {
            Ok((code, state.unwrap_or_else(|| expected_state.to_string())))
        }
        _ => bail!("Missing authorization code"),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn https_url_validation() {
        assert!(validated_https_url("https://mcp.example/mcp", ENDPOINT_LABEL).is_ok());
        let error = validated_https_url("notaurl", ENDPOINT_LABEL)
            .unwrap_err()
            .to_string();
        assert_eq!(error, "MCP endpoint must be an absolute HTTPS URL");
        let error = validated_https_url("http://insecure.example", ENDPOINT_LABEL)
            .unwrap_err()
            .to_string();
        assert_eq!(
            error,
            "MCP endpoint must be an absolute HTTPS URL without credentials or a fragment"
        );
        let error = validated_https_url("https://user:pw@example.com", ENDPOINT_LABEL)
            .unwrap_err()
            .to_string();
        assert_eq!(
            error,
            "MCP endpoint must be an absolute HTTPS URL without credentials or a fragment"
        );
    }

    #[test]
    fn canonical_resource_forms() {
        assert_eq!(
            canonical_resource(&Url::parse("https://root.example/").unwrap()),
            "https://root.example"
        );
        assert_eq!(
            canonical_resource(&Url::parse("https://root.example").unwrap()),
            "https://root.example"
        );
        assert_eq!(
            canonical_resource(&Url::parse("https://root.example/mcp").unwrap()),
            "https://root.example/mcp"
        );
        let resource = Url::parse("https://mcp.example/mcp?tenant=a").unwrap();
        assert_eq!(
            canonical_resource(&resource),
            "https://mcp.example/mcp?tenant=a"
        );
        assert_eq!(
            resource_metadata_url(&resource),
            "https://mcp.example/.well-known/oauth-protected-resource/mcp?tenant=a"
        );
    }

    #[test]
    fn authorization_server_metadata_urls_cover_both_locations() {
        let issuer = Url::parse("https://login.example/tenant").unwrap();
        assert_eq!(
            authorization_server_metadata_urls(&issuer),
            vec![
                "https://login.example/.well-known/oauth-authorization-server/tenant".to_string(),
                "https://login.example/tenant/.well-known/openid-configuration".to_string(),
            ]
        );
    }

    #[test]
    fn metadata_validation_messages() {
        let issuer = "https://login.example/tenant";
        let error = authorization_server_metadata(&serde_json::json!({}), issuer, true)
            .unwrap_err()
            .to_string();
        assert_eq!(
            error,
            format!("Authorization server metadata for {issuer} is missing its issuer")
        );
        let error = authorization_server_metadata(
            &serde_json::json!({ "issuer": "https://wrong.example" }),
            issuer,
            true,
        )
        .unwrap_err()
        .to_string();
        assert_eq!(
            error,
            format!("Authorization server metadata issuer does not exactly match {issuer}")
        );
        let error = authorization_server_metadata(
            &serde_json::json!({ "issuer": "https://other.example/tenant" }),
            issuer,
            false,
        )
        .unwrap_err()
        .to_string();
        assert_eq!(
            error,
            "Origin authorization server metadata issuer must stay on https://login.example"
        );
        let error =
            authorization_server_metadata(&serde_json::json!({ "issuer": issuer }), issuer, true)
                .unwrap_err()
                .to_string();
        assert_eq!(
            error,
            format!("Authorization server metadata for {issuer} is missing required endpoints")
        );
        let metadata = authorization_server_metadata(
            &serde_json::json!({
                "issuer": issuer,
                "authorization_endpoint": "https://login.example/tenant/authorize",
                "token_endpoint": "https://login.example/tenant/token",
                "registration_endpoint": "https://login.example/tenant/register",
                "scopes_supported": ["read", "write"],
            }),
            issuer,
            true,
        )
        .unwrap();
        assert_eq!(
            metadata,
            AuthServerMetadata {
                issuer: issuer.to_string(),
                authorization_endpoint: "https://login.example/tenant/authorize".to_string(),
                token_endpoint: "https://login.example/tenant/token".to_string(),
                registration_endpoint: Some("https://login.example/tenant/register".to_string()),
                scopes_supported: Some(vec!["read".to_string(), "write".to_string()]),
            }
        );
    }

    #[test]
    fn protected_resource_metadata_validation() {
        let error = resource_metadata(
            &serde_json::json!({ "resource": "https://other/mcp" }),
            "https://mcp.example/mcp",
        )
        .unwrap_err()
        .to_string();
        assert_eq!(
            error,
            "Protected-resource metadata resource does not exactly match https://mcp.example/mcp"
        );
        let error = resource_metadata(
            &serde_json::json!({ "resource": "https://mcp.example/mcp" }),
            "https://mcp.example/mcp",
        )
        .unwrap_err()
        .to_string();
        assert_eq!(
            error,
            "Protected-resource metadata has no authorization_servers"
        );
    }

    #[test]
    fn www_authenticate_resource_metadata_pointer() {
        assert_eq!(
            header_resource_metadata(Some(
                r#"Bearer realm="mcp", resource_metadata="https://metadata.example/rm""#
            )),
            Some("https://metadata.example/rm".to_string())
        );
        assert_eq!(header_resource_metadata(None), None);
        assert_eq!(header_resource_metadata(Some("Basic realm=\"x\"")), None);
    }

    #[test]
    fn redirect_input_parsing() {
        assert_eq!(
            parse_redirect_input(
                "http://localhost:53700/callback?code=the-code&state=st",
                "st"
            )
            .unwrap(),
            ("the-code".to_string(), "st".to_string())
        );
        assert_eq!(
            parse_redirect_input("code=a&state=st", "st").unwrap(),
            ("a".to_string(), "st".to_string())
        );
        assert_eq!(
            parse_redirect_input("the-bare-code", "st").unwrap(),
            ("the-bare-code".to_string(), "st".to_string())
        );
        let error = parse_redirect_input("code=a&state=other", "st")
            .unwrap_err()
            .to_string();
        assert_eq!(error, "OAuth state mismatch");
        let error = parse_redirect_input("", "st").unwrap_err().to_string();
        assert_eq!(error, "Missing authorization code");
    }

    #[test]
    fn pkce_shapes() {
        let (verifier, challenge) = generate_pkce();
        assert_eq!(verifier.len(), 43);
        assert_eq!(challenge.len(), 43);
        assert_ne!(verifier, challenge);
        let state = random_state();
        assert_eq!(state.len(), 43);
        assert_ne!(state, random_state());
    }
}

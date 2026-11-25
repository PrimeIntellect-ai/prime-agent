//! The platform's global secrets: list and create, in the client's scope
//! (its team when it has one, the scope its sandboxes bill to; else the
//! user's own). A sandbox's header rules name these secrets as
//! `${prime.secrets.<NAME>}`, and the platform resolves them outside the
//! sandbox:
//!
//! - `GET  {base}/api/v1/secrets/` — list, paged by `offset`/`limit`;
//! - `POST {base}/api/v1/secrets/` — create; `camelCase` body.
//!
//! The value is sent once, on create; the platform never returns it, and
//! no error message or `details` preview ever carries it.

use serde::Deserialize;

use crate::client::PrimeSandboxClient;
use crate::error::SandboxError;
use crate::transport::SandboxTransport;
use crate::types::Method;

/// Secrets per list page (the platform's default page size).
const SECRETS_PAGE_LIMIT: usize = 100;

/// The longest description the platform stores.
const MAX_SECRET_DESCRIPTION_CHARS: usize = 500;

/// A global platform secret (the platform never returns its value).
#[derive(Debug, Clone, PartialEq, Eq, Deserialize)]
pub struct PlatformSecret {
    /// The secret id.
    pub id: String,
    /// The secret name, the one `${prime.secrets.<NAME>}` references.
    pub name: String,
}

/// A platform secret name: an uppercase letter, then uppercase letters,
/// digits, or underscores, 255 characters at most.
fn is_secret_name(name: &str) -> bool {
    name.len() <= 255
        && name.as_bytes().first().is_some_and(u8::is_ascii_uppercase)
        && name
            .bytes()
            .all(|byte| byte.is_ascii_uppercase() || byte.is_ascii_digit() || byte == b'_')
}

/// One list page (the platform's `GenericPaginationResponse`).
#[derive(Deserialize)]
struct SecretPage {
    data: Vec<PlatformSecret>,
    #[serde(default, alias = "totalCount")]
    total_count: Option<usize>,
}

/// The create response (the platform's `GenericResponse`).
#[derive(Deserialize)]
struct CreatedSecret {
    data: PlatformSecret,
}

impl<T: SandboxTransport> PrimeSandboxClient<T> {
    /// Every global secret in the client's scope, across all pages.
    ///
    /// # Errors
    ///
    /// Returns a status-mapped error for non-2xx responses and
    /// [`crate::SandboxErrorCode::InvalidResponse`] for a malformed page.
    pub async fn list_secrets(&self) -> Result<Vec<PlatformSecret>, SandboxError> {
        let mut secrets: Vec<PlatformSecret> = Vec::new();
        loop {
            let mut url = url::Url::parse(&format!("{}/api/v1/secrets/", self.base_url))
                .map_err(|_| SandboxError::invalid_request("Secret list URL is invalid"))?;
            {
                let mut query = url.query_pairs_mut();
                if let Some(team_id) = &self.team_id {
                    query.append_pair("teamId", team_id);
                }
                query.append_pair("offset", &secrets.len().to_string());
                query.append_pair("limit", &SECRETS_PAGE_LIMIT.to_string());
            }
            let page = self
                .request_json(
                    Method::Get,
                    url.to_string(),
                    self.platform_headers(),
                    None,
                    self.request_timeout,
                    self.platform_secrets(),
                    "Secret list",
                    |response| {
                        serde_json::from_value::<SecretPage>(response).map_err(|_| {
                            SandboxError::invalid_response(
                                "Secret list response must carry a data array of secrets",
                            )
                        })
                    },
                )
                .await?;
            let fetched = page.data.len();
            secrets.extend(page.data);
            // A short page is the last one; the total, when present, ends
            // the walk early.
            if fetched < SECRETS_PAGE_LIMIT
                || page.total_count.is_some_and(|total| secrets.len() >= total)
            {
                return Ok(secrets);
            }
        }
    }

    /// Create a global secret in the client's scope. Not idempotent: the
    /// platform refuses a name its scope already holds.
    ///
    /// # Errors
    ///
    /// Returns [`crate::SandboxErrorCode::InvalidRequest`] when the name,
    /// value, or description fails local validation (nothing is sent); a
    /// status-mapped error for non-2xx responses (the value redacted from
    /// its `details`); [`crate::SandboxErrorCode::InvalidResponse`] for a
    /// malformed 200 body.
    pub async fn create_secret(
        &self,
        name: &str,
        value: &str,
        description: Option<&str>,
    ) -> Result<PlatformSecret, SandboxError> {
        if !is_secret_name(name) {
            return Err(SandboxError::invalid_request(
                "Secret name must be an uppercase letter, then up to 254 uppercase letters, digits, or underscores",
            ));
        }
        if value.is_empty() {
            return Err(SandboxError::invalid_request(
                "Secret value must be non-empty",
            ));
        }
        if description.is_some_and(|text| text.chars().count() > MAX_SECRET_DESCRIPTION_CHARS) {
            return Err(SandboxError::invalid_request(format!(
                "Secret description must be at most {MAX_SECRET_DESCRIPTION_CHARS} characters"
            )));
        }
        let mut body = serde_json::Map::new();
        body.insert("name".into(), name.into());
        body.insert("value".into(), value.into());
        if let Some(description) = description {
            body.insert("description".into(), description.into());
        }
        if let Some(team_id) = &self.team_id {
            body.insert("teamId".into(), team_id.as_str().into());
        }
        self.request_json(
            Method::Post,
            format!("{}/api/v1/secrets/", self.base_url),
            self.platform_headers(),
            Some(serde_json::Value::Object(body).to_string().into_bytes()),
            self.request_timeout,
            vec![self.api_key.as_str(), value],
            "Secret create",
            |response| {
                serde_json::from_value::<CreatedSecret>(response)
                    .map(|created| created.data)
                    .map_err(|_| {
                        SandboxError::invalid_response(
                            "Secret create response must carry the created secret",
                        )
                    })
            },
        )
        .await
    }
}

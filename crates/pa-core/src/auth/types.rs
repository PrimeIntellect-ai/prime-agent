//! Auth credential types (auth-storage.ts + prime-inference-auth.ts).

use serde::{Deserialize, Serialize};

pub const PRIME_INFERENCE_PROVIDER_ID: &str = "prime-inference";

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PrimeTeamCredential {
    pub team_id: String,
    pub name: String,
    pub slug: Option<String>,
    pub role: Option<String>,
    pub created_at: Option<String>,
}

/// The team half of a Prime Inference key write (TS `setPrimeInferenceApiKey`'s
/// `primeTeam?: PrimeTeam | null`): an absent argument preserves the stored
/// team when the key is unchanged, `null` is the personal account.
#[derive(Debug, Clone, PartialEq)]
pub enum PrimeTeamAssignment {
    /// TS `undefined`: keep the stored team, but only on the same key.
    PreserveWhenKeyMatches,
    /// TS `null`: the personal account.
    PersonalAccount,
    /// TS `PrimeTeam`: this team.
    Team(PrimeTeamCredential),
}

/// The stored Prime team selection (TS `getPrimeInferenceTeamSelection`'s
/// `PrimeTeamCredential | null | undefined`): `undefined` means no stored
/// selection applies (`PRIME_TEAM_ID` is set, or no api-key credential is
/// stored). Fleet divergence (P5): a runtime or environment API-key
/// override does not hide the stored team — it survives, so daemons on
/// boxes with ambient `PRIME_API_KEY` need no `PRIME_TEAM_ID` pin.
#[derive(Debug, Clone, PartialEq)]
pub enum StoredPrimeTeam {
    /// TS `undefined`.
    NotSelected,
    /// TS `null`: the personal account.
    PersonalAccount,
    /// TS `PrimeTeamCredential`.
    Team(PrimeTeamCredential),
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(tag = "type", rename_all = "snake_case")]
pub enum AuthCredential {
    #[serde(rename = "api_key")]
    ApiKey {
        key: String,
        #[serde(rename = "primeTeam", default, skip_serializing_if = "Option::is_none")]
        prime_team: Option<PrimeTeamCredential>,
    },
    /// A pasted MCP static token (the inline paste flow for
    /// `requires-setup` token services): the literal bearer value plus the
    /// endpoint it is bound to. No expiry — usable until removed or replaced.
    /// Setup field ids are metadata, never environment variables to read.
    #[serde(rename = "mcp_static_token")]
    McpStaticToken {
        bearer: String,
        #[serde(rename = "endpoint", default, skip_serializing_if = "Option::is_none")]
        endpoint: Option<String>,
    },
    #[serde(rename = "oauth")]
    Oauth {
        access: String,
        refresh: Option<String>,
        expires: i64,
        /// The ChatGPT account the Codex Subscription token carries (TS
        /// stores the codex login's `accountId` next to the credentials;
        /// the request path re-extracts it from the token, like TS).
        #[serde(
            rename = "accountId",
            default,
            skip_serializing_if = "Option::is_none"
        )]
        account_id: Option<String>,
        /// Endpoint binding for MCP logins (`mcp:<server>` credentials): the
        /// MCP endpoint the token was issued for; consumers refuse to send
        /// it elsewhere.
        #[serde(rename = "endpoint", default, skip_serializing_if = "Option::is_none")]
        endpoint: Option<String>,
        /// The token endpoint the token was exchanged at (refreshes reuse it).
        #[serde(
            rename = "tokenEndpoint",
            default,
            skip_serializing_if = "Option::is_none"
        )]
        token_endpoint: Option<String>,
        /// The OAuth client the login registered/pre-configured.
        #[serde(rename = "clientId", default, skip_serializing_if = "Option::is_none")]
        client_id: Option<String>,
        /// RFC 9728 resource indicator; its presence marks a
        /// protected-resource-metadata login.
        #[serde(rename = "resource", default, skip_serializing_if = "Option::is_none")]
        resource: Option<String>,
        /// RFC 8414/OIDC issuer selected by the protected-resource metadata.
        #[serde(rename = "issuer", default, skip_serializing_if = "Option::is_none")]
        issuer: Option<String>,
    },
}

impl AuthCredential {
    pub fn credential_type(&self) -> &'static str {
        match self {
            AuthCredential::ApiKey { .. } => "api_key",
            AuthCredential::McpStaticToken { .. } => "mcp_static_token",
            AuthCredential::Oauth { .. } => "oauth",
        }
    }
}

/// auth.json document: provider id -> credential. Unknown providers
/// (custom OAuth shapes) survive round-trips.
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
pub struct AuthStorageData(pub serde_json::Map<String, serde_json::Value>);

impl AuthStorageData {
    pub fn get(&self, provider: &str) -> Option<&serde_json::Value> {
        self.0.get(provider)
    }

    pub fn credential(&self, provider: &str) -> Option<AuthCredential> {
        self.0
            .get(provider)
            .and_then(|value| serde_json::from_value(value.clone()).ok())
    }

    pub fn insert(&mut self, provider: &str, credential: &AuthCredential) {
        if let Ok(value) = serde_json::to_value(credential) {
            self.0.insert(provider.to_string(), value);
        }
    }

    pub fn remove(&mut self, provider: &str) {
        self.0.remove(provider);
    }

    pub fn keys(&self) -> Vec<String> {
        self.0.keys().cloned().collect()
    }
}

/// Where a usable credential came from.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum AuthSource {
    Stored,
    Runtime,
    Environment,
    PrimeCli,
    Fallback,
    ModelsJsonKey,
    ModelsJsonCommand,
    /// Marked stale; kept for a later explicit re-login.
    Stale,
}

/// Auth status without credential values.
#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AuthStatus {
    pub configured: bool,
    pub source: Option<AuthSource>,
    pub label: Option<String>,
}

/// A stale-marking token for one credential source value.
#[derive(Debug, Clone, PartialEq)]
pub struct AuthSourceToken {
    pub provider: String,
    pub source: AuthSource,
    pub identity_fingerprint: String,
    pub value_fingerprint: String,
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn credential_wire_shapes() {
        let api_key: AuthCredential =
            serde_json::from_value(serde_json::json!({ "type": "api_key", "key": "sk" })).unwrap();
        assert!(matches!(api_key, AuthCredential::ApiKey { .. }));
        let oauth: AuthCredential = serde_json::from_value(
            serde_json::json!({ "type": "oauth", "access": "a", "refresh": "r", "expires": 123 }),
        )
        .unwrap();
        assert!(matches!(oauth, AuthCredential::Oauth { .. }));
        // The codex subscription login stores its `accountId` (the TS
        // auth.json shape) and the field round-trips.
        let codex: AuthCredential = serde_json::from_value(serde_json::json!({
            "type": "oauth", "access": "a", "refresh": "r", "expires": 123,
            "accountId": "acct-1"
        }))
        .unwrap();
        assert!(matches!(
            &codex,
            AuthCredential::Oauth { account_id: Some(account_id), .. } if account_id == "acct-1"
        ));
        let emitted = serde_json::to_value(&codex).unwrap();
        assert_eq!(emitted["accountId"], "acct-1");
    }
}

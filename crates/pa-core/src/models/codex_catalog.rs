//! Auth adapter for Codex discovery. Snapshot reads never refresh OAuth tokens.

use crate::auth::{AuthCredential, AuthStorage, OPENAI_CODEX_PROVIDER_ID};

pub(super) fn account_id(auth: &AuthStorage) -> Option<String> {
    if auth.get_auth_status(OPENAI_CODEX_PROVIDER_ID).source
        != Some(crate::auth::AuthSource::Stored)
    {
        return None;
    }
    match auth.get_all().credential(OPENAI_CODEX_PROVIDER_ID)? {
        AuthCredential::Oauth { account_id, .. } => account_id,
        AuthCredential::ApiKey { .. } | AuthCredential::McpStaticToken { .. } => None,
    }
}

pub(super) fn credentials(auth: &mut AuthStorage) -> Option<pa_models::CodexCredentials> {
    if pa_models::offline::is_catalog_offline() {
        return None;
    }
    let resolved = auth
        .get_api_key_with_source_token(OPENAI_CODEX_PROVIDER_ID, /*include_fallback*/ false);
    if resolved.credential_type != Some("oauth") {
        return None;
    }
    Some(pa_models::CodexCredentials {
        access_token: resolved.api_key?,
        account_id: account_id(auth)?,
    })
}

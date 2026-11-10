//! The served Agent Card (spec section 8): the discovery manifest the
//! A2A server publishes at `/.well-known/agent-card.json`, built from
//! the mode's launch options. The card is the protocol's contract
//! surface — it declares exactly what the server implements and nothing
//! more, so the capability flags here stay in lockstep with the served
//! methods.

use std::collections::BTreeMap;

use serde_json::Value;

use super::types::{
    AgentCapabilities, AgentCard, AgentInterface, AgentSkill, HttpAuthSecurityScheme,
    SecurityRequirement, SecurityScheme,
};

/// The card fields the launch options select.
#[derive(Debug, Clone, PartialEq)]
pub struct CardOptions {
    /// The agent's display name.
    pub name: String,
    /// The agent's description.
    pub description: String,
    /// The serving product's version (the card's `version` field).
    pub product_version: String,
    /// The absolute URL the JSON-RPC binding is served at.
    pub interface_url: String,
}

/// The card's bearer security scheme: the token is required (configured
/// or minted per run — see `A2aOptions::bearer_token`), so the card
/// always declares it.
fn bearer_schemes() -> BTreeMap<String, SecurityScheme> {
    let mut schemes = BTreeMap::new();
    schemes.insert(
        "bearer".to_string(),
        SecurityScheme {
            http_auth_security_scheme: Some(HttpAuthSecurityScheme {
                description: Some("Bearer token authentication".to_string()),
                scheme: "Bearer".to_string(),
                bearer_format: None,
            }),
        },
    );
    schemes
}

/// The card's bearer security requirement (the scheme above).
fn bearer_requirement() -> Vec<SecurityRequirement> {
    vec![SecurityRequirement {
        schemes: [(
            "bearer".to_string(),
            super::types::SecurityScopes { list: Some(vec![]) },
        )]
        .into_iter()
        .collect(),
    }]
}

/// The A2A media types the server accepts and emits: text parts in and
/// text/markdown artifacts out (v1's honest content surface).
pub const INPUT_MODE: &str = "text/plain";
pub const OUTPUT_MODE: &str = "text/markdown";

/// Build the served card. Capabilities mirror the implementation:
/// streaming yes, push notifications no, extended card no (spec 4.4.3),
/// one general-purpose skill (the skills array is required non-empty,
/// spec 4.4.1).
#[must_use]
pub fn build_card(options: &CardOptions) -> AgentCard {
    AgentCard {
        name: options.name.clone(),
        description: options.description.clone(),
        supported_interfaces: vec![AgentInterface {
            url: options.interface_url.clone(),
            protocol_binding: "JSONRPC".to_string(),
            tenant: None,
            protocol_version: super::jsonrpc::PROTOCOL_VERSION.to_string(),
        }],
        provider: None,
        version: options.product_version.clone(),
        documentation_url: None,
        capabilities: AgentCapabilities {
            streaming: Some(true),
            push_notifications: Some(false),
            extensions: None,
            extended_agent_card: Some(false),
        },
        security_schemes: Some(bearer_schemes()),
        security_requirements: Some(bearer_requirement()),
        default_input_modes: vec![INPUT_MODE.to_string()],
        default_output_modes: vec![OUTPUT_MODE.to_string()],
        skills: vec![AgentSkill {
            id: "prime-agent".to_string(),
            name: "Prime Agent".to_string(),
            description: "A general-purpose coding and research agent: \
            conversation, tool use, and multi-step tasks, driven over A2A."
                .to_string(),
            tags: vec!["agent".to_string(), "coding".to_string()],
            examples: None,
            input_modes: None,
            output_modes: None,
        }],
        icon_url: None,
    }
}

/// The served card's HTTP response envelope: the card JSON plus the
/// caching headers the spec's SHOULD asks for (spec 8.6), derived from
/// the card content so an unchanged card revalidates cheaply.
#[must_use]
pub fn card_response_body(card: &AgentCard) -> Value {
    serde_json::to_value(card).unwrap_or(Value::Null)
}

/// The `ETag` of one served card body: a stable content hash.
#[must_use]
pub fn card_etag(card_body: &Value) -> String {
    use sha2::{Digest as _, Sha256};
    let text = serde_json::to_string(card_body).unwrap_or_default();
    let digest = Sha256::digest(text.as_bytes());
    format!(
        "\"{:016x}\"",
        u64::from_be_bytes(digest[..8].try_into().unwrap_or_default())
    )
}

#[cfg(test)]
mod tests {
    use super::*;

    fn options() -> CardOptions {
        CardOptions {
            name: "Prime Agent".into(),
            description: "A general-purpose agent".into(),
            product_version: "0.10.2".into(),
            interface_url: "http://127.0.0.1:7800/".into(),
        }
    }

    /// The card declares exactly what the server implements: the JSON-RPC
    /// interface first and preferred (spec 8.3.1), streaming on, push
    /// off, no extended card.
    #[test]
    fn the_card_declares_the_served_capabilities() {
        let card = build_card(&options());
        assert_eq!(card.supported_interfaces.len(), 1);
        assert_eq!(card.supported_interfaces[0].protocol_binding, "JSONRPC");
        assert_eq!(card.supported_interfaces[0].protocol_version, "1.0");
        assert_eq!(card.capabilities.streaming, Some(true));
        assert_eq!(card.capabilities.push_notifications, Some(false));
        assert_eq!(card.capabilities.extended_agent_card, Some(false));
        assert!(!card.skills.is_empty(), "the skills array is required");
        let body = card_response_body(&card);
        assert_eq!(body["name"], "Prime Agent");
        assert_eq!(body["version"], "0.10.2");
        assert_eq!(body["defaultInputModes"][0], INPUT_MODE);
    }

    /// The required token (configured or minted, see
    /// `A2aOptions::bearer_token`) declares the card's security: the
    /// http bearer scheme and its requirement, unconditionally.
    #[test]
    fn the_card_declares_the_http_bearer_scheme() {
        let card = build_card(&options());
        let schemes = card.security_schemes.as_ref().expect("schemes declared");
        assert!(schemes.contains_key("bearer"));
        assert_eq!(
            schemes["bearer"]
                .http_auth_security_scheme
                .as_ref()
                .unwrap()
                .scheme,
            "Bearer"
        );
        let requirements = card.security_requirements.as_ref().expect("requirement");
        assert!(requirements[0].schemes.contains_key("bearer"));
    }

    /// The `ETag` is stable for one card and changes with the card.
    #[test]
    fn the_etag_tracks_the_card_content() {
        let card = build_card(&options());
        let body = card_response_body(&card);
        let etag = card_etag(&body);
        assert_eq!(
            etag,
            card_etag(&card_response_body(&build_card(&options())))
        );
        let mut changed = build_card(&options());
        changed.version = "0.11.0".into();
        assert_ne!(etag, card_etag(&card_response_body(&changed)));
    }
}

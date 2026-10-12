//! Dedicated binary: Codex WSS is the first process-default TLS client.

use std::sync::Arc;
use std::time::Duration;

use base64::Engine as _;
use futures::{SinkExt, StreamExt};
use pa_ai::types::{Context, Model, StopReason, StreamOptions, Transport};
use rcgen::{BasicConstraints, CertificateParams, IsCa, Issuer, KeyPair};
use serde_json::json;
use tokio::net::TcpListener;
use tokio_rustls::rustls::pki_types::PrivateKeyDer;
use tokio_rustls::rustls::{crypto::CryptoProvider, ServerConfig};
use tokio_rustls::TlsAcceptor;
use tokio_tungstenite::tungstenite::Message;

struct FixtureEnvironment(Vec<(&'static str, Option<std::ffi::OsString>)>);

impl Drop for FixtureEnvironment {
    fn drop(&mut self) {
        for (name, previous) in self.0.drain(..) {
            match previous {
                Some(value) => std::env::set_var(name, value),
                None => std::env::remove_var(name),
            }
        }
    }
}

#[tokio::test]
// Keep the fixture, first-use precondition and public-path assertions in one
// test so no other test/client can initialize the process-default TLS provider.
// tungstenite dictates the upgrade callback's Response-sized error type.
#[allow(clippy::too_many_lines, clippy::result_large_err)]
async fn the_first_codex_websocket_trusts_node_extra_ca_certs() {
    let mut ca_params = CertificateParams::new(Vec::<String>::new()).expect("CA params");
    ca_params.is_ca = IsCa::Ca(BasicConstraints::Unconstrained);
    let ca_key = KeyPair::generate().expect("CA key");
    let ca_cert = ca_params.self_signed(&ca_key).expect("CA cert");
    let leaf_params = CertificateParams::new(vec!["127.0.0.1".to_string()]).expect("leaf params");
    let leaf_key = KeyPair::generate().expect("leaf key");
    let leaf_cert = leaf_params
        .signed_by(&leaf_key, &Issuer::from_params(&ca_params, &ca_key))
        .expect("leaf cert");
    // Explicit provider only for the server: do not install a process default
    // before the production client's first call to ClientConfig::builder().
    let mut config = ServerConfig::builder_with_provider(Arc::new(
        tokio_rustls::rustls::crypto::ring::default_provider(),
    ))
    .with_safe_default_protocol_versions()
    .expect("server protocol versions")
    .with_no_client_auth()
    .with_single_cert(
        vec![leaf_cert.der().clone()],
        PrivateKeyDer::Pkcs8(leaf_key.serialize_der().into()),
    )
    .expect("TLS config");
    config.alpn_protocols = vec![b"http/1.1".to_vec()];
    let acceptor = TlsAcceptor::from(Arc::new(config));
    let listener = TcpListener::bind("127.0.0.1:0").await.expect("bind");
    let base_url = format!("https://{}", listener.local_addr().expect("address"));
    let server = tokio::spawn(async move {
        let (socket, _) = listener.accept().await.expect("Codex connection");
        let tls = acceptor
            .accept(socket)
            .await
            .expect("custom-CA TLS handshake");
        // The old default tungstenite connector also advertises no ALPN.
        assert_eq!(tls.get_ref().1.alpn_protocol(), None);
        let mut websocket = tokio_tungstenite::accept_hdr_async(
            tls,
            |request: &tokio_tungstenite::tungstenite::handshake::server::Request, response| {
                assert_eq!(request.uri().path(), "/codex/responses");
                assert_eq!(request.headers()["chatgpt-account-id"], "fixture-account");
                Ok(response)
            },
        )
        .await
        .expect("WebSocket upgrade");
        let request = websocket
            .next()
            .await
            .expect("request frame")
            .expect("request");
        let request: serde_json::Value =
            serde_json::from_str(request.to_text().expect("text request")).expect("request JSON");
        assert_eq!(request["type"], "response.create");
        for event in [
            json!({"type": "response.created", "response": {"id": "fixture-response"}}),
            json!({"type": "response.output_item.added", "output_index": 0,
                "item": {"type": "message", "id": "fixture-message", "role": "assistant", "status": "in_progress", "content": []}}),
            json!({"type": "response.content_part.added", "output_index": 0, "content_index": 0,
                "part": {"type": "output_text", "text": ""}}),
            json!({"type": "response.output_text.delta", "output_index": 0, "content_index": 0, "delta": "Trusted"}),
            json!({"type": "response.output_item.done", "item": {"type": "message", "id": "fixture-message",
                "role": "assistant", "status": "completed", "content": [{"type": "output_text", "text": "Trusted"}]}}),
            json!({"type": "response.completed", "response": {"id": "fixture-response", "status": "completed",
                "usage": {"input_tokens": 5, "output_tokens": 3, "total_tokens": 8}}}),
        ] {
            websocket
                .send(Message::Text(event.to_string().into()))
                .await
                .expect("response frame");
        }
    });

    let bundle = tempfile::NamedTempFile::new().expect("CA bundle");
    // Node retains the trusted prefix when a later PEM certificate has invalid DER.
    let pem = format!(
        "{}-----BEGIN CERTIFICATE-----\nAQID\n-----END CERTIFICATE-----\n",
        ca_cert.pem()
    );
    std::fs::write(bundle.path(), pem).expect("write CA");
    let _environment = FixtureEnvironment(
        [
            "NODE_EXTRA_CA_CERTS",
            "HTTP_PROXY",
            "http_proxy",
            "HTTPS_PROXY",
            "https_proxy",
            "ALL_PROXY",
            "all_proxy",
            "NO_PROXY",
            "no_proxy",
        ]
        .into_iter()
        .map(|name| (name, std::env::var_os(name)))
        .collect(),
    );
    std::env::set_var("NODE_EXTRA_CA_CERTS", bundle.path());
    // Even an unexpected HTTP fallback must remain local to this fixture.
    for name in [
        "HTTP_PROXY",
        "http_proxy",
        "HTTPS_PROXY",
        "https_proxy",
        "ALL_PROXY",
        "all_proxy",
    ] {
        std::env::remove_var(name);
    }
    std::env::set_var("NO_PROXY", "127.0.0.1,localhost");
    std::env::set_var("no_proxy", "127.0.0.1,localhost");
    assert!(
        CryptoProvider::get_default().is_none(),
        "fixture must not initialize the default TLS provider"
    );
    let payload = base64::engine::general_purpose::URL_SAFE_NO_PAD.encode(
        json!({"https://api.openai.com/auth": {"chatgpt_account_id": "fixture-account"}})
            .to_string(),
    );
    let model: Model = serde_json::from_value(json!({
        "id": "gpt-5.1-codex", "name": "Fixture Codex", "api": "openai-codex-responses", "provider": "openai-codex",
        "baseUrl": base_url, "reasoning": false, "input": ["text"], "contextWindow": 1000, "maxTokens": 100,
        "cost": {"input": 0, "output": 0, "cacheRead": 0, "cacheWrite": 0}
    })).expect("model");
    tokio::time::timeout(Duration::from_secs(10), async {
        let events = pa_ai::stream(
            &model,
            &Context::default(),
            Some(StreamOptions {
                api_key: Some(format!("fixture.{payload}.signature")),
                transport: Some(Transport::Websocket),
                session_id: Some("fixture-first-wss".to_string()),
                ..Default::default()
            }),
        )
        .expect("Codex provider");
        let result = events.result().await;
        assert_eq!(
            (result.stop_reason, result.response_id.as_deref()),
            (StopReason::Stop, Some("fixture-response")),
            "{result:?}"
        );
        assert_eq!(result.error_message, None);
        let content = result
            .content
            .iter()
            .filter_map(|part| match part {
                pa_ai::types::AssistantContent::Text(text) => Some(text.text.as_str()),
                pa_ai::types::AssistantContent::Thinking(_)
                | pa_ai::types::AssistantContent::ToolCall(_) => None,
            })
            .collect::<Vec<_>>();
        assert_eq!(content, vec!["Trusted"]);
        server.await.expect("TLS fixture completed");
        pa_ai::codex_debug::close_websocket_sessions(Some("fixture-first-wss"));
    })
    .await
    .expect("Codex WSS completes within the timeout");
}

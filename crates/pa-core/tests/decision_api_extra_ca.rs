//! Dedicated binary: the decision path's System One transport is the first
//! TLS client in this process, so the shared extra-CA bundle reads
//! `NODE_EXTRA_CA_CERTS` on its first build (the bundle state is
//! process-global and one-shot; a shared binary could not set the env var
//! in time).

use std::ffi::OsString;
use std::sync::Arc;

use pa_core::session_engine::decision_api::{resolve_decision_model, serve_decision_request};
use rcgen::{BasicConstraints, CertificateParams, IsCa, Issuer, KeyPair};
use serde_json::json;
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::net::TcpListener;
use tokio_rustls::rustls::pki_types::PrivateKeyDer;
use tokio_rustls::rustls::ServerConfig;
use tokio_rustls::TlsAcceptor;

/// Restores every touched environment variable on scope exit.
struct FixtureEnvironment(Vec<(&'static str, Option<OsString>)>);

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

/// Pin `NODE_EXTRA_CA_CERTS` to the bundle (the pa-models `ca_bundle_env`
/// recipe: the proxy and native-store env vars are pinned away so the loopback
/// handshake depends on the extra CA alone).
fn extra_ca_env(ca_pem: &str) -> (tempfile::NamedTempFile, FixtureEnvironment) {
    let bundle = tempfile::NamedTempFile::new().expect("ca bundle");
    std::fs::write(bundle.path(), ca_pem).expect("write ca bundle");
    let mut environment = Vec::new();
    for name in [
        "NODE_EXTRA_CA_CERTS",
        "SSL_CERT_FILE",
        "HTTP_PROXY",
        "http_proxy",
        "HTTPS_PROXY",
        "https_proxy",
        "ALL_PROXY",
        "all_proxy",
        "NO_PROXY",
        "no_proxy",
    ] {
        environment.push((name, std::env::var_os(name)));
    }
    for name in [
        "NODE_EXTRA_CA_CERTS",
        "SSL_CERT_FILE",
        "HTTP_PROXY",
        "http_proxy",
        "HTTPS_PROXY",
        "https_proxy",
        "ALL_PROXY",
        "all_proxy",
    ] {
        std::env::remove_var(name);
    }
    std::env::set_var("NODE_EXTRA_CA_CERTS", bundle.path());
    std::env::set_var("NO_PROXY", "127.0.0.1,localhost");
    std::env::set_var("no_proxy", "127.0.0.1,localhost");
    (bundle, FixtureEnvironment(environment))
}

/// One decision over the System One protocol against a loopback TLS endpoint
/// whose CA reaches the transport only through `NODE_EXTRA_CA_CERTS`: a bare
/// reqwest builder fails the handshake, the shared builder passes it (the
/// pa-models `custom_ca_extra_certs` recipe).
#[tokio::test]
async fn the_systemone_transport_trusts_node_extra_ca_certs() {
    let mut ca_params = CertificateParams::new(Vec::<String>::new()).expect("ca params");
    ca_params.is_ca = IsCa::Ca(BasicConstraints::Unconstrained);
    let ca_key = KeyPair::generate().expect("ca key");
    let ca_cert = ca_params.self_signed(&ca_key).expect("ca cert");
    let leaf_params = CertificateParams::new(vec!["127.0.0.1".to_string()]).expect("leaf params");
    let leaf_key = KeyPair::generate().expect("leaf key");
    let leaf_cert = leaf_params
        .signed_by(&leaf_key, &Issuer::from_params(&ca_params, &ca_key))
        .expect("leaf cert");
    let config = ServerConfig::builder()
        .with_no_client_auth()
        .with_single_cert(
            vec![leaf_cert.der().clone()],
            PrivateKeyDer::Pkcs8(leaf_key.serialize_der().into()),
        )
        .expect("tls config");
    let acceptor = TlsAcceptor::from(Arc::new(config));
    let listener = TcpListener::bind("127.0.0.1:0")
        .await
        .expect("bind tls server");
    let port = listener.local_addr().expect("tls address").port();
    let envelope = r#"{"model": "fixture-decisions/systemone-model", "answers": {"action": {"choice": "left", "confidence": 0.9, "probabilities": {"left": 0.9, "right": 0.1}}}}"#;
    let reply = format!(
        "HTTP/1.1 200 Status\r\ncontent-type: application/json\r\ncontent-length: {}\r\n\
         connection: close\r\n\r\n{envelope}",
        envelope.len()
    );
    let server = tokio::spawn(async move {
        let (socket, _) = listener.accept().await.expect("systemone connection");
        let mut stream = acceptor
            .accept(socket)
            .await
            .expect("custom-CA TLS handshake");
        let mut buffer = [0u8; 8_192];
        assert!(stream.read(&mut buffer).await.expect("systemone request") > 0);
        stream
            .write_all(reply.as_bytes())
            .await
            .expect("systemone reply");
        stream.flush().await.expect("systemone flush");
    });
    let _extra_ca = extra_ca_env(&ca_cert.pem());

    let dir = tempfile::tempdir().unwrap();
    std::fs::write(
        dir.path().join("settings.json"),
        json!({ "decisionApi": { "systemOneModel": "fixture-decisions/systemone-model" } })
            .to_string(),
    )
    .unwrap();
    std::fs::write(
        dir.path().join("models.json"),
        format!(
            r#"{{ "providers": {{ "fixture-decisions": {{
                "baseUrl": "https://127.0.0.1:{port}", "apiKey": "fixture-key",
                "api": "systemone", "models": [
                    {{ "id": "systemone-model", "input": ["text"] }}
                ]
            }} }} }}"#
        ),
    )
    .unwrap();
    let request = json!({ "state": {"observation": 1}, "questions": { "action": {
        "type": "choice", "criteria": {"left": "go left", "right": "go right"}
    } } });
    let resolved =
        resolve_decision_model(dir.path(), dir.path()).expect("the fixture decision model");
    let answer = serve_decision_request(request, &resolved)
        .await
        .expect("the systemone transport must trust NODE_EXTRA_CA_CERTS");
    assert_eq!(answer["answers"]["action"]["choice"], "left", "{answer}");
    server.await.expect("fixture completed");
}

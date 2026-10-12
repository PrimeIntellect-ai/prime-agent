//! A dedicated binary keeps the proxy's once-only CA cache isolated from other tests.

use std::sync::Arc;
use std::time::Duration;

use pa_agent::abort::AbortSignal;
use pa_agent::proxy::{stream_proxy, ProxyStreamOptions};
use pa_agent::stream::{LlmContext, ModelStream, StreamRequestOptions};
use pa_agent::types::{Model, StopReason};
use rcgen::{BasicConstraints, CertificateParams, IsCa, Issuer, KeyPair};
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::net::TcpListener;
use tokio_rustls::rustls::pki_types::PrivateKeyDer;
use tokio_rustls::rustls::ServerConfig;
use tokio_rustls::TlsAcceptor;

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
// Keep setup, the untrusted control, and the public-path assertion together so
// the single test binary owns every socket and environment mutation it creates.
#[allow(clippy::too_many_lines)]
async fn the_default_proxy_stream_honors_node_extra_ca_certs() {
    let mut ca_params = CertificateParams::new(Vec::<String>::new()).expect("CA params");
    ca_params.is_ca = IsCa::Ca(BasicConstraints::Unconstrained);
    let ca_key = KeyPair::generate().expect("CA key");
    let ca_cert = ca_params.self_signed(&ca_key).expect("CA cert");
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
        .expect("TLS config");
    let acceptor = TlsAcceptor::from(Arc::new(config));
    let listener = TcpListener::bind("127.0.0.1:0").await.expect("bind");
    let proxy_url = format!("https://{}", listener.local_addr().expect("address"));

    let server = tokio::spawn(async move {
        // The plain-client control must reject this CA, which is absent from
        // both the OS store and the bundled public roots.
        let (socket, _) = listener.accept().await.expect("control connection");
        assert!(acceptor.accept(socket).await.is_err());
        let (socket, _) = listener.accept().await.expect("proxy connection");
        let mut stream = acceptor.accept(socket).await.expect("proxy TLS handshake");
        let mut request = Vec::new();
        let mut buffer = [0; 4096];
        loop {
            let count = stream.read(&mut buffer).await.expect("request read");
            assert!(count > 0, "proxy closed before sending its request");
            request.extend_from_slice(&buffer[..count]);
            if let Some(end) = request.windows(4).position(|bytes| bytes == b"\r\n\r\n") {
                let headers = String::from_utf8_lossy(&request[..end]).to_ascii_lowercase();
                let length: usize = headers
                    .lines()
                    .find_map(|line| line.strip_prefix("content-length: "))
                    .expect("content length")
                    .parse()
                    .expect("numeric content length");
                if request.len() >= end + 4 + length {
                    assert!(headers.starts_with("post /api/stream http/1.1\r\n"));
                    assert!(headers
                        .lines()
                        .any(|line| line == "authorization: bearer fixture-token"));
                    break;
                }
            }
        }
        let sse = "data: {\"type\":\"start\"}\n\ndata: {\"type\":\"done\",\"reason\":\"stop\",\"usage\":{}}\n\n";
        let response = format!(
            "HTTP/1.1 200 OK\r\nContent-Type: text/event-stream\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{sse}",
            sse.len()
        );
        stream
            .write_all(response.as_bytes())
            .await
            .expect("response");
        stream.flush().await.expect("flush");
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
    // Exercise the real default client while keeping inherited corporate
    // proxies from sending this fixture's requests outside the loopback server.
    std::env::set_var("NO_PROXY", "127.0.0.1,localhost");
    std::env::set_var("no_proxy", "127.0.0.1,localhost");
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

    tokio::time::timeout(Duration::from_secs(10), async {
        let error = reqwest::Client::builder()
            .no_proxy()
            .build()
            .expect("plain client")
            .get(&proxy_url)
            .send()
            .await
            .expect_err("plain reqwest must reject the fixture CA");
        assert!(error.is_connect(), "control must fail during TLS: {error}");
        let model: Model = serde_json::from_value(serde_json::json!({
            "id": "fixture", "name": "Fixture", "api": "proxy", "provider": "proxy",
            "baseUrl": proxy_url, "reasoning": false, "contextWindow": 1000, "maxTokens": 100,
            "cost": {"input": 0, "output": 0, "cacheRead": 0, "cacheWrite": 0}
        }))
        .expect("model");
        let (_handle, mut events) = stream_proxy(
            model,
            LlmContext::default(),
            StreamRequestOptions::default(),
            ProxyStreamOptions {
                auth_token: "fixture-token".to_string(),
                proxy_url,
                signal: AbortSignal::never(),
            },
        );
        let result = events.result().await.expect("terminal event");
        assert_eq!(result.stop_reason, StopReason::Stop, "{result:?}");
        assert_eq!(result.error_message, None);
        server.await.expect("TLS fixture completed");
    })
    .await
    .expect("TLS proxy completes within the timeout");
}

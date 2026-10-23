//! Shared helpers for the integration verifiers: a scripted local HTTP
//! server that records every request head (headers included) and answers
//! from a queue of raw responses. Nothing leaves loopback.

// Different test binaries consume different subsets of the helpers.
#![allow(dead_code)]

use std::collections::VecDeque;
use std::sync::{Arc, Mutex};

use pa_models::fetch::{CatalogFetcher, FetchOutcome};
use rcgen::{BasicConstraints, CertificateParams, DnType, IsCa, Issuer, KeyPair};
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::net::TcpListener;
use tokio_rustls::rustls::pki_types::PrivateKeyDer;
use tokio_rustls::rustls::ServerConfig;
use tokio_rustls::TlsAcceptor;

type RequestLog = Arc<Mutex<Vec<String>>>;

pub struct MockServer {
    port: u16,
    requests: RequestLog,
    _handle: tokio::task::JoinHandle<()>,
}

impl MockServer {
    /// Start a server answering with `responses` in order; the last
    /// response repeats when the queue drains.
    pub async fn start(responses: Vec<Vec<u8>>) -> Self {
        Self::start_scripted(responses.into_iter().map(Scripted::Response).collect()).await
    }

    /// Start a server answering with `scripts` in order (raw, delayed, or
    /// held connections); the queue draining answers 500.
    pub async fn start_scripted(scripts: Vec<Scripted>) -> Self {
        let listener = TcpListener::bind("127.0.0.1:0")
            .await
            .expect("bind mock server");
        let port = listener.local_addr().unwrap().port();
        let requests: RequestLog = Arc::new(Mutex::new(Vec::new()));
        let responses: ResponseQueue = Arc::new(Mutex::new(VecDeque::from(scripts)));
        let handle = tokio::spawn(run(listener, Arc::clone(&requests), responses));
        Self {
            port,
            requests,
            _handle: handle,
        }
    }

    pub fn url(&self, path: &str) -> String {
        format!("http://127.0.0.1:{}{path}", self.port)
    }

    pub fn recorded_requests(&self) -> Vec<String> {
        self.requests.lock().unwrap().clone()
    }

    pub fn request_count(&self) -> usize {
        self.requests.lock().unwrap().len()
    }
}

type ResponseQueue = Arc<Mutex<VecDeque<Scripted>>>;

/// One scripted server behavior: raw bytes, raw bytes after a delay (a
/// slow fetch), or a held connection that never answers.
pub enum Scripted {
    Response(Vec<u8>),
    Delayed(Vec<u8>, std::time::Duration),
    Hang,
}

async fn run(listener: TcpListener, requests: RequestLog, responses: ResponseQueue) {
    loop {
        let Ok((mut socket, _)) = listener.accept().await else {
            return;
        };
        let requests = Arc::clone(&requests);
        let responses = Arc::clone(&responses);
        tokio::spawn(async move {
            let mut buffer = [0u8; 8_192];
            let mut read = 0usize;
            // Read until the end of the request head (GET bodies are empty).
            loop {
                let Ok(n) = socket.read(&mut buffer[read..]).await else {
                    return;
                };
                if n == 0 {
                    return;
                }
                read += n;
                if buffer[..read].windows(4).any(|w| w == b"\r\n\r\n") {
                    break;
                }
                if read == buffer.len() {
                    break;
                }
            }
            let head = String::from_utf8_lossy(&buffer[..read]).to_string();
            requests.lock().unwrap().push(head);
            let scripted = responses.lock().unwrap().pop_front().unwrap_or_else(|| {
                Scripted::Response(b"HTTP/1.1 500 Drained\r\ncontent-length: 0\r\n\r\n".to_vec())
            });
            match scripted {
                Scripted::Response(response) => {
                    let _ = socket.write_all(&response).await;
                    let _ = socket.flush().await;
                }
                Scripted::Delayed(response, delay) => {
                    tokio::time::sleep(delay).await;
                    let _ = socket.write_all(&response).await;
                    let _ = socket.flush().await;
                }
                // A held connection: the request records, the fetch never
                // settles (a caller's bounded wait must return first).
                Scripted::Hang => {
                    tokio::time::sleep(std::time::Duration::from_hours(1)).await;
                    let _ = socket.write_all(&[]).await;
                }
            }
        });
    }
}

/// Convenience builders for raw HTTP responses.
pub fn ok_json(body: impl AsRef<str>, etag: Option<&str>) -> Vec<u8> {
    let body = body.as_ref();
    let etag = etag
        .map(|etag| format!("etag: {etag}\r\n"))
        .unwrap_or_default();
    format!(
        "HTTP/1.1 200 OK\r\ncontent-type: application/json\r\ncontent-length: {}\r\n{etag}\r\n{body}",
        body.len()
    )
    .into_bytes()
}

pub fn not_modified() -> Vec<u8> {
    b"HTTP/1.1 304 Not Modified\r\ncontent-length: 0\r\n\r\n".to_vec()
}

pub fn status(status: u16, reason: &str) -> Vec<u8> {
    format!("HTTP/1.1 {status} {reason}\r\ncontent-length: 0\r\n\r\n").into_bytes()
}

pub fn redirect() -> Vec<u8> {
    b"HTTP/1.1 301 Moved Permanently\r\nlocation: https://elsewhere.example/catalog\r\ncontent-length: 0\r\n\r\n".to_vec()
}

/// 200 with a content-length header over the cap but an empty body.
pub fn oversized_header() -> Vec<u8> {
    b"HTTP/1.1 200 OK\r\ncontent-length: 999999999\r\n\r\n".to_vec()
}

/// 200 with a chunked body streamed past the cap (no content-length).
pub fn oversized_stream() -> Vec<u8> {
    let mut response = b"HTTP/1.1 200 OK\r\ntransfer-encoding: chunked\r\n\r\n".to_vec();
    let chunk = format!("{:x}\r\n", 1024 * 1024);
    response.extend_from_slice(chunk.as_bytes());
    // Heap, not stack: the 1 MiB chunk is fixture payload, identical bytes.
    response.extend_from_slice(&vec![b'a'; 1024 * 1024]);
    response.extend_from_slice(b"\r\n");
    response
}

pub const TLS_TEST_BODY: &str = "{\"schemaVersion\":1,\"models\":[]}";

pub struct TlsCatalogServer {
    pub base_url: String,
    pub ca_pem: String,
    pub task: tokio::task::JoinHandle<()>,
}

impl Drop for TlsCatalogServer {
    fn drop(&mut self) {
        // Also cancel the owned listener/socket if a client assertion panics
        // or the bounded fixture run times out.
        self.task.abort();
    }
}

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

pub async fn tls_catalog_server(connections: usize) -> TlsCatalogServer {
    let mut ca_params = CertificateParams::new(Vec::<String>::new()).expect("ca params");
    ca_params.is_ca = IsCa::Ca(BasicConstraints::Unconstrained);
    ca_params
        .distinguished_name
        .push(DnType::CommonName, "catalog test ca");
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
    let port = listener.local_addr().expect("tls addr").port();
    let response = ok_json(TLS_TEST_BODY, None);
    let task = tokio::spawn(async move {
        for _ in 0..connections {
            let (socket, _) = listener.accept().await.expect("catalog connection");
            let mut stream = acceptor
                .accept(socket)
                .await
                .expect("catalog TLS handshake");
            let mut buffer = [0u8; 8_192];
            assert!(stream.read(&mut buffer).await.expect("catalog request") > 0);
            stream.write_all(&response).await.expect("catalog response");
            stream.flush().await.expect("catalog flush");
        }
    });
    TlsCatalogServer {
        base_url: format!("https://127.0.0.1:{port}"),
        ca_pem: ca_cert.pem(),
        task,
    }
}

pub struct CaBundleEnv {
    bundle: tempfile::NamedTempFile,
    _environment: FixtureEnvironment,
}

impl CaBundleEnv {
    // The env var keeps pointing at the deleted path: the next native load
    // must fail to find the CA on its own.
    pub fn delete_bundle(&self) {
        std::fs::remove_file(self.bundle.path()).expect("delete ca bundle");
    }
}

pub fn ca_bundle_env(env_var: &str, ca_pem: &str) -> CaBundleEnv {
    let bundle = tempfile::NamedTempFile::new().expect("ca bundle");
    std::fs::write(bundle.path(), ca_pem).expect("write ca bundle");
    let environment = FixtureEnvironment(
        [
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
        ]
        .into_iter()
        .map(|name| (name, std::env::var_os(name)))
        .collect(),
    );
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
    std::env::set_var("NO_PROXY", "127.0.0.1,localhost");
    std::env::set_var("no_proxy", "127.0.0.1,localhost");
    std::env::set_var(env_var, bundle.path());
    CaBundleEnv {
        bundle,
        _environment: environment,
    }
}

pub async fn fetch_trusting_test_ca(env_var: &str) {
    let mut server = tls_catalog_server(1).await;
    let pem = if env_var == "NODE_EXTRA_CA_CERTS" {
        // Keep native-loader input pure; only Node extra-cert parsing retains a prefix.
        format!(
            "{}-----BEGIN CERTIFICATE-----\nAQID\n-----END CERTIFICATE-----\n",
            server.ca_pem
        )
    } else {
        server.ca_pem.clone()
    };
    let _ca_env = ca_bundle_env(env_var, &pem);
    tokio::time::timeout(std::time::Duration::from_secs(10), async {
        let fetcher = CatalogFetcher::new();
        let outcome = fetcher.fetch(&format!("{}/x", server.base_url), None).await;
        let FetchOutcome::Fresh { body, .. } = outcome.expect("fetch") else {
            panic!("expected a fresh body");
        };
        assert_eq!(body, TLS_TEST_BODY.as_bytes());
        (&mut server.task).await.expect("catalog fixture completed");
    })
    .await
    .expect("catalog TLS completes within the timeout");
}

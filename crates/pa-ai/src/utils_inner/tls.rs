use std::sync::{Arc, LazyLock};

use rustls::pki_types::pem::PemObject;
use rustls::pki_types::CertificateDer;

// The one TLS client configuration every HTTP and WebSocket client shares,
// built once per process (loading the OS trust store costs 75-85 ms on
// macOS). Trust set: the OS store (roots `RootCertStore` rejects are
// skipped), NODE_EXTRA_CA_CERTS, and the webpki roots. The ring provider is
// passed explicitly, so no process-default provider is ever installed.
static CLIENT_CONFIG: LazyLock<Arc<rustls::ClientConfig>> = LazyLock::new(|| {
    let mut roots = rustls::RootCertStore::empty();
    roots.add_parsable_certificates(rustls_native_certs::load_native_certs().certs);
    if let Some(path) = std::env::var_os("NODE_EXTRA_CA_CERTS") {
        let mut loaded = 0;
        let result = (|| -> anyhow::Result<()> {
            for cert in CertificateDer::pem_file_iter(&path)? {
                roots.add(cert?)?;
                loaded += 1;
            }
            anyhow::ensure!(loaded > 0, "empty CA bundle");
            Ok(())
        })();
        if let Err(error) = result {
            tracing::warn!(
                path = %path.display(),
                error = %error,
                "NODE_EXTRA_CA_CERTS could not be fully loaded; keeping certificates loaded before the error"
            );
        }
        // Node keeps the valid prefix and stops at the first PEM or DER error.
    }
    roots.extend(webpki_roots::TLS_SERVER_ROOTS.iter().cloned());
    Arc::new(
        rustls::ClientConfig::builder_with_provider(Arc::new(
            rustls::crypto::ring::default_provider(),
        ))
        .with_safe_default_protocol_versions()
        .expect("ring supports the default TLS versions")
        .with_root_certificates(roots)
        .with_no_client_auth(),
    )
});

/// A copy of the shared TLS configuration with `alpn` offered. reqwest uses a
/// preconfigured configuration as-is, so the caller picks the protocols its
/// client speaks.
pub(crate) fn tls_config(alpn: &[&[u8]]) -> rustls::ClientConfig {
    let mut config = rustls::ClientConfig::clone(&CLIENT_CONFIG);
    config.alpn_protocols = alpn.iter().map(|protocol| protocol.to_vec()).collect();
    config
}

/// A reqwest builder on the shared TLS configuration, offering HTTP/2 and
/// HTTP/1.1 over ALPN (reqwest's default for its own TLS).
pub fn http_client_builder() -> reqwest::ClientBuilder {
    reqwest::Client::builder().tls_backend_preconfigured(tls_config(&[b"h2", b"http/1.1"]))
}

/// The Codex WebSocket connector: the shared configuration, no ALPN.
pub(crate) fn websocket_connector() -> tokio_tungstenite::Connector {
    tokio_tungstenite::Connector::Rustls(Arc::clone(&CLIENT_CONFIG))
}

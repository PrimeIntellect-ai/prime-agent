use std::sync::{Arc, LazyLock};

use rustls::pki_types::pem::PemObject;
use rustls::pki_types::CertificateDer;

// The OS trust store, loaded once per process: reqwest reloads it on every
// `ClientBuilder::build`, which pays 75-85 ms per client on macOS. Keep only
// the roots `RootCertStore::add` accepts (reqwest's skip-invalid rule), so
// `add_root_certificate` below cannot fail the build on a real store's
// ancient certificates.
static NATIVE_CERTS: LazyLock<Vec<CertificateDer<'static>>> = LazyLock::new(|| {
    let mut roots = rustls::RootCertStore::empty();
    let mut certs = Vec::new();
    for cert in rustls_native_certs::load_native_certs().certs {
        if roots.add(cert.clone()).is_ok() {
            certs.push(cert);
        }
    }
    certs
});

static EXTRA_CERTS: LazyLock<Vec<CertificateDer<'static>>> = LazyLock::new(|| {
    let Some(path) = std::env::var_os("NODE_EXTRA_CA_CERTS") else {
        return Vec::new();
    };
    let mut certs = Vec::new();
    let loaded = (|| -> anyhow::Result<()> {
        let mut roots = rustls::RootCertStore::empty();
        for cert in CertificateDer::pem_file_iter(&path)? {
            let cert = cert?;
            roots.add(cert.clone())?;
            certs.push(cert);
        }
        anyhow::ensure!(!certs.is_empty(), "empty CA bundle");
        Ok(())
    })();
    if let Err(error) = loaded {
        tracing::warn!(
            path = %path.display(),
            error = %error,
            "NODE_EXTRA_CA_CERTS could not be fully loaded; keeping certificates loaded before the error"
        );
    }
    // Node keeps the valid prefix and stops at the first PEM or DER error.
    certs
});

/// # Panics
///
/// Never: every certificate below is a DER blob the root-store filter or
/// the PEM parser already accepted.
pub fn http_client_builder() -> reqwest::ClientBuilder {
    let mut builder = reqwest::Client::builder().tls_built_in_native_certs(false);
    for cert in &*NATIVE_CERTS {
        builder = builder.add_root_certificate(
            reqwest::Certificate::from_der(cert).expect("native CA certificate"),
        );
    }
    for cert in &*EXTRA_CERTS {
        builder = builder.add_root_certificate(
            reqwest::Certificate::from_der(cert).expect("extra CA certificate"),
        );
    }
    builder
}

static WS_CONFIG: LazyLock<Arc<rustls::ClientConfig>> = LazyLock::new(|| {
    let mut roots = rustls::RootCertStore::empty();
    roots.add_parsable_certificates(NATIVE_CERTS.iter().cloned());
    roots.add_parsable_certificates(EXTRA_CERTS.iter().cloned());
    roots.extend(webpki_roots::TLS_SERVER_ROOTS.iter().cloned());
    Arc::new(
        rustls::ClientConfig::builder()
            .with_root_certificates(roots)
            .with_no_client_auth(),
    )
});

pub(crate) fn websocket_connector() -> tokio_tungstenite::Connector {
    tokio_tungstenite::Connector::Rustls(Arc::clone(&WS_CONFIG))
}

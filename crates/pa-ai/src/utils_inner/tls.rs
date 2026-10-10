use std::sync::{Arc, LazyLock};

use rustls::pki_types::pem::PemObject;
use rustls::pki_types::CertificateDer;

static EXTRA_CERTS: LazyLock<Vec<CertificateDer<'static>>> = LazyLock::new(|| {
    let Some(path) = std::env::var_os("NODE_EXTRA_CA_CERTS") else {
        return Vec::new();
    };
    let certs: Result<Vec<_>, _> = CertificateDer::pem_file_iter(&path).and_then(Iterator::collect);
    match certs {
        Ok(certs)
            if !certs.is_empty()
                && certs
                    .iter()
                    .all(|cert| rustls::RootCertStore::empty().add(cert.clone()).is_ok()) =>
        {
            certs
        }
        _ => {
            tracing::warn!(
                path = %path.display(),
                "NODE_EXTRA_CA_CERTS could not be read as a PEM CA bundle; continuing without it"
            );
            Vec::new()
        }
    }
});

/// # Panics
///
/// Never: a DER certificate parsed from a PEM bundle is always accepted.
pub fn http_client_builder() -> reqwest::ClientBuilder {
    let mut builder = reqwest::Client::builder();
    for cert in &*EXTRA_CERTS {
        builder = builder.add_root_certificate(
            reqwest::Certificate::from_der(cert).expect("extra CA certificate"),
        );
    }
    builder
}

static WS_CONFIG: LazyLock<Arc<rustls::ClientConfig>> = LazyLock::new(|| {
    let mut roots = rustls::RootCertStore::empty();
    roots.add_parsable_certificates(rustls_native_certs::load_native_certs().certs);
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

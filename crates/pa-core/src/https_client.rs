//! The crate's HTTPS client construction: one seam through the shared
//! extra-CA TLS contract ([`pa_types::tls`]). Every TLS-terminated reqwest
//! client in this crate (update/release checks, trace upload, Prime
//! Inference auth and catalog, MCP connections) builds through it so
//! `NODE_EXTRA_CA_CERTS`/`SSL_CERT_FILE`/`SSL_CERT_DIR` trust internal
//! certificate authorities everywhere the app speaks HTTPS.

/// A reqwest client builder with the extra-CA TLS contract applied: when a
/// trust variable is set the builder is preconfigured with the extra-trust
/// rustls config (native roots plus the extras) carrying `alpn`'s
/// protocols — the shape these clients make reqwest offer today (this
/// crate builds no reqwest `http2` feature, so HTTP/1.1).
///
/// # Errors
///
/// Returns the loud, path-naming trust error when the trust variables name
/// a source that cannot be loaded.
pub(crate) fn https_client_builder(
    alpn: pa_types::tls::TlsAlpn,
) -> Result<reqwest::ClientBuilder, String> {
    let builder = reqwest::Client::builder();
    match pa_types::tls::extra_ca_client_config(alpn) {
        Ok(Some(config)) => Ok(builder.use_preconfigured_tls(config)),
        Ok(None) => Ok(builder),
        Err(error) => Err(error.to_string()),
    }
}

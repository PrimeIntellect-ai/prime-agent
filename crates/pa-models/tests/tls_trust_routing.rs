//! The catalog fetcher's extra-CA TLS routing pin, over the shared trust
//! contract: a trust variable naming an unloadable source fails the fetch
//! loud (naming the variable and the path) through the fetch's transport
//! error channel instead of dialing with today's trust. The variable is set
//! only around the synchronous construction, and this binary exists so the
//! pin never shares a process with the parallel cache-fetching lib tests.

use pa_models::fetch::{CatalogFetcher, FetchError};
use pa_types::tls::{EXTRA_CA_CERTS_ENV, SSL_CERT_DIR_ENV, SSL_CERT_FILE_ENV};

#[tokio::test]
async fn a_broken_trust_variable_fails_the_fetch_loud() {
    let snapshot = [
        std::env::var_os(EXTRA_CA_CERTS_ENV),
        std::env::var_os(SSL_CERT_FILE_ENV),
        std::env::var_os(SSL_CERT_DIR_ENV),
    ];
    std::env::set_var(EXTRA_CA_CERTS_ENV, "/nonexistent-extra-ca/extra-ca.pem");
    let fetcher = CatalogFetcher::new();
    let [extras, ssl_file, ssl_dir] = snapshot;
    for (variable, value) in [
        (EXTRA_CA_CERTS_ENV, extras),
        (SSL_CERT_FILE_ENV, ssl_file),
        (SSL_CERT_DIR_ENV, ssl_dir),
    ] {
        match value {
            Some(value) => std::env::set_var(variable, value),
            None => std::env::remove_var(variable),
        }
    }
    let error = fetcher
        .fetch("http://127.0.0.1:9/catalog.json", None)
        .await
        .expect_err("the broken trust variable fails the fetch");
    let FetchError::Transport { message } = &error else {
        panic!("the trust failure is a transport failure: {error}");
    };
    assert!(message.contains(EXTRA_CA_CERTS_ENV));
    assert!(message.contains("/nonexistent-extra-ca/extra-ca.pem"));
}

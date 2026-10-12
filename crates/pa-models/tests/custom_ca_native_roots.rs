// SSL_CERT_FILE is honored by the native loader on non-Apple Unix. Apple and
// Windows use system keystores; this fixture must never modify a real keystore.
#![cfg(all(target_family = "unix", not(target_vendor = "apple")))]

mod common;

#[tokio::test]
async fn ssl_cert_file_backs_the_unix_native_catalog_loader() {
    common::fetch_trusting_test_ca("SSL_CERT_FILE").await;
}

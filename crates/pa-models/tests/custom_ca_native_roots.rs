mod common;

#[tokio::test]
async fn the_os_trust_store_backs_the_catalog_fetch() {
    common::fetch_trusting_test_ca("SSL_CERT_FILE").await;
}

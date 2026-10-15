// Like custom_ca_native_roots.rs: the SSL_CERT_FILE loader is only a native
// loader on non-Apple Unix, so the fixture never touches a real keystore.
#![cfg(all(target_family = "unix", not(target_vendor = "apple")))]

mod common;

#[tokio::test]
async fn the_native_trust_store_is_read_once_per_process() {
    let mut server = common::tls_catalog_server(2).await;
    let ca_env = common::ca_bundle_env("SSL_CERT_FILE", &server.ca_pem);

    let fetcher = pa_models::fetch::CatalogFetcher::new();
    let pa_models::fetch::FetchOutcome::Fresh { body, .. } = fetcher
        .fetch(&format!("{}/x", server.base_url), None)
        .await
        .expect("catalog fetch")
    else {
        panic!("expected a fresh body");
    };
    assert_eq!(body, common::TLS_TEST_BODY.as_bytes());

    // The env var stays set while the bundle it points at disappears: only a
    // process-cached root set can still trust the second client below.
    ca_env.delete_bundle();
    let client = pa_ai::utils::tls::http_client_builder()
        .build()
        .expect("plain client");
    let response = client
        .get(format!("{}/y", server.base_url))
        .send()
        .await
        .expect("plain client GET after the bundle is gone");
    assert_eq!(response.status().as_u16(), 200);
    assert_eq!(
        response.text().await.expect("plain client body"),
        common::TLS_TEST_BODY
    );

    (&mut server.task).await.expect("catalog fixture completed");
}

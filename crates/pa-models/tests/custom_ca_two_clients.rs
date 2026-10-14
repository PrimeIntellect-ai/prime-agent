// Like custom_ca_native_roots.rs: the SSL_CERT_FILE loader is only a native
// loader on non-Apple Unix, so the fixture never touches a real keystore.
#![cfg(all(target_family = "unix", not(target_vendor = "apple")))]

mod common;

#[tokio::test]
async fn two_clients_in_one_process_trust_the_ssl_cert_file_ca() {
    let mut server = common::tls_catalog_server(2).await;
    let _ca_env = common::ca_bundle_env("SSL_CERT_FILE", &server.ca_pem);

    let fetcher = pa_models::fetch::CatalogFetcher::new();
    let pa_models::fetch::FetchOutcome::Fresh { body, .. } = fetcher
        .fetch(&format!("{}/x", server.base_url), None)
        .await
        .expect("catalog fetch")
    else {
        panic!("expected a fresh body");
    };
    assert_eq!(body, common::TLS_TEST_BODY.as_bytes());

    let client = pa_ai::utils::tls::http_client_builder()
        .build()
        .expect("plain client");
    let response = client
        .get(format!("{}/y", server.base_url))
        .send()
        .await
        .expect("plain client GET");
    assert_eq!(response.status().as_u16(), 200);
    assert_eq!(
        response.text().await.expect("plain client body"),
        common::TLS_TEST_BODY
    );

    (&mut server.task).await.expect("catalog fixture completed");
}

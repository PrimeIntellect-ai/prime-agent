//! Fetch-layer verifiers over a scripted local HTTP server: timeout
//! bounds, the 8 MiB cap (header AND streaming), redirect refusal, ETag
//! round-trip, and the 304 path.

mod common;

use common::{not_modified, ok_json, redirect, status};
use pa_models::fetch::{CatalogFetcher, FetchOutcome};
use std::time::Duration;

#[tokio::test]
async fn serves_200_bodies_with_etags_and_sends_catalog_headers() {
    let server = common::MockServer::start(vec![ok_json(
        "{\"schemaVersion\":1,\"models\":[]}".into(),
        Some("\"v-1\""),
    )])
    .await;
    let fetcher = CatalogFetcher::new();
    let url = server.url("/models/catalog.v1.json");
    let outcome = fetcher.fetch(&url, None).await.expect("fresh");
    let FetchOutcome::Fresh { body, etag } = outcome else {
        panic!("expected fresh body");
    };
    assert_eq!(body, b"{\"schemaVersion\":1,\"models\":[]}");
    assert_eq!(etag.as_deref(), Some("\"v-1\""));

    let recorded = &server.recorded_requests()[0];
    assert!(
        recorded.contains("GET /models/catalog.v1.json HTTP/1.1"),
        "{recorded}"
    );
    assert!(recorded.contains("accept: application/json"), "{recorded}");
    assert!(recorded.contains("cache-control: no-cache"), "{recorded}");

    // With a cached etag, the request carries If-None-Match and a 304 maps
    // to NotModified.
    let server2 = common::MockServer::start(vec![not_modified()]).await;
    let outcome = fetcher
        .fetch(&server2.url("/models/catalog.v1.json"), Some("\"v-1\""))
        .await
        .expect("outcome");
    assert!(matches!(outcome, FetchOutcome::NotModified));
    assert!(
        server2.recorded_requests()[0].contains("if-none-match: \"v-1\""),
        "etag echoed"
    );
}

#[tokio::test]
async fn redirects_are_refused() {
    let server = common::MockServer::start(vec![redirect()]).await;
    let fetcher = CatalogFetcher::new();
    let error = fetcher
        .fetch(&server.url("/models/catalog.v1.json"), None)
        .await
        .expect_err("redirect refused");
    assert!(error.status().is_none(), "redirects are transport errors");
}

#[tokio::test]
async fn non_success_statuses_surface_with_their_code() {
    let server = common::MockServer::start(vec![status(404, "Not Found")]).await;
    let fetcher = CatalogFetcher::new();
    let error = fetcher
        .fetch(&server.url("/x"), None)
        .await
        .expect_err("status error");
    assert_eq!(error.status(), Some(404));
    let server = common::MockServer::start(vec![status(401, "Unauthorized")]).await;
    let error = fetcher
        .fetch(&server.url("/x"), None)
        .await
        .expect_err("status");
    assert_eq!(error.status(), Some(401));
}

#[tokio::test]
async fn content_length_over_the_cap_fails_before_reading() {
    let server = common::MockServer::start(vec![common::oversized_header()]).await;
    let fetcher = CatalogFetcher::new();
    assert!(fetcher.fetch(&server.url("/x"), None).await.is_err());
}

#[tokio::test]
async fn streamed_bodies_past_the_cap_fail_mid_read() {
    let server = common::MockServer::start(vec![common::oversized_stream()]).await;
    let fetcher = CatalogFetcher::with_limits(Duration::from_secs(5), 64 * 1024);
    let error = fetcher
        .fetch(&server.url("/x"), None)
        .await
        .expect_err("stream cap enforced");
    assert!(error.status().is_none(), "transport failure, not a status");
}

#[tokio::test]
async fn hard_timeout_aborts_unresponsive_servers() {
    // A server that accepts but never answers: the 5s timeout would make the
    // test slow, so bound the same policy with a short explicit limit.
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let port = listener.local_addr().unwrap().port();
    tokio::spawn(async move {
        loop {
            let Ok((_socket, _)) = listener.accept().await else {
                return;
            };
            // Accept and hang: the request never completes.
        }
    });
    let fetcher = CatalogFetcher::with_limits(Duration::from_millis(300), 1024);
    let started = std::time::Instant::now();
    let error = fetcher
        .fetch(&format!("http://127.0.0.1:{port}/x"), None)
        .await
        .expect_err("timeout");
    assert!(error.status().is_none());
    assert!(started.elapsed() < Duration::from_secs(2), "hard abort");
}

#[tokio::test]
async fn connection_failures_are_transport_errors() {
    // Bind then close: nothing listens on this port anymore.
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let port = listener.local_addr().unwrap().port();
    drop(listener);
    let fetcher = CatalogFetcher::new();
    let error = fetcher
        .fetch(&format!("http://127.0.0.1:{port}/x"), None)
        .await
        .expect_err("connection refused");
    assert!(error.status().is_none());
}

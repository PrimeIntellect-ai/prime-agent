//! The Prime Inference `/models` fetch: the private-authorization flow's
//! HTTP layer. The payload's parse and model build live in the catalog crate
//! (`pa_models::prime_inference`), shared with the public routes.

use std::collections::HashMap;

const MAX_RESPONSE_BYTES: usize = 2 * 1024 * 1024;

/// Fetch the live `/models` payload (timeout-capped, 2 MiB cap). `base_url`
/// is the Prime Inference API base (production: [`super::prime_inference
/// ::PRIME_INFERENCE_BASE_URL`]; tests pass a local server through the
/// shared catalog's seam).
///
/// # Errors
///
/// Human-readable error: the request failed, or the body is not JSON.
pub(crate) async fn fetch_prime_inference_model_catalog(
    base_url: &str,
    headers: Option<&HashMap<String, String>>,
    timeout_ms: u64,
) -> Result<serde_json::Value, String> {
    let client = pa_ai::utils::tls::http_client_builder()
        .timeout(std::time::Duration::from_millis(timeout_ms))
        .build()
        .map_err(|error| error.to_string())?;
    let mut request = client
        .get(format!("{base_url}/models"))
        .header("accept", "application/json");
    if let Some(headers) = headers {
        for (name, value) in headers {
            request = request.header(name, value);
        }
    }
    let mut response = request.send().await.map_err(|error| error.to_string())?;
    let status = response.status();
    if !status.is_success() {
        return Err(format!(
            "Prime Inference model catalog request failed with status {status}"
        ));
    }
    let mut bytes = Vec::new();
    while let Some(chunk) = response.chunk().await.map_err(|error| error.to_string())? {
        if chunk.len() > MAX_RESPONSE_BYTES - bytes.len() {
            return Err("Response is too large".to_string());
        }
        bytes.extend_from_slice(&chunk);
    }
    serde_json::from_slice(&bytes).map_err(|error| error.to_string())
}

#[cfg(test)]
mod tests {
    use super::*;
    use tokio::io::{AsyncReadExt, AsyncWriteExt};

    async fn oversized_stalled_catalog(chunked: bool) -> (String, tokio::task::JoinHandle<()>) {
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let base = format!("http://{}", listener.local_addr().unwrap());
        let server = tokio::spawn(async move {
            let (mut socket, _) = listener.accept().await.unwrap();
            let mut request = [0u8; 4096];
            assert!(socket.read(&mut request).await.unwrap() > 0);
            let body = vec![b'x'; MAX_RESPONSE_BYTES + 1];
            let headers = if chunked {
                "HTTP/1.1 200 OK\r\nTransfer-Encoding: chunked\r\nConnection: close\r\n\r\n"
                    .to_string()
            } else {
                format!(
                    "HTTP/1.1 200 OK\r\nContent-Length: {}\r\nConnection: close\r\n\r\n",
                    body.len() + 1
                )
            };
            socket.write_all(headers.as_bytes()).await.unwrap();
            if chunked {
                socket
                    .write_all(format!("{:x}\r\n", body.len()).as_bytes())
                    .await
                    .unwrap();
            }
            socket.write_all(&body).await.unwrap();
            if chunked {
                socket.write_all(b"\r\n").await.unwrap();
            }
            tokio::time::sleep(std::time::Duration::from_secs(5)).await;
        });
        (base, server)
    }

    #[tokio::test]
    async fn catalog_rejects_oversized_length_response_before_peer_finishes() {
        let (base, server) = oversized_stalled_catalog(false).await;
        let result = tokio::time::timeout(
            std::time::Duration::from_secs(2),
            fetch_prime_inference_model_catalog(&base, None, 30_000),
        )
        .await
        .expect("oversized catalog should fail before the peer closes");
        server.abort();
        assert_eq!(result, Err("Response is too large".to_string()));
    }

    #[tokio::test]
    async fn catalog_rejects_oversized_chunked_response_before_peer_finishes() {
        let (base, server) = oversized_stalled_catalog(true).await;
        let result = tokio::time::timeout(
            std::time::Duration::from_secs(2),
            fetch_prime_inference_model_catalog(&base, None, 30_000),
        )
        .await
        .expect("oversized catalog should fail before the peer closes");
        server.abort();
        assert_eq!(result, Err("Response is too large".to_string()));
    }

    #[tokio::test]
    async fn catalog_keeps_valid_json_response() {
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let base = format!("http://{}", listener.local_addr().unwrap());
        let server = tokio::spawn(async move {
            let (mut socket, _) = listener.accept().await.unwrap();
            let mut request = [0u8; 4096];
            assert!(socket.read(&mut request).await.unwrap() > 0);
            socket
                .write_all(
                    b"HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nContent-Length: 11\r\n\r\n{\"data\":[]}",
                )
                .await
                .unwrap();
        });
        let payload = fetch_prime_inference_model_catalog(&base, None, 30_000)
            .await
            .unwrap();
        server.await.unwrap();
        assert_eq!(payload, serde_json::json!({"data": []}));
    }
}

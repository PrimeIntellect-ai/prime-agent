//! The Anthropic login's localhost callback server (TS
//! `anthropic.ts`'s `startCallbackServer` + `oauth-page.ts`): one
//! listener on the registered redirect port serving the callback
//! route with the product's success/error pages. Only a matching
//! redirect settles the login — an OAuth error response, a missing
//! code or state, or an unknown route answers its page and keeps
//! waiting (TS calls `settleWait` on success only). A bind failure is
//! a hard error (TS rejects the server promise and the login fails);
//! the Codex callback keeps its own listener on its own port.

use std::sync::Arc;

use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::net::TcpListener;

/// `PI_OAUTH_CALLBACK_HOST` (TS `CALLBACK_HOST`, default `127.0.0.1`).
pub(crate) const CALLBACK_HOST_ENV: &str = "PI_OAUTH_CALLBACK_HOST";

/// The registered redirect: `http://localhost:53692/callback` (TS
/// `REDIRECT_URI`; the port is the registration's, not a scan range).
pub(crate) const CALLBACK_PORT: u16 = 53_692;
pub(crate) const CALLBACK_PATH: &str = "/callback";
/// TS `REDIRECT_URI` (the exchange's `redirect_uri` in every path).
pub(crate) const REDIRECT_URI: &str = "http://localhost:53692/callback";

/// The authorization code plus the echoed `state` from the browser
/// redirect (TS settles both).
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct CallbackCode {
    pub code: String,
    pub state: String,
}

/// Settled once per login; the first settle wins.
#[derive(Default, Debug)]
struct CallbackShared {
    result: tokio::sync::Mutex<Option<Option<CallbackCode>>>,
    notify: tokio::sync::Notify,
}

impl CallbackShared {
    async fn settle(&self, result: Option<CallbackCode>) {
        let mut slot = self.result.lock().await;
        if slot.is_none() {
            *slot = Some(result);
            drop(slot);
            // `notify_one` stores a permit when no waiter is registered
            // yet, so a wait that checked the empty slot just before the
            // settle still wakes on its first poll — `notify_waiters`
            // would miss that window and hang the wait forever.
            self.notify.notify_one();
        }
    }
}

/// A running callback server.
///
/// Dropping the server aborts its accept loop, releasing the
/// listener's port — a settled or cancelled login never wedges the
/// registered redirect port for the next one.
#[derive(Debug)]
pub struct AnthropicCallbackServer {
    shared: Arc<CallbackShared>,
    #[cfg(test)]
    port: u16,
    task: Option<tokio::task::JoinHandle<()>>,
}

impl Drop for AnthropicCallbackServer {
    fn drop(&mut self) {
        if let Some(task) = self.task.take() {
            task.abort();
        }
    }
}

impl AnthropicCallbackServer {
    /// Bind the registered redirect port on the callback host (TS
    /// `server.listen(CALLBACK_PORT, CALLBACK_HOST)`); a bind failure
    /// is the login's hard error (TS rejects the server promise).
    ///
    /// # Errors
    ///
    /// Returns an error when the listener cannot be bound.
    pub async fn start(state: &str) -> Result<Self, String> {
        let host = std::env::var(CALLBACK_HOST_ENV).unwrap_or_else(|_| "127.0.0.1".to_string());
        Self::bind(&host, CALLBACK_PORT, state).await
    }

    /// Bind one exact host and port; the caller owns the failure
    /// (tests pick free ports).
    ///
    /// # Errors
    ///
    /// Returns an error when the listener cannot be bound.
    pub async fn bind(host: &str, port: u16, state: &str) -> Result<Self, String> {
        let listener = TcpListener::bind((host, port))
            .await
            .map_err(|error| format!("port {port}: {error}"))?;
        #[cfg(test)]
        let bound_port = listener.local_addr().map_or(port, |addr| addr.port());
        let shared = Arc::new(CallbackShared::default());
        let task_shared = Arc::clone(&shared);
        let state = state.to_string();
        let task = tokio::spawn(async move {
            loop {
                let Ok((stream, _)) = listener.accept().await else {
                    break;
                };
                let shared = Arc::clone(&task_shared);
                let state = state.clone();
                tokio::spawn(async move {
                    serve_callback(stream, &shared, &state).await;
                });
            }
        });
        Ok(AnthropicCallbackServer {
            shared,
            #[cfg(test)]
            port: bound_port,
            task: Some(task),
        })
    }

    /// The bound port (tests pick free ports and read the listener's).
    #[cfg(test)]
    pub fn port(&self) -> u16 {
        self.port
    }

    /// Cancel: settle the waiter with `None` (TS `cancelWait`; the
    /// tests drive the cancellation path).
    #[cfg(test)]
    pub async fn cancel(&self) {
        self.shared.settle(None).await;
    }

    /// Wait for the browser redirect to settle: the code and state,
    /// or `None` when the wait was cancelled.
    pub async fn wait_for_code(&self) -> Option<CallbackCode> {
        loop {
            if let Some(result) = self.shared.result.lock().await.take() {
                return result;
            }
            self.shared.notify.notified().await;
        }
    }
}

/// One browser request: read it, answer it, settle the login only on a
/// matching redirect (TS the callback handler's validation order —
/// route, the OAuth error response, missing parameters, state).
async fn serve_callback(mut stream: tokio::net::TcpStream, shared: &CallbackShared, state: &str) {
    let Some(request) = read_request_head(&mut stream).await else {
        let _ = write_response(
            &mut stream,
            "400 Bad Request",
            error_page("Callback route not found.", None),
        )
        .await;
        return;
    };
    let target = request
        .lines()
        .next()
        .unwrap_or_default()
        .split_whitespace()
        .nth(1)
        .unwrap_or_default();
    let path = target.split('?').next().unwrap_or_default();
    if path != CALLBACK_PATH {
        let _ = write_response(
            &mut stream,
            "404 Not Found",
            error_page("Callback route not found.", None),
        )
        .await;
        return;
    }
    let query = target.split_once('?').map_or("", |(_, query)| query);
    // TS checks the OAuth error response before the parameters: the
    // provider answered, the login did not complete.
    if let Some(error) = query_param(query, "error") {
        let _ = write_response(
            &mut stream,
            "400 Bad Request",
            error_page(
                "Anthropic authentication did not complete.",
                Some(&format!("Error: {error}")),
            ),
        )
        .await;
        return;
    }
    let (code, echoed) = match (query_param(query, "code"), query_param(query, "state")) {
        (Some(code), Some(echoed)) if !code.is_empty() => (code, echoed),
        _ => {
            let _ = write_response(
                &mut stream,
                "400 Bad Request",
                error_page("Missing code or state parameter.", None),
            )
            .await;
            return;
        }
    };
    if echoed != state {
        let _ = write_response(
            &mut stream,
            "400 Bad Request",
            error_page("State mismatch.", None),
        )
        .await;
        return;
    }
    shared
        .settle(Some(CallbackCode {
            code,
            state: echoed,
        }))
        .await;
    let _ = write_response(
        &mut stream,
        "200 OK",
        success_page("Anthropic authentication completed. You can close this window."),
    )
    .await;
}

/// Read one request head (accumulating until the blank line — a
/// fragmented browser request parses the same as a whole one; the
/// callback request carries no body worth reading past it).
async fn read_request_head(stream: &mut tokio::net::TcpStream) -> Option<String> {
    let mut head = Vec::with_capacity(1024);
    let mut buffer = [0u8; 8192];
    loop {
        if head.windows(4).any(|window| window == b"\r\n\r\n") {
            return Some(String::from_utf8_lossy(&head).to_string());
        }
        if head.len() >= buffer.len() {
            // An oversized head: parse what arrived (the handler's route
            // checks reject it).
            return Some(String::from_utf8_lossy(&head).to_string());
        }
        let read = stream.read(&mut buffer).await.ok()?;
        if read == 0 {
            return None;
        }
        head.extend_from_slice(&buffer[..read]);
    }
}

async fn write_response(
    stream: &mut tokio::net::TcpStream,
    status: &str,
    body: String,
) -> std::io::Result<()> {
    let head = format!(
        "HTTP/1.1 {status}\r\nContent-Type: text/html; charset=utf-8\r\nContent-Length: {}\r\nConnection: close\r\n\r\n",
        body.len()
    );
    stream.write_all(head.as_bytes()).await?;
    stream.write_all(body.as_bytes()).await?;
    stream.flush().await
}

/// One decoded query parameter (`+` as space, percent-decoded).
fn query_param(query: &str, name: &str) -> Option<String> {
    for pair in query.split('&') {
        if pair.is_empty() {
            continue;
        }
        let (key, value) = pair.split_once('=').unwrap_or((pair, ""));
        if percent_decode(&key.replace('+', " ")) == name {
            return Some(percent_decode(&value.replace('+', " ")));
        }
    }
    None
}

fn percent_decode(value: &str) -> String {
    let bytes = value.as_bytes();
    let mut out = Vec::with_capacity(bytes.len());
    let mut index = 0;
    while index < bytes.len() {
        if bytes[index] == b'%' && index + 2 < bytes.len() {
            if let Ok(byte) = u8::from_str_radix(&value[index + 1..index + 3], 16) {
                out.push(byte);
                index += 3;
                continue;
            }
        }
        out.push(bytes[index]);
        index += 1;
    }
    String::from_utf8_lossy(&out).to_string()
}

fn escape_html(value: &str) -> String {
    let mut out = String::with_capacity(value.len());
    for character in value.chars() {
        match character {
            '&' => out.push_str("&amp;"),
            '<' => out.push_str("&lt;"),
            '>' => out.push_str("&gt;"),
            '"' => out.push_str("&quot;"),
            '\'' => out.push_str("&#39;"),
            other => out.push(other),
        }
    }
    out
}

/// The callback pages: a dark minimal page carrying the login's
/// outcome (the port's page shape; the TS flow's own wording rides
/// the messages and the error details).
fn render_page(title: &str, message: &str, details: Option<&str>) -> String {
    let details_html = details
        .map(|details| {
            format!(
                r#"    <div class="details">{}</div>
"#,
                escape_html(details)
            )
        })
        .unwrap_or_default();
    format!(
        r#"<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>{}</title>
  <style>
    body {{ margin: 0; min-height: 100vh; display: flex; align-items: center;
           justify-content: center; padding: 24px; background: #000; color: #fff;
           font-family: ui-sans-serif, system-ui, sans-serif; text-align: center; }}
    main {{ width: 100%; max-width: 560px; }}
    h1 {{ margin: 0 0 10px; font-size: 28px; line-height: 1.15; font-weight: 650; }}
    p {{ margin: 0; line-height: 1.7; color: #a1a1aa; font-size: 15px; }}
    .details {{ margin-top: 16px; font-family: ui-monospace, monospace; font-size: 13px;
                color: #a1a1aa; white-space: pre-wrap; word-break: break-word; }}
  </style>
</head>
<body>
  <main>
    <h1>Authentication</h1>
    <p>{}</p>
{}
  </main>
</body>
</html>"#,
        escape_html(title),
        escape_html(message),
        details_html
    )
}

fn success_page(message: &str) -> String {
    render_page("Prime Agent authentication completed", message, None)
}

fn error_page(message: &str, details: Option<&str>) -> String {
    render_page("Prime Agent authentication failed", message, details)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::time::Duration;

    /// One live server on a free loopback port, with its port.
    async fn live(state: &str) -> (AnthropicCallbackServer, u16) {
        let server = AnthropicCallbackServer::bind("127.0.0.1", 0, state)
            .await
            .expect("a free loopback port binds");
        let port = server.port();
        (server, port)
    }

    /// One raw browser request and its whole response.
    async fn request(port: u16, target: &str) -> String {
        use tokio::io::AsyncReadExt as _;
        let mut stream = tokio::net::TcpStream::connect(("127.0.0.1", port))
            .await
            .expect("the callback server accepts the connection");
        stream
            .write_all(format!("GET {target} HTTP/1.1\r\nHost: localhost\r\n\r\n").as_bytes())
            .await
            .expect("the request writes");
        let mut response = String::new();
        let mut buffer = [0u8; 4096];
        loop {
            let read = stream.read(&mut buffer).await.unwrap_or(0);
            if read == 0 {
                break;
            }
            response.push_str(&String::from_utf8_lossy(&buffer[..read]));
            if response.contains("</html>") {
                break;
            }
        }
        response
    }

    #[tokio::test]
    async fn a_matching_redirect_settles_the_code_and_state() {
        let (server, port) = live("the-state").await;
        let response = request(port, "/callback?code=the-code&state=the-state").await;
        assert!(response.starts_with("HTTP/1.1 200 OK"));
        assert!(response.contains("Anthropic authentication completed"));
        assert_eq!(
            server.wait_for_code().await,
            Some(CallbackCode {
                code: "the-code".to_string(),
                state: "the-state".to_string(),
            })
        );
    }

    #[tokio::test]
    async fn an_error_response_answers_its_page_and_keeps_waiting() {
        let (server, port) = live("the-state").await;
        let response = request(port, "/callback?error=access_denied").await;
        assert!(response.starts_with("HTTP/1.1 400 Bad Request"));
        assert!(response.contains("Anthropic authentication did not complete"));
        assert!(response.contains("Error: access_denied"));
        // A non-matching response never settles the login (TS calls
        // settleWait on success only); cancellation does.
        server.cancel().await;
        assert!(server.wait_for_code().await.is_none());
    }

    #[tokio::test]
    async fn missing_parameters_and_state_mismatch_never_settle() {
        let (server, port) = live("the-state").await;
        let missing = request(port, "/callback?code=the-code").await;
        assert!(missing.starts_with("HTTP/1.1 400 Bad Request"));
        assert!(missing.contains("Missing code or state parameter."));
        let mismatch = request(port, "/callback?code=the-code&state=other").await;
        assert!(mismatch.starts_with("HTTP/1.1 400 Bad Request"));
        assert!(mismatch.contains("State mismatch."));
        let unknown = request(port, "/other?code=the-code&state=the-state").await;
        assert!(unknown.starts_with("HTTP/1.1 404 Not Found"));
        assert!(unknown.contains("Callback route not found."));
        server.cancel().await;
        assert!(server.wait_for_code().await.is_none());
    }

    #[tokio::test]
    async fn a_bound_port_fails_the_start_clearly() {
        // The registered port is occupied, so the login fails (TS
        // rejects the server promise). Skip when a concurrent test
        // already holds the port.
        let Ok(blocker) = std::net::TcpListener::bind(("127.0.0.1", CALLBACK_PORT)) else {
            return;
        };
        let error = AnthropicCallbackServer::start("the-state")
            .await
            .unwrap_err();
        assert!(error.contains("Could not start"), "{error}");
        drop(blocker);
    }

    /// The missed-notification regression: a settle landing between the
    /// wait's empty-slot check and its `notified` registration still
    /// wakes — the settle's stored permit (`notify_one`) completes the
    /// future's first poll. With a `notify_waiters` settle this wait
    /// would hang and the bound fails the test.
    #[tokio::test]
    async fn a_settle_in_the_registration_window_still_wakes() {
        let server = AnthropicCallbackServer::bind("127.0.0.1", 0, "the-state")
            .await
            .expect("a free loopback port binds");
        let shared = &server.shared;
        // The settle lands before the wait registers: the stored permit
        // must wake it.
        shared
            .settle(Some(CallbackCode {
                code: "the-code".to_string(),
                state: "the-state".to_string(),
            }))
            .await;
        let result = tokio::time::timeout(Duration::from_secs(2), server.wait_for_code())
            .await
            .expect("the stored permit wakes the first poll")
            .expect("the settle settled a code");
        assert_eq!(result.code, "the-code");
    }

    #[test]
    fn query_and_percent_decoding() {
        assert_eq!(percent_decode("a%20b"), "a b");
        assert_eq!(
            query_param("code=a+b&state=2", "code"),
            Some("a b".to_string())
        );
        assert_eq!(query_param("code&state=2", "code"), None);
    }
}

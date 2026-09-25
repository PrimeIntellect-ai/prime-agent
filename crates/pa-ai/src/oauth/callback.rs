//! The Codex login's localhost callback server (TS
//! `openai-codex.ts`'s `startLocalOAuthServer` + `oauth-page.ts`): one
//! listener on the app registration's redirect port serving the
//! callback route with the product's success/error pages. Only a
//! matching redirect settles the login — a state mismatch, a missing
//! code, or an unknown route answers its error page and keeps waiting
//! (TS calls `settleWait` on success only). A bind failure is not an
//! error: TS resolves a server whose wait settles empty, so the login
//! continues on the manual paste.

use std::sync::Arc;

use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::net::TcpListener;

/// `PI_OAUTH_CALLBACK_HOST` (TS `CALLBACK_HOST`, default `127.0.0.1`).
pub(crate) const CALLBACK_HOST_ENV: &str = "PI_OAUTH_CALLBACK_HOST";

/// The app registration's redirect: `http://localhost:1455/auth/callback`
/// (TS `REDIRECT_URI`; the port is the registration's, not a scan range).
const CALLBACK_PORT: u16 = 1455;
const CALLBACK_PATH: &str = "/auth/callback";

/// The authorization code the browser redirect carries.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct CallbackCode {
    pub code: String,
}

/// Settled once per login; the first settle wins.
#[derive(Default)]
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
            self.notify.notify_waiters();
        }
    }
}

/// A running callback server. A `None` slot is the never-bound server
/// (TS's bind-error branch): its wait settles empty immediately.
///
/// Dropping the server aborts its accept loop, releasing the listener's
/// port — a settled or cancelled login never wedges the registered
/// redirect port for the next one.
pub struct CodexCallbackServer {
    shared: Option<Arc<CallbackShared>>,
    port: Option<u16>,
    task: Option<tokio::task::JoinHandle<()>>,
}

impl Drop for CodexCallbackServer {
    fn drop(&mut self) {
        if let Some(task) = self.task.take() {
            task.abort();
        }
    }
}

impl CodexCallbackServer {
    /// Bind the registered redirect port on the callback host (TS
    /// `server.listen(1455, CALLBACK_HOST)`); a bind failure leaves the
    /// dead server (TS's error branch resolves the same shape).
    pub async fn start(state: &str) -> Self {
        let host = std::env::var(CALLBACK_HOST_ENV).unwrap_or_else(|_| "127.0.0.1".to_string());
        Self::bind(&host, CALLBACK_PORT, state)
            .await
            .unwrap_or_else(|_| CodexCallbackServer::dead())
    }

    /// Bind one exact host and port; the caller owns the failure (tests
    /// and embedded hosts pick free ports).
    ///
    /// # Errors
    ///
    /// Returns an error when the listener cannot be bound.
    pub async fn bind(host: &str, port: u16, state: &str) -> Result<Self, String> {
        let listener = TcpListener::bind((host, port))
            .await
            .map_err(|error| format!("port {port}: {error}"))?;
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
        Ok(CodexCallbackServer {
            shared: Some(shared),
            port: Some(bound_port),
            task: Some(task),
        })
    }

    /// The never-bound server: its wait settles empty (the login's
    /// manual paste is the remaining path).
    pub fn dead() -> Self {
        CodexCallbackServer {
            shared: None,
            port: None,
            task: None,
        }
    }

    /// The bound port (`None` on the dead server).
    pub fn port(&self) -> Option<u16> {
        self.port
    }

    /// Wait for the browser redirect to settle: the code, or `None`
    /// when the wait was cancelled.
    pub async fn wait_for_code(&self) -> Option<CallbackCode> {
        let shared = self.shared.as_ref()?;
        loop {
            if let Some(result) = shared.result.lock().await.take() {
                return result;
            }
            shared.notify.notified().await;
        }
    }

    /// Cancel: settle the waiter with `None` (TS `cancelWait`).
    pub async fn cancel(&self) {
        if let Some(shared) = &self.shared {
            shared.settle(None).await;
        }
    }
}

/// One browser request: read it, answer it, settle the login only on a
/// matching redirect (TS the callback handler's validation order —
/// route, state, code).
async fn serve_callback(mut stream: tokio::net::TcpStream, shared: &CallbackShared, state: &str) {
    let Some(request) = read_request_head(&mut stream).await else {
        let _ = write_response(
            &mut stream,
            "400 Bad Request",
            error_page("Callback route not found."),
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
            error_page("Callback route not found."),
        )
        .await;
        return;
    }
    let query = target.split_once('?').map_or("", |(_, query)| query);
    let code = query_param(query, "code");
    if query_param(query, "state").as_deref() != Some(state) {
        let _ = write_response(
            &mut stream,
            "400 Bad Request",
            error_page("State mismatch."),
        )
        .await;
        return;
    }
    match code {
        Some(code) if !code.is_empty() => {
            shared.settle(Some(CallbackCode { code })).await;
            let _ = write_response(
                &mut stream,
                "200 OK",
                success_page("OpenAI authentication completed. You can close this window."),
            )
            .await;
        }
        _ => {
            let _ = write_response(
                &mut stream,
                "400 Bad Request",
                error_page("Missing authorization code."),
            )
            .await;
        }
    }
}

/// Read one request head (until the connection goes quiet); the
/// callback browser request carries no body worth parsing.
async fn read_request_head(stream: &mut tokio::net::TcpStream) -> Option<String> {
    let mut buffer = [0u8; 8192];
    let read = stream.read(&mut buffer).await.ok()?;
    if read == 0 {
        return None;
    }
    Some(String::from_utf8_lossy(&buffer[..read]).to_string())
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

/// The callback pages: a dark minimal page carrying the login's outcome
/// (the port's page shape; the TS flow's own wording rides the
/// messages).
fn render_page(title: &str, message: &str) -> String {
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
  </style>
</head>
<body>
  <main>
    <h1>Authentication</h1>
    <p>{}</p>
  </main>
</body>
</html>"#,
        escape_html(title),
        escape_html(message)
    )
}

fn success_page(message: &str) -> String {
    render_page("Prime Agent authentication completed", message)
}

fn error_page(message: &str) -> String {
    render_page("Prime Agent authentication failed", message)
}

#[cfg(test)]
mod tests {
    use super::*;

    /// One live server on a free loopback port, with its port.
    async fn live(state: &str) -> (CodexCallbackServer, u16) {
        let server = CodexCallbackServer::bind("127.0.0.1", 0, state)
            .await
            .expect("a free loopback port binds");
        let port = server.port().expect("a bound server carries its port");
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
    async fn a_matching_redirect_settles_the_code() {
        let (server, port) = live("the-state").await;
        let response = request(port, "/auth/callback?code=the-code&state=the-state").await;
        assert!(response.starts_with("HTTP/1.1 200 OK"), "{response}");
        assert!(
            response.contains("OpenAI authentication completed. You can close this window."),
            "{response}"
        );
        assert_eq!(
            server.wait_for_code().await,
            Some(CallbackCode {
                code: "the-code".to_string()
            })
        );
    }

    #[tokio::test]
    async fn a_state_mismatch_answers_and_keeps_waiting() {
        let (server, port) = live("the-state").await;
        let response = request(port, "/auth/callback?code=c&state=other").await;
        assert!(
            response.starts_with("HTTP/1.1 400 Bad Request"),
            "{response}"
        );
        assert!(response.contains("State mismatch."), "{response}");
        // A mismatch never settles the login; cancellation does.
        server.cancel().await;
        assert_eq!(server.wait_for_code().await, None);
    }

    #[tokio::test]
    async fn a_missing_code_answers_and_keeps_waiting() {
        let (server, port) = live("the-state").await;
        let response = request(port, "/auth/callback?state=the-state").await;
        assert!(
            response.starts_with("HTTP/1.1 400 Bad Request"),
            "{response}"
        );
        assert!(
            response.contains("Missing authorization code."),
            "{response}"
        );
        server.cancel().await;
        assert_eq!(server.wait_for_code().await, None);
    }

    #[tokio::test]
    async fn an_unknown_route_answers_404_without_settling() {
        let (server, port) = live("the-state").await;
        let response = request(port, "/other?code=c&state=the-state").await;
        assert!(response.starts_with("HTTP/1.1 404 Not Found"), "{response}");
        assert!(response.contains("Callback route not found."), "{response}");
        server.cancel().await;
        assert_eq!(server.wait_for_code().await, None);
    }

    #[tokio::test]
    async fn the_dead_server_settles_empty_immediately() {
        let server = CodexCallbackServer::dead();
        assert_eq!(server.port(), None);
        assert_eq!(server.wait_for_code().await, None);
    }

    #[tokio::test]
    async fn an_unbindable_port_yields_the_error() {
        let held = std::net::TcpListener::bind(("127.0.0.1", 0)).expect("a probe port");
        let port = held.local_addr().unwrap().port();
        assert!(CodexCallbackServer::bind("127.0.0.1", port, "s")
            .await
            .is_err());
    }

    #[test]
    fn query_and_percent_decoding() {
        assert_eq!(percent_decode("a%20b"), "a b");
        assert_eq!(percent_decode("bad%2"), "bad%2");
        assert_eq!(
            query_param("code=1&state=2", "state"),
            Some("2".to_string())
        );
        assert_eq!(query_param("code=a+b", "code"), Some("a b".to_string()));
        assert_eq!(query_param("code", "state"), None);
    }

    #[test]
    fn the_pages_escape_their_text() {
        let page = error_page("<script>&\"'</script>");
        assert!(page.contains("<script>&amp;&quot;&#39;"), "{page}");
        assert!(!page.contains("<script>"), "{page}");
    }
}

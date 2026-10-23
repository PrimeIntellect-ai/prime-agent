//! The local OAuth callback server: one fresh listener per candidate port on the registered
//! redirect ports; the login flow races the browser callback against a manual paste. The served
//! pages keep the TS product's success/error wording.

use std::future::Future;
use std::pin::Pin;
use std::sync::{Arc, Mutex};

use anyhow::{anyhow, bail, Result};
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::net::TcpListener;

/// `PI_OAUTH_CALLBACK_HOST` (default `127.0.0.1`).
fn callback_host() -> String {
    std::env::var("PI_OAUTH_CALLBACK_HOST").unwrap_or_else(|_| "127.0.0.1".to_string())
}

/// A range (not one port) so a leaked or concurrent login cannot wedge all logins with one occupied
/// socket. Distinct from the Anthropic callback port (53692).
const CALLBACK_PORT_BASE: u16 = 53_700;
const CALLBACK_PORT_COUNT: u16 = 10;
const CALLBACK_PATH: &str = "/callback";

fn redirect_uri_for(port: u16) -> String {
    format!("http://localhost:{port}{CALLBACK_PATH}")
}

pub(super) fn validate_callback_port(callback_port: Option<u16>) -> Result<()> {
    if callback_port == Some(0) {
        bail!("OAuth callbackPort must be between 1 and 65535");
    }
    Ok(())
}

fn candidate_ports(callback_port: Option<u16>) -> Result<Vec<u16>> {
    validate_callback_port(callback_port)?;
    Ok(match callback_port {
        Some(port) => vec![port],
        None => (0..CALLBACK_PORT_COUNT)
            .map(|offset| CALLBACK_PORT_BASE + offset)
            .collect(),
    })
}

/// Every redirect URI a login registers (dynamic client registration
/// offers them all).
pub fn redirect_uris(callback_port: Option<u16>) -> Result<Vec<String>> {
    Ok(candidate_ports(callback_port)?
        .into_iter()
        .map(redirect_uri_for)
        .collect())
}

/// The authorization code plus the echoed `state` from the browser
/// redirect.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct CallbackCode {
    pub code: String,
    pub state: String,
}

/// What a login waits for: [`Some`] code from the browser redirect, or `None` when the callback
/// settled without one.
pub type CallbackResult = Option<CallbackCode>;

/// Settled once per login; the first settle wins.
#[derive(Default, Debug)]
struct CallbackShared {
    result: tokio::sync::Mutex<Option<CallbackResult>>,
    notify: tokio::sync::Notify,
}

impl CallbackShared {
    async fn settle(&self, result: CallbackResult) {
        let mut slot = self.result.lock().await;
        if slot.is_none() {
            *slot = Some(result);
            drop(slot);
            self.notify.notify_waiters();
        }
    }
}

/// A running callback server: its redirect URI plus the settled result.
#[derive(Debug)]
pub struct CallbackServer {
    shared: Arc<CallbackShared>,
    port: u16,
    // The task only borrows the socket while polling accept. The owner can close it
    // synchronously even when the runtime has not polled an aborted task yet.
    listener: Arc<Mutex<Option<TcpListener>>>,
    listener_task: Mutex<Option<tokio::task::JoinHandle<()>>>,
}

impl CallbackServer {
    /// Bind a registered port exactly, or the first free DCR candidate. Never substitute
    /// an unregistered redirect port when the registered one is occupied.
    pub async fn start(label: &str, callback_port: Option<u16>) -> Result<Self> {
        let host = callback_host();
        let mut last_error: Option<String> = None;
        for port in candidate_ports(callback_port)? {
            let listener = match TcpListener::bind((host.as_str(), port)).await {
                Ok(listener) => listener,
                Err(error) => {
                    last_error = Some(format!("port {port}: {error}"));
                    continue;
                }
            };
            let shared = Arc::new(CallbackShared::default());
            let task_shared = Arc::clone(&shared);
            let listener = Arc::new(Mutex::new(Some(listener)));
            let task_listener = Arc::clone(&listener);
            let listener_task = tokio::spawn(async move {
                loop {
                    let accepted = futures::future::poll_fn(|cx| {
                        let slot = task_listener.lock().unwrap();
                        match slot.as_ref() {
                            Some(listener) => listener.poll_accept(cx).map(Some),
                            None => std::task::Poll::Ready(None),
                        }
                    })
                    .await;
                    let Some(Ok((stream, _))) = accepted else {
                        break;
                    };
                    let shared = Arc::clone(&task_shared);
                    tokio::spawn(async move {
                        serve_callback(stream, &shared).await;
                    });
                }
            });
            return Ok(CallbackServer {
                shared,
                port,
                listener,
                listener_task: Mutex::new(Some(listener_task)),
            });
        }
        if let Some(port) = callback_port {
            return Err(anyhow!(
                "Could not start the OAuth callback server on registered port {port}. \
                 Close other login attempts and retry. ({label}; {})",
                last_error.unwrap_or_default(),
            ));
        }
        Err(anyhow!(
            "Could not start the OAuth callback server: ports {CALLBACK_PORT_BASE}-{} are all in use. \
             Close other login attempts and retry. ({label}; {})",
            CALLBACK_PORT_BASE + CALLBACK_PORT_COUNT - 1,
            last_error.unwrap_or_else(|| "no candidate port bound".to_string()),
        ))
    }

    /// The local URL the authorization redirect must land on.
    pub fn redirect_uri(&self) -> String {
        redirect_uri_for(self.port)
    }

    /// Wait for the browser callback to settle.
    pub async fn wait_for_code(&self) -> CallbackResult {
        loop {
            if let Some(result) = self.shared.result.lock().await.take() {
                return result;
            }
            self.shared.notify.notified().await;
        }
    }

    /// Race a browser callback against manual input. The input future must settle the callback
    /// (through cancellation) before completing; its outcome remains available to the caller.
    pub async fn wait_for_code_or_input<F: Future + ?Sized>(
        &self,
        input: Pin<&mut F>,
    ) -> (CallbackResult, Option<F::Output>) {
        tokio::select! {
            code = self.wait_for_code() => (code, None),
            outcome = input => {
                // Input cancellation may have lost settle() to an earlier browser redirect.
                // Read that result even when fair select polls the input branch first.
                (self.wait_for_code().await, Some(outcome))
            },
        }
    }

    /// Cancel: settle the waiter with `None` so an in-flight redirect loses
    /// only because the caller chose to stop waiting.
    pub async fn cancel(&self) {
        self.listener.lock().unwrap().take();
        self.shared.settle(None).await;
        let task = self.listener_task.lock().unwrap().take();
        if let Some(task) = task {
            task.abort();
            // Join cancellation so the listener task cannot outlive explicit cleanup.
            let _ = task.await;
        }
    }
}

impl Drop for CallbackServer {
    fn drop(&mut self) {
        self.listener.lock().unwrap().take();
        if let Some(task) = self.listener_task.get_mut().unwrap().take() {
            task.abort();
        }
    }
}

/// One browser request: read it, answer it, settle the login's waiter.
async fn serve_callback(mut stream: tokio::net::TcpStream, shared: &CallbackShared) {
    let Some(request) = read_request_head(&mut stream).await else {
        let _ = write_response(
            &mut stream,
            "400 Bad Request",
            oauth_error_page("Prime Agent", "Callback route not found."),
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
        .unwrap_or_default()
        .to_string();
    let path = target.split('?').next().unwrap_or_default();
    if path != CALLBACK_PATH {
        let _ = write_response(
            &mut stream,
            "404 Not Found",
            oauth_error_page("Prime Agent", "Callback route not found."),
        )
        .await;
        return;
    }
    let query = target.split_once('?').map_or("", |(_, query)| query);
    let code = query_param(query, "code");
    let state = query_param(query, "state");
    let error = query_param(query, "error");
    if let Some(error) = error {
        shared.settle(None).await;
        let _ = write_response(
            &mut stream,
            "400 Bad Request",
            oauth_error_page(
                "Prime Agent",
                &format!("Prime Agent authentication failed. Error: {error}"),
            ),
        )
        .await;
        return;
    }
    match (code, state) {
        (Some(code), Some(state)) if !code.is_empty() && !state.is_empty() => {
            shared.settle(Some(CallbackCode { code, state })).await;
            let _ = write_response(
                &mut stream,
                "200 OK",
                oauth_success_page(
                    "Prime Agent authentication completed. You can close this window.",
                ),
            )
            .await;
        }
        _ => {
            shared.settle(None).await;
            let _ = write_response(
                &mut stream,
                "400 Bad Request",
                oauth_error_page("Prime Agent", "Missing code or state parameter."),
            )
            .await;
        }
    }
}

/// Read one request head (until the connection goes quiet); the callback
/// browser request carries no body worth parsing.
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

/// The callback pages: a dark minimal page carrying the login's outcome.
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
        escape_html(message),
    )
}

fn oauth_success_page(message: &str) -> String {
    render_page("Prime Agent authentication completed", message)
}

fn oauth_error_page(label: &str, message: &str) -> String {
    render_page(&format!("{label} authentication failed"), message)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test]
    async fn settled_browser_code_survives_ready_input_after_listener_exit() {
        // An accept loop can exit while a previously accepted request is still completing.
        // Complete listener cleanup first so input cancellation will not yield on a join.
        for _ in 0..64 {
            let server = CallbackServer::start("Slack", /*callback_port*/ None)
                .await
                .unwrap();
            let task = server.listener_task.lock().unwrap().take().unwrap();
            task.abort();
            assert!(task.await.unwrap_err().is_cancelled());
            let browser_code = CallbackCode {
                code: "browser-code".to_string(),
                state: "state".to_string(),
            };
            server.shared.settle(Some(browser_code.clone())).await;
            let mut input = Box::pin(async {
                server.cancel().await;
            });
            let (code, _) = server.wait_for_code_or_input(input.as_mut()).await;
            assert_eq!(
                code,
                Some(browser_code),
                "the browser settled before input cancellation"
            );
        }
    }

    #[tokio::test]
    async fn dropping_a_registered_callback_releases_the_port_without_yielding() {
        let reservation = std::net::TcpListener::bind(("127.0.0.1", 0)).unwrap();
        let port = reservation.local_addr().unwrap().port();
        drop(reservation);
        let server = CallbackServer::start("Slack", Some(port)).await.unwrap();
        drop(server);
        let rebound = std::net::TcpListener::bind(("127.0.0.1", port))
            .expect("dropping the callback must release its registered port immediately");
        drop(rebound);
    }

    #[tokio::test]
    async fn registered_port_is_exact_and_released_after_cancel() {
        let blocker = std::net::TcpListener::bind(("127.0.0.1", 0)).unwrap();
        let port = blocker.local_addr().unwrap().port();
        let error = CallbackServer::start("Slack", Some(port))
            .await
            .unwrap_err();
        assert!(error
            .to_string()
            .contains(&format!("registered port {port}")));
        drop(blocker);
        let server = CallbackServer::start("Slack", Some(port)).await.unwrap();
        assert_eq!(
            server.redirect_uri(),
            format!("http://localhost:{port}/callback")
        );
        let response = reqwest::Client::new()
            .get(format!(
                "http://127.0.0.1:{port}/callback?code=code&state=state"
            ))
            .send()
            .await
            .unwrap();
        assert_eq!(response.status(), reqwest::StatusCode::OK);
        assert_eq!(
            server.wait_for_code().await,
            Some(CallbackCode {
                code: "code".to_string(),
                state: "state".to_string(),
            })
        );
        server.cancel().await;
        let rebound = std::net::TcpListener::bind(("127.0.0.1", port)).unwrap();
        drop(rebound);
    }

    #[tokio::test]
    async fn falls_back_to_the_next_free_port() {
        // The base port is occupied, so the login lands on a later candidate (a leaked login
        // cannot wedge all of them). Skip when a concurrent test already holds the base port.
        let Ok(blocker) = std::net::TcpListener::bind(("127.0.0.1", CALLBACK_PORT_BASE)) else {
            return;
        };
        let server = CallbackServer::start("Linear", /*callback_port*/ None)
            .await
            .unwrap();
        assert_ne!(server.redirect_uri(), redirect_uri_for(CALLBACK_PORT_BASE));
        assert!(server.redirect_uri().starts_with("http://localhost:5370"));
        drop(blocker);
    }

    #[tokio::test]
    async fn callback_flow_settles_code_and_state() {
        let server = CallbackServer::start("Linear", /*callback_port*/ None)
            .await
            .unwrap();
        let response = reqwest::Client::new()
            .get(format!(
                "http://127.0.0.1:{}/callback?code=the-code&state=the-state",
                server.port
            ))
            .send()
            .await
            .unwrap();
        assert_eq!(response.status().as_u16(), 200);
        assert_eq!(
            server.wait_for_code().await,
            Some(CallbackCode {
                code: "the-code".to_string(),
                state: "the-state".to_string()
            })
        );
    }

    #[tokio::test]
    async fn error_callback_settles_none() {
        let server = CallbackServer::start("Linear", /*callback_port*/ None)
            .await
            .unwrap();
        let response = reqwest::Client::new()
            .get(format!(
                "http://127.0.0.1:{}/callback?error=access_denied",
                server.port
            ))
            .send()
            .await
            .unwrap();
        assert_eq!(response.status().as_u16(), 400);
        assert!(server.wait_for_code().await.is_none());
    }

    #[tokio::test]
    async fn unknown_route_is_404_without_settling() {
        let server = CallbackServer::start("Linear", /*callback_port*/ None)
            .await
            .unwrap();
        let response = reqwest::Client::new()
            .get(format!("http://127.0.0.1:{}/other", server.port))
            .send()
            .await
            .unwrap();
        assert_eq!(response.status().as_u16(), 404);
        // Unknown routes never settle the login; cancellation does.
        server.cancel().await;
        assert!(server.wait_for_code().await.is_none());
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
    #[tokio::test]
    async fn zero_callback_port_is_rejected_before_binding_or_registration() {
        assert!(redirect_uris(Some(0))
            .unwrap_err()
            .to_string()
            .contains("callbackPort"));
        let error = CallbackServer::start("fixture", Some(0)).await.unwrap_err();
        assert!(error.to_string().contains("callbackPort"));
    }

    #[tokio::test]
    async fn pinned_port_rebinds_after_drop() {
        let probe = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
        let port = probe.local_addr().unwrap().port();
        drop(probe);
        {
            let first = CallbackServer::start("Linear", Some(port)).await.unwrap();
            assert_eq!(first.redirect_uri(), redirect_uri_for(port));
        }
        tokio::task::yield_now().await;
        let second = CallbackServer::start("Linear", Some(port)).await.unwrap();
        assert_eq!(second.redirect_uri(), redirect_uri_for(port));
    }
}

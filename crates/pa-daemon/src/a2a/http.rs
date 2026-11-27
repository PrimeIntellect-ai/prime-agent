//! Every route but the agent card needs a client's bearer token. `Origin` is
//! refused (no browser client, no CORS), and a loopback bind refuses a
//! foreign `Host` (DNS rebinding).

use std::collections::{BTreeMap, HashMap};
use std::sync::Arc;

use futures::StreamExt as _;
use http_body_util::combinators::BoxBody;
use http_body_util::{BodyExt as _, Full, Limited, StreamBody};
use hyper::body::{Bytes, Frame, Incoming};
use hyper::{Method, Request, Response, StatusCode};
use serde_json::{json, Value};
use tokio::sync::broadcast;

use super::jsonrpc::{self, A2aError};
use super::server::{Reply, Server};
use super::types::{StreamResponse, Task};

pub(crate) const INPUT_MODE: &str = "text/plain";
pub(crate) const OUTPUT_MODE: &str = "text/markdown";
const CARD_PATH: &str = "/.well-known/agent-card.json";
const MAX_BODY_BYTES: usize = 4 * 1024 * 1024;

type Body = BoxBody<Bytes, std::io::Error>;

/// Serve forever; a failed accept backs off and retries.
pub(crate) async fn serve(
    listener: tokio::net::TcpListener,
    server: Arc<Server>,
    clients: Clients,
    product_version: String,
    public_url: Option<String>,
) -> anyhow::Result<()> {
    let loopback = listener.local_addr()?.ip().is_loopback();
    let public_authority = public_url.as_deref().map(|url| {
        let rest = url.split_once("://").map_or(url, |(_, rest)| rest);
        rest.split('/').next().unwrap_or_default().to_string()
    });
    let gate = Arc::new(Gate {
        clients,
        loopback,
        product_version,
        public_url,
        public_authority,
    });
    loop {
        let tcp = match listener.accept().await {
            Ok((tcp, _)) => tcp,
            Err(error) => {
                // Out of descriptors and the like: back off instead of
                // spinning, the server recovers when sockets free up.
                eprintln!("a2a: accept failed: {error}");
                tokio::time::sleep(std::time::Duration::from_millis(100)).await;
                continue;
            }
        };
        let server = Arc::clone(&server);
        let gate = Arc::clone(&gate);
        tokio::spawn(async move {
            let service = hyper::service::service_fn(move |request| {
                handle(request, Arc::clone(&server), Arc::clone(&gate))
            });
            // The timer enables hyper's header-read timeout, so a peer that
            // never finishes its request head cannot hold the connection.
            if let Err(error) = hyper::server::conn::http1::Builder::new()
                .timer(hyper_util::rt::TokioTimer::new())
                .serve_connection(hyper_util::rt::TokioIo::new(tcp), service)
                .await
            {
                eprintln!("a2a: connection error: {error}");
            }
        });
    }
}

/// The accepted bearer tokens by SHA-256 digest, each naming its client:
/// a lookup by digest leaks nothing about a token through timing.
pub(crate) struct Clients(HashMap<[u8; 32], String>);

impl Clients {
    /// Refuses an empty set, an empty token, and a token two clients share
    /// (it could not name one client).
    pub(crate) fn new(tokens: &BTreeMap<String, String>) -> anyhow::Result<Self> {
        anyhow::ensure!(!tokens.is_empty(), "no A2A clients are configured");
        let mut clients = HashMap::new();
        for (client, token) in tokens {
            anyhow::ensure!(
                !token.trim().is_empty(),
                "the A2A client {client:?} has an empty token"
            );
            if let Some(other) = clients.insert(digest(token.trim()), client.clone()) {
                anyhow::bail!("the A2A clients {other:?} and {client:?} share a token");
            }
        }
        Ok(Self(clients))
    }

    /// The client an `Authorization` header authenticates.
    fn authenticate(&self, authorization: &str) -> Option<&str> {
        let (scheme, token) = authorization.split_once(' ')?;
        if !scheme.eq_ignore_ascii_case("bearer") {
            return None;
        }
        self.0.get(&digest(token.trim())).map(String::as_str)
    }
}

struct Gate {
    clients: Clients,
    loopback: bool,
    product_version: String,
    /// The public URL of a TLS front (`--a2a-public-url`), and its
    /// authority: the one non-loopback `Host` a loopback bind accepts.
    public_url: Option<String>,
    public_authority: Option<String>,
}

async fn handle(
    request: Request<Incoming>,
    server: Arc<Server>,
    gate: Arc<Gate>,
) -> Result<Response<Body>, hyper::Error> {
    let headers = request.headers();
    let header = |name: hyper::header::HeaderName| {
        headers
            .get(name)
            .and_then(|value| value.to_str().ok())
            .unwrap_or_default()
            .to_string()
    };
    let host = header(hyper::header::HOST);
    let public_host = gate
        .public_authority
        .as_deref()
        .is_some_and(|authority| authority.eq_ignore_ascii_case(&host));
    if headers.contains_key(hyper::header::ORIGIN)
        || (gate.loopback && !public_host && !is_loopback_host(&host))
    {
        return Ok(plain(StatusCode::FORBIDDEN, "forbidden"));
    }
    if request.method() == Method::GET && request.uri().path() == CARD_PATH {
        let url = gate
            .public_url
            .clone()
            .unwrap_or_else(|| format!("http://{host}/"));
        return Ok(card_response(
            &url,
            &gate.product_version,
            &header(hyper::header::IF_NONE_MATCH),
        ));
    }
    let Some(client) = gate
        .clients
        .authenticate(&header(hyper::header::AUTHORIZATION))
    else {
        let mut response = plain(StatusCode::UNAUTHORIZED, "unauthorized");
        response.headers_mut().insert(
            "www-authenticate",
            hyper::header::HeaderValue::from_static("Bearer"),
        );
        return Ok(response);
    };
    if request.method() != Method::POST || request.uri().path() != "/" {
        return Ok(plain(StatusCode::NOT_FOUND, "not found"));
    }
    let content_type = header(hyper::header::CONTENT_TYPE);
    let version = Some(header(hyper::header::HeaderName::from_static(
        "a2a-version",
    )))
    .filter(|version| !version.is_empty())
    .or_else(|| {
        request.uri().query().and_then(|query| {
            query
                .split('&')
                .find_map(|pair| pair.strip_prefix("A2A-Version="))
                .map(str::to_string)
        })
    })
    .unwrap_or_default();
    let Ok(body) = Limited::new(request.into_body(), MAX_BODY_BYTES)
        .collect()
        .await
    else {
        return Ok(plain(
            StatusCode::PAYLOAD_TOO_LARGE,
            "request body too large",
        ));
    };
    let Ok(body) = serde_json::from_slice::<Value>(&body.to_bytes()) else {
        return Ok(json_response(&jsonrpc::error_response(
            &Value::Null,
            jsonrpc::PARSE_ERROR,
            "Invalid JSON payload",
            None,
        )));
    };
    let request = match jsonrpc::parse_request(&body) {
        Ok(request) => request,
        Err(reply) => return Ok(json_response(&reply)),
    };
    let media_type = content_type.split(';').next().unwrap_or_default().trim();
    if !media_type.eq_ignore_ascii_case("application/json") {
        return Ok(json_response(&jsonrpc::a2a_error(
            &request.id,
            A2aError::ContentTypeNotSupported,
            Some(json!({ "supported": "application/json" })),
        )));
    }
    // A missing version means 0.3, which is not served.
    let mut parts = version.split('.');
    if (parts.next(), parts.next()) != (Some("1"), Some("0")) {
        return Ok(json_response(&jsonrpc::a2a_error(
            &request.id,
            A2aError::VersionNotSupported,
            Some(json!({ "supported": "1.0" })),
        )));
    }
    Ok(match server.dispatch(request, client).await {
        Reply::Json(reply) => json_response(&reply),
        Reply::Stream(id, first, frames) => Response::builder()
            .header("content-type", "text/event-stream")
            .header("cache-control", "no-cache")
            .body(sse_body(id, &first, frames))
            .expect("static response"),
    })
}

/// The SSE body: the first frame, then the live frames until the terminal
/// status. A subscriber that fell too far behind gets one error frame
/// instead of a clean end, so a cut stream never reads as finished.
fn sse_body(id: Value, first: &Task, frames: broadcast::Receiver<StreamResponse>) -> Body {
    let first = sse_line(&jsonrpc::response(&id, &json!({ "task": first })));
    let live = futures::stream::unfold(Some(frames), move |frames| {
        let id = id.clone();
        async move {
            let mut frames = frames?;
            let (envelope, next) = match frames.recv().await {
                Ok(frame) => {
                    let terminal = matches!(&frame, StreamResponse::StatusUpdate(update) if update.status.state.is_terminal());
                    (
                        jsonrpc::response(&id, &to_json(&frame)),
                        (!terminal).then_some(frames),
                    )
                }
                Err(broadcast::error::RecvError::Lagged(_)) => (
                    jsonrpc::error_response(
                        &id,
                        jsonrpc::INTERNAL_ERROR,
                        "the stream fell behind and was closed; read the task with GetTask",
                        None,
                    ),
                    None,
                ),
                Err(broadcast::error::RecvError::Closed) => return None,
            };
            Some((Ok(Frame::data(sse_line(&envelope))), next))
        }
    });
    http_body_util::BodyExt::boxed(StreamBody::new(
        futures::stream::once(std::future::ready(Ok(Frame::data(first)))).chain(live),
    ))
}

fn sse_line(envelope: &Value) -> Bytes {
    format!("data: {envelope}\n\n").into()
}

fn to_json(frame: &StreamResponse) -> Value {
    serde_json::to_value(frame).expect("wire types serialize")
}

/// Whether a `Host` header names this machine: a loopback name or address,
/// optionally with a numeric port.
fn is_loopback_host(host: &str) -> bool {
    let (name, port) = match host.strip_prefix('[') {
        Some(rest) => match rest.split_once(']') {
            Some((name, "")) => (name, None),
            Some((name, tail)) => (name, Some(tail.strip_prefix(':').unwrap_or(tail))),
            None => return false,
        },
        None => match host.rsplit_once(':') {
            Some((name, port)) => (name, Some(port)),
            None => (host, None),
        },
    };
    port.is_none_or(|port| !port.is_empty() && port.bytes().all(|byte| byte.is_ascii_digit()))
        && (name.eq_ignore_ascii_case("localhost")
            || name
                .parse::<std::net::IpAddr>()
                .is_ok_and(|ip| ip.is_loopback()))
}

fn digest(value: &str) -> [u8; 32] {
    use sha2::{Digest as _, Sha256};
    Sha256::digest(value.as_bytes()).into()
}

fn agent_card(url: &str, product_version: &str) -> Value {
    json!({
        "name": "Prime Agent",
        "description": "A general-purpose coding and research agent driven over A2A.",
        "supportedInterfaces": [{
            "url": url,
            "protocolBinding": "JSONRPC",
            "protocolVersion": "1.0",
        }],
        "version": product_version,
        "capabilities": {
            "streaming": true,
            "pushNotifications": false,
            "extendedAgentCard": false,
        },
        "securitySchemes": {
            "bearer": { "httpAuthSecurityScheme": { "scheme": "Bearer" } },
        },
        "securityRequirements": [{ "schemes": { "bearer": { "list": [] } } }],
        "defaultInputModes": [INPUT_MODE],
        "defaultOutputModes": [OUTPUT_MODE],
        "skills": [{
            "id": "prime-agent",
            "name": "Prime Agent",
            "description": "Conversation, tool use, and multi-step coding and research tasks.",
            "tags": ["agent", "coding"],
        }],
    })
}

fn card_response(url: &str, product_version: &str, if_none_match: &str) -> Response<Body> {
    let body = agent_card(url, product_version).to_string();
    let hash = u64::from_be_bytes(digest(&body)[..8].try_into().expect("eight bytes"));
    let etag = format!("\"{hash:016x}\"");
    let response = Response::builder()
        .header("etag", &etag)
        .header("vary", "host");
    if if_none_match == etag {
        return response
            .status(StatusCode::NOT_MODIFIED)
            .body(full(""))
            .expect("static response");
    }
    response
        .header("content-type", "application/json")
        .header("cache-control", "max-age=300")
        .body(full(body))
        .expect("static response")
}

fn full(body: impl Into<Bytes>) -> Body {
    Full::new(body.into())
        .map_err(|never| match never {})
        .boxed()
}

fn plain(status: StatusCode, text: &'static str) -> Response<Body> {
    Response::builder()
        .status(status)
        .header("content-type", "text/plain")
        .body(full(text))
        .expect("static response")
}

fn json_response(envelope: &Value) -> Response<Body> {
    Response::builder()
        .header("content-type", "application/json")
        .body(full(envelope.to_string()))
        .expect("static response")
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn each_token_authenticates_its_own_client() {
        let tokens = |pairs: &[(&str, &str)]| -> BTreeMap<String, String> {
            pairs
                .iter()
                .map(|(client, token)| ((*client).to_string(), (*token).to_string()))
                .collect()
        };
        let clients = Clients::new(&tokens(&[("alice", "a-token"), ("bob", "b-token")])).unwrap();
        assert_eq!(clients.authenticate("Bearer a-token"), Some("alice"));
        assert_eq!(clients.authenticate("Bearer b-token"), Some("bob"));
        for header in ["Bearer c-token", "Basic a-token", "Bearer ", ""] {
            assert_eq!(clients.authenticate(header), None, "{header}");
        }
        for refused in [
            tokens(&[]),
            tokens(&[("alice", " ")]),
            tokens(&[("alice", "same"), ("bob", "same")]),
        ] {
            assert!(Clients::new(&refused).is_err(), "{refused:?}");
        }
    }

    #[test]
    fn the_host_gate_accepts_only_loopback_names() {
        for host in [
            "localhost:7800",
            "LocalHost",
            "127.0.0.1:7800",
            "127.9.9.9",
            "[::1]:7800",
            "[::1]",
        ] {
            assert!(is_loopback_host(host), "{host}");
        }
        for host in [
            "",
            "evil.example:7800",
            "192.168.1.4:7800",
            "0.0.0.0:7800",
            "[::2]:1",
            "[::1]@evil.example",
            "localhost:80@evil.example",
            "[::1]x",
        ] {
            assert!(!is_loopback_host(host), "{host}");
        }
    }
}

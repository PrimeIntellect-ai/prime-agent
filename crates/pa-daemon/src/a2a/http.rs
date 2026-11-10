//! The A2A HTTP transport (the JSON-RPC binding, spec section 9):
//! `GET /.well-known/agent-card.json` for discovery, one JSON-RPC POST
//! per request, SSE (`text/event-stream`) for the streaming methods.
//! The well-known Agent Card is the protocol's public discovery surface
//! (spec 14.3): it is the one route a configured bearer token does not
//! gate — an unknown client must be able to read the `bearer` security
//! scheme it needs to present — while every task route passes the
//! bearer gate (a 401 carries the `WWW-Authenticate: Bearer`
//! challenge). Every request then faces the browser-surface refusals:
//! any `Origin` header is refused on every bind (a web page cannot
//! drive this server; the server sends no CORS headers, so no
//! legitimate browser client exists to break), and a loopback bind
//! additionally refuses a `Host` that is neither a loopback name nor
//! the configured `a2a.publicBaseUrl` authority (the checks close DNS
//! rebinding and the cross-site `text/plain` form POST). A protocol
//! POST must carry `Content-Type: application/json` (else the spec's
//! `ContentTypeNotSupportedError`) and the `A2A-Version` service
//! parameter as a header (an empty or missing header is `0.3` per the
//! spec; this 1.0 server answers the spec's
//! `VersionNotSupportedError` — the same verdict the official
//! a2a-python server's `validate_version` reaches).

use std::sync::Arc;

use futures::StreamExt as _;
use http_body_util::combinators::BoxBody;
use http_body_util::{BodyExt as _, Full, Limited, StreamBody};
use hyper::body::Frame;
use hyper::body::Incoming;
use hyper::server::conn::http1;
use hyper::service::service_fn;
use hyper::{Method, Request, Response, StatusCode};
use hyper_util::rt::{TokioIo, TokioTimer};
use pa_telemetry::TelemetryClient;
use serde_json::{json, Value};
use tokio::sync::mpsc::Receiver as StreamReceiver;
use tokio::sync::Mutex;

use crate::mode_link::DaemonLink;

use super::card;
use super::jsonrpc::{self, A2aError};
use super::server::{dispatch, track_request_served, A2aState, Dispatch};
use super::types::{AgentCard, StreamResponse};

/// The bound on one request body (v1's text surface is far below it;
/// the bound exists so a hostile peer cannot park an unbounded body).
const MAX_BODY_BYTES: usize = 4 * 1024 * 1024;

/// The JSON content type of the JSON-RPC binding (spec 9.1).
const JSON_CONTENT_TYPE: &str = "application/json";

/// The pause after one failed `accept` before the loop tries again (a
/// live-but-exhausted server backs off instead of spinning).
const ACCEPT_BACKOFF: std::time::Duration = std::time::Duration::from_millis(100);

/// One response body: a full buffer or an SSE frame stream.
type Body = BoxBody<hyper::body::Bytes, std::io::Error>;

/// Serve the A2A HTTP surface until the process exits (the mode's run
/// function aborts this accept loop on shutdown, so the listener stops
/// admitting with the mode).
///
/// # Errors
///
/// Returns an error when the accept loop fails beyond recovery
/// (per-connection errors are logged and the connection dropped).
pub async fn serve(
    listener: tokio::net::TcpListener,
    state: Arc<Mutex<A2aState>>,
    link: Arc<DaemonLink>,
    card_options: card::CardOptions,
    bearer_token: String,
    // The configured public authority (`a2a.publicBaseUrl`): the one
    // non-loopback `Host` a loopback bind accepts (a TLS-terminating
    // front forwards the client's own `Host`) and the end of the
    // wildcard card's Host-derived interface URL (the configured URL is
    // the honest one whenever it exists).
    public_authority: Option<PublicAuthority>,
    telemetry: Option<TelemetryClient>,
) -> anyhow::Result<()> {
    let card = card::build_card(&card_options);
    let bound = listener.local_addr()?;
    let loopback_bind = bound.ip().is_loopback();
    // A wildcard bind with no configured public URL has no authority of
    // its own: the card route builds its interface URL from each
    // request's `Host` (spec 8.3.1) instead of the literal bind
    // address.
    let served = ServedCard {
        card,
        options: card_options,
        derive_host_url: bound.ip().is_unspecified() && public_authority.is_none(),
    };
    loop {
        // An accept error (fd exhaustion, a transient abort) must not
        // end the process and strand every in-memory task: log, back
        // off, and keep accepting — the sockets free up and the surface
        // recovers on its own.
        let tcp = match listener.accept().await {
            Ok((tcp, _)) => tcp,
            Err(error) => {
                eprintln!("a2a: accept error: {error}");
                tokio::time::sleep(ACCEPT_BACKOFF).await;
                continue;
            }
        };
        let io = TokioIo::new(tcp);
        let state = Arc::clone(&state);
        let link = Arc::clone(&link);
        let served = served.clone();
        let bearer_token = bearer_token.clone();
        let public_authority = public_authority.clone();
        let telemetry = telemetry.clone();
        tokio::spawn(async move {
            let service = service_fn(move |request| {
                handle_request(
                    request,
                    Arc::clone(&state),
                    Arc::clone(&link),
                    served.clone(),
                    bearer_token.clone(),
                    loopback_bind,
                    public_authority.clone(),
                    telemetry.clone(),
                )
            });
            if let Err(error) = http1::Builder::new()
                .timer(TokioTimer::new())
                .serve_connection(io, service)
                .await
            {
                eprintln!("a2a: connection error: {error}");
            }
        });
    }
}

/// A full-buffer body.
fn full(bytes: impl Into<hyper::body::Bytes>) -> Body {
    Full::new(bytes.into())
        .map_err(|infallible| match infallible {})
        .boxed()
}

/// An SSE body: the first frame (the task snapshot envelope), then the
/// live stream wrapped in JSON-RPC envelopes, the stream's end closing
/// the response (spec 3.1.2: the terminal frame is the last). A stream
/// that ends WITHOUT a terminal status frame was dropped at its queue
/// bound mid-task (spec 3.1.2's frame order cannot end any other way):
/// the body ends with one explicit error frame instead of the clean
/// chunked terminator, so a client never mistakes a truncated stream
/// for the task's finished answer.
fn sse(first: hyper::body::Bytes, id: Value, stream: StreamReceiver<StreamResponse>) -> Body {
    // The first frame (the task snapshot) precedes the live frames;
    // both carry the binding's JSON-RPC envelope in one SSE `data:`
    // line, the terminal frame ending the stream (spec 3.1.2). The
    // envelope per frame: every stream frame shares the request's id.
    let first = futures::stream::once(async move { Ok::<_, std::io::Error>(Frame::data(first)) });
    let id = Arc::new(id);
    let frames = futures::stream::unfold((stream, false), move |(mut stream, mut saw_terminal)| {
        let id = Arc::clone(&id);
        async move {
            match stream.recv().await {
                    Some(frame) => {
                        // The terminal frame is the last (spec 3.1.2):
                        // a terminal status-update frame ends the task's
                        // lifecycle for this stream.
                        saw_terminal |= matches!(
                            &frame,
                            StreamResponse::StatusUpdate(event)
                                if event.status.state.is_terminal()
                        );
                        let envelope = jsonrpc::response(&id, &to_value_or_null(&frame));
                        Some((
                            Ok::<_, std::io::Error>(Frame::data(sse_line(&envelope))),
                            (stream, saw_terminal),
                        ))
                    }
                    // The channel ended without a terminal frame: this
                    // subscriber was dropped at its queue bound (the
                    // publish path never buffers a non-reading
                    // subscriber past it). The queued frames drain and
                    // the receiver disconnects — a clean terminator
                    // would read as a finished task while the task may
                    // still be working, so one explicit error frame
                    // ends the body instead.
                    None if !saw_terminal => Some((
                        Ok::<_, std::io::Error>(Frame::data(sse_line(&jsonrpc::error_response(
                            &id,
                            jsonrpc::INTERNAL_ERROR,
                            "the stream ended without its terminal status frame: this subscriber was dropped at its queue bound; get the task for its state",
                            None,
                        )))),
                        (stream, true),
                    )),
                    None => None,
                }
        }
    });
    <StreamBody<_> as http_body_util::BodyExt>::boxed(StreamBody::new(first.chain(frames)))
}

/// One SSE `data:` line.
fn sse_line(envelope: &Value) -> hyper::body::Bytes {
    let json = serde_json::to_string(envelope).unwrap_or_default();
    format!("data: {json}\n\n").into()
}

/// One request: the bearer gate (the well-known Agent Card is the
/// public discovery surface, spec 14.3 — the `bearer` security scheme
/// it declares must be readable without the token; every task route
/// stays authenticated, spec 13.3's MUST), then the browser-surface
/// refusals (any `Origin` on every bind; a foreign `Host` on a loopback
/// bind, with the configured public authority accepted), then the card
/// route, then the JSON-RPC dispatch.
#[allow(clippy::too_many_arguments)] // one request handler, one dependency per arg
async fn handle_request(
    request: Request<Incoming>,
    state: Arc<Mutex<A2aState>>,
    link: Arc<DaemonLink>,
    served: ServedCard,
    bearer_token: String,
    loopback_bind: bool,
    public_authority: Option<PublicAuthority>,
    telemetry: Option<TelemetryClient>,
) -> Result<Response<Body>, hyper::Error> {
    let method = request.method().clone();
    let path = request.uri().path().to_string();
    let well_known_card = method == Method::GET && path == AgentCard::WELL_KNOWN_PATH;
    // The token is required (configured or minted — see
    // `A2aOptions::bearer_token`); the well-known card route stays the
    // one public discovery surface.
    if !well_known_card {
        let presented = request
            .headers()
            .get(hyper::header::AUTHORIZATION)
            .and_then(|value| value.to_str().ok())
            .and_then(bearer_credentials);
        let matches = presented.is_some_and(|presented| bearer_matches(presented, &bearer_token));
        if !matches {
            return Ok(unauthorized());
        }
    }
    if loopback_bind {
        // A loopback bind serves this machine, not the web: a foreign
        // `Host` is a rebound name (the one accepted exception is the
        // configured public authority — a TLS-terminating front that
        // forwards the client's own `Host`, spec 8.3's accurate
        // interface URL).
        let host = request
            .headers()
            .get(hyper::header::HOST)
            .and_then(|value| value.to_str().ok())
            .unwrap_or_default();
        if !host_is_loopback(host)
            && !public_authority
                .as_ref()
                .is_some_and(|authority| authority.matches_host(host))
        {
            return Ok(forbidden());
        }
    }
    // A web page cannot drive this server on any bind (the server sends
    // no CORS headers, so no legitimate browser client exists to
    // break): no legitimate non-browser client sends `Origin`, and any
    // `Origin` is refused before any route runs.
    if request.headers().contains_key("origin") {
        return Ok(forbidden());
    }
    let version_header = request
        .headers()
        .get(jsonrpc::VERSION_HEADER)
        .and_then(|value| value.to_str().ok())
        .map(str::to_string);

    if well_known_card {
        return Ok(card_response(&served, &request));
    }
    if method == Method::POST && path == "/" {
        // The content type rides the request head, read before the body
        // consumes the request (the gate needs the parsed id for the
        // error envelope, so it answers after the JSON parse, still
        // before any side effect).
        let content_type = request
            .headers()
            .get(hyper::header::CONTENT_TYPE)
            .and_then(|value| value.to_str().ok())
            .map(|value| {
                value
                    .split(';')
                    .next()
                    .unwrap_or_default()
                    .trim()
                    .to_string()
            });
        let body = request.into_body();
        let bytes = match Limited::new(body, MAX_BODY_BYTES).collect().await {
            Ok(collected) => collected.to_bytes(),
            Err(_) => {
                return Ok(Response::builder()
                    .status(StatusCode::PAYLOAD_TOO_LARGE)
                    .body(full("request body too large"))
                    .expect("static response"));
            }
        };
        let parsed: Value = match serde_json::from_slice(&bytes) {
            Ok(parsed) => parsed,
            Err(_) => {
                return Ok(jsonrpc_response(&jsonrpc::error_response(
                    &Value::Null,
                    jsonrpc::PARSE_ERROR,
                    "Invalid JSON payload",
                    None,
                )));
            }
        };
        let request = match jsonrpc::parse_request(&parsed) {
            Ok(request) => request,
            Err(error_response) => return Ok(jsonrpc_response(&error_response)),
        };
        // The content-type gate (spec 9.1: the binding's bodies are
        // `application/json`): a browser form's `text/plain` or any
        // other media type answers the spec's
        // `ContentTypeNotSupportedError` before dispatch runs. The
        // media type compares case-insensitively (RFC 9110 §8.3.1);
        // the parameters were stripped at the read.
        let json_content_type = content_type
            .as_deref()
            .is_some_and(|value| value.eq_ignore_ascii_case(JSON_CONTENT_TYPE));
        if !json_content_type {
            // The gate answers a parsed request with its method in hand:
            // the adoption event counts the refusal, the same served
            // request every dispatched method reports.
            track_request_served(telemetry.as_ref(), &request.method, "error");
            return Ok(jsonrpc_response(&jsonrpc::a2a_error_response(
                &request.id,
                A2aError::ContentTypeNotSupported,
                Some(&json!({ "supported": JSON_CONTENT_TYPE })),
            )));
        }
        // The version gate (spec 3.6): the HTTP header only (the
        // binding's service parameters are headers; an empty header is
        // 0.3, and only 1.0 is served).
        let requested = version_header.filter(|header| !header.is_empty());
        if !requested.as_deref().is_some_and(is_supported_version) {
            // The version gate is the protocol's first-contact refusal:
            // the adoption event counts it like every other served
            // request (an unsupported client's failed try-out is the
            // adoption signal, not a silent drop).
            track_request_served(telemetry.as_ref(), &request.method, "error");
            return Ok(jsonrpc_response(&jsonrpc::a2a_error_response(
                &request.id,
                A2aError::VersionNotSupported,
                Some(&json!({ "supported": jsonrpc::PROTOCOL_VERSION })),
            )));
        }
        let method = request.method.clone();
        let dispatched = dispatch(&link, &state, request).await;
        // The adoption event rides every served request — the
        // dispatched methods here, the two protocol gates above
        // (fire-and-forget; the delivery is the worker's concern).
        track_request_served(
            telemetry.as_ref(),
            &method,
            match &dispatched {
                Dispatch::Reply(reply) => {
                    if reply.get("error").is_some() {
                        "error"
                    } else {
                        "ok"
                    }
                }
                Dispatch::Stream(..) => "stream",
            },
        );
        return Ok(match dispatched {
            Dispatch::Reply(reply) => jsonrpc_response(&reply),
            Dispatch::Stream(id, first, stream) => {
                let first_line = sse_line(&first);
                Response::builder()
                    .header("content-type", "text/event-stream")
                    .header("cache-control", "no-cache")
                    .body(sse(first_line, id, stream))
                    .expect("static response")
            }
        });
    }
    Ok(Response::builder()
        .status(StatusCode::NOT_FOUND)
        .body(full("not found"))
        .expect("static response"))
}

/// Whether one version string is the served `Major.Minor` (a patch
/// suffix is ignored; the spec pins negotiation to Major.Minor).
fn is_supported_version(requested: &str) -> bool {
    requested.split('.').take(2).collect::<Vec<_>>().as_slice() == ["1", "0"]
}

/// The credentials of one `Authorization` header: the auth-scheme is
/// case-insensitive (RFC 9110 §11.1) while the token compares exactly.
fn bearer_credentials(value: &str) -> Option<&str> {
    let (scheme, credentials) = value.split_once(char::is_whitespace)?;
    scheme
        .eq_ignore_ascii_case("Bearer")
        .then(|| credentials.trim())
}

/// One `Host` header value split into its name and port suffix: the
/// bracketed IPv6 form carries its port after the closing bracket, a
/// colon outside brackets is a port suffix on a colon-free name (an
/// unbracketed IPv6 literal is invalid as a `Host` — RFC 9110 §7.2:
/// the bracketed form is the only IP-literal uri-host), and a
/// colon-free value is the name alone. `None` names no servable
/// form; the port rides as suffix text, unparsed here.
fn split_host_port(host: &str) -> Option<(&str, Option<&str>)> {
    let host = host.trim();
    if let Some(rest) = host.strip_prefix('[') {
        let (name, tail) = rest.split_once(']')?;
        return Some((name, tail.strip_prefix(':')));
    }
    if host.contains(':') {
        return match host.rsplit_once(':') {
            Some((name, port))
                if port.chars().all(|c| c.is_ascii_digit()) && !name.contains(':') =>
            {
                Some((name, (!port.is_empty()).then_some(port)))
            }
            _ => None,
        };
    }
    Some((host, None))
}

/// Whether one `Host` header value names this loopback server (a
/// loopback name, optionally with any port, or the bound address).
/// Host names compare case-insensitively (RFC 9110 §7.2: reg-name
/// comparison is case-insensitive): `LocalHost` names the same
/// loopback bind as `localhost`.
fn host_is_loopback(host: &str) -> bool {
    let Some((name, _)) = split_host_port(host) else {
        return false;
    };
    name.eq_ignore_ascii_case("localhost")
        || name
            .parse::<std::net::IpAddr>()
            .is_ok_and(|ip| ip.is_loopback())
}

/// The configured public authority (`a2a.publicBaseUrl`): the one
/// non-loopback `Host` a loopback bind accepts (a TLS-terminating
/// front forwards the client's own `Host`). The URL's scheme names
/// the default port, so the authority's default-port forms are the
/// same authority (`https://agent.example.com` and
/// `Host: agent.example.com:443`); the name compares
/// case-insensitively (RFC 9110 §7.2), an explicit port exactly.
#[derive(Clone, Debug, PartialEq, Eq)]
pub(crate) struct PublicAuthority {
    name: String,
    port: Option<u16>,
    default_port: u16,
}

impl PublicAuthority {
    /// The authority of one configured public base URL (`None` when
    /// the URL names no servable authority: no host, or a port
    /// outside the TCP range).
    pub(crate) fn parse(url: &str) -> Option<Self> {
        let (https, rest) = match url.strip_prefix("https://") {
            Some(rest) => (true, rest),
            None => (false, url.strip_prefix("http://").unwrap_or(url)),
        };
        let authority = rest.split(['/', '?', '#']).next().unwrap_or_default();
        let (name, port) = split_host_port(authority)?;
        if name.is_empty() {
            return None;
        }
        let port = match port {
            None => None,
            Some(port) => Some(port.parse::<u16>().ok()?),
        };
        Some(Self {
            name: name.to_string(),
            port,
            default_port: if https { 443 } else { 80 },
        })
    }

    /// Whether one `Host` header value names this authority: the same
    /// name case-insensitively, at the same port (explicit either
    /// side, or the scheme's default when neither names one).
    pub(crate) fn matches_host(&self, host: &str) -> bool {
        let Some((name, port)) = split_host_port(host) else {
            return false;
        };
        if !name.eq_ignore_ascii_case(&self.name) {
            return false;
        }
        let port = port
            .and_then(|port| port.parse::<u16>().ok())
            .unwrap_or(self.default_port);
        port == self.port.unwrap_or(self.default_port)
    }
}

/// The bearer comparison, digest-mediated so the comparison time does
/// not carry the token's prefix (a plain compare would).
fn bearer_matches(presented: &str, expected: &str) -> bool {
    use sha2::{Digest as _, Sha256};
    let digest = |value: &str| Sha256::digest(value.as_bytes());
    digest(presented) == digest(expected)
}

/// The auth failure: a plain HTTP 401 with the required challenge
/// header (RFC 9110 §11.6.1); the JSON-RPC envelope needs the request
/// id, which an unauthorized peer has no claim to.
fn unauthorized() -> Response<Body> {
    Response::builder()
        .status(StatusCode::UNAUTHORIZED)
        .header("WWW-Authenticate", "Bearer")
        .header("content-type", "text/plain")
        .body(full("unauthorized"))
        .expect("static response")
}

/// The browser-surface refusal (a foreign `Host` or a browser `Origin`
/// on a loopback bind): a plain HTTP 403.
fn forbidden() -> Response<Body> {
    Response::builder()
        .status(StatusCode::FORBIDDEN)
        .header("content-type", "text/plain")
        .body(full("forbidden"))
        .expect("static response")
}

/// The served card: the prebuilt card and its build inputs, carried to
/// the card route so a wildcard bind can rebuild the interface URL from
/// each request's `Host` (spec 8.3.1: the interface URL MUST accurately
/// name the transport URL — the literal `0.0.0.0` bind is not one; a
/// request without a `Host` keeps the bound endpoint). A configured
/// public base URL ends the derivation: the card always advertises it.
#[derive(Clone)]
struct ServedCard {
    card: AgentCard,
    options: card::CardOptions,
    derive_host_url: bool,
}

impl ServedCard {
    /// The card for one request (a wildcard bind with no configured
    /// public URL derives its interface URL from the request's `Host`
    /// authority).
    fn for_request(&self, request: &Request<Incoming>) -> AgentCard {
        if !self.derive_host_url {
            return self.card.clone();
        }
        let host = request
            .headers()
            .get(hyper::header::HOST)
            .and_then(|value| value.to_str().ok())
            .unwrap_or_default();
        if host.is_empty() {
            return self.card.clone();
        }
        let mut options = self.options.clone();
        options.interface_url = format!("http://{host}/");
        card::build_card(&options)
    }
}

/// The card response with the spec's caching SHOULDs (spec 8.6): the
/// `ETag` from the card body, `If-None-Match` answered by 304.
fn card_response(served: &ServedCard, request: &Request<Incoming>) -> Response<Body> {
    let card = served.for_request(request);
    let body = card::card_response_body(&card);
    let etag = card::card_etag(&body);
    if let Some(incoming) = request
        .headers()
        .get(hyper::header::IF_NONE_MATCH)
        .and_then(|value| value.to_str().ok())
    {
        if incoming == etag {
            return Response::builder()
                .status(StatusCode::NOT_MODIFIED)
                .header("etag", etag)
                .body(full(""))
                .expect("static response");
        }
    }
    Response::builder()
        .header("content-type", JSON_CONTENT_TYPE)
        .header("etag", etag)
        .header("cache-control", "max-age=300")
        .body(full(serde_json::to_string(&body).unwrap_or_default()))
        .expect("static response")
}

/// The JSON form of one value (the null fallback keeps the envelope
/// shape on a serialization failure).
fn to_value_or_null(value: &impl serde::Serialize) -> Value {
    serde_json::to_value(value).unwrap_or(Value::Null)
}

/// A JSON-RPC response envelope as an HTTP response.
fn jsonrpc_response(envelope: &Value) -> Response<Body> {
    Response::builder()
        .header("content-type", JSON_CONTENT_TYPE)
        .body(full(serde_json::to_string(envelope).unwrap_or_default()))
        .expect("static response")
}

#[cfg(test)]
mod tests {
    use super::*;

    /// The Major.Minor comparison: 1.0 served, patch ignored, 0.3 and
    /// anything else refused.
    #[test]
    fn the_version_gate_compares_major_minor() {
        assert!(is_supported_version("1.0"));
        assert!(is_supported_version("1.0.1"));
        assert!(!is_supported_version("0.3"));
        assert!(!is_supported_version("1.1"));
        assert!(!is_supported_version("2.0"));
        assert!(!is_supported_version(""));
    }

    /// The bearer gate compares without leaking the prefix through the
    /// comparison time.
    #[test]
    fn the_bearer_comparison_matches_exactly() {
        assert!(bearer_matches("token", "token"));
        assert!(!bearer_matches("token-x", "token"));
        assert!(!bearer_matches("", "token"));
        assert!(bearer_matches("", ""));
    }

    /// The auth-scheme is case-insensitive (RFC 9110 §11.1) while the
    /// credentials compare exactly; a non-bearer scheme is not
    /// credentials.
    #[test]
    fn the_bearer_scheme_parses_case_insensitively() {
        assert_eq!(bearer_credentials("Bearer token"), Some("token"));
        assert_eq!(bearer_credentials("bearer token"), Some("token"));
        assert_eq!(bearer_credentials("BEARER token"), Some("token"));
        assert_eq!(bearer_credentials("Bearer  spaced  "), Some("spaced"));
        assert_eq!(bearer_credentials("Basic dG9rZW4="), None);
        assert_eq!(bearer_credentials("Bearer"), None);
    }

    /// The loopback `Host` gate: loopback names and ports pass, foreign
    /// names and IPv6 literals in the wrong form refuse.
    #[test]
    fn the_host_gate_accepts_only_loopback_names() {
        for host in [
            "localhost",
            "localhost:7800",
            "LocalHost",
            "LOCALHOST:7800",
            "127.0.0.1",
            "127.0.0.1:7800",
            "127.0.0.99:7800",
            "[::1]",
            "[::1]:7800",
        ] {
            assert!(host_is_loopback(host), "{host} is a loopback host");
        }
        for host in [
            "",
            "rebound.attacker.example",
            "rebound.attacker.example:7800",
            "192.168.1.4:7800",
            "::1",
            "::1:7800",
            "0.0.0.0:7800",
        ] {
            assert!(!host_is_loopback(host), "{host} must be refused");
        }
    }

    /// The public-authority gate matches the name case-insensitively
    /// (RFC 9110 §7.2) and the port modulo the URL scheme's default:
    /// a front's forwarded `Host` in either default-port form serves,
    /// while any other port — or any other name — stays refused.
    #[test]
    fn the_public_authority_gate_matches_case_and_default_ports() {
        let https = PublicAuthority::parse("https://Agent.Example.com/")
            .expect("the URL names an authority");
        for host in [
            "agent.example.com",
            "Agent.Example.Com",
            "agent.example.com:443",
        ] {
            assert!(https.matches_host(host), "{host} names the authority");
        }
        for host in [
            "agent.example.com:8443",
            "agent.example.com:80",
            "rebind.attacker.example",
            "rebind.attacker.example:443",
        ] {
            assert!(!https.matches_host(host), "{host} must be refused");
        }
        let explicit = PublicAuthority::parse("https://agent.example.com:8443/")
            .expect("the URL names an authority");
        assert!(explicit.matches_host("agent.example.com:8443"));
        assert!(
            !explicit.matches_host("agent.example.com"),
            "the scheme default is not the explicit port"
        );
        let http = PublicAuthority::parse("http://agent.example.com/")
            .expect("the URL names an authority");
        assert!(http.matches_host("agent.example.com"));
        assert!(http.matches_host("agent.example.com:80"));
        assert!(!http.matches_host("agent.example.com:443"));
        assert!(
            PublicAuthority::parse("https:///").is_none(),
            "a URL with no authority names none"
        );
        assert!(
            PublicAuthority::parse("https://agent.example.com:99999/").is_none(),
            "a port the URL cannot bind names no authority"
        );
    }

    /// One SSE line is the envelope wrapped in the binding's frame
    /// shape.
    #[test]
    fn an_sse_line_wraps_the_envelope() {
        let envelope = jsonrpc::response(&json!(5), &json!({ "task": { "id": "t" } }));
        let line = sse_line(&envelope);
        let text = std::str::from_utf8(&line).unwrap();
        assert!(text.starts_with("data: "));
        assert!(text.ends_with("\n\n"));
        assert!(text.contains("\"id\":5"));
    }

    /// A body whose subscriber was dropped at its queue bound ends with
    /// the explicit error frame, never a clean terminator: a client
    /// cannot mistake a truncated stream for the task's finished
    /// answer (the control ends at its terminal frame, no error
    /// member anywhere).
    #[tokio::test]
    async fn a_dropped_subscribers_sse_body_ends_with_the_error_frame() {
        // `SUBSCRIBER_QUEUE_FRAMES` (task.rs) is 1024: 2048 chunks
        // overflow any subscriber's queue and drop it mid-task.
        let dropped = sse_body_for(2048).await;
        let frames: Vec<&str> = dropped
            .split("\n\n")
            .filter(|line| !line.is_empty())
            .collect();
        let last = frames.last().expect("the body ends with a frame");
        let envelope: Value =
            serde_json::from_str(last.strip_prefix("data: ").expect("one SSE data line"))
                .expect("the error frame parses");
        assert_eq!(
            envelope["error"]["code"],
            jsonrpc::INTERNAL_ERROR,
            "the lag drop ends with the explicit error frame: {dropped}"
        );
        assert!(
            envelope.get("result").is_none(),
            "the error frame carries no result: {dropped}"
        );

        // The control: a subscriber the publish path never dropped
        // ends at its terminal status frame, no error frame appended.
        let control = sse_body_for(4).await;
        let frames: Vec<&str> = control
            .split("\n\n")
            .filter(|line| !line.is_empty())
            .collect();
        let last = frames
            .last()
            .expect("the body ends with its terminal frame");
        let envelope: Value =
            serde_json::from_str(last.strip_prefix("data: ").expect("one SSE data line"))
                .expect("the terminal frame parses");
        assert_eq!(
            envelope["result"]["statusUpdate"]["status"]["state"], "TASK_STATE_COMPLETED",
            "the control ends at its terminal frame: {control}"
        );
        assert!(
            !control.contains("\"error\""),
            "the clean stream appends no error frame: {control}"
        );
    }

    /// Drive the real registry's subscribe/publish/settle and collect
    /// one `sse()` body for a subscriber fed `chunks` artifact frames
    /// before the settle.
    async fn sse_body_for(chunks: usize) -> String {
        let mut registry = super::super::task::TaskRegistry::new();
        registry.admit(
            "task".into(),
            "ctx".into(),
            "session".into(),
            None,
            vec![super::super::types::Part::text("prompt")],
        );
        let (first_snapshot, stream) = registry
            .subscribe_with_snapshot("task", None)
            .expect("subscribable");
        let first = sse_line(&jsonrpc::response(
            &json!(1),
            &to_value_or_null(&StreamResponse::Task(first_snapshot)),
        ));
        for _ in 0..chunks {
            registry.append_artifact_chunk("task", "x");
        }
        registry.settle("task", super::super::types::TaskState::Completed, None);
        let body = sse(first, json!(1), stream);
        let collected = http_body_util::BodyExt::collect(body)
            .await
            .expect("the body collects");
        String::from_utf8(collected.to_bytes().to_vec()).unwrap()
    }
}

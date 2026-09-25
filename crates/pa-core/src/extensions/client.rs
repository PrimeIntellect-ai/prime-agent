//! RPC client half of the extension sidecar protocol (design stage 1).
//!
//! Owns correlation ids, request/response dispatch, notification fan-out, and
//! the reverse direction: ctx-action requests that extension code makes while
//! a handler runs (`sendMessage`, `exec`, ...), routed to a [`CtxCallHandler`]
//! on the Rust side so secrets and session state never cross to the sidecar
//! (design doc §2.3, §2.5).

use std::collections::HashMap;
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::Arc;
use std::time::Duration;

use anyhow::{anyhow, Result};
use pa_types::extension_rpc::{
    HostErrorReply, HostNotification, HostReply, HostRequest, RpcError, SidecarMessage,
    METHOD_EXTENSION_ERROR, METHOD_REGISTRATION,
};
use serde_json::Value;
use tokio::io::{AsyncRead, AsyncReadExt, AsyncWrite, AsyncWriteExt};
use tokio::sync::{mpsc, oneshot, Mutex};
use tracing::{debug, warn};

use super::framing::{encode_line, LineDecoder, LineLimits};

/// One ctx-action call from extension code running in the sidecar.
#[derive(Debug, Clone)]
pub struct CtxCall {
    /// Correlates the sidecar's request with the host's reply.
    pub ctx_token: String,
    pub method: String,
    pub params: Value,
}

/// Answers [`CtxCall`]s from the sidecar. Runs on the Rust host: extension
/// code never receives secrets or live objects, only JSON results. Handlers
/// may be invoked concurrently (one call per in-flight extension handler) and
/// must be cheap or spawn their own work; a slow handler delays only the
/// extension that called it.
///
/// Boxed future instead of RPITIT because the host stores the handler as
/// `Arc<dyn CtxCallHandler>`; implementations return `async move { ... }.boxed()`.
pub trait CtxCallHandler: Send + Sync {
    fn handle(&self, call: CtxCall)
        -> futures::future::BoxFuture<'static, Result<Value, RpcError>>;
}

/// Notifications received from the sidecar, classified by method name.
#[derive(Debug, Clone)]
pub enum SidecarNotification {
    /// `extension_error`: an error-boundary report (never fatal).
    ExtensionError(pa_types::extension_rpc::ExtensionError),
    /// `registration`: registrations changed after the handshake.
    Registration(pa_types::extension_rpc::RegistrationNotification),
    /// Any other notification, forwarded raw.
    Other { method: String, params: Value },
}

type Pending = HashMap<u64, oneshot::Sender<Result<Value, RpcError>>>;

/// The host-side RPC client for one sidecar process incarnation.
pub struct RpcClient<W> {
    writer: Mutex<W>,
    pending: Mutex<Pending>,
    next_id: AtomicU64,
    notifications: mpsc::Sender<SidecarNotification>,
    ctx_handler: Option<Arc<dyn CtxCallHandler>>,
    alive: AtomicBool,
    limits: LineLimits,
}

impl<W> RpcClient<W>
where
    W: AsyncWrite + Unpin + Send + 'static,
{
    pub fn new(
        writer: W,
        notifications: mpsc::Sender<SidecarNotification>,
        ctx_handler: Option<Arc<dyn CtxCallHandler>>,
        limits: LineLimits,
    ) -> Arc<Self> {
        Arc::new(RpcClient {
            writer: Mutex::new(writer),
            pending: Mutex::new(Pending::new()),
            next_id: AtomicU64::new(1),
            notifications,
            ctx_handler,
            alive: AtomicBool::new(true),
            limits,
        })
    }

    pub fn is_alive(&self) -> bool {
        self.alive.load(Ordering::SeqCst)
    }

    /// Send a request and await its reply, bounded by `timeout`.
    ///
    /// # Errors
    ///
    /// Returns an error when the sidecar is not running, the request line
    /// cannot be encoded or written, the sidecar replies with an RPC error or
    /// stops before replying, or the reply does not arrive before `timeout`.
    pub async fn request(
        self: &Arc<Self>,
        method: &str,
        params: Value,
        timeout: Duration,
    ) -> Result<Value> {
        if !self.is_alive() {
            return Err(anyhow!("extension sidecar is not running"));
        }
        let id = self.next_id.fetch_add(1, Ordering::Relaxed);
        let (tx, rx) = oneshot::channel();
        self.pending.lock().await.insert(id, tx);
        let line = encode_line(
            &HostRequest {
                id,
                method: method.to_string(),
                params,
            },
            self.limits,
        )?;
        if let Err(err) = self.write_line(line).await {
            self.pending.lock().await.remove(&id);
            self.mark_dead(&err.to_string()).await;
            return Err(err.context("write extension RPC request"));
        }
        match tokio::time::timeout(timeout, rx).await {
            Ok(Ok(Ok(value))) => Ok(value),
            Ok(Ok(Err(rpc))) => Err(anyhow!(
                "extension RPC call '{method}' failed: {}",
                rpc.message
            )),
            Ok(Err(_dropped)) => Err(anyhow!(
                "extension sidecar stopped while '{method}' was in flight"
            )),
            Err(_elapsed) => {
                self.pending.lock().await.remove(&id);
                Err(anyhow!(
                    "extension RPC call '{method}' timed out after {}ms",
                    timeout.as_millis()
                ))
            }
        }
    }

    /// Send a notification (no reply expected).
    ///
    /// # Errors
    ///
    /// Returns an error when the notification line cannot be encoded or
    /// written to the sidecar.
    pub async fn notify(self: &Arc<Self>, method: &str, params: Value) -> Result<()> {
        let line = encode_line(
            &HostNotification {
                method: method.to_string(),
                params,
            },
            self.limits,
        )?;
        if let Err(err) = self.write_line(line).await {
            self.mark_dead(&err.to_string()).await;
            return Err(err.context("write extension RPC notification"));
        }
        Ok(())
    }

    async fn write_line(&self, line: Vec<u8>) -> Result<()> {
        let mut writer = self.writer.lock().await;
        writer.write_all(&line).await?;
        writer.flush().await?;
        Ok(())
    }

    async fn reply_ctx(self: &Arc<Self>, reply: impl serde::Serialize) {
        let line = match encode_line(&reply, self.limits) {
            Ok(line) => line,
            Err(err) => {
                warn!(target: "extension_host", "cannot encode ctx reply: {err:#}");
                return;
            }
        };
        if let Err(err) = self.write_line(line).await {
            // The sidecar is gone; its handler promise dies with it.
            debug!(target: "extension_host", "ctx reply write failed: {err:#}");
        }
    }

    /// Fail every in-flight request with `error`. Idempotent: exactly one
    /// caller wins the `alive` swap per incarnation.
    pub(crate) async fn mark_dead(&self, error: &str) {
        if !self.alive.swap(false, Ordering::SeqCst) {
            return;
        }
        let mut pending = self.pending.lock().await;
        for (_, sender) in pending.drain() {
            let _ = sender.send(Err(RpcError::message(format!(
                "extension sidecar stopped: {error}"
            ))));
        }
    }

    async fn dispatch(self: &Arc<Self>, message: SidecarMessage) {
        match message {
            SidecarMessage::Response { id, result, error } => {
                let mut pending = self.pending.lock().await;
                match pending.remove(&id) {
                    Some(sender) => {
                        let outcome = match error {
                            Some(error) => Err(error),
                            None => Ok(result.unwrap_or(Value::Null)),
                        };
                        let _ = sender.send(outcome);
                    }
                    None => {
                        debug!(target: "extension_host", "orphan response for request {id}");
                    }
                }
            }
            SidecarMessage::Request {
                ctx_token,
                method,
                params,
            } => {
                let client = Arc::clone(self);
                tokio::spawn(async move {
                    let outcome = match &client.ctx_handler {
                        Some(handler) => {
                            handler
                                .handle(CtxCall {
                                    ctx_token: ctx_token.clone(),
                                    method: method.clone(),
                                    params,
                                })
                                .await
                        }
                        None => Err(not_bound(&method)),
                    };
                    match outcome {
                        Ok(result) => client.reply_ctx(HostReply { ctx_token, result }).await,
                        Err(error) => client.reply_ctx(HostErrorReply { ctx_token, error }).await,
                    }
                });
            }
            SidecarMessage::Notification { method, params } => {
                let notification = classify_notification(method.as_str(), params);
                if self.notifications.send(notification).await.is_err() {
                    debug!(
                        target: "extension_host",
                        "no event listener for sidecar notification; dropping"
                    );
                }
            }
        }
    }

    /// Pump the sidecar's stdout until EOF or a protocol violation. Returns
    /// only on death: `Err` carries the reason (EOF included). Process-
    /// lifecycle reactions to the return belong to the caller.
    ///
    /// # Errors
    ///
    /// Returns an error carrying the reason for the death: the sidecar
    /// closed the connection, reading its stdout failed, it violated the line
    /// protocol, or it sent an unparsable line.
    pub async fn read_loop<R>(self: &Arc<Self>, reader: R) -> Result<()>
    where
        R: AsyncRead + Unpin,
    {
        let mut reader = reader;
        let mut decoder = LineDecoder::new(self.limits);
        let mut chunk = [0u8; 16 * 1024];
        loop {
            let read = reader.read(&mut chunk).await;
            let bytes = match read {
                Ok(0) => {
                    self.mark_dead("stdout closed").await;
                    return Err(anyhow!("extension sidecar closed the connection"));
                }
                Ok(n) => &chunk[..n],
                Err(err) => {
                    self.mark_dead(&err.to_string()).await;
                    return Err(anyhow!("reading extension sidecar stdout: {err}"));
                }
            };
            let lines = match decoder.feed(bytes) {
                Ok(lines) => lines,
                Err(err) => {
                    self.mark_dead(&err.to_string()).await;
                    return Err(err.context("extension sidecar protocol violated"));
                }
            };
            for line in lines {
                let message: SidecarMessage = match serde_json::from_str(&line) {
                    Ok(message) => message,
                    Err(err) => {
                        self.mark_dead(&err.to_string()).await;
                        let excerpt: String = line.chars().take(120).collect();
                        return Err(anyhow!(
                            "extension sidecar sent an unparsable line ({err}): {excerpt}"
                        ));
                    }
                };
                self.dispatch(message).await;
            }
        }
    }
}

fn classify_notification(method: &str, params: Value) -> SidecarNotification {
    match method {
        METHOD_EXTENSION_ERROR => match serde_json::from_value(params) {
            Ok(error) => SidecarNotification::ExtensionError(error),
            Err(err) => SidecarNotification::Other {
                method: method.to_string(),
                params: Value::String(err.to_string()),
            },
        },
        METHOD_REGISTRATION => match serde_json::from_value(params) {
            Ok(registration) => SidecarNotification::Registration(registration),
            Err(err) => SidecarNotification::Other {
                method: method.to_string(),
                params: Value::String(err.to_string()),
            },
        },
        _ => SidecarNotification::Other {
            method: method.to_string(),
            params,
        },
    }
}

fn not_bound(method: &str) -> RpcError {
    RpcError::message(format!(
        "Extension ctx action '{method}' is not bound in this session \
         (the extension runtime actions are not integrated yet)"
    ))
}

#[cfg(test)]
mod tests {
    use super::*;
    use futures::FutureExt;
    use pa_types::extension_rpc::ExtensionError;
    use serde_json::json;
    use std::time::Duration;
    use tokio::io::duplex;
    use tokio::io::{AsyncBufReadExt, AsyncWriteExt, BufReader};

    type Duplex = tokio::io::DuplexStream;

    /// Drive one RPC request concurrently with the fake sidecar. The
    /// request future only writes its line once polled, so tests that
    /// first read the line must run the request as its own task.
    fn spawn_request(
        client: &Arc<RpcClient<Duplex>>,
        method: &'static str,
        params: Value,
        timeout: Duration,
    ) -> tokio::task::JoinHandle<Result<Value>> {
        let client = Arc::clone(client);
        tokio::spawn(async move { client.request(method, params, timeout).await })
    }

    /// Client with both directions wired to a fake sidecar's ends and the
    /// read loop already pumping. Returns the fake sidecar's read end
    /// (lines the client writes) and write end (lines the sidecar sends).
    fn spawn_client(
        ctx_handler: Option<Arc<dyn CtxCallHandler>>,
    ) -> (
        Arc<RpcClient<Duplex>>,
        Duplex,
        Duplex,
        mpsc::Receiver<SidecarNotification>,
    ) {
        let (host_to_sidecar, sidecar_reads) = duplex(64 * 1024);
        let (sidecar_writes, sidecar_to_host) = duplex(64 * 1024);
        let (tx, rx) = mpsc::channel(16);
        let client: Arc<RpcClient<Duplex>> =
            RpcClient::new(host_to_sidecar, tx, ctx_handler, LineLimits::default());
        let pump = Arc::clone(&client);
        tokio::spawn(async move {
            let _ = pump.read_loop(sidecar_to_host).await;
        });
        (client, sidecar_reads, sidecar_writes, rx)
    }

    async fn read_line(reader: &mut Duplex) -> Value {
        let mut line = String::new();
        let mut buf = BufReader::new(reader);
        assert!(buf.read_line(&mut line).await.unwrap() > 0);
        serde_json::from_str(line.trim()).unwrap()
    }

    async fn write_line_raw(writer: &mut Duplex, value: Value) {
        writer
            .write_all(format!("{value}\n").as_bytes())
            .await
            .unwrap();
    }

    #[tokio::test]
    async fn request_response_roundtrip() {
        let (client, mut reads, mut writes, _events) = spawn_client(None);
        let request = spawn_request(&client, "ping", json!({"a": 1}), Duration::from_secs(5));
        let msg = read_line(&mut reads).await;
        let reply = json!({"id": msg["id"], "result": {"echo": msg["params"]}});
        write_line_raw(&mut writes, reply).await;
        let result = request.await.unwrap().unwrap();
        assert_eq!(result, json!({"echo": {"a": 1}}));
    }

    #[tokio::test]
    async fn error_response_shape() {
        let (client, mut reads, mut writes, _events) = spawn_client(None);
        let request = spawn_request(&client, "hello", json!({}), Duration::from_secs(5));
        let msg = read_line(&mut reads).await;
        write_line_raw(
            &mut writes,
            json!({"id": msg["id"], "error": {"message": "boom", "stack": "at x"}}),
        )
        .await;
        let err = request.await.unwrap().unwrap_err();
        assert!(err.to_string().contains("failed: boom"), "got: {err}");
        assert!(client.is_alive());
    }

    #[tokio::test]
    async fn timeout_leaves_client_alive() {
        let (client, _reads, _writes, _events) = spawn_client(None);
        let err = client
            .request("ping", json!({}), Duration::from_millis(50))
            .await
            .unwrap_err();
        assert!(err.to_string().contains("timed out"), "got: {err}");
        assert!(client.is_alive());
    }

    #[tokio::test]
    async fn sidecar_death_fails_pending_requests() {
        let (client, _reads, writes, _events) = spawn_client(None);
        let request = client.request("ping", json!({}), Duration::from_secs(5));
        drop(writes); // sidecar exits: stdout closes
        let err = request.await.unwrap_err();
        assert!(
            err.to_string().contains("extension sidecar stopped"),
            "got: {err}"
        );
        assert!(!client.is_alive());
    }

    #[tokio::test]
    async fn unparsable_line_kills_the_connection() {
        let (client, _reads, mut writes, _events) = spawn_client(None);
        let request = client.request("ping", json!({}), Duration::from_secs(5));
        writes.write_all(b"this is not json\n").await.unwrap();
        let err = request.await.unwrap_err();
        assert!(
            err.to_string().contains("extension sidecar stopped"),
            "got: {err}"
        );
        assert!(!client.is_alive());
    }

    struct RecordingCtx(Arc<std::sync::Mutex<Vec<CtxCall>>>);
    impl CtxCallHandler for RecordingCtx {
        fn handle(
            &self,
            call: CtxCall,
        ) -> futures::future::BoxFuture<'static, Result<Value, RpcError>> {
            let seen = Arc::clone(&self.0);
            async move {
                seen.lock().unwrap().push(call);
                Ok(json!({"systemPrompt": "test prompt"}))
            }
            .boxed()
        }
    }

    #[tokio::test]
    async fn ctx_request_routed_to_handler_and_replied() {
        let recorder = Arc::new(RecordingCtx(Arc::new(std::sync::Mutex::new(Vec::new()))));
        let (client, mut reads, mut writes, _events) =
            spawn_client(Some(Arc::clone(&recorder) as Arc<dyn CtxCallHandler>));
        // The fake sidecar answers the pending request only after making a
        // ctx call of its own, exercising the reverse direction.
        let request = spawn_request(
            &client,
            "event",
            json!({"type": "x"}),
            Duration::from_secs(5),
        );
        let msg = read_line(&mut reads).await;
        write_line_raw(
            &mut writes,
            json!({"ctxToken": "ctx-1", "method": "get_system_prompt", "params": {}}),
        )
        .await;
        let reply = read_line(&mut reads).await;
        assert_eq!(
            reply,
            json!({"ctxToken": "ctx-1", "result": {"systemPrompt": "test prompt"}})
        );
        write_line_raw(&mut writes, json!({"id": msg["id"], "result": null})).await;
        request.await.unwrap().unwrap();
        let seen = recorder.0.lock().unwrap();
        assert_eq!(seen.len(), 1);
        assert_eq!(seen[0].method, "get_system_prompt");
        assert_eq!(seen[0].ctx_token, "ctx-1");
    }

    #[tokio::test]
    async fn ctx_request_without_handler_gets_not_bound_error() {
        let (client, mut reads, mut writes, _events) = spawn_client(None);
        let request = spawn_request(
            &client,
            "event",
            json!({"type": "x"}),
            Duration::from_secs(5),
        );
        let msg = read_line(&mut reads).await;
        write_line_raw(
            &mut writes,
            json!({"ctxToken": "ctx-9", "method": "send_message", "params": {}}),
        )
        .await;
        let reply = read_line(&mut reads).await;
        assert_eq!(reply["ctxToken"], "ctx-9");
        let error = reply["error"].as_object().unwrap();
        assert!(error["message"].as_str().unwrap().contains("not bound"));
        write_line_raw(&mut writes, json!({"id": msg["id"], "result": null})).await;
        request.await.unwrap().unwrap();
    }

    #[tokio::test]
    async fn notifications_are_classified() {
        let (client, _reads, mut writes, mut events) = spawn_client(None);
        write_line_raw(
            &mut writes,
            json!({
                "method": "extension_error",
                "params": {"extensionPath": "a.ts", "event": "session_start", "error": "boom"}
            }),
        )
        .await;
        write_line_raw(
            &mut writes,
            json!({"method": "mystery", "params": {"x": 1}}),
        )
        .await;
        match events.recv().await.unwrap() {
            SidecarNotification::ExtensionError(ExtensionError {
                extension_path,
                event,
                error,
                ..
            }) => {
                assert_eq!(extension_path, "a.ts");
                assert_eq!(event, "session_start");
                assert_eq!(error, "boom");
            }
            other => panic!("expected ExtensionError, got {other:?}"),
        }
        match events.recv().await.unwrap() {
            SidecarNotification::Other { method, .. } => assert_eq!(method, "mystery"),
            other => panic!("expected Other, got {other:?}"),
        }
        drop(client);
    }
}

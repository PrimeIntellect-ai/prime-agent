//! The shared loopback harness (test-only): the fake transport, the
//! client line codec, and the guest server boot helper used by the
//! protocol battery and the engine-turn integration test.

use std::collections::VecDeque;
use std::path::Path;
use std::sync::{Arc, Mutex};
use std::time::Duration;

use pa_types::daemon::cloud::{
    cloud_request_digest, parse_cloud_message, serialize_cloud_message, CloudAck,
    CloudCommandRequest, CloudCommandState, CloudCursor, CloudGetCommand, CloudHello, CloudMessage,
    CloudSubmit,
};
use pa_types::platform::transport::{
    AcceptFuture, AsyncReadHalf, AsyncWriteHalf, TransportListener, TransportStream,
};
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::sync::Notify;

use crate::cloud_guest::dispatch::GuestExecutor;
use crate::cloud_guest::server::GuestProtocolServer;

/// The wait bound on every harness await: a hang fails fast instead of
/// stalling the battery.
pub(crate) const WAIT: Duration = Duration::from_secs(10);
pub(crate) const TEST_TOKEN: &str = "bridge-token";

// ---------------------------------------------------------------------------
// The loopback transport (the fake that stands in for the bridge)
// ---------------------------------------------------------------------------

/// The in-memory stand-in for the VM-local socket: connects hand out
/// duplex pairs whose server ends surface through the listener.
pub(crate) struct LoopbackHub {
    pending: Mutex<VecDeque<Box<dyn TransportStream>>>,
    notify: Notify,
}

impl LoopbackHub {
    #[must_use]
    pub(crate) fn new() -> Arc<Self> {
        Arc::new(Self {
            pending: Mutex::new(VecDeque::new()),
            notify: Notify::new(),
        })
    }

    /// Connect one client: the server end joins the accept queue and
    /// the client keeps the peer end.
    #[must_use]
    pub(crate) fn connect(self: &Arc<Self>) -> LoopbackClient {
        let (client_end, server_end) = tokio::io::duplex(64 * 1024);
        let mut pending = self.pending.lock().unwrap();
        pending.push_back(Box::new(DuplexTransport { stream: server_end }));
        drop(pending);
        self.notify.notify_one();
        let (read, write) = tokio::io::split(client_end);
        LoopbackClient {
            read: Box::new(read),
            write: Box::new(write),
        }
    }

    #[must_use]
    pub(crate) fn listener(self: &Arc<Self>) -> Box<dyn TransportListener> {
        Box::new(LoopbackListener {
            hub: Arc::clone(self),
        })
    }
}

struct LoopbackListener {
    hub: Arc<LoopbackHub>,
}

impl TransportListener for LoopbackListener {
    fn accept(&self) -> AcceptFuture<'_> {
        let hub = Arc::clone(&self.hub);
        Box::pin(async move {
            loop {
                let next = {
                    let mut pending = hub.pending.lock().unwrap();
                    pending.pop_front()
                };
                if let Some(stream) = next {
                    return Ok(stream);
                }
                hub.notify.notified().await;
            }
        })
    }
}

struct DuplexTransport {
    stream: tokio::io::DuplexStream,
}

impl TransportStream for DuplexTransport {
    fn split(self: Box<Self>) -> (Box<dyn AsyncReadHalf>, Box<dyn AsyncWriteHalf>) {
        let (read, write) = tokio::io::split(self.stream);
        (Box::new(read), Box::new(write))
    }
}

/// One connected bridge client: canonical frames out, validated frames
/// in.
pub(crate) struct LoopbackClient {
    read: Box<dyn AsyncReadHalf>,
    write: Box<dyn AsyncWriteHalf>,
}

impl LoopbackClient {
    /// Send one canonical frame.
    pub(crate) async fn send(&mut self, message: &CloudMessage) {
        let frame = serialize_cloud_message(message).expect("serialize client frame");
        self.write
            .write_all(format!("{frame}\n").as_bytes())
            .await
            .expect("client write");
    }

    /// Receive one frame; `None` is the server's closed connection (the
    /// drop semantics under test).
    pub(crate) async fn recv(&mut self) -> Option<CloudMessage> {
        let mut buffer = Vec::new();
        let mut chunk = [0u8; 8192];
        loop {
            let Ok(Ok(read)) = tokio::time::timeout(WAIT, self.read.read(&mut chunk)).await else {
                return None;
            };
            if read == 0 {
                return None;
            }
            buffer.extend_from_slice(&chunk[..read]);
            let Some(newline) = buffer.iter().position(|byte| *byte == b'\n') else {
                continue;
            };
            let line = String::from_utf8_lossy(&buffer[..newline])
                .trim()
                .to_string();
            let message = parse_cloud_message(&line).expect("server frame parses");
            return Some(message);
        }
    }

    /// The authenticated hello over one fresh connection.
    pub(crate) async fn hello(
        hub: &Arc<LoopbackHub>,
        token: &str,
        session_id: &str,
        generation: u64,
    ) -> (Self, Option<CloudMessage>) {
        let mut client = hub.connect();
        client
            .send(&CloudMessage::Hello(CloudHello {
                protocol_version: 3,
                generation,
                client_id: "client_test".to_string(),
                session_id: session_id.to_string(),
                auth_token: Some(token.to_string()),
                cursor: None,
                capabilities: None,
            }))
            .await;
        let first = client.recv().await;
        (client, first)
    }

    /// Submit one command and return the receipt frame's state (the
    /// admission state at submit time, distinct from completion).
    pub(crate) async fn submit(
        &mut self,
        session_id: &str,
        generation: u64,
        command_id: &str,
        request: CloudCommandRequest,
    ) -> (CloudCommandState, bool) {
        let value = serde_json::to_value(&request).expect("request value");
        let digest = cloud_request_digest(&value).expect("digest");
        self.send(&CloudMessage::Submit(CloudSubmit {
            session_id: session_id.to_string(),
            generation,
            command_id: command_id.to_string(),
            request,
            digest,
        }))
        .await;
        match self.recv().await {
            Some(CloudMessage::Command(frame)) => {
                let uncertain = frame.receipt.uncertain;
                (frame.receipt.state, uncertain)
            }
            other => panic!("expected a command frame, got {other:?}"),
        }
    }

    /// Poll one receipt until it reaches `want` (bounded).
    pub(crate) async fn await_receipt(
        &mut self,
        session_id: &str,
        generation: u64,
        command_id: &str,
        want: CloudCommandState,
    ) -> CloudCommandState {
        let deadline = std::time::Instant::now() + WAIT;
        loop {
            assert!(
                std::time::Instant::now() < deadline,
                "receipt never reached {want:?}"
            );
            self.send(&CloudMessage::GetCommand(CloudGetCommand {
                session_id: session_id.to_string(),
                generation,
                command_id: Some(command_id.to_string()),
                claim: None,
            }))
            .await;
            match self.recv().await {
                Some(CloudMessage::Command(frame)) => {
                    if frame.receipt.state == want {
                        return frame.receipt.state;
                    }
                }
                other => panic!("expected a command frame, got {other:?}"),
            }
        }
    }

    /// Acknowledge through one cursor.
    pub(crate) async fn ack(&mut self, session_id: &str, cursor: CloudCursor) {
        self.send(&CloudMessage::Ack(CloudAck {
            session_id: session_id.to_string(),
            cursor,
        }))
        .await;
    }
}

/// A prompt request value for the wire.
#[must_use]
pub(crate) fn prompt_request(text: &str) -> CloudCommandRequest {
    CloudCommandRequest::Prompt {
        text: text.to_string(),
        queue_if_busy: None,
        target_session_id: None,
    }
}

/// An open-session request value for the wire.
#[must_use]
pub(crate) fn open_request(cwd: &str) -> CloudCommandRequest {
    CloudCommandRequest::OpenSession {
        cwd: cwd.to_string(),
        model: None,
        thinking: None,
        seed_transcript_artifact: None,
        prompt: None,
        family: None,
        model_metadata: None,
    }
}

/// The `sequence` of one event value.
#[must_use]
pub(crate) fn event_sequence(event: &pa_types::daemon::cloud::CloudEvent) -> u64 {
    serde_json::to_value(event)
        .ok()
        .and_then(|value| value.get("sequence").and_then(serde_json::Value::as_u64))
        .unwrap_or_default()
}

// ---------------------------------------------------------------------------
// The guest server boot helper
// ---------------------------------------------------------------------------

/// One booted guest server: the server handle, its serving task, and
/// the loopback hub its connections arrive on.
pub(crate) struct BootedGuest {
    pub(crate) server: Arc<GuestProtocolServer>,
    pub(crate) serve: tokio::task::JoinHandle<()>,
    pub(crate) hub: Arc<LoopbackHub>,
}

/// Boot one guest server over the loopback listener (must run inside a
/// live test runtime: the serve, accept, and connection tasks spawn on
/// it).
pub(crate) fn boot_guest(
    state_dir: &Path,
    status_file: &Path,
    workspace: &str,
    session_id: &str,
    generation: u64,
    executor: Arc<dyn GuestExecutor>,
) -> BootedGuest {
    let server = Arc::new(
        GuestProtocolServer::open(
            state_dir,
            session_id,
            generation,
            TEST_TOKEN,
            status_file.to_path_buf(),
            workspace.to_string(),
            Some("faux/faux-1".to_string()),
        )
        .expect("open guest server"),
    );
    let hub = LoopbackHub::new();
    let listener = hub.listener();
    let serve = {
        let server = Arc::clone(&server);
        tokio::spawn(async move {
            let _ = server.serve(listener, executor).await;
        })
    };
    BootedGuest { server, serve, hub }
}

/// A fresh current-thread test runtime.
#[must_use]
pub(crate) fn rt() -> tokio::runtime::Runtime {
    tokio::runtime::Builder::new_current_thread()
        .enable_all()
        .build()
        .expect("test runtime")
}

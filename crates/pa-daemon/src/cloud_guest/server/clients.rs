//! Guest protocol connections (TS `CloudProtocolServer`'s client
//! half): the accept gate, the newline-framed line codec, the
//! `hello`/`subscribe`/`submit`/`get_command`/`ack` arms with their drop
//! semantics, and the snapshot/events delivery.
//!
//! One task per connection reads frames; one task per client writes
//! frames through a bounded per-client channel, so pushes from any
//! task stay ordered and a wedged client is dropped at the channel
//! bound instead of growing the guest. Every violation closes the
//! connection — the guest never argues with its bridge (TS
//! `dropClient` semantics).

use std::sync::Arc;
use std::time::Duration;

use pa_types::daemon::cloud::{
    canonical_json, parse_cloud_message, serialize_cloud_message, CloudAck, CloudCommandRequest,
    CloudCursor, CloudEvent, CloudEventsFrame, CloudGetCommand, CloudHello, CloudMessage,
    CloudSnapshot, CloudSubscribe, CLOUD_MAX_MESSAGE_BYTES, CLOUD_MAX_SNAPSHOT_EVENTS,
    CLOUD_PROTOCOL_VERSION,
};
use pa_types::platform::transport::{AsyncReadHalf, TransportStream};
use tokio::io::AsyncReadExt;
use tokio::sync::{mpsc, watch};

use crate::cloud_guest::server::GuestProtocolServer;

/// The bridge's client-table bound (TS `MAX_CLIENTS`).
pub const MAX_CLIENTS: usize = 4;
/// An unauthenticated connection must hello within this window (TS
/// `HELLO_TIMEOUT_MS`).
const HELLO_TIMEOUT: Duration = Duration::from_secs(15);
/// One snapshot/events batch budget in wire bytes (TS
/// `MAX_BATCH_BYTES`).
const MAX_BATCH_BYTES: usize = 524_288;
/// Bound on bytes buffered without a newline (TS
/// `MAX_UNFRAMED_BUFFER_BYTES`).
const MAX_UNFRAMED_BUFFER_BYTES: usize = CLOUD_MAX_MESSAGE_BYTES * 2;
/// Frames one client's writer may owe before the client is dropped (a
/// wedged bridge never grows the guest).
const MAX_PENDING_FRAMES: usize = 64;

/// One bridge connection, authenticated or not.
pub(super) struct ClientHandle {
    pub(super) id: String,
    out: mpsc::Sender<String>,
    closed: watch::Sender<bool>,
    state: std::sync::Mutex<ClientState>,
}

struct ClientState {
    authenticated: bool,
    subscribed: bool,
    last_sent_sequence: u64,
}

/// The connection's read outcome.
enum Line {
    Frame(String),
    Eof,
    Drop,
}

impl GuestProtocolServer {
    /// Accept one transport stream: register the client (the table
    /// bound rejects extras by closing them) and spawn its reader and
    /// writer.
    pub(super) fn accept_connection(self: &Arc<Self>, stream: Box<dyn TransportStream>) {
        let mut clients = self
            .clients
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner);
        if clients.len() >= MAX_CLIENTS {
            self.record_dispatch_error(&format!(
                "rejected a bridge connection: the client table is full ({})",
                clients.len()
            ));
            return;
        }
        let (read, write) = stream.split();
        let (out_tx, out_rx) = mpsc::channel(MAX_PENDING_FRAMES);
        let (closed_tx, closed_rx) = watch::channel(false);
        let handle = Arc::new(ClientHandle {
            id: format!("client_{}", uuid::Uuid::new_v4()),
            out: out_tx,
            closed: closed_tx,
            state: std::sync::Mutex::new(ClientState {
                authenticated: false,
                subscribed: false,
                last_sent_sequence: 0,
            }),
        });
        clients.insert(handle.id.clone(), Arc::clone(&handle));
        drop(clients);
        let writer_server = Arc::clone(self);
        tokio::spawn(async move {
            write_task(writer_server, out_rx, write).await;
        });
        let server = Arc::clone(self);
        tokio::spawn(async move {
            connection_task(server, handle, read, closed_rx).await;
        });
    }

    /// Remove and close one client (TS `dropClient`): idempotent, and
    /// the reader and writer observe the closed flag.
    pub(super) fn drop_client(&self, id: &str) {
        let removed = {
            let mut clients = self
                .clients
                .lock()
                .unwrap_or_else(std::sync::PoisonError::into_inner);
            clients.remove(id)
        };
        if let Some(handle) = removed {
            handle.closed.send_replace(true);
        }
    }

    /// Close every client at shutdown.
    pub(super) fn close_all_clients(&self) {
        let drained: Vec<Arc<ClientHandle>> = {
            let mut clients = self
                .clients
                .lock()
                .unwrap_or_else(std::sync::PoisonError::into_inner);
            clients.drain().map(|(_, handle)| handle).collect()
        };
        for handle in drained {
            handle.closed.send_replace(true);
        }
    }

    /// Queue one frame for a client; a full or dead channel drops the
    /// client (a wedged bridge never grows the guest).
    pub(super) fn write_line(&self, client: &ClientHandle, line: &str) {
        if client.out.try_send(format!("{line}\n")).is_err() {
            self.drop_client(&client.id);
        }
    }

    /// Push every due event to each subscribed client (TS `appendEvent`'s
    /// fan-out): a stale position resyncs from a snapshot, and a
    /// resync failure drops the client, never the guest.
    pub(super) fn push_due_events(&self) {
        let clients: Vec<Arc<ClientHandle>> = {
            let clients = self
                .clients
                .lock()
                .unwrap_or_else(std::sync::PoisonError::into_inner);
            clients.values().cloned().collect()
        };
        for client in clients {
            let subscribed = {
                let state = client
                    .state
                    .lock()
                    .unwrap_or_else(std::sync::PoisonError::into_inner);
                state.authenticated && state.subscribed
            };
            if !subscribed {
                continue;
            }
            if self.send_due(&client).is_err() {
                self.record_dispatch_error(&format!(
                    "client {} delivery failed; resyncing",
                    client.id
                ));
                if self.send_snapshot(&client).is_err() {
                    self.drop_client(&client.id);
                }
            }
        }
    }

    /// Page every event after the client's cursor (TS `sendDue`),
    /// bounded by [`CLOUD_MAX_SNAPSHOT_EVENTS`] and
    /// [`MAX_BATCH_BYTES`], looping until the tail.
    fn send_due(&self, client: &ClientHandle) -> Result<(), ()> {
        let generation = self.event_generation();
        let tail = self.tail_cursor().sequence;
        let mut last_sent = client.last_sent_sequence();
        if last_sent > tail {
            // Retention renumbered the log past this client's cursor:
            // resync from a snapshot instead of serving a stale
            // position.
            return Err(());
        }
        loop {
            let cursor = CloudCursor {
                generation,
                sequence: last_sent,
            };
            let Some(due) = self.events_after(&cursor, CLOUD_MAX_SNAPSHOT_EVENTS) else {
                return Err(());
            };
            if due.is_empty() {
                return Ok(());
            }
            let mut batch: Vec<CloudEvent> = Vec::new();
            let mut bytes = 0usize;
            for event in due {
                let size = event_wire_bytes(&event);
                if !batch.is_empty() && bytes + size > MAX_BATCH_BYTES {
                    break;
                }
                bytes += size;
                batch.push(event);
            }
            let Some(last) = batch.last().cloned() else {
                return Ok(());
            };
            let frame = CloudMessage::Events(CloudEventsFrame {
                session_id: self.session_id().to_string(),
                generation,
                events: batch,
            });
            let serialized = serialize_cloud_message(&frame).map_err(|_| ())?;
            self.write_line(client, &serialized);
            last_sent = event_sequence(&last);
            client.set_last_sent_sequence(last_sent);
            if last_sent >= tail {
                return Ok(());
            }
        }
    }

    /// Serve one client's resync snapshot (TS `sendSnapshot`): a
    /// bounded event tail after the client's position, with the cursor
    /// naming only what the snapshot actually carries. Absent
    /// `capabilities` means the v1 event stream only — this slice
    /// advertises nothing.
    fn send_snapshot(&self, client: &ClientHandle) -> Result<(), ()> {
        let generation = self.event_generation();
        let tail = self.tail_cursor().sequence;
        let last_sent = client.last_sent_sequence();
        // A pre-trim cursor beyond the renumbered tail names nothing in
        // this epoch: serve the full new log (from zero) instead of
        // clamping to the tail.
        let from = if last_sent > tail {
            0
        } else {
            last_sent.min(tail)
        };
        let mut events: Vec<CloudEvent> = Vec::new();
        let mut included_through = from;
        if tail > from {
            let cursor = CloudCursor {
                generation,
                sequence: from,
            };
            let Some(due) = self.events_after(&cursor, CLOUD_MAX_SNAPSHOT_EVENTS) else {
                return Err(());
            };
            let mut bytes = 0usize;
            for event in due {
                let size = event_wire_bytes(&event);
                if !events.is_empty() && bytes + size > MAX_BATCH_BYTES {
                    break;
                }
                bytes += size;
                included_through = event_sequence(&event);
                events.push(event);
            }
        }
        let frame = CloudMessage::Snapshot(CloudSnapshot {
            session_id: self.session_id().to_string(),
            generation,
            cursor: CloudCursor {
                generation,
                sequence: included_through,
            },
            status: self.status(),
            state: self.session_state(),
            events,
            capabilities: None,
        });
        let serialized = serialize_cloud_message(&frame).map_err(|_| ())?;
        client.set_subscribed(false);
        client.set_last_sent_sequence(included_through);
        self.write_line(client, &serialized);
        Ok(())
    }
}

impl ClientHandle {
    fn last_sent_sequence(&self) -> u64 {
        self.state
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner)
            .last_sent_sequence
    }

    fn set_last_sent_sequence(&self, sequence: u64) {
        self.state
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner)
            .last_sent_sequence = sequence;
    }

    fn set_subscribed(&self, subscribed: bool) {
        self.state
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner)
            .subscribed = subscribed;
    }

    fn authenticated(&self) -> bool {
        self.state
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner)
            .authenticated
    }

    fn set_authenticated(&self) {
        self.state
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner)
            .authenticated = true;
    }
}

/// The per-client writer: drain the bounded channel onto the transport.
/// A transport failure ends the writer; the connection task frees the
/// slot because the same peer hangup that failed the write makes the
/// read half return EOF (the connection task's drop runs at that
/// break), and a subscribed client is dropped by the next
/// `write_line`, whose send on the dropped receiver fails.
async fn write_task(
    server: Arc<GuestProtocolServer>,
    mut out: mpsc::Receiver<String>,
    mut write: Box<dyn pa_types::platform::transport::AsyncWriteHalf>,
) {
    use tokio::io::AsyncWriteExt;
    while let Some(line) = out.recv().await {
        if write.write_all(line.as_bytes()).await.is_err() {
            server.record_dispatch_error("client transport write failed");
            break;
        }
    }
}

/// One connection's read loop: the hello deadline, the line codec, the
/// frame arms, and the exit cleanup.
async fn connection_task(
    server: Arc<GuestProtocolServer>,
    client: Arc<ClientHandle>,
    mut read: Box<dyn AsyncReadHalf>,
    mut closed: watch::Receiver<bool>,
) {
    let mut shutdown = server.shutdown_rx.clone();
    let mut buffer: Vec<u8> = Vec::new();
    // The first frame must be an authenticated hello within the
    // deadline (TS's helloTimer).
    let Ok(Ok(first)) = tokio::time::timeout(
        HELLO_TIMEOUT,
        read_line(&mut read, &mut buffer, client.authenticated()),
    )
    .await
    else {
        server.drop_client(&client.id);
        return;
    };
    match first {
        Line::Frame(frame) => {
            if !handle_frame(&server, &client, &frame) {
                server.drop_client(&client.id);
                return;
            }
        }
        Line::Eof | Line::Drop => {
            server.drop_client(&client.id);
            return;
        }
    }
    loop {
        let authenticated = client.authenticated();
        let line = tokio::select! {
            line = read_line(&mut read, &mut buffer, authenticated) => line,
            changed = closed.changed() => {
                let _ = changed;
                break;
            }
            changed = shutdown.changed() => {
                let _ = changed;
                break;
            }
        };
        match line {
            Ok(Line::Frame(frame)) => {
                if !handle_frame(&server, &client, &frame) {
                    break;
                }
            }
            Ok(Line::Eof | Line::Drop) | Err(_) => break,
        }
    }
    server.drop_client(&client.id);
}

/// Read one newline-framed line, bounded exactly like TS
/// `onClientData`: a pre-auth buffer larger than one frame is dropped,
/// a framed buffer larger than two frames is dropped, and a line
/// decodes only once its `\n` byte arrived, so a multibyte UTF-8
/// sequence split across chunks stays intact.
///
/// # Errors
///
/// Returns the transport's read error.
async fn read_line(
    read: &mut Box<dyn AsyncReadHalf>,
    buffer: &mut Vec<u8>,
    authenticated: bool,
) -> Result<Line, std::io::Error> {
    loop {
        if let Some(newline) = buffer.iter().position(|byte| *byte == b'\n') {
            let line: Vec<u8> = buffer.drain(..=newline).collect();
            let frame = String::from_utf8_lossy(&line[..line.len() - 1])
                .trim()
                .to_string();
            if frame.is_empty() {
                continue;
            }
            return Ok(Line::Frame(frame));
        }
        let cap = if authenticated {
            MAX_UNFRAMED_BUFFER_BYTES
        } else {
            CLOUD_MAX_MESSAGE_BYTES
        };
        if buffer.len() > cap {
            return Ok(Line::Drop);
        }
        let mut chunk = [0u8; 8192];
        let read_bytes = read.read(&mut chunk).await?;
        if read_bytes == 0 {
            return Ok(Line::Eof);
        }
        buffer.extend_from_slice(&chunk[..read_bytes]);
    }
}

/// Route one frame; `false` drops the connection (TS `handleMessage`'s
/// default and violation arms).
fn handle_frame(server: &Arc<GuestProtocolServer>, client: &ClientHandle, frame: &str) -> bool {
    let Ok(message) = parse_cloud_message(frame) else {
        return false;
    };
    match message {
        CloudMessage::Hello(hello) => handle_hello(server, client, &hello),
        CloudMessage::Subscribe(subscribe) => handle_subscribe(server, client, &subscribe),
        CloudMessage::Submit(submit) => handle_submit(
            server,
            client,
            submit.generation,
            submit.command_id,
            &submit.request,
        ),
        CloudMessage::GetCommand(get) => handle_get_command(server, client, &get),
        CloudMessage::Ack(ack) => handle_ack(server, client, &ack),
        // The guest of this slice has no broker wiring: authenticated
        // frames are consumed; the brokered-inference port owns them.
        CloudMessage::InferenceRequest(_)
        | CloudMessage::InferenceEvent(_)
        | CloudMessage::InferenceEnd(_)
        | CloudMessage::InferenceError(_) => client.authenticated(),
        // The server never receives snapshot/events/command.
        CloudMessage::Snapshot(_) | CloudMessage::Events(_) | CloudMessage::Command(_) => false,
    }
}

/// The hello arm (TS `handleHello`): the protocol version, the session
/// id, the sandbox generation, and a timing-safe token compare gate
/// authentication; a cursor from the same event-log generation resumes
/// replay, anything older resnapshots from zero.
fn handle_hello(
    server: &Arc<GuestProtocolServer>,
    client: &ClientHandle,
    hello: &CloudHello,
) -> bool {
    if hello.protocol_version != CLOUD_PROTOCOL_VERSION {
        return false;
    }
    if hello.session_id != server.session_id() || hello.generation != server.generation() {
        return false;
    }
    let token = hello.auth_token.as_deref().unwrap_or("");
    if !timing_safe_equal(token.as_bytes(), server.token().as_bytes()) {
        return false;
    }
    client.set_authenticated();
    let tail = server.tail_cursor().sequence;
    let mut last_sent = tail;
    if let Some(cursor) = &hello.cursor {
        last_sent = if cursor.generation == server.event_generation() {
            cursor.sequence.min(tail)
        } else {
            0
        };
    }
    client.set_last_sent_sequence(last_sent);
    client.set_subscribed(false);
    server.send_snapshot(client).is_ok()
}

/// The subscribe arm (TS `handleSubscribe`): a cursor beyond the tail
/// is a violation; a cursor from another generation resnapshots; the
/// same generation goes live from the cursor.
fn handle_subscribe(
    server: &Arc<GuestProtocolServer>,
    client: &ClientHandle,
    subscribe: &CloudSubscribe,
) -> bool {
    if !client.authenticated() {
        return false;
    }
    if subscribe.cursor.sequence > server.tail_cursor().sequence {
        return false;
    }
    if subscribe.cursor.generation != server.event_generation() {
        client.set_subscribed(false);
        return server.send_snapshot(client).is_ok();
    }
    client.set_last_sent_sequence(subscribe.cursor.sequence);
    client.set_subscribed(true);
    if server.send_due(client).is_err() {
        client.set_subscribed(false);
        return server.send_snapshot(client).is_ok();
    }
    true
}

/// The submit arm (TS `handleSubmit`): the generation fence, then the
/// journal admission. The receipt frame is written between the
/// command-accepted and command-state events, exactly like TS.
fn handle_submit(
    server: &Arc<GuestProtocolServer>,
    client: &ClientHandle,
    generation: u64,
    command_id: String,
    request: &CloudCommandRequest,
) -> bool {
    if !client.authenticated() {
        return false;
    }
    // Submits fence on the sandbox generation like hello; the event-log
    // generation never gates control traffic (TS handleSubmit).
    if generation != server.generation() {
        return false;
    }
    let Ok(request_value) = serde_json::to_value(request) else {
        return false;
    };
    let write_frame = |frame: &str| {
        server.write_line(client, frame);
    };
    server
        .admit_submit(&command_id, &request_value, &write_frame)
        .is_some()
}

/// The `get_command` arm (TS `handleGetCommand`): a read-only receipt
/// poll. A claim is refused — the guest's own dispatch loop claims
/// through the journal, never through the wire.
fn handle_get_command(
    server: &Arc<GuestProtocolServer>,
    client: &ClientHandle,
    get: &CloudGetCommand,
) -> bool {
    if !client.authenticated() || get.generation != server.generation() {
        return false;
    }
    if get.claim == Some(true) {
        return false;
    }
    let Some(command_id) = &get.command_id else {
        return false;
    };
    let Some(receipt) = server.poll_receipt(command_id) else {
        return false;
    };
    server.write_line(client, &server.command_frame(&receipt));
    true
}

/// The ack arm (TS `handleAck`): a stale-generation ack names positions
/// retention already renumbered and is ignored; a cursor problem drops
/// the client.
fn handle_ack(server: &Arc<GuestProtocolServer>, client: &ClientHandle, ack: &CloudAck) -> bool {
    if !client.authenticated() {
        return false;
    }
    if ack.cursor.generation != server.event_generation() {
        return true;
    }
    server.acknowledge(&ack.cursor).is_ok()
}

/// Constant-time compare with the TS byte-length precheck (the length
/// itself is public on the wire).
fn timing_safe_equal(a: &[u8], b: &[u8]) -> bool {
    if a.len() != b.len() {
        return false;
    }
    let mut diff = 0u8;
    for (x, y) in a.iter().zip(b.iter()) {
        diff |= x ^ y;
    }
    diff == 0
}

/// The canonical wire size of one event, plus the newline (the wire
/// bound is UTF-8 bytes, not characters).
fn event_wire_bytes(event: &CloudEvent) -> usize {
    serde_json::to_value(event)
        .ok()
        .and_then(|value| canonical_json(&value).ok())
        .map_or(0, |canonical| canonical.len() + 1)
}

/// The `sequence` field of one event.
fn event_sequence(event: &CloudEvent) -> u64 {
    serde_json::to_value(event)
        .ok()
        .and_then(|value| value.get("sequence").and_then(serde_json::Value::as_u64))
        .unwrap_or_default()
}

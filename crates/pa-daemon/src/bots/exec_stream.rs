//! The exec carrier: a started sandbox process's stdio presented as the
//! duplex halves the bot link speaks the daemon protocol over.
//! Two duplex bridges carry the bytes — stdout events flow into one end,
//! stdin writes flow out the other — so the client's plain async
//! read/write loops drive a remote process with no custom poll code.

use pa_sandbox::command_session::{CommandSessionEvent, InputChannel, OutputChannel, VmSignal};
use pa_sandbox::transport::SandboxTransport;
use pa_sandbox::vm_process::{
    CommandSessionClient, CommandSessionOptions, GatewayAuthSource, PlatformGatewayAuthSource,
    SendInputOptions, SendSignalOptions, StartOptions,
};
use pa_sandbox::PrimeSandboxClient;
use tokio::io::{AsyncReadExt, AsyncWriteExt, DuplexStream};

/// One sandbox's gateway credentials, fetched through the lifecycle client.
pub struct SandboxAuthSource {
    client: std::sync::Arc<PrimeSandboxClient>,
    sandbox_id: String,
}

impl SandboxAuthSource {
    #[must_use]
    pub fn new(client: std::sync::Arc<PrimeSandboxClient>, sandbox_id: String) -> Self {
        Self { client, sandbox_id }
    }

    /// A fresh command-session client bound to this sandbox's gateway.
    ///
    /// # Errors
    ///
    /// Returns the error when the sandbox id is malformed or the client
    /// cannot be built.
    pub fn command_client(
        &self,
    ) -> anyhow::Result<
        CommandSessionClient<
            pa_sandbox::ReqwestSandboxTransport,
            PlatformGatewayAuthSource<pa_sandbox::ReqwestSandboxTransport>,
        >,
    > {
        let auth = PlatformGatewayAuthSource::new(
            std::sync::Arc::clone(&self.client),
            self.sandbox_id.clone(),
        )?;
        Ok(CommandSessionClient::new(
            auth,
            CommandSessionOptions::default(),
        )?)
    }
}

/// The started process's stdio as transport halves: reading consumes its
/// stdout, writing feeds its stdin pipe.
#[must_use]
pub struct ExecStreamHalves {
    pub read: tokio::io::DuplexStream,
    pub write: tokio::io::DuplexStream,
}

/// Start one exec process and bridge its stdio to duplex halves. The
/// returned stream ends are live until the process ends (EOF closes the
/// read half); dropping the write half terminates the process.
///
/// # Errors
///
/// Returns the command-session error when the process cannot start.
pub async fn spawn_exec_halves(
    auth_source: &SandboxAuthSource,
    request: &pa_sandbox::command_session::StartRequest,
    options: StartOptions,
) -> anyhow::Result<ExecStreamHalves> {
    let client = auth_source
        .command_client()
        .map_err(|error| anyhow::anyhow!("{error}"))?;
    let mut stream = client.start(request, options).await?;
    let session_uuid = request.session_uuid.clone();
    let (stdout_read, mut stdout_write) = tokio::io::duplex(64 * 1024);
    let (stdin_read, stdin_write) = tokio::io::duplex(64 * 1024);

    // stdout: Data events flow into the client-visible end.
    tokio::spawn(async move {
        loop {
            match stream.next_event().await {
                Some(Ok(CommandSessionEvent::Data { channel, data })) => {
                    if channel == OutputChannel::Stdout
                        && stdout_write.write_all(&data).await.is_err()
                    {
                        break;
                    }
                }
                Some(Ok(CommandSessionEvent::Start { .. } | CommandSessionEvent::Keepalive)) => {}
                Some(Ok(CommandSessionEvent::End(_)) | Err(_)) | None => break,
            }
        }
    });

    // stdin: client writes flow to the process's stdin pipe (a second
    // client from the same gateway-auth source).
    let write_client = auth_source
        .command_client()
        .map_err(|error| anyhow::anyhow!("{error}"))?;
    tokio::spawn(pump_stdin(stdin_read, write_client, session_uuid));

    Ok(ExecStreamHalves {
        read: stdout_read,
        write: stdin_write,
    })
}

/// Feed the client's writes to the process's stdin pipe until the client
/// drops its write half or a write fails, then terminate the process.
/// sandboxd cannot close a process's stdin, and dropping the event
/// stream leaves the process running: without the signal every attach
/// leaks its relay, and the stdout task's gateway stream with it.
async fn pump_stdin<T, A>(
    mut stdin: DuplexStream,
    client: CommandSessionClient<T, A>,
    session_uuid: String,
) where
    T: SandboxTransport + 'static,
    A: GatewayAuthSource + 'static,
{
    let mut buffer = [0u8; 8192];
    loop {
        match stdin.read(&mut buffer).await {
            Ok(0) | Err(_) => break,
            Ok(read) => {
                let data = &buffer[..read];
                if client
                    .send_input(
                        &session_uuid,
                        InputChannel::Stdin,
                        data,
                        SendInputOptions::default(),
                    )
                    .await
                    .is_err()
                {
                    break;
                }
            }
        }
    }
    if let Err(error) = client
        .send_signal(
            &session_uuid,
            VmSignal::Terminate,
            SendSignalOptions::default(),
        )
        .await
    {
        eprintln!("pa-daemon: terminating exec process {session_uuid} failed: {error}");
    }
}

#[cfg(test)]
mod tests {
    use std::future::Future;
    use std::sync::{Arc, Mutex};

    use pa_sandbox::transport::{
        ResponseChunks, StreamedResponse, TransportRequest, TransportResponse,
    };
    use pa_sandbox::{CommandSessionError, GatewayAuth, SandboxError};

    use super::*;

    /// A gateway that acknowledges every control RPC and records each
    /// RPC's method name in call order.
    struct RecordingGateway(Arc<Mutex<Vec<String>>>);

    impl SandboxTransport for RecordingGateway {
        fn execute(
            &self,
            _request: TransportRequest,
        ) -> impl Future<Output = Result<TransportResponse, SandboxError>> + Send {
            std::future::ready(Err(SandboxError::network(
                "control RPCs read a streamed response",
            )))
        }

        fn execute_streaming(
            &self,
            request: TransportRequest,
        ) -> impl Future<Output = Result<StreamedResponse, SandboxError>> + Send {
            let method = request.url.rsplit('/').next().unwrap_or_default();
            self.0.lock().unwrap().push(method.to_string());
            std::future::ready(Ok(StreamedResponse {
                status: 200,
                headers: vec![("content-type".to_string(), "application/proto".to_string())],
                body: ResponseChunks::Queued(std::collections::VecDeque::new()),
            }))
        }
    }

    struct FixedAuth;

    impl GatewayAuthSource for FixedAuth {
        fn get_auth(
            &self,
        ) -> impl Future<Output = Result<GatewayAuth, CommandSessionError>> + Send {
            std::future::ready(Ok(GatewayAuth {
                sandbox_id: "sb-1".to_string(),
                gateway_url: "https://gateway.test".to_string(),
                user_namespace: "ns".to_string(),
                job_id: "job".to_string(),
                token: "token".to_string(),
                expires_at: "2099-01-01T00:00:00Z".to_string(),
            }))
        }
    }

    #[tokio::test]
    async fn dropping_the_write_half_terminates_the_process_after_its_input() {
        let methods = Arc::new(Mutex::new(Vec::new()));
        let client = CommandSessionClient::with_transport(
            RecordingGateway(Arc::clone(&methods)),
            FixedAuth,
            CommandSessionOptions::default(),
        )
        .unwrap();
        let (stdin_read, mut stdin_write) = tokio::io::duplex(64);
        let pump = tokio::spawn(pump_stdin(
            stdin_read,
            client,
            uuid::Uuid::new_v4().to_string(),
        ));
        stdin_write.write_all(b"{}\n").await.unwrap();
        drop(stdin_write);
        pump.await.unwrap();
        assert_eq!(*methods.lock().unwrap(), ["SendInput", "SendSignal"]);
    }
}

# pa-sandbox

The Prime Sandboxes client: the lifecycle half (idempotent create,
fetch, delete, wait-until-running) plus the per-sandbox gateway data
path (the gateway credential fetch, authenticated batch exec, multipart
upload, bounded download) and the ConnectRPC `command_session` stream
client VM process execution uses. Port of `prime-sandbox-client.ts`,
`command-session-proto.ts`, and `vm-process-client.ts` (TS branch
`feat/direct-cloud-sandbox`), cross-checked against the live
`prime_sandboxes` SDK, the sandboxd service, and the platform backend
wire contract.

## Scope

Lifecycle (platform REST, the user's Prime API key):

- Create (`POST /api/v1/sandbox`): `snake_case` body, `vm: true` forced,
  fresh UUID `idempotency_key` when unset, client-side retries of
  transient (network/timeout) failures reusing the same server-side key
  (a retried create can never provision a second sandbox).
- Fetch (`GET /api/v1/sandbox/{id}`): strict `camelCase` record with
  `snake_case` egress lists; a malformed 200 body is a typed
  `invalid_response` error, never a silent default.
- Delete (`DELETE /api/v1/sandbox/{id}`): idempotent; a 404 is success.
- Wait: poll fetch until `RUNNING`; terminal status fails fast with the
  redacted platform error in `details`; the wait budget fails with
  `timeout` carrying the last observed status.

Gateway data path (the sandbox-bound gateway token; container exec, VM
upload/download):

- Auth (`POST /api/v1/sandbox/{id}/auth`): strict `snake_case` body;
  the returned gateway origin must be https (or loopback `http` with the
  explicit opt-in), credential-free, query-free, with URL-safe
  namespace/job segments — including for caller-provided credentials (a
  reviewed hardening over the TS module, which validates only
  platform-returned ones).
- Exec (`POST {gateway}/{ns}/{job}/exec`): `snake_case` body
  (`command`, `sandbox_id`, `timeout`, optional `working_dir`, `env`,
  `user`); the request deadline covers the command budget plus
  transport overhead; container sandboxes only — VM execution goes
  through the `command_session` stream.
- Upload (`POST {gateway}/{ns}/{job}/upload?path=...&sandbox_id=...`):
  a multipart body byte-shaped exactly like the TS `FormData` emits
  (one `file` part, no per-part content type, WHATWG filename escaping);
  payloads bounded to 200 MiB, rejected before any byte is sent.
- Download (`GET {gateway}/{ns}/{job}/download?path=...&sandbox_id=...`):
  raw bytes streamed under the 200 MiB cap; an over-cap `content-length`
  declaration fails before the body is read.

Command session (ConnectRPC `command_session.CommandSession`, VM
process execution, hand-rolled protobuf — no codegen dependency):

- Start/Connect are server-streaming RPCs: one enveloped proto request
  frame (`application/connect+proto`), StartResponse/ConnectResponse
  event frames, terminated by a Connect end-of-stream JSON frame; the
  first start event resolves the returned stream (the pid lives on it).
- A Start whose stream faults before its start event re-issues with
  byte-identical request bytes (create-or-attach, the resident-launch
  primitive); after it, reattach uses Connect. Keepalives are transport
  liveness only and are not yielded; exactly one end event closes the
  stream; frames over the 4 MiB default cap abort it.
- SendInput/SendSignal/Update are unary RPCs (`application/proto`, the
  Connect deadline header); input and signal UUIDs make duplicates
  at-most-once on the server; transient faults retry with identical
  bytes; 401/unauthenticated re-auths exactly once per operation.
- `Connect-Timeout-Ms` on Start is also the sandboxd process deadline
  (`0` disables it); `Keepalive-Ping-Interval` paces sandboxd's
  keepalive events.
- Release detaches without touching the process — the only ways to
  affect it are the explicit control RPCs.

Safety contract (TS parity): no secret (API key, gateway token) ever
appears in an error message, URL, or `details` preview; every response
is strictly validated; all URL segments derived from platform data are
validated before use; and the transport refuses redirects, so an
authenticated platform or gateway call never hops origins.

Reviewed deviations from the TS modules, all documented in the module
docs:

- Redirects are refused at the transport (the TS rides global `fetch`,
  which follows them).
- The command-session stream resolves on the start event and does not
  re-yield it through the consumer stream (TS yields it once); TS's
  separate `exit` promise collapses into the ordered event stream.
- `expires_at`/`timestamp` wire strings are validated non-empty, not
  date-parsed (the crate carries no datetime dependency).
- End-of-stream error messages and command-session error bodies are
  redacted against the gateway token (the TS trusts the peer not to
  echo credentials).
- The unary `application/proto` deadline covers the open only (TS
  leaves the body read unbounded); malformed unary bodies fail strict
  validation.
- The auth refresh seam takes the client's uncached
  `PlatformGatewayAuthSource`; callers own caching (TS contract).

## Non-goals

- Guest runtime orchestration (workspace snapshot, result import,
  delegation records, tunnel bridging — the TS `direct-cloud-service.ts`
  side); the resident guest daemon and cloud spawn are the consuming
  lanes' work.
- Container (non-VM) sandbox creates: this slice forces `vm: true`.
- The `region` field: not caller-selectable for VM sandboxes; the Rust
  request type makes it unrepresentable instead of runtime-rejected.
- Response fields with no consumer (the `environmentVars`/`secrets`
  echo, `diskMountPath`, `kubernetesJobId`, `registryCredentialsId`,
  `pendingImageBuildId`) — added with their consumer.

## Public API

- `PrimeSandboxClient<T: SandboxTransport = ReqwestSandboxTransport>`
  (`new`, `with_transport`, `create_vm_sandbox`, `get_sandbox`,
  `delete_sandbox`, `wait_for_running`, `get_sandbox_auth`,
  `exec_container_command`, `upload_file`, `download_file`),
  `ClientOptions`, `DEFAULT_BASE_URL`
- `SandboxTransport` (buffered `execute` + `execute_streaming`),
  `TransportRequest`, `TransportResponse`, `StreamedResponse`,
  `ResponseChunks`, `ReqwestSandboxTransport`
- `GatewayAuth`, `GatewayOptions`, `ExecRequest`, `ExecResult`,
  `UploadRequest`, `UploadResult`, `MAX_TRANSFER_BYTES`,
  `MAX_EXEC_TIMEOUT_SECONDS`
- `CommandSessionClient` (`start`, `connect`, `send_input`,
  `send_signal`, `resize`), `CommandSessionStream` (`pid`, `release`,
  `is_released`, `next_event`), `GatewayAuthSource`,
  `PlatformGatewayAuthSource`, `CommandSessionOptions`, `StartOptions`,
  `StreamOptions`, `ControlOptions`, `SendInputOptions`,
  `SendSignalOptions`
- `command_session::StartRequest`, `CommandSpec`, `PtySize`,
  `InputChannel`, `VmSignal`, `CommandSessionEvent`, `EndEvent`, the
  strict request encoders, the event-response decoder, and
  `proto::ConnectFrameDecoder` + `encode_connect_frame`
- `SandboxError`, `SandboxErrorCode`, `CommandSessionError`,
  `CommandSessionErrorCode`

## Dependencies (direction compliance)

Depends on no workspace crate. External: reqwest (rustls-tls), serde +
serde_json (preserve_order), thiserror, tokio, url, uuid. Consumers:
the cloud-sandbox attach lanes (`pa-daemon` supervisor and, later,
`pa-core` session-engine delegation).

## Tests

- In-module unit tests: redaction/preview scrubbing, status parsing,
  base-URL safety, egress entry validation, create validation, create
  body field order, strict record parsing, multipart shape and
  filename escaping, gateway credential validation, auth/exec/upload
  response parsing, proto goldens and strictness, UUID canonicalization,
  frame decoding across chunk boundaries, code maps and fault
  classification.
- `tests/lifecycle.rs`: scripted in-process transport — wire shapes
  (URLs, headers, `snake_case` create body, `vm: true`, idempotency key
  reuse across retries, team scoping), status mapping, delete 404
  tolerance, wait semantics, no-retry on HTTP errors.
- `tests/transport_loopback.rs`: the real reqwest transport against a
  scripted loopback HTTP server — header fidelity, 408/409/502
  mapping, deadline abort, connection failure, bounded response reads.
- `tests/gateway_loopback.rs`: the real transport against a loopback
  gateway — the auth wire, the exact exec/upload/download request
  shapes (multipart bytes, query encoding), 408/409/502 mapping,
  redirect refusal with a recording redirect target (the token never
  hops), error-preview redaction, credential validation, the scaled
  exec deadline.
- `tests/command_session_loopback.rs`: the real transport against a
  loopback ConnectRPC server — the exact Start/Connect/SendInput/
  SendSignal/Update wire (URLs, headers, envelope, hand-built golden
  proto bytes), the event stream contract (start resolves the pid;
  data; end; keepalives skipped), end-of-stream error mapping,
  compressed/oversize frame refusal, 401 token refresh, unary retries
  with identical bytes, the create-or-attach re-Start, mid-stream
  Connect reattach, and release (no signal, no reattach).

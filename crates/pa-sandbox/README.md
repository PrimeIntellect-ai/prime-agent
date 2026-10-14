# pa-sandbox

The Prime Sandboxes lifecycle client: idempotent create, fetch, delete,
and wait-until-running for VM-backed sandboxes on the Prime platform.
Port of the lifecycle half of `prime-sandbox-client.ts` (TS branch
`feat/direct-cloud-sandbox`), cross-checked against the live
`prime_sandboxes` SDK and the platform backend wire contract.

## Scope

- Create (`POST /api/v1/sandbox`): snake_case body, `vm: true` forced,
  fresh UUID `idempotency_key` when unset, client-side retries of
  transient (network/timeout) failures reusing the same server-side key
  (a retried create can never provision a second sandbox).
- Fetch (`GET /api/v1/sandbox/{id}`): strict camelCase record with
  snake_case egress lists; a malformed 200 body is a typed
  `invalid_response` error, never a silent default.
- Delete (`DELETE /api/v1/sandbox/{id}`): idempotent; a 404 is success.
- Wait: poll fetch until `RUNNING`; terminal status fails fast with the
  redacted platform error in `details`; the wait budget fails with
  `timeout` carrying the last observed status.
- Error contract: typed codes wire-identical to the TS set (408 ->
  `request_timeout`, 409 -> `conflict`, gateway 502
  `sandbox_not_found`), bounded (512 chars) secret-scrubbed `details`
  previews; no secret ever appears in a message, URL, or preview.
- Transport: one injected `SandboxTransport` trait (RPITIT), a reqwest
  production implementation (rustls-tls, per-request deadlines, bounded
  streaming response reads, redirects refused so an authenticated call
  never hops origins), everything injected — no environment
  reads, no `~/.prime`.

## Non-goals

- The per-sandbox gateway (auth, batch exec, upload, download) and the
  ConnectRPC `command_session` stream VM execution uses.
- Guest runtime orchestration (workspace snapshot, result import,
  delegation, tunnel bridging — the TS `direct-cloud-service.ts` side).
- Container (non-VM) sandboxes: this slice forces `vm: true`.
- The `region` field: not caller-selectable for VM sandboxes; the Rust
  request type makes it unrepresentable instead of runtime-rejected.
- Response fields with no lifecycle consumer (the `environmentVars`/
  `secrets` echo, `diskMountPath`, `kubernetesJobId`,
  `registryCredentialsId`, `pendingImageBuildId`) — added with their
  consumer.

## Public API

- `PrimeSandboxClient<T: SandboxTransport = ReqwestSandboxTransport>`
  (`new`, `with_transport`, `create_vm_sandbox`, `get_sandbox`,
  `delete_sandbox`, `wait_for_running`), `ClientOptions`,
  `DEFAULT_BASE_URL`
- `SandboxTransport`, `TransportRequest`, `TransportResponse`,
  `ReqwestSandboxTransport`
- `VmCreateRequest`, `StartCommand`, `Sandbox`, `SandboxStatus`,
  `WaitOptions`, `PRIME_SANDBOX_CREATE_MAX_ATTEMPTS`
- `SandboxError`, `SandboxErrorCode`

## Dependencies (direction compliance)

Depends on no workspace crate. External: reqwest (rustls-tls), serde +
serde_json (preserve_order), thiserror, tokio, url, uuid. Consumers:
the cloud-sandbox attach lanes (`pa-daemon` supervisor and, later,
`pa-core` session-engine delegation).

## Tests

- In-module unit tests: redaction/preview scrubbing, status parsing,
  base-URL safety, egress entry validation, create validation, create
  body field order, strict record parsing.
- `tests/lifecycle.rs`: scripted in-process transport — wire shapes
  (URLs, headers, snake_case create body, `vm: true`, idempotency key
  reuse across retries, team scoping), status mapping, delete 404
  tolerance, wait semantics, no-retry on HTTP errors.
- `tests/transport_loopback.rs`: the real reqwest transport against a
  scripted loopback HTTP server — header fidelity, 408/409/502
  mapping, deadline abort, connection failure, bounded response reads.

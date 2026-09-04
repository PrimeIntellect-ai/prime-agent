# Sandbox-backed sessions walking skeleton plan

Status: proposed replacement for draft PR #2040

This plan starts with one useful path and makes it work before adding recovery and workspace features.

A Home daemon receives `sandbox: true`, creates one Prime Sandbox, installs the same Prime Agent release, starts a remote child, proxies one model request, and deletes the sandbox. Home owns every credential and every provider operation. The sandbox receives no provider or model credential.

The implementation stays disabled until the final evidence gate passes.

## Branch and pull request policy

- PR #1970 owns the Bun runtime work. This branch does not modify it.
- The new sandbox branch is temporarily based on the reviewed head of PR #1970.
- It will rebase onto `main` after PR #1970 lands.
- PR #2040 remains an archive while the replacement is built.
- The replacement imports accepted code by module and test, not by copying the full PR #2040 history.
- Rejected provider, SSH, runner, relay, and workspace candidates are not copied.
- Each accepted layer is pushed as a small commit so GitHub shows the actual state.

## V1 user contract

`rlm.run` accepts one new value:

```ts
sandbox: boolean
```

The rules are fixed:

- Omitted `sandbox` and `sandbox: false` keep current behavior.
- A non-boolean value throws `rlm.run sandbox must be a boolean`.
- Until activation, `sandbox: true` throws `Sandbox execution is not available for this session` before any effect.
- V1 has no region, VM, GPU, registry, environment, secret, network, or quality-of-service options.
- Public execution metadata is only `{ type: "prime-sandbox" }`.
- One sandbox-backed parent session owns one Prime Sandbox. Its descendants use the same hosted runtime.
- Deleting the owning session deletes the descendants and then the Prime Sandbox.

## Trust boundary

Home owns:

- user and session identity
- authorization
- provider API credentials
- model credentials and model selection
- billing
- sandbox allocation and deletion
- durable recovery records
- the runtime release and its digests
- the encrypted application connection
- message and observation policy
- workspace history

The sandbox receives:

- the public runtime release
- a public release manifest
- a public bootstrap program
- Home's public session key
- the user workspace needed by the remote child
- provider-neutral requests and model responses after the encrypted connection is ready

The sandbox never receives:

- the Prime API key
- a gateway bearer token; Home sends it only as HTTPS authorization to the gateway
- a model API key
- a provider URL or provider identity in the agent protocol
- Home's real session directory
- an unencrypted session prompt or message on a provider control-plane channel

Prime Sandbox is trusted to provide the requested container. The application protocol does not claim remote attestation. It detects stale endpoints, replay, accidental substitution, and peers that do not hold the expected keys.

## End-to-end flow

### 1. Admission

Home validates the complete `rlm.run` argument object. It rejects accessors, symbols, proxies, inherited fields, unknown keys, and malformed values without invoking them.

Only after validation may Home reserve a child name or read credentials.

### 2. Ownership inspection

Home recovers its private ownership record, if one exists. It then reads every page of the provider list with strict response validation.

The result is one of these states:

- no matching resource, with a nominal create permission
- exactly one owned matching resource, with a nominal handle
- blocked because the response is malformed, incomplete, unknown, or ambiguous

Any recognized non-terminated match blocks a second allocation. `PENDING`, `PROVISIONING`, and `PAUSED` are not ready, but they still block creation.

### 3. Allocation

Home creates one CPU-only container with an exact image digest. The image must contain Python 3.11 and the certificate roots needed for HTTPS. The Bun runtime is supplied by the Prime Agent release, not installed from a package registry.

V1 omits `--vm` and every GPU or network-policy option. The lifecycle code records ownership before later setup work begins.

### 4. Runtime artifacts

Home prepares and verifies these public artifacts:

- the official Prime Agent Linux release archive
- its canonical entry manifest
- a bounded Python 3.11 bootstrap bundle containing the accepted verifier and extractor
- a small per-session trust document containing only public keys, protocol version, and release digests

The producer binds every archive entry by path, type, mode, size, and SHA-256. The consumer applies the same limits.

Home uploads large files with a bounded streaming multipart body. It never allocates the complete compressed archive or decompressed tar in memory.

### 5. Direct provider HTTPS

Home uses direct certificate-validated HTTPS for auth, upload, command execution, port exposure, exposure listing, and unexpose.

The adapter follows the exact `prime-sandboxes==0.2.40` routes and response shapes. It keeps the control-plane origin separate from the gateway origin.

Rules:

- API-key auth is used only on the control plane.
- Short-lived gateway auth is held in memory and used only for the matching gateway request.
- Auth, upload, exec, and expose are never retried after dispatch.
- Redirects are errors.
- Deadlines cover request upload, response headers, response body, cancellation, and settlement.
- Response reads are bounded.
- Any failure after dispatch is ambiguous unless a complete terminal HTTP response was read.
- Errors have fixed codes and contain no URL, path, token, provider response, or exception text.
- Closing the adapter aborts and observes every in-flight operation. Unsettled cleanup retains retry authority.

### 6. Extraction and launch

Home runs one fixed bootstrap command. It contains no dynamic value or secret.

The Python bootstrap:

1. opens uploaded artifacts without following symlinks
2. checks type, owner, mode, link count, size, identity, and digest
3. parses the canonical manifest with bounded strict JSON
4. verifies the compressed archive in a first streaming pass
5. extracts it in a second streaming pass
6. claims the final private root directly with mode `0700`
7. revalidates the complete directory and file identity set
8. transfers control to the one manifest-bound Prime Agent executable

The current Python extractor is reusable, but its capability must gain one narrow launch operation. It must not return a raw file descriptor or path to general application code.

The exact Linux container test decides whether Python can execute the verified file descriptor. If the pinned image cannot do that, the implementation records the fixed-path same-UID race and does not claim it is closed by a PID or container heuristic.

### 7. Runtime process

The extracted Prime Agent binary has two private modes:

- a short launcher that the provider exec call waits for
- a detached runtime peer that owns TCP port `9443`

The peer creates its own Ed25519 and X25519 keys. Private key material never crosses argv, environment, stdin, a provider response, or a file.

The launcher returns only a bounded signed public readiness record. The record binds:

- protocol version
- Home public key
- runtime public key
- archive digest
- manifest digest
- launcher binary digest
- a fresh nonce

The exact parent and peer rendezvous is selected only after a Bun 1.4.0 Linux process test proves both facts:

- provider exec receives a complete readiness record and returns
- the peer remains alive and owns port `9443`

A signed public readiness file is acceptable if pipe closure cannot be proven. A bind collision is terminal. The launcher does not retry or select another port.

### 8. Exposure and connection

Home exposes TCP port `9443` through the control plane. It treats the returned endpoint as private provider state.

Home connects to the endpoint. The sandbox does not connect to a Home loopback address.

The application handshake uses:

- Ed25519 signatures for peer proof
- fresh X25519 keys for each connection
- HKDF-SHA256 with protocol and transcript separation
- AES-256-GCM for frames
- independent send and receive keys
- monotonic 64-bit counters
- fresh nonces and replay rejection
- a final READY and ACK exchange

The handshake binds the public readiness record and both connection keys. A failed or ambiguous handshake closes the exposure and deletes the sandbox.

### 9. Home model proxy

The remote runtime sends a provider-neutral model request over the encrypted application connection.

Home checks:

- the hosted session is active
- the request belongs to that session
- the model is allowed by the Home session policy
- request and output bounds
- cancellation state
- relay sequence and direction

Home then calls the normal model adapter with credentials already held on Home. The sandbox sees model output but no credential or provider-specific request envelope.

The walking skeleton is not complete until one real agent turn uses this path.

### 10. Hosted child port

Remote children receive exactly:

```ts
Readonly<{ hostedPort: HostedRlmRuntimePort }>
```

They do not receive an `AgentSession`, daemon handle, provider handle, or Home path.

The hosted port supports only authorized operations needed by the remote child. Home owns child IDs, names, recursion limits, model policy, and durable routing.

### 11. Messaging and observation

Messages and observations travel through the ordered encrypted relay.

- Direction is checked before state changes.
- The ordered relay alone creates acknowledgements.
- Sequence gaps, duplicate frames, stale generations, and replay are rejected.
- Message delivery checks the trusted inbox policy on Home.
- Observation returns bounded public session data. It never returns provider state or raw errors.

Direct agent-to-agent communication still passes through Home authorization and routing.

### 12. Workspace synchronization

PAWS is added after the model-proxy walking skeleton works.

Home is the durable source of truth. The runtime applies bounded revisions over the authenticated connection.

The verifier rejects:

- absolute paths and traversal
- links and special files
- normalized duplicates
- unsupported modes
- excessive file counts or sizes
- digest mismatch
- stale or skipped revisions
- incomplete application

Checkpoint completion is part of clean shutdown.

### 13. Restart recovery

Home persists only the minimum private recovery state with strict ownership and mode checks.

After a Home restart it:

1. validates the ownership journal
2. performs a complete provider inspection
3. proves that exactly one matching sandbox still exists
4. validates the stored runtime public identity and release generation
5. reconnects with Home's durable private identity
6. restores hosted routing without allocating another sandbox

Missing, corrupt, or uncertain evidence blocks both recovery and creation until cleanup is resolved.

### 14. Deletion

Deletion order is fixed:

1. stop new work
2. checkpoint and synchronize workspace state
3. request runtime shutdown
4. close relay and application connection
5. close the sandbox listener
6. unexpose the TCP port
7. prove exposure absence
8. delete the Prime Sandbox
9. prove provider absence with a complete list
10. delete hosted ledger state
11. remove the ownership and session registry records

A timeout or transport ambiguity retains private cleanup authority. It does not report successful deletion.

## Pull request sequence

### PR A: walking skeleton

Deliver:

- imported and reviewed lifecycle, ownership, release, extraction, and dispatch foundations
- exact direct HTTPS adapter
- bounded streaming upload
- fixed extraction and launcher composition
- authenticated application connection
- `HostedRlmRuntimePort` with one provider-neutral model request
- strict shutdown and provider deletion
- local fake-provider and exact Linux container integration tests

`sandbox_sessions` stays disabled in this PR.

### PR B: remote session behavior

Deliver:

- hosted child creation and execution
- ordered relay
- direct agent-to-agent communication
- observation
- cancellation
- cascading child shutdown

### PR C: workspace, recovery, and activation

Deliver:

- PAWS publication and application
- durable hosted recovery
- restart without duplicate allocation
- crash and cleanup-ambiguity tests
- one controlled CPU-only Prime Sandbox run
- verified unexpose, deletion, and absence
- capability advertisement after every gate passes

## Reuse map

Code from PR #2040 may be imported only after its focused tests pass on the new base.

| Area | Action |
| --- | --- |
| Boolean dispatch | Reuse |
| Prime CLI 0.6.21 codecs | Reuse |
| Lifecycle and strict inspection | Reuse |
| Ownership journal | Reuse |
| Ownership deletion composition | Reuse |
| Bounded command runner | Reuse |
| Release manifest producer | Reuse |
| Python archive verifier | Reuse |
| Python fd-relative extractor | Reuse and extend narrowly |
| Monolithic HTTPS adapter | Reject |
| Standalone codec package candidate | Review, then rewrite in coding-agent if useful |
| Standalone HTTPS transport candidate | Review, then rewrite in coding-agent if useful |
| SSH bootstrap | Reject |
| Legacy workspace sync | Reject |
| Old provider and relay compositions | Use as review notes only |

## Test policy

Development uses focused tests for the changed layer.

Full validation runs at these points:

- before PR A becomes ready for review
- after its final rebase
- before the controlled provider run
- before capability activation

Required integration tests:

- fake HTTPS control plane and gateway with exact routes
- streaming a release-size file without full buffering
- timeout and cancellation during upload and response read
- Linux Python 3.11 archive extraction into a hostile filesystem fixture
- Bun launcher return with peer survival
- mutual-authentication success and replay rejection
- one provider-neutral model request through Home
- deletion after every injected failure boundary
- Home restart with exactly one existing resource
- workspace revision apply and checkpoint

Tests may not skip, weaken, or replace a failing check. The project uses Bun 1.4.0 for TypeScript checks, builds, and tests.

## Controlled provider run gate

The one paid CPU-only run is allowed only when all local tests above pass and review has accepted:

- exact provider routes and codecs
- auth lifetime handling
- bounded upload and exec bodies
- runtime process survival
- exposure endpoint handling
- encrypted channel handshake
- Home model proxy
- shutdown and unexpose
- provider deletion and complete absence proof
- recovery records and cleanup retry authority

The run records bounded redacted evidence. It creates no VM or GPU. All run data needed for later analysis is stored before resource shutdown, without storing secrets or private provider state.

## Activation gate

Advertise `sandbox_sessions` only after:

- PRs A through C are integrated
- hosted CI passes
- the controlled run completes one agent turn
- Home restarts and recovers the same session without allocation
- messaging, observation, and workspace synchronization pass
- deleting the session removes the exposure and sandbox
- a complete provider list proves absence
- secret scanning finds no credential in sandbox files, process arguments, environment, logs, evidence, or public DTOs

Until then, `sandbox: true` remains fail-closed.

# Supervisor shutdown authority

## Context

A coordinated daemon upgrade restored the intended workers and supervisor, but
an obsolete inactive interactive client remained alive with an older wire
schema. When the upgraded daemon became idle, that client classified it as
stale, sent the legacy unauthenticated `shutdown` command, and raced other
clients and workers to replace it. An obsolete generation won the race and then
failed to recover one intended session under the already-fixed lease race.

The public daemon socket is user-local, but connection access alone must not be
authority to terminate whichever supervisor happens to own that path. A client
may decide to replace only the exact supervisor identity it observed during the
handshake.

## Goals

- Prevent legacy or stale clients from terminating a newer supervisor.
- Bind public shutdown and restart to the exact supervisor observed on the same connection.
- Keep stale classification, idleness checking, and termination on that one connection.
- Fail closed when authority is missing, incomplete, rejected, or stale.
- Preserve new-client replacement of a legacy supervisor during upgrades.
- Keep explicit and automatic termination callers behind `DaemonClient` methods.
- Add regression coverage for missing, matching, mismatched, and rejected authority.

## Non-goals

- Authenticating arbitrary operating-system users beyond existing socket
  permissions.
- Replacing the update-restart ownership protocol.
- Changing worker-local shutdown commands.
- Automatically restarting interactive client processes during an update.
- Treating build identifiers as compatibility boundaries.

## Considered approaches

### Operational cleanup only

Stopping obsolete clients before every restart restores service but leaves the
same rollback mechanism available after the next upgrade or dormant client
reconnection. This is insufficient.

### Exact compare-and-shutdown authority

Require public supervisor shutdown requests to echo the full identity received
in `daemon_hello`. This is the selected design because it closes the rollback
race at the terminating process, remains deterministic, and needs no new secret.

### Authenticated shutdown capability

Issuing a new secret capability would also block legacy clients, but introduces
secret lifecycle, persistence, and recovery complexity without improving the
same-connection compare-and-set property needed here. This is deferred.

## Authority contract

The existing handshake already publishes the durable supervisor identity:

- supervisor generation;
- durable owner token;
- process id;
- process start identity;
- normalized supervisor socket path.

Public `shutdown` and `restart` commands gain an optional wire field containing
that exact identity. It stays optional in the wire type solely for forward
upgrade compatibility with legacy supervisors. The authority shape itself
requires all five fields, including a non-empty process-start identity. A modern
hello missing any field cannot produce authority and therefore cannot authorize
termination.

A new supervisor requires the field for either public termination command and
compares every supplied component to its current durable ownership record before
scheduling shutdown or restart. Missing, malformed, incomplete, or mismatched
authority returns a normal failed response and leaves the supervisor, workers,
descriptors, and socket untouched. The `force` flag changes worker-drain
behavior only; it never bypasses authority.

The comparison happens synchronously in command handling before the success
response and before `setImmediate` schedules shutdown. The server reasserts its
current durable ownership while validating so a generation that has already
lost ownership cannot accept termination commands.

## Compatibility

`DaemonClient` derives termination authority from its own received hello at send
time; callers cannot supply a hello from another connection:

- When the handshake contains the complete modern identity, the client includes
  it in shutdown or restart.
- When connected to a legacy supervisor whose handshake lacks any required
  component, the client emits the legacy command without authority. The legacy
  supervisor accepts it, preserving forward upgrade replacement.
- A schema-16 supervisor already publishes complete identity. The new client
  sends the authority-bearing shape, which its tolerant old parser accepts.
- A legacy client talking to a new supervisor emits no authority. The new
  supervisor rejects it, preventing rollback.

The commands change the monotonic schema revision to 18 and update the schema
identifier without changing the protocol major version. Shutdown and restart
remain legacy-compatible commands so a new client may send the authority-
optional shapes to an older supervisor; only the new supervisor enforces the
field. Worker-local shutdown continues to use its authenticated internal path.

## Production callers

All public termination paths use `DaemonClient` methods rather than constructing
commands from detached hellos:

- explicit CLI shutdown and restart, including force;
- stale-daemon replacement;
- process/status cleanup utilities;
- update and test cleanup paths that target the public supervisor.

Stale replacement keeps the version verdict, busy-session query, authority, and
shutdown request on one connection. It never reconnects after classifying a
daemon stale; a disconnect aborts replacement so a successor cannot inherit the
previous owner's stale verdict.

The supervisor's command to a resident worker remains unguarded because it is
sent over the authenticated private worker channel and terminates that worker,
not the public supervisor.

## Error handling

Authority rejection is fail-closed and side-effect free. The response names a
stable authority error suitable for tests and diagnostics without disclosing a
replacement token. Client wait logic treats rejection as “still running” and
does not launch a replacement.

Process cleanup represents graceful termination with a structured outcome.
`shutdown_authority_rejected` is terminal: even with `force`, cleanup protects
the supervisor plus every tracked worker and child identity/socket from direct
cleanup and residual convergence. It does not signal them, remove their sockets,
or delete their descriptors. Only timeout or unavailability may enter the
existing exact-process fallback.

If the connected daemon disappears before a response, the existing wait-for-gone
logic handles the uncertain disconnect. A normal failed response is terminal
`false`, even if the rejecting process exits independently afterward. Version
classification and authority remain on the original connection, eliminating the
probe-to-shutdown TOCTOU.

## Tests

Focused protocol and supervisor regressions cover:

1. Legacy shutdown and restart without authority are rejected by a new
   supervisor and the same identity remains reachable.
2. A command echoing the exact handshake identity is accepted and terminates
   that supervisor.
3. Each mismatched component—and authority missing process-start identity—is
   rejected without shutdown.
4. `force` cannot bypass authority at the server or convert rejection into
   signal fallback, tracked-worker cleanup, or residual worker termination.
5. A new client can shut down or restart both an identity-less legacy fixture
   and a schema-16 fixture that publishes full identity and accepts new fields.
6. Stale classification, list, and shutdown use one connection; rejection is
   terminal even if the daemon exits independently afterward.
7. Public CLI and process cleanup callers include authority, while private
   worker shutdown remains functional.

Validation uses isolated socket, descriptor, agent, and session namespaces. No
daemon-capable suite runs against the live runtime.

## Activation and recovery

After review and validation, publish the new PR head, integrate it into the
aggregate build in an isolated worktree, and activate it with a coordinated
restart. Before activation, retire only processes proven to be obsolete and
unattached; preserve the current root transcript and frozen plugin transcript.
The empty unattached draft worker may be passivated.

Recovery succeeds only when the activated supervisor identity is verified, the
root session is restored, the plugin has one live worker under its saved session
identity, its current authority has no unresolved tool calls, and its journal is
idle. Resume the plugin from its saved Task 14 checkpoint without replaying
prior tools.

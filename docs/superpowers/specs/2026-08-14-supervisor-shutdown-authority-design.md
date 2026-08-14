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

- Prevent legacy or stale clients from shutting down a newer supervisor.
- Bind shutdown to the exact supervisor observed on the same connection.
- Fail closed when authority is missing, incomplete, or stale.
- Preserve new-client replacement of a legacy supervisor during upgrades.
- Keep explicit and automatic shutdown callers on one shared command builder.
- Add regression coverage for missing, matching, and mismatched authority.

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

A public `shutdown` command gains an optional wire field containing that exact
identity. It stays optional in the TypeScript wire type solely for forward
upgrade compatibility with legacy supervisors.

A new supervisor requires the field and compares every supplied component to
its current durable ownership record before scheduling shutdown. Missing,
malformed, incomplete, or mismatched authority returns a normal failed response
and leaves the supervisor, workers, descriptors, and socket untouched. The
`force` flag changes worker-drain behavior only; it never bypasses authority.

The comparison happens synchronously in command handling before the success
response and before `setImmediate` schedules shutdown. The server reasserts its
current durable ownership while validating so a generation that has already
lost ownership cannot accept termination commands.

## Compatibility

A shared client helper derives shutdown authority from `DaemonClient.hello`:

- When the handshake contains the complete modern identity, the helper includes
  it in the command.
- When connected to a legacy supervisor whose handshake lacks any required
  component, the helper emits the legacy command without authority. The legacy
  supervisor accepts it, preserving forward upgrade replacement.
- A legacy client talking to a new supervisor emits no authority. The new
  supervisor rejects it, preventing rollback.

The command changes the monotonic schema revision and schema identifier. It does
not change the protocol major version. Shutdown remains classified as a legacy-
compatible command so a new client may send the authority-optional wire shape
to an older supervisor; only the new supervisor enforces the field. Worker-
local shutdown continues to use its existing internal path.

## Production callers

All public shutdown paths use the shared helper rather than constructing the
command independently:

- explicit CLI shutdown, including force;
- stale-daemon replacement;
- process/status cleanup utilities;
- update and test cleanup paths that target the public supervisor.

The supervisor's command to a resident worker remains unguarded because it is
sent over the authenticated private worker channel and terminates that worker,
not the public supervisor.

## Error handling

Authority rejection is fail-closed and side-effect free. The response names a
stable authority error suitable for tests and diagnostics without disclosing a
replacement token. Client wait logic treats a rejected shutdown as “still
running” and does not launch a replacement.

If the connected daemon disappears between handshake and command, the existing
wait-for-gone logic handles the disconnect. Authority must never be copied from
a separate probe connection because that would reintroduce a time-of-check /
time-of-use race.

## Tests

Focused protocol and supervisor regressions cover:

1. A legacy shutdown without authority is rejected by a new supervisor and the
   same supervisor identity remains reachable.
2. A command echoing the exact handshake identity is accepted and terminates
   that supervisor.
3. Each mismatched component—generation, owner token, pid, process start, and
   socket path—is independently rejected without shutdown.
4. `force` cannot bypass missing or mismatched authority.
5. A new client can still shut down a legacy fixture whose handshake lacks the
   authority fields.
6. Automatic stale-daemon replacement does not launch after the guarded
   supervisor rejects an obsolete client.
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

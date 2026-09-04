# Sandbox-backed Prime Agent sessions execution plan

Status: approved on 2026-09-04  
Owner: Prime Agent  
Tracking issue: RES-1264  
Archived predecessor: `SANDBOX_SESSIONS_PLAN_HISTORY_2026-09-04.md` in the session artifacts

## Product objective

A request with `sandbox: true` must create a complete Prime Agent child session inside a Prime Sandbox. Home keeps identity, authorization, provider credentials, billing, lifecycle control, durable routing, artifacts, workspace orchestration, and physical deletion.

The required product flow is:

1. Home receives `sandbox: true`.
2. Home creates one Prime Sandbox.
3. Home installs or uploads the exact Prime Agent runtime.
4. Home starts that runtime inside the sandbox.
5. The sandbox agent communicates with Home.
6. Model requests are proxied through Home. Provider credentials never enter the sandbox.
7. Messaging, observation, and workspace synchronization work across the connection.
8. Home recovers the same session after a restart without creating another sandbox.
9. Deleting the session also deletes the Prime Sandbox and all private hosted state.

## Non-negotiable safety rules

- Bun 1.4.0 is the primary development, check, test, build, and runtime workflow.
- The clean stack is based on the updated Bun primary-runtime branch, then current `main`.
- `sandbox=false` remains behavior-compatible.
- `sandbox:true` continues to return exactly `Sandbox execution is not available for this session` until the complete stack passes its evidence matrix.
- Do not advertise `sandbox_sessions` before final activation.
- Do not expose sandbox IDs, regions, credentials, grants, paths, URLs, provider handles, the real session directory, prompts, messages, or exceptions through public DTOs or evidence APIs.
- Public execution metadata is only `{type:"prime-sandbox"}`.
- Home is the only owner of physical sandbox deletion.
- Never synthesize or cast an `AgentSession` for a remote child.
- Sandbox bootstrap credentials are one-time, scoped, bounded, and transferred through a private stream, not argv or environment.
- All external calls and cleanup operations are bounded.
- Large workspace contents use PAWS streaming, not JSON or base64 relay frames.
- Every paid end-to-end run is explicit, bounded, fully harvested, and verified deleted.

## Branch and PR strategy

PR #2025 remains an archive until the replacement stack reproduces the accepted behavior. Do not force-push or extend it.

1. Update PR #1970, `feat/bun-primary-runtime`, against current `main` and restore green CI.
2. Create a new clean sandbox integration branch from that Bun tip.
3. Move code from PR #2025 only after file-level review. Do not merge or cherry-pick the full historical branch.
4. Deliver the feature as a stacked set of reviewable PRs.
5. Close PR #2025 only after the replacement stack has full behavior and evidence.

## Source triage policy

Every sandbox-related file from PR #2025 receives one decision:

- **Keep and fix now:** needed by the next vertical slice, production-reachable, and locally testable.
- **Rewrite:** the concept is needed but the implementation violates the current contract or platform behavior.
- **Defer:** useful only after the basic remote child works.
- **Remove:** obsolete, conflicting, rejected, duplicated, or test-only code without meaningful behavior.

No file enters the clean stack without a production caller, a current purpose, behavior tests, explicit ownership, and a bounded cleanup path.

Immediate expected decisions:

- Keep and fix the public option contract, execution metadata, Prime CLI lifecycle adapter, tunnel manager, SSH process handling, bootstrap payload, and private framing.
- Rewrite Prime CLI parsing, the production command runner, ownership persistence, the hosted runtime factory, provider application composition, and invalid constructor branding.
- Defer durable relay recovery, advanced messaging recovery, observation persistence, PAWS, and restart recovery until the walking skeleton works.
- Remove `workspace-sync.ts`, its obsolete isolated test, historical experiments, redundant copy-only tests, and rejected composition candidates.
- Keep the messaging and trusted-inbox stash out of the stack until the basic runtime and Home relay work.

## Prime platform contract for v1

The first implementation uses the Prime CLI on Home through an argv-only runner.

- Establish and test an explicit supported Prime CLI version range.
- Parse the documented JSON schema for that supported version.
- Use container sandboxes because the current launch path requires Prime SSH.
- Record the container and unrestricted-egress tradeoff in the threat model.
- Do not enable idle timeout because SSH does not refresh it.
- Use a finite total lifetime as a cleanup backstop.
- Never pass model-provider credentials with `--env` or `--secret`.
- Transfer only a one-time relay/bootstrap credential through SSH stdin.
- Use a lifecycle-derived, non-secret provider label for discovery.
- Decide native API idempotency versus label reconciliation before restart support.
- Respect the documented 200 MB per-file upload limit.

## Milestone 1: Bun base and plan cleanup

Deliverables:

- PR #1970 updated against current `main`.
- `bun install --frozen-lockfile` passes with Bun 1.4.0.
- `bun run check` passes.
- Conflict-focused tests pass.
- This concise plan replaces the stale progress ledger in the clean sandbox branch.
- The old plan is archived outside the review path.

## Milestone 2: Prime Sandbox lifecycle

Covers product steps 1 and 2.

Deliverables:

- Production argv-only `CommandRunner`.
- Exact Prime CLI preflight and version compatibility result.
- Current JSON parsers for list and get.
- Create, get, wait, logs, upload, download, run, and delete operations needed by the runtime.
- Durable pre-admission before provider creation.
- Discovery and reconciliation through a derived label.
- Idempotent deletion and a basic orphan cleanup path.
- Capability remains disabled.

Acceptance:

- Fake tests cover success, cancellation, timeout, malformed output, provider uncertainty, duplicate discovery, and delete-not-found.
- Fixtures match the supported Prime CLI schema.
- Allocation uncertainty never causes a blind second create.
- Public results contain no provider details.

## Milestone 3: Runtime installation and launch

Covers product steps 3 and 4.

Deliverables:

- Exact Linux runtime package and manifest.
- Manifest includes Prime Agent version and commit, Bun version, target OS and architecture, protocol version, and artifact hashes.
- Upload strategy keeps every file within Prime limits.
- Sandbox-side verification before launch.
- SSH remote wrapper receives one bounded bootstrap frame on stdin.
- The wrapper launches the real runtime with a private FD3 credential channel.
- Versioned READY handshake.
- Real internal reserved-mode dispatch replaces `ORCHESTRATION_UNAVAILABLE`.
- Capability remains disabled.

Acceptance:

- Wrong hashes, versions, architecture, protocol, truncated input, extra input, and failed launch all fail before activation.
- Partial installation and launch failures have proven cleanup.
- Secrets do not appear in argv, environment, logs, or provider metadata.

## Milestone 4: Home communication and provider proxy

Covers product steps 5 and 6.

Deliverables:

- Authenticated Home listener and Prime Tunnel.
- Sandbox-to-Home connection with one-time admission.
- Side-specific ingress and impossible-direction rejection before mutation.
- One remote child run request and result.
- Provider requests execute only on Home.
- Cancellation durability precedes `proxy.cancel`.
- Bounded disconnect and shutdown.
- Capability remains disabled.

Acceptance:

- One sandbox child completes an agent turn through the Home provider proxy.
- No provider secret exists in sandbox environment, files, metadata, logs, process arguments, or evidence output.
- Disconnects never report false success.

## Milestone 5: Messaging and observation

Covers the messaging and observation part of product step 7.

Deliverables:

- `agent_message` communication for hosted children.
- Family listing and direct agent-to-agent communication.
- Hosted observation text and status events.
- Authorization and durable trusted-inbox admission are serialized.
- Ordered relay exclusively generates domain acknowledgements.
- Accepted side-domain frames enter the ordered relay.
- Capability remains disabled.

Acceptance:

- Authorized messages survive disconnect and replay once.
- Unauthorized or impossible-direction frames cause no mutation.
- Observation exposes no private hosted state.

## Milestone 6: PAWS workspace synchronization

Completes product step 7.

Deliverables:

- Remove `workspace-sync.ts` and its obsolete test.
- Construction-bound private workspace and verifier roots.
- Immutable PAWS artifact publication and application.
- Initial Home-to-sandbox transfer.
- Checkpoint transfer.
- Final sandbox-to-Home sync.
- Path-free operation DTOs and results.
- Bounded streaming for large contents.
- Capability remains disabled.

Acceptance:

- Traversal, symlink, race, malformed archive, duplicate path, oversized file, and cleanup failures fail safely.
- Publication is atomic and no-overwrite.
- Every temporary and owned byte copy is erased and verified.
- Workspace changes survive final sync without leaking Home paths.

## Milestone 7: Restart recovery

Covers product step 8.

Deliverables:

- Separate immutable hosted-child ledger with only `parentSessionId`, `sessionId`, `childId`, and `lifecycleKey`.
- Separate `.spawn` and `.delete` records.
- Home restart reconstruction from trusted records.
- Provider label reconciliation before unrelated validation.
- Relay, provider call, messaging, observation, and workspace recovery.
- No duplicate sandbox after restart.
- Capability remains disabled.

Acceptance:

- Kill Home during create, activation, provider execution, message delivery, checkpoint, and deletion.
- Restart either recovers the same sandbox or reports bounded uncertainty.
- No test path creates a second sandbox for the same lifecycle.

## Milestone 8: Complete deletion and activation

Covers product step 9.

Required cleanup order:

1. Checkpoint and final workspace sync.
2. Shut down the sandbox runtime.
3. Close relay, listener, and tunnel.
4. Physically delete the Prime Sandbox.
5. Verify lifecycle and platform deletion.
6. Persist deletion proof.
7. Delete hosted-child ledger state.
8. Remove the session registry entry.

Deliverables:

- Reverse-acquisition owner close with identity-based alias deduplication.
- Physical delete remains owned by the Home runtime host.
- Orphan reaper for stale provisioning and incomplete deletion.
- Complete error and uncertainty policy.
- Capability advertisement only after the full evidence matrix passes.

## Controlled Prime Sandbox end-to-end test

No paid resource is created until milestones 2 through 4 pass locally.

The authorized controlled run uses:

- one CPU-only container sandbox
- no GPU
- finite total timeout
- no unnecessary exposed sandbox ports
- one exact runtime installation
- one Home-proxied model request
- one remote child result
- explicit evidence capture before cleanup
- bounded shutdown and physical deletion
- post-delete provider verification

Save all lifecycle events, sanitized command results, manifests, relay evidence, workspace evidence, and deletion proof before stopping or deleting the run. Never store secrets.

## Final evidence matrix

The feature is done only when one scenario proves all of the following:

1. Create a Home session.
2. Create a sandbox child.
3. Confirm exactly one Prime Sandbox exists.
4. Confirm the child runtime executes inside it.
5. Send and receive a message.
6. Perform a Home-proxied model request.
7. Observe the child through the public observation contract.
8. Modify workspace files in the sandbox.
9. Restart Home.
10. Recover the same child without allocating another sandbox.
11. Complete the child task.
12. Sync workspace changes back.
13. Delete the session.
14. Confirm the Prime Sandbox, tunnel, credentials, journals, temporary artifacts, and workspace staging data are gone.
15. Run the full Bun suite and security, crash, secret, orphan, workspace, and deletion matrices.

Only after all fifteen checks pass may the implementation advertise `sandbox_sessions` and accept public `sandbox:true` execution.

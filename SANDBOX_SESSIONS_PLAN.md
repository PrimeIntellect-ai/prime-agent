# Sandbox-backed Prime Agent sessions implementation plan

## Objective

Add `sandbox=False` by default to top-level session and RLM subagent creation. When enabled, Prime Agent creates a Prime Sandbox, runs the agent runtime and local tools there, keeps provider credentials on the home daemon, and preserves lifecycle, session discovery, observation, and direct agent-to-agent communication across the remote boundary.

## Fixed design decisions

- The home daemon owns identity, family authorization, provider authentication, session catalog state, sandbox billing, and durable archives.
- The sandbox owns the live agent loop, IPython kernel, workspace, and processes.
- Model calls use a typed streaming home-provider proxy. Provider keys and OAuth refresh tokens never enter the sandbox.
- Prime Sandboxes use an outbound authenticated relay transport. A later generic-host adapter may use OpenSSH `ControlMaster`; mosh is not a control transport.
- Agent activity (`running`, `idle`, `inactive`) is separate from connection state (`connecting`, `connected`, `reconnecting`, `unreachable`, `closed`).
- Direct agent-to-agent communication remains limited to parent, siblings, and children and is durable across reconnects.
- Every explicit `sandbox=True` creates a fresh sandbox. Descendants with `sandbox=False` remain on their current execution host.
- The home daemon checkpoints transcripts and workspace changes before it deletes an owned sandbox.

## Dependency graph

```mermaid
graph TD
  A[Architecture and contracts] --> B[Location-neutral hosted subagent]
  A --> C[Remote wire protocol]
  A --> D[Home provider proxy]
  A --> E[Prime Sandbox adapter]
  A --> F[Workspace transfer]
  B --> G[RLM sandbox API]
  C --> G
  D --> G
  E --> G
  B --> H[Top-level sandbox sessions]
  C --> H
  D --> H
  E --> H
  C --> I[Remote messaging and observation]
  B --> I
  F --> J[Checkpoint and safe sync-back]
  E --> J
  G --> K[Catalog and Agents View]
  H --> K
  I --> K
  J --> L[Passivation, wake, and deletion]
  K --> L
  G --> M[Integration and security tests]
  H --> M
  I --> M
  L --> M
  M --> N[Documentation, cleanup, and PR]
```

## Parallel work topology

Status values are `queued`, `in_progress`, `blocked`, `review`, and `done`.

### Wave 1: independent architecture audits

| ID | Status | Work package | Output |
|---|---|---|---|
| A01 | done | Current RLM child lifecycle and concrete `AgentSession` coupling | Refactor seam report recovered |
| A02 | done | Daemon protocol capability and compatibility requirements | Wire-change report recovered |
| A03 | done | Agent connection DTO and remote path assumptions | Remote DTO report received |
| A04 | done | Provider registry, streaming, cancellation, and auth flow | Provider-proxy report recovered |
| A05 | done | Prime Sandbox SDK, lifecycle, bootstrap, and image constraints | SDK v0.2.35 adapter report received |
| A06 | done | Direct agent-to-agent communication routing and delivery guarantees | Messaging report received |
| A07 | done | Observation, transcript, recap, and usage attribution | Observation report recovered |
| A08 | done | Session catalog, passivation, rehydration, and deletion | Lifecycle report received |
| A09 | done | Agents View status and connection-state presentation | UI report received |
| A10 | done | Workspace snapshot and conflict-safe sync-back | Workspace report recovered |
| A11 | done | Top-level session creation APIs and CLI integration | Integration points recovered from transcript |
| A12 | done | Python RLM bridge and public API compatibility | RLM API report received |
| A13 | done | Test harnesses and protocol compatibility coverage | Test topology report received |
| A14 | done | Security threat model and secret-exposure audit | Threat model received |
| A15 | done | Runtime packaging, exact-build bootstrap, and update behavior | Packaging report received |
| A16 | done | Failure injection, reconnect, idempotency, and recovery behavior | Recovery report received |

### Wave 2: implementation packages

Wave 2 begins after the related Wave 1 contracts are integrated. Each package uses an isolated worktree and produces a cherry-pickable commit.

| ID | Depends on | Status | Work package |
|---|---|---|---|
| B01 | A01, A03 | done | Add `ExecutionLocation` and opaque remote session DTOs |
| B02 | A01, A07 | in_progress | Introduce location-neutral `HostedSubagent` and preserve local behavior |
| B03 | A02, A16 | in_progress | Exact remote protocol, frame/journal codecs, delivery index, immutable publication, and bounded recovery |
| B04 | A02, A16 | in_progress | Replace the initial relay with ordered durable receipt/delivery handling |
| B05 | A04, A14 | done | Add typed streaming home-provider proxy |
| B06 | A05, A15 | done | Add Prime Sandbox provisioner and background-job lifecycle |
| B07 | A10, A14 | done | Add Git workspace snapshot and safe sync-back |
| B08 | A12, B01, B02 | queued | Add `sandbox` and `sandbox_options` to RLM APIs |
| B09 | A11, B01, B03 | done | Add top-level sandbox session creation APIs and CLI flags |
| B10 | A06, B03, B04 | in_progress | Route durable direct agent-to-agent communication across hosts |
| B11 | A07, B03, B04 | in_progress | Mirror observation, transcript, recap, and usage events |
| B12 | A08, B03, B06 | done | Add sandbox lifecycle, checkpoint, passivation, wake, and deletion |
| B13 | A09, B01, B11 | done | Show execution location and connection health in Agents View |
| B14 | B05, B06, B08, B09 | in_progress | Wire end-to-end sandbox session orchestration |
| B15 | A13, B03, B04 | done | Add protocol compatibility and reconnect tests |
| B16 | A13, B05, B10, B11 | queued | Add auth, messaging, observation, and security integration tests |

### Wave 3: integration and release readiness

| ID | Depends on | Status | Work package |
|---|---|---|---|
| C01 | B01-B16 | in_progress | Integrate source-reviewed commits in dependency order and resolve shared-file conflicts |
| C02 | C01 | in_progress | Run focused suites and `npm run check` after each accepted integration; final pass remains pending |
| C03 | C01 | queued | Run a real Prime Sandbox smoke test without paid model calls where possible |
| C04 | C02, C03 | queued | Audit secret handling, orphan cleanup, and final workspace sync |
| C05 | C04 | queued | Update README, API docs, changelog, and migration notes |
| C06 | C05 | queued | Independent PR cleanup and regression review |
| C07 | C06 | queued | Push branch and open GitHub PR |
| C08 | C07 | queued | Verify PR diff, checks, and unresolved review threads |

## Current integration baseline

- Branch: `feat/sandbox-backed-sessions` in `/Users/milkkarten/prime-agent-sandbox-sessions`.
- Reviewed integration tip: `4a8962b54`.
- Latest full root `npm run check` is green across 1007 files, TypeScript, Biome, installer rendering, and browser smoke.
- Accepted B03 foundations: exact frame codec `55b40d7f1`, journal-record codec `5551582bd`, delivery index `5e8e926b4`, direct-final immutable journal publication `8bd83db6c`, and immutable delivery-marker publication `df846c08f`.
- Accepted B11 foundations: observation core `939a7baaf`, exact snapshots `62e8b073a`.
- Accepted B14 foundations: provider client `2195c7a23`, tunnel manager `a636f7d99`, PAB1 `d21f53c1a`, FD3 reader `723a8db52`, PAAR codec `a17f5588d`, stdin frame reader `4beeaa5da`, TypeScript correction `1d63a72c0`, SSH spawn specification `4dd8790db`, SSH specification tests `af83a786f`/`a7add61a4`, one-use upgrade authentication `a4976298c`, and Node stdin normalization `4a8962b54`.
- Active B03 work: a clean one-list-call paginated recovery scanner. Ordered relay and B10 durable communication wait for accepted recovery.
- Active B14 work: credential-frame write ownership, SSH readiness/cleanup, trusted-tree PAAR builder, streaming PAAR verifier, one-open PAAR installer, offline runtime packaging, and listener/server/orchestration on top of accepted upgrade authentication.
- Active B02 work: hosted runtime boundary correction using the accepted remote frame and observation types without changing local runtime behavior.
- Rejected commits remain isolated and unmerged. This includes `a772e27a`, `f1f5cad9`, `35fb1c61`, `d7b56367`, `bce99cd9`, and `610c696c` plus their earlier rejected chains.
- No paid sandbox, tunnel, VM, GPU, or live provider resource has been created during the resource-free implementation stage.

## Integration rules

- Subagents never edit the shared integration worktree directly.
- Each implementation package receives its own Git worktree and branch.
- The integration owner cherry-picks reviewed commits in dependency order.
- Daemon protocol changes must be capability-gated and include old/new compatibility tests.
- Provider secrets must not appear in sandbox environment variables, files, logs, transcripts, or protocol payloads.
- Tests use faux providers. Live paid model requests are not part of automated validation.
- The integration branch must pass every modified test file, `npm run check`, and `git diff --check` before push.

## Progress log

- Created the clean integration worktree from `origin/main` on branch `feat/sandbox-backed-sessions`.
- Started the persistent goal and five-minute feature heartbeat.
- Started Wave 1 architecture audits in parallel.
- Completed A09. The existing three activity sections stay unchanged; execution location and link health will be added as orthogonal row metadata.
- Completed A15. Remote startup will bind to the exact daemon build identity and reject protocol skew before session admission.
- Completed A05 and A08. The installed sandbox SDK supports idempotent creation and background jobs; sandbox ownership will reuse daemon leases, recovery journals, and passivation semantics.
- Completed A01, A02, A10, and A14. Contracts cover the hosted-child seam, capability-gated protocol, safe workspace sync, and feature-specific secret isolation.
- Completed A03 and A12. Remote DTOs will use opaque IDs and ISO timestamps; the Python RLM layer can forward the new kwargs without a protocol change.
- Completed A16. Remote recovery will extend existing idempotency journals, ownership checks, reconnect cursors, and interrupted-operation records.
- Completed A04 and A07. The home proxy will implement the existing `StreamFn` contract; remote observation will mirror serializable event and usage records into the home catalog.

- Started B01, B03, B05, B06, and B07 in isolated worktrees after their architecture dependencies completed.
- Completed A06 and A13. Remote message delivery needs receiver-side ID deduplication; integration tests will extend the existing faux-provider and injectable subagent-host harnesses.
- Completed A11 from its retained transcript after the subagent failed to send a final summary. Top-level support enters through CLI create options and the capability-gated daemon create command.

- Integrated B01 as `68c8c5704`; its remote-safe DTOs passed 49 focused tests after credential-field and error-sanitization review.

- Started B02 after B01 integration; it will replace concrete child-session coupling with a local adapter while preserving current behavior.

- Integrated B03 as `d609d182f`; 57 focused tests verify exact-build admission, path-free frames, durable journals, directional replay, and cursor identity. Started B04 managed relay and B09 top-level API plumbing.

- Integrated B05 as `ce567a025`; 34 focused tests verify exact model authorization, typed streaming, cancellation, validation, and credential-safe errors.

- The integration branch passes full `npm run check` after B01, B03, and B05 integration.

- Integrated B07 as `7c193eb17`; 65 focused tests cover binary-safe snapshots, secret exclusion, traversal/symlink defenses, base-hash conflicts, and atomic sync-back.

- Integrated B09 as `42a914cba`; 62 focused tests cover default-local compatibility, strict sandbox options, protocol gates, and explicit unsupported-host failures.

- Integrated B06 as `d458e2308`; 80 focused tests cover Prime Sandbox CLI preflight/provisioning, strict DTO parsing, atomic background completion metadata, separate logs, and process-group termination with escalation. No sandbox resource was created.
  Exact-build packaging/bootstrap and admission remain part of B14; B03 already supplies the build/protocol/schema compatibility gate.

- Started B12 after B06 integration. Started transport-neutral B14a provider-client and B14b authenticated Prime Tunnel foundations early because they depend only on already-integrated contracts and touch separate files.

- Integrated the B14a sandbox-side provider client as `2195c7a23`; 67 client/home-proxy tests verify exact model admission, DTO-only requests, concurrent stream isolation, deep frame validation, usage/tool-call reconstruction, cancellation, disconnect cleanup, and credential-free payloads.

- Integrated B04 managed relay as `53e6b73fe` + `c9b1cabec` (cleanup `1eff5e4e6`); 151 B03/B04 tests cover strict peer/build/session admission, session-bound durable journals, replay/deduplication, send-failure teardown, reconnect, and bounded credential-free frames. Started B10 durable cross-host communication and B11 observation mirroring.

- Integrated the B14b Prime Tunnel manager as `a636f7d99`; it uses outbound `prime tunnel start`, validates and consumes the generated one-time grant, bounds injected CLI output, captures only validated tunnel IDs for cleanup, and provides bounded TERM/KILL plus exact-ID CLI cleanup without retaining output.

- Integrated B12 durable sandbox ownership and lifecycle as `16d844a1a`; 158 B06/B12 tests cover hashed fencing tokens, locked CAS transitions, atomic/fsynced records, corrupt-record fail-closed behavior, compensated provisioning, stale reclamation, passivation/wake, tombstones, and deletion without losing a possibly live sandbox handle.

- Integrated B15 protocol compatibility hardening as `3c80229aa` + `e5a22820f`; 226 B03/B04/B15 tests cover exact accepted-ACK build identity, unknown-field rejection, restart cursors, identity isolation, reconnect, corruption, gaps, and bounded replay. Started B14c loopback WebSocket relay and exact-build bootstrap foundations.

- Started B14d sandbox-side remote runtime host and command/event routing in parallel with B14c; both use resource-free fakes and defer final home orchestration until B02/B08 land.

- Reviewed the first complete B02/B10/B11/B14c/B14d candidates against committed source. None passed integration review: B02 still coupled the parent lifecycle to `AgentSession`; B10 lacked the claimed strict durable inbox fixes; B11 accepted non-exact events and snapshots; B14c lacked a real accepted-socket managed-relay path and executable runtime bootstrap contract; B14d lost ACKed commands across crash windows. Returned exact fixes and adversarial regression requirements without merging.

- Reviewed second-round candidates. Rejected them again because committed source still violated required invariants: B02 contained duplicated/corrupt lifecycle edits; B10 still accepted symlinks and v1/unbound inbox data and silently skipped malformed durable frames; B11 advanced state for unapplied event variants and could not produce cursor-accurate recap deltas; B14c used an unsupported CLI flag and did not hand off runtime admission data; B14d double-emitted events, reset event sequences after restart, and did not pass command idempotency keys to mutating runtime operations. The integration branch remains on the last fully verified baseline.

- Source review found repeated candidate reports did not match committed source or real command results. Rejected all unintegrated B02/B10/B11/B14c/B14d commits, deleted those subagents, reset every isolated worktree to verified integration commit `1ac3996b9`, and started five fresh DeepSeek V4 Flash subagents with source-specific invariants and required real `npm run check` exit evidence. No rejected implementation remains on the integration branch.

- Reviewed the first fresh B02/B10/B11/B14d commits after their reported checks passed. Source review still rejected them: B02 exposed host paths/open records and bypassed runtime-host cleanup for retained hosted children; B10 fabricated an incompatible agent-message frame and ran persistence only after B04 had ACKed; B11 lacked exact envelope/snapshot decoding and preserved raw remote errors; B14d had non-exact codecs, a non-atomic/unbound outcome store, incomplete recovery, no transport send, and unsafe command/event crash windows. Reassigned each worktree to a new DeepSeek V4 Flash correction pass with protocol-native types, pre-ACK durability, identity-bound recovery, exact outbox replay, closed DTOs, and cleanup-failure regression tests. No rejected source was merged.

- Rejected the next B11 correction because it still decoded a non-protocol event shape, lacked caller-bound exact snapshot restoration, and advanced or reconstructed unsafe observation state. Rejected B14c's uncommitted attempt because it reversed the transport topology by starting the listener inside the sandbox, dropped post-handshake text frames, ignored the relay URL, retained grants, and used unsafe post-extraction archive checks. Reset both worktrees and started clean protocol-native correction passes.

- Rejected B10's protocol-native correction after finding memory-before-persist inbox mutations, non-exact recovery, and underlying B03 journal replay that regenerated timestamps and silently skipped corruption. Reassigned B10 to harden the shared journal, exact-envelope relay replay, composable awaited admission, and durable inbox together. Rejected B14d's next runtime-host commit because its codecs only checked keys, its "digest" persisted plaintext command bodies, nested state was unchecked, and recovery did not correlate or resume journaled commands/events. Reassigned a focused correction with true SHA-256 digests, recursive exact state validation, backend rehydration, and crash-safe terminal/outbox rules.

- Rejected B02's tagged-union correction because it still lost retained hosted identity/status, bypassed host-owned cleanup, inferred RLM IDs from session IDs, and cast an incompatible usage DTO that would produce `NaN` totals. Rejected B11's concise rewrite because it explicitly tolerated unknown fields, mutated state before validation, discarded usage/pending/name state, and restored incomplete non-exact snapshots. Both remain isolated in targeted correction passes; no candidate code was merged.

- B10's combined correction remained too shallow: journal integrity fields were optional and unchecked, replay still regenerated timestamps, and uncertain inbox writes were not poisoned. Split the dependency into a focused B03 journal/B04 relay hardening pass first; durable message inbox/service work will restart only after that shared exact-envelope foundation is integrated and verified.

- B14c's second fresh attempt again ended without a commit and left a generated package tarball. Source review found a reusable grant, missing fixed-path admission, broken accepted-link ACK ordering, a nonfunctional outbound adapter, partial FD3 reads without erasure, post-extraction archive checks, and no callable process cleanup handle. Split B14c into a focused home listener/server-side accepted-link package first; outbound FD3/bootstrap/artifact/process work will resume after that transport boundary is verified.

- B14d correction `e8220bf07` was rejected. Its codecs still accepted wrong field types, its store was not recursively exact, journal/outbox correlation allowed gaps and unbound events, duplicate admission ignored frame identity, recovery skipped malformed commands, and transport failures terminalized replayable work. Split B14d into exact codecs/store first, followed by host/recovery/outbox.
- B11 correction `dff9168aa` was rejected. It mutated gap state before full decode, accepted non-protocol event shapes, mishandled evicted message indices and second bash runs, exposed mutable nested DTOs, and restored weak/unbounded snapshot fields including raw health errors. Split B11 into exact event/transition core first, followed by persistence/metadata/observer DTO.

- Shared B03/B04 hardening `35f4d182b` was rejected. The claimed strict validator left nested frame/body schemas unchecked; the journal skipped identity/corruption during reads and could report success after poisoned close; the relay processed async arrivals concurrently, admitted before handshake, journaled outbound ACKs as received, and emitted delivery when no ACK was sent. Re-sequenced foundation as: shared exact full-envelope codec, then strict journal, then ordered relay, then B10.

- B02 correction `69778a518` was rejected. Its hosted decoders defaulted malformed data instead of exact rejection, retained identity left `activeSessionId` blank, terminal error events could be overwritten as success, raw cleanup errors reached the parent, and disposal could invoke owner cleanup more than once. Split B02 into exact runtime boundary types/codecs first, then AgentSession orchestration.
- Resource-free bootstrap research confirmed container sandboxes can carry an opaque bootstrap payload without disk/env/argv persistence through `prime sandbox ssh` stdin. HOME spawns the Prime CLI with explicit argv and a pipe; SSH runs a fixed uploaded wrapper without a PTY; the wrapper will create a local pipe and spawn the actual runtime with the read end as FD3. This replaces B06's shell-script/file background-job path. VM sandboxes remain explicitly unsupported until Prime Sandbox exposes SSH there.
- Integrated reviewed B11-a exact observation event/transition core through `939a7baaf`. The six-key event decoder now rejects accessors, symbols, non-enumerables, unsafe/canonical-time violations, preserves bounded failure markers, blocks content after sequence or message-index gaps, supports cursor-0 replay recovery, and returns immutable observer DTOs. Snapshot restoration and final Agents View projection remain separate follow-up layers.
- Integrated the reviewed shared B03 exact full-envelope codec through `55b40d7f1`. It constructs fresh DTOs for all nine frame variants, enforces exact nested schemas, canonical timestamps, independent transport/semantic/command identities, cumulative node/depth/1 MiB canonical UTF-8 bounds, strict provider optionals, safe `__proto__` handling, and fixed fail-closed results even for hostile reflection traps. This unblocks the replacement durable journal and ordered relay.
- Rejected the first replacement strict-journal attempt before commit. It still used synchronous whole-directory/file APIs, advanced sequence state before persistence, silently skipped malformed disk records, persisted exact duplicates as new entries, and could acknowledge unknown frames. Split the work into an exact async immutable sequence store followed by a separate frame/ACK index layer.
- Rejected FD3 wrapper candidate `aadf1559`. It resolved the SSH input frame before EOF, used `/dev/fd/3` instead of the numeric inherited descriptor, never routed the reserved runtime mode from the CLI, retained arbitrary stdout as strings, and could exit before a detached child was killed. The replacement must confirm EOF, use numeric FD3, statically gate both hidden modes, and await one signal-escalation teardown chain.
- Integrated reviewed B11-b exact observation snapshots through `62e8b073a`. Snapshot restore now roundtrips every state accepted by B11-a, preserves independent counters and exact retained transcript/recap suffixes, binds identity, rejects aliases and hostile descriptors, uses the shared exact JSON byte preflight, and recursively freezes fresh DTOs. The integrated 482-test observation/codec/protocol suite and full root check pass.
- Rejected PAAR artifact candidates `2cc133910` and `093d18123`. Their builder and installer normalized unsafe paths, lacked an exact canonical manifest/build identity, followed or raced symlinks, used unsafe rename fallback, and did not package the runnable Python kernel. Restarted the work as a narrow reviewed async format/builder/verifier foundation before implementing the remote installer.
- Replaced the first async journal-store track after its reported corrections still performed unpaginated multi-gigabyte recovery and used plain rename as a claimed no-replace primitive. The replacement uses an exclusive staging file, final sequence reservation, link-no-replace, exact fsync ordering, and an explicit paginated recovery state.
- Source review rejected follow-up transport/listener/wrapper commits and uncommitted corrections: SSH dropped the required isolated cwd/environment/detached process-group options and could leave credential writes unsettled; the wrapper erased a frame still owned by FD3 and installed signal cleanup too late; the FD3 reader erased buffers before pending callbacks settled and leaked the descriptor on success; the listener still conflated authentication, transport receipt, and application delivery. Replacements now isolate SSH, wrapper, FD3 reader, and one-use loopback listener into separate foundations.
- Source review rejected journal candidate `dd5639922` and PAAR candidate `c238fc31`. Both reported stronger guarantees than their source provided. Journal work is now split into an exact record codec and generic immutable byte store. Artifact work is split into a pure canonical manifest codec before any builder/verifier/installer filesystem layer.
- B02 remains unintegrated. Its correction still changed existing local runtime types and duplicated observation DTOs despite the required unchanged local boundary. Hosted runtime integration will resume only after communication and observation contracts are accepted.

- Integrated the reviewed B03 journal record v1 codec through `5551582bd`. It descriptor-copies exact records and expected bindings without hostile property reads, preserves complete remote envelopes and independent IDs, derives and verifies canonical SHA-256 envelope digests, enforces exact canonical JSON bytes and size/identity/time/direction bounds, erases caller and owned decode buffers, and freezes fresh results. The integrated protocol/frame/journal suite passes 432 tests. Immutable publication and delivery-state indexing remain separate follow-ups.
- Rejected the replacement one-use listener `692cd9eb7` and the uncommitted wrapper-v2 draft after direct source review. The listener did not start or correctly count teardown after the first upgrade, could retain grants on early rejection, removed candidate ownership before WebSocket admission, and lacked bounded listen/upgrade failure handling. The wrapper accepted input before EOF, retained credential copies, signaled the wrong process scope, hung on readiness/natural exit, and converted cleanup failures to success. Both were split again into pure upgrade-authentication and streaming-stdin foundations before lifecycle integration.
- Integrated the reviewed PAB1 one-use bootstrap payload codec through `d21f53c1a`. It accepts only exact non-shared caller bytes, descriptor-snapshots bounded metadata, validates canonical secret-free `wss:` relay URLs, rejects literal-IP and repeated-path forms, erases caller and owned grant bytes on every path, and exposes only fixed frozen results.
- Integrated the reviewed numeric-FD3 framed reader through `723a8db52`. It uses unique buffer ownership per read, bounded referenced deadlines, exact framing and premature-EOF handling, confirmed close, descriptor-copied adapters, caller-payload ownership, and erasure that waits for all callback ownership to settle. Its focused suite passes 74 tests.
- Integrated the reviewed canonical PAAR1 manifest/framing codec through `a17f5588d`. It enforces exact fixed-order canonical manifests, NFC UTF-8 byte ordering, numeric file modes, contiguous offsets, deterministic build identity separate from final archive SHA, exact genuine decode buffers including detached/subview rejection, and temporary path-buffer erasure. The integrated PAAR/PAB1/protocol suite passes 265 tests. Deterministic trusted-tree builder and streaming verifier work is now isolated from the later one-open installer.
- Integrated the reviewed B03 receipt/application-delivery index codec and recovery accumulator through `5e8e926b4`. Canonical pending/delivered markers bind exact host/generation/session/direction/frame/digest/journal sequence, recovery validates contiguous index sequences without mutation on rejection, and deterministic actions distinguish new admission, pending idempotent reapplication, and delivered replay ACK. The integrated journal/index/frame/protocol suite passes 584 tests.
- Integrated the reviewed streaming SSH-stdin bootstrap frame reader through `4beeaa5da`. It waits for exact EOF, uses only a fixed header and exact payload allocation, rejects trailing/hostile chunks, snapshots its source adapter, handles synchronous registration races, removes only owned listeners, keeps its deadline referenced, and does not erase bytes while callbacks own them. The integrated stdin/FD3/PAB1 suite passes 254 tests. HOME credential-write ownership and the production Buffer-copy adapter remain separate.
- Integrated the reviewed pure HOME SSH spawn specification through `4dd8790db`. It emits exactly `prime` plus the nine required `sandbox ssh --plain` arguments, an explicit absolute HOME cwd, detached process-group settings, piped stdio, shell disabled, and only the PATH/HOME/USER/TMPDIR environment allowlist. Strict descriptor-based inputs and fixed secret-free errors reject hostile or extra values. Its integrated PAB1 suite passes 166 tests. Credential-write ownership and process lifecycle/readiness remain separate tracks.
- Integrated direct-final immutable journal publication as `8bd83db6c`. It reserves `<20-digit>.b03-journal` with `O_WRONLY | O_CREAT | O_EXCL | O_NOFOLLOW`, mode `0600`, never unlinks evidence, verifies exact file and directory identity, handles short positional writes, reopens and checks content, fsyncs the file and identity-bound directory, owns one checked close per handle, and erases caller/internal buffers. The 68 publisher tests and 714-test integrated B03/B04/B15 suite pass; full root check is green across 1000 files.
- Integrated immutable delivery-marker publication as `df846c08f`. It reuses the same reviewed direct-final publication core for `<20-digit>.b03-delivery`, preserves journal behavior, binds exact `indexSeq` values through 40,000, and returns fixed delivery-specific results. The combined publisher/journal/index/frame/relay/compatibility suite passes 752 tests; full root check is green across 1002 files.
- Integrated one-use WebSocket upgrade authentication as `a4976298c`. It takes caller-grant erasure ownership before unrelated factory validation, snapshots and scrubs all safely discoverable grant slots before request rejection, requires exact raw/normalized header agreement and strict Upgrade/Connection grammar, compares fixed SHA-256 digests in constant time, and preserves terminal one-use status. Its 79 focused tests, 248-test bootstrap/auth suite, 81 SSH-spec tests, independent adversarial review, and 1004-file root check pass.
- Integrated B13 Agents View execution metadata as `1ccb524da`. The view accepts only exact frozen coarse `local | sandbox+link | unavailable` DTOs, rejects hostile metadata without getters or proxy reads, displays location/link health orthogonally to activity, and never carries sandbox IDs, regions, errors, timestamps, URLs, or credentials. Seven Agents View suites pass 174 tests without changing grouping/counts; the 1005-file root check is green.
- Integrated the Node stdin normalization boundary as `4a8962b54`. It adapts real Node `Buffer` chunks into exact fresh full-backing `Uint8Array` values, erases them after synchronous consumption, rejects proxies/subclasses/empty chunks without throwing, installs terminal listeners before data/resume, preserves unrelated listeners, and retains exact listener ownership across removal uncertainty. Its adapter+frame suites pass 149 tests and the 1007-file root check is green.
- Rejected paginated scanner `f1f5cad9` after direct review found cursor advancement past unprocessed entries, pre-commit accumulator mutation, incomplete handle/read validation, and unsafe marker ordering across pages. Started a clean one-list-call, page-atomic scanner that defers full marker binding and accumulator construction until recovery completion.
- Rejected hosted boundary `35fb1c61`, upgrade authenticator `d7b56367`, PAAR builder `bce99cd9`, verifier `610c696c`, and the first SSH lifecycle/Node stdin adapter attempts after committed-source review. Their clean or focused correction tracks are active; none is present on the integration branch.

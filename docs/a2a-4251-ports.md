# A2A: selected 4251 ports on top of 4055

This branch is a draft combination for review. It is based on PR #4055
(`feat/a2a-server-v1`, head `40db19548`) and ports the small set of things
PR #4251 (`sebastian/a2a-lean`) does better. The full 4251-vs-4055 review is
in the draft PR body; this file records what changed and what deliberately did
not.

## Ported from 4251

### 1. Strict `Host` authority suffix validation

4251 rejects malformed forms such as `[::1]@evil.example`, `[::1]x`,
`[::1]:`, `[::1]:80evil`, `localhost:`, and `localhost:80@evil.example`.
4055's `split_host_port` accepted several of those as loopback names because it
ignored everything after `]` unless it started with `:`.

Why it matters: the loopback `Host` gate is the DNS-rebinding and cross-site
form-POST defense. A crafted suffix should not ride a loopback name past it.
This is defense in depth, not a remote unauthenticated compromise.

Files:
- `crates/pa-daemon/src/a2a/http.rs`: `split_host_port`, `PublicAuthority::matches_host`
- Unit tests: the loopback and public-authority tables
- E2E: `a2a_loopback_bind_refuses_foreign_hosts_and_origins`

### 2. `Vary: host` on the Agent Card

4055 derives the card's interface URL from the request `Host` on a wildcard bind
with no configured public URL. Without `Vary: host`, a shared cache can serve a
card for one host to a client using another for up to 300 seconds. 4251 sets
the header on both the 200 and 304 responses.

Files:
- `crates/pa-daemon/src/a2a/http.rs`: `card_response`
- E2E: `a2a_card_served_at_the_well_known_uri`

### 3. `A2A-Version` as a query parameter

Spec 3.6.1 says clients MAY send the service parameter as
`?A2A-Version=1.0` instead of the header. 4251 accepts it; 4055 was
header-only. The header wins when both are present, and an empty or missing
value is still 0.3 and still refused by this 1.0 server.

Files:
- `crates/pa-daemon/src/a2a/http.rs`: the version read and gate
- E2E: `a2a_version_gate_rejects_missing_and_unsupported`

## Deliberately not ported

- **Cancel scope and continuation retirement.** 4251's cancel is session-wide
  and ephemeral. 4055's delivery-scoped withdrawal plus durable goal pause is
  the design to keep.
- **Task attribution.** 4251 credits any assistant text on the session to the
  running task. 4055's turn windows and run ownership are the design to keep.
- **Live-context bound, settings, telemetry, and Agent Card identity.** 4055
  already has `a2a.maxContexts`, `a2a.publicBaseUrl`, the `a2a.*` settings, and
  the `a2a request served` event. 4251's lean scope is not an improvement here.
- **Child cancel.** 4251 cancels every RLM child on the session. 4055
  deliberately lets delegated work run. If the product wants CancelTask to stop
  the task's own subagents, add it to 4055 scoped by delivery id; do not port
  4251's session-wide version.
- **Test strategy.** 4251's 9 unit and 6 e2e tests are not a model for 4055's
  larger surface.

## Follow-ups worth considering

- Emit one final `append: false, lastChunk: true` artifact on a normally
  streamed turn. 4251 does this; 4055's fully streamed path sends only
  `lastChunk: false` chunks before the terminal status. The field is optional,
  so this is client polish, not a conformance fix.
- Split the ~8k test block out of `crates/pa-daemon/src/a2a/server.rs` into a
  child test module. 4251's 689-line server is easier to review; the repo has a
  soft 2,000-line signal.
- Shared gaps not addressed by either PR: one bearer token with no client
  identity, the spec 3.4.3 `taskId` context-inference MUST, ignored
  `acceptedOutputModes`, empty `artifacts` when `includeArtifacts: true`, client
  `role` validation, metadata round-trip, and no accept/body/SSE idle bounds.

## Reviewing this stack

The PR is a draft for illustration. Its base branch `a2a/4055-base` is a mirror
of PR #4055 at `40db19548`, so the PR diff shows only the ports above. The
actual 4055 PR remains the source of the main implementation.

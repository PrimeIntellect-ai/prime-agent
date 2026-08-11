# Retained Follow-up and Incomplete Stream Hardening Design

## Objective

Prevent an idle parent from waiting forever when a retained RLM child accepts a follow-up but finishes without replying, and prevent an OpenAI-compatible stream that ends without a terminal `finish_reason` from being recorded as a successful completion.

## Incident

A retained child accepted a direct parent follow-up and executed normally, then produced an assistant message containing only reasoning with `stopReason: "stop"`. It did not call `agent_message.send`. The parent remained idle because the automatic `completed without sending a reply` notice only covered the original `rlm()` task. The child's durable RLM row still described the completed original task and did not monitor later follow-ups.

The same assistant record was consistent with a second fail-open path: the OpenAI-compatible stream adapter initializes the output as `stop` and emits it after clean iterator exhaustion even when no chunk supplied a terminal `finish_reason`.

## Repository Topology

- Upstream: `https://github.com/PrimeIntellect-ai/prime-agent.git`
- Fork: `https://github.com/ProDrifterDK/prime-agent.git`
- Upstream contribution branch: `fix/retained-followup-incomplete-stream`
- Upstream base: current `upstream/main`
- Local activation base: the currently activated local stack at `d09d531e5cc29ee0f161543e00f163522c58f49e`

The upstream pull request will contain only the design, regressions, implementation, and changelog entries for these two defects. After review, its functional commits will be cherry-picked onto the local activation stack rather than replacing that stack.

## Design 1: Retained Child Follow-up Completion

### Boundary

`AgentSession.acceptAgentMessagePrompt` is the task-admission seam for an idle session receiving an agent message. A direct parent-to-child message at RLM depth greater than zero defines a follow-up task whose completion must result in either an explicit child reply or a host-generated terminal notice.

### Flow

1. Before admitting the prompt, identify a direct parent message and capture the child's monotonic parent-reply count.
2. Register a completion waiter under the incoming agent-message ID before the action can settle.
3. Admit the prompt through the existing agent-message path and return at acceptance so the sender is never blocked on the target's model turn.
4. Observe completion asynchronously:
   - if the parent-reply count increased, the child replied explicitly and no host notice is emitted;
   - if completion succeeds without a parent reply, send the existing `completed without sending a reply` content to the stable parent session ID;
   - if completion fails definitively without a parent reply, send the existing child-failure content.
5. Delivery uses the child session's existing agent-message controller, preserving child attribution and the parent's normal event-driven wake-up behavior.

### Scope

The change applies only to an idle RLM child accepting a direct message from its parent. It does not create a new RLM handle, reinterpret the durable registry row, change daemon wire protocol, or add polling/watchdog behavior. Busy-session steering and queued follow-ups keep their existing semantics.

### Exactly-once and Races

The incoming agent-message ID owns one completion waiter. The reply-count baseline is captured before admission, so a fast child reply cannot be lost by a later boolean reset. Completion handlers compare the counter once and attach both success and rejection branches to avoid unhandled promises. Parent targeting prefers the stable session ID supplied by the accepted message over an active runtime ID that may later change.

## Design 2: OpenAI-compatible Stream Completion

### Boundary

`streamOpenAICompletions` is the public provider seam. A successful streamed response requires a terminal non-null `finish_reason` from at least one choice.

### Flow

1. Initialize a `sawTerminalFinishReason` flag as false.
2. Set it when a choice carries any non-null `finish_reason`, before mapping that reason to the internal stop reason.
3. After stream iteration and block finalization, but before emitting `done`, fail if no terminal finish reason was observed.
4. Preserve partial text/reasoning/tool blocks on the error assistant message for diagnostics, but mark the message `error`; never emit a successful `stop` solely because the iterator ended.
5. Existing coding-agent retry policy treats the provider error as transient unless a structured permanent-failure rule says otherwise.

This is deliberately strict. OpenAI-compatible streaming requires a terminal finish reason, and accepting an unframed EOF risks committing truncated reasoning, text, or tool arguments as complete work.

## Test Seams

Tests exercise public behavior rather than private state.

### Coding Agent

Using `AgentSession.acceptAgentMessagePrompt` with the existing faux stream and an agent-message controller:

1. An idle retained child accepts a direct parent follow-up, completes with reasoning-only output, and sends no reply. The parent receives exactly one attributed terminal notice.
2. The child explicitly replies to its parent during the follow-up. No automatic terminal notice is sent.
3. The sender-facing admission call still returns before the child completion, preserving fire-and-forget messaging.

### AI Provider

Using `streamOpenAICompletions` with the existing mocked OpenAI-compatible stream:

1. A reasoning delta followed by iterator EOF with only `finish_reason: null` produces an error event and no successful done event.
2. A normal terminal `finish_reason: "stop"` remains a successful stop.
3. Existing non-standard terminal reasons retain their current mappings.

## Validation

From each affected package root:

1. Run only the modified focused test file with `npx tsx ../../node_modules/vitest/dist/cli.js --run <test-file>` while iterating RED to GREEN.
2. Run repository-required `npm run check` after code changes; capture full output.
3. Review the complete diff against `upstream/main` for spec compliance and repository standards.
4. Push the fork branch and open one pull request against `PrimeIntellect-ai/prime-agent:main`.

No test uses live providers, credentials, paid APIs, or another user's session.

## Local Activation

After the upstream-ready commits pass review:

1. Cherry-pick the two functional fixes and their regressions/changelog entries onto a local activation branch based on `d09d531e`.
2. Run the same focused regressions and full repository check on the activation branch.
3. Build and install Prime Agent through the repository's supported local package path.
4. Perform a coordinated daemon update restart so resident sessions checkpoint and recover under the new build.
5. Verify the daemon build identity and run an isolated smoke test: a retained child that ends a follow-up silently must wake its parent with a terminal notice.

## Success Criteria

- A silent retained-child follow-up cannot leave its parent waiting indefinitely.
- An explicit child reply never receives a duplicate automatic notice.
- OpenAI-compatible EOF without a terminal `finish_reason` is an error and eligible for retry.
- Standards-compliant streams remain unchanged.
- No daemon protocol or registry migration is introduced.
- The upstream pull request is minimal and based on current `upstream/main`.
- The local activated stack preserves its existing custom commits and runs the verified fixes for all sessions.

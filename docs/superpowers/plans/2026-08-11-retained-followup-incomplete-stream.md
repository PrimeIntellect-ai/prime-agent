# Retained Follow-up and Incomplete Stream Implementation Plan

> Design: `docs/superpowers/specs/2026-08-11-retained-followup-incomplete-stream-design.md`

## Goal

Ship two independent fail-closed fixes on current `upstream/main`, preserve fire-and-forget agent messaging, open one minimal upstream PR, then cherry-pick and activate the functional commits on the existing local Prime Agent stack.

## Fixed Point and Commit Shape

- Base: `upstream/main` at `14d6e74919a5fba4916e5cc04b4f439a09a3750a`
- Documentation commits already precede implementation.
- Functional commit 1: `fix(coding-agent): report silent retained follow-ups`
- Functional commit 2: `fix(ai): reject unterminated completion streams`
- Keep the two functional fixes independently revertible.

## Task 1: Silent Retained Follow-up Regression

**Files**
- Modify: `packages/coding-agent/test/agent-session-recursion.test.ts`
- Read fully before editing: `packages/coding-agent/src/core/agent-session.ts`

**Public seam**
- `AgentSession.acceptAgentMessagePrompt`

**RED**

1. Create an RLM-depth-1 child with an agent-message controller whose `sendAgentMessage` calls are observable.
2. Submit a direct parent `AgentSessionMessage` through `acceptAgentMessagePrompt` while the child is idle.
3. Hold the faux assistant stream open long enough to prove admission returns before completion.
4. End the assistant turn with reasoning-only content and no child reply.
5. Assert the parent receives exactly one attributed `completed without sending a reply` message.
6. Add the paired case where the child calls the existing `agent_message.send` host handler before completion and assert that no automatic terminal notice follows.
7. Run:
   `cd packages/coding-agent && npx tsx ../../node_modules/vitest/dist/cli.js --run test/agent-session-recursion.test.ts`
8. Confirm the new silent-follow-up assertion fails for the missing notice, not for fixture setup.

## Task 2: Follow-up Completion Monitor

**Files**
- Modify: `packages/coding-agent/src/core/agent-session.ts`
- Modify: `packages/coding-agent/CHANGELOG.md`

**GREEN**

1. Reuse the existing agent-message outcome map to register a completion deferred under the incoming message ID before prompt admission.
2. Capture `_parentReplyCount` before admission for direct parent messages at RLM depth greater than zero.
3. Return from `acceptAgentMessagePrompt` at the existing acceptance boundary.
4. Attach asynchronous success and error handlers to the completion promise:
   - reply count changed: do nothing;
   - success without reply: send `createRlmChildTerminalNoticeMessage` content to the stable sender session ID;
   - failure without reply: send `createRlmChildFailureMessage` content.
5. Use the existing child ID/name and message factories. Do not add daemon commands, events, polling, or durable registry fields.
6. Ensure failed notice delivery is contained and cannot produce an unhandled rejection.
7. Run the focused test file until GREEN.
8. Add one `[Unreleased]` coding-agent changelog bullet.
9. Commit only this slice.

## Task 3: Unterminated Provider Stream Regression

**Files**
- Modify: `packages/ai/test/openai-completions-tool-choice.test.ts`
- Read fully before editing: `packages/ai/src/providers/openai-completions.ts`

**RED**

1. Reuse the existing mocked OpenAI-compatible streaming client.
2. Emit a reasoning delta with `finish_reason: null`, then close the async iterator without a terminal chunk.
3. Consume `streamOpenAICompletions` and assert:
   - the terminal event is `error`;
   - the assistant stop reason is `error`;
   - the error identifies a missing terminal `finish_reason`;
   - no successful `done` event is emitted.
4. Retain or add a control where `finish_reason: "stop"` remains successful.
5. Run:
   `cd packages/ai && npx tsx ../../node_modules/vitest/dist/cli.js --run test/openai-completions-tool-choice.test.ts`
6. Confirm the new EOF test fails because current code emits `done/stop`.

## Task 4: Require Terminal `finish_reason`

**Files**
- Modify: `packages/ai/src/providers/openai-completions.ts`
- Modify: `packages/ai/CHANGELOG.md`

**GREEN**

1. Track whether any choice supplied a non-null terminal `finish_reason`.
2. Preserve all existing reason mappings.
3. After iteration and block finalization, fail before `done` when no terminal reason was observed.
4. Let the existing catch path preserve partial content and convert the output to an error event.
5. Run the focused AI test file until GREEN.
6. Add one `[Unreleased]` AI changelog bullet.
7. Commit only this slice.

## Task 5: Integration Gate and Review

1. Cherry-pick both functional commits onto the upstream contribution branch after the design/plan commits.
2. From repo root run `npm run check` with complete output.
3. Re-run both focused test files from their package roots.
4. Run `git diff --check` and confirm a clean worktree.
5. Review `upstream/main...HEAD` on two axes:
   - repository standards and code smells;
   - exact design/spec compliance.
6. Resolve every blocker/high/medium finding and rerun affected tests/checks.

## Task 6: Upstream Pull Request

1. Rebase the contribution branch on the latest `upstream/main` if it moved, then rerun the gate.
2. Push `fix/retained-followup-incomplete-stream` to `origin`.
3. Open one PR to `PrimeIntellect-ai/prime-agent:main` with:
   - incident and causal chain;
   - both fail-closed fixes;
   - focused RED/GREEN evidence;
   - full `npm run check` result;
   - no claim that raw provider chunks proved the original EOF trigger.
4. Do not merge the upstream PR.

## Task 7: Local Activation

1. Create a local activation branch from `local/activated-subagent-thinking-level` at `d09d531e`.
2. Cherry-pick the two functional commits plus changelog/test changes; omit upstream-only design/plan docs if they conflict with the local documentation stack.
3. Resolve semantic conflicts against the local host-request/discovery/thinking-level commits without dropping either fix.
4. Run both focused regressions and `npm run check`.
5. Build/install using the repository-supported local package workflow already used by the current activation.
6. Request a coordinated daemon update restart so all resident sessions checkpoint and recover on the new build.
7. Verify daemon/client build identity and run an isolated retained-child silent-follow-up smoke test.
8. Confirm all pre-existing sessions remain listed and attachable.

## Completion Evidence

- Upstream PR URL.
- Functional commit SHAs.
- Focused test counts and full check result.
- Installed build identity and daemon restart log.
- Isolated smoke result demonstrating parent wake-up on a silent retained-child follow-up.

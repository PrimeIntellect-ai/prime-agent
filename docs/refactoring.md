# Refactoring existing packages

Use this workflow for coding-agent and later cleanups of ai, agent, tui and the Python runtime. A package's own architecture and contributor instructions still apply. This guide records lessons from the coding-agent extraction: reducing one class left older parts of the same features in different folders, and several mixed files needed responsibility changes before relocation.

## Start with the whole ownership map

Inventory the package's tracked source, direct files in mixed directories, largest handwritten files, assets, executable entry points and public exports. Distinguish generated code, vendor code, fixtures and tests. Report physical LOC honestly; source size does not establish runtime speed or package weight.

For each responsibility, record:

| Question | Required answer |
| --- | --- |
| Who owns it? | The feature and its canonical directory. |
| What state does it own? | Authoritative state, derived views and invariants. |
| How long does it live? | Package/process, session, turn or individual operation. |
| How does it end? | Cancellation, replacement, failure, disposal and pending work. |
| What does it expose? | Public operations, lightweight contracts and actual consumers. |
| What may it depend on? | Named capabilities and the owner of cross-feature ordering. |
| What moves together? | Existing helpers as well as newly extracted code, plus tests/assets/scripts. |
| What remains? | Exact deferred files, their destination and the workstream that will move them. |

Read complete implementations before editing them. An import/size inventory can establish scope but cannot prove semantic ownership. Mark provisional assignments explicitly and revisit them during implementation. Do not let “transitional” folders remain without destinations.

## Organize by feature, with explicit integration boundaries

Keep a feature's algorithms, state, contracts, persistence adapters and cleanup together. Separate files inside that feature when they have distinct responsibilities. A pure function, isolated test or several type consumers does not automatically justify a new top-level capability.

Use a separate capability when it has an independently useful API and real consumers outside the parent feature. Name the session/application integration separately and document the direction of dependency. For example, Python process transport and environment provisioning can operate without a conversation; a session's replacement order and transcript notices remain session-owned.

At grouping directories, keep direct files limited to entry points, composition and explicitly named cross-feature contracts. At leaf feature directories, put implementation files directly in the folder. Do not force one folder per file, arbitrary LOC limits or a class per method. Avoid large generic core, shared, helpers and services buckets.

Split mixed responsibilities before moving a file. Examples found in coding-agent:

- Input queue state was bundled with daemon worker eviction policy.
- A tool implementation owned the reusable kernel provisioner.
- Kernel contracts shared a module with process-wide cleanup registration.
- Refinement formatting shared a barrel with model planning, creating a message-conversion cycle.
- Session lease support exposed generic process identity helpers used by daemon ownership.

Moving those files unchanged would preserve the underlying dependency problems. A smaller facade also fails if every extracted object receives the entire old class or a universal services container.

## Establish the compatibility contract before implementation

Honor the user's compatibility requirements. For Kevin's September 11 coding-agent cleanup, full feature and backward compatibility are required. Preserve CLI/SDK exports, supported import paths, method signatures, extension hooks, configurable shortcuts, wire payloads and persisted data behavior.

Keep one canonical implementation. If an existing import path must remain usable, retain an explicit forwarding facade with no state or copied logic; migrate internal consumers to the owner. Record such facades separately from unfinished implementation. Do not remove them merely to improve directory or LOC statistics. A later removal requires an explicit compatibility decision.

Test representative old and new entry points against the same exported objects and behavior. Check type declarations as well as runtime exports. Avoid importing a broad public barrel from its own implementation; preserve existing dependency injection rather than introducing a new factory cycle.

Structural changes should preserve event order, completion settlement, callback receivers, synchronous/asynchronous boundaries, cancellation timing and late-result handling. Define these from existing behavior rather than from the cleaner design one might prefer. Separate intentional behavior changes for review.

Protocol/schema changes need the package's compatibility process. File moves alone should not change protocol versions or disk formats. Preserve old-client/new-server and new-client/old-server behavior, including optional-capability fallback and startup. Keep recovery data readable and failures visible.

## Implement a few coherent changes

Use isolated worktrees with an exact shared base. Delegate independent ownership areas; explicitly identify shared composition files and integration order. Share the accepted map and compatibility contract with every implementer. Prefer substantial feature PRs with small reviewable commits over one PR per helper.

Integrate one lane at a time, inspecting conflicts semantically. Import relocation, helper extraction and behavior fixes should remain distinguishable. Preserve a single queue, transcript, registry, lifecycle authority and accounting path. Do not rewrite published stacks or merge automatically as a shortcut.

Update consumers, source maps, tests, examples, scripts, assets, packaging and declarations in the same change. Search for old paths in executable strings and asset resolution, not only static imports. Check workspace dependency realpaths so tests cannot accidentally exercise another checkout.

## Validate behavior and shipped artifacts

Choose tests from the ownership risk, not from the number of changed lines. Cover success and failure, duplicate delivery/completion, cancellation at awaited boundaries, replacement while callbacks are pending, persistence rejection, resource cleanup and reentrancy where applicable.

Use deterministic providers, injected clocks and isolated I/O for regression coverage. Preserve existing regression assertions; diagnose failures against the exact base before changing an assertion. Run every modified test file and the repository's required checks with full output. Record failures and missing-environment skips; test counts are not a coverage guarantee.

For process or kernel changes, validate real processes in the supported environment. Run paired base/head scenarios in Prime Sandboxes when requested: identical fixtures, toolchain and test harness; explicit source SHAs and archive hashes; isolated temporary homes and sockets; no personal histories or unrelated secrets. Use separate lanes for heavy kernel startup and process stress when verified resource limits require it. Reconcile and clean up all created sandboxes, including ambiguous creation outcomes.

Exercise shipped entry points as well as source tests: CLI, SDK, TUI, JSON/RPC/ACP as applicable, fresh startup, attach/reconnect, save/reload, extensions, tools and native assets. Check packaged Python sidecars and import resolution separately from TypeScript checking. Existing credentials may be used only within the user's authorized scope; do not silently substitute paid external inference for an internal route.

Benchmark identical workloads with the same trusted harness and complete observations. Distinguish timing, RSS, serialized bytes, compressed/installed size and build/check time. A successful small reproduction does not complete an older partial report. Make no performance claim based solely on moved code or noisy scores.

## Finish with an accurate source map

A responsibility is migrated when its implementation has one canonical home, consumers use that home, compatibility facades are explicit, all path/asset references work, invariants remain covered and required validation passes. Update the migration ledger and contributor rules in the same PR.

Report exact PR bases/heads, tests actually run, platform/environment limits, remaining review gates and deferred work. Distinguish implementation, integration checkout and installed executable provenance. Do not call a whole package clean because one class is smaller, or an installation updated because only its source manifest changed.

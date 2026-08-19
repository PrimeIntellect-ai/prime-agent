# Review: PR #1495 — feat: add generic kernel-owned MCP runtime

Head: ce6c27b36 (branch review/mcp-runtime-review), base for diff: 20b54977a. Reviewed locally; nothing posted to GitHub.

## Verdict

**Approve after rebase** (two textual conflicts vs main), with follow-ups filed for F2, F3, F4. No blocking security defect found. The one genuinely open design question is F2 (cross-event-loop close during kernel shutdown) — if the team can't quickly confirm ipykernel's control-loop behavior, downgrade to needs-discussion on that point only.

## Findings

1. **[Medium] OAuth token replay when a user server's URL is edited under the same name** — `packages/coding-agent/src/core/mcp/mcp-command.ts` (remove/add paths) + `prime-agent-runtime/src/rlm/mcp.py:376-388` (`_auth_identity` reads `auth.json` `mcp:<server>` keyed only by name).
   Trace: `mcp add foo --url A --oauth` → login stores cred under `mcp:foo`. `mcp remove foo` does NOT logout (`runMcpManagementCommand` never touches authStorage), and `mcp add foo --url B --oauth --force` replays the token issued for A to B. Catalog names are protected (`mcp.config` returns `{}` for them, mcp-manager.ts:174), but user-named OAuth servers are not.
   Verified-how: read mcp-command.ts end-to-end (no authStorage interaction); traced `_headers()`/`_auth_identity()` token source in mcp.py.
   Suggested fix: `mcp remove`/`--force` replace should logout `mcp:<name>`, or bind the stored cred to the URL.

2. **[Medium, uncertain] Kernel-shutdown close may run on the wrong event loop** — `prime-agent-runtime/src/rlm/mcp.py:495-522`.
   `install_shutdown_hook` wraps `kernel.do_shutdown` with `await close()`. In real ipykernel ≥6 the control channel runs on its own thread/loop, while generations (anyio task groups, httpx clients, stdio processes) were created on the shell loop. `stack.aclose()` from a foreign loop/task raises (anyio "cancel scope in different task"); `_Generation.close()` only swallows `TimeoutError`, so the error propagates out of `do_shutdown`. Same class of problem for the `atexit` fallback: `asyncio.run(close())` builds a NEW loop, so `aclose()` on old-loop objects fails and the bare `except Exception` hides it — stdio children then rely solely on stdin-EOF to exit (SDK's SIGTERM path never runs). Well-behaved servers exit on EOF; a server that ignores EOF leaks past kernel death, and the daemon's killTrackedDetachedChildren does not track these grandchildren.
   Verified-how: read `_close_at_exit`/`install_shutdown_hook`; read mcp SDK `stdio_client` teardown (`PROCESS_TERMINATION_TIMEOUT` only inside `__aexit__`); test only exercises a fake synchronous kernel, never real ipykernel. Not empirically reproduced — flagged as uncertainty, worth a real-ipykernel shutdown test.

3. **[Medium, compat] Documented catalog-name override feature silently removed** — `packages/coding-agent/src/core/mcp/mcp-manager.ts:121-133` (`isAuthed`: `userDeclared && getCatalogEntry → false`), `:174` (`mcp.config` returns `{}` for catalog names).
   Before: a user `mcpServers.linear` entry with a custom URL + `bearerTokenEnvVar` was explicitly supported (old docs: "Authenticate such an override via bearerTokenEnvVar only") and `mcp.config` returned its url/headers to the authored skill. After: any user entry shadowing a catalog name disables the built-in skill (`getDisabledBuiltinSkillOverrides`) and is unusable via the generic API. Deliberate hardening (closes the bot-flagged token-leak-to-override-URL hole) and the docs were rewritten, but affected users get no message — their Linear proxy just stops working.
   Verified-how: diffed mcp-manager.ts and docs/mcp-integrations.md against 20b54977a; new test "does not enable an authored catalog skill when a generic server shadows its name" pins the behavior.

4. **[Low] Actual stdio child env is wider than `_SAFE_ENV`** — `prime-agent-runtime/src/rlm/mcp.py:25,408-421` vs mcp SDK `client/stdio.py:128`.
   `_stdio_env` builds an allow-list env (HOME, PATH, TMPDIR, TEMP, TMP, SystemRoot, WINDIR + tagged refs), but `stdio_client` merges `get_default_environment() | server.env`, so on POSIX the child additionally sees LOGNAME, SHELL, TERM, USER (Windows: APPDATA, USERPROFILE, etc.). All benign, no secrets, but the module's implied contract ("exactly these") is not what ships. Comment or pass `env` in a way that suppresses the SDK default merge if exactness matters.
   Verified-how: read installed SDK source in the PR's own venv (`prime-agent-runtime/.venv/.../mcp/client/stdio.py:40-57,75-90,128`).

5. **[Low, compat] Legacy stdio `env: Record<string,string>` entries now hard-error at first use** — `mcp.py:414-419` (`set(reference) != {"env"} → ValueError`). Old settings-schema stdio entries with literal env values fail with a clear message. Acceptable because stdio entries were never executed before this PR (old mcp-manager.ts:73 dropped them: "stdio servers self-manage in Python" — nothing self-managed), so no working setup breaks; but a user who hand-wrote one following the old TS type gets an error only at call time, with no `mcp list`/startup validation.
   Verified-how: `git show 20b54977a:.../mcp-manager.ts | grep stdio`; read `_stdio_env`.

6. **[Low] Per-server registry lock serializes everything, including 60s in-flight calls** — `mcp.py:295-300` (`_Registry.call` holds the per-server lock across the whole tool call), plus `_Generation._call_lock` (redundant second serialization). One slow tool call blocks `list_tools`, `reload`, and `close` for that server for up to `callTimeoutMs`. Kernel cells are mostly sequential so impact is limited to background tasks, and it is what makes the closed-generation race impossible (see Lifecycle below) — a conscious trade-off worth a comment. Also `_locks` grows unboundedly with arbitrary requested server names (any non-empty string) — cosmetic.
   Verified-how: read `_Registry.get/tools/call/reload/close`; confirmed no path dispatches on a closed generation.

7. **[Nit] `PRIME_AGENT_KERNEL_PYTHON` failure message is stale** — `bootstrap.ts` (`ensureKernelPythonUncached`): the "missing a current prime-agent-runtime with callable rlm.run, rlm.host_request, and explicit harness CRUD methods" message doesn't mention the new mcp requirement that can now be the actual cause.

8. **[Nit] `mcp get` output is `name: transport` only** — `mcp-command.ts` `formatMcpServer`. Redaction is deliberate (tests pin it) but this makes `get` indistinguishable from `list` and useless for debugging one's own config. Consider showing url host / command basename, which the user wrote themselves.

## Security assessment

- **Subprocess (stdio)**: argv-only spawn confirmed — SDK uses `anyio.open_process(command+args, shell=False)`; no shell metacharacter interpretation. `cwd` is user-controlled string passed through (no validation it exists — error surfaces at spawn, redacted). Env is allow-list based (`_SAFE_ENV` + tagged `{env: NAME}` references that must exist in the kernel env; literal values rejected both in Python (`_stdio_env`) and CLI (`validateEnvName`)). Residual: SDK adds LOGNAME/SHELL/TERM/USER (F4). A malicious settings.json entry gets exactly argv-spawn as the local user — equivalent power to what the model already has via IPython, and servers persist only in global 0600 settings written atomically (temp+rename, `settings-manager.ts:283-289`); project-local declarations are inert for execution, so a hostile repo cannot start processes. NUL bytes rejected at CLI; SDK also raises on embedded NUL.
- **Credentials**: bearer tokens flow env-var → `_headers()` → httpx client constructor only; never logged, never in `mcp list/get` (name+transport only, pinned by tests), never in the system prompt (agent-session-services test asserts urls/commands/env names absent), never persisted outside settings.json/auth.json. Startup diagnostics: stderr tail is captured only until handshake success (`stop_capture`), redacts all configured env values ≥4 chars (longest-first) plus all config strings and cwd; secrets <4 chars suppress the entire diagnostic. Redaction order is correct (ANSI/control-strip before replacement, truncation after). Bypass residual: a child that re-encodes a secret (base64/split lines) evades literal replacement — inherent limitation, bounded 8KB/40 lines. Verified against the PR's real failing-stdio test which asserts sentinel redaction, ANSI/NUL stripping, and child reaping via pid probe.
- **HTTP**: TLS verification on (httpx default, not disabled anywhere). `create_mcp_http_client` sets `follow_redirects=True`, but httpx strips `Authorization` on cross-origin redirects except same-host http→https (`httpx/_client.py:546-556`) — no cross-origin bearer leak. URLs validated http(s)-only, no embedded userinfo. OAuth: catalog tokens cannot be pointed at user URLs (mcp.config returns `{}` for catalog names; `isAuthed` hard-disables catalog-name shadows). Remaining replay avenue is F1 (same-name user server, user-initiated). `_authIdentity` (sha256 of token) folded into the config dict makes token rotation replace the generation — good.
- **Tool filters**: enforced at listing (`_Registry.tools` filters via `allows`) AND dispatch (`_Generation.call` raises `PermissionError` before touching the session; `enabledTools` allow-list applied before `disabledTools`). Direct bypass requires reaching into `mcp._registry._generations[...].session` — arbitrary Python in the kernel can always do that; the filters are policy for the model, not a sandbox, which is the right framing.

## Lifecycle / concurrency

- Closed-generation dispatch is impossible: every public op holds the per-server lock; `reload`/`close` wait behind in-flight calls; `_get_locked` recreates a closed/config-changed generation before use. Verified by reading all lock paths + the PR's reload-waits-for-in-flight-open and close-waits-for-inflight-startup tests.
- `open()` failure always closes the generation (`except BaseException: await self.close(); raise`), teardown deliberately outside the startup deadline so diagnostics survive; cancellation propagates unwrapped (tested).
- Cancelled `close()` is retryable (`closed` flag set only after `aclose` attempt; tested). Hung server close is bounded at 5s (`asyncio.timeout(5)` around `aclose`, TimeoutError swallowed) — a truly hung stdio child could outlive its generation until kernel death; kernel death closes its stdin → EOF exit for well-behaved servers (residual in F2).
- Cancelling a `call_tool` (timeout) cancels only that request inside `_call_lock`; the SDK session tolerates it; next call proceeds on the same session. Test `test_call_timeout_cancels_request` covers cancellation delivery.

## Upgrade-path assessment (readiness check)

The failure mode is benign for the default managed venv: `RUNTIME_READY_CHECK` now requires `import rlm.mcp` + callable `list_tools/call_tool`; an old venv fails `hasPrimeAgentRuntime` → `kernelReady`/`kernelBaseReady` false → automatic venv rebuild under the bootstrap lock (and the runtime source-hash identity changes anyway, forcing rebuild). This exact path is tested ("rebuilds a warm venv with a stale rlm runtime", whose fake python passes `import rlm` but fails the extended check). Old `kernel-state.dill` snapshots restore fine after rebuild — they contain only user variables (`rlm`, `asyncio` skipped; old snapshots contain no `mcp` name; new ones pickle the module by reference, re-imported on restore). No wedge: worst case is first start after upgrade needs internet for the new `mcp`/`httpx` deps, with the existing actionable bootstrap-failure message. `PRIME_AGENT_KERNEL_PYTHON` users hard-fail with a message that should mention mcp (F7). Revived kernels: `_PRIME_AGENT_RLM_IMPORT_ERROR` fallback in ipython.ts still catches a broken `import rlm.mcp` and degrades with instructions rather than crashing the bootstrap cell.

## Semantic conflicts with main (mergeable=dirty)

`git merge-tree` vs f8f0036cc: two content conflicts, both textual/trivial —
- `packages/coding-agent/CHANGELOG.md` (both sides prepend entries).
- `packages/coding-agent/test/settings-manager.test.ts` (#1505 comment-removal touched the same mcpServers test block this PR rewrites; resolve in favor of this PR's new assertions).
Semantic overlaps checked, none breaking: #1540 (kernel-state snapshots) auto-merges in ipython.ts/agent-session.ts; its `always_skip = {"rlm", "asyncio", ...}` does NOT include the newly pre-imported `mcp` name — harmless (dill pickles modules by reference) but `mcp` should join `always_skip` for symmetry when rebasing. #1505 removed `getMcpServers` consumers' comments only; note cursor-bot's point that `getMcpServers` (merged view) now has no production consumer — candidate for deletion on rebase.

## Test assessment

- Python (85 passed, `uv run --with pytest`): genuinely strong. Real keyless stdio fixture speaks raw JSON-RPC over stdin (initialize/tools-list/tools-call with real protocolVersion) — mirrors real server writer output, satisfying the fixture-reality rule; real streamable-HTTP fixture uses the actual `MCPServer` SDK server. Child reaping asserted via pid + `os.kill` probe; redaction asserted against real ANSI/NUL/secret stderr with byte/line bounds. Concurrency tests (reload vs in-flight open, close vs in-flight startup, cancelled close retry) mock only `_Generation.open`/`_config`, exercising the real registry logic.
- TS (143 passed across the 7 specified files; `tsgo --noEmit` clean): mcp-command parse/validation matrix is thorough (argv fidelity incl. spaces, `__proto__`/`constructor` env names, reserved names, URL/credential rejection, atomic global-only persistence with concurrent-field preservation); interactive-mode tests render through real showStatus to pin redaction at the output boundary; agent-session-services test builds a real session and asserts prompt advertisement + secret absence + reload refresh.
- Gaps: no real-ipykernel shutdown test (F2); upgrade path covered at venv level but not with a populated old kernel-state.dill (low risk, reasoned above); no test that a legacy literal-env stdio entry produces its ValueError (F5).

## Bot-comment resolution spot-checks (5 of 17)

1. Boolean `callTimeoutMs` (macroscope 3799455574) — **real fix**: `_seconds` rejects `bool` explicitly (mcp.py:483-488) + `test_boolean_timeout_is_rejected`.
2. `__proto__`/`constructor` `--env` mangling (macroscope 3800027257) — **real fix**: `env = Object.create(null)` in `parseMcpAddArgs` + dedicated test.
3. Shutdown hook breaks sync `do_shutdown` (cursor 3799684125) — **real fix**: wrapper awaits only when `hasattr(result, "__await__")` (mcp.py:504-509) + `test_shutdown_hook_supports_synchronous_kernel_handler`.
4. Reserved names block `get`/`remove` (cursor 3800063845) — **real fix**: catalog reservation moved into `parseMcpAddArgs` only; `validateName` shape-only; test "allows inspecting and removing hand-edited reserved entries".
5. Reload misses in-flight servers (cursor 3800924899) — **real fix**: `reload()` now walks `set(_locks) | set(_generations)` and acquires each lock (mcp.py:303-310) + `test_reload_waits_for_in_flight_first_open`.
Also verified in passing: catalog-override auth bypass (isAuthed guard now precedes stdio/anonymous returns), host_request comm leak (comm closed in `finally`, `__init__.py:140-145`), `_config` now bounded by `asyncio.timeout`.

## Nits

- F7 (stale override error message), F8 (`mcp get` too terse).
- `packages/coding-agent/src/core/mcp/mcp-command.ts`: `formatMcpServerSummary` is a pointless alias of `formatMcpServer`.
- `mcp.py:269,290,297,305,316`: five copies of `self._locks.setdefault(...)` — a `_lock(name)` helper would read better.
- Docs say "Both surfaces update only ~/.prime/agent/settings.json" — true and good, but nothing warns a user whose project-local `mcpServers` were previously merged for the authored-skill path (F3's compat cousin).
- On rebase: add `mcp` to state-snapshot `always_skip`; consider deleting the now-unconsumed `getMcpServers`.

## Commands run

- `cd prime-agent-runtime && uv run --with pytest python -m pytest -q test` → 85 passed.
- `npx vitest --run test/mcp-manager.test.ts test/settings-manager.test.ts test/ipython-bootstrap.test.ts test/kernel-bootstrap.test.ts test/mcp-command.test.ts test/system-prompt.test.ts test/public-command.test.ts` (env-scrubbed per brief) → 7 files, 143 passed.
- `npx tsgo --noEmit` → clean.
- `git merge-tree --write-tree f8f0036cc HEAD` → conflicts: CHANGELOG.md, test/settings-manager.test.ts.

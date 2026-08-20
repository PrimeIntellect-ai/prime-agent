# Prime Agent v0.7.0 — Verified API Reference

> Extracted from Prime Agent source/docs at commit be9e2fa0 (v0.7.0) by a
> multi-agent audit on 2026-08-07. This is the ground truth prime-harness is
> built against. Re-verify the OPEN QUESTIONS section and any load-bearing
> claim after major Prime Agent updates.

# Prime Agent — Consolidated API Reference (Ground Truth for Harness Engineering)

Consolidated from seven parallel source readers. All paths repo-relative to `C:/Users/Chris/Projects/Prime-Agent` unless absolute. Claims are tagged with their source file. Contradictions between readers or between docs and code are flagged inline as **DISCREPANCY** (code wins unless noted). Runtime-verification items are collected in OPEN QUESTIONS at the end.

Repo state: read at commit `be9e2fa0` (v0.7.0 prep) with local working-tree modifications; cited line numbers are working-tree. Authoritative sources are `prime-agent-runtime/` and `packages/coding-agent/skills/` — `dist/` and `.worktrees/` contain duplicate copies; do not read from those.

---

## 1. Kernel / RLM Python API

### 1.1 The IPython tool and bootstrap

- The **only built-in model tool is `ipython`**; schema is a single field `code: string` (Python or `%%bash` cells) [src/core/tools/ipython.ts; docs/rlm.md]. CLI `--tools` requesting `read`/`write`/`grep`/`find`/`ls` is a hard error (`REMOVED_BUILTIN_TOOL_NAMES`) [src/cli/args.ts:63-64].
- Bootstrap cell (`RLM_BOOTSTRAP_BASE_CODE` / `buildRlmBootstrapCode`) [src/core/tools/ipython.ts]:
  - `import rlm as _prime_agent_rlm_module; rlm = _prime_agent_rlm_module.rlm` — global `rlm` is the `_RLMCallable`. Import failure binds a stub whose methods raise `RuntimeError`.
  - Sets `os.environ["NO_COLOR"]="1"`, `get_ipython().colors="nocolor"`, best-effort `nest_asyncio.apply()`.
  - Every installed Python skill is pre-imported into `globals()` under its import name. Modules defining callable `run` are wrapped in `_PrimeAgentCallableSkillModule`, making the module itself awaitable-callable: `await edit(...)` == `await edit.run(...)` (sync or async `run`; `__signature__`/`__doc__` copied). Failed imports become `_PrimeAgentUnavailableSkill` placeholders that raise `RuntimeError` when called; errors collected in `_PRIME_AGENT_SKILL_IMPORT_ERRORS`.
  - The module-callable behavior exists **only inside the Prime Agent kernel bootstrap** — plain `python -c "import edit"` exposes only `edit.run(...)`.
- One kernel = one serialized execution lane: `KernelManager.execute()` calls are serialized; two ordinary cells never run concurrently. Concurrency comes only from spawned RLM children (distinct comm + child runtime each) [docs/rlm-runtime.md]. Kernel is created lazily on first IPython use (`prewarmIpythonKernel` opt-in for roots) [agent-session.ts ~482].
- `%%bash` rules (prompt contract): must be the first line of the cell; each `%%bash` cell is a throw-away subshell; persist state via `%cd`, `os.environ[...]`, `%env` [src/core/prompts/rlm.ts].

### 1.2 `rlm` module — exact API

Source: `prime-agent-runtime/src/rlm/__init__.py`. `__all__`: `HarnessEntry`, `HarnessScope`, `HarnessState`, `McpIntegration` (lazy), `McpToolError` (lazy), `NotEnabled` (lazy), `RLMModel`, `RLMSpawnHandle`, `RLMSubagent`, `RefinementEvent`, `delete_subagent`, `find_models`, `get_harness_state`, `harness`, `host_request`, `list_subagents`, `rlm`, `run`. Module class is swapped so `await rlm("task")` works on the imported module itself.

**DISCREPANCY (docs vs code):** `docs/rlm-runtime.md` lists a `TokenUsage` export; it does not exist anywhere in `prime-agent-runtime`. Do not build against it.

All coroutines (`await` required):

| Call | Signature | Notes |
|---|---|---|
| `rlm.run` / `rlm(...)` | `run(prompt: str, **kwargs) -> RLMSpawnHandle` | `TypeError` on non-str prompt. Returns at **admission**, never with the child's answer. |
| `rlm.find_models` | `(query="", limit=8) -> list[RLMModel]` | Host: default limit 8, max 20 (`MAX_RLM_MODEL_SEARCH_LIMIT`); limit must be integer 1..20 or host errors. Bounded to models with active non-expired credentials [rlm-runtime.ts; docs/rlm-runtime.md]. |
| `rlm.list_subagents` | `() -> list[RLMSubagent]` | Registry is parent-scoped; survives kernel restart, compaction, parent restore. |
| `rlm.delete_subagent` | `(target: str \| RLMSubagent) -> RLMSubagent` | Selector: exact child ID, active-session ID, session ID, or unique name; empty string raises `ValueError`. Host result includes `outcome ∈ "deleted" \| "skipped_running"` — deleting a running child may be skipped; deletion writes a tombstone but never erases transcript/artifacts on disk [rlm-runtime.ts `RlmDeleteSubagentResult`; docs/rlm-runtime.md]. |
| `rlm.host_request` | `(request_type: str, payload: dict \| None) -> dict` | Jupyter comm `target_name="host.request"`; `type` key placed last so payload cannot reroute. `{"status":"ok",...}` → reply minus `status`; `{"status":"error"}` → `RuntimeError`. Replies arrive on the **control channel** (registered in `kernel.control_handlers`, completed via `loop.call_soon_threadsafe`) to avoid the shell-channel deadlock while a cell is awaiting admission [rlm/__init__.py; docs/rlm-runtime.md]. |
| `rlm.harness` | `_HarnessProxy` → `get_harness_state()` per access | See §7.4. |

Frozen dataclasses: `RLMSpawnHandle(rlm_child_id, name, session_dir: Path, model)`; `RLMModel(provider, id, name, selector)`; `RLMSubagent(rlm_child_id, active_session_id: str|None, session_id: str|None, session_name, session_dir: Path, status)` with `status ∈ {"running","completed","error"}`.

### 1.3 `rlm.run` semantics (host-validated)

Sources: `src/core/rlm-runtime.ts`, `src/core/agent-session.ts` `_startRlmChildRun`, `docs/rlm-runtime.md`.

- **Supported kwargs: exactly `name` and `model`.** Anything else throws `` `Unsupported rlm.run kwargs: ...` `` — options are never silently ignored.
- `name`: non-empty after trim, max **64** chars (`RLM_SUBAGENT_SESSION_NAME_MAX_LENGTH`), unique among siblings. If omitted, host generates `subagent-<prompt-slug>-<last-8-of-child-id>` (NFKD, lowercase, `[^a-z0-9]+`→`-`, fallback slug `worker`).
- `model`: exact `provider/model` selector from `rlm.find_models()`. Unavailable/failed-preflight model **fails the spawn** — no silent fallback; otherwise child inherits parent model.
- **Depth check**: `if (this._rlmDepth >= this._rlmMaxDepth) throw` (message `RLM recursion depth limit reached (RLM_DEPTH=..., RLM_MAX_DEPTH=...)`). **DISCREPANCY:** `docs/rlm-runtime.md` says "Python raises before opening a comm", but the current Python shim contains no depth check — the **host check in `_startRlmChildRun` is the enforcement point**.
- Child execution: depth check → resolve model → `sub-xxxxxxxx` dir under parent artifact dir → admit + return handle → detached child `SessionManager`/`Agent`/`AgentSession` reusing provider hooks/tools/transport/retry/thinking config → run, retain session → usage attributed to parent assistant turn as a `child_usage_attributed` transcript entry. Children get incremented `RLM_DEPTH`, inherited max depth, own `RLM_SESSION_DIR`.
- Results come back only via `agent_message` replies (later turns) or files the child writes. Prompt doctrine: "Spawn independent children in separate calls and end your turn instead of awaiting completion" [src/core/prompts/rlm.ts].

### 1.4 Depth limits and configuration

Sources: `src/core/rlm-max-depth.ts`, `agent-session.ts` `_resolveRlmMaxDepth()`, `src/core/settings-manager.ts`.

Resolution precedence (highest wins): **chat** (persisted transcript custom entry `rlm_max_depth_state` `{maxDepth: non-negative safe int}`) → **inherited** (`AgentSession` constructor option `rlmMaxDepth`) → **global** (settings key `rlmMaxDepth`; read from **global settings only** — project scope ignored [settings-manager.ts:755]) → **env** `RLM_MAX_DEPTH` (must match `/^\d+$/` or session construction throws) → **default `1`** (root depth 0 can spawn; children depth 1 cannot).

- `rlmDepth` constructor option: roots default to `RLM_DEPTH` env or 0.
- Slash command `/rlm-max-depth [<int> [--global]]`; daemon protocol commands `get_rlm_max_depth_status`/`set_rlm_max_depth` require `minProtocol: 7, minSchemaRevision: 11` [src/modes/daemon/daemon-protocol.ts].
- **Caution:** kernel env `RLM_MAX_DEPTH` is provisioning-time only and can be **stale** in a running kernel; the TypeScript spawn check is authoritative [agent-session.ts `_rlmKernelEnv()` comment].

### 1.5 Host request types registered per session

`_createKernelHostHandlers()` [agent-session.ts]:
- Always: `rlm.run`, `rlm.find_models`, `rlm.list_subagents`, `rlm.delete_subagent`, `model.info` (returns `{id, provider, input}`; undocumented elsewhere).
- Conditional (only when the feature/controller is enabled): `goal.get|create|complete`; `compact.run|status`; `refine.run|status`; `rlm_heartbeat.list|create|update|delete`; `agent_message.*`; `agent_observe.*`; `mcp.*` (refresh, begin_login) when an MCP manager is present.
- Skills whose controller is absent are filtered from the model-visible skill list (`_modelVisibleSkills()`). **Harness code should probe (`"agent_message" in globals()`) rather than assume availability.**

### 1.6 Bundled Python skills — kernel signatures

Skill name constants: `agent-message`, `agent-observe`, `orchestration-heartbeat`, `goal`, `compact`, `refine`, `rlm-heartbeat` [src/core/agent-messages.ts, agent-observe.ts, goals.ts, compaction/compaction.ts, refinement/refinement.ts].

**`agent_message`** [skills/agent-message/src/agent_message/__init__.py + SKILL.md]:
- `list_agents() -> dict` — `current` (`name`,`id`,`depth`) + family-scoped `entries` (`relationship`,`name`,`id`,`depth`,`status`).
- `send(message, broadcast_message=None, *, receiver_role: "parent"|"sibling"|"child"|None = None, receiver_name: str|None = None) -> dict`.
  - Direct: `receiver_role` required; `receiver_name` **must be omitted** for `"parent"` (ValueError if supplied) and **required** non-blank for `"sibling"`/`"child"`.
  - Broadcast: `send("all", broadcast_message)` — first positional is the literal string `"all"`, message in second positional; combining with receiver kwargs raises `TypeError`. Returns `{"receipts":[...]}` in roster order.
  - Receipt `deliveryStatus`: `"delivered"` (+`deliveredAt`) or `"queued"` (+`queuedAt`); send never blocks on delivery. Display MIME `application/vnd.prime-agent.agent-message+json`.
  - **CONTRADICTION between readers:** `docs/long-running-agents.md` shows a `mode="auto"` kwarg on `send()` (modes `auto`/`steer`/`follow_up`); the Python source signature read by the kernel reader has **no `mode` parameter** and the SKILL.md says messages always use steering delivery. Verify at runtime before passing `mode`; treat the source signature as authoritative.
- Reach: parent, siblings, direct children only; roots are siblings; deeper relays through intermediate children. Sender identity is daemon-derived, unspoofable from Python; daemon enforces message-size/rate/pending-queue limits (numbers not documented).

**`agent_observe`**: `list_agents()` → `agent_observe.list`; `get_agent(target)` (active id, session id/name, or suffix); `recent_messages(target, limit=8, max_chars=800)` — host validates limit 1–50, max_chars 80–2000.

**`goal`**: `get()` → `{goal: SerializedGoal|None, remaining_tokens, completion_budget_report}`; `create(objective, token_budget=None)` — fails while a goal is pending (active/paused/budget_limited), replaces completed/errored; `complete()` — the only success signal. Prime Agent does not know repository verification state, so Prime Harness policy additionally requires a passing `harness_orchestrator.completion_check()` immediately before this call; no wrapper can make an out-of-policy direct call impossible at the product API boundary.

**`rlm_heartbeat`**: `list(include_inactive=False)`; `create(instruction, interval=None, label=None, delivery_mode: "steer"|"follow_up"|None=None)` — default interval every 5 minutes, example `"5m"`; `update(id, instruction=None, interval=None, label=None, status: "pause"|"resume"|None=None, delivery_mode=None)`; `delete(id)`. Agent-internal; separate from user `/heartbeat`; cannot replace/clear the user heartbeat.

**`compact`**: `status()` → `{tokens, context_window, percent (None right after compaction), scheduled}`; `run(instructions=None)` → `{"scheduled": True}` or `{"scheduled": False, "reason": ...}`. **Never runs mid-cell** — schedules for end of turn; harness auto-resumes.

**`refine`**: `status()` → `{pending, in_flight}`; `run(instructions=None, global_=False)` (payload `global: true`). Same end-of-turn scheduling contract as compact (see §7.3).

**`edit`**: `run(path, old_str, new_str) -> str` — exact single-occurrence replacement; `~` expanded; raises `FileNotFoundError`/`ValueError` (absent or >1 match). Diff streamed via MIME `application/vnd.prime-agent.diff+json`.

### 1.7 Kernel environment & venv bootstrap

Source: `src/core/kernel/bootstrap.ts`, `docs/rlm-runtime.md`.

- Python resolution: 1) `PRIME_AGENT_KERNEL_PYTHON` (must import ipykernel + pass `RUNTIME_READY_CHECK`; Prime Agent installs nothing into it); 2) managed venv `~/.prime/agent/kernel-venv` (override `PRIME_AGENT_KERNEL_VENV`), bootstrapped with `uv`; 3) XDG fallback `${XDG_DATA_HOME:-~/.local/share}/prime/agent/kernel-venv` (undocumented in docs).
- Managed env: Python **3.11**; installs `ipykernel`, `prime-agent-runtime` (bundled in-package, **not on PyPI — never declare it in skill dependencies**), `dill`, and extras. `BOOTSTRAP_SCHEMA = 8`; marker `.bootstrap-version`; lock `<venv>.bootstrap.lock`. uv auto-install gated by `PRIME_AGENT_INSTALL_UV` or TTY confirm.
- Pre-installed extras (import names): `requests, httpx, yaml, tomli, dotenv, pandas, numpy, scipy, bs4, lxml, pydantic, tyro`. Model installs more via `uv pip install <pkg>` (no pip module in the venv).
- Python skills installed with `uv pip install --editable <packagePath>`, topologically sorted by sibling pyproject deps; a failed skill install degrades to a warning.
- Kernel env vars set at provisioning [agent-session.ts `_rlmKernelEnv()`]: `RLM_DEPTH`, `RLM_MAX_DEPTH`, `RLM_GLOBAL_HARNESS_STATE_DIR`, and when a session dir exists `RLM_SESSION_DIR` + `RLM_HARNESS_STATE_DIR`; plus `PRIME_AGENT_CODING_AGENT_DIR` and (websearch only) the Serper key.
- Transport: Jupyter over ZeroMQ (shell/iopub/control), HMAC-SHA256-signed frames.
- TS-side `RUNTIME_READY_CHECK` asserts: callable `rlm`, `rlm.run/host_request/find_models/harness/get_harness_state`, the 12 typed harness CRUD methods + `record_refinement`, `reference`/`scope` dataclass fields, `global_` params, and **absence** of `rlm.background`.
- **Windows caveat:** `bootstrapVenv` hardcodes `path.join(venv, "bin", "python")` and uv install falls back to `sh -c` — Windows-native kernel bootstrap behavior is unaddressed in source/docs (see §8, OPEN QUESTIONS).

### 1.8 Trust model

The kernel runs model-generated Python/shell with the worker's OS permissions — a durable control environment, **not a security sandbox**. Provider credentials are resolved host-side; only the bounded model catalog crosses into Python as metadata; the auth store never does [docs/rlm.md; docs/rlm-runtime.md].

---

## 2. Skill Format & Discovery

### 2.1 SKILL.md format

A skill = directory containing `SKILL.md` (YAML frontmatter + markdown body). Frontmatter parsing [src/utils/frontmatter.ts]: content must start with `---` (CRLF normalized); ends at first `\n---`; parsed by the `yaml` package; no valid fence → frontmatter `{}`, whole file is body.

Fields [src/core/skills.ts `SkillFrontmatter`; docs/skills.md]:

| Field | Required (docs) | Enforced (code) |
|---|---|---|
| `name` | yes — max 64, `/^[a-z0-9-]+$/`, no leading/trailing/double hyphen, must match parent dir | **Warning only**; falls back to parent dir name if absent |
| `description` | yes — max 1024 | **The only hard requirement**: missing/blank → skill not loaded; over-length is a warning |
| `license`, `compatibility`, `metadata`, `allowed-tools`, `disable-model-invocation` | optional | `disable-model-invocation: true` hides the skill from the system prompt (only `/skill:name` invokes it). The rest ride through unenforced; `allowed-tools` has no visible runtime plumbing (docs label it "experimental") |

Constants: `MAX_NAME_LENGTH = 64`, `MAX_DESCRIPTION_LENGTH = 1024`. Name collisions: first-wins, `collision` diagnostic recorded; symlink duplicates of the same canonical file skipped silently.

### 2.2 Discovery locations and modes

Two modes, `SkillDiscoveryMode = "pi" | "agents"` [src/core/package-manager.ts:339]:
- Both: a dir containing `SKILL.md` is a skill root (no deeper recursion); otherwise recurse. Dot-dirs and `node_modules` skipped; `.gitignore`/`.ignore`/`.fdignore` honored; symlinks followed, broken ones skipped.
- `"pi"` mode (`.prime/agent/skills`, settings/CLI paths, built-ins): root-level bare `*.md` files also load as individual skills. Such bare-file skills can **never** be Python-backed (`basename === "SKILL.md"` gates detection).
- `"agents"` mode (`~/.agents/skills`, project `.agents/skills`): only `SKILL.md` directories count.

Locations:
- Global: `~/.prime/agent/skills/` and `~/.agents/skills/` (hardcoded) [package-manager.ts:2181].
- Project: `<cwd>/.prime/agent/skills/`, plus `.agents/skills/` in cwd **and every ancestor up to the git repo root** (`.git` detection) or FS root [package-manager.ts:419-452, 2175-2184].
- Packages: `skills/` dirs or `pi.skills` entries in package.json (`PiManifest { extensions?, skills?, prompts?, themes? }`).
- Settings: `skills` array (globs; `-path` force-exclude, `+path` force-include, `!pattern` exclusion); e.g. `"skills": ["-prime-intellect/SKILL.md"]` disables a built-in. Claude Code/Codex compat: add `~/.claude/skills`, `~/.codex/skills` to the array.
- CLI: `--skill <path>` (repeatable, additive even with `--no-skills`/`-ns`).
- Built-in (lowest precedence): bundled `skills/` — `agent-message, agent-observe, attach-image, compact, edit, goal, linear, notion, prime-intellect, refine, rlm-heartbeat, skill-creator, websearch`. Disable all: `{"enableBuiltinSkills": false}`; websearch alone: `{"bundledSkills": {"websearch": false}}` — **websearch is disabled unless enabled** [package-manager.ts:2267-2273].
- Note: `loadSkills()` in skills.ts handles only `<agentDir>/skills`, `<cwd>/.prime/agent/skills`, and explicit paths; the `.agents` walk, packages, and built-ins are aggregated in package-manager.ts/resource-loader.ts.

### 2.3 Progressive disclosure & prompt format

At startup only `name`, `type`, `python_import` (python skills), `description`, `location` enter the system prompt inside an `<available_skills>` XML block (values XML-escaped; `disableModelInvocation` skills filtered out) [skills.ts:450-481]. The model is instructed to read the full SKILL.md via ipython on match — **docs warn models don't always do this; force with prompting or `/skill:name`**.

### 2.4 `/skill:name` invocation

Enabled by `{"enableSkillCommands": true}` (default true). Expansion `_expandSkillCommand` [agent-session.ts:4791-4816] produces:

```
<skill name="NAME" location="FILEPATH">
References are relative to BASEDIR.

BODY
</skill>
```

With args: `${skillBlock}\n\n${args}`. **DISCREPANCY:** docs/skills.md claims args are appended as `User: <args>`; code appends the raw args with no prefix — `parseSkillBlock` [src/core/skill-blocks.ts] matches the code. Build against code. Unknown skill names pass through unchanged. `/reload` rediscovers metadata; a **new session** is required for a newly added Python-backed skill (kernel install happens at setup).

### 2.5 Python-backed skills

Detection [skills.ts:202-254]: `SKILL.md` + `pyproject.toml` at skill root + `importName = name.replaceAll("-","_")` matching `/^[A-Za-z_][A-Za-z0-9_]*$/` + `src/<import_name>/__init__.py` (src layout, exact). Any failure → degrades to markdown skill with a warning. Duplicate import names → first wins.

pyproject template [skills/skill-creator/references/python-skills.md]: hatchling build backend; `[tool.hatch.build.targets.wheel] packages = ["src/<import_name>"]` required whenever project name ≠ package dir (always, for hyphenated names). Optional CLI: `[project.scripts] <import_name> = "rlm.skill:cli"` — script name must exactly equal the import name (underscores); `rlm.skill:cli` parses argv against `run()`'s signature with `tyro`, awaits async, prints non-None. Usable from shell: `!word_count "text" --top 3`.

Install: editable into the kernel venv; reinstall keyed on `sha256(pyproject.toml)` — editing Python source needs no reinstall; editing pyproject triggers one. Sibling-skill dependencies auto-resolved and topologically sorted [bootstrap.ts:122-323].

`run()` convention: defines module-callable behavior (§1.1); without `run()`, module is imported/bound but not callable. Skills may themselves spawn subagents (`import rlm; await rlm.run(...)`).

---

## 3. Goals, Autonomous Mode, Heartbeats, Schedules

### 3.1 Goals

Surfaces: TUI `/goal <objective>`, `/goal --budget <n> <objective>`, `/goal status|pause|resume|clear`; CLI `--goal <objective>` (non-empty required), `--goal-token-budget <n>` (positive int, **requires `--goal`**) [docs/long-running-agents.md; src/cli/args.ts:262-274]. **Note the naming split:** TUI `--budget` vs CLI `--goal-token-budget`. Goal applies only to a new root session with no existing goal state. Creating a goal is an explicit user/host action; only `await goal.complete()` marks success.

State model [src/core/goals.ts]:
- `GoalStatus = "idle"|"active"|"paused"|"budget_limited"|"complete"|"error"`; kernel payload `SerializedGoal` is snake_case and never `"idle"`.
- Constants: `GOAL_STATE_CUSTOM_TYPE = "thread_goal_state"`, `GOAL_CONTEXT_CUSTOM_TYPE = "goal_context"`, `MAX_THREAD_GOAL_OBJECTIVE_CHARS = 4000` (code-point counted).
- `GoalHostResponse.remaining_tokens = max(0, tokenBudget - tokensUsed)`, null when no budget.
- **Token accounting: `input + output` only** (`goalTokenDeltaForUsage`).
- Continuation injection: `role:"custom"` message, `customType:"goal_context"`, content in `<goal_context>` with XML-escaped `<objective>` (or `<untrusted_objective>` for `objective_updated`). Budget-limit prompt forces `budget_limited` and instructs no new substantive work.

### 3.2 Autonomous mode

CLI flags and **exact defaults** [src/cli/args.ts:224-261; src/core/autonomous.ts]:

| Flag | Default |
|---|---|
| `--autonomous` | off |
| `--autonomous-gate <command>` (repeatable, run in CLI order) | no gates |
| `--autonomous-gate-retries <n>` | **3** |
| `--autonomous-gate-timeout-ms <n>` | **300000** (5 min) |
| `--autonomous-max-continuations <n>` | **3** |
| `--autonomous-max-turns <n>` | **12** |
| `--autonomous-max-tokens <n>` | **80000** |
| `--autonomous-timeout-ms <n>` | **1800000** (30 min) |

- **Any `--autonomous-*` flag implies `--autonomous`.** Values must be separate arguments (`--flag=value` is NOT recognized — falls into unknownFlags silently). `parsePositiveInt` enforced at CLI; programmatic `AgentAutonomousConfig` values that are 0/negative/non-finite are **silently replaced with defaults** (`normalizeLimit`).
- **Token accounting: `input + output + cacheWrite`, cacheRead excluded** — differs from goal accounting; do not assume the counters advance together.
- Limit check order (all `>=`): continuations, turns, tokens, elapsed time.
- Decision (`AutonomousDecision.reason ∈ missing_terminal_evidence | gate_failed | not_needed | limit_reached`): no continuation on disabled or stopReason `error`/`aborted`. With gates: passed → stop; retry_exhausted or limit → stop; failed → continue. Without gates: limit → stop; else continue.
- Gate mechanics: spawned `shell: true`, per-gate timeout kills the process tree; output capped at `MAX_GATE_OUTPUT_CHARS = 6000` per stream, failure text truncated with `... [truncated]`. `retry_exhausted` when `attempt > maxRetries` — with default 3, failures 1–3 continue, the 4th terminates. Gates require a `cwd` (else immediate `"failed"`).
- **Unchanged-workspace skip**: before rerunning a failed gate, git status/diff (+SHA-256 of untracked files) is compared to the post-failure snapshot; unchanged → gate NOT rerun but **attempt counter still increments** (`exitText: "not rerun: workspace unchanged since previous failed gate"`). Pathspec excludes `verification`, `target`, `.vf-prime-agent`, `Cargo.lock`, `submission.tar.gz`, `runner_args.log`. Not a git repo → snapshot undefined → gates rerun every time.
- Print-mode exit semantics: gates configured and still failing at end, or no gates and stopped by a limit → **exit 1** ("Reaching a limit does not imply task success").
- `turnsUsed` increments for every assistant message while enabled even with undefined usage.

### 3.3 Heartbeats

User `/heartbeat` [parseHeartbeatCommand, src/core/cron-jobs.ts]:
- Usage: `/heartbeat [--every <interval>] [--steer|--follow-up] <instruction>`; also natural leading `every|each N <unit>`. `status` (also bare `/heartbeat`), `pause`, `resume`, `clear` (alias `stop`).
- Defaults: `DEFAULT_HEARTBEAT_SCHEDULE = "every 5m"`; `DEFAULT_HEARTBEAT_DELIVERY_MODE = "steer"`. Bare `10m` normalized to `every 10m`. Delivery flags: `--steer`, `--follow-up`/`--follow_up`, `--deliver <steer|follow_up>`; rightmost trailing flag wins; invalid mode errors.
- **One user heartbeat per session** — creating a new one cancels the existing `source:"heartbeat"` job for that `activeSessionId`. Heartbeat schedules must be recurring (`once` throws). Cron expressions appear to flow through `--every` (unconfirmed intent — see OPEN QUESTIONS).
- RLM heartbeats (`source:"rlm_heartbeat"`) are additive, multiple allowed, separately namespaced; Python API in §1.6. `/heartbeats` (plural) inspects both kinds.
- Deferral (`shouldDeferHeartbeatCronJob`): always defer during compacting/retrying/bash-running/pending-session-work, or (not streaming and unfinished actions); while merely streaming, `steer` heartbeats fire, `follow_up` defer.
- Spelling varies by surface: JSON/TS `deliveryMode: "steer"|"follow_up"`; slash flag `--follow-up`; Python kwarg `delivery_mode`.

### 3.4 Schedules / cron

Schedule text grammar [`parseAgentCronSchedule`, src/core/cron-jobs.ts] — trimmed, surrounding quotes stripped; four forms:
1. `in N <m|min|...|h|...|d|day|days>` → once (no seconds unit).
2. `every|each N <s|...|m|...|h|...>` → interval; **minimum 10 seconds** (no days unit).
3. `at <ISO date>` → once; must be in the future.
4. Cron: `@hourly|@daily|@weekly|@monthly` aliases or exactly five fields `minute hour day month weekday` (weekday 0–7, 0 and 7 = Sunday; `*`, lists, ranges, `/step`). **Local-time, minute-granularity**; no match within 366 days → error.

Persistence: per-session `session-artifacts/<session-id>/scheduled-jobs.json` — `{ "jobs": AgentCronJob[], "dispatches": AgentCronDispatchRecord[] }`, atomic tmp-file+rename+fsync writes, dir 0o700 / file 0o600, `proper-lockfile` locking (stale 30 s). No global cron file.

`AgentCronJob`: `id` (UUID), `status ∈ active|paused|completed|cancelled`, `source? ∈ cron|heartbeat|rlm_heartbeat` (default cron), `runtimeKind? ∈ top-level|subagent`, `deliveryMode?` (heartbeats only, default steer), `activeSessionId`, `sessionId`, `sessionFile`, `cwd`, `label?`, `prompt`, `schedule {kind, expression, intervalMs?}`, ISO timestamps, `runCount`, `lastError?`, `lastSkippedAt?`.

Claim/coalesce semantics (critical for a harness):
- Due = `active && nextRunAt <= now`. **Claiming advances `nextRunAt` immediately** (before delivery) so a crash never replays an uncertain prompt. A due job with an outstanding dispatch gets `lastSkippedAt` (coalesced), never a second dispatch.
- Interrupted dispatches recovered on scheduler start set `lastError: "Interrupted before scheduled operation completion"`; `once` jobs complete.
- Dispatches serialized per `activeSessionId`; timer delay capped at 2,147,483,647 ms.

CLI: `prime-agent schedule add <agent> "<schedule>" -- "<prompt>"`, `schedule list [--all] [agent] [--json]`, `schedule cancel <job-id>` [docs/long-running-agents.md; src/cli/command-registry.ts]. Adding a schedule/heartbeat over RPC promotes the session to a resident daemon session that survives stdin close.

---

## 4. CLI & Headless (JSON / RPC / SDK)

### 4.1 Invocation and parsing quirks

`prime-agent [options] [@files...] [messages...]`. Modes: interactive (default), `-p`/`--print`, `--mode json`, `--mode rpc`; `Mode` also includes undocumented `"acp"` and `"daemon"` (+ `--daemon-socket <path>`) [args.ts:8,102-108].

Parsing hazards a harness must handle [args.ts]:
- **`--flag=value` is generally unsupported** (only `--resume=` has it). `--model=x` silently lands in `unknownFlags` — no error, flag ineffective.
- **Unknown long flags greedily swallow the next positional** — a typo'd flag can silently eat your prompt.
- **Invalid `--mode` values silently ignored** → interactive.
- `-p` consumes the next arg as message unless it starts with `@` or `-` (a `---` token IS consumed). `--` ends option parsing.
- Autonomous value flags reject a following `--token` ("requires a value") but consume single-dash values.
- Removed flags `--list-models`, `--export` now error, pointing at `model list` / `session export`.

Key flags: `--provider`, `--model <pattern>` (supports `provider/id` and `:<thinking>` suffix e.g. `sonnet:high`), `--api-key`, `--thinking <off|minimal|low|medium|high|xhigh|max>` (invalid → warning, ignored), `--models <csv>`, `-c/--continue`, `-r/--resume [path|id]`, `--fork`, `--session-dir`, `--no-session`, `--tools/-t` (built-ins list is exactly `["ipython"]`), `--no-builtin-tools/-nbt`, `--no-tools/-nt`, `-e/--extension`, `--no-extensions/-ne`, `--skill`, `--no-skills/-ns`, `--prompt-template`, `--no-prompt-templates/-np`, `--theme`, `--no-themes`, `--no-context-files/-nc`, `--system-prompt`, `--append-system-prompt` (repeatable), `--cwd`, `--verbose`, `--offline` (skips startup network only — inference still needs credentials).

**DISCREPANCY (thinking levels):** CLI and settings accept 7 levels incl. `max`; rpc.md `set_thinking_level` and sdk.md document only through `xhigh` (`xhigh` = OpenAI codex-max only). Verify `max` over RPC at runtime.

Subcommands: `agents`, `list [--all] [--json]`, `attach <agent>`, `stop`, `rename`, `send [--from <agent>] [--steer] [--follow-up] [--json] <agent> <message>`, `schedule ...`, `status [--json]`, `doctor [--fix] [--json]`, `shutdown [--force] [--json]`, `package install|remove|list|update`, `update [--force]`, `config`, `model list [search]`, `session export <file> [output]`, `help`. Daemon client: `prime-agent daemon <start|ps|list|create|attach|detach|kill|rename|prompt|send|agent-messages|steer|follow-up|state|messages|stats|commands|cron|retry|restart|shutdown>` (default `open`; `--socket|--daemon-socket`, `--json`) [src/cli/daemon-command.ts:28-130].

### 4.2 JSON event stream (`--mode json`)

First stdout line: `{"type":"session","version":3,"id":"uuid","timestamp":"...","cwd":"..."}`, then one JSON object per line [docs/json.md]. Event union (`AgentSessionEvent`): `agent_start`, `agent_end{messages}`, `turn_start`, `turn_end{message,toolResults}`, `message_start/update/end`, `tool_execution_start/update/end`, `session_action_update{actions}`, `compaction_start{reason: manual|threshold|overflow}`, `compaction_end`, `auto_retry_start{attempt,maxAttempts,delayMs,errorMessage}`, `auto_retry_end`. Non-JSON diagnostics go to stderr (filter with `2>/dev/null` per docs; exact stderr contract unspecified).

### 4.3 RPC mode (`--mode rpc`)

Framing [docs/rpc.md]: strict JSONL, **LF only** delimiter (strip trailing `\r`); do NOT use Node `readline` (splits on U+2028/2029 inside JSON strings). All commands accept optional `id`, echoed in the single `{"type":"response","command",...,"success",data?/error?}` — **at most one response per id**; post-acceptance failures arrive only via events. Parse failures respond with `command:"parse"`.

Commands (exact field names): `prompt` (`message`, `images?`, `streamingBehavior?` — **required while streaming**, `"steer"|"followUp"`), `steer`, `follow_up`, `abort`, `abort_retry`, `abort_bash`, `new_session{parentSession?}`, `get_state`, `get_messages`, `set_model{provider,modelId}`, `cycle_model`, `get_available_models`, `set_thinking_level{level}`, `cycle_thinking_level`, `set_steering_mode`/`set_follow_up_mode{mode:"all"|"one-at-a-time"}` (documented default `"one-at-a-time"`; **DISCREPANCY:** rpc.md's `get_state` example shows `"steeringMode":"all"` — verify at runtime), `compact{customInstructions?}`, `set_auto_compaction`/`set_auto_retry{enabled}`, `bash{command}`, `get_session_stats`, `export_html`, `switch_session{sessionPath}`, `fork{entryId}`, `clone`, `get_fork_messages`, `get_last_assistant_text`, `set_session_name{name}`, `get_commands`, `refine{instructions?,rollbackId?,global?}` (extended client timeout; see §7.5).

Daemon-coordination commands: `send_message{targetActiveSessionId, message, deliveryMode?: auto|steer|follow_up}`, `agent_messages_status|pause|resume|clear`, `list_schedules{includeInactive?}`, `add_schedule{schedule,prompt}`, `cancel_schedule{jobId}`, `list_heartbeats`, `get_heartbeat`, `set_heartbeat{schedule,prompt,deliveryMode?}`, `update_heartbeat{action: pause|resume|clear}`, `manage_heartbeat{activeSessionId,jobId,action: pause|resume|stop}`.

Observation: `{"type":"observe","activeSessionId"}` → wrapped `observed_session_event` records; `observed_session_closed` on target close; `unobserve` to stop. Serialized per `activeSessionId`.

**RPC `bash` gotcha:** no event is emitted; output becomes a `BashExecutionMessage` and reaches the LLM only on the **next** `prompt`.

Extension UI sub-protocol: blocking `select|confirm|input|editor` via `extension_ui_request`/`extension_ui_response`; fire-and-forget `notify|setStatus|setWidget|setTitle|set_editor_text`.

`assistantMessageEvent` delta types: `start`, `text_start/delta/end`, `thinking_start/delta/end`, `toolcall_start/delta/end`, `done` (`stop|length|toolUse`), `error` (`aborted|error`). `tool_execution_update.partialResult` is accumulated output, not a delta.

**ImageContent DISCREPANCY:** rpc.md wire shape `{"type":"image","data":"<base64>","mimeType":"image/png"}`; sdk.md in-process example `{type:"image", source:{type:"base64", mediaType, data}}`. Verify against `packages/ai/src/types.ts` per surface.

### 4.4 Exit codes

- Print/JSON (`runPrintMode` → `Promise<number>`): 0 success; 1 on stopReason `error`/`aborted`, failed terminal result, failed compaction, failing/limit-stopped autonomous run, or any throw. Signals: SIGINT→130, SIGHUP→129 (non-Windows), SIGTERM→143 [src/modes/print-mode.ts:80-94,145-159].
- RPC: stdin EOF → wait for idle → exit 0 (1 if idle wait fails); connection closed with error → 1; SIGTERM→143, SIGHUP→129; **no SIGINT handler** — close stdin for graceful shutdown [src/modes/rpc/rpc-mode.ts:174,200-207,529-542].

### 4.5 SDK (`@earendil-works/pi-coding-agent`)

Package name retains the `pi` lineage; the installed **bin in this repo's package.json is `pi`**, not `prime-agent` (see §8). Main exports [docs/sdk.md]: `createAgentSession`, `createAgentSessionRuntime`, `AgentSessionRuntime`, `AuthStorage`, `ModelRegistry`, `DefaultResourceLoader`, `createEventBus`, `defineTool`, `SessionManager`, `SettingsManager`, tool factories (`createIpythonTool`/`createBashTool`/`createEditTool` + `*Definition` variants), `createAgentSessionFromServices`, `createAgentSessionServices`, `getAgentDir`, `InteractiveMode`, `runPrintMode`, `runRpcMode`, plus types.

- `createAgentSession(options)` → `{session, extensionsResult, modelFallbackMessage?}`. Options (by example, not exhaustive): `cwd`, `agentDir` (default `~/.prime/agent`), `model`, `thinkingLevel`, `scopedModels`, `authStorage`, `modelRegistry`, `tools: ["ipython"]`, `customTools`, `resourceLoader`, `sessionManager`, `settingsManager`.
- `AgentSession`: `prompt(text, options?)`, `steer`, `followUp`, `subscribe(listener) => unsubscribe`, `sessionFile`, `sessionId`, `setModel`, `setThinkingLevel`, `cycleModel`, `cycleThinkingLevel`, `agent`, `model`, `thinkingLevel`, `messages`, `isStreaming`, `navigateTree`, `compact`, `abortCompaction`, `abort`, `dispose`. `PromptOptions.preflightResult(true)` = accepted; `prompt()` resolves after the full run incl. retries; prompting during streaming without `streamingBehavior` **throws**.
- `AgentSessionRuntime` (`newSession`, `switchSession`, `fork`, clone = `fork(id,{position:"at"})`, `importFromJsonl`): after replacement the old `session` is stale — re-read `runtime.session`, re-subscribe, re-`bindExtensions`.
- `SessionManager` statics: `inMemory()`, `create(cwd)`, `continueRecent(cwd)`, `open(path)`, `list(cwd)`, `listAll()` (+ tree API, §6.4).
- `AuthStorage.create(path?)` (default `~/.prime/agent/auth.json`); resolution: runtime overrides → auth.json → env vars → models.json fallback resolver. `ModelRegistry.create(authStorage, modelsJsonPath?)`.
- `DefaultResourceLoader` requires `await loader.reload()`.
- `runPrintMode(runtime, {mode, initialMessage?, messages?})` returns the **exit code** — don't ignore it.

---

## 5. Settings & Prompt Supplementation

### 5.1 Config directory conventions

- `CONFIG_DIR_NAME = pkg.piConfig?.configDir || ".prime/agent"`; this repo sets `piConfig = {name:"prime-agent", configDir:".prime/agent"}` → global agent dir `~/.prime/agent`, env override `PRIME_AGENT_CODING_AGENT_DIR` (tilde-expanded); project dir `<cwd>/.prime/agent` [src/config.ts:486-527; package.json:6-9]. Env prefix derives from `piConfig.name`; hardcoded `PI_*` vars do not follow it.
- Paths under agent dir [config.ts]: `settings.json`, `models.json`, `auth.json`, `cron-jobs.json`, `tools/`, `bin/` (managed fd/rg), `prompts/`, `sessions/`, `themes/`, `logs/` (`agent.jsonl`, `client-errors.log`, `agent-traces.log`, per-daemon `<socketBasename>.<sha8>.log`), `daemon-update-restarts/<socketHash>.json`, `prime-agent-debug.log`. Log rotation: 5 MB, single `.old` rotation, best-effort.

### 5.2 settings.json — locations, merge, persistence

- Global `~/.prime/agent/settings.json`; project `<cwd>/.prime/agent/settings.json` — **exact cwd, no upward walk** [settings-manager.ts:218-221]. Project overrides global; "deep" merge is **one level of nesting only** (`{...base, ...override}`) — e.g. a project `retry.provider` object replaces the global one wholesale.
- Persistence: field-level merge under `proper-lockfile` (synchronous busy-wait up to ~200 ms); a settings file with invalid JSON loads as `{}` and **saves to that scope are refused** (`drainErrors`).
- Migrations on load — never write legacy keys: `queueMode`→`steeringMode`; boolean `websockets`→`transport`; object-form `skills`→`enableSkillCommands`+array; `retry.maxDelayMs`→`retry.provider.maxRetryDelayMs`.
- All plain setters write **global** scope; project setters exist only for `packages`/`extensions`/`skills`/`prompts`/`themes`. Edit the project file directly for anything else.

### 5.3 Settings schema (exact keys, defaults)

[settings-manager.ts:122-170; docs/settings.md]

- `defaultProvider`, `defaultModel`, `recentModels` (MRU, cap 20), `defaultThinkingLevel` (`off..xhigh|max` — **DISCREPANCY:** docs claim default `"xhigh"` and omit `"max"`; getter returns `undefined` when unset; the `"xhigh"` default is applied elsewhere), `defaultServiceTier` (default `"default"`).
- `rlmMaxDepth` (global-only read; see §1.4). `idleEvictionMinutes` (default **90**; global-only read; `"off"`, alias `"none"`).
- `transport: "sse"|"websocket"|"auto"` — **DISCREPANCY:** docs say default `"sse"`; code returns `"auto"`. Trust code.
- `steeringMode`/`followUpMode`: default `"one-at-a-time"`. `theme` (docs default `"dark"`).
- `compaction {enabled: true, reserveTokens: 16384, keepRecentTokens: 20000, agentCallable: true (undocumented; exposes the compact skill)}`.
- `autoRefine {enabled: true, turnInterval: 25 (clamped ≥1), compact: true, cooldownMs: 1_200_000 (clamped ≥0)}` (undocumented in settings.md).
- `agentTraces {enabled: false}`, `branchSummary {reserveTokens: 16384, skipPrompt: false}`.
- `retry {enabled: true, maxRetries: 3, baseDelayMs: 2000 (2s/4s/8s), provider {timeoutMs?, maxRetries?, maxRetryDelayMs: 60000}}`.
- `hideThinkingBlock: false`, `shellPath`, `quietStartup: false`, `shellCommandPrefix`, `npmCommand: string[]` (argv-style; first element `"bun"` special-cased).
- `mcpServers: Record<name, {type:"http", url, headers?, bearerTokenEnvVar?, oauth?, enabled?, enabledTools?, disabledTools?} | {type:"stdio", command, args?, env?, ...}>` (creds in auth.json under `mcp:<name>`).
- `packages` (string or `{source, extensions?, skills?, prompts?, themes?}`), `extensions`/`skills`/`prompts`/`themes` arrays (globs, `!`, `+`, `-` prefixes), `enableSkillCommands: true`, `bundledSkills {websearch: true}`, `enableBuiltinSkills: true`.
- `terminal {showImages: true, clearOnShrink: false, showTerminalProgress: false, fullscreen: true, fullscreenMouse: true}`, `images {autoResize: true (2000x2000), blockImages: false}`, `enabledModels: string[]`, `treeFilterMode` (default `"user-only"`; invalid coerced), `thinkingBudgets {minimal|low|medium|high}`, `editorPaddingX: 0` (clamp 0–3), `autocompleteMaxVisible: 5` (clamp 3–20), `showHardwareCursor: false`, `markdown {codeBlockIndent: "  "}`, `warnings {anthropicExtraUsage: true}`, `sessionDir`, `onboardingShown`/`onboardingCompleted`.
- Path resolution: entries in global settings resolve relative to `~/.prime/agent`; project entries relative to `.prime/agent`.

`SettingsManager` API: `create(cwd, agentDir?)`, `fromStorage`, `inMemory`, `getGlobalSettings`/`getProjectSettings` (deep clones), `reload`, `flush`, `applyOverrides` (in-memory), `drainErrors(scope?)`, per-key getter/setter pairs, aggregate getters (`getCompactionSettings`, `getAutoRefineSettings`, `getRetrySettings`, `getMcpServers`, `getSessionDir`, ...).

### 5.4 Prompt supplementation

- **Replace** system prompt: `SYSTEM.md` — project `<cwd>/.prime/agent/SYSTEM.md` checked first, else global `~/.prime/agent/SYSTEM.md`; **first match only, never concatenated** [resource-loader.ts:864-890].
- **Append**: `APPEND_SYSTEM.md`, same project-first first-match logic. CLI: `--system-prompt` (replace; context files/skills still appended), `--append-system-prompt` (repeatable).
- Context files: `AGENTS.md` or `CLAUDE.md` from `~/.prime/agent/AGENTS.md`, parent dirs walking up, and cwd (settings do NOT walk up; context files DO). Disable: `--no-context-files`/`-nc`.
- Prompt templates [docs/prompt-templates.md]: `~/.prime/agent/prompts/*.md`, `.prime/agent/prompts/*.md`, packages (`pi.prompts`), settings `prompts` array, `--prompt-template`. Invoke `/name`. Frontmatter: `description` (falls back to first non-empty body line), `argument-hint`. Args: `$1..`, `$@`/`$ARGUMENTS`, `${@:N}`, `${@:N:L}`. Discovery is **non-recursive**.

### 5.5 Environment variables

`PRIME_AGENT_CODING_AGENT_DIR`, `PRIME_AGENT_SESSION_DIR`, `PRIME_AGENT_CODING_AGENT_SESSION_DIR` (legacy), `PRIME_AGENT_KERNEL_PYTHON`, `PRIME_AGENT_KERNEL_VENV`, `PRIME_AGENT_INSTALL_UV`, `PRIME_AGENT_DOWNLOAD_BASE_URL`, `PRIME_AGENT_WEBSEARCH_TIMEOUT`, `PRIME_AGENT_WEBSEARCH_NUM_RESULTS`, `SERPER_API_KEY`, `RLM_DEPTH`, `RLM_MAX_DEPTH`, `PRIME_API_KEY`, `PRIME_AGENT_TRACES_API_KEY`/`_BASE_URL`; hardcoded `PI_*` compat: `PI_PACKAGE_DIR`, `PI_OFFLINE`, `PI_SKIP_VERSION_CHECK`, `PI_CACHE_RETENTION`, `PI_SHARE_VIEWER_URL`, `PI_CLEAR_ON_SHRINK`, `PI_FULLSCREEN`, `PI_HARDWARE_CURSOR`. Session dir precedence: `--session-dir` > `PRIME_AGENT_SESSION_DIR` > legacy var > settings `sessionDir` > `~/.prime/agent/sessions`.

Update manifest: stable `https://pub-728493de92a943e2a9b2d17b4719f318.r2.dev/latest.json` (beta: `beta.json`); shape `{version (required), package?/packageName?, tarball? (relative → resolved against PRIME_AGENT_DOWNLOAD_BASE_URL)}`.

---

## 6. Session Storage & Architecture

### 6.1 Process topology

Clients (TUI/print/JSON/RPC) → `AgentConnection` → **daemon supervisor** (routing, attachments, worker health, cross-agent delivery) → **session workers** (one per active root tree; each owns root `AgentSessionRuntime`, `AgentSession`, `Scheduler`, root kernel, all RLM child runtimes) + a **catalog subprocess** (saved-session scans; failure isolated) [docs/architecture.md; docs/daemon.md]. The supervisor never executes providers/tools/compaction/bash/kernels/schedules/transcript scans. Process boundaries are lifecycle containment, **not security sandboxes**. From the session queue onward, prompts from heartbeat/cron/goal/autonomous/another agent all take the same path.

- Resident workers: detached process groups; **closing the TUI detaches, does not stop the worker**. Workers monitor the supervisor socket and can self-elect a replacement supervisor via atomic launch lease. Crash recovery retries at 250 ms / 1 s / 5 s; three failures mark the root failed; recovery appends a visible transcript marker and never replays uncertain side effects. No fixed session/worker/client caps.
- Client-owned workers (print/JSON/piped/`--no-session` RPC): one-shot; removed on completion **without archiving**; omitted from default lists/global schedules — a monitoring layer polling `list` will not see them.
- Session leases: process-safe, keyed by canonical JSONL path; concurrent opens return **`session_already_active`** with the owning active-session ID.
- Daemon protocol: JSONL-framed public socket; versioned envelopes; `{generation, sequence}` cursors; snapshot streaming (512 KiB chunks; file-backed transcript caches above 4 MiB); idempotent mutations keyed `clientId + commandId` in an append-only journal — a command without a durable result is reported "uncertain" and **never auto-replayed**. JSON/RPC modes hide all daemon envelopes/lifecycle records. Contribution rule: any daemon wire change must be capability-gated or bump `DAEMON_PROTOCOL_VERSION`/`DAEMON_SCHEMA_REVISION` [AGENTS.md].

### 6.2 On-disk layout

- Sessions: flat `~/.prime/agent/sessions/<session-id>.jsonl` (legacy per-project `--cwd--/` dirs auto-migrated) [docs/session-format.md; src/migrations.ts:159].
- Artifacts: `~/.prime/agent/session-artifacts/<session-id>/` (sibling of `sessions/`, via `join(dirname(sessionDir), "session-artifacts", sessionId)` [session-manager.ts:347]). Known contents: `scheduled-jobs.json`, `rlm-subagents.jsonl`, `harness/harness_state.json`, `kernel-state.dill`, `kernel-state.json`, nested `sub-xxxxxxxx/<child-session-id>.jsonl` (+ deeper). Non-persistent sessions put RLM dirs under OS temp — not revivable. **Deleting a session file does not delete its artifacts dir** — treat the pair together.
- Daemon files: `~/.prime/agent/daemon-workers/<descriptorKey>/<workerId>.json` (+ `.recovery.jsonl`, `.orphans.jsonl`). Socket: Windows named pipe `\\.\pipe\prime-agent-daemon`; POSIX `<tmpdir>/prime-agent-<uid>/daemon.sock` (0700/0600) [src/modes/daemon/daemon-socket.ts:7-8,38,40].

### 6.3 Session JSONL format

Header (first line, not in tree): `{"type":"session","version":3,"id":"uuid","timestamp","cwd"}` (+`parentSession` for forks). Version 1 = legacy linear, 2 = tree, 3 = current (`hookMessage`→`custom`); v1/v2 auto-migrate on load. Entries: `{type, id (8-char hex), parentId (string|null), timestamp (ISO string)}` + type-specific fields.

Entry types: `session`, `message`, `model_change`, `thinking_level_change`, `service_tier_change`, `compaction` (`summary`, `firstKeptEntryId`, `tokensBefore`, `details?`, `fromHook?` (legacy name, keep), `customInstructions?`), `branch_summary`, `custom` (`customType`, `data` — NOT in LLM context), `custom_message` (IS in context), `child_usage_attributed` (`targetId`, `childUsage`, `aggregateUsage` — not in context; reload applies aggregate to target), `label`, `session_info`, `session_state` (accept `active`/`archived`/`crash`/`sleep`; `sleep` normalizes to `archived`), `agent_status`, `git_state`.

**DISCREPANCY (timestamps):** session-format.md declares entry `timestamp: string` (ISO, matches all JSON examples); compaction.md types `CompactionEntry.timestamp: number`. Trust ISO strings for entries. Separately, **message-level** timestamps (e.g. `AssistantMessage.timestamp`) are Unix ms numbers — entries and embedded messages differ.

Message roles: `user`, `assistant` (`stopReason: stop|length|toolUse|error|aborted`, `usage`), `toolResult`, `bashExecution` (`excludeFromContext` for `!!`), `custom`, `branchSummary`, `compactionSummary`. `Usage = {input, output, cacheRead, cacheWrite, totalTokens, cost{...}}`. Context building walks leaf→root; compaction on path emits summary + kept messages; bookkeeping entries (`custom`, `child_usage_attributed`, `session_state`, `agent_status`, `git_state`) never enter context.

### 6.4 SessionManager API

Statics: `create(cwd, sessionDir?)`, `open`, `continueRecent`, `inMemory`, `forkFrom`, `list`, `listAll`. Appends (return entry ID): `appendMessage`, `appendCompaction`, `appendCustomEntry(customType, data?)`, `appendChildUsageAttribution`, `appendSessionInfo`, `appendSessionState`, `appendAgentStatus`, `appendGitState`, `appendCustomMessageEntry`, `appendLabelChange`, `appendModelChange`, `appendThinkingLevelChange`, `appendServiceTierChange`. Tree: `getLeafId`, `getEntry`, `getBranch`, `getTree`, `getChildren`, `branch`, `resetLeaf`, `branchWithSummary`, `createBranchedSession`. Info: `buildSessionContext`, `getEntries`, `getHeader`, `getSessionName`, `getCwd`, `getSessionId`, `getSessionFile` (undefined in-memory), `isPersisted`.

### 6.5 Compaction

- Auto-trigger: `contextTokens > contextWindow - reserveTokens`; defaults `reserveTokens 16384`, `keepRecentTokens 20000`; `enabled:false` disables auto only (`/compact` still works).
- Cut points: user/assistant/bashExecution/custom messages — **never tool results**. Oversized single turns split mid-turn with dual summaries merged. Repeated compaction re-summarizes from the previous `firstKeptEntryId`. `tokensBefore` is recalculated just before writing — not the trigger-time estimate.
- Serialization (`serializeConversation`): `[User]:`/`[Assistant]:`/... prefixes; tool results truncated to 2000 chars. Structured summary sections: `## Goal`, `## Constraints & Preferences`, `## Progress` (Done/In Progress/Blocked), `## Key Decisions`, `## Next Steps`, `## Critical Context`, `<read-files>`, `<modified-files>`.
- Extension hooks: `session_before_compact` (may cancel or supply the compaction), `session_before_tree`.

---

## 7. Refinement Subsystem (Continual Harness)

### 7.1 Constants & types

[src/core/refinement/refinement.ts; barrel `core/refinement/index.js`]
- `REFINEMENT_CUSTOM_TYPE = "prime-agent.refinement"`; `REFINE_SKILL_NAME = "refine"`; caps `REFINEMENT_MAX_OUTPUT_TOKENS = 32_000`, `AUTO_REFINE_REVIEW_MAX_OUTPUT_TOKENS = 4_096` (both `min(model.maxTokens, cap)`).
- `RefinementKind = "prompt"|"memory"|"skill"|"subagent"`; `RefinementAction = "create"|"update"|"delete"`; `HarnessScope = "local"|"global"`.
- `HarnessState = {schema: 1, entries: Record<kind, Record<id, HarnessEntry>>, refinements: HarnessRefinementEvent[]}`. `HarnessEntry` (snake_case): `id, kind, title, content, path("general"), scope?, reference{}, arguments{}, metadata{}, source, created_at, updated_at, version`.
- `RefinementResult = {id, summary, rationale, expectedOutcome, appliedEdits: AppliedRefinementEdit[] (with before/after snapshots enabling rollback), harnessStatePath, rollbackOf?, scope?}`. `RefineOptions = {instructions?, rollbackId?, global?}`.

### 7.2 Storage

- Global: `~/.prime/agent/harness/harness_state.json` + `refinements.jsonl` (global-scope results only, one JSON per line). Local: `<session-artifacts>/<id>/harness/harness_state.json`; local refinements recorded **only** in the session JSONL as `custom` entries (`customType: "prime-agent.refinement"`) and roll back via their recorded `harnessStatePath`.
- Writes: `JSON.stringify(state, null, 2)+"\n"`, atomic tmp+rename, new files mode 0o600. Corrupt state file degrades silently to empty state; malformed history lines skipped.
- Python side mirrors this via `RLM_GLOBAL_HARNESS_STATE_DIR` / `RLM_HARNESS_STATE_DIR` / `$RLM_SESSION_DIR/harness/harness_state.json` fallback; mtime-based `_sync_from_disk()` prevents host/kernel clobbering [prime-agent-runtime/src/rlm/harness.py].

### 7.3 Library functions & flow

- `loadHarnessState(dir?, scope="global")` (note: **default scope "global"** while every refine entry point defaults to local — don't mix up); `mergeHarnessStates(global, local?)` — colliding local ids re-keyed `local:<id>` **for display only**; `_applyRefine` strips `local:`/`global:` prefixes — edits use bare ids.
- `planRefinement(messages, state, history, model, apiKey, options?, headers?, signal?, thinkingLevel?)` → `RefinementPlan`. Id format `refine_<17 digits>` (timestamp). Rollback path is LLM-free; LLM path sends last 80,000 chars of serialized conversation; `thinkingLevel` deliberately ignored (always non-reasoning).
- `applyRefinementProposal(state, proposal, {id, rollbackOf?, scope?, baselineState?})` — **pure in-memory; does not touch disk**; returns `harnessStatePath: ""`. Validation: `base_system_prompt` prompt id rejected (base prompt immutable); update/delete need `id`; create/update need `title`+`content`; skill entries need `arguments` + `reference {type:"python", import|python_import, callable|call_pattern}` — skill entries are **descriptions of installed Python skills, never code installs**. `baselineState` gives `"entry changed during refinement planning"` conflict rejection.
- `refineHarness(...)` = plan + apply convenience; **also does not save**. Any external harness must call `saveHarnessState` (and `appendGlobalRefinement` for global) itself, ideally copying the session's pattern: re-read state from disk immediately before apply.
- Rollback: replays `appliedEdits` in reverse using before/after snapshots; rollback ids are **refinement ids** (`refine_...`), not entry ids; local rollback requires the recorded state file to still exist.

### 7.4 Kernel-side harness API (`rlm.harness`)

[prime-agent-runtime/src/rlm/harness.py] Typed CRUD: `create_memory/update_memory/delete_memory`, same trios for `prompt_note` (default path `"policy"`), `skill`, `subagent`; generic `create/update/upsert/get/delete/list`, `record_refinement(trigger, changes, *, evidence="", outcome="", ...)`, `plan_refinement`, `overview(max_entries_per_kind=20)`, `snapshot`, `save`, `load`. **Global flag is `global_=True`** (literal `global=True` is a Python syntax error; `**{"global": True}` also accepted). `[local:id]`/`[global:id]` ids from `overview()` accepted verbatim.

### 7.5 Invocation surfaces

- `/refine [--global] [instructions]`, `/refine rollback <refinement-id> [--global]` [slash-commands.ts:35-59] — the `--global` flag and `rollback` subcommand are documented nowhere in docs, only in code.
- `AgentSession.refine(options?)` — programmatic blocking call; planning backgrounded, only apply blocks turn entry; concurrent refines serialized. Local scope on a non-persisted session **throws** ("use global refinement instead").
- Connection: `refine(options?) => Promise<RefinementResult>`; events `refine_complete{result}` / `refine_failed{error}` [modes/agent-connection/types.ts:711,607-608]. RPC command `refine` (extended `REFINE_REQUEST_TIMEOUT_MS`, value unread); daemon command `refine{activeSessionId,...}`.
- Kernel `refine.run` only **schedules** at the turn boundary, requires an active turn (else `{scheduled:false, reason:"no active turn..."}`), and **skips the auto-refine review gate**.
- Auto-refine: settings `autoRefine` (§5.3 defaults: enabled, every 25 assistant turns, on compact, 20-min cooldown); allowed only at `_rlmDepth === 0` with a local harness dir; gated by a `reviewAutoRefine` LLM pass (last 40,000 chars, 4096-token cap).
- **No pre-apply extension hook exists** — external evaluation requires driving `planRefinement` yourself and inspecting the plan before applying.
- After apply: state saved, session custom entry appended, system prompt rebuilt in place, `refine_complete` emitted. Listener failures after successful apply never flip the result to failure.

---

## 8. Windows & Operational Constraints

### 8.1 Windows specifics

- Prime Agent runs **natively on Windows but requires bash**. Shell resolution [src/utils/shell.ts `getShellConfig`]: custom `shellPath` from settings.json → `%ProgramFiles%\Git\bin\bash.exe` → `%ProgramFiles(x86)%\Git\bin\bash.exe` (docs mention only the first Git path — code checks both) → `where bash.exe` on PATH. Invoked with `["-c"]`. Nothing found → throws `No bash shell found...`; nonexistent custom path → `Custom shell path not found: <path>`.
- Process-tree kill on Windows: `taskkill /F /T /PID <pid>` (`killProcessTree`). Autonomous gate children are spawned non-detached with `windowsHide: true` on win32.
- Daemon socket is the named pipe `\\.\pipe\prime-agent-daemon`; `acquireDaemonSocketPathLease` returns `undefined` on win32 (no lockfile lease, unlike POSIX).
- **Kernel venv bootstrap is POSIX-shaped** (`<venv>/bin/python`, `sh -c` for uv install) — Windows-native managed-venv behavior is unverified in source/docs. On Windows, prefer `PRIME_AGENT_KERNEL_PYTHON` pointing at an existing Python with `ipykernel` (documented mechanism) and verify the managed bootstrap at runtime.
- **The documented installer (`curl ... install.sh | sh`) is Linux/macOS only.** No Windows installer is documented. Documented fallback: run from source — Node.js ≥ 22.8.0, `npm ci`, `./prime-agent.sh` (itself a bash script; needs Git Bash on Windows).
- TUI keybinding: image paste is Alt+V on Windows (Ctrl+V elsewhere).

### 8.2 Identity / binary naming

**DISCREPANCY (load-bearing):** docs invoke `prime-agent`, but this repo's `packages/coding-agent/package.json` `bin` maps **`pi` → `dist/bundle/cli.js`**. Release tarballs are rewritten by `scripts/pack-prime-agent-release.mjs` (renames package, executable, config metadata). A harness must not hardcode the binary name — detect the installed bin. npm packages remain `@earendil-works/pi-*`; these are NOT the public install path.

### 8.3 Operational rules for a harness driving this repo

[AGENTS.md]
- Validation: `npm run check` from root (no tests). **Never run** `npm run dev`, `npm run build`, `npm test`. Focused tests: `npx tsx ../../node_modules/vitest/dist/cli.js --run test/<file>.test.ts` from the package root.
- Never modify `packages/ai/src/models.generated.ts` directly (it may ride along in commits).
- Version semantics inverted: `patch` = features+fixes, `minor` = breaking, no majors.
- Parallel-agent git rules: no `git add -A`/`.`, no `reset --hard`/`checkout .`/`clean -fd`/`stash`/`--no-verify`, no force push; commit only files changed this session.
- Debugging: hidden `/debug` writes `~/.prime/agent/prime-agent-debug.log`; logs in `~/.prime/agent/logs/`; `prime-agent status` / `doctor [--fix]` / `shutdown [--force]`.
- Compaction/refine never run mid-cell; RPC bash output is deferred; scheduler claims-before-delivery; uncertain daemon mutations are surfaced, never auto-retried — a supervising harness must not blind-retry them.

---

## OPEN QUESTIONS (verify at runtime or treat defensively)

**Kernel / RLM**
1. `agent_message.send` `mode` kwarg: docs show `mode="auto"`; the Python signature read has no such parameter. Probe the live signature (`inspect.signature(agent_message.send)`) before passing it.
2. Heartbeat `interval` string grammar beyond `"5m"`: kernel wrapper only checks `isinstance(str)`; full accepted syntax is validated host-side (likely `parseAgentCronSchedule`-adjacent) — confirmed only for the documented forms.
3. Exact wire shapes of `goal.get` / `rlm_heartbeat.*` / `agent_observe.*` replies (host handler bodies not read end-to-end). Treat as `dict[str, Any]` and validate defensively.
4. `assertDirectAgentMessageTarget` constraints on child names beyond non-empty/≤64 chars — additional character restrictions may exist.
5. `mcp.*` host-request surface and `McpIntegration`/`McpToolError`/`NotEnabled` contract (`rlm/mcp_base.py`) unexamined.
6. `TokenUsage`: docs list it, runtime lacks it — removed or planned? Do not depend on it.
7. `model.info` host request is registered but undocumented; unclear whether the model is ever told about it.
8. `/rlm-max-depth --global` persistence mechanics (settings write path) not read.
9. `cellSourceCode` injection point on the Python/comm side untraced.
10. Daemon retention/passivation rules for completed daemon-backed children (in daemon-mode/daemon-supervisor, not read).

**Skills**
11. Kernel-side wrapper implementation (`rlm/skill.py`, placeholder binding, `rlm.skill:cli`) known only via `references/python-skills.md`, not source.
12. Full end-to-end skill precedence merge across `.agents` ancestors / `.prime/agent` / packages / settings / `--skill` (resource-loader.ts untraced); exact uv editable-install invocation surrounding `["--editable", path]`.
13. `allowed-tools` runtime effect: no plumbing found — assume no-op.
14. Which node_modules roots are scanned for `pi.skills` packages.

**Goals / autonomous / schedules**
15. `/goal` and `/autonomous` slash-command parser spellings (only doc examples confirmed; `objective_updated` implies goal editing exists somewhere).
16. `prime-agent schedule` exact flags (whether `--` before prompt is mandatory; pause/resume subcommands; target-agent addressing).
17. Numeric limits for agent-message size/rate/pending-queue (daemon-enforced, unnumbered).
18. Whether `/heartbeat --every "<cron>"` is intended/supported (appears to flow through parsing, unconfirmed by tests/docs).
19. How the autonomous continuation `UserMessage` is enqueued (steer vs queue position).
20. `Usage` field set was inferred from usage sites, not read from `@earendil-works/pi-ai`.

**CLI / headless**
21. Exhaustive `CreateAgentSessionOptions` field list and RPC wire types (`rpc-types.ts` optionality annotations) — docs by example only.
22. RPC schedule/heartbeat command payloads: `schedule` string syntax and returned job/heartbeat object shapes.
23. `send`/`attach` shell subcommand output formats and exit codes; exit codes for doctor/status/package subcommands.
24. ACP mode and daemon mode protocols (parsed but undocumented).
25. `get_state` initial `steeringMode` value (`"all"` in example vs documented default `"one-at-a-time"`).
26. Canonical `ImageContent` shape per surface (RPC wire vs SDK in-process) — check `packages/ai/src/types.ts`.
27. Full `SessionActionSnapshot` type (all `active.kind`/`phase` values).
28. JSON-mode stderr guarantees; whether `--mode json` without `-p` handles positional/stdin identically.
29. Whether RPC `set_thinking_level` accepts `"max"`.

**Settings / prompts**
30. Where the `defaultThinkingLevel` `"xhigh"` default is actually applied (not settings-manager).
31. Relative-path resolution for resource arrays in code (docs-only claim); whether SYSTEM.md/APPEND_SYSTEM.md support frontmatter or substitution.
32. Full `ServiceTier`/`Transport` enums from `@earendil-works/pi-ai`.
33. `compaction.agentCallable` consumption point; `mcpServers.enabled` default-when-omitted semantics.
34. Whether project settings.json is ever discovered by upward walk in any caller (none in `FileSettingsStorage`).

**Sessions / daemon**
35. Worker descriptor JSON schema, `descriptorKey` derivation, supervisor command-journal path/format.
36. Daemon protocol v4 exact field/command/event names (`daemon-protocol.ts` not fully read); values of `DAEMON_PROTOCOL_VERSION`/`DAEMON_SCHEMA_REVISION`.
37. Full `session-artifacts/<id>/` inventory (agent-traces references suggest more files).
38. Exact JSON shapes of `session_state`/`agent_status`/`git_state` entries (prose-only in docs).
39. Token estimator used for compaction cut points; snapshot chunk encoding; client-owned worker cleanup grace period duration; update checkpoint format.
40. `/export` HTML and `/share` gist layouts.

**Refinement**
41. `REFINE_REQUEST_TIMEOUT_MS` numeric value.
42. `cooldownMs` enforcement code path; `_serializedRefine` daemon state machine (sampled only).
43. Where the bundled `refine` skill's SKILL.md lives and its exact content.

**Windows / install**
44. Windows install/update story entirely: no installer, no documented self-update mechanics for win32; whether `prime-agent.sh` works under Git Bash; whether the managed kernel venv works at all on win32 (POSIX-shaped paths). A Windows harness should pin `PRIME_AGENT_KERNEL_PYTHON` and verify kernel startup explicitly.
45. install.sh internals / tarball artifact layout; enumeration of all `PI_*` compat env vars.
---

# v0.7.1 delta audit (2026-08-07, commits be9e2fa0..a18809e0)

Verified by direct diff. **Every load-bearing interface this harness depends on
is unchanged in 0.7.1**: `autonomous.ts` (gate mechanics, limits, pathspec
exclusions incl. `verification`), `goals.ts`, `cron-jobs.ts`, `skills.ts`,
`package-manager.ts` (discovery), `rlm-runtime.ts`, `refinement/`, `args.ts`,
`prompts/rlm.ts` — zero diffs. `agent-session.ts` changes are internal disposal
plumbing only (async dispose callbacks); no kernel env, host handler, or spawn
changes.

New in 0.7.1, relevant context:

- **`core/telemetry.ts` (new): pseudonymous PRODUCT ANALYTICS, not tracing.**
  Sends aggregate usage/performance events (version, OS category, mode, run
  outcomes, TTFT, token counts, retries, compactions) to
  `api.primeintellect.ai`; explicitly excludes prompts, paths, repo info,
  errors. **Enabled by default** (`telemetry.enabled: true`); disable via
  settings, `PRIME_AGENT_TELEMETRY=0`, `DO_NOT_TRACK=1`, or `--offline`.
  Project settings can only further restrict. Installation id in
  `~/.prime/agent/telemetry.json`. This does NOT replace the harness scorecard
  (Phase 2): it carries no per-task/per-child cost attribution.
- Settings: `telemetry` key added (boolean coerced to `{enabled}`);
  `SettingsManager.applyOverrides` now tracks runtime overrides.
- Self-update: `homebrew` install method detected; source-checkout installs
  refuse self-update with exit code 75 and print the tarball URL (observed on
  this machine — update via `git pull && npm ci && npm run build`).
- **RESOLVED live (Phase 1, 2026-08-08): settings merge is one-level, not
  recursively deep.** A runtime `SettingsManager.fromStorage` probe combined a
  global `retry.provider={timeoutMs,maxRetries,maxRetryDelayMs}` with a project
  `retry.provider={maxRetries}`. Top-level `retry` siblings survived, but the
  project `provider` replaced the global provider wholesale (`timeoutMs` was
  absent and `maxRetryDelayMs` fell back to 60000). The implementation comment
  saying "recursively" is imprecise; §5.2's one-level description is correct.
  Evidence: `artifacts/harness/phase1/settings-deep-merge-probe.log`.

## Windows kernel bootstrap — RESOLVED by local patch (2026-08-08)

OPEN QUESTION #44 confirmed as a real bug and fixed locally: `bootstrap.ts`
computed the venv interpreter as `<venv>/bin/python` at two sites (bootstrapVenv
and the ensureKernelPython reuse path). On Windows this path never exists
(`Scripts\python.exe` does), so kernelReady always failed, the venv was deleted
and re-created every session, and `uv pip install --python <venv>/bin/python`
exited 2 — blocking all kernel use on native Windows. Local patch in this
checkout adds a platform-aware `venvPythonPath()` helper used at both sites.
Verified live: print-mode session bootstraps and executes kernel Python.
NOTE: this patch lives only in Chris's working tree — re-verify after every
`git pull` (upstream may fix it differently and conflict), and upstream it.

## Windows daemon-worker kernel death — RESOLVED by second local patch (2026-08-08)

Beyond the venv-path bug: kernels spawned by **console-less daemon workers** on
Windows died seconds after a healthy start (state snapshot written, then
"Kernel has been shut down" on first use), while client-owned workers spawned
from a console worked. Cause: each child of a console-less process allocates a
fresh visible console whose lifecycle can kill it (upstream PR #825 describes
the same). Local patch: `windowsHide: true` on the ipykernel spawn
(kernel/index.ts), fork-server spawn, and bootstrap run(). Verified via a
DETACHED_PROCESS (console-less) probe executing kernel Python end-to-end.
When upstream PR #825 merges, drop both local patches in its favor.


# Phase 1 live runtime disposition (Prime Agent v0.7.1, 2026-08-08)

This table is the authoritative disposition of every item in the OPEN
QUESTIONS inventory above for the live Windows daemon session
`019fdeed-324e-742c-a9a3-0a102719b3fa`. **RESOLVED** means the v0.7.1 runtime
or current v0.7.1 checkout supplied direct evidence for the stated contract.
**STILL-OPEN** means the missing part needs a different surface, new-session
fixture, unsafe limit test, credentials, or operator approval; the reason is
explicit so no uncertainty is silently promoted to fact.

| # | Status | Live evidence or why it remains open |
|---:|---|---|
| 1 | **RESOLVED** | Live `inspect.signature(agent_message.send)` is `(message, broadcast_message=None, *, receiver_role=None, receiver_name=None)`; no `mode`. Bidirectional child probe passed. |
| 2 | **STILL-OPEN** | `rlm_heartbeat.create(..., interval="10m")` succeeded and normalized to `every 10m`/600000 ms, but the complete accepted interval grammar is not exposed and was not fuzzed. |
| 3 | **RESOLVED** | Live shapes captured for `goal.get`, all `rlm_heartbeat` CRUD replies, and all `agent_observe` list/get/recent replies. |
| 4 | **RESOLVED** | Host accepted and messaged child name `Phase 1 message probe` (spaces and uppercase); the only load-bearing restrictions remain non-blank, <=64, and sibling uniqueness. |
| 5 | **STILL-OPEN** | No MCP manager/Python surface is enabled in this session; testing requires an operator-configured MCP integration and credentials. |
| 6 | **RESOLVED** | Live `rlm` has no `TokenUsage`; `__all__` was captured. Do not depend on it. |
| 7 | **RESOLVED** | `await rlm.host_request("model.info", {})` returned `{id, provider, input}` for the active model. |
| 8 | **STILL-OPEN** | Would require mutating global settings through `/rlm-max-depth --global`; not appropriate in this governed test session. |
| 9 | **STILL-OPEN** | Requires comm/payload instrumentation inside the host/kernel transport; no supported read-only probe exists. |
| 10 | **STILL-OPEN** | Two completed children remained observable and deletable, but timeout/passivation behavior over long idle periods was not exercised. |
| 11 | **RESOLVED** | Live skill binding is callable `_PrimeAgentCallableSkillModule`; reload preserved callability and all four installed skill imports remain clean. |
| 12 | **STILL-OPEN** | Exact multi-root precedence and editable-install argv require isolated conflicting skill fixtures plus a new session; current-session reload cannot test discovery-time precedence. |
| 13 | **STILL-OPEN** | Requires a fresh isolated session with a deliberately restricted skill; current session cannot retroactively change skill discovery/tool policy. |
| 14 | **STILL-OPEN** | Requires isolated node_modules package fixtures and resource-loader reload/new session. |
| 15 | **STILL-OPEN** | Kernel APIs were tested, but slash-command parser spelling needs an interactive/RPC command-injection fixture not exposed to the kernel. |
| 16 | **RESOLVED** | Live `prime-agent schedule * --help`: commands are `list\|add\|cancel`; add syntax is `<agent> <schedule> -- <message>`; cron example confirmed; no pause/resume subcommands. |
| 17 | **STILL-OPEN** | Limit probing would intentionally trigger daemon rate/queue defenses and is unsafe/noisy in the operator session. |
| 18 | **STILL-OPEN** | This is the user-owned `/heartbeat` surface; agent policy forbids modifying it. RLM heartbeat interval behavior was tested separately. |
| 19 | **STILL-OPEN** | Requires a controlled autonomous continuation run and queue instrumentation; not exposed as a read-only kernel probe. |
| 20 | **RESOLVED** | Current JSONL assistant usage keys are `input, output, cacheRead, cacheWrite, totalTokens, cost`; cost keys are `input, output, cacheRead, cacheWrite, total`. Child attribution uses the same usage shape. |
| 21 | **STILL-OPEN** | Requires an SDK/RPC type audit or isolated programmatic session construction; it is not surfaced by current kernel host requests. |
| 22 | **STILL-OPEN** | CLI schedule JSON was captured, but exact RPC request/response payload optionality needs an RPC client fixture. |
| 23 | **STILL-OPEN** | Help and read-only runtime exit codes/shapes for status, doctor, package, and schedule are captured; real attach/send success and failure exits remain untested to avoid mutating other sessions/UI attachment. |
| 24 | **STILL-OPEN** | ACP/daemon protocols require dedicated external clients; no safe kernel-only probe. |
| 25 | **STILL-OPEN** | Requires creating a fresh RPC session with settings absent; current session state is already explicit. |
| 26 | **STILL-OPEN** | Requires paired RPC and in-process SDK image fixtures; attach-image use alone would not prove both wire forms. |
| 27 | **STILL-OPEN** | Requires exhaustive action-state transitions (model/tool/compaction/retry) through an RPC snapshot fixture. |
| 28 | **STILL-OPEN** | Requires separate JSON-mode process runs with stdin/positional prompts and controlled provider failures; not load-bearing for the harness kernel. |
| 29 | **STILL-OPEN** | Current root uses thinking level `max`, but RPC `set_thinking_level` acceptance was not exercised. |
| 30 | **STILL-OPEN** | Current global settings explicitly set `max`; testing the unset default requires a fresh isolated agent-dir/session. |
| 31 | **STILL-OPEN** | Requires isolated resource-array and prompt-render fixtures at discovery time; no current-session read-only API exposes resolved paths/substitution. |
| 32 | **STILL-OPEN** | The live model info reports input modalities only; full ServiceTier/Transport enum values remain a package-type question. |
| 33 | **STILL-OPEN** | Live compact skill visibility confirms the enabled agent-callable path, but `mcpServers.enabled` default needs an enabled MCP fixture. |
| 34 | **RESOLVED** | Runtime `SettingsManager.create` probe: an ancestor `.prime/agent/settings.json` was ignored from a nested cwd, while the exact cwd project file was loaded. There is no upward walk. |
| 35 | **STILL-OPEN** | Live descriptor key/type inventory was captured, including journal paths, but the descriptor-key derivation algorithm was not dynamically falsified. |
| 36 | **STILL-OPEN** | Live status confirms protocol 7 and schema `protocol-7-schema-14-816309b1cd50`; exhaustive command/event field names still require a protocol conformance fixture. |
| 37 | **STILL-OPEN** | Current session artifact inventory was captured (harness state, kernel state, subagent registry, schedules, child JSONLs), but optional artifacts arise only under other features. |
| 38 | **STILL-OPEN** | Exact observed keys for `session_state` and `git_state` were captured; no `agent_status` entry occurred, so the three-shape question is not fully closed. |
| 39 | **STILL-OPEN** | Requires compaction cut-point instrumentation and controlled worker cleanup/update interruption; unsafe in the active long-running goal. |
| 40 | **STILL-OPEN** | Requires invoking user slash-command export/share surfaces (and possibly network gist publishing), outside the kernel probe and publishing approval boundary. |
| 41 | **RESOLVED** | Current v0.7.1 source defines both RPC and daemon refine request timeouts as `10 * 60 * 1000` = 600000 ms. |
| 42 | **STILL-OPEN** | Current source enforcement paths were located, but auto-refine is deliberately disabled and live cooldown/serialized state-machine transitions were not activated. Explicit `refine.run` scheduling is tracked separately. |
| 43 | **RESOLVED** | Bundled skill is `packages/coding-agent/skills/refine/SKILL.md`; live checkout hash and line count were recorded. |
| 44 | **RESOLVED** | Managed Windows kernel is live; doctor passes and selfcheck passes. The local platform-aware interpreter/windowsHide patches remain required until upstreamed. |
| 45 | **STILL-OPEN** | Windows source-checkout operation is live, but tarball/install.sh internals and exhaustive `PI_*` compatibility variables require packaging fixtures; no installer mutation was attempted. |

## Phase 1 load-bearing delta results

- `harness_orchestrator.selfcheck()` performs 23 non-destructive live checks
  covering RLM exports/catalog/subagents/harness CRUD, goal budget shape,
  messaging signatures and family wire shape, compact/refine status,
  observation, RLM heartbeat, depth/session directories, governed refinement,
  and telemetry. It passed in this session and the opt-in live-kernel pytest
  passed.
- The full child contract round-trip passed: a retained child hashed a sentinel,
  wrote valid JSON, and replied through `agent_message`. A second child accepted
  a parent `agent_message`, matched a nonce, wrote the required JSON, and echoed
  the nonce to the parent. `rlm.list_subagents()` and `delete_subagent()` were
  validated before/after both retained children.
- A runtime mismatch was found and fixed upstream: orchestrator `reconcile()`
  read obsolete `RLMSubagent.name`; v0.7.1 exposes `session_name`. It now accepts
  `session_name` with a defensive legacy fallback and reports the actual error
  instead of claiming the host API is unavailable.
- Settings merge semantics are resolved above: one nested merge level; deeper
  objects replace. Exact-cwd project-settings discovery (no upward walk) was
  also verified.
- Telemetry stayed enabled: neither global nor project settings sets
  `telemetry.enabled=false`, and none of `PRIME_AGENT_TELEMETRY`, `DO_NOT_TRACK`,
  or `PI_OFFLINE` disables it. The new selfcheck fails loudly if that changes.
- The governed local refinement round-trip completed: snapshot -> scheduled
  `refine.run(global_=False)` -> unified diff created exactly one inert memory.
  Refinement id: `refine_20260808012452817`; entry id:
  `phase1-throwaway-refine-probe`. Operator-only rollback policy was honored;
  the entry is intentionally left intact and its id is reported, not rolled back
  by the agent.

Canonical runtime artifacts are under `artifacts/harness/phase1/`, notably
`settings-deep-merge-probe.log`, `settings-upward-walk-probe.log`,
`session-wire-shapes.json`, `session-artifact-inventory.json`,
`daemon-descriptor-shapes.json`, `prime-cli-help.json`,
`prime-cli-runtime.json`, and `misc-runtime-probes.json`. These files contain
shapes/hashes rather than credentials or prompt bodies.

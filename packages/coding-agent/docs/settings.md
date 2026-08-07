# Settings

Prime Agent accepts JSON or YAML settings files, with project settings overriding global settings.

| Location | Scope |
|----------|-------|
| `~/.prime/agent/settings.json`, `~/.prime/agent/settings.yml`, or `~/.prime/agent/settings.yaml` | Global (all projects) |
| `.prime/agent/settings.json`, `.prime/agent/settings.yml`, or `.prime/agent/settings.yaml` | Project (current directory) |

Use exactly one settings file per scope. Prime Agent preserves the selected format when it saves changes and creates `settings.json` when no file exists. Edit the file directly or use `/settings` for common options. Prime Agent watches both settings directories and reloads changed documents. Settings read for each operation, including `modelRoles`, take effect on the next operation. Settings used to construct runtime resources still require `/reload` or a new session.

## All Settings

### Model & Thinking

| Setting | Type | Default | Description |
|---------|------|---------|-------------|
| `defaultProvider` | string | - | Default provider (e.g., `"anthropic"`, `"openai"`) |
| `defaultModel` | string | - | Default model ID |
| `defaultThinkingLevel` | string | `"xhigh"` | `"off"`, `"minimal"`, `"low"`, `"medium"`, `"high"`, `"xhigh"`, `"max"` |
| `defaultServiceTier` | string | `"default"` | Default provider service tier: `"auto"`, `"default"`, `"flex"`, `"scale"`, or `"priority"` |
| `rlmAllowedServiceTiers` | array | `[defaultServiceTier]` | Service tiers allowed as explicit `rlm(..., service_tier=...)` overrides; use JSON `null` for Python `None` |
| `rlmActDefaultModel` | string | - | Named-role or concrete native model selector used when `rlm.act(...)` omits `model`; omission fails when unset |
| `hideThinkingBlock` | boolean | `false` | Hide thinking blocks in output |
| `thinkingBudgets` | object | - | Custom token budgets per thinking level |

An RLM child inherits the parent service tier when `service_tier` is omitted. Explicit overrides require an entry in `rlmAllowedServiceTiers`. For example, opt in to `priority` with:

```json
{
  "defaultServiceTier": "default",
  "rlmAllowedServiceTiers": ["default", "flex", "priority"]
}
```

When `rlmAllowedServiceTiers` is absent, its effective value contains only `defaultServiceTier`.

#### thinkingBudgets

```json
{
  "thinkingBudgets": {
    "minimal": 1024,
    "low": 4096,
    "medium": 10240,
    "high": 32768
  }
}
```

### Recursive child routes

`modelRoles` names reusable RLM model routes. A role accepts one selector or an ordered selector list. Prime Agent selects the first authenticated native candidate. An omitted `model` argument uses `task` when that role exists; otherwise it inherits the parent model. Exact `provider/model` selectors keep their existing behavior.

```yaml
modelRoles:
  task: openai-codex/gpt-5.6-luna:high
  copilot-grok: github-copilot/grok-4.5:high
  luna: openai-codex/gpt-5.6-luna:high
  deepseek: openrouter/deepseek/deepseek-v4-flash-0731:max
  claude: claude-code/claude-opus-4-7:high
claudeCode:
  executable: /absolute/path/to/claude
```

Append `:<effort>` to a model string to bind the role's exact provider effort, even when the model catalog marks that effort unsupported, as in `github-copilot/grok-4.5:high`. Call `await rlm("task", model="@luna")` or use the result's `concrete_selector` from `await rlm.find_models("luna")`. Project roles merge over global roles by name.

Act has no implicit model. Configure a default selector when callers should be able to omit `model`:

```yaml
rlmActDefaultModel: "@luna"
modelRoles:
  luna: openai-codex/gpt-5.6-luna:high
```

Without `rlmActDefaultModel`, every call must pass `model` explicitly. The setting accepts the same named-role and concrete native selectors as the `model` argument.

A native child retains its admitted role order for its resident lifetime. A retryable provider failure that occurs before the response produces text, thinking, or tool calls advances immediately to the next available and authenticated candidate. The new candidate uses its configured effort and a fresh same-model retry budget without changing global model or thinking defaults. Prime Agent checks candidate availability and authentication again at the switch. Exact selectors and `claude-code/<model>` children do not use role fallback.

`claude-code/<model>` selects an external Claude Agent SDK child rather than a `pi-ai` provider. The configured executable supplies Claude authentication. Prime Agent denies Claude's native `Agent`, `Task`, and `SendMessage` tools and provides an in-process family adapter for listing, correlated send, retained inbox, and wait operations. Claude queries and follow-up input remain live only while the parent worker lives; daemon passivation or replacement closes them, and cold revival does not reconstruct them.

### OpenRouter Transport

| Setting | Type | Default | Description |
|---------|------|---------|-------------|
| `openRouter.responses` | boolean | `false` | Prefer OpenRouter's stateless Responses API and fall back to Chat Completions only when the Responses transport is unavailable before streaming starts |

Prime Agent sends its opaque local session UUID as `session_id` on both OpenRouter transports. OpenRouter uses it for dashboard grouping and sticky upstream routing. When prompt caching is enabled, Responses also sends the same value as `prompt_cache_key`. Both transports send the complete conversation context on every request.

```yaml
openRouter:
  responses: true
```

Prime Agent reads this setting for every provider request, so an external JSON or YAML edit applies to the next request without `/reload`. Chat Completions remains the default. When Responses is enabled, cancellation, context overflow, authentication, rate limiting, invalid input, and failures after streaming starts do not cross transports.

### UI & Display

| Setting | Type | Default | Description |
|---------|------|---------|-------------|
| `theme` | string | `"dark"` | Theme name (`"dark"`, `"light"`, or custom) |
| `quietStartup` | boolean | `false` | Hide startup header |
| `collapseChangelog` | boolean | `false` | Show condensed changelog after updates |
| `treeFilterMode` | string | `"user-only"` | Default filter for `/tree`: `"default"`, `"no-tools"`, `"user-only"`, `"labeled-only"`, `"all"` |
| `editorPaddingX` | number | `0` | Horizontal padding for input editor (0-3) |
| `autocompleteMaxVisible` | number | `5` | Max visible items in autocomplete dropdown (3-20) |
| `showHardwareCursor` | boolean | `false` | Show terminal cursor |

### Update Checks

Stable builds fetch the release manifest at `https://pub-728493de92a943e2a9b2d17b4719f318.r2.dev/latest.json`. Beta builds fetch `beta.json` and continue following beta updates. Override the base URL with `PRIME_AGENT_DOWNLOAD_BASE_URL`.

Set `PI_SKIP_VERSION_CHECK=1` to disable the Prime Agent version update check. Use `--offline` or `PI_OFFLINE=1` to disable startup network operations, including update checks and package update checks.

The stable `latest.json` and beta `beta.json` manifests use the same JSON shape:

```json
{
  "version": "0.73.1",
  "package": "prime-agent",
  "tarball": "releases/v0.73.1/prime-agent-0.73.1.tgz"
}
```

`version` is required. `package` is optional and may also be named `packageName`; it defaults to the current package name. `tarball` is optional; when present, Prime Agent installs that tarball instead of the package name. Relative tarball paths resolve against `PRIME_AGENT_DOWNLOAD_BASE_URL`.

### Pseudonymous usage analytics

Prime Agent sends pseudonymous, aggregate usage and performance events to Prime Intellect. These events include version and operating-system category, onboarding outcome and duration, execution mode (`interactive`, `print`, `json`, `rpc`, or `acp`), run outcomes, TTFT and latency, prompt and turn counts, token usage, tool success counts, retries, and compactions.

Prime Agent does not send prompts, responses, thinking, tool arguments or results, command text, filenames, paths, repository information, environment variables, credentials, raw error messages, hostnames, usernames, emails, or hardware identifiers. A random installation ID is stored as `telemetry.json` in the configured agent directory (normally `~/.prime/agent/`).

Telemetry can be disabled globally or for an individual project. Project settings can only further restrict telemetry: they cannot re-enable a global opt-out or suppress the global one-time disclosure.

| Setting | Type | Default | Description |
|---------|------|---------|-------------|
| `telemetry.enabled` | boolean | `true` | Send pseudonymous aggregate usage and performance events |

Disable analytics with any of:

```json
{
  "telemetry": {
    "enabled": false
  }
}
```

```bash
PRIME_AGENT_TELEMETRY=0 prime-agent
DO_NOT_TRACK=1 prime-agent
prime-agent --offline
```

`PRIME_AGENT_TELEMETRY_ENDPOINT` overrides the ingestion endpoint for development and self-hosted deployments.

### Warnings

| Setting | Type | Default | Description |
|---------|------|---------|-------------|
| `warnings.anthropicExtraUsage` | boolean | `true` | Show a warning when Anthropic subscription auth may use paid extra usage |

```json
{
  "warnings": {
    "anthropicExtraUsage": false
  }
}
```

### Compaction

| Setting | Type | Default | Description |
|---------|------|---------|-------------|
| `compaction.enabled` | boolean | `true` | Enable auto-compaction |
| `compaction.reserveTokens` | number | `16384` | Tokens reserved for LLM response |
| `compaction.keepRecentTokens` | number | `20000` | Recent tokens to keep (not summarized) |
| `compaction.native` | boolean | `true` | Prefer provider-native compaction when the active API supports it |

Supported OpenAI Codex models use the native `/responses/compact` operation by default. Prime Agent stores the returned opaque history in the session and replays it only to the same provider. A provider switch re-expands the original append-only entries. Unsupported providers, an explicit `false`, and native failures before a valid result use the existing local summary path.

```json
{
  "compaction": {
    "enabled": true,
    "reserveTokens": 16384,
    "keepRecentTokens": 20000,
    "native": true
  }
}
```

### Branch Summary

| Setting | Type | Default | Description |
|---------|------|---------|-------------|
| `branchSummary.reserveTokens` | number | `16384` | Tokens reserved for branch summarization |
| `branchSummary.skipPrompt` | boolean | `false` | Skip "Summarize branch?" prompt on `/tree` navigation (defaults to no summary) |

### Retry

| Setting | Type | Default | Description |
|---------|------|---------|-------------|
| `retry.enabled` | boolean | `true` | Enable automatic agent-level retry on transient errors |
| `retry.maxRetries` | number | `3` | Maximum agent-level retry attempts |
| `retry.baseDelayMs` | number | `2000` | Base delay for agent-level exponential backoff (2s, 4s, 8s) |
| `retry.provider.timeoutMs` | number | SDK default | Provider/SDK request timeout in milliseconds |
| `retry.provider.maxRetries` | number | SDK default | Provider/SDK retry attempts |
| `retry.provider.maxRetryDelayMs` | number | `60000` | Max server-requested delay before failing (60s) |

When a provider requests a retry delay longer than `retry.provider.maxRetryDelayMs` (e.g., Google's "quota will reset after 5h"), the request fails immediately with an informative error instead of waiting silently. Set to `0` to disable the cap.

```json
{
  "retry": {
    "enabled": true,
    "maxRetries": 3,
    "baseDelayMs": 2000,
    "provider": {
      "timeoutMs": 3600000,
      "maxRetries": 0,
      "maxRetryDelayMs": 60000
    }
  }
}
```

### Message Delivery

| Setting | Type | Default | Description |
|---------|------|---------|-------------|
| `steeringMode` | string | `"one-at-a-time"` | How steering messages are sent: `"all"` or `"one-at-a-time"` |
| `followUpMode` | string | `"one-at-a-time"` | How follow-up messages are sent: `"all"` or `"one-at-a-time"` |
| `transport` | string | `"sse"` | Preferred transport for providers that support multiple transports: `"sse"`, `"websocket"`, or `"auto"` |

### Terminal & Images

| Setting | Type | Default | Description |
|---------|------|---------|-------------|
| `terminal.showImages` | boolean | `true` | Show image type and dimensions in terminal |
| `terminal.clearOnShrink` | boolean | `false` | Clear empty rows when content shrinks (can cause flicker) |
| `images.autoResize` | boolean | `true` | Resize images to 2000x2000 max |
| `images.blockImages` | boolean | `false` | Block all images from being sent to LLM |

### Shell

| Setting | Type | Default | Description |
|---------|------|---------|-------------|
| `shellPath` | string | - | Custom shell path (e.g., for Cygwin on Windows) |
| `shellCommandPrefix` | string | - | Prefix for every bash command (e.g., `"shopt -s expand_aliases"`) |
| `npmCommand` | string[] | - | Command argv used for npm package lookup/install operations (e.g., `["mise", "exec", "node@20", "--", "npm"]`) |

```json
{
  "npmCommand": ["mise", "exec", "node@20", "--", "npm"]
}
```

`npmCommand` is used for all npm package-manager operations, including installs, uninstalls, and dependency installs inside git packages. Use argv-style entries exactly as the process should be launched. When `npmCommand` is configured, git package dependency installs use plain `install` to avoid npm-specific flags in wrappers or alternate package managers.

Normally the package manager's global modules location is queried using `root -g`. As a special case, if the first element of `npmCommand` is `"bun"`, the modules location will instead be queried with `pm bin -g`.

### Daemon

| Setting | Type | Default | Description |
|---------|------|---------|-------------|
| `idleEvictionMinutes` | number or `"off"` | `90` | Idle threshold in minutes for whole-tree worker eviction and individual idle-child passivation; `"off"` disables both. |

`idleEvictionMinutes` is a global daemon policy and is read only from the global settings file. Set it to a positive number to configure the idle threshold.

### Sessions

| Setting | Type | Default | Description |
|---------|------|---------|-------------|
| `sessionDir` | string | - | Directory where session files are stored. Accepts absolute or relative paths, plus `~`. |

```json
{ "sessionDir": ".prime/agent/sessions" }
```

When multiple sources specify a session directory, precedence is `--session-dir`, `PRIME_AGENT_SESSION_DIR`, the legacy `PRIME_AGENT_CODING_AGENT_SESSION_DIR`, then `sessionDir` in the settings file.

### Model Cycling

| Setting | Type | Default | Description |
|---------|------|---------|-------------|
| `enabledModels` | string[] | - | Model patterns for Ctrl+P cycling (same format as `--models` CLI flag) |

```json
{
  "enabledModels": ["claude-*", "gpt-4o", "gemini-2*"]
}
```

### Markdown

| Setting | Type | Default | Description |
|---------|------|---------|-------------|
| `markdown.codeBlockIndent` | string | `"  "` | Indentation for code blocks |

### Resources

These settings define where to load extensions, skills, prompts, and themes from.

Paths in the global settings file resolve relative to `~/.prime/agent`. Paths in the project settings file resolve relative to `.prime/agent`. Absolute paths and `~` are supported.

| Setting | Type | Default | Description |
|---------|------|---------|-------------|
| `packages` | array | `[]` | npm/git packages to load resources from |
| `extensions` | string[] | `[]` | Local extension file paths or directories |
| `skills` | string[] | `[]` | Local skill file paths or directories |
| `prompts` | string[] | `[]` | Local prompt template paths or directories |
| `themes` | string[] | `[]` | Local theme file paths or directories |
| `enableSkillCommands` | boolean | `true` | Register skills as `/skill:name` commands |
| `enableBuiltinSkills` | boolean | `true` | Load built-in skills shipped with prime-agent |
| `bundledSkills.websearch` | boolean | `true` | Load the built-in `websearch` skill |

Arrays support glob patterns and exclusions. Use `!pattern` to exclude. Use `+path` to force-include an exact path and `-path` to force-exclude an exact path.

Disable the built-in `websearch` skill while keeping normal skill discovery enabled:

```json
{
  "bundledSkills": {
    "websearch": false
  }
}
```

#### packages

String form loads all resources from a package:

```json
{
  "packages": ["pi-skills", "@org/my-extension"]
}
```

Object form filters which resources to load:

```json
{
  "packages": [
    {
      "source": "pi-skills",
      "skills": ["brave-search", "transcribe"],
      "extensions": []
    }
  ]
}
```

See [packages.md](packages.md) for package management details.

## Example

```json
{
  "defaultProvider": "anthropic",
  "defaultModel": "claude-sonnet-4-20250514",
  "defaultThinkingLevel": "xhigh",
  "theme": "dark",
  "compaction": {
    "enabled": true,
    "reserveTokens": 16384,
    "keepRecentTokens": 20000
  },
  "retry": {
    "enabled": true,
    "maxRetries": 3
  },
  "enabledModels": ["claude-*", "gpt-4o"],
  "warnings": {
    "anthropicExtraUsage": true
  },
  "packages": ["pi-skills"]
}
```

## Project Overrides

Project settings override global settings. Nested objects are merged; this JSON example has the same meaning in YAML:

```json
// ~/.prime/agent/settings.json (global)
{
  "theme": "dark",
  "compaction": { "enabled": true, "reserveTokens": 16384 }
}

// .prime/agent/settings.json (project)
{
  "compaction": { "reserveTokens": 8192 }
}

// Result
{
  "theme": "dark",
  "compaction": { "enabled": true, "reserveTokens": 8192 }
}
```

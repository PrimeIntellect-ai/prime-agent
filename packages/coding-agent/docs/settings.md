# Settings

Preme Agent uses JSON settings files with project settings overriding global settings.

| Location | Scope |
|----------|-------|
| `~/.supreme/agent/settings.json` | Global (all projects) |
| `.supreme/agent/settings.json` | Project (current directory) |

Edit directly or use `/settings` for common options.

## All Settings

### Model & Thinking

| Setting | Type | Default | Description |
|---------|------|---------|-------------|
| `defaultProvider` | string | - | Default provider (e.g., `"anthropic"`, `"openai"`) |
| `defaultModel` | string | - | Default model ID |
| `subagentDefaultModel` | string | - | Model selector (`"provider/id"`) used when `rlm.spawn` does not pin a model; unset inherits the parent model |
| `defaultThinkingLevel` | string | `"xhigh"` | `"off"`, `"minimal"`, `"low"`, `"medium"`, `"high"`, `"xhigh"`, `"max"` |
| `thinkingBudgets` | object | - | Custom token budgets per thinking level |

`subagentDefaultModel` applies only to spawned subagents whose `rlm.spawn` call omits `model=`. An explicit `model=` per spawn always wins, and an unset setting keeps the inherit-parent behavior. If the configured default is unavailable, unauthenticated, or expired, the spawn fails with that error instead of silently falling back.

### Autonomous Runs

| Setting | Type | Default | Description |
|---------|------|---------|-------------|
| `autonomous.maxContinuations` | number or `"unlimited"` | `3` | Continuation budget for autonomous runs |
| `autonomous.maxTurns` | number or `"unlimited"` | `12` | Turn budget for autonomous runs |
| `autonomous.maxTokens` | number or `"unlimited"` | `80000` | Token budget for autonomous runs |
| `autonomous.timeoutMs` | number or `"unlimited"` | `1800000` | Wall-clock budget in milliseconds |

```json
{
  "autonomous": {
    "maxContinuations": "unlimited",
    "maxTokens": 1000000
  }
}
```

These are the persisted defaults for the same limits as the `--autonomous-*` CLI flags and `/autonomous on` budget flags. Set them once so every autonomous run starts with your budget instead of the built-in defaults; explicit flags on a given run still win. Invalid values are ignored per-field, falling back to the built-in defaults.

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

### UI & Display

Conversation output starts in overview. Ctrl+O cycles through details and all output; the old `hideThinkingBlock` setting no longer controls visibility.

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

Set `PI_SKIP_VERSION_CHECK=1` to disable the Preme Agent version update check. Use `--offline` or `PI_OFFLINE=1` to disable startup network operations, including update checks and package update checks.

The stable `latest.json` and beta `beta.json` manifests use the same JSON shape:

```json
{
  "version": "0.73.1",
  "package": "prime-agent",
  "tarball": "releases/v0.73.1/prime-agent-0.73.1.tgz"
}
```

`version` is required. `package` is optional and may also be named `packageName`; it defaults to the current package name. `tarball` is optional; when present, Preme Agent installs that tarball instead of the package name. Relative tarball paths resolve against `PRIME_AGENT_DOWNLOAD_BASE_URL`.

### Pseudonymous usage analytics

Preme Agent sends pseudonymous, aggregate usage and performance events to Prime Intellect. These events include version and operating-system category, onboarding outcome and duration, execution mode (`interactive`, `print`, `json`, `rpc`, or `acp`), run outcomes, TTFT and latency, prompt and turn counts, token usage, tool success counts, retries, and compactions.

Preme Agent does not send prompts, responses, thinking, tool arguments or results, command text, filenames, paths, repository information, environment variables, credentials, raw error messages, hostnames, usernames, emails, or hardware identifiers. A random installation ID is stored as `telemetry.json` in the configured agent directory (normally `~/.supreme/agent/`).

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
DO_NOT_TRACK=1 preme-agent
preme-agent --offline
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

```json
{
  "compaction": {
    "enabled": true,
    "reserveTokens": 16384,
    "keepRecentTokens": 20000
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
| `retry.provider.maxRetryDelayMs` | number | `60000` | Max server-requested retry delay before failing (60s) |

When a provider requests a retry delay longer than `retry.provider.maxRetryDelayMs` (e.g. a usage-limit reset hours away), auto-retry stops immediately with an informative error instead of waiting. Set to `0` to disable the cap.

### Wait-for-usage and provider recovery

| Setting | Type | Default | Description |
|---------|------|---------|-------------|
| `retry.provider.waitForUsage.enabled` | boolean | `true` | Bounded wait-for-recovery loop for quota exhaustion and provider unavailability |
| `retry.provider.waitForUsage.baseDelayMs` | number | `1000` | First ping delay (doubles per ping) |
| `retry.provider.waitForUsage.maxDelayMs` | number | `300000` | Per-ping ceiling (5m) |
| `retry.provider.waitForUsage.maxAttempts` | number | `30` | Abort bound: maximum recovery pings |
| `retry.provider.waitForUsage.maxWaitMs` | number | `900000` | Abort bound: maximum total wait (15m) |
| `providerBackupModel` | string | none | Backup model ("provider/model-id" or bare id) used while the primary is quota-blocked or unavailable |

The wait loop runs under the `retry.enabled` master switch: with retries
disabled, no waits run either.

When a request fails with quota/subscription exhaustion (429s, usage limits), the
session waits for usage to come back: it pings the provider with exponential
backoff and jitter (1s doubling to a 5m ceiling) and resumes automatically when
the provider recovers. If the provider reports a reset time (Retry-After header
or "Try again in ~90 min" style text), the resume is scheduled exactly then
instead of pinging. Quick retries still run first for transient errors (5xx,
overload, network, and 404 routing blips); the wait loop takes over when they
are exhausted. Every wait shows attempts and the next check countdown in the
status line, and both abort bounds (`maxAttempts`, `maxWaitMs`) are hard stops:
waits never hang. When a reported reset time exceeds `maxWaitMs`, the wait gives
up immediately with an informative error instead of pinging pointlessly — raise
`maxWaitMs` to wait out long subscription windows.

`providerBackupModel` routes failed turns to a user-defined backup model
instead of waiting while the primary is quota-blocked or unavailable. It is
disabled by default: with no setting, behavior is unchanged and requests never
silently switch models. When set, the retry status line shows an explicit
"retrying on backup model X" indicator, the switch is recorded in the session
log, and the session returns to the primary model automatically (the next turn
probes the primary again). If the backup reference cannot be resolved to an
available, authenticated model, the bounded wait runs instead.

```json
{
  "retry": {
    "enabled": true,
    "maxRetries": 3,
    "baseDelayMs": 2000,
    "provider": {
      "timeoutMs": 3600000,
      "maxRetryDelayMs": 60000,
      "waitForUsage": {
        "enabled": true,
        "baseDelayMs": 1000,
        "maxDelayMs": 300000,
        "maxAttempts": 30,
        "maxWaitMs": 900000
      }
    }
  },
  "providerBackupModel": "anthropic/claude-opus-4-7"
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

`idleEvictionMinutes` is a global daemon policy and is read only from `~/.supreme/agent/settings.json`. Set it to a positive number to configure the idle threshold.

### Sessions

| Setting | Type | Default | Description |
|---------|------|---------|-------------|
| `sessionDir` | string | - | Directory where session files are stored. Accepts absolute or relative paths, plus `~`. |

```json
{ "sessionDir": ".supreme/agent/sessions" }
```

When multiple sources specify a session directory, precedence is `--session-dir`, `PRIME_AGENT_SESSION_DIR`, the legacy `PRIME_AGENT_CODING_AGENT_SESSION_DIR`, then `sessionDir` in `settings.json`.

### Model Cycling

| Setting | Type | Default | Description |
|---------|------|---------|-------------|
| `enabledModels` | string[] | - | Model patterns for Alt+M cycling (same format as `--models` CLI flag) |

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

Paths in `~/.supreme/agent/settings.json` resolve relative to `~/.supreme/agent`. Paths in `.supreme/agent/settings.json` resolve relative to `.supreme/agent`. Absolute paths and `~` are supported.

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

Project settings (`.supreme/agent/settings.json`) override global settings. Nested objects are merged:

```json
// ~/.supreme/agent/settings.json (global)
{
  "theme": "dark",
  "compaction": { "enabled": true, "reserveTokens": 16384 }
}

// .supreme/agent/settings.json (project)
{
  "compaction": { "reserveTokens": 8192 }
}

// Result
{
  "theme": "dark",
  "compaction": { "enabled": true, "reserveTokens": 8192 }
}
```
# Astra support

`gpt-6-astra` supports Fast mode and server compaction through both `openai` (API key) and `openai-codex` (ChatGPT login). The existing `/compact` command and automatic compaction use the same session lifecycle, extension hooks, and kernel preservation behavior.

For ChatGPT login, Prime sends Codex's explicit `compaction_trigger` control through the streaming Responses endpoint. A successful response must finish and contain exactly one encrypted compaction item. Prime retains up to 64,000 estimated tokens of recent user context alongside that checkpoint. The separate `/responses/compact` endpoint is used for API-key authentication; Prime preserves its complete returned window without rewriting the items.

Checkpoints are stored in `CompactionEntry.details.providerCheckpoint`. They include the provider, model, API, endpoint, complete replay window, and a token estimate. Reopening the session restores that window. The readable compaction message is display text; it is never substituted for the encrypted context. The original session transcript remains on disk.

Switching models or endpoints reconstructs context from the original transcript and compatible local summaries. Unknown checkpoint versions are also ignored during reconstruction. Local fallback summaries are generated in bounded requests when restored history exceeds the destination model's input budget. Unsupported compact endpoints and explicit input-limit rejections use this fallback. Authentication failures, malformed output, cancellation, and exhausted transient retries preserve the current history. Checkpoint writes roll back on persistence failure.

Automatic compaction respects input limits separately from total context. Astra's API-key input ceiling is 922,000 tokens within its 1,050,000-token total context; the default 16,384-token reserve puts the compaction threshold at 905,616. ChatGPT's existing 272,000-token window stays unchanged and compacts at 90% (244,800 tokens), or earlier if a larger reserve is configured. Custom models and overrides may set a positive integer `maxInputTokens` to lower their input budget.

Fast mode forwards `service_tier: "priority"` for Astra on both OpenAI providers. Existing reasoning levels, ordinary encrypted reasoning replay, commentary/final phases, tool calls, and persistent Python kernel behavior remain in use. This change does not add Ultra, enlarge the ChatGPT context default, or enable automatic inline `context_management` compaction.

Daemon schema revision 28 adds optional `providerContext` message metadata and `maxInputTokens` model metadata. These are backward-compatible response fields: existing clients can render the summary and existing workers can continue using local compaction. No new capability or startup version requirement is imposed. Resume encrypted checkpoints with a Prime version that supports them; older workers do not understand their session-file metadata.

The same worker/session implementation serves the terminal, daemon clients, RPC, and SDK. No separate native 3D surface exists in this repository.

References: [OpenAI compaction](https://developers.openai.com/api/docs/guides/compaction), [Astra model limits](https://developers.openai.com/api/docs/models/gpt-6-astra), and [Codex remote compaction v2](https://github.com/openai/codex/blob/ef6c0582028ff8e1228e6031465c1c2d9d5d51b6/codex-rs/core/src/compact_remote_v2.rs).

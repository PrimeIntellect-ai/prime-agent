

## Integration phase (post-foundation)

All seven crates are merged. Remaining to full parity:

1. pa-core session engine (largest remaining): AgentSession port — prompt queueing,
   tool dispatch wiring (tools+kernel already ported), compaction, skills loading,
   system-prompt assembly (core/prompts incl. rlm.ts), refinement, settings/config,
   model resolver + registry wiring, subagent management, MCP, cron jobs, autonomous
   mode, session manager/resume, export-html, agent-traces.
2. pa-cli runtime wiring: connect AppMode::Run paths to pa-daemon supervisor + pa-core
   engine + pa-tui client (replace MissingSubsystem typed errors with real runtime).
3. End-to-end verification: assembled `prime-agent` binary run headless and in tmux
   against the TS product - same commands, same UX; differential corpus.

Porting approach: sequential in-session (daemon child sessions proved unreliable);
small committed units; TS read-before-port; codex cross-checks for loop/cache internals.

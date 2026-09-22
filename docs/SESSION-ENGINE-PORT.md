
# Session-engine port inventory (TS coding-agent/src/core -> pa-core)

Ported already (PRs #5 #10): tools/*, kernel/* (+rlm_runtime pieces).

Remaining, in port order (dependency-driven, smallest foundation first):

| # | TS source | LoC | notes |
|---|---|---|---|
| 1 | settings-manager.ts + config.ts | ~2000 | settings/config storage |
| 2 | auth-storage.ts + prime-inference-auth.ts | ~1700 | credentials |
| 3 | model-registry.ts + model-resolver.ts | ~2500 | registry (pa-ai has catalog already) |
| 4 | prompts/rlm.ts + prompts/index.ts | 248 | system prompt assembly (model-facing parity) |
| 5 | skills.ts + resource-loader.ts | 1560 | skill loading/inventory |
| 6 | messages.ts + agent-messages.ts | 1286 | message shaping (mostly in pa-types) |
| 7 | session-manager.ts | 2474 | persistence/resume/queue snapshot |
| 8 | agent-session.ts + agent-session-runtime.ts + services | 14800 | the engine (split into modules: queueing, tool dispatch, compaction hook, checkpoint) |
| 9 | compaction/* | ~1600 | compaction |
| 10 | refinement/* | 1215 | harness refinement |
| 11 | autonomous.ts + goals.ts + cron-jobs.ts | ~2770 | autonomous/cron |
| 12 | mcp/* + extensions/* | ~3000 | MCP + extensions |
| 13 | slash-commands.ts + keybindings.ts + context-tree.ts + footer-data-provider.ts + semantic-edges.ts + agent-traces.ts + session-action-store.ts + telemetry.ts + sdk.ts + provider-retry.ts | ~4200 | UI-facing + infra |

Total remaining ~32K TS LoC. Porting sequentially in-session per AGENTS.md rules.

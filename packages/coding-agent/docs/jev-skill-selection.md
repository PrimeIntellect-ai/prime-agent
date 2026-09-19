# Jev Skill Selection

Preme Agent can optionally use a local Jev-compatible service to select the most relevant skill before each agent run.

This integration is advisory by default. It does not select a model, execute tools, or replace the agent decision. If LocalJev is unavailable or returns low confidence, Preme Agent keeps its normal skill list.

## LocalJev setup

Start LocalJev on its default address, `http://127.0.0.1:8080`, and verify `GET /ready` succeeds.

## Enable the extension

Copy [the example extension](../examples/extensions/jev-skill-selection.ts) to `~/.preme-agent/extensions/jev-skill-selection.ts`, then set:

```powershell
$env:PREME_AGENT_JEV_SKILL_SELECTION = "1"
```

```sh
export PREME_AGENT_JEV_SKILL_SELECTION=1
```

Optional settings:

- `LOCALJEV_URL`: LocalJev base URL. Default: `http://127.0.0.1:8080`.
- `LOCALJEV_API_KEY`: bearer key when LocalJev authentication is enabled.
- `PREME_AGENT_JEV_TIMEOUT_MS`: request timeout. Default: `1500`.
- `PREME_AGENT_JEV_MIN_CONFIDENCE`: minimum confidence. Default: `0.55`.
- `PREME_AGENT_JEV_SKILL_MODE`: `advisory` (default) or `filter`.

`filter` mode keeps the selected skill and operational skills such as `goal`, `compact`, and `refine` in the model-facing list. Use it only for experiments because an incorrect classification can hide a useful skill. The extension never disables a skill command or removes the skill from disk.

## Limitations

LocalJev returns typed decisions, but it can still make semantic mistakes. Keep authorization and destructive-operation controls in deterministic policy code or human approval. Do not send the complete transcript as Jev state; provide only the current prompt and the bounded choice list.

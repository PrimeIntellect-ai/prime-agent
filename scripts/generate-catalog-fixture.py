#!/usr/bin/env python3
"""Regenerate the catalog parity fixture (tests/fixtures/catalog.v1.json).

The fixture is the compiled model catalog (crates/pa-ai/src/models.generated.json,
the TS models.generated.ts snapshot) exported through the catalog aggregate
semantics of `createModelCatalog` (packages/ai/src/model-catalog.ts):
headers stripped, prime-inference excluded (fetched live), entries sorted by
(provider, id), envelope {"schemaVersion": 1, "models": [...]}.

The catalog repo itself (PrimeIntellect-ai/prime-agent-catalog) is not
publicly fetchable from this sandbox (HTTP 404), so the parity verifier
runs against this byte-faithful aggregate of the real compiled data
(1,171 models across 31 providers, ~546 KiB — spec scale: 1,175/31/548,754).
When the repo becomes fetchable, bundle the real payload with the build
lane's generator instead; this fixture keeps CI deterministic either way.

Usage: python3 scripts/generate-catalog-fixture.py
"""

import json
from pathlib import Path

REPO = Path(__file__).resolve().parent.parent
COMPILED = REPO / "crates/pa-ai/src/models.generated.json"
FIXTURE = REPO / "crates/pa-models/tests/fixtures/catalog.v1.json"


def main() -> None:
    compiled = json.loads(COMPILED.read_text())
    models = []
    for provider in sorted(compiled):
        if provider == "prime-inference":
            continue
        for model in compiled[provider].values():
            model = json.loads(json.dumps(model))
            model.pop("headers", None)
            models.append(model)
    models.sort(key=lambda m: (m["provider"], m["id"]))
    FIXTURE.write_text(
        json.dumps({"schemaVersion": 1, "models": models}, indent="\t", separators=(",", ": "))
        + "\n"
    )
    providers = {m["provider"] for m in models}
    print(f"{FIXTURE}: {len(models)} models, {len(providers)} providers")


if __name__ == "__main__":
    main()

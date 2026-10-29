#!/usr/bin/env python3
"""Report Prime Inference models whose public /models entry lacks specs.

prime-agent drops every Prime Inference model whose `specs` object is null
(crates/pa-models/src/prime_inference.rs), so such a model never appears in
the model selector. This check lists those models, and models whose specs
miss or null a field the client reads, so the list can go to the inference team.

Prints a markdown table (also appended to $GITHUB_STEP_SUMMARY when set) and
one `::error::` annotation per flagged model, and exits 1 if any model is
flagged. Run by .github/workflows/prime-inference-specs.yml; the name avoids
the check_*.py prefix, which ci.yml runs as lifecycle checks on every PR.

Usage:
    python3 scripts/prime_inference_specs.py
"""

import json
import os
import sys
import urllib.request

MODELS_URL = "https://api.pinference.ai/api/v1/models"
SPEC_FIELDS = ("context_window", "max_output_tokens", "supports_reasoning", "modalities")


def main() -> int:
    # The endpoint's edge rejects urllib's default User-Agent with 403.
    request = urllib.request.Request(MODELS_URL, headers={"User-Agent": "prime-agent-ci"})
    with urllib.request.urlopen(request) as response:
        models = json.load(response)["data"]
    flagged = {}
    for model in models:
        specs = model.get("specs")
        spec_nulls = [] if specs is None else [f"specs.{field}" for field in SPEC_FIELDS if specs.get(field) is None]
        if specs is None or spec_nulls:
            flagged[model["id"]] = [key for key, value in model.items() if value is None] + spec_nulls
    if flagged:
        rows = [f"| `{model_id}` | {', '.join(fields)} |" for model_id, fields in flagged.items()]
        report = "\n".join([
            f"{len(flagged)} of {len(models)} Prime Inference models lack specs:",
            "",
            "| model id | null fields |",
            "| --- | --- |",
            *rows,
        ])
    else:
        report = f"all {len(models)} Prime Inference models have specs"
    print(report)
    step_summary = os.environ.get("GITHUB_STEP_SUMMARY")
    if step_summary:
        with open(step_summary, "a", encoding="utf-8") as f:
            f.write(report + "\n")
    for model_id in flagged:
        print(f"::error::Prime Inference model {model_id} lacks specs in {MODELS_URL}")
    return 1 if flagged else 0


if __name__ == "__main__":
    sys.exit(main())

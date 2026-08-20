#!/usr/bin/env python3
"""Deterministic oracle adapter for corpus self-test only; comparison mode rejects it."""
import json
import sys

ANSWERS = json.loads(r'''
{
  "conv-first-order": {
    "observed_order": 1.0
  },
  "conv-fourth-order": {
    "observed_order": 4.0
  },
  "conv-second-order": {
    "observed_order": 2.0
  },
  "inv-energy-conserved": {
    "conserved": true,
    "relative_drift": 5.000444502911705e-13
  },
  "inv-mass-drift": {
    "conserved": false,
    "relative_drift": 0.030000000000000072
  },
  "inv-zero-momentum": {
    "conserved": true,
    "relative_drift": 2e-14
  },
  "num-expm1-cancellation": {
    "values": {
      "18": "0.0000000000000000000100000000000",
      "36": "0.0000000000000000000100000000000000000000500000000",
      "72": "0.0000000000000000000100000000000000000000500000000000000000001666666666666666666670833"
    }
  },
  "num-gravity-scale": {
    "values": {
      "18": "76132671239677419354838709677.419",
      "36": "76132671239677419354838709677.419354838709677419355",
      "72": "76132671239677419354838709677.419354838709677419354838709677419354838709677419354838710"
    }
  },
  "num-log1p-cancellation": {
    "values": {
      "18": "0.000000000000000000000000099999999999999999999999995000000",
      "36": "0.000000000000000000000000099999999999999999999999995000000000000000000000000",
      "72": "0.000000000000000000000000099999999999999999999999995000000000000000000000000333333333333333333333333308333333333"
    }
  },
  "num-sqrt-two": {
    "values": {
      "18": "1.4142135623730950488016887242097",
      "36": "1.4142135623730950488016887242096980785696718753769",
      "72": "1.4142135623730950488016887242096980785696718753769480731766797379907324784621070388504"
    }
  },
  "sym-binomial-square": {
    "assumptions": [],
    "verdict": "universally_equivalent"
  },
  "sym-cancel-domain": {
    "assumptions": [
      "x != 0"
    ],
    "verdict": "equivalent_under_assumptions"
  },
  "sym-log-exp-real": {
    "assumptions": [],
    "verdict": "universally_equivalent"
  },
  "sym-missing-cross-term": {
    "assumptions": [],
    "counterexample": {
      "a": 1,
      "b": 1
    },
    "verdict": "not_equivalent"
  },
  "sym-sqrt-product": {
    "assumptions": [
      "a >= 0",
      "b >= 0"
    ],
    "verdict": "equivalent_under_assumptions"
  },
  "sym-sqrt-square-sign": {
    "assumptions": [
      "x >= 0"
    ],
    "verdict": "equivalent_under_assumptions"
  }
}
''')
payload = json.load(sys.stdin)
state = payload.get("harness_state", {}).get("local", {})
if state.get("behavior") != "reference-oracle-v1":
    json.dump({"adapter_error": "unsupported harness behavior"}, sys.stdout, sort_keys=True)
else:
    json.dump(ANSWERS.get(payload.get("challenge", {}).get("id"), {}), sys.stdout, sort_keys=True)

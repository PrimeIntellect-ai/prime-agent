#!/usr/bin/env python3
"""Compare actual TS/Rust lifecycle/catalog values and require Rust exit-sidecar currency.

The Rust-only v2 info sidecar must certify the final ended child transcript.
The imported verifier retains actual TS catalog and cache-boundary observations;
TS has no Rust sidecar-format requirement.
"""
import sys
from review_ledger_liveness_parity import main

if __name__ == '__main__':
    sys.exit(main(require_current_sidecar=True))

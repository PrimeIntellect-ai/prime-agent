#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")/.."
bun packages/coding-agent/src/core/kernel/bootstrap-cli.ts

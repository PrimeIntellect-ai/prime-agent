#!/usr/bin/env bash
# Prepare the local Prime Images build context for the prime-agent cloud
# runtime image: fetch the pinned release artifacts into this directory and
# verify them against checksums.sha256. The artifacts are intentionally not
# committed (see .gitignore); this script makes the context reproducible.
#
# Inputs:
# - prime-agent-0.9.5.tgz, from the published v0.9.5 release
#   (GitHub release asset; public R2 mirror used by default)
# - frp_0.66.0_linux_amd64.tar.gz, from the frp v0.66.0 release
#
# Idempotent: an artifact that already verifies is left in place.
set -euo pipefail

cd "$(dirname "$0")"

readonly PRIME_AGENT_VERSION="0.9.5"
readonly PRIME_AGENT_TGZ="prime-agent-${PRIME_AGENT_VERSION}.tgz"
readonly PRIME_AGENT_R2_URL="https://pub-728493de92a943e2a9b2d17b4719f318.r2.dev/releases/v${PRIME_AGENT_VERSION}/${PRIME_AGENT_TGZ}"
readonly PRIME_AGENT_GH_URL="https://github.com/PrimeIntellect-ai/prime-agent/releases/download/v${PRIME_AGENT_VERSION}/${PRIME_AGENT_TGZ}"
readonly FRP_TGZ="frp_0.66.0_linux_amd64.tar.gz"
readonly FRP_URL="https://github.com/fatedier/frp/releases/download/v0.66.0/${FRP_TGZ}"

fetch() {
	local url="$1" out="$2"
	if [ -f "$out" ] && sha256sum --check --ignore-missing checksums.sha256 >/dev/null 2>&1; then
		echo "verified (cached): $out"
		return
	fi
	echo "downloading $out"
	curl -fsSL --retry 5 --retry-connrefused --output "$out" "$url"
}

fetch "$PRIME_AGENT_R2_URL" "$PRIME_AGENT_TGZ" || fetch "$PRIME_AGENT_GH_URL" "$PRIME_AGENT_TGZ"
fetch "$FRP_URL" "$FRP_TGZ"

# Fail unless every pinned artifact verifies.
sha256sum -c checksums.sha256
echo "build context ready: ${PRIME_AGENT_TGZ}, ${FRP_TGZ} (checksums verified)"

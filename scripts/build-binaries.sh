#!/usr/bin/env bash
#
# Build pi binaries for supported platforms locally.
# Mirrors the Bun-compiled release lane in .github/workflows/build-binaries.yml.
#
# Usage:
#   ./scripts/build-binaries.sh [--skip-deps] [--platform <platform>]
#
# Options:
#   --skip-deps         Skip frozen dependency install and package build
#   --platform <name>   Build only for specified platform
#                       (darwin-arm64, darwin-x64, linux-x64, linux-arm64)
#
# Output:
#   packages/coding-agent/binaries/
#     <platform>/pi
#
#   packages/coding-agent/release/artifacts/
#     prime-agent-<version>-<platform>.tar.gz
#     SHA256SUMS
#     stable
#     latest.json

set -euo pipefail

cd "$(dirname "$0")/.."

# Require Bun 1.4.0
EXPECTED_BUN_VERSION="1.4.0"
ACTUAL_BUN_VERSION=$(bun --version 2>/dev/null || echo "not-found")
if [ "$ACTUAL_BUN_VERSION" != "$EXPECTED_BUN_VERSION" ]; then
	echo "ERROR: Expected Bun ${EXPECTED_BUN_VERSION}, got ${ACTUAL_BUN_VERSION}"
	echo "Install Bun ${EXPECTED_BUN_VERSION}:"
	echo "  curl -fsSL https://bun.sh/install | bash -s -- bun-v${EXPECTED_BUN_VERSION}"
	exit 1
fi

SKIP_DEPS=false
PLATFORM=""

while [[ $# -gt 0 ]]; do
	case $1 in
		--skip-deps)
			SKIP_DEPS=true
			shift
			;;
		--platform)
			PLATFORM="$2"
			shift 2
			;;
		*)
			echo "Unknown option: $1"
			exit 1
			;;
	esac
done

# Validate platform if specified
if [[ -n "$PLATFORM" ]]; then
	case "$PLATFORM" in
		darwin-arm64|darwin-x64|linux-x64|linux-arm64|windows-x64|windows-arm64) ;;
		*)
			echo "Invalid platform: $PLATFORM"
			echo "Valid platforms: darwin-arm64, darwin-x64, linux-x64, linux-arm64, windows-x64, windows-arm64"
			exit 1
			;;
	esac
fi

if [[ "$SKIP_DEPS" == "false" ]]; then
	echo "==> Installing dependencies for all release platforms (frozen lockfile)..."
	bun install --frozen-lockfile --os=* --cpu=*

	echo "==> Building all packages..."
	bun run build
fi

echo "==> Compiling binaries..."
cd packages/coding-agent

# Clean previous builds
rm -rf binaries
mkdir -p binaries

# Determine which platforms to build
if [[ -n "$PLATFORM" ]]; then
	PLATFORMS=("$PLATFORM")
else
	PLATFORMS=(darwin-arm64 darwin-x64 linux-x64 linux-arm64 windows-x64 windows-arm64)
fi

for platform in "${PLATFORMS[@]}"; do
	echo "Building for $platform..."
	mkdir -p "binaries/$platform"
	bun build --compile --minify --keep-names --bytecode --format=esm --external koffi --target="bun-$platform" ./dist/bun/cli.js --outfile "binaries/$platform/pi"
done

echo "==> Copying sidecar assets..."
bun run copy-binary-assets

echo "==> Assembling release archives..."
VERSION=$(bun -e "console.log(require('./package.json').version)")
BASE_URL="${PRIME_AGENT_DOWNLOAD_BASE_URL:-https://releases.pi.ai}"
PACK_PLATFORM_ARGS=()
if [[ -n "$PLATFORM" ]]; then
	PACK_PLATFORM_ARGS=(--platform "$PLATFORM")
fi
bun ../../scripts/pack-prime-agent-release.mjs \
	--channel stable \
	--version "$VERSION" \
	--base-url "$BASE_URL" \
	--binary-base-dir "$(pwd)/binaries" \
	--sidecar-dir "$(pwd)/dist" \
	--out-dir "$(pwd)/release" \
	"${PACK_PLATFORM_ARGS[@]}"

echo ""
echo "==> Build complete!"
echo "Release archives:"
shopt -s nullglob
archives=(release/artifacts/*.tar.gz release/artifacts/*.zip)
if (( ${#archives[@]} == 0 )); then
	echo "No release archives were created" >&2
	exit 1
fi
ls -lh "${archives[@]}"
echo ""
echo "Metadata:"
ls -lh "release/artifacts/SHA256SUMS" "release/artifacts/latest.json" "release/artifacts/stable"

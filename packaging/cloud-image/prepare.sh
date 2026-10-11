#!/bin/sh
# prepare.sh — prepare the cloud-image build context for the Rust resident
# image: fetch the pinned release artifacts and verify them against
# checksums.sha256. The artifacts are gitignored and never committed.
#
# Defaults fetch the validated v0.9.7 reference pin. A deployment-time
# rebuild targeting a different release passes both flags:
#
#     ./prepare.sh --version <v> --sha256 <prime-agent-<v>-linux-x64.tar.gz sha256>
#
# Sources:
# - prime-agent-<version>-linux-x64.tar.gz — the Rust release tarball
#   (GitHub release asset; the sha256 must match the release SHA256SUMS).
# - frp_0.66.0_linux_amd64.tar.gz — the frp v0.66.0 release tarball.
set -eu

cd "$(dirname "$0")"

DEFAULT_VERSION=0.9.7
DEFAULT_SHA256=47981c19396bcaabfabc4d6d788e64d55c057288d8676fc5733ab525803be066

version="$DEFAULT_VERSION"
agent_sha256="$DEFAULT_SHA256"
while [ $# -gt 0 ]; do
    case "$1" in
        --version) version="$2"; shift 2 ;;
        --sha256) agent_sha256="$2"; shift 2 ;;
        *) echo "prepare.sh: unknown argument $1" >&2; exit 2 ;;
    esac
done

agent_tarball="prime-agent-$version-linux-x64.tar.gz"
base_url="https://github.com/PrimeIntellect-ai/prime-agent/releases/download/v$version"
frp_url="https://github.com/fatedier/frp/releases/download/v0.66.0/frp_0.66.0_linux_amd64.tar.gz"

fetch() {
    url="$1"
    out="$2"
    if [ -f "$out" ]; then
        echo "prepare.sh: $out already present, skipping download"
    else
        echo "prepare.sh: fetching $url"
        curl -fsSL -o "$out" "$url"
    fi
}

fetch "$base_url/$agent_tarball" "$agent_tarball"
fetch "$frp_url" frp_0.66.0_linux_amd64.tar.gz

echo "prepare.sh: verifying $agent_tarball against the pinned sha256"
echo "$agent_sha256  $agent_tarball" | sha256sum -c -

echo "prepare.sh: verifying the reference frp checksum"
sha256sum -c checksums.sha256

# The Dockerfile COPYs a fixed name (COPY source paths cannot interpolate
# build args); stage the verified tarball under it.
cp "$agent_tarball" prime-agent-release.tar.gz

echo "prepare.sh: build context ready"
echo "prepare.sh: build with --build-arg RELEASE_VERSION=$version RELEASE_PLATFORM=linux-x64 RELEASE_SHA256=$agent_sha256"

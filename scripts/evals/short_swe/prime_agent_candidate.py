"""Trusted Verifiers harness for testing local Prime Agent npm artifacts."""

from __future__ import annotations

from pathlib import Path
from uuid import uuid4

from candidate_contract import (
    TARBALLS,
    VERSION,
    load_artifacts,
    process_env,
    require_non_autonomous,
    validate_checksums,
)
from pydantic import Field, field_validator
from verifiers.v1.acp import ACPHarness
from verifiers.v1.configs.harness import HarnessConfig
from verifiers.v1.harnesses.node import ensure_node
from verifiers.v1.harnesses.prime_agent import PrimeAgentHarness
from verifiers.v1.harnesses.prime_agent.harness import PRIME_AGENT_DIR, SKILLS_DIR
from verifiers.v1.harnesses.utils.install import ensure_installed
from verifiers.v1.interception import server as interception_server
from verifiers.v1.runtimes import Runtime
from verifiers.v1.trace import Trace

__all__ = ["PrimeAgentCandidateHarness"]

MAX_MODEL_REQUEST_BYTES = 16_000_000
interception_server.MAX_REQUEST_BODY = MAX_MODEL_REQUEST_BYTES


INSTALL = r"""
set -e
export PATH="/var/tmp/vf-node/bin:$PATH"
prefix="$VF_PRIME_AGENT_DIR/$PRIME_AGENT_COMMIT"
source_dir="$VF_PRIME_AGENT_ARTIFACT_DIR"
trap 'rm -rf "$source_dir"' EXIT
[ -x "$prefix/bin/prime-agent" ] && [ -f "$HOME/.prime/agent/kernel-venv/.bootstrap-version" ] && exit 0
export NPM_CONFIG_PREFIX="$prefix"
export PRIME_AGENT_BOOTSTRAP_KERNEL_ON_INSTALL=1
agent_tarball="prime-agent-$PRIME_AGENT_RELEASE_VERSION.tgz"
ai_tarball="prime-agent-ai-$PRIME_AGENT_RELEASE_VERSION.tgz"
core_tarball="prime-agent-core-$PRIME_AGENT_RELEASE_VERSION.tgz"
tui_tarball="prime-agent-tui-$PRIME_AGENT_RELEASE_VERSION.tgz"
printf '%s\n' "$VF_PRIME_AGENT_SHA256SUMS" > "$source_dir/SHA256SUMS"
(cd "$source_dir" && sha256sum -c SHA256SUMS)
mkdir "$source_dir/core-root" "$source_dir/repacked-core"
tar -xzf "$source_dir/$core_tarball" -C "$source_dir/core-root"
node - \
    "$source_dir/core-root/package/package.json" \
    "$source_dir/$ai_tarball" <<'NODE'
const fs = require("node:fs");
const [manifestPath, ai] = process.argv.slice(2);
const manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8"));
manifest.dependencies["@earendil-works/pi-ai"] = `file:${ai}`;
fs.writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
NODE
repacked_core="$(npm pack "$source_dir/core-root/package" \
    --pack-destination "$source_dir/repacked-core" --silent)"

mkdir "$source_dir/package-root"
tar -xzf "$source_dir/$agent_tarball" -C "$source_dir/package-root"
node - \
    "$source_dir/package-root/package/package.json" \
    "$source_dir/$ai_tarball" \
    "$source_dir/repacked-core/$repacked_core" \
    "$source_dir/$tui_tarball" <<'NODE'
const fs = require("node:fs");
const [manifestPath, ai, core, tui] = process.argv.slice(2);
const manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8"));
for (const [name, file] of [
    ["@earendil-works/pi-ai", ai],
    ["@earendil-works/pi-agent-core", core],
    ["@earendil-works/pi-tui", tui],
]) {
    manifest.dependencies[name] = `file:${file}`;
}
fs.writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
NODE
mkdir "$source_dir/repacked"
repacked="$(npm pack "$source_dir/package-root/package" \
    --pack-destination "$source_dir/repacked" --silent)"
PRIME_AGENT_BOOTSTRAP_TOOLS_ON_INSTALL=1 npm install -g \
    --no-fund --no-audit --loglevel=error --progress=false \
    "$source_dir/repacked/$repacked"
[ -x "$prefix/bin/prime-agent" ]
[ -f "$HOME/.prime/agent/kernel-venv/.bootstrap-version" ]
"""


class PrimeAgentCandidateHarnessConfig(HarnessConfig):
    artifact_dir: Path
    commit: str = Field(pattern=r"^[0-9a-f]{40}$")
    autonomous: bool = False
    checksums: dict[str, str] | None = None

    @field_validator("autonomous")
    @classmethod
    def reject_autonomous(cls, value: bool) -> bool:
        return require_non_autonomous(value)

    @field_validator("checksums")
    @classmethod
    def check_checksums(cls, value: dict[str, str] | None) -> dict[str, str] | None:
        return validate_checksums(value)


class PrimeAgentCandidateHarness(PrimeAgentHarness, ACPHarness[PrimeAgentCandidateHarnessConfig]):
    """Prime Agent harness that installs only controller-supplied npm tarballs."""

    config: PrimeAgentCandidateHarnessConfig

    def _load_artifacts(self) -> tuple[dict[str, bytes], dict[str, str]]:
        return load_artifacts(self.config.artifact_dir, self.config.checksums)

    async def setup(self, runtime: Runtime) -> None:
        blobs, checksums = self._load_artifacts()
        await self.install_skills(runtime, SKILLS_DIR)
        await ensure_node(runtime)
        upload_dir = f"/tmp/vf-prime-agent-candidate-{uuid4().hex}"
        for name, data in blobs.items():
            await runtime.write(f"{upload_dir}/{name}", data)
        sums = "\n".join(f"{checksums[name]}  {name}" for name in TARBALLS)
        install_env = process_env(self.config.resolved_env)
        await ensure_installed(
            runtime,
            directory=PRIME_AGENT_DIR,
            install=INSTALL,
            env={
                **install_env,
                "VF_PRIME_AGENT_DIR": PRIME_AGENT_DIR,
                "VF_PRIME_AGENT_ARTIFACT_DIR": upload_dir,
                "VF_PRIME_AGENT_SHA256SUMS": sums,
                "PRIME_AGENT_COMMIT": self.config.commit,
                "PRIME_AGENT_RELEASE_VERSION": VERSION,
            },
            label="prime-agent candidate",
        )
        await ACPHarness.setup(self, runtime)

    def _env(self, trace: Trace, secret: str) -> dict[str, str]:
        return process_env(super()._env(trace, secret))

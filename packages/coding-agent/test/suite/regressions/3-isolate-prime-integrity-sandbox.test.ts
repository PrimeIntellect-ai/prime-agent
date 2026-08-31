import { spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { createHarness, type Harness } from "../harness.js";

const TEST_DIR = dirname(fileURLToPath(import.meta.url));
const PACKAGE_ROOT = resolve(TEST_DIR, "..", "..", "..");
const REPOSITORY_ROOT = resolve(PACKAGE_ROOT, "..", "..");
const RUNNER_PATH = join(PACKAGE_ROOT, "src", "evals", "prime-integrity", "runner.ts");
const TSX_PATH = join(REPOSITORY_ROOT, "node_modules", "tsx", "dist", "cli.mjs");

describe("issue #3 Prime Integrity sandbox", () => {
	let harness: Harness | undefined;

	afterEach(() => {
		harness?.cleanup();
		harness = undefined;
	});

	it("keeps provider config in the parent while hiding it from model-executed kernels", async () => {
		if (
			process.platform !== "linux" ||
			!existsSync("/usr/bin/bwrap") ||
			!existsSync("/usr/bin/python3") ||
			!existsSync("/usr/bin/setpriv")
		) {
			return;
		}
		harness = await createHarness();
		const configSource = join(harness.tempDir, "host-provider-config");
		const outputDir = join(harness.tempDir, "integrity-output");
		const hostWriteTarget = join(harness.tempDir, "host-write-target");
		const fakeAgent = join(outputDir, "prime-integrity-agent-probe.sh");
		mkdirSync(configSource, { recursive: true });
		mkdirSync(outputDir, { recursive: true });
		writeFileSync(
			join(configSource, "auth.json"),
			'{"fixture":"provider-secret","mcp:linear":"integration-secret"}\n',
			{ mode: 0o600 },
		);
		writeFileSync(
			join(configSource, "settings.json"),
			'{"defaultProvider":"fixture","mcpServers":{"evil":{"type":"stdio","command":"steal"}},"packages":["evil-package"],"shellPath":"/tmp/evil-shell"}\n',
			{ mode: 0o600 },
		);
		writeFileSync(
			fakeAgent,
			`#!/bin/sh
set -eu
case " $* " in
  *" --no-env "*) ;;
  *) printf 'missing --no-env\\n' >&2; exit 41 ;;
esac
test -z "\${AVO_REVIEW_API_KEY+x}" || { printf 'ambient secret visible to parent\\n' >&2; exit 42; }
test -z "\${SSH_AUTH_SOCK+x}" || { printf 'auth socket visible to parent\\n' >&2; exit 43; }
test -r "$PRIME_AGENT_AVO_CONFIG_DIR/auth.json" || { printf 'staged provider config unavailable\\n' >&2; exit 45; }
test ! -e ${JSON.stringify(join(configSource, "auth.json"))} || { printf 'host provider config visible\\n' >&2; exit 46; }
test ! -S /run/docker.sock || { printf 'docker socket visible to parent\\n' >&2; exit 47; }
test -S "$PRIME_AGENT_INTERNAL_AVO_PROBE_BROKER_SOCKET" || { printf 'probe broker unavailable to parent\\n' >&2; exit 48; }
printf tampered > ${JSON.stringify(hostWriteTarget)}
! grep -q 'mcp:linear' "$PRIME_AGENT_AVO_CONFIG_DIR/auth.json" || { printf 'MCP auth staged\\n' >&2; exit 49; }
! grep -q 'evil' "$PRIME_AGENT_AVO_CONFIG_DIR/settings.json" || { printf 'unsafe settings staged\\n' >&2; exit 50; }
export PRIME_INTEGRITY_TEST_HOST_CONFIG=${JSON.stringify(configSource)}
export PRIME_INTEGRITY_TEST_PROVIDER_PID="$$"
"$PRIME_AGENT_KERNEL_PYTHON" -c '
import json, os, pathlib
staged_auth = pathlib.Path(os.environ["PRIME_AGENT_AVO_CONFIG_DIR"]) / "auth.json"
host_auth = pathlib.Path(os.environ["PRIME_INTEGRITY_TEST_HOST_CONFIG"]) / "auth.json"
def can_read(path):
    try:
        path.read_bytes()
        return True
    except OSError:
        return False
try:
    (pathlib.Path.cwd().parent / "result.json").write_text("tampered", encoding="utf-8")
    host_artifact_parent_writable = True
except OSError:
    host_artifact_parent_writable = False
proof = {
    "ambient_secret_visible": "AVO_REVIEW_API_KEY" in os.environ,
    "auth_socket_visible": "SSH_AUTH_SOCK" in os.environ,
    "host_auth_visible": can_read(host_auth),
    "host_artifact_parent_writable": host_artifact_parent_writable,
    "staged_auth_visible": can_read(staged_auth),
	"probe_broker_environment_visible": "PRIME_AGENT_INTERNAL_AVO_PROBE_BROKER_SOCKET" in os.environ or "PRIME_AGENT_INTERNAL_AVO_PROBE_BROKER_TOKEN" in os.environ,
    "docker_socket_visible": pathlib.Path("/run/docker.sock").is_socket(),
    "provider_parent_pid_visible": can_read(pathlib.Path("/proc") / os.environ["PRIME_INTEGRITY_TEST_PROVIDER_PID"] / "environ"),
}
pathlib.Path("sandbox-proof.json").write_text(json.dumps(proof), encoding="utf-8")
'`,
			{ mode: 0o700 },
		);
		chmodSync(fakeAgent, 0o700);

		const execution = spawnSync(
			process.execPath,
			[
				TSX_PATH,
				RUNNER_PATH,
				"--case",
				"incomplete-obligations-01",
				"--agent-command",
				fakeAgent,
				"--config-source",
				configSource,
				"--output",
				outputDir,
				"--timeout-ms",
				"30000",
			],
			{
				encoding: "utf8",
				env: {
					...process.env,
					AVO_REVIEW_API_KEY: "fixture-secret",
					PRIME_AGENT_KERNEL_PYTHON: "/usr/bin/python3",
					SSH_AUTH_SOCK: "/run/fixture-agent.sock",
				},
				timeout: 120_000,
			},
		);

		expect(execution.status, `${execution.stdout}\n${execution.stderr}`).toBe(0);
		expect(existsSync(hostWriteTarget)).toBe(false);
		const proofPath = join(outputDir, "cases", "incomplete-obligations-01", "workspace", "sandbox-proof.json");
		const transcriptPath = join(outputDir, "cases", "incomplete-obligations-01", "transcript.log");
		expect(
			existsSync(proofPath),
			`${execution.stdout}\n${execution.stderr}\n${existsSync(transcriptPath) ? readFileSync(transcriptPath, "utf8") : ""}`,
		).toBe(true);
		expect(JSON.parse(readFileSync(proofPath, "utf8"))).toEqual({
			ambient_secret_visible: false,
			auth_socket_visible: false,
			host_auth_visible: false,
			host_artifact_parent_writable: false,
			staged_auth_visible: false,
			probe_broker_environment_visible: false,
			docker_socket_visible: false,
			provider_parent_pid_visible: false,
		});
	});
});

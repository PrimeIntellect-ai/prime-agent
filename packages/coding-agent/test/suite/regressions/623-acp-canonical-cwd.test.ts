import { existsSync, mkdtempSync, realpathSync, rmSync, statSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import * as acp from "@agentclientprotocol/sdk";
import { afterEach, describe, expect, it } from "vitest";
import type { AgentSessionRuntime } from "../../../src/core/agent-session-runtime.js";
import { PRIME_AGENT_META_NAMESPACE } from "../../../src/modes/acp/acp-meta.js";
import { runAcpModeWithConnection } from "../../../src/modes/acp/index.js";
import { InProcessAgentConnection } from "../../../src/modes/agent-connection/in-process-agent-connection.js";
import { createHarness, type Harness } from "../harness.js";

function runtimeHostFor(session: unknown): AgentSessionRuntime {
	return {
		session,
		setRebindSession() {},
		setBeforeSessionInvalidate() {},
		async dispose() {},
	} as unknown as AgentSessionRuntime;
}

async function newAcpSession(harness: Harness, cwd: string) {
	const connection = new InProcessAgentConnection(runtimeHostFor(harness.session));
	const toAgent = new TransformStream<Uint8Array, Uint8Array>();
	const toClient = new TransformStream<Uint8Array, Uint8Array>();
	void runAcpModeWithConnection(connection, {
		stream: acp.ndJsonStream(toClient.writable, toAgent.readable),
	});
	const handle = acp.client({ name: "cwd-regression" }).connect(acp.ndJsonStream(toAgent.writable, toClient.readable));
	await handle.agent.request("initialize", { protocolVersion: acp.PROTOCOL_VERSION, clientCapabilities: {} });
	return handle.agent.request("session/new", { cwd, mcpServers: [] });
}

function cwdMeta(created: { _meta?: Record<string, unknown> | null }): unknown {
	return (created._meta?.[PRIME_AGENT_META_NAMESPACE] as { cwd?: unknown } | undefined)?.cwd;
}

function findExistingCaseVariant(path: string): string | undefined {
	const originalStat = statSync(path, { bigint: true });
	for (let index = 0; index < path.length; index++) {
		const character = path[index];
		if (!character || !/[A-Z]/i.test(character)) continue;
		const toggled = character === character.toLowerCase() ? character.toUpperCase() : character.toLowerCase();
		const candidate = path.slice(0, index) + toggled + path.slice(index + 1);
		if (!existsSync(candidate)) continue;
		try {
			const candidateStat = statSync(candidate, { bigint: true });
			if (
				realpathSync(candidate) !== realpathSync(path) &&
				originalStat.dev === candidateStat.dev &&
				originalStat.ino === candidateStat.ino
			) {
				return candidate;
			}
		} catch {
			// Try the next component when this spelling cannot be inspected.
		}
	}
	return undefined;
}

const caseVariantCwd = findExistingCaseVariant(process.cwd());
const harnesses: Harness[] = [];
const directories: string[] = [];

afterEach(() => {
	for (const directory of directories.splice(0)) {
		rmSync(directory, { recursive: true, force: true });
	}
	for (const harness of harnesses.splice(0)) {
		harness.cleanup();
	}
});

describe("#623 ACP canonical cwd comparison", () => {
	it("does not report a mismatch for paths resolving to the same directory", async () => {
		const harness = await createHarness();
		harnesses.push(harness);
		const aliasRoot = mkdtempSync(join(tmpdir(), "prime-agent-acp-cwd-"));
		directories.push(aliasRoot);
		const alias = join(aliasRoot, "alias");
		symlinkSync(process.cwd(), alias, process.platform === "win32" ? "junction" : "dir");

		// macOS exposes /var as /private/var; a portable symlink exercises the
		// same distinction between a displayed path and its canonical path.
		const created = await newAcpSession(harness, alias);

		expect(created.sessionId).toBeTruthy();
		expect(cwdMeta(created)).toBeUndefined();
	}, 30_000);

	it.runIf(caseVariantCwd !== undefined)(
		"uses filesystem identity when realpath preserves different component casing",
		async () => {
			if (!caseVariantCwd) throw new Error("Expected a case-only cwd variant");
			const originalStat = statSync(process.cwd(), { bigint: true });
			const variantStat = statSync(caseVariantCwd, { bigint: true });
			expect(realpathSync(caseVariantCwd)).not.toBe(realpathSync(process.cwd()));
			expect([variantStat.dev, variantStat.ino]).toEqual([originalStat.dev, originalStat.ino]);

			const harness = await createHarness();
			harnesses.push(harness);

			const created = await newAcpSession(harness, caseVariantCwd);

			expect(created.sessionId).toBeTruthy();
			expect(cwdMeta(created)).toBeUndefined();
		},
		30_000,
	);

	it("preserves mismatch metadata when canonicalization falls back", async () => {
		const harness = await createHarness();
		harnesses.push(harness);
		const requested = join(harness.tempDir, "missing");

		const created = await newAcpSession(harness, requested);

		expect(created.sessionId).toBeTruthy();
		expect(cwdMeta(created)).toEqual({ requested, actual: process.cwd() });
	}, 30_000);
});

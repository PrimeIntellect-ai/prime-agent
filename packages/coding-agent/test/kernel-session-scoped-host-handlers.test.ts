import { mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { IpythonKernelProvisioner } from "../src/core/tools/ipython.js";

/**
 * Session-scoped host handler dispatch on a shared kernel.
 *
 * On the kernel-fulfill path an rlm child executes cells on its PARENT's
 * kernel. Host requests raised by such a cell must dispatch to the CHILD's
 * handlers (its own agent_message identity, its own rlm.run), not the kernel
 * owner's. Executions tagged with ExecuteOptions.ownerSessionId look up the
 * owning session in the provisioner's registry; everything else — untagged
 * cells, the owner's own id, unknown ids, dead registrations, and request
 * types the delegated set lacks — falls back to the owner's handlers.
 */
describe("session-scoped host handler dispatch", () => {
	let tempDir: string;
	let provisioner: IpythonKernelProvisioner | undefined;

	beforeEach(() => {
		tempDir = join(tmpdir(), `pi-session-host-dispatch-${Date.now()}-${Math.random().toString(36).slice(2)}`);
		mkdirSync(tempDir, { recursive: true });
	});

	afterEach(async () => {
		await provisioner?.dispose();
		provisioner = undefined;
		rmSync(tempDir, { recursive: true, force: true });
	});

	it("dispatches tagged executions to the registered session's handlers", async () => {
		provisioner = new IpythonKernelProvisioner(tempDir, {
			sessionId: "owner-session",
			hostHandlers: {
				"probe.whoami": async () => ({ who: "owner" }),
				"probe.owner_only": async () => ({ who: "owner-only" }),
			},
		});
		provisioner.registerSessionHostHandlers("child-session", () => ({
			"probe.whoami": async () => ({ who: "child" }),
		}));
		provisioner.registerSessionHostHandlers("dead-session", () => undefined);

		const manager = await provisioner.ensure();
		const probe = async (type: string, ownerSessionId?: string) => {
			const result = await manager.execute(
				`from rlm import host_request\nprint((await host_request("${type}"))["who"])`,
				ownerSessionId ? { ownerSessionId } : {},
			);
			expect(result.status).toBe("ok");
			return result.stdout.trim();
		};

		// Untagged and owner-tagged cells use the owner's handlers.
		expect(await probe("probe.whoami")).toBe("owner");
		expect(await probe("probe.whoami", "owner-session")).toBe("owner");
		// A cell tagged with a registered session dispatches to that session.
		expect(await probe("probe.whoami", "child-session")).toBe("child");
		// Unknown / dead sessions fall back to the owner.
		expect(await probe("probe.whoami", "unknown-session")).toBe("owner");
		expect(await probe("probe.whoami", "dead-session")).toBe("owner");
		// A type the delegated set lacks falls back to the owner's handler.
		expect(await probe("probe.owner_only", "child-session")).toBe("owner-only");

		// Unregistration restores owner dispatch.
		provisioner.unregisterSessionHostHandlers("child-session");
		expect(await probe("probe.whoami", "child-session")).toBe("owner");
	});
});

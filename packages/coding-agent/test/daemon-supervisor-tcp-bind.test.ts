import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import type { AddressInfo, Server } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

/** Stands in for the one `tailscale status --json` probe the listener makes. */
const tailscaleProbe = vi.hoisted(() => ({ calls: 0, result: undefined as unknown }));

vi.mock("../src/utils/child-process.js", async (importOriginal) => {
	const actual = await importOriginal<typeof import("../src/utils/child-process.js")>();
	return {
		...actual,
		spawnSyncHidden: (command: string, args: readonly string[], options: unknown) => {
			if (command === "tailscale") {
				tailscaleProbe.calls++;
				return tailscaleProbe.result;
			}
			return actual.spawnSyncHidden(command, args, options as never);
		},
	};
});

import { DaemonSupervisor } from "../src/modes/daemon/daemon-supervisor.js";

interface TcpListenerInternals {
	tcpPort?: number;
	tcpServer?: Server;
	log: ReturnType<typeof vi.fn>;
	startTcpListener(): Promise<void>;
}

const tempDirs: string[] = [];
const listeners: Server[] = [];

afterEach(async () => {
	for (const server of listeners.splice(0)) {
		await new Promise<void>((resolve) => server.close(() => resolve()));
	}
	for (const directory of tempDirs.splice(0)) rmSync(directory, { recursive: true, force: true });
	tailscaleProbe.calls = 0;
	tailscaleProbe.result = undefined;
});

function makeSupervisor(
	settings: Record<string, unknown> = {},
	options: { tcpBindHost?: string } = {},
): TcpListenerInternals {
	const directory = mkdtempSync(join(tmpdir(), "prime-supervisor-tcp-bind-"));
	tempDirs.push(directory);
	writeFileSync(join(directory, "settings.json"), JSON.stringify(settings));
	const supervisor = new DaemonSupervisor(join(directory, "daemon.sock"), {
		defaultSessionConfig: { agentDir: directory, cwd: directory },
		descriptorDir: join(directory, "workers"),
		...options,
	}) as unknown as TcpListenerInternals;
	supervisor.log = vi.fn();
	// Ephemeral port: the assertions are about the bound address, not the port.
	supervisor.tcpPort = 0;
	return supervisor;
}

/** Start the listener and return the address it actually bound. */
async function bind(supervisor: TcpListenerInternals): Promise<AddressInfo> {
	await supervisor.startTcpListener();
	const server = supervisor.tcpServer;
	if (!server) {
		throw new Error("daemon TCP listener did not bind");
	}
	listeners.push(server);
	return server.address() as AddressInfo;
}

/** Point the probe at a machine that is up on a tailnet at this address. */
function tailscaleUp(address: string): void {
	tailscaleProbe.result = {
		status: 0,
		stdout: JSON.stringify({ BackendState: "Running", Self: { Online: true, TailscaleIPs: [address] } }),
	};
}

describe("daemon supervisor tcp bind host", () => {
	it("binds the machine's tailscale address instead of every interface", async () => {
		// Loopback stands in for the tailnet address so the bind itself is real here.
		tailscaleUp("127.0.0.1");
		const supervisor = makeSupervisor();

		const address = await bind(supervisor);

		expect(address.address).toBe("127.0.0.1");
		expect(supervisor.log).toHaveBeenCalledWith(expect.stringContaining("listening on 127.0.0.1:"));
	});

	it("refuses to start when this machine has no tailscale address and no host is configured", async () => {
		tailscaleProbe.result = {
			status: -1,
			stdout: "",
			error: Object.assign(new Error("spawn tailscale ENOENT"), { code: "ENOENT" }),
		};
		const supervisor = makeSupervisor();

		const starting = supervisor.startTcpListener();
		await expect(starting).rejects.toThrow(/Refusing to start the daemon TCP listener/);
		await expect(starting).rejects.toThrow(/daemonTcpBindHost/);

		expect(supervisor.tcpServer).toBeUndefined();
	});

	it("binds the configured settings host without probing tailscale", async () => {
		// The probed address is not bindable here, so an ignored setting would fail loudly.
		tailscaleUp("100.64.0.7");
		const supervisor = makeSupervisor({ daemonTcpBindHost: "127.0.0.1" });

		const address = await bind(supervisor);

		expect(address.address).toBe("127.0.0.1");
		expect(tailscaleProbe.calls).toBe(0);
	});

	it("prefers the --daemon-bind flag over the settings host", async () => {
		const supervisor = makeSupervisor({ daemonTcpBindHost: "100.64.0.7" }, { tcpBindHost: "127.0.0.1" });

		const address = await bind(supervisor);

		expect(address.address).toBe("127.0.0.1");
		expect(tailscaleProbe.calls).toBe(0);
	});

	it("binds a wildcard host only when it is asked for explicitly, and warns", async () => {
		tailscaleProbe.result = {
			status: -1,
			stdout: "",
			error: Object.assign(new Error("spawn tailscale ENOENT"), { code: "ENOENT" }),
		};
		const supervisor = makeSupervisor({ daemonTcpBindHost: "0.0.0.0" });

		const address = await bind(supervisor);

		expect(address.address).toBe("0.0.0.0");
		expect(supervisor.log).toHaveBeenCalledWith(expect.stringContaining("binding every interface"));
	});
});

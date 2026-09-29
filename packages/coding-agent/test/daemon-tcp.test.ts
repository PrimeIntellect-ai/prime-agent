import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

const tokenRace = vi.hoisted(() => ({ armed: false, winnerToken: "" }));

/** Stands in for the one `tailscale status --json` probe the bind host resolution makes. */
const tailscaleProbe = vi.hoisted(() => ({ calls: 0, result: undefined as unknown }));

vi.mock("../src/utils/child-process.js", async (importOriginal) => {
	const actual = await importOriginal<typeof import("../src/utils/child-process.js")>();
	return {
		...actual,
		spawnSyncHidden: (command: string) => {
			tailscaleProbe.calls++;
			if (command !== "tailscale") {
				throw new Error(`unexpected command in bind host test: ${command}`);
			}
			return tailscaleProbe.result;
		},
	};
});

/** Point the probe at a node that is up on a tailnet with these own addresses. */
function tailscaleUp(addresses: string[]): void {
	tailscaleProbe.result = {
		status: 0,
		stdout: JSON.stringify({ BackendState: "Running", Self: { Online: true, TailscaleIPs: addresses } }),
	};
}

/** Point the probe at a machine with no usable tailnet address. */
function tailscaleUnavailable(reason: "missing" | "stopped" | "unparseable" | "no-address"): void {
	if (reason === "missing") {
		tailscaleProbe.result = {
			status: -1,
			stdout: "",
			error: Object.assign(new Error("spawn tailscale ENOENT"), { code: "ENOENT" }),
		};
		return;
	}
	if (reason === "stopped") {
		tailscaleProbe.result = {
			status: 0,
			stdout: JSON.stringify({ BackendState: "Stopped", Self: { Online: false, TailscaleIPs: ["100.64.0.7"] } }),
		};
		return;
	}
	if (reason === "no-address") {
		tailscaleProbe.result = {
			status: 0,
			stdout: JSON.stringify({ BackendState: "Running", Self: { Online: true, TailscaleIPs: [] } }),
		};
		return;
	}
	tailscaleProbe.result = { status: 0, stdout: "not json at all" };
}

vi.mock("node:fs", async (importOriginal) => {
	const actual = await importOriginal<typeof import("node:fs")>();
	return {
		...actual,
		writeFileSync: (path: unknown, data: unknown, options: unknown) => {
			if (tokenRace.armed && typeof path === "string" && path.endsWith("daemon-tcp-token")) {
				tokenRace.armed = false;
				const winnerLine = `${JSON.stringify({ token: tokenRace.winnerToken })}\n`;
				actual.writeFileSync(path, winnerLine, { mode: 0o600 });
				throw Object.assign(new Error("concurrent creator already wrote the token"), { code: "EEXIST" });
			}
			return actual.writeFileSync(path as never, data as never, options as never);
		},
	};
});

const {
	checkDaemonTcpLineAuth,
	isWildcardBindHost,
	loadOrCreateDaemonTcpToken,
	resolveDaemonTcpListenerHost,
	resolveDaemonTcpPort,
} = await import("../src/modes/daemon/daemon-tcp.js");

const tempDirs: string[] = [];

afterEach(() => {
	for (const directory of tempDirs.splice(0)) rmSync(directory, { recursive: true, force: true });
	tokenRace.armed = false;
	tailscaleProbe.calls = 0;
	tailscaleProbe.result = undefined;
});

function tempAgentDir(): string {
	const directory = mkdtempSync(join(tmpdir(), "prime-daemon-tcp-test-"));
	tempDirs.push(directory);
	return directory;
}

describe("daemon tcp token store", () => {
	it("creates a token on first load and keeps it stable across restarts", () => {
		const agentDir = tempAgentDir();
		const first = loadOrCreateDaemonTcpToken(agentDir);
		expect(first.created).toBe(true);
		expect(first.token).toMatch(/^[A-Za-z0-9_-]{43}$/);
		const second = loadOrCreateDaemonTcpToken(agentDir);
		expect(second.created).toBe(false);
		expect(second.token).toBe(first.token);
		expect(readFileSync(join(agentDir, "daemon-tcp-token"), "utf8")).toContain(first.token);
	});

	it("creates the token file with owner-only permissions", () => {
		const agentDir = tempAgentDir();
		const { tokenPath } = loadOrCreateDaemonTcpToken(agentDir);
		expect(statSync(tokenPath).mode & 0o777).toBe(0o600);
	});

	it("refuses corrupt token files instead of overwriting them", () => {
		const agentDir = tempAgentDir();
		writeFileSync(join(agentDir, "daemon-tcp-token"), "{ not json", { mode: 0o600 });
		expect(() => loadOrCreateDaemonTcpToken(agentDir)).toThrow(/not valid JSON/);
		writeFileSync(join(agentDir, "daemon-tcp-token"), JSON.stringify({ version: 1 }), { mode: 0o600 });
		expect(() => loadOrCreateDaemonTcpToken(agentDir)).toThrow(/missing its token/);
		expect(readFileSync(join(agentDir, "daemon-tcp-token"), "utf8")).toContain(JSON.stringify({ version: 1 }));
	});

	it("reuses the concurrent winner's token when the exclusive create loses", () => {
		const agentDir = tempAgentDir();
		tokenRace.winnerToken = "winner-token-value-0123456789abcdef";
		tokenRace.armed = true;

		const record = loadOrCreateDaemonTcpToken(agentDir);

		expect(record.token).toBe("winner-token-value-0123456789abcdef");
		expect(record.created).toBe(false);
		expect(readFileSync(join(agentDir, "daemon-tcp-token"), "utf8")).toContain("winner-token-value-0123456789abcdef");
	});
});

describe("daemon tcp port resolution", () => {
	it("prefers the CLI flag > env > settings, rejecting invalid sources", () => {
		expect(resolveDaemonTcpPort(4100, 4200, { PRIME_AGENT_DAEMON_PORT: "4300" })).toBe(4100);
		expect(resolveDaemonTcpPort(undefined, 4200, { PRIME_AGENT_DAEMON_PORT: "4300" })).toBe(4300);
		expect(resolveDaemonTcpPort(undefined, 4200, {})).toBe(4200);
		expect(resolveDaemonTcpPort(undefined, undefined, {})).toBeUndefined();
		expect(resolveDaemonTcpPort(70000, undefined, {})).toBeUndefined();
		expect(resolveDaemonTcpPort(0, 8123, {})).toBe(8123);
		expect(() => resolveDaemonTcpPort(undefined, undefined, { PRIME_AGENT_DAEMON_PORT: "not-a-port" })).toThrow(
			/PRIME_AGENT_DAEMON_PORT/,
		);
	});
});

describe("daemon tcp bind host", () => {
	it("binds the machine's tailscale address when no source names a host", () => {
		tailscaleUp(["fd7a:115c:a1e0::1", "100.101.102.103"]);
		expect(resolveDaemonTcpListenerHost(undefined, undefined, {})).toBe("100.101.102.103");
		// A tailnet without an IPv4 address still has an address worth binding.
		tailscaleUp(["fd7a:115c:a1e0::1"]);
		expect(resolveDaemonTcpListenerHost(undefined, undefined, {})).toBe("fd7a:115c:a1e0::1");
	});

	it("refuses to bind when no host is configured and this machine has no tailnet address", () => {
		for (const reason of ["missing", "stopped", "unparseable", "no-address"] as const) {
			tailscaleUnavailable(reason);
			// Fail closed: a missing tailnet address must never widen to 0.0.0.0.
			expect(() => resolveDaemonTcpListenerHost(undefined, undefined, {})).toThrow(
				/Refusing to start the daemon TCP listener/,
			);
			expect(() => resolveDaemonTcpListenerHost(undefined, undefined, {})).toThrow(/--daemon-bind/);
			expect(() => resolveDaemonTcpListenerHost(undefined, undefined, {})).toThrow(/daemonTcpBindHost/);
		}
	});

	it("prefers the flag > env > settings without probing tailscale", () => {
		tailscaleUp(["100.64.0.7"]);
		tailscaleProbe.calls = 0;
		expect(resolveDaemonTcpListenerHost("10.0.0.5", "10.0.0.7", { PRIME_AGENT_DAEMON_BIND_HOST: "10.0.0.6" })).toBe(
			"10.0.0.5",
		);
		expect(resolveDaemonTcpListenerHost(undefined, "10.0.0.7", { PRIME_AGENT_DAEMON_BIND_HOST: "10.0.0.6" })).toBe(
			"10.0.0.6",
		);
		expect(resolveDaemonTcpListenerHost(undefined, "10.0.0.7", {})).toBe("10.0.0.7");
		// An explicit host is trusted as given, so the probe never runs.
		expect(resolveDaemonTcpListenerHost("10.0.0.5", undefined, {})).toBe("10.0.0.5");
		expect(tailscaleProbe.calls).toBe(0);
	});

	it("rejects a host that is not an address and names the source", () => {
		expect(() => resolveDaemonTcpListenerHost("daemon.tailnet.ts.net", undefined, {})).toThrow(/--daemon-bind/);
		expect(() => resolveDaemonTcpListenerHost(undefined, undefined, { PRIME_AGENT_DAEMON_BIND_HOST: "lan" })).toThrow(
			/PRIME_AGENT_DAEMON_BIND_HOST/,
		);
		expect(() => resolveDaemonTcpListenerHost(undefined, "not-an-ip", {})).toThrow(/daemonTcpBindHost/);
	});

	it("accepts an explicit wildcard, trims configured hosts, and flags wildcards", () => {
		tailscaleUnavailable("missing");
		expect(resolveDaemonTcpListenerHost("0.0.0.0", undefined, {})).toBe("0.0.0.0");
		expect(resolveDaemonTcpListenerHost("  10.0.0.5  ", undefined, {})).toBe("10.0.0.5");
		expect(isWildcardBindHost("0.0.0.0")).toBe(true);
		// Every spelling of the unspecified IPv6 address binds every interface.
		for (const wildcard of ["::", "::0", "0:0:0:0:0:0:0:0"]) {
			expect(isWildcardBindHost(wildcard)).toBe(true);
		}
		for (const real of ["100.101.102.103", "127.0.0.1", "::1", "fd7a:115c:a1e0::1", "fe80::", "not-an-ip"]) {
			expect(isWildcardBindHost(real)).toBe(false);
		}
	});
});

describe("daemon tcp line auth", () => {
	const token = "test-token-value-0123456789";

	it("accepts raw and envelope command lines with the right token", () => {
		expect(checkDaemonTcpLineAuth(`{"id":"t1","type":"list","auth":{"token":"${token}"}}`, token).ok).toBe(true);
		expect(
			checkDaemonTcpLineAuth(
				`{"type":"command","id":"t2","protocol":{"name":"prime-agent.daemon","version":7},"command":{"type":"list"},"auth":{"token":"${token}"}}`,
				token,
			).ok,
		).toBe(true);
	});

	it("refuses bad tokens and compares without leaking length differences", () => {
		const missing = checkDaemonTcpLineAuth(`{"id":"t3","type":"list"}`, token);
		expect(missing).toMatchObject({ ok: false, reason: "missing_token", id: "t3", command: "list" });
		const wrong = checkDaemonTcpLineAuth(`{"id":"t4","type":"list","auth":{"token":"nope"}}`, token);
		expect(wrong).toMatchObject({ ok: false, reason: "wrong_token", id: "t4" });
		const empty = checkDaemonTcpLineAuth(`{"id":"t5","type":"list","auth":{"token":""}}`, token);
		expect(empty).toMatchObject({ ok: false, reason: "missing_token" });
		const envelopeLine = `{"type":"command","id":"t6","command":{"type":"list"},"auth":{"token":"x"}}`;
		expect(checkDaemonTcpLineAuth(envelopeLine, token)).toMatchObject({ ok: false, id: "t6", command: "list" });
		expect(checkDaemonTcpLineAuth("not json at all", token)).toMatchObject({ ok: false, reason: "invalid_json" });
	});

	it("refuses JSON primitive lines instead of dereferencing them", () => {
		// `null` in particular used to throw from the socket data handler.
		for (const line of ["null", "5", '"str"', "true"]) {
			expect(checkDaemonTcpLineAuth(line, token)).toMatchObject({ ok: false, reason: "invalid_json" });
		}
	});
});

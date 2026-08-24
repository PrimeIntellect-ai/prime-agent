import { type ChildProcess, spawn } from "node:child_process";
import { resolve } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { DAEMON_CATALOG_ROLE_ENV, DaemonCatalogClient } from "../src/modes/daemon/daemon-catalog-process.js";

const tsxPath = resolve(__dirname, "../../../node_modules/tsx/dist/cli.mjs");
const fixturePath = resolve(__dirname, "fixtures/daemon-catalog-client-fixture.ts");
const children = new Set<ChildProcess>();

function spawnCatalog(): ChildProcess {
	const child = spawn(process.execPath, [tsxPath, fixturePath], {
		env: { ...process.env, [DAEMON_CATALOG_ROLE_ENV]: "1" },
		stdio: ["ignore", "ignore", "pipe", "ipc"],
	});
	children.add(child);
	return child;
}

function waitForMessage(child: ChildProcess, predicate: (message: unknown) => boolean): Promise<unknown> {
	return new Promise((resolveMessage, rejectMessage) => {
		const timeout = setTimeout(() => {
			cleanup();
			rejectMessage(new Error("Timed out waiting for catalog fixture message"));
		}, 5000);
		const cleanup = () => {
			clearTimeout(timeout);
			child.off("message", onMessage);
			child.off("error", onError);
		};
		const onMessage = (message: unknown) => {
			if (!predicate(message)) return;
			cleanup();
			resolveMessage(message);
		};
		const onError = (error: Error) => {
			cleanup();
			rejectMessage(error);
		};
		child.on("message", onMessage);
		child.once("error", onError);
	});
}

function waitForExit(child: ChildProcess): Promise<{ code: number | null; signal: NodeJS.Signals | null }> {
	if (child.exitCode !== null || child.signalCode !== null) {
		return Promise.resolve({ code: child.exitCode, signal: child.signalCode });
	}
	return new Promise((resolveExit) => child.once("exit", (code, signal) => resolveExit({ code, signal })));
}

afterEach(async () => {
	for (const child of children) {
		if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
		await waitForExit(child);
	}
	children.clear();
});

describe("daemon catalog lifecycle", () => {
	it("maps SIGTERM to an orderly signal exit code", async () => {
		const child = spawnCatalog();
		await waitForMessage(child, (message) => (message as { type?: unknown })?.type === "ready");
		child.kill("SIGTERM");
		await expect(waitForExit(child)).resolves.toEqual({ code: 143, signal: null });
	});

	it("escalates a catalog that ignores graceful shutdown and reaps it", async () => {
		const client = new DaemonCatalogClient(
			() => {},
			() => ({ command: process.execPath, args: [tsxPath, fixturePath] }),
		);
		const previous = process.env.PRIME_AGENT_TEST_CATALOG_STUCK;
		process.env.PRIME_AGENT_TEST_CATALOG_STUCK = "1";
		try {
			await client.start();
			const child = Reflect.get(client, "child") as ChildProcess | undefined;
			expect(child?.pid).toEqual(expect.any(Number));

			await client.stop();

			expect(child?.signalCode).toBe("SIGKILL");
		} finally {
			if (previous === undefined) delete process.env.PRIME_AGENT_TEST_CATALOG_STUCK;
			else process.env.PRIME_AGENT_TEST_CATALOG_STUCK = previous;
		}
	});

	it("stops the catalog child repeatedly without process accumulation", async () => {
		const stopped: ChildProcess[] = [];
		for (let cycle = 0; cycle < 3; cycle++) {
			const client = new DaemonCatalogClient(
				() => {},
				() => ({ command: process.execPath, args: [tsxPath, fixturePath] }),
			);
			await client.start();
			const child = Reflect.get(client, "child") as ChildProcess | undefined;
			if (!child) throw new Error("Catalog client did not retain its child");
			stopped.push(child);
			await client.stop();
		}

		expect(stopped).toHaveLength(3);
		expect(stopped.every((child) => child.exitCode === 0 && child.signalCode === null)).toBe(true);
	});

	it("stops and reaps the catalog child before resolving", async () => {
		const client = new DaemonCatalogClient(
			() => {},
			() => ({ command: process.execPath, args: [tsxPath, fixturePath] }),
		);
		await client.start();
		const child = Reflect.get(client, "child") as ChildProcess | undefined;
		expect(child?.pid).toEqual(expect.any(Number));

		await client.stop();

		expect(child?.exitCode).toBe(0);
		expect(child?.signalCode).toBeNull();
	});
});

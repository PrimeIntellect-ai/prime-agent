import { spawn } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, unlinkSync, writeFileSync } from "node:fs";
import { createConnection, createServer } from "node:net";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
import lockfile from "proper-lockfile";
import { describe, expect, it, vi } from "vitest";
import {
	acquireDaemonSocketPathLease,
	cleanupDaemonSocketPath,
	DaemonSocketPathLease,
	defaultDaemonSocketDir,
	defaultDaemonSocketPath,
	endDaemonSocketAfterFlush,
	getDaemonSocketIdentity,
	normalizeSocketPath,
	prepareDaemonSocketPath,
} from "../src/modes/daemon/daemon-socket.js";

describe("endDaemonSocketAfterFlush", () => {
	it("delivers queued bytes before closing the socket", async () => {
		const server = createServer((socket) => {
			socket.write("daemon_closing\n");
			endDaemonSocketAfterFlush(socket);
		});
		await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
		const address = server.address();
		if (!address || typeof address === "string") throw new Error("Expected TCP server address");
		const received = await new Promise<string>((resolve, reject) => {
			let data = "";
			const socket = createConnection({ host: "127.0.0.1", port: address.port });
			socket.setEncoding("utf8");
			socket.on("data", (chunk) => {
				data += chunk;
			});
			socket.on("end", () => resolve(data));
			socket.on("error", reject);
		});
		await new Promise<void>((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
		expect(received).toBe("daemon_closing\n");
	});
});

describe.each([
	{ platform: "darwin", limit: 103 },
	{ platform: "linux", limit: 107 },
])("Unix socket bind path length on $platform", ({ platform, limit }) => {
	function socketPathWithBytes(directory: string, byteLength: number, encoding: string): string {
		const stemBytes = byteLength - Buffer.byteLength(join(directory, ".sock"));
		const stem =
			encoding === "multibyte"
				? "é".repeat(Math.floor(stemBytes / 2)) + "x".repeat(stemBytes % 2)
				: "x".repeat(stemBytes);
		return join(directory, `${stem}.sock`);
	}

	it.each(["ascii", "multibyte"])("accepts the exact byte boundary for %s paths", async (encoding) => {
		const root = mkdtempSync(join(tmpdir(), "pa-len-"));
		const hostPlatform = Object.getOwnPropertyDescriptor(process, "platform")!;
		let lease: DaemonSocketPathLease | undefined;
		try {
			Object.defineProperty(process, "platform", { value: platform });
			vi.stubEnv("TMPDIR", root);
			const socketPath = socketPathWithBytes(defaultDaemonSocketDir(), limit, encoding);
			expect(Buffer.byteLength(socketPath)).toBe(limit);
			lease = await acquireDaemonSocketPathLease(socketPath);
			expect(lease?.socketPath).toBe(socketPath);
			expect(existsSync(`${socketPath}.lock`)).toBe(true);
			await expect(prepareDaemonSocketPath(socketPath, lease)).resolves.toBeUndefined();
			expect(existsSync(socketPath)).toBe(false);
			await lease?.release();
			expect(existsSync(`${socketPath}.lock`)).toBe(false);
		} finally {
			await lease?.release();
			vi.unstubAllEnvs();
			Object.defineProperty(process, "platform", hostPlatform);
			rmSync(root, { recursive: true, force: true });
		}
	});

	it.each([
		{ operation: "acquire", encoding: "ascii" },
		{ operation: "prepare", encoding: "ascii" },
		{ operation: "acquire", encoding: "multibyte" },
		{ operation: "prepare", encoding: "multibyte" },
	])("rejects an overlong $encoding path before $operation side effects", async ({ operation, encoding }) => {
		const root = mkdtempSync(join(tmpdir(), "pa-len-"));
		const hostPlatform = Object.getOwnPropertyDescriptor(process, "platform")!;
		let lease: DaemonSocketPathLease | undefined;
		try {
			Object.defineProperty(process, "platform", { value: platform });
			vi.stubEnv("TMPDIR", root);
			const socketDir = defaultDaemonSocketDir();
			const socketPath = socketPathWithBytes(socketDir, limit + 1, encoding);
			expect(Buffer.byteLength(socketPath)).toBe(limit + 1);
			if (encoding === "multibyte") expect(socketPath.length).toBeLessThan(limit);
			let error: unknown;
			try {
				if (operation === "acquire") lease = await acquireDaemonSocketPathLease(socketPath);
				else await prepareDaemonSocketPath(socketPath);
			} catch (caught) {
				error = caught;
			}
			expect(existsSync(socketDir)).toBe(false);
			expect(existsSync(`${socketPath}.lock`)).toBe(false);
			expect(existsSync(socketPath)).toBe(false);
			expect(error).toBeInstanceOf(Error);
			expect((error as Error).message).toMatch(/socket path.*too long/i);
			expect((error as Error).message).toContain(`${limit + 1} bytes`);
			expect((error as Error).message).toContain(`maximum ${limit} on ${platform}`);
		} finally {
			await lease?.release();
			vi.unstubAllEnvs();
			Object.defineProperty(process, "platform", hostPlatform);
			rmSync(root, { recursive: true, force: true });
		}
	});

	it("still cleans up an existing overlong path without applying bind validation", () => {
		const root = mkdtempSync(join(tmpdir(), "pa-len-"));
		const hostPlatform = Object.getOwnPropertyDescriptor(process, "platform")!;
		try {
			Object.defineProperty(process, "platform", { value: platform });
			const socketPath = socketPathWithBytes(root, limit + 1, "ascii");
			writeFileSync(socketPath, "stale socket record");
			const identity = getDaemonSocketIdentity(socketPath);
			expect(readFileSync(socketPath, "utf8")).toBe("stale socket record");
			cleanupDaemonSocketPath(socketPath, identity);
			expect(existsSync(socketPath)).toBe(false);
			expect(existsSync(`${socketPath}.lock`)).toBe(false);
		} finally {
			Object.defineProperty(process, "platform", hostPlatform);
			rmSync(root, { recursive: true, force: true });
		}
	});
});

describe("normalizeSocketPath", () => {
	it("normalizes equivalent Unix spellings", () => {
		if (process.platform === "win32") return;
		expect(normalizeSocketPath("/a//b.sock/")).toBe("/a/b.sock");
	});
});

describe("defaultDaemonSocketPath", () => {
	it("uses a fixed Windows named pipe path", () => {
		if (process.platform !== "win32") {
			return;
		}

		expect(defaultDaemonSocketPath()).toBe("\\\\.\\pipe\\prime-agent-daemon");
	});

	it("uses a per-user Unix socket directory", () => {
		if (process.platform === "win32") {
			return;
		}

		const suffix = typeof process.getuid === "function" ? String(process.getuid()) : "user";
		const socketPath = defaultDaemonSocketPath();

		expect(dirname(socketPath)).toBe(join(tmpdir(), `prime-agent-${suffix}`));
		expect(basename(socketPath)).toBe("daemon.sock");
	});

	it("checks a live daemon before acquiring the socket path lock", async () => {
		if (process.platform === "win32") {
			return;
		}

		const dir = mkdtempSync(join(tmpdir(), "pa-socket-live-"));
		const socketPath = join(dir, "daemon.sock");
		let observedLock: boolean | undefined;
		const server = createServer((socket) => {
			observedLock = existsSync(`${socketPath}.lock`);
			socket.destroy();
		});
		try {
			await new Promise<void>((resolve, reject) => {
				server.once("error", reject);
				server.listen(socketPath, resolve);
			});

			await expect(prepareDaemonSocketPath(socketPath)).rejects.toThrow(/socket already in use/i);
			expect(observedLock).toBe(false);
		} finally {
			if (server.listening) {
				await new Promise<void>((resolve) => server.close(() => resolve()));
			}
			rmSync(dir, { recursive: true, force: true });
		}
	});

	it("does not wait on a stale lock when no socket path exists", async () => {
		if (process.platform === "win32") {
			return;
		}

		const dir = mkdtempSync(join(tmpdir(), "pa-socket-stale-lock-"));
		const socketPath = join(dir, "daemon.sock");
		mkdirSync(`${socketPath}.lock`);
		let prepared = false;
		try {
			await Promise.race([
				prepareDaemonSocketPath(socketPath).then(() => {
					prepared = true;
				}),
				new Promise<void>((resolve) => setTimeout(resolve, 250)),
			]);
			expect(prepared).toBe(true);
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});

	it("does not unlink a replacement daemon's socket during delayed cleanup", async () => {
		if (process.platform === "win32") {
			return;
		}

		const dir = mkdtempSync(join(tmpdir(), "pa-socket-ownership-"));
		const socketPath = join(dir, "daemon.sock");
		const oldServer = createServer();
		const replacementServer = createServer();
		try {
			await new Promise<void>((resolve, reject) => {
				oldServer.once("error", reject);
				oldServer.listen(socketPath, resolve);
			});
			const oldIdentity = getDaemonSocketIdentity(socketPath);
			if (!oldIdentity) {
				throw new Error("Expected a Unix daemon socket identity");
			}

			unlinkSync(socketPath);
			await new Promise<void>((resolve, reject) => {
				replacementServer.once("error", reject);
				replacementServer.listen(socketPath, resolve);
			});

			cleanupDaemonSocketPath(socketPath, oldIdentity);

			await expect(
				new Promise<void>((resolve, reject) => {
					const client = createConnection(socketPath);
					client.once("connect", () => {
						client.destroy();
						resolve();
					});
					client.once("error", reject);
				}),
			).resolves.toBeUndefined();
		} finally {
			await Promise.all(
				[oldServer, replacementServer].map(
					(server) =>
						new Promise<void>((resolve) => {
							server.close(() => resolve());
						}),
				),
			);
			rmSync(dir, { recursive: true, force: true });
		}
	});

	it("does not unlink a socket while another daemon owns the path lock", async () => {
		if (process.platform === "win32") {
			return;
		}

		const dir = mkdtempSync(join(tmpdir(), "pa-socket-lock-"));
		const socketPath = join(dir, "daemon.sock");
		const server = createServer();
		let releaseLock: (() => Promise<void>) | undefined;
		try {
			await new Promise<void>((resolve, reject) => {
				server.once("error", reject);
				server.listen(socketPath, resolve);
			});
			const identity = getDaemonSocketIdentity(socketPath);
			if (!identity) {
				throw new Error("Expected a Unix daemon socket identity");
			}
			releaseLock = await lockfile.lock(socketPath, { realpath: false });

			cleanupDaemonSocketPath(socketPath, identity);

			await expect(
				new Promise<void>((resolve, reject) => {
					const client = createConnection(socketPath);
					client.once("connect", () => {
						client.destroy();
						resolve();
					});
					client.once("error", reject);
				}),
			).resolves.toBeUndefined();
		} finally {
			await releaseLock?.();
			await new Promise<void>((resolve) => server.close(() => resolve()));
			rmSync(dir, { recursive: true, force: true });
		}
	});

	it("does not remove a replacement socket that appears while stale cleanup is pending", async () => {
		if (process.platform === "win32") {
			return;
		}

		const dir = mkdtempSync(join(tmpdir(), "pa-socket-startup-"));
		const socketPath = join(dir, "daemon.sock");
		const staleOwner = spawn(
			process.execPath,
			[
				"-e",
				"const { createServer } = require('node:net'); const server = createServer(); server.listen(process.argv[1], () => process.stdout.write('ready'));",
				socketPath,
			],
			{ stdio: ["ignore", "pipe", "ignore"] },
		);
		const replacementServer = createServer();
		let replacementTimer: ReturnType<typeof setTimeout> | undefined;
		try {
			await new Promise<void>((resolve, reject) => {
				staleOwner.stdout?.once("data", () => resolve());
				staleOwner.once("error", reject);
				staleOwner.once("exit", (code) => {
					if (code !== null && code !== 0) {
						reject(new Error(`Stale socket owner exited before listening: ${code}`));
					}
				});
			});
			staleOwner.kill("SIGKILL");
			await new Promise<void>((resolve) => staleOwner.once("close", () => resolve()));
			expect(existsSync(socketPath)).toBe(true);

			const replacementListening = new Promise<void>((resolve, reject) => {
				replacementTimer = setTimeout(() => {
					try {
						if (existsSync(socketPath)) {
							unlinkSync(socketPath);
						}
						replacementServer.once("error", reject);
						replacementServer.listen(socketPath, resolve);
					} catch (error) {
						reject(error);
					}
				}, 50);
			});

			await expect(prepareDaemonSocketPath(socketPath)).rejects.toThrow(
				/socket (already in use|changed ownership)/i,
			);
			await replacementListening;
			await expect(
				new Promise<void>((resolve, reject) => {
					const client = createConnection(socketPath);
					client.once("connect", () => {
						client.destroy();
						resolve();
					});
					client.once("error", reject);
				}),
			).resolves.toBeUndefined();
		} finally {
			if (replacementTimer) {
				clearTimeout(replacementTimer);
			}
			if (staleOwner.exitCode === null && staleOwner.signalCode === null) {
				staleOwner.kill("SIGKILL");
			}
			if (replacementServer.listening) {
				await new Promise<void>((resolve) => replacementServer.close(() => resolve()));
			}
			rmSync(dir, { recursive: true, force: true });
		}
	});
});

describe.skipIf(process.platform === "win32")("DaemonSocketPathLease compromise hardening", () => {
	it("records compromise without rethrowing listener failures", () => {
		const lease = new DaemonSocketPathLease("/tmp/test.sock", () => Promise.resolve());
		const observed: Error[] = [];
		lease.onCompromised(() => {
			throw new Error("listener failed");
		});
		lease.onCompromised((error) => observed.push(error));

		expect(() => lease.recordCompromise(new Error("lock update failed"))).not.toThrow();
		expect(lease.compromise?.message).toBe("lock update failed");
		expect(observed).toHaveLength(1);
	});

	it("does not unlink a successor socket after the old lease is compromised", async () => {
		const dir = mkdtempSync(join(tmpdir(), "pa-socket-compromise-"));
		const socketPath = join(dir, "daemon.sock");
		const server = createServer();
		try {
			await new Promise<void>((resolve) => server.listen(socketPath, resolve));
			const identity = getDaemonSocketIdentity(socketPath);
			const lease = new DaemonSocketPathLease(socketPath, () => Promise.resolve());
			lease.recordCompromise(new Error("lock stolen"));

			cleanupDaemonSocketPath(socketPath, identity, lease);
			expect(existsSync(socketPath)).toBe(true);
		} finally {
			await new Promise<void>((resolve) => server.close(() => resolve()));
			rmSync(dir, { recursive: true, force: true });
		}
	});
});

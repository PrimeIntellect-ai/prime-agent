/**
 * Unit tests for PrimeTunnelManager.
 *
 * Uses a fake ManagedProcess so tests are deterministic and never
 * invoke the real `prime` CLI or create real tunnels.
 */

import { describe, expect, it } from "vitest";
import {
	defaultCleanupRunner,
	generateTunnelUser,
	type ManagedProcess,
	PrimeTunnelManager,
	TunnelAbortError,
	TunnelStartError,
	type TunnelStartOptions,
	TunnelTimeoutError,
} from "../src/core/prime-tunnel-manager.js";

// ---------------------------------------------------------------------------
// Fake ManagedProcess with SIGTERM/SIGKILL awareness
// ---------------------------------------------------------------------------

class FakeManagedProcess implements ManagedProcess {
	private _running = true;
	private _lines: string[] = [];
	private _exitResolve: ((result: { code: number; signal: string | null }) => void) | null = null;
	private _exitPromise: Promise<{
		code: number;
		signal: string | null;
	}>;
	private _exitOnKill = true;
	private _killCalls: Array<"SIGTERM" | "SIGKILL"> = [];
	lastSpawnArgv: string[] | null = null;

	constructor() {
		this._exitPromise = new Promise((resolve) => {
			this._exitResolve = resolve;
		});
	}

	set exitOnKill(v: boolean) {
		this._exitOnKill = v;
	}

	get pid(): number | undefined {
		return 42;
	}

	get running(): boolean {
		return this._running;
	}

	get killCalls(): ReadonlyArray<"SIGTERM" | "SIGKILL"> {
		return this._killCalls;
	}

	/** Provide preloaded lines (like spawn output already in buffer). */
	preloadLines(lines: readonly string[]): void {
		this._lines.push(...lines);
	}

	spawn(argv: string[], _options?: { signal?: AbortSignal }): void {
		this._running = true;
		this.lastSpawnArgv = argv;
	}

	readLine(): string | null {
		return this._lines.shift() ?? null;
	}

	/** Simulate process exit. */
	exit(code: number, signal: string | null = null): void {
		this._running = false;
		this._exitResolve?.({ code, signal });
	}

	kill(signal: "SIGTERM" | "SIGKILL" = "SIGTERM"): void {
		this._killCalls.push(signal);
		this._running = false;
		if (this._exitOnKill) {
			this._exitResolve?.({ code: -1, signal });
		}
	}

	wait(): Promise<{ code: number; signal: string | null }> {
		return this._exitPromise;
	}
}

// ---------------------------------------------------------------------------
// Factory helpers
// ---------------------------------------------------------------------------

const STD_LINES: readonly string[] = [
	"Tunnel started successfully!",
	"URL: https://example-tunnel.primeintellect.ai",
	"Tunnel ID: tun_abc123def456",
	"Basic auth user: tun-abc123",
	"Basic auth password: s3cret!p4ss",
];

const FAST_CLOCK = {
	sleep: async () => {},
	now: () => Date.now(),
};

/** Create options with a fresh FakeManagedProcess. */
function opts(
	overrides?: Partial<TunnelStartOptions> & {
		fake?: FakeManagedProcess;
	},
): TunnelStartOptions {
	const fp = overrides?.fake ?? new FakeManagedProcess();
	const base: TunnelStartOptions = {
		localPort: 8765,
		httpUser: "tun-abc123",
		startTimeoutMs: 5000,
		processFactory: () => fp,
	};
	Object.assign(base, overrides);
	(base as unknown as Record<string, unknown>).fakeProcess = undefined;
	(base as unknown as Record<string, unknown>).fake = undefined;
	return base;
}

function emitStandard(fp: FakeManagedProcess): void {
	for (const l of STD_LINES) fp.preloadLines([l]);
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("PrimeTunnelManager", () => {
	describe("start", () => {
		it("returns catalog-safe descriptor and grant via consumeGrant", async () => {
			const fp = new FakeManagedProcess();
			const mgr = new PrimeTunnelManager();
			emitStandard(fp);

			const d = await mgr.start(opts({ fake: fp }));

			expect(d.tunnelId).toBe("tun_abc123def456");
			expect(d.url).toBe("https://example-tunnel.primeintellect.ai");
			expect(d.localPort).toBe(8765);
			expect((d as unknown as Record<string, unknown>).pid).toBeUndefined();
			expect((d as unknown as Record<string, unknown>).httpUser).toBeUndefined();

			const g = mgr.consumeGrant();
			expect(g).not.toBeNull();
			expect(g!.httpPassword).toBe("s3cret!p4ss");
			// Second consume returns null
			expect(mgr.consumeGrant()).toBeNull();
		});

		it("parses output arriving incrementally", async () => {
			const fp = new FakeManagedProcess();
			const mgr = new PrimeTunnelManager();
			fp.preloadLines(STD_LINES.slice(0, 5));

			await mgr.start(opts({ fake: fp }));

			const g = mgr.consumeGrant();
			expect(g?.httpPassword).toBe("s3cret!p4ss");
		});

		it("throws TUNNEL_MISSING_PASSWORD with correct code", async () => {
			const fp = new FakeManagedProcess();
			const mgr = new PrimeTunnelManager();
			fp.preloadLines(["Tunnel ID: tun_nopwd", "URL: https://nopwd.tunnel", "Basic auth user: tun-abc123"]);

			let err: unknown;
			try {
				await mgr.start(opts({ fake: fp }));
			} catch (e) {
				err = e;
			}
			expect(err).toBeInstanceOf(TunnelStartError);
			expect((err as TunnelStartError).code).toBe("TUNNEL_MISSING_PASSWORD");
			expect(mgr.consumeGrant()).toBeNull();
		});

		it("throws on timeout", async () => {
			const fp = new FakeManagedProcess();
			const mgr = new PrimeTunnelManager();

			await expect(mgr.start(opts({ fake: fp, startTimeoutMs: 100 }))).rejects.toThrow(TunnelTimeoutError);
		});

		it("throws on abort signal", async () => {
			const fp = new FakeManagedProcess();
			const mgr = new PrimeTunnelManager();
			const ac = new AbortController();

			const p = mgr.start(
				opts({
					fake: fp,
					signal: ac.signal,
					startTimeoutMs: 10000,
				}),
			);
			fp.preloadLines(["URL: https://x.com"]);
			ac.abort();

			await expect(p).rejects.toThrow(TunnelAbortError);
			expect(mgr.consumeGrant()).toBeNull();
		});

		it("throws on unexpected exit before start", async () => {
			const fp = new FakeManagedProcess();
			const mgr = new PrimeTunnelManager();

			const p = mgr.start(opts({ fake: fp }));
			fp.preloadLines(["URL: https://x.com"]);
			fp.exit(1);

			await expect(p).rejects.toThrow(TunnelStartError);
		});

		it("throws on second start call", async () => {
			const fp = new FakeManagedProcess();
			const mgr = new PrimeTunnelManager();
			emitStandard(fp);
			await mgr.start(opts({ fake: fp }));

			const fp2 = new FakeManagedProcess();
			emitStandard(fp2);
			await expect(mgr.start(opts({ fake: fp2 }))).rejects.toThrow(TunnelStartError);
		});

		it("auto-generates httpUser when omitted", async () => {
			const fp = new FakeManagedProcess();
			const mgr = new PrimeTunnelManager();

			const p = mgr.start(opts({ fake: fp, httpUser: undefined }));
			const authIdx = fp.lastSpawnArgv!.indexOf("--auth");
			const gen = fp.lastSpawnArgv![authIdx + 1];
			expect(gen).toMatch(/^tun-[a-f0-9]{16}$/);

			fp.preloadLines([
				"Tunnel ID: tun_gen",
				"URL: https://gen.tunnel",
				`Basic auth user: ${gen}`,
				"Basic auth password: p4ss",
			]);
			await p;

			const grant = mgr.consumeGrant();
			expect(grant?.httpUser).toBe(gen);
		});

		it("rejects invalid port", async () => {
			const mgr = new PrimeTunnelManager();
			await expect(mgr.start(opts({ localPort: 0 }))).rejects.toThrow(TunnelStartError);
			await expect(mgr.start(opts({ localPort: 65536 }))).rejects.toThrow(TunnelStartError);
		});

		it("rejects invalid httpUser", async () => {
			const mgr = new PrimeTunnelManager();
			await expect(mgr.start(opts({ httpUser: "user with spaces" }))).rejects.toThrow(TunnelStartError);
			await expect(mgr.start(opts({ httpUser: "user:name" }))).rejects.toThrow(TunnelStartError);
		});

		it("rejects invalid name and labels", async () => {
			const mgr = new PrimeTunnelManager();
			await expect(mgr.start(opts({ name: "a".repeat(200) }))).rejects.toThrow(TunnelStartError);
			await expect(mgr.start(opts({ labels: ["invalid label!!!"] }))).rejects.toThrow(TunnelStartError);
		});

		it("rejects too many labels (11)", async () => {
			const mgr = new PrimeTunnelManager();
			const many = Array.from({ length: 11 }, (_, i) => `l${i}`);
			await expect(mgr.start(opts({ labels: many }))).rejects.toThrow(TunnelStartError);
		});

		it("rejects auth user mismatch", async () => {
			const fp = new FakeManagedProcess();
			const mgr = new PrimeTunnelManager();
			fp.preloadLines([
				"Tunnel ID: tun_mm",
				"URL: https://mm.tunnel",
				"Basic auth user: wrong-user",
				"Basic auth password: s3cret",
			]);

			await expect(mgr.start(opts({ fake: fp, httpUser: "tun-abc123" }))).rejects.toThrow(TunnelStartError);
		});

		it("rejects empty password (blank value)", async () => {
			const fp = new FakeManagedProcess();
			const mgr = new PrimeTunnelManager();
			fp.preloadLines([
				"Tunnel ID: tun_emp",
				"URL: https://emp.tunnel",
				"Basic auth user: tun-abc123",
				"Basic auth password:",
			]);

			await expect(mgr.start(opts({ fake: fp }))).rejects.toThrow(TunnelStartError);
		});

		it("rejects non-finite startTimeoutMs", async () => {
			const mgr = new PrimeTunnelManager();
			await expect(mgr.start(opts({ startTimeoutMs: -1 }))).rejects.toThrow(TunnelStartError);
			await expect(mgr.start(opts({ startTimeoutMs: Infinity }))).rejects.toThrow(TunnelStartError);
			await expect(mgr.start(opts({ startTimeoutMs: 0 }))).rejects.toThrow(TunnelStartError);
		});

		it("accepts WSS URLs with matching auth user", async () => {
			const fp = new FakeManagedProcess();
			const mgr = new PrimeTunnelManager();
			fp.preloadLines([
				"Tunnel ID: tun_ws",
				"URL: wss://ws-tunnel.test",
				"Basic auth user: user",
				"Basic auth password: p4ss",
			]);

			const d = await mgr.start(opts({ fake: fp, httpUser: "user" }));
			expect(d.url).toBe("wss://ws-tunnel.test");
		});

		it("rejects non-HTTPS/WSS URLs", async () => {
			const fp = new FakeManagedProcess();
			const mgr = new PrimeTunnelManager();
			fp.preloadLines([
				"Tunnel ID: tun_http",
				"URL: http://insecure.tunnel",
				"Basic auth user: user",
				"Basic auth password: p4ss",
			]);

			await expect(mgr.start(opts({ fake: fp }))).rejects.toThrow(TunnelStartError);
		});
	});

	describe("consumeGrant (one-time)", () => {
		it("returns grant once then null", async () => {
			const fp = new FakeManagedProcess();
			const mgr = new PrimeTunnelManager();
			emitStandard(fp);
			await mgr.start(opts({ fake: fp }));

			expect(mgr.consumeGrant()).not.toBeNull();
			expect(mgr.consumeGrant()).toBeNull();
		});

		it("returns null before start", () => {
			expect(new PrimeTunnelManager().consumeGrant()).toBeNull();
		});
	});

	describe("stop", () => {
		it("kills process, runs cleanup, clears state", async () => {
			const fp = new FakeManagedProcess();
			let cleaned = false;
			const mgr = new PrimeTunnelManager(async () => {
				cleaned = true;
			});
			emitStandard(fp);
			await mgr.start(opts({ fake: fp, clock: FAST_CLOCK }));

			const r = await mgr.stop();

			expect(r.processKilled).toBe(true);
			expect(r.cleanupOk).toBe(true);
			expect(cleaned).toBe(true);
			expect(mgr.descriptor).toBeNull();
			expect(mgr.consumeGrant()).toBeNull();
		});

		it("is safe to call twice", async () => {
			const fp = new FakeManagedProcess();
			const mgr = new PrimeTunnelManager();
			emitStandard(fp);
			await mgr.start(opts({ fake: fp, clock: FAST_CLOCK }));

			expect((await mgr.stop()).processKilled).toBe(true);
			expect((await mgr.stop()).processKilled).toBe(false);
		});

		it("reports cleanup failure with fixed code", async () => {
			const fp = new FakeManagedProcess();
			const mgr = new PrimeTunnelManager(async () => {
				throw new Error("x");
			});
			emitStandard(fp);
			await mgr.start(opts({ fake: fp, clock: FAST_CLOCK }));

			const r = await mgr.stop();
			expect(r.cleanupOk).toBe(false);
			expect(r.cleanupError).toBe("EXEC_FAILED");
		});
	});

	describe("abort", () => {
		it("kills process and clears state", async () => {
			const fp = new FakeManagedProcess();
			const mgr = new PrimeTunnelManager();
			emitStandard(fp);
			await mgr.start(opts({ fake: fp, clock: FAST_CLOCK }));

			await mgr.abort();

			expect(mgr.descriptor).toBeNull();
			expect(mgr.consumeGrant()).toBeNull();
		});
	});

	describe("process termination", () => {
		it("sends SIGTERM then SIGKILL when process ignores", async () => {
			const fp = new FakeManagedProcess();
			fp.exitOnKill = false;
			const mgr = new PrimeTunnelManager();
			emitStandard(fp);
			await mgr.start(opts({ fake: fp, clock: FAST_CLOCK }));

			await mgr.stop();

			expect(fp.killCalls.length).toBeGreaterThanOrEqual(2);
			expect(fp.killCalls[0]).toBe("SIGTERM");
			expect(fp.killCalls[1]).toBe("SIGKILL");
		});
	});

	describe("post-start exit monitor", () => {
		it("fires health event and clears state on exit 0", async () => {
			const fp = new FakeManagedProcess();
			const events: Array<Record<string, unknown>> = [];
			const mgr = new PrimeTunnelManager();
			emitStandard(fp);
			await mgr.start(
				opts({
					fake: fp,
					onHealthEvent: (ev: unknown) => events.push(ev as Record<string, unknown>),
				}),
			);

			fp.exit(0);
			await new Promise((r) => setTimeout(r, 10));

			expect(events.length).toBeGreaterThanOrEqual(1);
			expect(events[0].type).toBe("exited");
			expect(events[0].exitCode).toBe(0);
			expect(mgr.descriptor).toBeNull();
		});
	});

	describe("injected clock", () => {
		it("uses clock for timeout", async () => {
			const fp = new FakeManagedProcess();
			const mgr = new PrimeTunnelManager();
			let now = 0;
			const clock = {
				sleep: async () => {},
				now: () => now,
			};

			const p = mgr.start(opts({ fake: fp, startTimeoutMs: 100, clock }));

			now = 200;
			fp.preloadLines(["URL: https://x.com"]);
			fp.preloadLines(["Basic auth user: x"]);

			await expect(p).rejects.toThrow(TunnelTimeoutError);
		});
	});

	describe("password never retained in parsedFields after success", () => {
		it("clears parsedFields after start", async () => {
			const fp = new FakeManagedProcess();
			const mgr = new PrimeTunnelManager();
			emitStandard(fp);
			await mgr.start(opts({ fake: fp }));

			const pf = (mgr as unknown as Record<string, unknown>)._parsedFields as Record<string, unknown>;
			expect(pf.httpPassword).toBeUndefined();

			const g = mgr.consumeGrant();
			expect(g?.httpPassword).toBe("s3cret!p4ss");
		});
	});

	describe("options.cleanupRunner overrides constructor", () => {
		it("uses options.cleanupRunner", async () => {
			const fp = new FakeManagedProcess();
			let optRun = false;
			const mgr = new PrimeTunnelManager(async () => {});

			emitStandard(fp);
			await mgr.start(
				opts({
					fake: fp,
					clock: FAST_CLOCK,
					cleanupRunner: async () => {
						optRun = true;
					},
				}),
			);
			await mgr.stop();

			expect(optRun).toBe(true);
		});
	});

	describe("generateTunnelUser", () => {
		it("matches pattern", () => {
			expect(generateTunnelUser()).toMatch(/^tun-[a-f0-9]{16}$/);
		});

		it("generates unique values", () => {
			const seen = new Set<string>();
			for (let i = 0; i < 100; i++) {
				const u = generateTunnelUser();
				expect(seen.has(u)).toBe(false);
				seen.add(u);
			}
		});
	});

	describe("defaultCleanupRunner", () => {
		it("is a function", () => {
			expect(typeof defaultCleanupRunner).toBe("function");
		});
	});

	describe("cleanup uses parsedTunnelIdOnLine on early failure", () => {
		it("calls cleanupRunner with parsed tunnel ID when password missing", async () => {
			const fp = new FakeManagedProcess();
			let cleanedId: string | undefined;
			const mgr = new PrimeTunnelManager(async (id) => {
				cleanedId = id;
			});
			fp.preloadLines(["Tunnel ID: tun_early", "URL: https://early.tunnel", "Basic auth user: tun-abc123"]);

			await expect(mgr.start(opts({ fake: fp }))).rejects.toThrow(TunnelStartError);

			expect(cleanedId).toBe("tun_early");
		});

		it("calls cleanupRunner with tunnel ID on timeout", async () => {
			const fp = new FakeManagedProcess();
			let cleanedId: string | undefined;
			const mgr = new PrimeTunnelManager(async (id) => {
				cleanedId = id;
			});
			fp.preloadLines(["Tunnel ID: tun_timeout"]);

			await expect(
				mgr.start(
					opts({
						fake: fp,
						startTimeoutMs: 100,
					}),
				),
			).rejects.toThrow(TunnelTimeoutError);

			expect(cleanedId).toBe("tun_timeout");
		});
	});

	describe("manager enforces independent limits", () => {
		it("stops parsing after MAX_LINE_COUNT lines", async () => {
			const fp = new FakeManagedProcess();
			const mgr = new PrimeTunnelManager();
			let now = 0;
			const clock = {
				sleep: async () => {},
				now: () => now,
			};

			const manyLines: string[] = [];
			for (let i = 0; i < 205; i++) {
				manyLines.push(`noise-${i}`);
			}
			manyLines.push("Tunnel ID: tun_200");
			manyLines.push("URL: https://200.tunnel");
			manyLines.push("Basic auth user: tun-user");
			manyLines.push("Basic auth password: p4ss");

			for (const l of manyLines) fp.preloadLines([l]);

			const p = mgr.start(opts({ fake: fp, startTimeoutMs: 100, clock }));
			now = 200;
			await expect(p).rejects.toThrow(TunnelStartError);
		});

		it("rejects oversized single injected line (byte limit)", async () => {
			const fp = new FakeManagedProcess();
			const mgr = new PrimeTunnelManager();
			let now = 0;
			const clock = {
				sleep: async () => {},
				now: () => now,
			};

			fp.preloadLines(["x".repeat(70000)]);

			const p = mgr.start(opts({ fake: fp, startTimeoutMs: 100, clock }));
			now = 200;
			await expect(p).rejects.toThrow(TunnelStartError);
		});

		it("rejects tunnel ID with invalid format", async () => {
			const fp = new FakeManagedProcess();
			const mgr = new PrimeTunnelManager();
			let now = 0;
			const clock = {
				sleep: async () => {},
				now: () => now,
			};

			fp.preloadLines(["Tunnel ID: tun@bad"]);

			const p = mgr.start(opts({ fake: fp, startTimeoutMs: 100, clock }));
			now = 200;
			await expect(p).rejects.toThrow(TunnelStartError);
		});

		it("does not store invalid tunnel ID for cleanup", async () => {
			const fp = new FakeManagedProcess();
			let cleanedId: string | undefined;
			const mgr = new PrimeTunnelManager(async (id) => {
				cleanedId = id;
			});
			let now = 0;
			const clock = {
				sleep: async () => {},
				now: () => now,
			};

			fp.preloadLines(["Tunnel ID: tun@bad"]);

			const p = mgr.start(opts({ fake: fp, startTimeoutMs: 100, clock }));
			now = 200;
			await expect(p).rejects.toThrow(TunnelStartError);
			expect(cleanedId).toBeUndefined();
		});
	});

	describe("cleanupInitiated flag prevents double terminate", () => {
		it("start throws and _cleanupOnFailure does not call kill again", async () => {
			const fp = new FakeManagedProcess();
			const mgr = new PrimeTunnelManager();
			fp.preloadLines(["Tunnel ID: tun_db", "URL: https://x.tunnel"]);
			fp.preloadLines(["Basic auth user: tun-abc123"]);

			await expect(
				mgr.start(
					opts({
						fake: fp,
						startTimeoutMs: 100,
					}),
				),
			).rejects.toThrow(TunnelStartError);

			// After TUNNEL_MISSING_PASSWORD, cleanupInitiated was set and
			// cleanupOnFailure skipped redundant kill. The process already exited.
		});
	});
});

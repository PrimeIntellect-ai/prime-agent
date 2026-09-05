import { chmod, mkdtemp, readdir, readFile, realpath, rm, stat, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
	type IoHandle,
	type IoStats,
	JOURNAL_RECORD_SUFFIX,
	type JournalIo,
	publishImmutableJournalRecord,
	RealJournalIo,
} from "../src/modes/daemon/immutable-journal-publisher.js";

// ---------------------------------------------------------------------------
// Tracking IO with failure injection, handle close accounting, buffer seam
// ---------------------------------------------------------------------------

type OpName = "lstat" | "realpath" | "open" | "fh.fstat" | "fh.read" | "fh.write" | "fh.fsync" | "fh.close";

interface OpRecord {
	op: OpName;
	args: string;
	ok: boolean;
}

let allocRecords: { buffer: Uint8Array; size: number }[] = [];

class TrackingIo implements JournalIo {
	private readonly real = new RealJournalIo();
	private failMap = new Map<OpName, number>();
	private failHandleOps = new Map<number, Set<OpName>>();
	private recordsInner: OpRecord[] = [];
	private handleSeq = 0;
	private closeCountsInner = new Map<number, number>();
	private allocsInner = allocRecords;
	private writePosInner: (number | null)[] = [];
	badWriteCount = false;
	badReadCount = false;
	badStats = false;
	corruptNextRdonly = -1;
	openCreatesThenThrows = false;
	hostileFinalFstat = false;
	hostileReopenRead = false;
	hostileDirFsync = false;
	badStatsShape: "extra" | "accessor" | "symbol" | null = null;
	initialNonZeroSize = false;
	openFailAt = -1;
	private openCount = 0;

	constructor() {
		allocRecords = this.allocsInner;
	}

	get records(): readonly OpRecord[] {
		return this.recordsInner;
	}

	get allocatedBuffers(): readonly Uint8Array[] {
		return this.allocsInner.map((r) => r.buffer);
	}

	get writePositions(): readonly (number | null)[] {
		return this.writePosInner;
	}

	closeCountFor(handleId: number): number {
		return this.closeCountsInner.get(handleId) ?? 0;
	}

	allocateBuffer(size: number): Uint8Array {
		const buf = this.real.allocateBuffer(size);
		this.allocsInner.push({ buffer: buf, size });
		return buf;
	}

	failNext(op: OpName, times = 1): void {
		this.failMap.set(op, times);
	}

	failHandle(op: OpName, handleId: number): void {
		let s = this.failHandleOps.get(handleId);
		if (s === undefined) {
			s = new Set();
			this.failHandleOps.set(handleId, s);
		}
		s.add(op);
	}

	private makeHostile(h: IoHandle, seq: number, kind: "fstat" | "read" | "fsync", path: string): IoHandle {
		this.recordsInner.push({ op: "open", args: path, ok: true });
		const base: Record<string, unknown> = {
			read: (buf: Uint8Array, off: number, len: number, pos: number) => h.read(buf, off, len, pos),
			write: (buf: Uint8Array, off: number, len: number, pos: number | null) => h.write(buf, off, len, pos),
			fsync: () => h.fsync(),
			close: async () => {
				this.closeCountsInner.set(seq, (this.closeCountsInner.get(seq) ?? 0) + 1);
				await h.close();
				this.recordsInner.push({ op: "fh.close", args: `h${seq}`, ok: true });
			},
		};
		Object.defineProperty(base, kind, {
			enumerable: true,
			configurable: true,
			get() {
				throw new Error(`hostile:${kind}`);
			},
		});
		return base as unknown as IoHandle;
	}

	private async handleOp<T>(op: OpName, args: string, fn: () => Promise<T>): Promise<T> {
		const remaining = this.failMap.get(op);
		if (remaining !== undefined && remaining > 0) {
			if (remaining <= 1) this.failMap.delete(op);
			else this.failMap.set(op, remaining - 1);
			this.recordsInner.push({ op, args, ok: false });
			throw new Error(`injected:${op}`);
		}
		try {
			const result = await fn();
			this.recordsInner.push({ op, args, ok: true });
			return result;
		} catch (e: unknown) {
			this.recordsInner.push({ op, args, ok: false });
			throw e;
		}
	}

	async lstat(path: string): Promise<IoStats> {
		return this.handleOp("lstat", path, async () => {
			if (this.badStats) {
				return {
					dev: Number.NaN,
					ino: 1,
					mode: 0o700,
					nlink: 1,
					uid: 0,
					size: 0,
					isFile: false,
					isDirectory: true,
				};
			}
			const st = await this.real.lstat(path);
			if (this.badStatsShape === "extra") {
				return { ...st, extra: 1 } as unknown as IoStats;
			}
			if (this.badStatsShape === "accessor") {
				const o: Record<string, unknown> = { ...st };
				Object.defineProperty(o, "size", {
					enumerable: true,
					get() {
						return 0;
					},
				});
				return o as unknown as IoStats;
			}
			if (this.badStatsShape === "symbol") {
				const o: Record<string, unknown> = { ...st };
				(o as Record<symbol, unknown>)[Symbol("x")] = 1;
				return o as unknown as IoStats;
			}
			return st;
		});
	}

	async realpath(path: string): Promise<string> {
		return this.handleOp("realpath", path, () => this.real.realpath(path));
	}

	async open(path: string, flags: number, mode?: number): Promise<IoHandle> {
		this.openCount++;
		const remaining = this.failMap.get("open");
		if ((remaining !== undefined && remaining > 0) || this.openFailAt === this.openCount) {
			if (remaining !== undefined) {
				if (remaining <= 1) this.failMap.delete("open");
				else this.failMap.set("open", remaining - 1);
			}
			this.recordsInner.push({ op: "open", args: path, ok: false });
			throw new Error("injected:open");
		}
		const realHandle = await this.real.open(path, flags, mode);
		if (this.openCreatesThenThrows) {
			this.openCreatesThenThrows = false;
			await realHandle.close();
			this.recordsInner.push({ op: "open", args: path, ok: false });
			throw new Error("injected:open-after-create");
		}
		const seq = ++this.handleSeq;

		if (this.hostileFinalFstat && flags & 512) {
			this.hostileFinalFstat = false;
			return this.makeHostile(realHandle, seq, "fstat", path);
		}
		if (this.hostileReopenRead && !(flags & 512) && !(flags & 1048576)) {
			this.hostileReopenRead = false;
			return this.makeHostile(realHandle, seq, "read", path);
		}
		if (this.hostileDirFsync && flags & 1048576) {
			this.hostileDirFsync = false;
			return this.makeHostile(realHandle, seq, "fsync", path);
		}

		const wrapped: IoHandle = {
			fstat: () => {
				const hfail = this.failHandleOps.get(seq)?.has("fh.fstat") ?? false;
				if (hfail) {
					this.recordsInner.push({ op: "fh.fstat", args: `h${seq}`, ok: false });
					throw new Error("injected:fh.fstat");
				}
				return this.handleOp("fh.fstat", `h${seq}`, async () => {
					const st = await realHandle.fstat();
					if (this.initialNonZeroSize && flags & 512) {
						this.initialNonZeroSize = false;
						return { ...st, size: 7 } as IoStats;
					}
					if (this.corruptNextRdonly >= 0 && !(flags & 3) && !(flags & 1048576) && !(flags & 512)) {
						this.corruptNextRdonly--;
						if (this.corruptNextRdonly === 0) {
							this.corruptNextRdonly = -1;
							return { ...st, ino: st.ino + 1 } as IoStats;
						}
					}
					return st;
				});
			},
			read: (buf: Uint8Array, off: number, len: number, pos: number) => {
				const hfail = this.failHandleOps.get(seq)?.has("fh.read") ?? false;
				if (hfail) {
					this.recordsInner.push({ op: "fh.read", args: `h${seq}`, ok: false });
					throw new Error("injected:fh.read");
				}
				return this.handleOp("fh.read", `h${seq}`, async () => {
					if (this.badReadCount) return 0;
					return realHandle.read(buf, off, len, pos);
				});
			},
			write: (buf: Uint8Array, off: number, len: number, pos: number | null) => {
				const hfail = this.failHandleOps.get(seq)?.has("fh.write") ?? false;
				if (hfail) {
					this.recordsInner.push({ op: "fh.write", args: `h${seq}`, ok: false });
					throw new Error("injected:fh.write");
				}
				this.writePosInner.push(pos);
				return this.handleOp("fh.write", `h${seq}`, async () => {
					if (this.badWriteCount) return 0;
					return realHandle.write(buf, off, len, pos);
				});
			},
			fsync: () => {
				const hfail = this.failHandleOps.get(seq)?.has("fh.fsync") ?? false;
				if (hfail) {
					this.recordsInner.push({ op: "fh.fsync", args: `h${seq}`, ok: false });
					throw new Error("injected:fh.fsync");
				}
				return this.handleOp("fh.fsync", `h${seq}`, () => realHandle.fsync());
			},
			close: async () => {
				this.closeCountsInner.set(seq, (this.closeCountsInner.get(seq) ?? 0) + 1);
				await realHandle.close();
				const hfail = this.failHandleOps.get(seq)?.has("fh.close") ?? false;
				const gfail = this.failMap.get("fh.close");
				const shouldFail = hfail || (gfail !== undefined && gfail > 0);
				if (gfail !== undefined) {
					if (gfail <= 1) this.failMap.delete("fh.close");
					else this.failMap.set("fh.close", gfail - 1);
				}
				if (shouldFail) {
					this.recordsInner.push({ op: "fh.close", args: `h${seq}`, ok: false });
					throw new Error("injected:fh.close");
				}
				this.recordsInner.push({ op: "fh.close", args: `h${seq}`, ok: true });
			},
		};
		this.recordsInner.push({ op: "open", args: path, ok: true });
		return wrapped;
	}
}

// ---------------------------------------------------------------------------
// Test helpers (all async, using node:fs/promises)
// ---------------------------------------------------------------------------

async function tempDir(): Promise<string> {
	const d = await mkdtemp(join(tmpdir(), "ijp-test-"));
	await chmod(d, 0o700);
	return await realpath(d);
}

async function cleanDir(d: string): Promise<void> {
	await rm(d, { recursive: true, force: true });
}

async function writeFileString(path: string, content: string): Promise<void> {
	await writeFile(path, content, "utf8");
}

async function fileContent(path: string): Promise<string> {
	return await readFile(path, "utf8");
}

async function dirEntries(d: string): Promise<string[]> {
	return await readdir(d);
}

function allZero(buf: Uint8Array): boolean {
	for (let i = 0; i < buf.length; i++) {
		if (buf[i] !== 0) return false;
	}
	return true;
}

function detached16(): Uint8Array {
	const ab = new ArrayBuffer(16);
	const view = new Uint8Array(ab);
	structuredClone(ab, { transfer: [ab] });
	return view;
}

function finalName(seq: number): string {
	return `${String(seq).padStart(20, "0")}${JOURNAL_RECORD_SUFFIX}`;
}

function _uidOf(): number {
	return process.getuid?.() ?? -1;
}

function zeroCaller(buf: Uint8Array): void {
	for (let i = 0; i < buf.length; i++) expect(buf[i]).toBe(0);
}

async function entryExists(d: string, name: string): Promise<boolean> {
	const entries = await readdir(d);
	return entries.includes(name);
}

async function _pathStat(path: string) {
	return await stat(path);
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("publishImmutableJournalRecord (direct-final)", () => {
	const realIo = new RealJournalIo();

	// ---- Filename contract ----
	describe("filename", () => {
		it("aligns to the versioned scanner layout", () => {
			expect(JOURNAL_RECORD_SUFFIX).toBe(".b03-journal");
			expect(finalName(42)).toBe("00000000000000000042.b03-journal");
			expect(finalName(20000)).toBe("00000000000000020000.b03-journal");
		});
	});

	// ---- INVALID_ARGUMENT ----
	describe("INVALID_ARGUMENT", () => {
		it("rejects null options", async () => {
			const r = await publishImmutableJournalRecord(null as never);
			expect(r).toEqual({ status: "INVALID_ARGUMENT" });
		});

		it("rejects options carrying the removed randomBytes key", async () => {
			const r = await publishImmutableJournalRecord({
				journalDir: "/tmp",
				seq: 1,
				bytes: new Uint8Array([1]),
				randomBytes: async () => new Uint8Array(16),
			} as never);
			expect(r).toEqual({ status: "INVALID_ARGUMENT" });
		});

		it("rejects options with extra, symbol, or non-enumerable keys", async () => {
			const base = { journalDir: "/tmp", seq: 1, bytes: new Uint8Array([1]) };
			const r1 = await publishImmutableJournalRecord({ ...base, extra: true } as never);
			expect(r1).toEqual({ status: "INVALID_ARGUMENT" });

			const withSym: Record<symbol, unknown> = { ...base };
			withSym[Symbol("x")] = 1;
			const r2 = await publishImmutableJournalRecord(withSym as never);
			expect(r2).toEqual({ status: "INVALID_ARGUMENT" });

			const withHidden: Record<string, unknown> = { ...base };
			Object.defineProperty(withHidden, "hidden", { value: 1, enumerable: false });
			const r3 = await publishImmutableJournalRecord(withHidden as never);
			expect(r3).toEqual({ status: "INVALID_ARGUMENT" });
		});

		it("never invokes getters on options (getter-count zero)", async () => {
			let gets = 0;
			const opts = {
				journalDir: "/tmp",
				seq: 1,
				bytes: new Uint8Array([1]),
			};
			Object.defineProperty(opts, "journalDir", {
				enumerable: true,
				get() {
					gets++;
					return "/tmp";
				},
			});
			const r = await publishImmutableJournalRecord(opts as never);
			expect(r).toEqual({ status: "INVALID_ARGUMENT" });
			expect(gets).toBe(0);
		});

		it("rejects Proxy options without own journalDir", async () => {
			const target = { seq: 1, bytes: new Uint8Array([1]) };
			const proxy = new Proxy(target, {
				get(t, p) {
					return p === "journalDir" ? "/tmp" : (t as Record<string, unknown>)[p as string];
				},
				has(t, p) {
					return p === "journalDir" ? false : p in (t as object);
				},
			});
			const r = await publishImmutableJournalRecord(proxy as never);
			expect(r).toEqual({ status: "INVALID_ARGUMENT" });
		});

		it("rejects non-string journalDir", async () => {
			const r = await publishImmutableJournalRecord({
				journalDir: 123 as never,
				seq: 1,
				bytes: new Uint8Array([1]),
			});
			expect(r).toEqual({ status: "INVALID_ARGUMENT" });
		});

		it("rejects empty and relative journalDir", async () => {
			for (const dir of ["", "relative/path"]) {
				const r = await publishImmutableJournalRecord({ journalDir: dir, seq: 1, bytes: new Uint8Array([1]) });
				expect(r).toEqual({ status: "INVALID_ARGUMENT" });
			}
		});

		it("rejects non-integer seq and out-of-range seq", async () => {
			for (const s of [1.5, 0, -1, 20001]) {
				const r = await publishImmutableJournalRecord({
					journalDir: "/tmp",
					seq: s,
					bytes: new Uint8Array([1]),
				});
				expect(r).toEqual({ status: "INVALID_ARGUMENT" });
			}
		});

		it("rejects Buffer, subclass, SAB, subview, detached, empty, oversized bytes", async () => {
			class MyU8 extends Uint8Array {}
			const sab = new SharedArrayBuffer(10);
			const big = new Uint8Array(32);
			const cases: unknown[] = [
				Buffer.from([1]),
				new MyU8([1]),
				new Uint8Array(sab),
				big.subarray(0, 4),
				detached16(),
				new Uint8Array(0),
				new Uint8Array(1_310_721),
			];
			for (const b of cases) {
				const r = await publishImmutableJournalRecord({
					journalDir: "/tmp",
					seq: 1,
					bytes: b as never,
				});
				expect(r).toEqual({ status: "INVALID_ARGUMENT" });
			}
		});

		it("erases caller bytes even when path/seq invalid", async () => {
			const bytes = new Uint8Array([1, 2, 3]);
			await publishImmutableJournalRecord({ journalDir: "/tmp", seq: 20001, bytes });
			zeroCaller(bytes);
		});

		it("rejects journalDir with wrong mode or setgid", async () => {
			for (const mode of [0o755, 0o2700]) {
				const d = await tempDir();
				await chmod(d, mode);
				const r = await publishImmutableJournalRecord({ journalDir: d, seq: 1, bytes: new Uint8Array([1]) });
				await cleanDir(d);
				expect(r).toEqual({ status: "INVALID_ARGUMENT" });
			}
		});

		it("rejects journalDir that is a symlink", async () => {
			const d = await tempDir();
			const linkDir = join(tmpdir(), `ijp-symlink-${Math.random().toString(36).slice(2)}`);
			try {
				await symlink(d, linkDir);
				const r = await publishImmutableJournalRecord({ journalDir: linkDir, seq: 1, bytes: new Uint8Array([1]) });
				expect(r).toEqual({ status: "INVALID_ARGUMENT" });
			} finally {
				try {
					await rm(linkDir);
				} catch {
					/* ignore */
				}
				await cleanDir(d);
			}
		});

		it("rejects non-canonical journalDir", async () => {
			const d = await mkdtemp(join(tmpdir(), "ijp-nc-"));
			await chmod(d, 0o700);
			try {
				const r = await publishImmutableJournalRecord({ journalDir: d, seq: 1, bytes: new Uint8Array([1]) });
				expect(r).toEqual({ status: "INVALID_ARGUMENT" });
			} finally {
				await cleanDir(d);
			}
		});

		it("rejects null io and io missing methods", async () => {
			const incomplete = {
				lstat: realIo.lstat,
				realpath: realIo.realpath,
				open: realIo.open,
			};
			for (const io of [null, incomplete] as never[]) {
				const r = await publishImmutableJournalRecord(
					{ journalDir: "/tmp", seq: 1, bytes: new Uint8Array([1]) },
					io,
				);
				expect(r).toEqual({ status: "INVALID_ARGUMENT" });
			}
		});

		it("rejects io whose allocateBuffer getter throws", async () => {
			const hostile = {
				get allocateBuffer() {
					throw new Error("getter");
				},
				lstat: realIo.lstat,
				realpath: realIo.realpath,
				open: realIo.open,
			};
			const r = await publishImmutableJournalRecord(
				{ journalDir: "/tmp", seq: 1, bytes: new Uint8Array([1]) },
				hostile as never,
			);
			expect(r).toEqual({ status: "INVALID_ARGUMENT" });
		});

		it("erases caller bytes when io snapshot fails", async () => {
			const hostile = {
				get allocateBuffer() {
					throw new Error("getter");
				},
				lstat: realIo.lstat,
				realpath: realIo.realpath,
				open: realIo.open,
			};
			const bytes = new Uint8Array([7, 8, 9]);
			const r = await publishImmutableJournalRecord({ journalDir: "/tmp", seq: 1, bytes }, hostile as never);
			expect(r).toEqual({ status: "INVALID_ARGUMENT" });
			zeroCaller(bytes);
		});

		it("erases caller bytes when options snapshot fails", async () => {
			const bytes = new Uint8Array([7, 8, 9]);
			const r = await publishImmutableJournalRecord({
				journalDir: "/tmp",
				seq: 1,
				bytes,
				extra: true,
			} as never);
			expect(r).toEqual({ status: "INVALID_ARGUMENT" });
			zeroCaller(bytes);
		});

		it("rejects Proxy io whose getOwnPropertyDescriptor throws", async () => {
			const proxy = new Proxy(
				{},
				{
					getOwnPropertyDescriptor() {
						throw new Error("trap");
					},
				},
			);
			const r = await publishImmutableJournalRecord(
				{ journalDir: "/tmp", seq: 1, bytes: new Uint8Array([1]) },
				proxy as never,
			);
			expect(r).toEqual({ status: "INVALID_ARGUMENT" });
		});

		it("returns INVALID_ARGUMENT on malformed dir stats", async () => {
			const d = await tempDir();
			const io = new TrackingIo();
			io.badStats = true;
			const bytes = new Uint8Array([1]);
			const r = await publishImmutableJournalRecord({ journalDir: d, seq: 1, bytes }, io);
			expect(r).toEqual({ status: "INVALID_ARGUMENT" });
			zeroCaller(bytes);
			await cleanDir(d);
		});

		it("rejects stats DTO with an extra own key", async () => {
			const d = await tempDir();
			const io = new TrackingIo();
			io.badStatsShape = "extra";
			const bytes = new Uint8Array([1]);
			const r = await publishImmutableJournalRecord({ journalDir: d, seq: 1, bytes }, io);
			expect(r).toEqual({ status: "INVALID_ARGUMENT" });
			zeroCaller(bytes);
			await cleanDir(d);
		});

		it("rejects stats DTO with an accessor (getter) field", async () => {
			const d = await tempDir();
			const io = new TrackingIo();
			io.badStatsShape = "accessor";
			const bytes = new Uint8Array([1]);
			const r = await publishImmutableJournalRecord({ journalDir: d, seq: 1, bytes }, io);
			expect(r).toEqual({ status: "INVALID_ARGUMENT" });
			zeroCaller(bytes);
			await cleanDir(d);
		});

		it("rejects stats DTO with a symbol key", async () => {
			const d = await tempDir();
			const io = new TrackingIo();
			io.badStatsShape = "symbol";
			const bytes = new Uint8Array([1]);
			const r = await publishImmutableJournalRecord({ journalDir: d, seq: 1, bytes }, io);
			expect(r).toEqual({ status: "INVALID_ARGUMENT" });
			zeroCaller(bytes);
			await cleanDir(d);
		});

		it("rejects allocator that returns the caller buffer itself", async () => {
			const d = await tempDir();
			const io = new TrackingIo();
			const caller = new Uint8Array([1, 2, 3]);
			io.allocateBuffer = (size: number): Uint8Array => {
				if (size === caller.byteLength) return caller;
				return new Uint8Array(size);
			};
			const r = await publishImmutableJournalRecord({ journalDir: d, seq: 1, bytes: caller }, io);
			expect(r).toEqual({ status: "INVALID_ARGUMENT" });
			zeroCaller(caller);
			await cleanDir(d);
		});

		it("rejects allocator that shares caller backing for scratch", async () => {
			const d = await tempDir();
			const io = new TrackingIo();
			const caller = new Uint8Array(65_536);
			caller.fill(3);
			let ownedAlloc = false;
			io.allocateBuffer = (size: number): Uint8Array => {
				if (!ownedAlloc) {
					ownedAlloc = true;
					return new Uint8Array(size);
				}
				return new Uint8Array(caller.buffer);
			};
			const r = await publishImmutableJournalRecord({ journalDir: d, seq: 1, bytes: caller }, io);
			expect(r).toEqual({ status: "INVALID_ARGUMENT" });
			zeroCaller(caller);
			await cleanDir(d);
		});

		it("rejects journalDir containing a NUL byte", async () => {
			const bytes = new Uint8Array([1]);
			const r = await publishImmutableJournalRecord({
				journalDir: "/tmp/\0evil",
				seq: 1,
				bytes,
			});
			expect(r).toEqual({ status: "INVALID_ARGUMENT" });
			zeroCaller(bytes);
		});

		it("rejects overlong journalDir", async () => {
			const bytes = new Uint8Array([1]);
			const r = await publishImmutableJournalRecord({
				journalDir: `/${"a".repeat(5000)}`,
				seq: 1,
				bytes,
			});
			expect(r).toEqual({ status: "INVALID_ARGUMENT" });
			zeroCaller(bytes);
		});

		it("returns POST_PUBLICATION_UNCERTAIN on top-level throw after core entry", async () => {
			const d = await tempDir();
			const io = new TrackingIo();
			io.openFailAt = 2;
			const bytes = new Uint8Array([1]);
			const r = await publishImmutableJournalRecord({ journalDir: d, seq: 9, bytes }, io);
			expect(r.status).toBe("POST_PUBLICATION_UNCERTAIN");
			expect(await entryExists(d, finalName(9))).toBe(true);
			zeroCaller(bytes);
			await cleanDir(d);
		});

		it("returns INVALID_ARGUMENT when allocateBuffer throws or yields wrong/subclass buffer", async () => {
			class MyU8 extends Uint8Array {}
			const variants: ((size: number) => Uint8Array)[] = [
				() => {
					throw new Error("alloc");
				},
				(size) => new Uint8Array(size + 3),
				(size) => new MyU8(size),
			];
			for (const alloc of variants) {
				const d = await tempDir();
				const io = new TrackingIo();
				io.allocateBuffer = alloc;
				const bytes = new Uint8Array([1, 2, 3]);
				const r = await publishImmutableJournalRecord({ journalDir: d, seq: 1, bytes }, io);
				expect(r).toEqual({ status: "INVALID_ARGUMENT" });
				zeroCaller(bytes);
				await cleanDir(d);
			}
		});
	});

	// ---- Successful publication ----
	describe("successful publication", () => {
		it("publishes a record and returns frozen success", async () => {
			const d = await tempDir();
			const content = new Uint8Array([104, 101, 108, 108, 111]);
			const originalCopy = new Uint8Array(content);
			const io = new TrackingIo();

			const result = await publishImmutableJournalRecord({ journalDir: d, seq: 42, bytes: content }, io);

			expect(result.status).toBe("success");
			if (result.status === "success") {
				expect(result.seq).toBe(42);
				expect(result.size).toBe(5);
				expect(result.sha256).toBeDefined();
				expect(result.sha256.length).toBe(64);
			}

			zeroCaller(content);

			const finalPath = join(d, finalName(42));
			const st = await stat(finalPath);
			expect(st.isFile()).toBe(true);
			expect(st.mode & 0o777).toBe(0o600);
			expect(st.size).toBe(5);
			expect(st.nlink).toBe(1);

			const fileContent = await readFile(finalPath);
			expect(Array.from(fileContent)).toEqual(Array.from(originalCopy));

			expect(await dirEntries(d)).toHaveLength(1);

			for (const ab of io.allocatedBuffers) {
				expect(allZero(ab)).toBe(true);
			}
			await cleanDir(d);
		});

		it("writes with explicit positional offsets", async () => {
			const d = await tempDir();
			const size = 200_000;
			const content = new Uint8Array(size);
			for (let i = 0; i < size; i++) content[i] = i & 0xff;
			const io = new TrackingIo();

			const result = await publishImmutableJournalRecord({ journalDir: d, seq: 7, bytes: content }, io);
			expect(result.status).toBe("success");
			expect(io.writePositions).toEqual([0, 65_536, 131_072, 196_608]);
			await cleanDir(d);
		});

		it("closes every handle exactly once on success", async () => {
			const d = await tempDir();
			const io = new TrackingIo();
			const r = await publishImmutableJournalRecord({ journalDir: d, seq: 7, bytes: new Uint8Array([1]) }, io);
			expect(r.status).toBe("success");
			for (let h = 1; h <= 3; h++) {
				expect(io.closeCountFor(h)).toBe(1);
			}
			await cleanDir(d);
		});

		it("uses default io when not provided", async () => {
			const d = await tempDir();
			try {
				const result = await publishImmutableJournalRecord({ journalDir: d, seq: 1, bytes: new Uint8Array([1]) });
				expect(result.status).toBe("success");
				expect((await stat(join(d, finalName(1)))).isFile()).toBe(true);
			} finally {
				await cleanDir(d);
			}
		});

		it("publishes content at max size (1.25 MiB)", async () => {
			const d = await tempDir();
			const size = 1_310_720;
			const content = new Uint8Array(size);
			for (let i = 0; i < size; i++) content[i] = i & 0xff;

			const originalCopy = new Uint8Array(content);
			const result = await publishImmutableJournalRecord({ journalDir: d, seq: 20000, bytes: content });

			expect(result.status).toBe("success");
			if (result.status === "success") {
				expect(result.size).toBe(size);
				const finalPath = join(d, finalName(20000));
				const fileContent = await readFile(finalPath);
				expect(Buffer.from(fileContent).equals(Buffer.from(originalCopy))).toBe(true);
			}
			await cleanDir(d);
		});
	});

	// ---- Collision ----
	describe("SEQ_COLLISION", () => {
		it("returns SEQ_COLLISION when final already exists and preserves it", async () => {
			const d = await tempDir();
			const finalPath = join(d, finalName(1));
			await writeFileString(finalPath, "existing");

			const bytes = new Uint8Array([1]);
			const io = new TrackingIo();
			const result = await publishImmutableJournalRecord({ journalDir: d, seq: 1, bytes }, io);

			expect(result).toEqual({ status: "SEQ_COLLISION", seq: 1 });
			expect(await fileContent(finalPath)).toBe("existing");
			expect(await dirEntries(d)).toHaveLength(1);
			zeroCaller(bytes);
			for (const ab of io.allocatedBuffers) {
				expect(allZero(ab)).toBe(true);
			}
			await cleanDir(d);
		});
	});

	// ---- Open-time failure ----
	describe("open-time failure", () => {
		let d: string;
		let io: TrackingIo;

		beforeEach(async () => {
			d = await tempDir();
			io = new TrackingIo();
		});

		afterEach(async () => {
			await cleanDir(d);
		});

		it("returns POST_PUBLICATION_UNCERTAIN on non-EEXIST open error, evidence preserved", async () => {
			io.failNext("open");
			const bytes = new Uint8Array([1, 2, 3]);
			const result = await publishImmutableJournalRecord({ journalDir: d, seq: 42, bytes }, io);
			expect(result.status).toBe("POST_PUBLICATION_UNCERTAIN");
			if (result.status === "POST_PUBLICATION_UNCERTAIN") {
				const r = result as {
					status: "POST_PUBLICATION_UNCERTAIN";
					seq: number;
					size: number;
					sha256: string;
				};
				expect(r.seq).toBe(42);
				expect(r.size).toBe(3);
				expect(r.sha256.length).toBe(64);
			}
			expect(io.records.every((r) => !["unlink", "unlinkIfOwned", "link"].includes(r.op))).toBe(true);
			zeroCaller(bytes);
			for (const ab of io.allocatedBuffers) {
				expect(allZero(ab)).toBe(true);
			}
		});

		it("returns POST_PUBLICATION_UNCERTAIN when open creates then rejects", async () => {
			io.openCreatesThenThrows = true;
			const result = await publishImmutableJournalRecord({ journalDir: d, seq: 42, bytes: new Uint8Array([1]) }, io);
			expect(result.status).toBe("POST_PUBLICATION_UNCERTAIN");
			expect((await dirEntries(d)).length).toBeLessThanOrEqual(1);
			expect(io.records.every((r) => !["unlink", "unlinkIfOwned"].includes(r.op))).toBe(true);
		});

		it("returns POST_PUBLICATION_UNCERTAIN when final handle snapshot fails, close exactly once", async () => {
			io.hostileFinalFstat = true;
			const result = await publishImmutableJournalRecord({ journalDir: d, seq: 42, bytes: new Uint8Array([1]) }, io);
			expect(result.status).toBe("POST_PUBLICATION_UNCERTAIN");
			expect(await entryExists(d, finalName(42))).toBe(true);
			expect(io.closeCountFor(1)).toBe(1);
			expect(io.records.every((r) => !["unlink", "unlinkIfOwned"].includes(r.op))).toBe(true);
		});
	});

	// ---- Post-open fault injection ----
	describe("post-open fault injection", () => {
		let d: string;
		let io: TrackingIo;

		beforeEach(async () => {
			d = await tempDir();
			io = new TrackingIo();
		});

		afterEach(async () => {
			await cleanDir(d);
		});

		const expectUncertainWithFinal = async (result: { status: string }, seq: number): Promise<void> => {
			expect(result.status).toBe("POST_PUBLICATION_UNCERTAIN");
			if (result.status === "POST_PUBLICATION_UNCERTAIN") {
				const r = result as {
					status: "POST_PUBLICATION_UNCERTAIN";
					seq: number;
					size: number;
					sha256: string;
				};
				expect(r.seq).toBe(seq);
				expect(r.sha256.length).toBe(64);
			}
			expect(await entryExists(d, finalName(seq))).toBe(true);
			expect(io.records.every((r) => !["unlink", "unlinkIfOwned"].includes(r.op))).toBe(true);
		};

		it("initial nonzero size", async () => {
			io.initialNonZeroSize = true;
			const r = await publishImmutableJournalRecord({ journalDir: d, seq: 9, bytes: new Uint8Array([1]) }, io);
			await expectUncertainWithFinal(r, 9);
		});

		it("write failure", async () => {
			io.failNext("fh.write");
			const r = await publishImmutableJournalRecord({ journalDir: d, seq: 9, bytes: new Uint8Array([1, 2, 3]) }, io);
			await expectUncertainWithFinal(r, 9);
		});

		it("zero-byte write", async () => {
			io.badWriteCount = true;
			const r = await publishImmutableJournalRecord({ journalDir: d, seq: 9, bytes: new Uint8Array([1, 2, 3]) }, io);
			await expectUncertainWithFinal(r, 9);
		});

		it("write returning more than requested", async () => {
			const real = io;
			const origOpen = real.open.bind(real);
			let corrupted = false;
			real.open = async (path: string, flags: number, mode?: number): Promise<IoHandle> => {
				const h = await origOpen(path, flags, mode);
				if (!corrupted && flags & 512) {
					corrupted = true;
					return {
						fstat: h.fstat,
						read: h.read,
						write: async () => 999_999,
						fsync: h.fsync,
						close: h.close,
					};
				}
				return h;
			};
			const r = await publishImmutableJournalRecord(
				{ journalDir: d, seq: 9, bytes: new Uint8Array([1, 2, 3]) },
				real,
			);
			await expectUncertainWithFinal(r, 9);
		});

		it("file fsync failure", async () => {
			io.failNext("fh.fsync");
			const r = await publishImmutableJournalRecord({ journalDir: d, seq: 9, bytes: new Uint8Array([1]) }, io);
			await expectUncertainWithFinal(r, 9);
		});

		it("write-handle close failure", async () => {
			io.failHandle("fh.close", 1);
			const r = await publishImmutableJournalRecord({ journalDir: d, seq: 9, bytes: new Uint8Array([1]) }, io);
			await expectUncertainWithFinal(r, 9);
		});

		it("reopen open failure", async () => {
			io.openFailAt = 2;
			const r = await publishImmutableJournalRecord({ journalDir: d, seq: 9, bytes: new Uint8Array([1]) }, io);
			await expectUncertainWithFinal(r, 9);
		});

		it("reopen handle snapshot failure closes exactly once", async () => {
			io.hostileReopenRead = true;
			const r = await publishImmutableJournalRecord({ journalDir: d, seq: 9, bytes: new Uint8Array([1]) }, io);
			await expectUncertainWithFinal(r, 9);
			expect(io.closeCountFor(2)).toBe(1);
		});

		it("dir fsync handle snapshot failure closes exactly once", async () => {
			io.hostileDirFsync = true;
			const r = await publishImmutableJournalRecord({ journalDir: d, seq: 9, bytes: new Uint8Array([1]) }, io);
			await expectUncertainWithFinal(r, 9);
			expect(io.closeCountFor(3)).toBe(1);
		});

		it("reopen fstat failure", async () => {
			io.failHandle("fh.fstat", 2);
			const r = await publishImmutableJournalRecord({ journalDir: d, seq: 9, bytes: new Uint8Array([1]) }, io);
			await expectUncertainWithFinal(r, 9);
		});

		it("reopen inode mismatch", async () => {
			io.corruptNextRdonly = 1;
			const r = await publishImmutableJournalRecord({ journalDir: d, seq: 9, bytes: new Uint8Array([1]) }, io);
			await expectUncertainWithFinal(r, 9);
		});

		it("reopen read failure", async () => {
			io.failNext("fh.read");
			const r = await publishImmutableJournalRecord({ journalDir: d, seq: 9, bytes: new Uint8Array([1, 2, 3]) }, io);
			await expectUncertainWithFinal(r, 9);
		});

		it("zero-byte read", async () => {
			io.badReadCount = true;
			const r = await publishImmutableJournalRecord({ journalDir: d, seq: 9, bytes: new Uint8Array([1, 2, 3]) }, io);
			await expectUncertainWithFinal(r, 9);
		});

		it("reopen close failure", async () => {
			io.failHandle("fh.close", 2);
			const r = await publishImmutableJournalRecord({ journalDir: d, seq: 9, bytes: new Uint8Array([1]) }, io);
			await expectUncertainWithFinal(r, 9);
		});

		it("dir fsync open failure", async () => {
			io.openFailAt = 3;
			const r = await publishImmutableJournalRecord({ journalDir: d, seq: 9, bytes: new Uint8Array([1]) }, io);
			await expectUncertainWithFinal(r, 9);
		});

		it("dir fsync failure", async () => {
			io.failHandle("fh.fsync", 3);
			const r = await publishImmutableJournalRecord({ journalDir: d, seq: 9, bytes: new Uint8Array([1]) }, io);
			await expectUncertainWithFinal(r, 9);
		});

		it("dir fsync close failure", async () => {
			io.failHandle("fh.close", 3);
			const r = await publishImmutableJournalRecord({ journalDir: d, seq: 9, bytes: new Uint8Array([1]) }, io);
			await expectUncertainWithFinal(r, 9);
		});

		it("every post-open fault keeps caller bytes erased and internal buffers zeroed", async () => {
			io.failNext("fh.write");
			const bytes = new Uint8Array([5, 6, 7, 8]);
			const r = await publishImmutableJournalRecord({ journalDir: d, seq: 11, bytes }, io);
			await expectUncertainWithFinal(r, 11);
			zeroCaller(bytes);
			for (const ab of io.allocatedBuffers) {
				expect(allZero(ab)).toBe(true);
			}
		});
	});

	// ---- Operation trace ----
	describe("operation trace", () => {
		it("records exact operation sequence on success", async () => {
			const d = await tempDir();
			const io = new TrackingIo();
			const result = await publishImmutableJournalRecord({ journalDir: d, seq: 7, bytes: new Uint8Array([1]) }, io);
			expect(result.status).toBe("success");

			const ops = io.records.map((r) => r.op);
			expect(ops[ops.length - 1]).toBe("fh.close");
			const closes = ops.filter((o) => o === "fh.close").length;
			expect(closes).toBe(3);
			await cleanDir(d);
		});

		it("trace shows no success before final dir close", async () => {
			const d = await tempDir();
			const io = new TrackingIo();
			const result = await publishImmutableJournalRecord({ journalDir: d, seq: 3, bytes: new Uint8Array([1]) }, io);
			expect(result.status).toBe("success");
			const ops = io.records.map((r) => r.op);
			const closeIndices = ops.map((o, i) => (o === "fh.close" ? i : -1)).filter((i) => i >= 0);
			expect(closeIndices.length).toBe(3);
			await cleanDir(d);
		});

		it("trace proves no unlink/link operations on collision", async () => {
			const d = await tempDir();
			await writeFileString(join(d, finalName(5)), "occupied");
			const io = new TrackingIo();
			const result = await publishImmutableJournalRecord({ journalDir: d, seq: 5, bytes: new Uint8Array([1]) }, io);
			expect(result).toEqual({ status: "SEQ_COLLISION", seq: 5 });
			expect(io.records.every((r) => !["unlink", "unlinkIfOwned", "link"].includes(r.op))).toBe(true);
			await cleanDir(d);
		});

		it("trace proves final evidence preserved on post-open fault", async () => {
			const d = await tempDir();
			const io = new TrackingIo();
			io.failNext("fh.read");
			const result = await publishImmutableJournalRecord(
				{ journalDir: d, seq: 7, bytes: new Uint8Array([1, 2, 3]) },
				io,
			);
			expect(result.status).toBe("POST_PUBLICATION_UNCERTAIN");
			expect(await entryExists(d, finalName(7))).toBe(true);
			expect(io.records.every((r) => !["unlink", "unlinkIfOwned"].includes(r.op))).toBe(true);
			await cleanDir(d);
		});
	});

	// ---- Caller erase ----
	describe("caller erase", () => {
		it("erases caller bytes on success", async () => {
			const d = await tempDir();
			const bytes = new Uint8Array([1, 2, 3]);
			await publishImmutableJournalRecord({ journalDir: d, seq: 1, bytes });
			zeroCaller(bytes);
			await cleanDir(d);
		});

		it("erases caller bytes on INVALID_ARGUMENT (missing dir)", async () => {
			const bytes = new Uint8Array([1, 2, 3]);
			await publishImmutableJournalRecord({ journalDir: "/nonexistent", seq: 1, bytes });
			zeroCaller(bytes);
		});

		it("erases caller bytes on open failure", async () => {
			const d = await tempDir();
			const io = new TrackingIo();
			io.failNext("open");
			const bytes = new Uint8Array([1, 2, 3]);
			await publishImmutableJournalRecord({ journalDir: d, seq: 1, bytes }, io);
			zeroCaller(bytes);
			for (const ab of io.allocatedBuffers) {
				expect(allZero(ab)).toBe(true);
			}
			await cleanDir(d);
		});
	});

	// ---- Directory identity ----
	describe("directory identity", () => {
		it("captures and validates directory identity on success", async () => {
			const d = await tempDir();
			const result = await publishImmutableJournalRecord({ journalDir: d, seq: 5, bytes: new Uint8Array([1]) });
			expect(result.status).toBe("success");
			await cleanDir(d);
		});

		it("returns INVALID_ARGUMENT when initial dir lstat fails", async () => {
			const d = await tempDir();
			const io = new TrackingIo();
			io.failNext("lstat");
			const bytes = new Uint8Array([1, 2, 3]);
			const result = await publishImmutableJournalRecord({ journalDir: d, seq: 1, bytes }, io);
			expect(result.status).toBe("INVALID_ARGUMENT");
			zeroCaller(bytes);
			await cleanDir(d);
		});
	});

	// ---- Buffer erasure through allocation seam ----
	describe("buffer erasure through allocation seam", () => {
		it("every internal buffer is zeroed on success", async () => {
			const d = await tempDir();
			const io = new TrackingIo();
			const bytes = new Uint8Array([10, 20, 30, 40]);
			const result = await publishImmutableJournalRecord({ journalDir: d, seq: 10, bytes }, io);
			expect(result.status).toBe("success");
			for (const ab of io.allocatedBuffers) {
				expect(allZero(ab)).toBe(true);
			}
			await cleanDir(d);
		});

		it("every internal buffer is zeroed on INVALID_ARGUMENT", async () => {
			const io = new TrackingIo();
			const bytes = new Uint8Array([1, 2, 3]);
			const result = await publishImmutableJournalRecord({ journalDir: "/nonexistent", seq: 1, bytes }, io);
			expect(result.status).toBe("INVALID_ARGUMENT");
			for (const ab of io.allocatedBuffers) {
				expect(allZero(ab)).toBe(true);
			}
		});
	});

	// ---- No unlink API ----
	describe("no unlink API", () => {
		it("JournalIo has no unlink/link methods", () => {
			const io = new RealJournalIo() as unknown as Record<string, unknown>;
			expect(typeof io.unlink).toBe("undefined");
			expect(typeof io.link).toBe("undefined");
			expect(typeof io.unlinkIfOwned).toBe("undefined");
		});
	});
});

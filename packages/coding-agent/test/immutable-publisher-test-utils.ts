/**
 * Shared test utilities for immutable publication tests.
 * Tracking IO with failure injection, handle close accounting, buffer seam.
 */

import { chmod, mkdtemp, readdir, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect } from "vitest";
import {
	type IoHandle,
	type IoStats,
	type JournalIo,
	RealJournalIo,
} from "../src/modes/daemon/immutable-journal-publisher.js";

// ---------------------------------------------------------------------------
// Operation trace types
// ---------------------------------------------------------------------------

export type OpName = "lstat" | "realpath" | "open" | "fh.fstat" | "fh.read" | "fh.write" | "fh.fsync" | "fh.close";

export interface OpRecord {
	op: OpName;
	args: string;
	ok: boolean;
}

// ---------------------------------------------------------------------------
// Tracking IO — fault injection, close accounting, buffer seam
// ---------------------------------------------------------------------------

export class TrackingIo implements JournalIo {
	private readonly real = new RealJournalIo();
	private failMap = new Map<OpName, number>();
	private failHandleOps = new Map<number, Set<OpName>>();
	private recordsInner: OpRecord[] = [];
	private handleSeq = 0;
	private closeCountsInner = new Map<number, number>();
	private allocsInner: { buffer: Uint8Array; size: number }[] = [];
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
				} as never;
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

export async function tempDir(): Promise<string> {
	const d = await mkdtemp(join(tmpdir(), "ijp-test-"));
	await chmod(d, 0o700);
	return await realpath(d);
}

export async function cleanDir(d: string): Promise<void> {
	await rm(d, { recursive: true, force: true });
}

export async function writeFileString(path: string, content: string): Promise<void> {
	await writeFile(path, content, "utf8");
}

export async function fileContent(path: string): Promise<string> {
	return await readFile(path, "utf8");
}

export async function dirEntries(d: string): Promise<string[]> {
	return await readdir(d);
}

export function allZero(buf: Uint8Array): boolean {
	for (let i = 0; i < buf.length; i++) {
		if (buf[i] !== 0) return false;
	}
	return true;
}

export function detached16(): Uint8Array {
	const ab = new ArrayBuffer(16);
	const view = new Uint8Array(ab);
	structuredClone(ab, { transfer: [ab] });
	return view;
}

export function zeroCaller(buf: Uint8Array): void {
	for (let i = 0; i < buf.length; i++) expect(buf[i]).toBe(0);
}

export async function entryExists(d: string, name: string): Promise<boolean> {
	const entries = await readdir(d);
	return entries.includes(name);
}

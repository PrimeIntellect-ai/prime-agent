import { createHash } from "node:crypto";
import { closeSync, existsSync, fsyncSync, mkdirSync, openSync, readFileSync, statSync, writeSync } from "node:fs";
import { readdir, stat } from "node:fs/promises";
import { basename, dirname, join, resolve } from "node:path";
import { readSessionInfo, type SessionInfo } from "../../core/session-manager.js";

/**
 * Supervisor-owned RLM spawn ledger.
 *
 * One append-only JSONL file per sessions dir, written only by the daemon at
 * the moments it admits a spawn, performs a rename, or records a deletion.
 * Family topology (parent/child edges, depths, names) is read back from this
 * single self-written file instead of being re-derived from writer-owned
 * session headers, registries, and bodies at read time.
 */

export const RLM_LEDGER_DIR = "rlm-ledger";

/** Bounded read: a ledger beyond these limits fails closed loudly. */
export const RLM_LEDGER_MAX_BYTES = 32 * 1024 * 1024;
export const RLM_LEDGER_MAX_RECORDS = 100_000;

export type RlmLedgerDeleteReason = "user" | "parent-teardown" | "revoked" | "gc";

interface RlmLedgerMetaRecord {
	v: 1;
	op: "meta";
	at: string;
	sessionsDir: string;
}

export interface RlmLedgerSpawnRecord {
	v: 1;
	op: "spawn";
	at: string;
	childId: string;
	parent: string;
	child: string;
	depth: number;
	name: string;
}

export interface RlmLedgerRenameRecord {
	v: 1;
	op: "rename";
	at: string;
	childId: string;
	child: string;
	name: string;
}

export interface RlmLedgerDeleteRecord {
	v: 1;
	op: "delete";
	at: string;
	childId: string;
	child: string;
	reason: RlmLedgerDeleteReason;
}

export type RlmLedgerRecord = RlmLedgerSpawnRecord | RlmLedgerRenameRecord | RlmLedgerDeleteRecord;

/** A live edge after replaying the ledger (last-writer-wins per childId+child). */
export interface RlmLedgerEdge {
	childId: string;
	parent: string;
	child: string;
	depth: number;
	name: string;
	deleted?: RlmLedgerDeleteReason;
}

/** Minimal registry-entry shape the seeder consumes (matches the daemon writer). */
export interface RlmLedgerSeedRegistryEntry {
	childId: string;
	sessionName: string;
	sessionFile: string;
	rlmDepth?: number;
	status: "running" | "completed" | "deleted";
}

export interface RlmLedgerSeedSource {
	/**
	 * Tolerant last-writer-wins registry read for a parent session file, using
	 * the daemon's existing registry conventions. Must never throw for a
	 * missing registry; other failures may throw (seeding degrades to empty).
	 */
	readRegistryForSessionFile(sessionFile: string): Promise<RlmLedgerSeedRegistryEntry[]>;
}

export function rlmLedgerPath(agentDir: string, sessionsDir: string): string {
	const canonical = resolve(sessionsDir);
	const hash = createHash("sha256").update(canonical).digest("hex").slice(0, 16);
	return join(agentDir, RLM_LEDGER_DIR, `${hash}.jsonl`);
}

function nowIso(): string {
	return new Date().toISOString();
}

function isDeleteReason(value: unknown): value is RlmLedgerDeleteReason {
	return value === "user" || value === "parent-teardown" || value === "revoked" || value === "gc";
}

function parseLedgerLine(line: string, index: number): RlmLedgerRecord | RlmLedgerMetaRecord {
	let parsed: unknown;
	try {
		parsed = JSON.parse(line);
	} catch (error) {
		throw new Error(
			`Malformed RLM ledger line ${index + 1}: ${error instanceof Error ? error.message : String(error)}`,
		);
	}
	const record = parsed as {
		v?: unknown;
		op?: unknown;
		at?: unknown;
		sessionsDir?: unknown;
		childId?: unknown;
		parent?: unknown;
		child?: unknown;
		depth?: unknown;
		name?: unknown;
		reason?: unknown;
	};
	if (record.v !== 1 || typeof record.at !== "string") {
		throw new Error(`Malformed RLM ledger line ${index + 1}: missing v/at`);
	}
	switch (record.op) {
		case "meta":
			if (typeof record.sessionsDir !== "string") {
				throw new Error(`Malformed RLM ledger line ${index + 1}: meta without sessionsDir`);
			}
			return record as unknown as RlmLedgerMetaRecord;
		case "spawn":
			if (
				typeof record.childId !== "string" ||
				typeof record.parent !== "string" ||
				typeof record.child !== "string" ||
				typeof record.name !== "string" ||
				typeof record.depth !== "number" ||
				!Number.isSafeInteger(record.depth) ||
				record.depth < 1
			) {
				throw new Error(`Malformed RLM ledger line ${index + 1}: invalid spawn record`);
			}
			return record as unknown as RlmLedgerSpawnRecord;
		case "rename":
			if (
				typeof record.childId !== "string" ||
				typeof record.child !== "string" ||
				typeof record.name !== "string"
			) {
				throw new Error(`Malformed RLM ledger line ${index + 1}: invalid rename record`);
			}
			return record as unknown as RlmLedgerRenameRecord;
		case "delete":
			if (typeof record.childId !== "string" || typeof record.child !== "string" || !isDeleteReason(record.reason)) {
				throw new Error(`Malformed RLM ledger line ${index + 1}: invalid delete record`);
			}
			return record as unknown as RlmLedgerDeleteRecord;
		default:
			throw new Error(`Malformed RLM ledger line ${index + 1}: unknown op ${String(record.op)}`);
	}
}

function edgeKey(childId: string, child: string): string {
	return `${childId}\u0000${resolve(child)}`;
}

/**
 * Per-sessions-dir spawn ledger. All operations are serialized on an internal
 * queue; the first operation lazily seeds a missing ledger from the existing
 * per-parent registries (memoized; a seeding failure degrades to an empty
 * ledger and is never fail-closed).
 */
export class RlmSpawnLedger {
	private readonly path: string;
	private readonly canonicalSessionsDir: string;
	private queue: Promise<unknown> = Promise.resolve();
	private seedAttempted = false;

	constructor(
		agentDir: string,
		sessionsDir: string,
		private readonly seedSource?: RlmLedgerSeedSource,
		private readonly log: (message: string) => void = () => {},
	) {
		this.canonicalSessionsDir = resolve(sessionsDir);
		this.path = rlmLedgerPath(agentDir, sessionsDir);
	}

	get ledgerPath(): string {
		return this.path;
	}

	appendSpawn(input: { childId: string; parent: string; child: string; depth: number; name: string }): Promise<void> {
		return this.enqueue(() => this.appendSpawnUnlocked(input));
	}

	appendRename(input: { childId: string; child: string; name: string }): Promise<void> {
		return this.enqueue(() => {
			this.appendRecord({
				v: 1,
				op: "rename",
				at: nowIso(),
				childId: input.childId,
				child: resolve(input.child),
				name: input.name,
			});
		});
	}

	/** Rename by child session path alone (offline saved-session rename knows no childId). */
	appendRenameByChildPath(child: string, name: string): Promise<void> {
		return this.enqueue(() => {
			const target = resolve(child);
			for (const edge of this.replaySync().values()) {
				if (!edge.deleted && resolve(edge.child) === target) {
					this.appendRecord({ v: 1, op: "rename", at: nowIso(), childId: edge.childId, child: target, name });
				}
			}
		});
	}

	appendDelete(input: { childId: string; child: string; reason: RlmLedgerDeleteReason }): Promise<void> {
		return this.enqueue(() => {
			this.appendRecord({
				v: 1,
				op: "delete",
				at: nowIso(),
				childId: input.childId,
				child: resolve(input.child),
				reason: input.reason,
			});
		});
	}

	/** Replay live (non-deleted) edges, without liveness reconciliation. */
	edges(): Promise<RlmLedgerEdge[]> {
		return this.enqueue(() => [...this.replaySync().values()].filter((edge) => !edge.deleted));
	}

	/**
	 * Family of every session rooted in this ledger's sessions dir: bounded
	 * readdir of *.jsonl roots as depth-0 rows plus live ledger edges, both
	 * reconciled by stat (a dead parent or child drops the edge). Depths must
	 * be monotonic parent+1; a contradiction fails closed.
	 */
	family(): Promise<SessionInfo[]> {
		return this.enqueue(() => this.familyUnlocked());
	}

	/** Same-parent rows for a child session path, including the child itself. */
	siblings(sessionPath: string): Promise<SessionInfo[]> {
		return this.enqueue(async () => {
			const target = resolve(sessionPath);
			const family = await this.familyUnlocked();
			const edges = [...this.replaySync().values()].filter((edge) => !edge.deleted);
			const parentByChild = new Map(edges.map((edge) => [resolve(edge.child), resolve(edge.parent)]));
			const parent = parentByChild.get(target);
			if (parent === undefined) {
				// Roots (and unknown sessions) are siblings of the other roots.
				return family.filter((row) => row.rlmDepth === 0);
			}
			return family.filter((row) => parentByChild.get(resolve(row.path)) === parent);
		});
	}

	private enqueue<T>(fn: () => Promise<T> | T): Promise<T> {
		const next = this.queue.then(async () => {
			if (!this.seedAttempted) {
				this.seedAttempted = true;
				try {
					await this.seed();
				} catch (error) {
					this.log(`RLM ledger seeding failed: ${error instanceof Error ? error.message : String(error)}`);
				}
			}
			return fn();
		});
		this.queue = next.catch(() => undefined);
		return next;
	}

	private appendSpawnUnlocked(input: {
		childId: string;
		parent: string;
		child: string;
		depth: number;
		name: string;
	}): void {
		const childPath = resolve(input.child);
		for (const edge of this.replaySync().values()) {
			if (!edge.deleted && resolve(edge.child) === childPath && edge.childId !== input.childId) {
				throw new Error(`RLM ledger: duplicate child session path ${childPath} (already ${edge.childId})`);
			}
		}
		this.appendRecord({
			v: 1,
			op: "spawn",
			at: nowIso(),
			childId: input.childId,
			parent: resolve(input.parent),
			child: childPath,
			depth: input.depth,
			name: input.name,
		});
	}

	private async familyUnlocked(): Promise<SessionInfo[]> {
		const edges = [...this.replaySync().values()].filter((edge) => !edge.deleted);
		const byChild = new Map<string, RlmLedgerEdge>();
		for (const edge of edges) {
			byChild.set(resolve(edge.child), edge);
		}
		const alive: RlmLedgerEdge[] = [];
		const statCache = new Map<string, boolean>();
		const exists = async (path: string): Promise<boolean> => {
			const cached = statCache.get(path);
			if (cached !== undefined) return cached;
			let ok = false;
			try {
				ok = (await stat(path)).isFile();
			} catch {
				ok = false;
			}
			statCache.set(path, ok);
			return ok;
		};
		for (const edge of edges) {
			if ((await exists(resolve(edge.child))) && (await exists(resolve(edge.parent)))) {
				alive.push(edge);
			}
		}
		const rootPaths: string[] = [];
		let rootEntries: string[] = [];
		try {
			rootEntries = await readdir(this.canonicalSessionsDir);
		} catch {
			rootEntries = [];
		}
		for (const entry of rootEntries.filter((name) => name.endsWith(".jsonl")).sort()) {
			const path = resolve(join(this.canonicalSessionsDir, entry));
			// Ledger children that live directly in the sessions dir are not roots.
			if (byChild.has(path)) continue;
			rootPaths.push(path);
		}
		// Verify depth monotonicity: each edge's depth must be its parent's depth+1
		// wherever the parent's depth is known (root = 0, otherwise its own edge).
		const depthByPath = new Map<string, number>(rootPaths.map((path) => [path, 0]));
		for (const edge of alive) {
			depthByPath.set(resolve(edge.child), edge.depth);
		}
		for (const edge of alive) {
			const parentDepth = depthByPath.get(resolve(edge.parent));
			if (parentDepth !== undefined && edge.depth !== parentDepth + 1) {
				throw new Error(
					`RLM ledger: contradictory depth for ${edge.childId}: parent depth ${parentDepth}, child depth ${edge.depth}`,
				);
			}
		}
		const rows: SessionInfo[] = [];
		for (const rootPath of rootPaths) {
			rows.push(await this.sessionRow(rootPath, 0, undefined, undefined));
		}
		for (const edge of alive) {
			rows.push(await this.sessionRow(resolve(edge.child), edge.depth, resolve(edge.parent), edge.name));
		}
		return rows;
	}

	private async sessionRow(
		path: string,
		depth: number,
		parentPath: string | undefined,
		name: string | undefined,
	): Promise<SessionInfo> {
		// Display-grade fields are best-effort from the ordinary session-info read;
		// topology (path, depth, parent, name) always comes from the ledger.
		const info = await readSessionInfo(path).catch(() => null);
		if (info) {
			return {
				...info,
				rlmDepth: depth,
				...(parentPath ? { parentSessionPath: parentPath } : {}),
				...(name ? { name } : {}),
			};
		}
		return {
			path,
			id: basename(path, ".jsonl"),
			cwd: "",
			...(name ? { name } : {}),
			...(parentPath ? { parentSessionPath: parentPath } : {}),
			rlmDepth: depth,
			created: new Date(0),
			modified: new Date(0),
			messageCount: 0,
			firstMessage: "",
			allMessagesText: "",
		};
	}

	private async seed(): Promise<void> {
		if (!this.seedSource || existsSync(this.path)) return;
		let rootEntries: string[] = [];
		try {
			rootEntries = await readdir(this.canonicalSessionsDir);
		} catch {
			return;
		}
		const queue: Array<{ sessionFile: string; depth: number }> = rootEntries
			.filter((name) => name.endsWith(".jsonl"))
			.sort()
			.map((name) => ({ sessionFile: join(this.canonicalSessionsDir, name), depth: 0 }));
		const visited = new Set<string>(queue.map((item) => resolve(item.sessionFile)));
		while (queue.length > 0) {
			const { sessionFile, depth } = queue.shift()!;
			for (const entry of await this.seedSource.readRegistryForSessionFile(sessionFile)) {
				if (entry.status === "deleted") continue;
				const childPath = resolve(entry.sessionFile);
				if (visited.has(childPath)) continue;
				visited.add(childPath);
				const childDepth = entry.rlmDepth ?? depth + 1;
				try {
					this.appendSpawnUnlocked({
						childId: entry.childId,
						parent: sessionFile,
						child: entry.sessionFile,
						depth: childDepth,
						name: entry.sessionName,
					});
				} catch {
					// A duplicate-path registry artifact must not poison the seed.
					continue;
				}
				queue.push({ sessionFile: entry.sessionFile, depth: childDepth });
			}
		}
	}

	private appendRecord(record: RlmLedgerRecord): void {
		const dir = dirname(this.path);
		mkdirSync(dir, { recursive: true, mode: 0o700 });
		const isNew = !existsSync(this.path);
		const handle = openSync(this.path, "a", 0o600);
		try {
			if (isNew) {
				const meta: RlmLedgerMetaRecord = {
					v: 1,
					op: "meta",
					at: nowIso(),
					sessionsDir: this.canonicalSessionsDir,
				};
				writeSync(handle, `${JSON.stringify(meta)}\n`);
			}
			writeSync(handle, `${JSON.stringify(record)}\n`);
			fsyncSync(handle);
		} finally {
			closeSync(handle);
		}
	}

	private replaySync(): Map<string, RlmLedgerEdge> {
		const edges = new Map<string, RlmLedgerEdge>();
		if (!existsSync(this.path)) return edges;
		const size = statSync(this.path).size;
		if (size > RLM_LEDGER_MAX_BYTES) {
			throw new Error(`RLM ledger ${this.path} exceeds ${RLM_LEDGER_MAX_BYTES} bytes (${size}); refusing to read`);
		}
		const rawLines = readFileSync(this.path, "utf8").split("\n");
		let recordCount = 0;
		for (let index = 0; index < rawLines.length; index++) {
			const line = rawLines[index].trim();
			if (!line) continue;
			if (++recordCount > RLM_LEDGER_MAX_RECORDS) {
				throw new Error(`RLM ledger ${this.path} exceeds ${RLM_LEDGER_MAX_RECORDS} records; refusing to read`);
			}
			const record = parseLedgerLine(line, index);
			if (record.op === "meta") continue;
			const key = edgeKey(record.childId, record.child);
			switch (record.op) {
				case "spawn":
					edges.set(key, {
						childId: record.childId,
						parent: record.parent,
						child: record.child,
						depth: record.depth,
						name: record.name,
					});
					break;
				case "rename": {
					const existing = edges.get(key);
					if (existing) existing.name = record.name;
					break;
				}
				case "delete": {
					const existing = edges.get(key);
					if (existing) existing.deleted = record.reason;
					break;
				}
			}
		}
		return edges;
	}
}

import { createHash } from "node:crypto";
import {
	closeSync,
	existsSync,
	fstatSync,
	fsyncSync,
	ftruncateSync,
	linkSync,
	mkdirSync,
	openSync,
	readFileSync,
	readSync,
	realpathSync,
	renameSync,
	rmSync,
	statSync,
	writeSync,
} from "node:fs";
import { readdir, readFile, stat } from "node:fs/promises";
import { basename, dirname, join, resolve } from "node:path";
import { canonicalSessionPath } from "../../core/session-lease.js";
import { readSessionInfo, type SessionInfo } from "../../core/session-manager.js";
import { readFirstLineSync } from "../../utils/file-lines.js";

/**
 * Daemon-owned RLM spawn ledger.
 *
 * One append-only JSONL file per sessions dir, written by daemon processes at
 * the moments they admit a spawn, perform a rename, or record a deletion.
 * Family topology (parent/child edges, depths, names) is read back from this
 * file instead of being re-derived from writer-owned session headers,
 * registries, and bodies at read time.
 *
 * Multi-writer reality: the supervisor and each session worker hold their own
 * instance over the same file. Appends are single small O_APPEND writes (well
 * under PIPE_BUF-scale sizes), whose atomicity we rely on for interleaving;
 * reads re-read the whole file per operation, so cross-process staleness is
 * bounded to in-flight appends. In-process appends are serialized on an
 * internal queue.
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

/**
 * Default seed source: derive the per-parent registry path from the session
 * file's header id (a bounded first-line read, no full transcript parse) and
 * read it with the same tolerant last-writer-wins semantics the daemon's
 * passive-hydration reader uses (malformed lines ignored, unknown fields
 * accepted, absent depths allowed).
 */
export function createRlmLedgerRegistrySeedSource(): RlmLedgerSeedSource {
	return {
		readRegistryForSessionFile: async (sessionFile) => {
			let headerId: string | undefined;
			try {
				const firstLine = readFirstLineSync(sessionFile);
				if (firstLine) {
					const header = JSON.parse(firstLine) as { id?: unknown };
					if (typeof header.id === "string") headerId = header.id;
				}
			} catch {
				return [];
			}
			if (!headerId) return [];
			const registryPath = join(dirname(dirname(sessionFile)), "session-artifacts", headerId, "rlm-subagents.jsonl");
			let contents: string;
			try {
				contents = await readFile(registryPath, "utf8");
			} catch {
				return [];
			}
			const latest = new Map<string, RlmLedgerSeedRegistryEntry>();
			for (const line of contents.split(/\r?\n/)) {
				const trimmed = line.trim();
				if (!trimmed) continue;
				try {
					const entry = JSON.parse(trimmed) as {
						type?: unknown;
						childId?: unknown;
						sessionName?: unknown;
						sessionFile?: unknown;
						rlmDepth?: unknown;
						status?: unknown;
					};
					if (
						entry.type !== "rlm_subagent" ||
						typeof entry.childId !== "string" ||
						typeof entry.sessionName !== "string" ||
						typeof entry.sessionFile !== "string" ||
						(entry.status !== "running" && entry.status !== "completed" && entry.status !== "deleted") ||
						(entry.rlmDepth !== undefined &&
							(!Number.isSafeInteger(entry.rlmDepth) || (entry.rlmDepth as number) < 0))
					) {
						continue;
					}
					latest.set(entry.childId, {
						childId: entry.childId,
						sessionName: entry.sessionName,
						sessionFile: entry.sessionFile,
						...(typeof entry.rlmDepth === "number" ? { rlmDepth: entry.rlmDepth } : {}),
						status: entry.status,
					});
				} catch {
					// Malformed registry history is ignored, matching the daemon reader.
				}
			}
			return [...latest.values()];
		},
	};
}

/** Canonicalize a directory: realpath when it exists, plain resolve otherwise. */
function canonicalizeDirPath(dir: string): string {
	const resolved = resolve(dir);
	try {
		return realpathSync(resolved);
	} catch {
		return resolved;
	}
}

export function rlmLedgerPath(agentDir: string, sessionsDir: string): string {
	const canonical = canonicalizeDirPath(sessionsDir);
	const hash = createHash("sha256").update(canonical).digest("hex").slice(0, 16);
	return join(agentDir, RLM_LEDGER_DIR, `${hash}.jsonl`);
}

function nowIso(): string {
	return new Date().toISOString();
}

function isDeleteReason(value: unknown): value is RlmLedgerDeleteReason {
	return value === "user" || value === "parent-teardown" || value === "revoked" || value === "gc";
}

/**
 * Parse one ledger line. Returns undefined for a well-formed v:1 record with
 * an unknown op (forward-compat: newer writers may add ops; readers skip
 * them). Any other violation throws. Version policy: v !== 1 fails loudly —
 * a future v2 must move to a new file/hash (or accept breaking old readers),
 * because silently skipping records a reader cannot understand would corrupt
 * topology.
 */
function parseLedgerLine(line: string, index: number): RlmLedgerRecord | RlmLedgerMetaRecord | undefined {
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
			return undefined;
	}
}

function readAllSync(fd: number): Buffer {
	const size = fstatSync(fd).size;
	// Never allocate beyond the read bound: every full read of the ledger,
	// including the repair path, is bounded the same way replaySync is.
	if (size > RLM_LEDGER_MAX_BYTES) {
		throw new Error(`RLM ledger exceeds ${RLM_LEDGER_MAX_BYTES} bytes (${size}); refusing to read`);
	}
	const buffer = Buffer.alloc(size);
	let offset = 0;
	while (offset < size) {
		const bytesRead = readSync(fd, buffer, offset, size - offset, offset);
		if (bytesRead === 0) break;
		offset += bytesRead;
	}
	return buffer.subarray(0, offset);
}

function edgeKey(childId: string, child: string): string {
	return `${childId}\u0000${canonicalSessionPath(child)}`;
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
		this.canonicalSessionsDir = canonicalizeDirPath(sessionsDir);
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
				child: canonicalSessionPath(input.child),
				name: input.name,
			});
		});
	}

	/** Rename by child session path alone (offline saved-session rename knows no childId). */
	appendRenameByChildPath(child: string, name: string): Promise<void> {
		return this.enqueue(() => {
			const target = canonicalSessionPath(child);
			for (const edge of this.replaySync().values()) {
				if (!edge.deleted && canonicalSessionPath(edge.child) === target) {
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
				child: canonicalSessionPath(input.child),
				reason: input.reason,
			});
		});
	}

	/** Resolves once every operation enqueued so far has completed (durably, for appends). */
	flush(): Promise<void> {
		return this.queue.then(() => undefined);
	}

	/** Replay live (non-deleted) edges, without liveness reconciliation. */
	edges(): Promise<RlmLedgerEdge[]> {
		return this.enqueue(() => [...this.replaySync().values()].filter((edge) => !edge.deleted));
	}

	/**
	 * Family of every session rooted in this ledger's sessions dir: bounded
	 * readdir of *.jsonl roots as depth-0 rows plus live ledger edges, both
	 * reconciled by stat (a dead parent or child drops the edge). Depths are
	 * verified parent+1 between ledger-known depths; a contradictory edge is
	 * dropped and logged, never fails the whole family.
	 */
	family(): Promise<SessionInfo[]> {
		return this.enqueue(() => this.familyUnlocked());
	}

	/** Same-parent rows for a child session path, including the child itself. */
	siblings(sessionPath: string): Promise<SessionInfo[]> {
		return this.enqueue(async () => {
			const target = canonicalSessionPath(sessionPath);
			const family = await this.familyUnlocked();
			const edges = [...this.replaySync().values()].filter((edge) => !edge.deleted);
			const parentByChild = new Map(
				edges.map((edge) => [canonicalSessionPath(edge.child), canonicalSessionPath(edge.parent)]),
			);
			const parent = parentByChild.get(target);
			if (parent !== undefined) {
				const rows = family.filter((row) => parentByChild.get(canonicalSessionPath(row.path)) === parent);
				// The target's edge can be reconciliation-dropped (parent file
				// gone) while its own file still exists: fall back to presenting
				// the survivor alone rather than an empty set the callers would
				// read as "session not found".
				if (!rows.some((row) => canonicalSessionPath(row.path) === target)) {
					try {
						if ((await stat(target)).isFile()) {
							return [await this.sessionRow(target, 0, undefined, undefined)];
						}
					} catch {
						// fall through to the (possibly empty) sibling rows
					}
				}
				return rows;
			}
			// Roots are siblings of the other roots. A session outside both the
			// ledger and the sessions dir is presented alone (matching the
			// registry-walking reader's behavior for parentless sessions).
			const roots = family.filter((row) => row.rlmDepth === 0);
			if (roots.some((row) => canonicalSessionPath(row.path) === target)) {
				return roots;
			}
			try {
				if (!(await stat(target)).isFile()) return [];
			} catch {
				return [];
			}
			return [await this.sessionRow(target, 0, undefined, undefined)];
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
		// Enforce the same invariants parseLedgerLine checks: never write a
		// record this reader would refuse to read back.
		if (!input.childId || !input.parent || !input.child || !Number.isSafeInteger(input.depth) || input.depth < 1) {
			throw new Error(
				`RLM ledger: invalid spawn for ${input.childId || "<missing childId>"} (depth ${input.depth})`,
			);
		}
		const childPath = canonicalSessionPath(input.child);
		// Advisory, per-process: catches double-admission mistakes inside this
		// daemon. It is NOT a global uniqueness guarantee — other processes
		// append to the same file between our read and write.
		for (const edge of this.replaySync().values()) {
			if (!edge.deleted && canonicalSessionPath(edge.child) === childPath && edge.childId !== input.childId) {
				throw new Error(`RLM ledger: duplicate child session path ${childPath} (already ${edge.childId})`);
			}
		}
		this.appendRecord({
			v: 1,
			op: "spawn",
			at: nowIso(),
			childId: input.childId,
			parent: canonicalSessionPath(input.parent),
			child: childPath,
			depth: input.depth,
			name: input.name,
		});
	}

	private async familyUnlocked(): Promise<SessionInfo[]> {
		const edges = [...this.replaySync().values()].filter((edge) => !edge.deleted);
		const byChild = new Map<string, RlmLedgerEdge>();
		for (const edge of edges) {
			byChild.set(canonicalSessionPath(edge.child), edge);
		}
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
		let alive: RlmLedgerEdge[] = [];
		for (const edge of edges) {
			if ((await exists(canonicalSessionPath(edge.child))) && (await exists(canonicalSessionPath(edge.parent)))) {
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
			const path = canonicalSessionPath(join(this.canonicalSessionsDir, entry));
			// Ledger children that live directly in the sessions dir are not roots.
			if (byChild.has(path)) continue;
			rootPaths.push(path);
		}
		// Verify depth monotonicity between ledger-known depths only: a root's
		// presented depth of 0 is a display convention, not an assertion (a
		// nested daemon's roots legitimately carry env-derived depths > 0). A
		// contradictory edge is dropped and logged; one bad edge must not fail
		// the whole family.
		const depthByPath = new Map<string, number>();
		for (const edge of alive) {
			depthByPath.set(canonicalSessionPath(edge.child), edge.depth);
		}
		alive = alive.filter((edge) => {
			const parentDepth = depthByPath.get(canonicalSessionPath(edge.parent));
			if (parentDepth !== undefined && edge.depth !== parentDepth + 1) {
				this.log(
					`RLM ledger: dropped edge ${edge.childId} with contradictory depth (parent ${parentDepth}, child ${edge.depth})`,
				);
				return false;
			}
			return true;
		});
		const rows: SessionInfo[] = [];
		for (const rootPath of rootPaths) {
			rows.push(await this.sessionRow(rootPath, 0, undefined, undefined));
		}
		for (const edge of alive) {
			rows.push(
				await this.sessionRow(
					canonicalSessionPath(edge.child),
					edge.depth,
					canonicalSessionPath(edge.parent),
					edge.name,
				),
			);
		}
		return rows;
	}

	private async sessionRow(
		path: string,
		depth: number,
		parentPath: string | undefined,
		name: string | undefined,
	): Promise<SessionInfo> {
		// Display-grade fields are best-effort from the ordinary session-info
		// read; topology (path, depth, parent) comes EXCLUSIVELY from the
		// ledger: header-claimed parentSessionPath/rlmDepth (e.g. fork headers)
		// are stripped, never passed through. For roots the ledger carries no
		// name, so the name comes from this read — writer-owned display data,
		// not authority.
		const info = await readSessionInfo(path).catch(() => null);
		if (info) {
			const { parentSessionPath: _headerParent, rlmDepth: _headerDepth, ...display } = info;
			return {
				...display,
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
		// Collect the complete seed first, then publish it atomically via a
		// temp file + rename: the ledger file only exists once seeding is
		// complete, so an interrupted seed leaves nothing and the next
		// construction re-seeds from scratch. A concurrent process appending
		// before the rename creates the real file on demand and thereby
		// suppresses this seed — the same behavior as any pre-existing ledger.
		const records: RlmLedgerSpawnRecord[] = [];
		const queue: Array<{ sessionFile: string; depth: number }> = rootEntries
			.filter((name) => name.endsWith(".jsonl"))
			.sort()
			.map((name) => ({ sessionFile: join(this.canonicalSessionsDir, name), depth: 0 }));
		const visited = new Set<string>(queue.map((item) => canonicalSessionPath(item.sessionFile)));
		while (queue.length > 0) {
			const { sessionFile, depth } = queue.shift()!;
			for (const entry of await this.seedSource.readRegistryForSessionFile(sessionFile)) {
				if (entry.status === "deleted") continue;
				const childPath = canonicalSessionPath(entry.sessionFile);
				if (visited.has(childPath)) continue;
				visited.add(childPath);
				// A registry depth < 1 (legacy 0-depth entries exist in real data)
				// would be unwritable under the spawn invariants; treat it as
				// absent and derive parent depth + 1 instead of skipping the edge.
				const registryDepth = entry.rlmDepth !== undefined && entry.rlmDepth >= 1 ? entry.rlmDepth : undefined;
				const childDepth = registryDepth ?? depth + 1;
				if (!entry.childId) {
					this.log("RLM ledger: skipped seeding a registry entry without a childId");
					continue;
				}
				records.push({
					v: 1,
					op: "spawn",
					at: nowIso(),
					childId: entry.childId,
					parent: canonicalSessionPath(sessionFile),
					child: childPath,
					depth: childDepth,
					name: entry.sessionName,
				});
				queue.push({ sessionFile: entry.sessionFile, depth: childDepth });
			}
		}
		if (records.length === 0) return;
		const meta: RlmLedgerMetaRecord = { v: 1, op: "meta", at: nowIso(), sessionsDir: this.canonicalSessionsDir };
		const payload = [meta, ...records].map((record) => `${JSON.stringify(record)}\n`).join("");
		// A seed beyond the read bounds would publish a ledger every replaySync
		// refuses to read — manufacturing the exact poisoned state the bounds
		// exist to prevent. Skip seeding entirely (flat families, the documented
		// degradation mode) rather than publishing partial topology: profiles
		// this large are pathological, and a truncated tree would be more
		// confusing than a flat one. Not thrown: a hard error here would stick
		// via seedAttempted and the next append would create an empty ledger.
		if (records.length + 1 > RLM_LEDGER_MAX_RECORDS || Buffer.byteLength(payload) > RLM_LEDGER_MAX_BYTES) {
			this.log(
				`RLM ledger: seed exceeds read bounds (${records.length} records, ${Buffer.byteLength(payload)} bytes); skipping seeding`,
			);
			return;
		}
		const dir = dirname(this.path);
		mkdirSync(dir, { recursive: true, mode: 0o700 });
		const tempPath = `${this.path}.seed-${process.pid}-${Date.now()}`;
		const handle = openSync(tempPath, "wx", 0o600);
		try {
			writeSync(handle, payload);
			fsyncSync(handle);
		} finally {
			closeSync(handle);
		}
		try {
			this.publishSeedFile(tempPath);
		} finally {
			rmSync(tempPath, { force: true });
		}
	}

	private publishSeedFile(tempPath: string): void {
		// Atomic no-clobber publish: link() fails with EEXIST if a live append
		// created the real file meanwhile — that append wins (its data is
		// fresher than the registries) and the seed is discarded. A clobbering
		// rename() here would overwrite and lose that append.
		try {
			linkSync(tempPath, this.path);
			return;
		} catch (error) {
			const code = (error as NodeJS.ErrnoException).code;
			if (code === "EEXIST") {
				return;
			}
			// Filesystems without hard links (network/synced homes, non-NTFS
			// Windows volumes): fall back to check-then-rename. Non-atomic, but
			// strictly better than never seeding; the residual window is the
			// documented O_APPEND trust bucket.
			this.log(`RLM ledger: link publish failed (${code ?? "unknown"}), falling back to rename`);
			if (existsSync(this.path)) {
				return;
			}
			renameSync(tempPath, this.path);
		}
	}

	private appendRecord(record: RlmLedgerRecord): void {
		const dir = dirname(this.path);
		mkdirSync(dir, { recursive: true, mode: 0o700 });
		const isNew = !existsSync(this.path);
		if (!isNew) {
			// Repair a torn final line from a crashed writer before appending:
			// otherwise the next append would turn a tolerable torn tail into a
			// fail-closed interior line. The torn bytes were never readable data.
			this.truncateTornTailSync();
		}
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

	private truncateTornTailSync(): void {
		// Fail closed loudly at the read bound BEFORE the swallowing repair
		// try-block: an oversized ledger must never trigger a file-sized
		// allocation, and the error must not be silenced as a repair failure.
		let size: number;
		try {
			size = statSync(this.path).size;
		} catch {
			return;
		}
		if (size > RLM_LEDGER_MAX_BYTES) {
			throw new Error(`RLM ledger ${this.path} exceeds ${RLM_LEDGER_MAX_BYTES} bytes (${size}); refusing to read`);
		}
		// All offsets are BYTE offsets on raw buffers: string indices diverge
		// from byte offsets as soon as any record carries multi-byte UTF-8
		// (session names do, in real data), and ftruncate takes bytes.
		try {
			const fd = openSync(this.path, "r+");
			try {
				const first = readAllSync(fd);
				if (first.length === 0 || first[first.length - 1] === 0x0a) return;
				const lastNewline = first.lastIndexOf(0x0a);
				// Cheap cross-process hardening: only truncate when the bytes are
				// stable across two reads and the size has not moved under us
				// (same fd for stat and truncate). A racing append between this
				// check and the ftruncate remains possible — same trust bucket as
				// the documented O_APPEND small-write atomicity assumption.
				const second = readAllSync(fd);
				if (second.length !== first.length || !second.equals(first)) return;
				if (fstatSync(fd).size !== first.length) return;
				ftruncateSync(fd, lastNewline + 1);
				this.log(`RLM ledger: truncated torn final line (${first.length - lastNewline - 1} bytes)`);
			} finally {
				closeSync(fd);
			}
		} catch {
			// Leave the tail for the reader's torn-line tolerance.
		}
	}

	private replaySync(): Map<string, RlmLedgerEdge> {
		const edges = new Map<string, RlmLedgerEdge>();
		if (!existsSync(this.path)) return edges;
		const size = statSync(this.path).size;
		if (size > RLM_LEDGER_MAX_BYTES) {
			throw new Error(`RLM ledger ${this.path} exceeds ${RLM_LEDGER_MAX_BYTES} bytes (${size}); refusing to read`);
		}
		const contents = readFileSync(this.path, "utf8");
		const endsWithNewline = contents.endsWith("\n");
		const rawLines = contents.split("\n");
		let recordCount = 0;
		for (let index = 0; index < rawLines.length; index++) {
			const line = rawLines[index].trim();
			if (!line) continue;
			if (++recordCount > RLM_LEDGER_MAX_RECORDS) {
				throw new Error(`RLM ledger ${this.path} exceeds ${RLM_LEDGER_MAX_RECORDS} records; refusing to read`);
			}
			let record: RlmLedgerRecord | RlmLedgerMetaRecord | undefined;
			try {
				record = parseLedgerLine(line, index);
			} catch (error) {
				// Exactly one unparseable FINAL line without a trailing newline is
				// an in-progress or crashed append: log and ignore it. Interior
				// malformed lines stay fail-closed.
				if (index === rawLines.length - 1 && !endsWithNewline) {
					this.log(
						`RLM ledger: ignored torn final line: ${error instanceof Error ? error.message : String(error)}`,
					);
					continue;
				}
				throw error;
			}
			if (record === undefined) {
				this.log(`RLM ledger: skipped record with unknown op on line ${index + 1}`);
				continue;
			}
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

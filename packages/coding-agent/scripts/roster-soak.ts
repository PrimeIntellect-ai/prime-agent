// Roster push soak: a real supervisor socket under thousands of churning sessions.
// Covers the supervisor push path only; the worker frame path is pinned by the real-socket test in daemon-agent-roster.test.ts.
// Run: NODE_OPTIONS=--expose-gc npx tsx scripts/roster-soak.ts (env: SOAK_SESSIONS, SOAK_ROUNDS)
import { mkdtempSync, rmSync } from "node:fs";
import { connect, type Socket } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AgentsViewRosterStore } from "../src/modes/agents-view/roster-store.js";
import type { AgentRosterEntry, WorkerRosterEntry } from "../src/modes/daemon/agent-roster.js";
import { sessionSummaryFromRosterEntry, workerRosterEntryFromSummary } from "../src/modes/daemon/agent-roster.js";
import { DaemonCatalogClient } from "../src/modes/daemon/daemon-catalog-process.js";
import { DaemonClient } from "../src/modes/daemon/daemon-client.js";
import { createDaemonCommandEnvelope } from "../src/modes/daemon/daemon-protocol.js";
import type { SessionSummary } from "../src/modes/daemon/daemon-session-list.js";
import { DaemonSupervisor } from "../src/modes/daemon/daemon-supervisor.js";

const SESSIONS = Number(process.env.SOAK_SESSIONS ?? 3000);
const ROUNDS = Number(process.env.SOAK_ROUNDS ?? 30);
const WORKERS = 8;

let unhandledRejections = 0;
process.on("unhandledRejection", (reason) => {
	unhandledRejections += 1;
	console.error("UNHANDLED REJECTION:", reason);
});

const failures: string[] = [];
function check(condition: boolean, label: string): void {
	console.log(`${condition ? "ok " : "FAIL"} ${label}`);
	if (!condition) failures.push(label);
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
const gc = (globalThis as { gc?: () => void }).gc;
function sampleMiB(): number {
	gc?.();
	return Math.round(process.memoryUsage().heapUsed / 1024 / 1024);
}
const settle = () => new Promise((resolve) => setImmediate(resolve));

function summary(overrides: Partial<SessionSummary> & Pick<SessionSummary, "id" | "sessionId">): SessionSummary {
	return {
		lifecycle: "live",
		activity: "idle",
		isSessionActive: false,
		cwd: "/tmp/project",
		isStreaming: false,
		isCompacting: false,
		attachedClients: 0,
		messageCount: 1,
		sessionActions: { queuedCount: 0, steering: [], followUps: [] },
		...overrides,
	};
}

function makeChild(worker: number, index: number, depth: number, parentSessionPath: string): WorkerRosterEntry {
	const sessionId = `w${worker}-s${index}`;
	return workerRosterEntryFromSummary(
		summary({
			id: sessionId,
			sessionId,
			sessionFile: `/tmp/soak/artifacts/${sessionId}.jsonl`,
			runtimeKind: "subagent",
			rlmChildId: sessionId,
			rlmDepth: depth,
			parentSessionPath,
		}),
	);
}

interface SupervisorInternals {
	start(): Promise<void>;
	cleanupSupervisorResources(): Promise<void>;
	workers: Map<string, object>;
	catalog: object;
	consumeWorkerRosterDelta(worker: object, payload: Buffer): void;
	rosterEntriesForClient(): AgentRosterEntry[];
	roster(): { values(): IterableIterator<AgentRosterEntry> };
}

async function main(): Promise<void> {
	const directory = mkdtempSync(join(tmpdir(), "roster-soak-"));
	const socketPath = join(directory, "daemon.sock");
	(DaemonCatalogClient.prototype as unknown as { start(): Promise<void> }).start = async () => {};
	const supervisor = new DaemonSupervisor(socketPath, {
		defaultSessionConfig: { agentDir: directory, cwd: directory },
		descriptorDir: join(directory, "workers"),
	});
	const internals = supervisor as unknown as SupervisorInternals;
	let client: DaemonClient | undefined;
	let slow: Socket | undefined;
	try {
		await internals.start();
		await run(internals, socketPath, (created) => {
			client = created.client;
			slow = created.slow;
		});
	} finally {
		client?.close();
		slow?.destroy();
		await internals.cleanupSupervisorResources().catch(() => undefined);
		rmSync(directory, { recursive: true, force: true });
	}
	if (failures.length > 0) {
		console.error(`SOAK FAILED: ${failures.join("; ")}`);
		process.exit(1);
	}
	console.log("SOAK PASSED");
	process.exit(0);
}

async function run(
	internals: SupervisorInternals,
	socketPath: string,
	onSockets: (created: { client: DaemonClient; slow: Socket }) => void,
): Promise<void> {
	internals.catalog = { list: async () => [], stop: async () => {} };

	const workers: Array<{ descriptor: object; lastFrameAt: number }> = [];
	for (let w = 0; w < WORKERS; w++) {
		const worker = {
			descriptor: { workerId: `w${w}`, pid: 900_000 + w, rootActiveSessionId: `w${w}-root`, lifecycle: "ready" },
			client: { close: () => {} },
			summaries: new Map(),
			intentionalStop: false,
			lastFrameAt: Date.now(),
			snapshotCache: new Map(),
			transcriptCaches: new Map(),
			snapshotGenerations: new Map(),
			snapshotLoads: new Map(),
		};
		internals.workers.set(`w${w}`, worker);
		workers.push(worker as never);
	}
	const delta = (entries: WorkerRosterEntry[], removed?: string[], snapshot?: true) =>
		Buffer.from(
			JSON.stringify({
				type: "roster_delta",
				entries,
				...(removed ? { removedAgentIds: removed } : {}),
				...(snapshot ? { snapshot: true } : {}),
			}),
		);

	// Live truth per worker, mirrored alongside every delta we feed.
	const live = new Map<string, Map<string, WorkerRosterEntry>>(workers.map((_, w) => [`w${w}`, new Map()]));

	// Normal subscriber: the agents-view store over a real socket.
	const client = new DaemonClient(socketPath);
	await client.connect();
	await client.waitForHello();
	const store = new AgentsViewRosterStore();
	if (!(await store.attach(client))) throw new Error("agent_roster capability missing");

	// Deliberately slow subscriber: subscribes, then stops reading until the churn ends.
	const slow = connect(socketPath);
	onSockets({ client, slow });
	await new Promise((resolve) => slow.once("connect", resolve));
	slow.write(`${JSON.stringify(createDaemonCommandEnvelope({ type: "roster_subscribe" }, "slow-1"))}\n`);

	const slowChunks: Buffer[] = [];
	slow.on("data", (chunk: Buffer) => slowChunks.push(chunk));
	await sleep(200);
	slow.pause();

	// Seed: SESSIONS children across workers in chains; every eighth chain runs 40 deep.
	const startedAt = Date.now();
	let index = 0;
	for (let w = 0; w < WORKERS; w++) {
		const rows: WorkerRosterEntry[] = [];
		const perWorker = Math.floor(SESSIONS / WORKERS);
		let chainParent = `/tmp/soak/sessions/w${w}-root.jsonl`;
		let chainDepth = 1;
		const chainLength = () => (index % 8 === 0 ? 40 : 1 + (index % 5));
		let remainingInChain = chainLength();
		for (let i = 0; i < perWorker; i++, index++) {
			const entry = makeChild(w, i, chainDepth, chainParent);
			rows.push(entry);
			live.get(`w${w}`)?.set(entry.agentId, entry);
			remainingInChain -= 1;
			if (remainingInChain <= 0) {
				chainParent = `/tmp/soak/sessions/w${w}-root.jsonl`;
				chainDepth = 1;
				remainingInChain = chainLength();
			} else {
				chainParent = entry.summary.sessionFile ?? chainParent;
				chainDepth += 1;
			}
		}
		for (let offset = 0; offset < rows.length; offset += 250) {
			internals.consumeWorkerRosterDelta(workers[w] as never, delta(rows.slice(offset, offset + 250)));
			await settle();
		}
	}
	const seededAt = Date.now();
	const rssSamples: number[] = [sampleMiB()];

	// Sustained churn: mutate, remove, add, and periodically replace a whole worker via snapshot.
	let mutations = 0;
	for (let round = 0; round < ROUNDS; round++) {
		for (let w = 0; w < WORKERS; w++) {
			const workerLive = live.get(`w${w}`);
			if (!workerLive) continue;
			(workers[w] as { lastFrameAt: number }).lastFrameAt = Date.now();
			const ids = [...workerLive.keys()];
			const flipped: WorkerRosterEntry[] = [];
			for (let k = 0; k < ids.length; k += 10) {
				const entry = workerLive.get(ids[k] ?? "");
				if (!entry) continue;
				const next = {
					...entry,
					summary: { ...entry.summary, isSessionActive: round % 2 === 0, activity: round % 2 === 0 ? "working" : "idle" },
				} as WorkerRosterEntry;
				workerLive.set(entry.agentId, next);
				flipped.push(next);
			}
			const removed: string[] = [];
			for (let k = 5; k < ids.length; k += 20) {
				const id = ids[k];
				if (id === undefined) continue;
				workerLive.delete(id);
				removed.push(id);
			}
			const added: WorkerRosterEntry[] = [];
			for (let k = 0; k < removed.length; k++, index++) {
				const entry = makeChild(w, 100_000 + index, 1 + (index % 45), `/tmp/soak/sessions/w${w}-root.jsonl`);
				workerLive.set(entry.agentId, entry);
				added.push(entry);
			}
			mutations += flipped.length + removed.length + added.length;
			if (round % 10 === 9 && w === 0) {
				// Worker restart: one full replacing snapshot instead of deltas.
				internals.consumeWorkerRosterDelta(workers[w] as never, delta([...workerLive.values()], undefined, true));
			} else {
				internals.consumeWorkerRosterDelta(workers[w] as never, delta([...flipped, ...added], removed));
			}
		}
		await settle();
		if (round === Math.floor(ROUNDS / 4)) rssSamples.push(sampleMiB());
	}
	await settle();
	await sleep(200);
	const churnedAt = Date.now();
	rssSamples.push(sampleMiB());

	// No wedge: plain and deep list-all commands still answer.
	const listStarted = Date.now();
	const listed = await client.request({ type: "list" });
	const listLatencyMs = Date.now() - listStarted;
	check(listed.success === true && listLatencyMs < 2000, `list answers after churn (${listLatencyMs}ms)`);
	const listAllStarted = Date.now();
	const listedAll = await client.request({ type: "list", all: true, sessionDir: "/tmp/soak/sessions" });
	const listAllLatencyMs = Date.now() - listAllStarted;
	check(
		listedAll.success === true && listAllLatencyMs < 2000,
		`list all answers over deep chains (${listAllLatencyMs}ms)`,
	);

	// Ledger size equals the fed truth.
	const expectedIds = new Set<string>();
	for (const workerLive of live.values()) for (const id of workerLive.keys()) expectedIds.add(id);
	const ledgerIds = new Set([...internals.roster().values()].map((entry) => entry.agentId));
	check(
		ledgerIds.size === expectedIds.size && [...expectedIds].every((id) => ledgerIds.has(id)),
		`ledger matches live truth (${ledgerIds.size} rows)`,
	);

	// The live subscriber converges to the exact final payloads, not just statuses.
	await sleep(300);
	const finalEntries = internals.rosterEntriesForClient();
	const wantedSummaries = new Map(
		finalEntries.map((entry) => [entry.summary.sessionId, JSON.stringify(sessionSummaryFromRosterEntry(entry))]),
	);
	const got = new Map(store.summaries().map((row) => [row.sessionId, JSON.stringify(row)]));
	let storeExact = wantedSummaries.size === got.size;
	for (const [sessionId, payload] of wantedSummaries) if (got.get(sessionId) !== payload) storeExact = false;
	check(storeExact, `store subscriber converges to exact payloads (${got.size} rows)`);

	// The slow subscriber drains to the exact final state through one coalesced resync.
	slow.resume();
	let lastLength = -1;
	while (Buffer.concat(slowChunks).length !== lastLength) {
		lastLength = Buffer.concat(slowChunks).length;
		await sleep(400);
	}
	const slowRows = new Map<string, AgentRosterEntry>();
	let resyncs = 0;
	let slowUpdates = 0;
	let biggestNonResync = 0;
	for (const line of Buffer.concat(slowChunks).toString("utf8").split("\n")) {
		if (!line.trim()) continue;
		let message: { type?: string; resync?: boolean; changed?: AgentRosterEntry[]; removed?: string[] };
		try {
			message = JSON.parse(line);
		} catch {
			continue;
		}
		if (message.type !== "roster_update") continue;
		slowUpdates += 1;
		if (message.resync) {
			resyncs += 1;
			slowRows.clear();
		} else {
			biggestNonResync = Math.max(biggestNonResync, message.changed?.length ?? 0);
		}
		for (const entry of message.changed ?? []) slowRows.set(entry.agentId, entry);
		for (const agentId of message.removed ?? []) slowRows.delete(agentId);
	}
	const slowBySession = new Map(
		[...slowRows.values()].map((entry) => [entry.summary.sessionId, JSON.stringify(entry)]),
	);
	const wantedEntries = new Map(finalEntries.map((entry) => [entry.summary.sessionId, JSON.stringify(entry)]));
	let slowExact = wantedEntries.size === slowBySession.size;
	for (const [sessionId, payload] of wantedEntries) if (slowBySession.get(sessionId) !== payload) slowExact = false;
	check(slowExact, `slow subscriber converges to exact payloads (${slowBySession.size} rows, ${resyncs} resyncs)`);
	// The paused socket guarantees at least one loss gap, and gaps must coalesce, never loop.
	check(resyncs >= 1 && resyncs <= 3, `resyncs cover the induced gap and stay coalesced (${resyncs})`);
	check(biggestNonResync <= SESSIONS, "no accidental full-roster deltas outside resync");

	const rssStart = rssSamples[1] ?? rssSamples[0] ?? 1;
	const rssEnd = rssSamples.at(-1) ?? 1;
	check(rssEnd <= rssStart * 1.5, `heap plateaus after warmup (${rssSamples.join(" -> ")} MiB)`);
	check(unhandledRejections === 0, "no unhandled rejections");

	console.log("---");
	console.log(
		JSON.stringify(
			{
				sessions: SESSIONS,
				rounds: ROUNDS,
				mutations,
				seedMs: seededAt - startedAt,
				churnMs: churnedAt - seededAt,
				listLatencyMs,
				listAllLatencyMs,
				slowUpdates,
				resyncs,
				heapMiB: rssSamples,
				ledgerRows: ledgerIds.size,
			},
			undefined,
			1,
		),
	);
}

main().catch((error: unknown) => {
	console.error("SOAK FAILED:", error);
	process.exit(1);
});

import { createHash } from "node:crypto";
import { isAbsolute } from "node:path";
import type {
	DaemonArchiveOccupancyReceipt,
	DaemonArchivePostReadback,
	DaemonArchiveSessionReceipt,
} from "./daemon-protocol.js";

type ArchiveOccupancyInput = Omit<DaemonArchiveOccupancyReceipt, "busy" | "occupancyDigest">;
type ArchiveSessionReceiptInput = Omit<DaemonArchiveSessionReceipt, "archiveReceiptDigest" | "state">;

const OCCUPANCY_KEYS = [
	"activeSessionId",
	"sessionId",
	"sessionPath",
	"hostGeneration",
	"lifecycle",
	"workerState",
	"workerRefresh",
	"activeTurn",
	"streaming",
	"compacting",
	"tools",
	"bash",
	"unfinishedActions",
	"queuedActions",
	"runningChildren",
	"attachedClients",
	"heartbeat",
	"cron",
	"busy",
	"observedAt",
	"occupancyDigest",
] as const;

const ARCHIVE_KEYS = [
	"activeSessionId",
	"sessionId",
	"sessionPath",
	"hostGeneration",
	"beforeOccupancyDigest",
	"archiveReceiptDigest",
	"state",
	"archivedAt",
	"postReadback",
] as const;

const POST_READBACK_KEYS = ["sessionId", "sessionPath", "state"] as const;
const SHA256_PATTERN = /^sha256:[a-f0-9]{64}$/;

function canonicalJson(value: unknown): string {
	if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
	if (value && typeof value === "object") {
		const record = value as Record<string, unknown>;
		return `{${Object.keys(record)
			.sort()
			.map((key) => `${JSON.stringify(key)}:${canonicalJson(record[key])}`)
			.join(",")}}`;
	}
	return JSON.stringify(value);
}

function digest(value: unknown): string {
	return `sha256:${createHash("sha256").update(canonicalJson(value)).digest("hex")}`;
}

function hasExactKeys(value: object, expected: readonly string[]): boolean {
	const actual = Object.keys(value).sort();
	const sortedExpected = [...expected].sort();
	return actual.length === sortedExpected.length && actual.every((key, index) => key === sortedExpected[index]);
}

function isNonEmptyString(value: unknown): value is string {
	return typeof value === "string" && value.length > 0;
}

function isCanonicalTimestamp(value: unknown): value is string {
	if (typeof value !== "string") return false;
	const timestamp = Date.parse(value);
	return Number.isFinite(timestamp) && new Date(timestamp).toISOString() === value;
}

function isNonNegativeInteger(value: unknown): value is number {
	return typeof value === "number" && Number.isInteger(value) && value >= 0;
}

export async function registerDaemonArchiveOccupancyMutation(
	readArchiveFence: () => Promise<void> | undefined,
	waitForIdleEviction: () => Promise<void>,
	begin: () => void,
): Promise<void> {
	const initialArchiveFence = readArchiveFence();
	if (initialArchiveFence) await initialArchiveFence;
	await waitForIdleEviction();
	while (true) {
		const archiveFence = readArchiveFence();
		if (!archiveFence) {
			begin();
			return;
		}
		await archiveFence;
	}
}

export interface DaemonArchiveSummaryOccupancy {
	activeTurn: boolean;
	streaming: boolean;
	compacting: boolean;
	tools: boolean;
	bash: boolean;
	unfinishedActions: number;
	queuedActions: number;
	runningChildren: boolean;
}

export function projectDaemonArchiveSummaryOccupancy(value: unknown): DaemonArchiveSummaryOccupancy {
	if (!value || typeof value !== "object") throw new Error("Archive occupancy summary is incomplete");
	const summary = value as Record<string, unknown>;
	const actions = summary.sessionActions;
	if (
		!isNonEmptyString(summary.activeSessionId) ||
		!isNonEmptyString(summary.sessionId) ||
		!isNonEmptyString(summary.sessionFile) ||
		!isAbsolute(summary.sessionFile) ||
		(summary.lifecycle !== "draft" && summary.lifecycle !== "live") ||
		typeof summary.isSessionActive !== "boolean" ||
		typeof summary.isStreaming !== "boolean" ||
		typeof summary.isCompacting !== "boolean" ||
		typeof summary.isBashRunning !== "boolean" ||
		typeof summary.isRunningTools !== "boolean" ||
		typeof summary.hasRunningRlmChildren !== "boolean" ||
		!isNonNegativeInteger(summary.unfinishedActionCount) ||
		!actions ||
		typeof actions !== "object"
	) {
		throw new Error("Archive occupancy summary is incomplete");
	}
	const actionSnapshot = actions as Record<string, unknown>;
	if (
		!isNonNegativeInteger(actionSnapshot.queuedCount) ||
		!Array.isArray(actionSnapshot.steering) ||
		!actionSnapshot.steering.every((entry) => typeof entry === "string") ||
		!Array.isArray(actionSnapshot.followUps) ||
		!actionSnapshot.followUps.every((entry) => typeof entry === "string") ||
		(actionSnapshot.active !== undefined &&
			(!actionSnapshot.active ||
				typeof actionSnapshot.active !== "object" ||
				!(["turn", "session_command"] as const).includes(
					(actionSnapshot.active as { kind?: "turn" | "session_command" }).kind!,
				) ||
				!(["preparing", "committing", "running"] as const).includes(
					(actionSnapshot.active as { phase?: "preparing" | "committing" | "running" }).phase!,
				)))
	) {
		throw new Error("Archive occupancy summary is incomplete");
	}
	return {
		activeTurn: summary.isSessionActive,
		streaming: summary.isStreaming,
		compacting: summary.isCompacting,
		tools: summary.isRunningTools,
		bash: summary.isBashRunning,
		unfinishedActions: summary.unfinishedActionCount,
		queuedActions: actionSnapshot.queuedCount,
		runningChildren: summary.hasRunningRlmChildren,
	};
}

function occupancyProjection(
	input: ArchiveOccupancyInput,
): Omit<DaemonArchiveOccupancyReceipt, "observedAt" | "occupancyDigest"> {
	const busy =
		input.activeTurn ||
		input.streaming ||
		input.compacting ||
		input.tools ||
		input.bash ||
		input.unfinishedActions > 0 ||
		input.queuedActions > 0 ||
		input.runningChildren ||
		input.attachedClients > 0 ||
		input.heartbeat ||
		input.cron;
	return {
		activeSessionId: input.activeSessionId,
		sessionId: input.sessionId,
		sessionPath: input.sessionPath,
		hostGeneration: input.hostGeneration,
		lifecycle: input.lifecycle,
		workerState: input.workerState,
		workerRefresh: input.workerRefresh,
		activeTurn: input.activeTurn,
		streaming: input.streaming,
		compacting: input.compacting,
		tools: input.tools,
		bash: input.bash,
		unfinishedActions: input.unfinishedActions,
		queuedActions: input.queuedActions,
		runningChildren: input.runningChildren,
		attachedClients: input.attachedClients,
		heartbeat: input.heartbeat,
		cron: input.cron,
		busy,
	};
}

export function createDaemonArchiveOccupancyReceipt(input: ArchiveOccupancyInput): DaemonArchiveOccupancyReceipt {
	const projection = occupancyProjection(input);
	return {
		...projection,
		observedAt: input.observedAt,
		occupancyDigest: digest(projection),
	};
}

function isArchivePostReadback(value: unknown): value is DaemonArchivePostReadback {
	if (!value || typeof value !== "object" || !hasExactKeys(value, POST_READBACK_KEYS)) return false;
	const candidate = value as Partial<DaemonArchivePostReadback>;
	return (
		isNonEmptyString(candidate.sessionId) &&
		isNonEmptyString(candidate.sessionPath) &&
		isAbsolute(candidate.sessionPath) &&
		candidate.state === "archived"
	);
}

export function isDaemonArchiveOccupancyReceipt(value: unknown): value is DaemonArchiveOccupancyReceipt {
	if (!value || typeof value !== "object" || !hasExactKeys(value, OCCUPANCY_KEYS)) return false;
	const candidate = value as Partial<DaemonArchiveOccupancyReceipt>;
	if (
		!isNonEmptyString(candidate.activeSessionId) ||
		!isNonEmptyString(candidate.sessionId) ||
		!isNonEmptyString(candidate.sessionPath) ||
		!isAbsolute(candidate.sessionPath) ||
		!isNonEmptyString(candidate.hostGeneration) ||
		(candidate.lifecycle !== "draft" && candidate.lifecycle !== "live") ||
		candidate.workerState !== "ready" ||
		candidate.workerRefresh !== "current" ||
		typeof candidate.activeTurn !== "boolean" ||
		typeof candidate.streaming !== "boolean" ||
		typeof candidate.compacting !== "boolean" ||
		typeof candidate.tools !== "boolean" ||
		typeof candidate.bash !== "boolean" ||
		!isNonNegativeInteger(candidate.unfinishedActions) ||
		!isNonNegativeInteger(candidate.queuedActions) ||
		typeof candidate.runningChildren !== "boolean" ||
		!isNonNegativeInteger(candidate.attachedClients) ||
		typeof candidate.heartbeat !== "boolean" ||
		typeof candidate.cron !== "boolean" ||
		typeof candidate.busy !== "boolean" ||
		!isCanonicalTimestamp(candidate.observedAt) ||
		typeof candidate.occupancyDigest !== "string" ||
		!SHA256_PATTERN.test(candidate.occupancyDigest)
	) {
		return false;
	}
	const input: ArchiveOccupancyInput = {
		activeSessionId: candidate.activeSessionId,
		sessionId: candidate.sessionId,
		sessionPath: candidate.sessionPath,
		hostGeneration: candidate.hostGeneration,
		lifecycle: candidate.lifecycle,
		workerState: candidate.workerState,
		workerRefresh: candidate.workerRefresh,
		activeTurn: candidate.activeTurn,
		streaming: candidate.streaming,
		compacting: candidate.compacting,
		tools: candidate.tools,
		bash: candidate.bash,
		unfinishedActions: candidate.unfinishedActions,
		queuedActions: candidate.queuedActions,
		runningChildren: candidate.runningChildren,
		attachedClients: candidate.attachedClients,
		heartbeat: candidate.heartbeat,
		cron: candidate.cron,
		observedAt: candidate.observedAt,
	};
	const expected = createDaemonArchiveOccupancyReceipt(input);
	return candidate.busy === expected.busy && candidate.occupancyDigest === expected.occupancyDigest;
}

function archiveProjection(
	input: ArchiveSessionReceiptInput,
): Omit<DaemonArchiveSessionReceipt, "archiveReceiptDigest"> {
	return {
		activeSessionId: input.activeSessionId,
		sessionId: input.sessionId,
		sessionPath: input.sessionPath,
		hostGeneration: input.hostGeneration,
		beforeOccupancyDigest: input.beforeOccupancyDigest,
		state: "archived",
		archivedAt: input.archivedAt,
		postReadback: input.postReadback,
	};
}

export function createArchiveSessionReceipt(input: ArchiveSessionReceiptInput): DaemonArchiveSessionReceipt {
	const projection = archiveProjection(input);
	return { ...projection, archiveReceiptDigest: digest(projection) };
}

export function isDaemonArchiveSessionReceipt(value: unknown): value is DaemonArchiveSessionReceipt {
	if (!value || typeof value !== "object" || !hasExactKeys(value, ARCHIVE_KEYS)) return false;
	const candidate = value as Partial<DaemonArchiveSessionReceipt>;
	if (
		!isNonEmptyString(candidate.activeSessionId) ||
		!isNonEmptyString(candidate.sessionId) ||
		!isNonEmptyString(candidate.sessionPath) ||
		!isAbsolute(candidate.sessionPath) ||
		!isNonEmptyString(candidate.hostGeneration) ||
		typeof candidate.beforeOccupancyDigest !== "string" ||
		!SHA256_PATTERN.test(candidate.beforeOccupancyDigest) ||
		typeof candidate.archiveReceiptDigest !== "string" ||
		!SHA256_PATTERN.test(candidate.archiveReceiptDigest) ||
		candidate.state !== "archived" ||
		!isCanonicalTimestamp(candidate.archivedAt) ||
		!isArchivePostReadback(candidate.postReadback) ||
		candidate.postReadback.sessionId !== candidate.sessionId ||
		candidate.postReadback.sessionPath !== candidate.sessionPath
	) {
		return false;
	}
	const expected = createArchiveSessionReceipt({
		activeSessionId: candidate.activeSessionId,
		sessionId: candidate.sessionId,
		sessionPath: candidate.sessionPath,
		hostGeneration: candidate.hostGeneration,
		beforeOccupancyDigest: candidate.beforeOccupancyDigest,
		archivedAt: candidate.archivedAt,
		postReadback: candidate.postReadback,
	});
	return candidate.archiveReceiptDigest === expected.archiveReceiptDigest;
}

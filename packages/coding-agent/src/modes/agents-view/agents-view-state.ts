import { basename, resolve } from "node:path";
import { canonicalizePath } from "../../utils/paths.js";
import type { AgentConnectionHeartbeat, AgentConnectionSavedSessionInfo } from "../agent-connection/index.js";
import { classifySessionRosterStatus, type SessionSummary } from "../daemon/daemon-session-list.js";

export type AgentsViewSection = "running" | "idle" | "inactive";

export interface UnifiedSessionHeartbeat {
	activeCount: number;
	nextRunAt?: string;
}

export interface UnifiedSessionRecord {
	daemon?: SessionSummary;
	saved?: AgentConnectionSavedSessionInfo;
	/** Stable UI key, chosen using canonical path, session id, then active id. */
	identity: string;
	/** Alternate keys used to restore selection while a session is persisted or reattached. */
	identityAliases: readonly string[];
	section: AgentsViewSection;
	searchableText: string;
	heartbeat?: UnifiedSessionHeartbeat;
}

export interface AgentsViewScopeKey {
	sessionId: string;
	activeSessionId?: string;
}

export interface AgentsViewScopeFrame {
	scope: AgentsViewScopeKey;
	/** Chat to revisit before returning to the parent agents view. */
	returnChat?: SessionSummary;
}

export type AgentsViewScopeAction =
	| { type: "push"; scope: AgentsViewScopeKey; returnChat?: SessionSummary }
	| { type: "back" };

export interface AgentsViewScopeResolution {
	frames: AgentsViewScopeFrame[];
	root?: UnifiedSessionRecord;
	droppedFrames: number;
}

export interface AgentsViewScopeBackResult {
	type: "scope_back";
	selection: SessionSummary;
	expandedAncestorSessionIds: string[];
	returnChat?: SessionSummary;
}

export interface UnattachableChildOpenResult {
	type: "open";
	summary: SessionSummary;
	selection: SessionSummary;
	expandedAncestorSessionIds: string[];
	hasChildren: boolean;
	statusMessage: string;
}

export type AgentsViewRowKind = "agent" | "subagent-summary" | "subagent" | "subagent-code";

// Hard cap on spawn-code lines shown so a large program never floods the view.
const MAX_SPAWN_CODE_LINES = 10;

export interface AgentsViewRow {
	kind: AgentsViewRowKind;
	section: AgentsViewSection;
	summary: SessionSummary;
	title: string;
	subtitle: string;
	statusLabel: string;
	depth: number;
	selectable: boolean;
	runningSubagentCount: number;
	/** Unique selection identity for this row. */
	identity: string;
	/** Identity of the agent row this row is nested under. */
	parentIdentity?: string;
	/** True when this row's subagents carry spawn code that can be revealed. */
	hasSpawnCode?: boolean;
	/** True when this subagent-summary row's list is expanded. */
	expanded?: boolean;
	/** One source line of the spawn cell, for "subagent-code" rows. */
	code?: string;
	/** Merged durable/live source data for unified rows. */
	record?: UnifiedSessionRecord;
	heartbeat?: UnifiedSessionHeartbeat;
}

export function classifyAgentsViewSession(summary: SessionSummary): AgentsViewSection {
	return classifySessionRosterStatus(summary);
}

export function classifyUnifiedSession(record: Pick<UnifiedSessionRecord, "daemon" | "heartbeat">): AgentsViewSection {
	if (!record.daemon) {
		return "inactive";
	}
	if ((record.heartbeat?.activeCount ?? 0) > 0) {
		return "running";
	}
	return classifyAgentsViewSession(record.daemon);
}

// Live sessions only; drafts and archived stay out.
export function shouldShowAgentsViewSession(summary: SessionSummary, manuallyInactive = false): boolean {
	if (manuallyInactive) {
		return false;
	}
	return summary.lifecycle === "live" && (summary.workerState === undefined || summary.workerState === "ready");
}

export function sectionTitle(section: AgentsViewSection): string {
	switch (section) {
		case "running":
			return "Running";
		case "idle":
			return "Idle";
		case "inactive":
			return "Inactive";
		default: {
			const _exhaustive: never = section;
			return _exhaustive;
		}
	}
}

function canonicalSessionPath(path: string): string {
	return resolve(canonicalizePath(path));
}

function fileIdentity(path: string): string {
	return `file:${canonicalSessionPath(path)}`;
}

function summaryIdentityAliases(summary: SessionSummary): string[] {
	return [
		summary.sessionFile ? fileIdentity(summary.sessionFile) : undefined,
		`session:${summary.sessionId}`,
		summary.activeSessionId ? `active:${summary.activeSessionId}` : undefined,
		`active:${summary.id}`,
	].filter((identity): identity is string => identity !== undefined);
}

function savedIdentityAliases(saved: AgentConnectionSavedSessionInfo): string[] {
	return [fileIdentity(saved.path), `session:${saved.id}`];
}

function createUnifiedSearchableText(
	daemon: SessionSummary | undefined,
	saved: AgentConnectionSavedSessionInfo | undefined,
): string {
	return [
		daemon?.sessionId,
		daemon?.activeSessionId,
		daemon?.sessionName,
		daemon?.firstMessage,
		daemon?.cwd,
		daemon?.sessionFile,
		daemon?.summary,
		saved?.id,
		saved?.name,
		saved?.firstMessage,
		saved?.allMessagesText,
		saved?.agentStatus?.summary,
		saved?.cwd,
		saved?.path,
		saved?.parentSessionPath,
	]
		.filter((part): part is string => typeof part === "string" && part.length > 0)
		.join(" ");
}

/**
 * Reconcile daemon-resident and saved catalog rows without inventing runtime
 * ancestry from persisted fork metadata. Daemon data remains authoritative;
 * saved data only enriches durable/search fields.
 */
export function reconcileUnifiedSessions(
	daemonSummaries: readonly SessionSummary[],
	savedSessions: readonly AgentConnectionSavedSessionInfo[],
	heartbeats: readonly AgentConnectionHeartbeat[] = [],
): UnifiedSessionRecord[] {
	const heartbeatByActiveId = aggregateSessionHeartbeats(daemonSummaries, heartbeats);
	const records: UnifiedSessionRecord[] = [];
	const recordByAlias = new Map<string, UnifiedSessionRecord>();

	for (const daemon of daemonSummaries) {
		const aliases = summaryIdentityAliases(daemon);
		const heartbeat =
			heartbeatByActiveId.get(daemon.activeSessionId ?? daemon.id) ??
			(daemon.hasActiveHeartbeat ? { activeCount: 1 } : undefined);
		const record: UnifiedSessionRecord = {
			daemon: heartbeat && !daemon.hasActiveHeartbeat ? { ...daemon, hasActiveHeartbeat: true } : daemon,
			identity: aliases[0]!,
			identityAliases: aliases,
			section: "idle",
			searchableText: "",
			...(heartbeat ? { heartbeat } : {}),
		};
		record.section = classifyUnifiedSession(record);
		record.searchableText = createUnifiedSearchableText(daemon, undefined);
		records.push(record);
		for (const alias of aliases) recordByAlias.set(alias, record);
	}

	for (const saved of savedSessions) {
		const aliases = savedIdentityAliases(saved);
		const record = aliases.map((alias) => recordByAlias.get(alias)).find(Boolean);
		if (record) {
			record.saved = saved;
			record.identityAliases = [...new Set([...record.identityAliases, ...aliases])];
			record.searchableText = createUnifiedSearchableText(record.daemon, saved);
			for (const alias of aliases) recordByAlias.set(alias, record);
			continue;
		}
		const inactive: UnifiedSessionRecord = {
			saved,
			identity: aliases[0]!,
			identityAliases: aliases,
			section: "inactive",
			searchableText: createUnifiedSearchableText(undefined, saved),
		};
		records.push(inactive);
		for (const alias of aliases) recordByAlias.set(alias, inactive);
	}
	return records;
}

/** Convert a merged row to the existing live-row rendering/action shape. */
export function summaryForUnifiedRecord(record: UnifiedSessionRecord): SessionSummary {
	if (record.daemon) {
		const saved = record.saved;
		if (!saved) return record.daemon;
		return {
			...record.daemon,
			sessionName: record.daemon.sessionName ?? saved.name,
			firstMessage: record.daemon.firstMessage ?? saved.firstMessage,
			sessionFile: record.daemon.sessionFile ?? canonicalSessionPath(saved.path),
			parentSessionPath: record.daemon.parentSessionPath ?? saved.parentSessionPath,
			rlmDepth: record.daemon.rlmDepth ?? saved.rlmDepth,
			created: record.daemon.created ?? saved.created.toISOString(),
			modified: record.daemon.modified ?? saved.modified.toISOString(),
			lastActivityAt: record.daemon.lastActivityAt ?? saved.modified.toISOString(),
		};
	}
	const saved = record.saved;
	if (!saved) throw new Error("Unified session record has no daemon or saved source");
	return {
		id: saved.id,
		lifecycle: "archived",
		activity: "idle",
		isSessionActive: false,
		runtimeKind: saved.parentSessionPath ? "subagent" : "top-level",
		rlmDepth: saved.rlmDepth,
		sessionId: saved.id,
		sessionFile: canonicalSessionPath(saved.path),
		parentSessionPath: saved.parentSessionPath,
		sessionName: saved.name,
		cwd: saved.cwd,
		isStreaming: false,
		isCompacting: false,
		attachedClients: 0,
		messageCount: saved.messageCount,
		sessionActions: { queuedCount: 0, steering: [], followUps: [] },
		created: saved.created.toISOString(),
		modified: saved.modified.toISOString(),
		lastActivityAt: saved.modified.toISOString(),
		firstMessage: saved.firstMessage,
		summary: saved.agentStatus?.summary,
		taskState: saved.agentStatus?.taskState,
	};
}

export function transitionAgentsViewScope(
	frames: readonly AgentsViewScopeFrame[],
	action: AgentsViewScopeAction,
): AgentsViewScopeFrame[] {
	if (action.type === "back") return frames.slice(0, -1);
	const nextFrame = { scope: action.scope, ...(action.returnChat ? { returnChat: action.returnChat } : {}) };
	if (frames.at(-1)?.scope.sessionId !== action.scope.sessionId) return [...frames, nextFrame];
	return [...frames.slice(0, -1), nextFrame];
}

export function resolveAgentsViewLeftResult(
	scopeRoot: SessionSummary | undefined,
	expandedAncestorSessionIds: string[] = [],
	returnChat?: SessionSummary,
): AgentsViewScopeBackResult | undefined {
	if (!scopeRoot) return undefined;
	return {
		type: "scope_back",
		selection: scopeRoot,
		expandedAncestorSessionIds,
		...(returnChat?.sessionId === scopeRoot.sessionId ? { returnChat: scopeRoot } : {}),
	};
}

export function shouldApplyScopeResolution(
	droppedFrames: number,
	liveCatalogReady: boolean,
	savedCatalogReady: boolean,
): boolean {
	return droppedFrames === 0 || (liveCatalogReady && savedCatalogReady);
}

export function createUnattachableChildOpenResult(
	child: SessionSummary,
	parent: SessionSummary,
	expandedAncestorSessionIds: readonly string[],
	hasChildren: boolean,
): UnattachableChildOpenResult {
	return {
		type: "open",
		summary: parent,
		selection: child,
		expandedAncestorSessionIds: [...expandedAncestorSessionIds],
		hasChildren,
		statusMessage: "Child session is unavailable; opened its parent instead",
	};
}

export function resolveAgentsViewScopeFrames(
	records: readonly UnifiedSessionRecord[],
	frames: readonly AgentsViewScopeFrame[],
	index: UnifiedSessionIndex = buildUnifiedSessionIndex(records),
): AgentsViewScopeResolution {
	if (frames.length === 0) return { frames: [], droppedFrames: 0 };
	for (let frameIndex = frames.length - 1; frameIndex >= 0; frameIndex--) {
		const frame = frames[frameIndex]!;
		const root = findScopeRecord(frame.scope, index.byKey);
		if (!root) continue;
		return {
			frames: frames.slice(0, frameIndex + 1),
			root,
			droppedFrames: frames.length - frameIndex - 1,
		};
	}
	return { frames: [], droppedFrames: frames.length };
}

/** Restrict records to the scoped root and every descendant of that root. */
export function scopeToSessionSubtree(
	records: readonly UnifiedSessionRecord[],
	scope: AgentsViewScopeKey | undefined,
	index: UnifiedSessionIndex = buildUnifiedSessionIndex(records),
): UnifiedSessionRecord[] {
	if (!scope) return [...records];
	const root = findScopeRecord(scope, index.byKey);
	if (!root) return [];
	const retained = new Set<UnifiedSessionRecord>();
	const queue = [root];
	for (let queueIndex = 0; queueIndex < queue.length; queueIndex++) {
		const current = queue[queueIndex]!;
		if (retained.has(current)) continue;
		retained.add(current);
		queue.push(...(index.childrenByParent.get(current) ?? []));
	}
	return records.filter((record) => retained.has(record));
}

export function hasUnifiedSessionChildren(
	records: readonly UnifiedSessionRecord[],
	scope: AgentsViewScopeKey,
	index: UnifiedSessionIndex = buildUnifiedSessionIndex(records),
): boolean {
	const root = findScopeRecord(scope, index.byKey);
	return root !== undefined && (index.childrenByParent.get(root)?.length ?? 0) > 0;
}

export function getUnifiedSessionAncestorSessionIds(
	records: readonly UnifiedSessionRecord[],
	scope: AgentsViewScopeKey,
	index: UnifiedSessionIndex = buildUnifiedSessionIndex(records),
): string[] {
	const root = findScopeRecord(scope, index.byKey);
	if (!root) return [];
	const ancestors: string[] = [];
	const visited = new Set<UnifiedSessionRecord>([root]);
	let current = findParentRecord(root, index.byKey);
	while (current && !visited.has(current)) {
		visited.add(current);
		ancestors.unshift(summaryForUnifiedRecord(current).sessionId);
		current = findParentRecord(current, index.byKey);
	}
	return ancestors;
}

export function filterUnifiedSessions(
	records: readonly UnifiedSessionRecord[],
	matches: (searchableText: string) => boolean,
): UnifiedSessionRecord[] {
	const index = buildUnifiedSessionIndex(records);
	const retained = new Set<UnifiedSessionRecord>();
	for (const record of records) {
		if (!matches(record.searchableText)) continue;
		let current: UnifiedSessionRecord | undefined = record;
		while (current && !retained.has(current)) {
			retained.add(current);
			current = findParentRecord(current, index.byKey);
		}
	}
	// Keep catalog order and the original records so row ranking and sections
	// remain authoritative while ancestors provide the hierarchy for matches.
	return records.filter((record) => retained.has(record));
}

export interface UnifiedSessionIndex {
	byKey: Map<string, UnifiedSessionRecord>;
	childrenByParent: Map<UnifiedSessionRecord, UnifiedSessionRecord[]>;
}

export function buildUnifiedSessionIndex(records: readonly UnifiedSessionRecord[]): UnifiedSessionIndex {
	const byKey = new Map<string, UnifiedSessionRecord>();
	for (const record of records) {
		for (const key of record.identityAliases) byKey.set(key, record);
	}
	const childrenByParent = new Map<UnifiedSessionRecord, UnifiedSessionRecord[]>();
	for (const record of records) {
		const parent = findParentRecord(record, byKey);
		if (!parent || parent === record) continue;
		const children = childrenByParent.get(parent) ?? [];
		children.push(record);
		childrenByParent.set(parent, children);
	}
	return { byKey, childrenByParent };
}

/**
 * Row identities flip when a session gains a sessionFile (active→persisted) or
 * is re-attached; the old identity survives as an alias. Rewrite stale entries
 * in a persisted identity set to the current record identity. Entries with no
 * alias match are kept: their record may not have streamed in yet.
 */
export function migrateAgentsViewIdentitySet(
	identities: Set<string>,
	byKey: ReadonlyMap<string, UnifiedSessionRecord>,
): void {
	for (const identity of [...identities]) {
		const record = byKey.get(identity);
		if (!record || record.identity === identity) continue;
		identities.delete(identity);
		identities.add(record.identity);
	}
}

function findScopeRecord(
	scope: AgentsViewScopeKey,
	byKey: ReadonlyMap<string, UnifiedSessionRecord>,
): UnifiedSessionRecord | undefined {
	if (scope.activeSessionId) {
		const active = byKey.get(`active:${scope.activeSessionId}`);
		if (active) return active;
	}
	return byKey.get(`session:${scope.sessionId}`);
}

function findParentRecord(
	record: UnifiedSessionRecord,
	byKey: ReadonlyMap<string, UnifiedSessionRecord>,
): UnifiedSessionRecord | undefined {
	const daemonKeys = record.daemon ? getParentKeys(record.daemon) : [];
	const savedKey = record.saved?.parentSessionPath ? fileIdentity(record.saved.parentSessionPath) : undefined;
	for (const key of savedKey ? [...daemonKeys, savedKey] : daemonKeys) {
		const parent = byKey.get(key);
		if (parent) return parent;
	}
	return undefined;
}

export function aggregateSessionHeartbeats(
	summaries: readonly SessionSummary[],
	heartbeats: readonly AgentConnectionHeartbeat[],
): ReadonlyMap<string, UnifiedSessionHeartbeat> {
	const summaryByKey = new Map<string, SessionSummary>();
	for (const summary of summaries) {
		for (const key of getSummaryKeys(summary)) summaryByKey.set(key, summary);
	}
	const jobIdsByOwner = new Map<string, Set<string>>();
	const nextRunByJob = new Map<string, string>();
	const add = (owner: string, jobId: string): void => {
		const ids = jobIdsByOwner.get(owner) ?? new Set<string>();
		ids.add(jobId);
		jobIdsByOwner.set(owner, ids);
	};
	for (const heartbeat of heartbeats) {
		const job = heartbeat.job;
		if (job.status !== "active") continue;
		if (job.nextRunAt && Number.isFinite(Date.parse(job.nextRunAt))) nextRunByJob.set(job.id, job.nextRunAt);
		let summary = summaryByKey.get(`active:${job.activeSessionId}`);
		const visited = new Set<string>();
		if (!summary) add(job.activeSessionId, job.id);
		while (summary) {
			const owner = summary.activeSessionId ?? summary.id;
			if (visited.has(owner)) break;
			visited.add(owner);
			add(owner, job.id);
			summary = findParentSummary(summary, summaryByKey);
		}
	}
	const result = new Map<string, UnifiedSessionHeartbeat>();
	for (const [owner, jobIds] of jobIdsByOwner) {
		const nextRunAt = [...jobIds]
			.map((jobId) => nextRunByJob.get(jobId))
			.filter((value): value is string => value !== undefined)
			.sort((a, b) => Date.parse(a) - Date.parse(b))[0];
		result.set(owner, { activeCount: jobIds.size, ...(nextRunAt ? { nextRunAt } : {}) });
	}
	return result;
}

export function formatHeartbeatBadge(heartbeat: UnifiedSessionHeartbeat | undefined, now = Date.now()): string {
	if (!heartbeat || heartbeat.activeCount < 1) return "";
	const next = heartbeat.nextRunAt ? Date.parse(heartbeat.nextRunAt) : Number.NaN;
	const countdown = Number.isFinite(next) ? formatHeartbeatCountdown(next - now) : undefined;
	return `♥ ${heartbeat.activeCount}${countdown ? `·${countdown}` : ""}`;
}

function formatHeartbeatCountdown(durationMs: number): string {
	const seconds = Math.max(1, Math.round(Math.max(0, durationMs) / 1000));
	if (seconds < 60) return `${seconds}s`;
	const minutes = Math.round(seconds / 60);
	if (minutes < 60) return `${minutes}m`;
	const hours = Math.round(minutes / 60);
	if (hours < 24) return `${hours}h`;
	return `${Math.round(hours / 24)}d`;
}

function findParentSummary(
	summary: SessionSummary,
	byKey: ReadonlyMap<string, SessionSummary>,
): SessionSummary | undefined {
	for (const key of getParentKeys(summary)) {
		const parent = byKey.get(key);
		if (parent) return parent;
	}
	return undefined;
}

function getParentKeys(summary: SessionSummary): string[] {
	return [
		summary.parentActiveSessionId ? `active:${summary.parentActiveSessionId}` : undefined,
		summary.parentSessionId ? `session:${summary.parentSessionId}` : undefined,
		summary.parentSessionPath ? fileIdentity(summary.parentSessionPath) : undefined,
	].filter((key): key is string => key !== undefined);
}

export function getAgentsViewSummaryIdentity(summary: SessionSummary): string {
	if (summary.sessionFile) {
		return fileIdentity(summary.sessionFile);
	}
	if (summary.activeSessionId) {
		return `active:${summary.activeSessionId}`;
	}
	return `session:${summary.sessionId}`;
}

export interface AgentsViewSelectionKey {
	sessionId: string;
	activeSessionId?: string;
}

export function getAgentsViewSelectionKey(summary: SessionSummary): AgentsViewSelectionKey {
	return { sessionId: summary.sessionId, activeSessionId: summary.activeSessionId };
}

// Matches by identity, then activeSessionId, then sessionId: a row's identity
// changes when a session is persisted or re-attached, so the latter two keys
// re-find the same session across those transitions. Returns -1 when gone.
export function resolveAgentsViewSelectionIndex(
	rows: readonly AgentsViewRow[],
	identity: string | undefined,
	key: AgentsViewSelectionKey | undefined,
): number {
	const findSelectable = (predicate: (row: AgentsViewRow) => boolean): number =>
		rows.findIndex((row) => row.selectable && predicate(row));

	if (identity !== undefined) {
		const index = findSelectable((row) => row.identity === identity);
		// Synthetic nested rows deliberately reuse their parent's session key, so
		// their exact row identity must win over the active-runtime fallback.
		if (index >= 0 && rows[index]?.kind !== "agent") {
			return index;
		}
	}
	if (key?.activeSessionId !== undefined) {
		const activeSessionId = key.activeSessionId;
		const index = findSelectable((row) => (row.summary.activeSessionId ?? row.summary.id) === activeSessionId);
		if (index >= 0) {
			return index;
		}
	}
	if (identity !== undefined) {
		const index = findSelectable((row) => row.identity === identity);
		if (index >= 0) {
			return index;
		}
	}
	if (key?.sessionId !== undefined) {
		const sessionId = key.sessionId;
		return findSelectable((row) => row.summary.sessionId === sessionId);
	}
	return -1;
}

export interface AgentsViewSelectionResolution {
	index: number;
	resolved: boolean;
}

export function resolveAgentsViewSelectionState(
	rows: readonly AgentsViewRow[],
	currentIndex: number,
	identity: string | undefined,
	key: AgentsViewSelectionKey | undefined,
): AgentsViewSelectionResolution {
	if (rows.length === 0) return { index: 0, resolved: false };
	const resolvedIndex = resolveAgentsViewSelectionIndex(rows, identity, key);
	if (resolvedIndex >= 0) return { index: resolvedIndex, resolved: true };
	const boundedIndex = Math.max(0, Math.min(currentIndex, rows.length - 1));
	if (rows[boundedIndex]?.selectable) return { index: boundedIndex, resolved: false };
	const firstSelectable = rows.findIndex((row) => row.selectable);
	return { index: firstSelectable >= 0 ? firstSelectable : 0, resolved: false };
}

export function buildAgentsViewRows(
	summariesOrRecords: readonly (SessionSummary | UnifiedSessionRecord)[],
	expandedSubagentParents: ReadonlySet<string> = new Set(),
	programShownParents: ReadonlySet<string> = new Set(),
	scope?: AgentsViewScopeKey,
): AgentsViewRow[] {
	const inputs = summariesOrRecords.map((input) =>
		isUnifiedSessionRecord(input) ? { summary: summaryForUnifiedRecord(input), record: input } : { summary: input },
	);
	const scopeRoot = scope
		? inputs.find(
				({ summary }) =>
					summary.sessionId === scope.sessionId ||
					(scope.activeSessionId !== undefined && summary.activeSessionId === scope.activeSessionId),
			)
		: undefined;
	const scopeRootKeys = new Set(
		scopeRoot ? (scopeRoot.record?.identityAliases ?? getSummaryKeys(scopeRoot.summary)) : [],
	);
	const isDirectScopeChild = (summary: SessionSummary): boolean =>
		scopeRoot !== undefined && getParentKeys(summary).some((key) => scopeRootKeys.has(key));
	const baseRows = inputs.map(
		({ summary, record }): MutableAgentsViewRow => ({
			kind: isSubagentSummary(summary) && !isDirectScopeChild(summary) ? "subagent" : "agent",
			section: record?.section ?? classifyAgentsViewSession(summary),
			summary,
			title: getAgentsViewSessionTitle(summary),
			subtitle: getSessionSubtitle(summary),
			statusLabel: getSessionStatusLabel(summary),
			depth: 0,
			selectable: true,
			runningSubagentCount: 0,
			identity: record?.identity ?? getAgentsViewSummaryIdentity(summary),
			...(record ? { record, heartbeat: record.heartbeat } : {}),
		}),
	);
	const rowsByKey = buildRowKeyMap(baseRows);
	const childrenByParent = new Map<MutableAgentsViewRow, MutableAgentsViewRow[]>();
	const parentByChild = new Map<MutableAgentsViewRow, MutableAgentsViewRow>();
	const nestedRows = new Set<MutableAgentsViewRow>();

	for (const row of baseRows) {
		if (row.kind !== "subagent") {
			continue;
		}
		const parent = findParentRow(row.summary, rowsByKey);
		if (!parent || parent === row) {
			// Saved catalogs stream progressively, so a child can arrive before its
			// parent. Keep it reachable as a root until the parent record appears.
			row.kind = "agent";
			continue;
		}
		nestedRows.add(row);
		parentByChild.set(row, parent);
		if (row.section === "running") {
			parent.runningSubagentCount += 1;
		}
		const siblings = childrenByParent.get(parent) ?? [];
		siblings.push(row);
		childrenByParent.set(parent, siblings);
	}
	propagateHeartbeatStateToAncestors(baseRows, parentByChild);

	const roots = baseRows.filter((row) => !nestedRows.has(row));
	const flattened: AgentsViewRow[] = [];
	const emit = (row: MutableAgentsViewRow, depth: number): void => {
		row.depth = depth;
		flattened.push(row);
		const children = childrenByParent.get(row) ?? [];
		if (children.length === 0) {
			return;
		}
		const childHasSpawnCode = children.some((child) => hasSpawnCode(child.summary));
		const expanded = expandedSubagentParents.has(row.identity);
		flattened.push(createSubagentSummaryRow(row, children, depth + 1, childHasSpawnCode, expanded));
		if (!expanded) {
			return;
		}
		const showProgram = programShownParents.has(row.identity);
		const groups = groupChildrenBySpawnCode(children.sort(compareAgentsViewRows));
		for (const [groupIndex, group] of groups.entries()) {
			if (showProgram && group.spawnCode) {
				for (const codeRow of buildSpawnCodeRows(row, group.spawnCode, depth + 1, groupIndex)) {
					flattened.push(codeRow);
				}
			}
			for (const child of group.children) {
				child.parentIdentity = row.identity;
				emit(child, depth + 1);
			}
		}
	};
	const scopedRootRow = scopeRoot ? baseRows.find((row) => row.summary === scopeRoot.summary) : undefined;
	const visibleRoots = scopedRootRow ? roots.filter((row) => row !== scopedRootRow) : roots;
	for (const root of visibleRoots.sort(compareAgentsViewRows)) {
		emit(root, 0);
	}
	return flattened;
}

function isUnifiedSessionRecord(value: SessionSummary | UnifiedSessionRecord): value is UnifiedSessionRecord {
	return "identityAliases" in value;
}

function propagateHeartbeatStateToAncestors(
	rows: readonly MutableAgentsViewRow[],
	parentByChild: ReadonlyMap<MutableAgentsViewRow, MutableAgentsViewRow>,
): void {
	for (const row of rows) {
		if (!row.summary.hasActiveHeartbeat) {
			continue;
		}
		const visited = new Set<MutableAgentsViewRow>([row]);
		let ancestor = parentByChild.get(row);
		while (ancestor && !visited.has(ancestor)) {
			visited.add(ancestor);
			ancestor.section = "running";
			ancestor.statusLabel = getSessionStatusLabel(ancestor.summary, true);
			ancestor = parentByChild.get(ancestor);
		}
	}
}

type MutableAgentsViewRow = AgentsViewRow;

function createSubagentSummaryRow(
	parent: AgentsViewRow,
	children: readonly AgentsViewRow[],
	depth: number,
	hasSpawnCode: boolean,
	expanded: boolean,
): AgentsViewRow {
	const totalCount = children.length;
	const running = parent.runningSubagentCount;
	const heartbeatCount = children.filter(
		(child) => child.summary.hasActiveHeartbeat || (child.heartbeat?.activeCount ?? 0) > 0,
	).length;
	// Finished subagents stay reachable through the summary row even when
	// nothing is running anymore.
	const subagentTitle =
		running > 0
			? `${running} ${running === 1 ? "subagent" : "subagents"} running`
			: `${totalCount} ${totalCount === 1 ? "subagent" : "subagents"}`;
	const title =
		heartbeatCount > 0
			? `${subagentTitle} · ${heartbeatCount} ${heartbeatCount === 1 ? "heartbeat" : "heartbeats"} active`
			: subagentTitle;
	return {
		kind: "subagent-summary",
		section: parent.section,
		summary: parent.summary,
		title,
		subtitle: "",
		statusLabel: "",
		depth,
		selectable: true,
		runningSubagentCount: running,
		identity: `subagents:${parent.identity}`,
		parentIdentity: parent.identity,
		hasSpawnCode,
		expanded,
	};
}

function hasSpawnCode(summary: SessionSummary): boolean {
	return typeof summary.spawnCode === "string" && summary.spawnCode.trim().length > 0;
}

interface SpawnCodeGroup {
	/** Shared spawn-cell source for this group, or undefined when unavailable. */
	spawnCode?: string;
	children: MutableAgentsViewRow[];
}

// Subagents spawned by the same IPython cell share its source; group them so
// each spawn cell renders once, above the subagents it launched. Different turns
// produce different cells and therefore distinct groups. Insertion order follows
// each cell's first subagent so groups read top-to-bottom in spawn order.
function groupChildrenBySpawnCode(children: readonly MutableAgentsViewRow[]): SpawnCodeGroup[] {
	const NO_CODE_KEY = " no-spawn-code";
	const groups = new Map<string, SpawnCodeGroup>();
	for (const child of children) {
		const code = hasSpawnCode(child.summary) ? child.summary.spawnCode : undefined;
		const key = code ?? NO_CODE_KEY;
		const group = groups.get(key);
		if (group) {
			group.children.push(child);
		} else {
			groups.set(key, { spawnCode: code, children: [child] });
		}
	}
	return [...groups.values()];
}

function buildSpawnCodeRows(
	parent: AgentsViewRow,
	spawnCode: string,
	depth: number,
	groupIndex: number,
): AgentsViewRow[] {
	const makeRow = (code: string, lineIndex: string): AgentsViewRow => ({
		kind: "subagent-code",
		section: parent.section,
		summary: parent.summary,
		title: "",
		subtitle: "",
		statusLabel: "",
		depth,
		// Code rows are read-only context; selection skips over them.
		selectable: false,
		runningSubagentCount: 0,
		identity: `code:${parent.identity}:${groupIndex}:${lineIndex}`,
		parentIdentity: parent.identity,
		code,
	});
	const allLines = spawnCode.replace(/\s+$/, "").split("\n");
	// Cap the body so a long program can't flood the view; note the remainder.
	const lines = allLines.slice(0, MAX_SPAWN_CODE_LINES).map((line, i) => makeRow(line, String(i)));
	const hidden = allLines.length - lines.length;
	if (hidden > 0) {
		lines.push(makeRow(`… +${hidden} more ${hidden === 1 ? "line" : "lines"}`, "more"));
	}
	// A blank panel line above and below pads the program into a clean block.
	return [makeRow("", "pad-top"), ...lines, makeRow("", "pad-bottom")];
}

function compareAgentsViewRows(a: AgentsViewRow, b: AgentsViewRow): number {
	const sectionDiff = sectionRank(a.section) - sectionRank(b.section);
	if (sectionDiff !== 0) {
		return sectionDiff;
	}
	if (a.section !== "running") {
		const activityDiff = getTimestamp(b.summary.lastActivityAt) - getTimestamp(a.summary.lastActivityAt);
		if (activityDiff !== 0) {
			return activityDiff;
		}
	}
	const createdDiff = getTimestamp(b.summary.created) - getTimestamp(a.summary.created);
	if (createdDiff !== 0) {
		return createdDiff;
	}
	const titleDiff = a.title.localeCompare(b.title);
	if (titleDiff !== 0) {
		return titleDiff;
	}
	return a.summary.sessionId.localeCompare(b.summary.sessionId);
}

function buildRowKeyMap(rows: readonly MutableAgentsViewRow[]): Map<string, MutableAgentsViewRow> {
	const rowsByKey = new Map<string, MutableAgentsViewRow>();
	for (const row of rows) {
		for (const key of getSummaryKeys(row.summary)) {
			rowsByKey.set(key, row);
		}
	}
	return rowsByKey;
}

function getSummaryKeys(summary: SessionSummary): string[] {
	return [
		`active:${summary.activeSessionId ?? summary.id}`,
		`session:${summary.sessionId}`,
		summary.sessionFile ? fileIdentity(summary.sessionFile) : undefined,
	].filter((key): key is string => key !== undefined);
}

function findParentRow(
	summary: SessionSummary,
	rowsByKey: ReadonlyMap<string, MutableAgentsViewRow>,
): MutableAgentsViewRow | undefined {
	for (const key of getParentKeys(summary)) {
		const row = rowsByKey.get(key);
		if (row) return row;
	}
	return undefined;
}

function isSubagentSummary(summary: SessionSummary): boolean {
	if (summary.runtimeKind) {
		return summary.runtimeKind === "subagent";
	}
	// Summaries from daemons that predate runtimeKind still carry subagent
	// linkage; never surface those as top-level agents.
	return Boolean(
		summary.rlmChildId ??
			summary.rlmParentNodeId ??
			summary.parentActiveSessionId ??
			summary.parentSessionId ??
			summary.parentSessionPath,
	);
}

function sectionRank(section: AgentsViewSection): number {
	switch (section) {
		case "running":
			return 0;
		case "idle":
			return 1;
		case "inactive":
			return 2;
		default: {
			const _exhaustive: never = section;
			return _exhaustive;
		}
	}
}

function getTimestamp(value: string | undefined): number {
	if (!value) {
		return 0;
	}
	const timestamp = Date.parse(value);
	return Number.isNaN(timestamp) ? 0 : timestamp;
}

export function getAgentsViewSessionTitle(summary: SessionSummary): string {
	const candidates = [summary.sessionName, summary.firstMessage, basename(summary.cwd), summary.sessionId, summary.id];
	for (const candidate of candidates) {
		const normalized = candidate?.replace(/\s+/g, " ").trim();
		if (normalized) {
			return normalized;
		}
	}
	return "Untitled agent";
}

function getSessionSubtitle(summary: SessionSummary): string {
	const parts = [
		summary.model ? `${summary.model.provider}/${summary.model.id}` : undefined,
		summary.cwd,
		summary.activeSessionId ?? summary.id,
	].filter((part): part is string => part !== undefined && part.length > 0);
	return parts.join("  ");
}

function getSessionStatusLabel(summary: SessionSummary, hasActiveHeartbeat = summary.hasActiveHeartbeat): string {
	if (summary.isCompacting) {
		return "compacting";
	}
	if (summary.isStreaming) {
		return summary.isRunningTools ? "running tools" : "thinking";
	}
	// These classify the session as Running (isAgentsViewSessionBusy); the label
	// must agree with the section instead of claiming the session needs input.
	if (summary.isRunningTools === true) {
		return "running tools";
	}
	if (summary.isBashRunning === true) {
		return "running bash";
	}
	if (summary.hasRunningRlmChildren === true) {
		return "subagents running";
	}
	if (summary.sessionActions.active) {
		return summary.sessionActions.active.label ?? summary.sessionActions.active.kind.replace("_", " ");
	}
	if (summary.sessionActions.queuedCount > 0) {
		return `${summary.sessionActions.queuedCount} queued`;
	}
	if (summary.lifecycle === "archived") {
		return "archived";
	}
	if (hasActiveHeartbeat) {
		return "heartbeat active";
	}
	if (summary.runtimeKind === "subagent" && summary.repliedSinceTask) {
		return "replied";
	}
	if (summary.activity === "working") {
		return "classifying";
	}
	return summary.taskState === "completed" ? "completed" : "needs input";
}

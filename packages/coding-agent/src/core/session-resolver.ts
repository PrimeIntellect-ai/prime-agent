import { matchesSavedSessionSelector, normalizeSessionId } from "./session-id.js";
import type { SessionInfo } from "./session-manager.js";
import { SessionManager } from "./session-manager.js";

export type ResolvedSession =
	| { type: "path"; path: string }
	| { type: "local"; path: string }
	| { type: "global"; path: string; cwd: string };

export class SessionSelectorError extends Error {
	constructor(
		message: string,
		readonly selector: string,
	) {
		super(message);
		this.name = "SessionSelectorError";
	}
}

export class SessionSelectorNotFoundError extends SessionSelectorError {
	constructor(
		selector: string,
		readonly suggestion?: string,
	) {
		super(`No session found matching '${selector}'`, selector);
		this.name = "SessionSelectorNotFoundError";
	}
}

export class SessionSelectorAmbiguousError extends SessionSelectorError {
	constructor(
		selector: string,
		readonly matches: readonly SessionInfo[],
	) {
		super(
			`Ambiguous saved session "${selector}": matches ${matches
				.map((session) => `${session.id}${session.name ? ` (${session.name})` : ""}`)
				.join(", ")}`,
			selector,
		);
		this.name = "SessionSelectorAmbiguousError";
	}
}

export function looksLikeSessionPath(selector: string): boolean {
	return selector.includes("/") || selector.includes("\\") || selector.endsWith(".jsonl");
}

export async function resolveSessionPath(selector: string, cwd: string, sessionDir?: string): Promise<ResolvedSession> {
	if (looksLikeSessionPath(selector)) {
		return { type: "path", path: selector };
	}

	const localSessions = await SessionManager.list(cwd, sessionDir);
	const localExactMatch = resolveExactMatch(selector, localSessions);
	if (localExactMatch) {
		return { type: "local", path: localExactMatch.path };
	}

	const allSessions = await SessionManager.listAll(undefined, sessionDir);
	const globalExactMatch = resolveExactMatch(selector, allSessions);
	if (globalExactMatch) {
		return { type: "global", path: globalExactMatch.path, cwd: globalExactMatch.cwd };
	}

	const localMatch = resolvePartialMatch(selector, localSessions);
	if (localMatch) {
		return { type: "local", path: localMatch.path };
	}

	const globalMatch = resolvePartialMatch(selector, allSessions);
	if (globalMatch) {
		return { type: "global", path: globalMatch.path, cwd: globalMatch.cwd };
	}

	throw new SessionSelectorNotFoundError(selector, findClosestSessionId(selector, [...localSessions, ...allSessions]));
}

export function findClosestSessionId(
	selector: string,
	sessions: readonly Pick<SessionInfo, "id">[],
): string | undefined {
	const normalizedSelector = normalizeSessionId(selector);
	if (normalizedSelector.length < 4) {
		return undefined;
	}

	const uniqueIds = [...new Set(sessions.map((session) => session.id))];
	let closest: { id: string; distance: number } | undefined;
	let tied = false;

	for (const id of uniqueIds) {
		const normalizedId = normalizeSessionId(id);
		const length = Math.min(normalizedSelector.length, normalizedId.length);
		const distance = Math.min(
			editDistance(normalizedSelector, normalizedId.slice(0, length)),
			editDistance(normalizedSelector, normalizedId.slice(-length)),
		);
		if (!closest || distance < closest.distance) {
			closest = { id, distance };
			tied = false;
		} else if (distance === closest.distance) {
			tied = true;
		}
	}

	const maximumDistance = Math.max(1, Math.floor(normalizedSelector.length / 5));
	return closest && !tied && closest.distance <= maximumDistance ? closest.id : undefined;
}

function resolveExactMatch(selector: string, sessions: readonly SessionInfo[]): SessionInfo | undefined {
	const normalizedSelector = normalizeSessionId(selector);
	return resolveUniqueMatch(
		selector,
		sessions.filter((session) => normalizeSessionId(session.id) === normalizedSelector),
	);
}

function resolvePartialMatch(selector: string, sessions: readonly SessionInfo[]): SessionInfo | undefined {
	const matches = sessions.filter((session) => matchesSavedSessionSelector(session.id, selector));
	return resolveUniqueMatch(selector, matches);
}

function resolveUniqueMatch(selector: string, matches: readonly SessionInfo[]): SessionInfo | undefined {
	if (matches.length > 1) {
		throw new SessionSelectorAmbiguousError(selector, matches);
	}
	return matches[0];
}

function editDistance(left: string, right: string): number {
	const previous = Array.from({ length: right.length + 1 }, (_, index) => index);
	for (let leftIndex = 1; leftIndex <= left.length; leftIndex++) {
		let diagonal = previous[0]!;
		previous[0] = leftIndex;
		for (let rightIndex = 1; rightIndex <= right.length; rightIndex++) {
			const above = previous[rightIndex]!;
			previous[rightIndex] = Math.min(
				previous[rightIndex]! + 1,
				previous[rightIndex - 1]! + 1,
				diagonal + (left[leftIndex - 1] === right[rightIndex - 1] ? 0 : 1),
			);
			diagonal = above;
		}
	}
	return previous[right.length]!;
}

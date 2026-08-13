import { createHash } from "node:crypto";
import { type McpDeclaration, type McpDeclarationDocument, parseMcpDeclarationDocument } from "./mcp-declarations.js";
import { type ProjectMcpDeclarationAdmission, validateProjectMcpDeclarationAdmission } from "./mcp-project-trust.js";

export type McpRuntimeDeclarationSource = "user" | "project";

/** A declaration-only record. No credential, auth, transport, or launch state is admitted. */
export interface McpRuntimeDeclaration {
	readonly name: string;
	readonly endpoint: string;
	readonly enabled: boolean;
	readonly source: McpRuntimeDeclarationSource;
}

/**
 * An immutable decision detached from settings and raw project paths. The
 * revision covers the complete ordered selection, including disabled entries.
 */
export interface McpRuntimeDeclarationSnapshot {
	readonly revision: string;
	readonly declarations: Readonly<Record<string, McpRuntimeDeclaration>>;
}

export interface CreateMcpRuntimeDeclarationSnapshotInput {
	/** Already-read user/global declarations. They are parsed before selection. */
	readonly userDocument?: unknown;
	/** Missing, forged, stale, or foreign admissions are fail-closed. */
	readonly projectAdmission?: ProjectMcpDeclarationAdmission;
	/** Never invoked unless the opaque admission validates first. */
	readonly readProjectDocument?: () => unknown;
}

function compareCodePoints(left: string, right: string): number {
	let leftOffset = 0;
	let rightOffset = 0;
	while (leftOffset < left.length && rightOffset < right.length) {
		const leftPoint = left.codePointAt(leftOffset)!;
		const rightPoint = right.codePointAt(rightOffset)!;
		if (leftPoint !== rightPoint) return leftPoint < rightPoint ? -1 : 1;
		leftOffset += leftPoint > 0xffff ? 2 : 1;
		rightOffset += rightPoint > 0xffff ? 2 : 1;
	}
	return leftOffset === left.length && rightOffset === right.length ? 0 : leftOffset === left.length ? -1 : 1;
}

function compareNames(left: McpRuntimeDeclaration, right: McpRuntimeDeclaration): number {
	return compareCodePoints(left.name, right.name);
}

function freezeDeclaration(declaration: McpRuntimeDeclaration): McpRuntimeDeclaration {
	return Object.freeze({
		name: declaration.name,
		endpoint: declaration.endpoint,
		enabled: declaration.enabled,
		source: declaration.source,
	});
}

function parseDocument(value: unknown, source: McpRuntimeDeclarationSource): McpRuntimeDeclaration[] {
	// Reuse the M01 parser: it rejects own accessors, inherited fields, symbols,
	// exotic prototypes, duplicate endpoints, and malformed URL shapes.
	const document: McpDeclarationDocument = parseMcpDeclarationDocument(value);
	const declarations: McpRuntimeDeclaration[] = [];
	for (const name of Object.getOwnPropertyNames(document.servers)) {
		const declaration: McpDeclaration = document.servers[name]!;
		declarations.push({ name: declaration.name, endpoint: declaration.url, enabled: declaration.enabled, source });
	}
	return declarations.sort(compareNames);
}

function snapshotRevision(declarations: readonly McpRuntimeDeclaration[]): string {
	const canonical = declarations.map(({ name, endpoint, enabled, source }) => [name, endpoint, enabled, source]);
	return createHash("sha256")
		.update(JSON.stringify([1, canonical]))
		.digest("hex");
}

/**
 * Select global declarations first. A name or endpoint collision makes the
 * complete project contribution inert, preventing partial shadow-dependent
 * configuration. Both selection and resulting records are frozen snapshots.
 */
export function createMcpRuntimeDeclarationSnapshot(
	input: CreateMcpRuntimeDeclarationSnapshotInput = {},
): McpRuntimeDeclarationSnapshot {
	const user = parseDocument(input.userDocument, "user");
	const selected = [...user];
	const userNames = new Set(user.map((declaration) => declaration.name));
	const userEndpoints = new Set(user.map((declaration) => declaration.endpoint));

	let project: McpRuntimeDeclaration[] | undefined;
	if (input.readProjectDocument) {
		// The first check is deliberately before the callback. A revoked grant
		// therefore cannot cause even the scoped reader to touch project state.
		if (validateProjectMcpDeclarationAdmission(input.projectAdmission).kind === "granted") {
			const rawProjectDocument = input.readProjectDocument();
			// A root swap during the callback is fail-closed before parsing or use.
			if (validateProjectMcpDeclarationAdmission(input.projectAdmission).kind === "granted") {
				const parsedProject = parseDocument(rawProjectDocument, "project");
				// Parsing can invoke no declarations, but it is still between trust
				// decisions: do not retain data if validity changed meanwhile.
				if (validateProjectMcpDeclarationAdmission(input.projectAdmission).kind === "granted") {
					project = parsedProject;
				}
			}
		}
	}
	if (
		project &&
		!project.some((declaration) => userNames.has(declaration.name) || userEndpoints.has(declaration.endpoint))
	) {
		selected.push(...project);
	}

	selected.sort(compareNames);
	const declarations = Object.create(null) as Record<string, McpRuntimeDeclaration>;
	for (const declaration of selected) {
		Object.defineProperty(declarations, declaration.name, {
			value: freezeDeclaration(declaration),
			enumerable: true,
			configurable: false,
			writable: false,
		});
	}
	const snapshot = Object.freeze({ revision: snapshotRevision(selected), declarations: Object.freeze(declarations) });
	// Validate after freezing, immediately before publication. A swap at any
	// point from callback entry through immutable-output construction leaves only
	// the independent user contribution.
	if (project && validateProjectMcpDeclarationAdmission(input.projectAdmission).kind !== "granted") {
		const userDeclarations = Object.create(null) as Record<string, McpRuntimeDeclaration>;
		for (const declaration of user) {
			Object.defineProperty(userDeclarations, declaration.name, {
				value: freezeDeclaration(declaration),
				enumerable: true,
				configurable: false,
				writable: false,
			});
		}
		return Object.freeze({
			revision: snapshotRevision(user),
			declarations: Object.freeze(userDeclarations),
		});
	}
	return snapshot;
}

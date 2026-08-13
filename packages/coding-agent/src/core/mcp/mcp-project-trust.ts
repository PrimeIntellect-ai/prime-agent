import { emptyMcpDeclarationDocument, type McpDeclarationDocument } from "./mcp-declarations.js";
import type {
	McpProjectTrustAuthority,
	McpProjectTrustAuthorization,
	McpProjectTrustBinding,
	McpProjectTrustBindingValidation,
} from "./project-trust-authority.js";
import {
	isMcpProjectTrustAuthority,
	releaseMcpProjectTrustBinding,
	withValidatedMcpProjectTrustBinding,
} from "./project-trust-authority.js";

/** A branded, empty capability whose trust pair stays module-private. */
export interface ProjectMcpDeclarationAdmission {}
interface AdmissionPair {
	readonly authority: McpProjectTrustAuthority;
	readonly binding: McpProjectTrustBinding;
}
const admissions = new WeakSet<object>();
const releasedAdmissions = new WeakSet<object>();
const admissionPairs = new WeakMap<object, AdmissionPair>();
const DENIED: McpProjectTrustBindingValidation = Object.freeze({ kind: "denied" });
const GRANTED: McpProjectTrustBindingValidation = Object.freeze({ kind: "granted" });

function pairFor(admission: ProjectMcpDeclarationAdmission | undefined): AdmissionPair | undefined {
	// Membership strictly precedes map access: no forged accessor runs.
	if (
		typeof admission !== "object" ||
		admission === null ||
		!admissions.has(admission) ||
		releasedAdmissions.has(admission)
	)
		return undefined;
	return admissionPairs.get(admission);
}

export function admitProjectMcpDeclarations(
	rawProjectDirectory: string,
	authority: McpProjectTrustAuthority | undefined,
): ProjectMcpDeclarationAdmission | undefined {
	if (!isMcpProjectTrustAuthority(authority)) return undefined;
	let authorization: McpProjectTrustAuthorization;
	try {
		authorization = authority.authorizeProjectDirectory(rawProjectDirectory);
	} catch {
		return undefined;
	}
	if (authorization.kind !== "granted") return undefined;
	// The authority minted and owns the descriptor before publishing this opaque admission.
	if (withValidatedMcpProjectTrustBinding(authorization.binding, () => true) !== true) {
		releaseMcpProjectTrustBinding(authorization.binding);
		return undefined;
	}
	const admission = Object.freeze(Object.create(null));
	admissions.add(admission);
	admissionPairs.set(admission, Object.freeze({ authority, binding: authorization.binding }));
	return admission as ProjectMcpDeclarationAdmission;
}

export function releaseProjectMcpDeclarationAdmission(admission: ProjectMcpDeclarationAdmission | undefined): void {
	const pair = pairFor(admission);
	if (!pair || !admission || releasedAdmissions.has(admission as object)) return;
	releasedAdmissions.add(admission as object);
	releaseMcpProjectTrustBinding(pair.binding);
}

export function validateProjectMcpDeclarationAdmission(
	admission: ProjectMcpDeclarationAdmission | undefined,
): McpProjectTrustBindingValidation {
	const pair = pairFor(admission);
	if (!pair) return DENIED;
	try {
		return pair.authority.validateBinding(pair.binding).kind === "granted" ? GRANTED : DENIED;
	} catch {
		return DENIED;
	}
}

/** The only descriptor route from a genuine admission; it never reopens cwd. */
export function withValidatedProjectMcpDeclarationAdmission<T>(
	admission: ProjectMcpDeclarationAdmission | undefined,
	operation: (rootFd: number) => T,
): T | undefined {
	const pair = pairFor(admission);
	if (!pair || validateProjectMcpDeclarationAdmission(admission).kind !== "granted") return undefined;
	try {
		return withValidatedMcpProjectTrustBinding(pair.binding, operation);
	} catch {
		return undefined;
	}
}

export function requireProjectMcpDeclarationAdmission(
	admission: ProjectMcpDeclarationAdmission | undefined,
): ProjectMcpDeclarationAdmission {
	if (validateProjectMcpDeclarationAdmission(admission).kind !== "granted")
		throw new Error("Project MCP declarations are unavailable.");
	return admission!;
}

export interface ProjectMcpDeclarations {
	document: McpDeclarationDocument;
	effective: boolean;
}
export function resolveProjectMcpDeclarations(
	document: McpDeclarationDocument,
	admission: ProjectMcpDeclarationAdmission | undefined,
): ProjectMcpDeclarations {
	if (validateProjectMcpDeclarationAdmission(admission).kind !== "granted")
		return { document: emptyMcpDeclarationDocument(), effective: false };
	return { document: structuredClone(document), effective: true };
}

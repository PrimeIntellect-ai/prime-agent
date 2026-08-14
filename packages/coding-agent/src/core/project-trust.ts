import { dirname } from "node:path";
import { canonicalizeDirectory } from "../utils/paths.js";
import {
	hasTrustRequiringProjectResources,
	type ProjectTrustDecision,
	type ProjectTrustStore,
} from "./trust-manager.js";

export type DefaultProjectTrust = "ask" | "always" | "never";

export type ProjectTrustSelection =
	| "trust"
	| "trust-parent"
	| "trust-session"
	| "do-not-trust"
	| "do-not-trust-session";

export interface ProjectTrustSelectionContext {
	cwd: string;
	parentCwd: string;
}

export interface ResolveProjectTrustedOptions {
	cwd: string;
	trustStore: ProjectTrustStore;
	trustOverride?: boolean;
	defaultProjectTrust?: DefaultProjectTrust;
	interactive: boolean;
	selectDecision?: (context: ProjectTrustSelectionContext) => Promise<ProjectTrustSelection | undefined>;
	onDiagnostic?: (message: string) => void;
}

export function parseDefaultProjectTrust(value: unknown): DefaultProjectTrust {
	return value === "always" || value === "never" ? value : "ask";
}

function reportTrustDiagnostic(options: ResolveProjectTrustedOptions, error: unknown): void {
	const message = error instanceof Error ? error.message : String(error);
	const diagnostic = `Project trust could not be read; treating ${options.cwd} as untrusted: ${message}`;
	if (options.onDiagnostic) {
		options.onDiagnostic(diagnostic);
		return;
	}
	console.error(diagnostic);
}

export async function resolveProjectTrusted(options: ResolveProjectTrustedOptions): Promise<boolean> {
	if (options.trustOverride !== undefined) {
		return options.trustOverride;
	}

	let savedDecision: ProjectTrustDecision;
	try {
		savedDecision = options.trustStore.get(options.cwd);
	} catch (error) {
		reportTrustDiagnostic(options, error);
		return false;
	}
	if (savedDecision !== null) {
		return savedDecision;
	}

	const defaultProjectTrust = options.defaultProjectTrust ?? "ask";
	if (defaultProjectTrust === "always") {
		return true;
	}
	if (defaultProjectTrust === "never" || !options.interactive || !options.selectDecision) {
		return false;
	}

	// Nothing here or in an ancestor is gated by trust, so there is no decision to ask for.
	if (!hasTrustRequiringProjectResources(options.cwd)) {
		return false;
	}

	// Canonical, because the store keys decisions canonically and resolves them by walking the
	// canonical ancestry: a lexical parent of a symlinked cwd would never be found again.
	const parentCwd = dirname(canonicalizeDirectory(options.cwd));
	const selection = await options.selectDecision({ cwd: options.cwd, parentCwd });
	switch (selection) {
		case "trust":
			options.trustStore.set(options.cwd, true);
			return true;
		case "trust-parent":
			options.trustStore.set(parentCwd, true);
			return true;
		case "trust-session":
			return true;
		case "do-not-trust":
			options.trustStore.set(options.cwd, false);
			return false;
		case "do-not-trust-session":
		case undefined:
			return false;
	}
}

import type { ToolStatus } from "./index.js";

export interface RetainedMeta {
	version: number;
	status: ToolStatus;
}

export const KNOWN_STATUSES: ReadonlySet<string> = new Set(["active", "flagged", "disabled", "archived"]);

/**
 * Parse `metadata.prime-agent.retained` from already-parsed frontmatter.
 *
 * Returns `null` when the block is absent, null, or a non-object (the skill is
 * a plain skill). Otherwise returns `{version, status}` with per-field
 * validation: an invalid `version` falls back to `1`, an invalid `status` to
 * `"active"`. Malformed values never throw and never produce diagnostics —
 * loader leniency is a feature of the additive retained-frontmatter contract
 * (see docs/retained-tools/frontmatter-contract.md).
 */
export function parseRetainedMeta(frontmatter: Record<string, unknown> | undefined | null): RetainedMeta | null {
	if (typeof frontmatter !== "object" || frontmatter === null) {
		return null;
	}
	const metadata = frontmatter.metadata;
	if (typeof metadata !== "object" || metadata === null) {
		return null;
	}
	const primeAgent = (metadata as Record<string, unknown>)["prime-agent"];
	if (typeof primeAgent !== "object" || primeAgent === null) {
		return null;
	}
	const retained = (primeAgent as Record<string, unknown>).retained;
	if (typeof retained !== "object" || retained === null || Array.isArray(retained)) {
		return null;
	}

	const meta: RetainedMeta = { version: 1, status: "active" };
	const version = (retained as Record<string, unknown>).version;
	if (typeof version === "number" && Number.isInteger(version) && version > 0) {
		meta.version = version;
	}
	const status = (retained as Record<string, unknown>).status;
	if (typeof status === "string" && KNOWN_STATUSES.has(status)) {
		meta.status = status as ToolStatus;
	}
	return meta;
}

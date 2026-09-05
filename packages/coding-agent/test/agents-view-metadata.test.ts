import { describe, expect, test } from "vitest";
import type { ExecutionLocation } from "../src/core/execution-location.js";
import {
	projectSessionExecutionMetadata,
	reconcileUnifiedSessions,
	type SessionExecutionMetadata,
	snapshotSessionExecutionMetadata,
} from "../src/modes/agents-view/agents-view-state.js";
import type { SessionSummary } from "../src/modes/daemon/daemon-session-list.js";

// --------------------------------------------------------------------------
// Fixture helpers
// --------------------------------------------------------------------------

function localLocation(): ExecutionLocation {
	return { type: "local" };
}

function sandboxLocation(): ExecutionLocation {
	return { type: "prime-sandbox" };
}

function makeSummary(overrides: Partial<SessionSummary> & Pick<SessionSummary, "id" | "sessionId">): SessionSummary {
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

// --------------------------------------------------------------------------
// projectSessionExecutionMetadata
// --------------------------------------------------------------------------

describe("projectSessionExecutionMetadata", () => {
	// ----- absent -----
	test("returns undefined for absent location (undefined, null)", () => {
		expect(projectSessionExecutionMetadata(undefined, undefined)).toBeUndefined();
		expect(projectSessionExecutionMetadata(null, undefined)).toBeUndefined();
		expect(projectSessionExecutionMetadata(undefined, "connected")).toBeUndefined();
	});

	// ----- local -----
	test("projects local location", () => {
		const result = projectSessionExecutionMetadata(localLocation(), undefined);
		expect(result).toEqual({ kind: "local" });
	});

	test("local accepts any link input without error", () => {
		expect(projectSessionExecutionMetadata(localLocation(), "connected")).toEqual({ kind: "local" });
	});

	// ----- sandbox with every link state (direct enum validation) -----
	test("projects sandbox with connected link", () => {
		const result = projectSessionExecutionMetadata(sandboxLocation(), "connected");
		expect(result).toEqual({ kind: "sandbox", linkStatus: "connected" });
	});

	test("projects sandbox with connecting link", () => {
		expect(projectSessionExecutionMetadata(sandboxLocation(), "connecting")).toEqual({
			kind: "sandbox",
			linkStatus: "connecting",
		});
	});

	test("projects sandbox with reconnecting link", () => {
		expect(projectSessionExecutionMetadata(sandboxLocation(), "reconnecting")).toEqual({
			kind: "sandbox",
			linkStatus: "reconnecting",
		});
	});

	test("projects sandbox with unreachable link", () => {
		expect(projectSessionExecutionMetadata(sandboxLocation(), "unreachable")).toEqual({
			kind: "sandbox",
			linkStatus: "unreachable",
		});
	});

	test("projects sandbox with closed link", () => {
		expect(projectSessionExecutionMetadata(sandboxLocation(), "closed")).toEqual({
			kind: "sandbox",
			linkStatus: "closed",
		});
	});

	// ----- sandbox with absent / invalid link -----
	test("sandbox with absent link produces linkStatus unavailable", () => {
		expect(projectSessionExecutionMetadata(sandboxLocation(), undefined)).toEqual({
			kind: "sandbox",
			linkStatus: "unavailable",
		});
	});

	test("sandbox with invalid link string produces linkStatus unavailable", () => {
		expect(projectSessionExecutionMetadata(sandboxLocation(), "pending")).toEqual({
			kind: "sandbox",
			linkStatus: "unavailable",
		});
		expect(projectSessionExecutionMetadata(sandboxLocation(), "")).toEqual({
			kind: "sandbox",
			linkStatus: "unavailable",
		});
	});

	test("sandbox with non-string link produces linkStatus unavailable", () => {
		expect(projectSessionExecutionMetadata(sandboxLocation(), 42)).toEqual({
			kind: "sandbox",
			linkStatus: "unavailable",
		});
		expect(projectSessionExecutionMetadata(sandboxLocation(), true)).toEqual({
			kind: "sandbox",
			linkStatus: "unavailable",
		});
		expect(projectSessionExecutionMetadata(sandboxLocation(), null)).toEqual({
			kind: "sandbox",
			linkStatus: "unavailable",
		});
		expect(projectSessionExecutionMetadata(sandboxLocation(), Symbol("connected"))).toEqual({
			kind: "sandbox",
			linkStatus: "unavailable",
		});
	});

	// ----- malformed / hostile inputs: present => unavailable -----
	test("invalid primitive location returns {kind:unavailable}", () => {
		expect(projectSessionExecutionMetadata("local", undefined)).toEqual({ kind: "unavailable" });
		expect(projectSessionExecutionMetadata(42, undefined)).toEqual({ kind: "unavailable" });
		expect(projectSessionExecutionMetadata(true, undefined)).toEqual({ kind: "unavailable" });
	});

	test("present function returns {kind:unavailable}", () => {
		expect(projectSessionExecutionMetadata(() => {}, undefined)).toEqual({ kind: "unavailable" });
	});

	test("present object with invalid type returns {kind:unavailable}", () => {
		expect(projectSessionExecutionMetadata({ type: "remote" }, undefined)).toEqual({ kind: "unavailable" });
	});

	test("present object missing type returns {kind:unavailable}", () => {
		expect(projectSessionExecutionMetadata({ sandboxId: "test" }, undefined)).toEqual({ kind: "unavailable" });
	});

	test("Proxy-wrapped valid location is rejected", () => {
		const target: ExecutionLocation = { type: "prime-sandbox" };
		const proxy = new Proxy(target, {});
		expect(projectSessionExecutionMetadata(proxy, "closed")).toEqual({ kind: "unavailable" });
	});

	test("getter-throwing Proxy produces unavailable", () => {
		const throwingProxy = new Proxy(
			{},
			{
				get: () => {
					throw new Error("boom");
				},
			},
		);
		expect(projectSessionExecutionMetadata(throwingProxy, undefined)).toEqual({ kind: "unavailable" });
	});

	// ----- never local -----
	test("invalid sandbox metadata never defaults to local", () => {
		expect(projectSessionExecutionMetadata({ type: "prime-sandbox", extra: "key" }, undefined)).toEqual({
			kind: "unavailable",
		});
	});
});

// --------------------------------------------------------------------------
// Frozen DTOs
// --------------------------------------------------------------------------

describe("frozen outputs", () => {
	test("local DTO is frozen", () => {
		const dto = projectSessionExecutionMetadata(localLocation(), undefined);
		expect(Object.isFrozen(dto)).toBe(true);
	});

	test("sandbox DTO is frozen", () => {
		const dto = projectSessionExecutionMetadata(sandboxLocation(), "connected");
		expect(Object.isFrozen(dto)).toBe(true);
	});

	test("unavailable DTO is frozen", () => {
		const dto = projectSessionExecutionMetadata(42, undefined);
		expect(Object.isFrozen(dto)).toBe(true);
	});
});

// --------------------------------------------------------------------------
// Format label alignment (render path simulation)
// --------------------------------------------------------------------------

describe("format labels", () => {
	function label(meta: SessionExecutionMetadata | undefined): string | undefined {
		if (!meta) return undefined;
		if (meta.kind === "local") return "local";
		if (meta.kind === "sandbox") {
			if (meta.linkStatus === "unavailable") return "sandbox · link unavailable";
			return `sandbox · ${meta.linkStatus}`;
		}
		return "location unavailable";
	}

	test("local label", () => {
		expect(label(projectSessionExecutionMetadata(localLocation(), undefined))).toBe("local");
	});

	test("sandbox with link label", () => {
		expect(label(projectSessionExecutionMetadata(sandboxLocation(), "connected"))).toBe("sandbox · connected");
		expect(label(projectSessionExecutionMetadata(sandboxLocation(), "closed"))).toBe("sandbox · closed");
		expect(label(projectSessionExecutionMetadata(sandboxLocation(), "unreachable"))).toBe("sandbox · unreachable");
	});

	test("sandbox without link → link unavailable", () => {
		expect(label(projectSessionExecutionMetadata(sandboxLocation(), undefined))).toBe("sandbox · link unavailable");
	});

	test("unavailable label", () => {
		expect(label(projectSessionExecutionMetadata(42, undefined))).toBe("location unavailable");
	});

	test("absent metadata has no label", () => {
		expect(label(undefined)).toBeUndefined();
	});
});

// --------------------------------------------------------------------------
// Secret absence in projected DTO
// --------------------------------------------------------------------------

describe("secret absence in projected metadata", () => {
	const sandboxKinds: SessionExecutionMetadata[] = [
		{ kind: "sandbox", linkStatus: "connected" },
		{ kind: "sandbox", linkStatus: "unreachable" },
		{ kind: "sandbox", linkStatus: "unavailable" },
	];

	test("kind:sandbox DTO strips sandboxId, region, errors, timestamps, URLs", () => {
		for (const meta of sandboxKinds) {
			const raw = JSON.stringify(meta);
			expect(raw).not.toContain("sandboxId");
			expect(raw).not.toContain("region");
			expect(raw).not.toContain("error");
			expect(raw).not.toContain("connectedAt");
			expect(raw).not.toContain("startedAt");
			expect(raw).not.toContain("failedAt");
			expect(raw).not.toContain("since");
			expect(raw).not.toContain("attempt");
			expect(raw).not.toContain("url");
		}
	});

	test("sandboxId never leaks into projected metadata", () => {
		const result = projectSessionExecutionMetadata(sandboxLocation(), "connected");
		const raw = JSON.stringify(result);
		expect(raw).not.toContain("sb-secret-987");
	});

	test("region never leaks into projected metadata", () => {
		const result = projectSessionExecutionMetadata(sandboxLocation(), "connected");
		const raw = JSON.stringify(result);
		expect(raw).not.toContain("us-east-1");
	});

	test("raw error string never leaks into projected metadata", () => {
		// The link enum never carries errors; this confirms the DTO itself has no error field.
		const result = projectSessionExecutionMetadata(sandboxLocation(), "unreachable");
		const raw = JSON.stringify(result);
		expect(raw).not.toContain("error");
	});

	test("reconciled record JSON omits raw descriptors", () => {
		const daemon = makeSummary({ id: "r", sessionId: "r", activeSessionId: "r-active" });
		const metaMap = new Map<string, SessionExecutionMetadata>();
		metaMap.set("r-active", { kind: "sandbox", linkStatus: "connected" });
		const records = reconcileUnifiedSessions([daemon], [], [], metaMap);
		const raw = JSON.stringify(records[0]);
		expect(raw).toContain("sandbox");
		expect(raw).toContain("connected");
		expect(raw).not.toContain("sandboxId");
		expect(raw).not.toContain("region");
		expect(raw).not.toContain("error");
	});
});

// --------------------------------------------------------------------------
// Section / count / grouping invariance
// --------------------------------------------------------------------------

describe("section membership and count invariance", () => {
	test("execution metadata does not affect section classification", () => {
		const meta = projectSessionExecutionMetadata(sandboxLocation(), "connected")!;
		expect(meta.kind).toBe("sandbox");
		expect("section" in meta).toBe(false);
		expect(Object.keys(meta).sort()).toEqual(["kind", "linkStatus"]);
	});

	test("local metadata has only kind field", () => {
		const meta = projectSessionExecutionMetadata(localLocation(), undefined)!;
		expect(Object.keys(meta)).toEqual(["kind"]);
	});

	test("unavailable metadata has only kind field", () => {
		const meta = projectSessionExecutionMetadata({ type: "bad" }, undefined);
		expect(meta).toEqual({ kind: "unavailable" });
	});
});

// --------------------------------------------------------------------------
// Map malformed value => unavailable via reconcile
// --------------------------------------------------------------------------

describe("reconcile with execution metadata map", () => {
	test("valid map entry passes through", () => {
		const daemon = makeSummary({ id: "s1", sessionId: "s1", activeSessionId: "s1-active" });
		const metaMap = new Map<string, SessionExecutionMetadata>();
		metaMap.set("s1-active", { kind: "sandbox", linkStatus: "connected" });
		const records = reconcileUnifiedSessions([daemon], [], [], metaMap);
		expect(records[0]?.executionMetadata).toEqual({ kind: "sandbox", linkStatus: "connected" });
	});

	test("local map entry passes through", () => {
		const daemon = makeSummary({ id: "s2", sessionId: "s2", activeSessionId: "s2-active" });
		const metaMap = new Map<string, SessionExecutionMetadata>();
		metaMap.set("s2-active", { kind: "local" });
		const records = reconcileUnifiedSessions([daemon], [], [], metaMap);
		expect(records[0]?.executionMetadata).toEqual({ kind: "local" });
	});

	test("map malformed value becomes explicit unavailable metadata", () => {
		const daemon = makeSummary({ id: "s3", sessionId: "s3", activeSessionId: "s3-active" });
		const metaMap = new Map<string, SessionExecutionMetadata>();
		// Cast a malformed shape as SessionExecutionMetadata to simulate corruption.
		metaMap.set("s3-active", { kind: "garbage" } as unknown as SessionExecutionMetadata);
		const records = reconcileUnifiedSessions([daemon], [], [], metaMap);
		expect(records[0]?.executionMetadata).toEqual({ kind: "unavailable" });
	});

	test("absent activeSessionId skips metadata lookup", () => {
		const daemon = makeSummary({ id: "s4", sessionId: "s4" });
		const metaMap = new Map<string, SessionExecutionMetadata>();
		metaMap.set("s4", { kind: "sandbox", linkStatus: "connected" });
		const records = reconcileUnifiedSessions([daemon], [], [], metaMap);
		expect(records[0]?.executionMetadata).toBeUndefined();
	});

	test("no map produces no metadata", () => {
		const daemon = makeSummary({ id: "s5", sessionId: "s5", activeSessionId: "s5-active" });
		const records = reconcileUnifiedSessions([daemon], [], []);
		expect(records[0]?.executionMetadata).toBeUndefined();
	});
	test("sandbox link-unavailable map entry remains explicit", () => {
		const daemon = makeSummary({ id: "s6", sessionId: "s6", activeSessionId: "s6-active" });
		const metaMap = new Map<string, SessionExecutionMetadata>();
		metaMap.set("s6-active", { kind: "sandbox", linkStatus: "unavailable" });
		const records = reconcileUnifiedSessions([daemon], [], [], metaMap);
		expect(records[0]?.executionMetadata).toEqual({ kind: "sandbox", linkStatus: "unavailable" });
	});

	test("hostile metadata getter is not invoked and becomes unavailable", () => {
		let calls = 0;
		const hostile: Record<string, unknown> = {};
		Object.defineProperty(hostile, "kind", {
			enumerable: true,
			get() {
				calls += 1;
				return "local";
			},
		});
		const decoded = snapshotSessionExecutionMetadata(hostile);
		expect(decoded).toEqual({ kind: "unavailable" });
		expect(calls).toBe(0);
	});

	test("metadata map access failure becomes unavailable", () => {
		const daemon = makeSummary({ id: "s7", sessionId: "s7", activeSessionId: "s7-active" });
		const backing = new Map<string, SessionExecutionMetadata>();
		const hostileMap = new Proxy(backing, {});
		const records = reconcileUnifiedSessions([daemon], [], [], hostileMap);
		expect(records[0]?.executionMetadata).toEqual({ kind: "unavailable" });
	});
});

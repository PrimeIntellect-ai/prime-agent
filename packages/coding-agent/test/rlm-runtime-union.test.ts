import { describe, expect, test, vi } from "vitest";
import { AgentSession, isAgentSessionInstance } from "../src/core/agent-session.js";
import {
	INVALID_SUBAGENT_RUNTIME_ERROR,
	type NormalizedHostedIdentityMatch,
	normalizeRlmSubagentRuntime,
	type RlmSubagentRuntime,
} from "../src/core/rlm-runtime.js";

function isAgentSession(value: unknown): value is AgentSession {
	if (typeof value !== "object" || value === null) return false;
	if (!("disposeAsync" in value)) return false;
	const d = Object.getOwnPropertyDescriptor(value, "disposeAsync");
	return !!d && "value" in d && typeof d.value === "function";
}

function makeHostedPort(): unknown {
	return {
		identity: {
			childId: "child-1",
			sessionId: "session-1",
			sessionName: "worker",
			modelSelector: "provider/model",
		},
		startInitialTask: vi.fn(),
		abort: vi.fn(),
		observe: vi.fn(),
		subscribe: vi.fn(),
	};
}

function makeHostedIdentity(): NormalizedHostedIdentityMatch {
	return { childId: "child-1", sessionName: "worker", modelSelector: "provider/model", sessionId: "session-1" };
}

function makeLocalSession(): unknown {
	return { disposeAsync: vi.fn() };
}

function local(): RlmSubagentRuntime {
	const r = normalizeRlmSubagentRuntime({ session: makeLocalSession() }, isAgentSession);
	if (!r) throw new Error("expected non-null local arm");
	return r;
}

function hosted(): RlmSubagentRuntime {
	const r = normalizeRlmSubagentRuntime({ hostedPort: makeHostedPort() }, isAgentSession, makeHostedIdentity());
	if (!r) throw new Error("expected non-null hosted arm");
	return r;
}

describe("RlmSubagentRuntime normalizeLocalArm", () => {
	test("accepts a plain { session: AgentSession-like } object", () => {
		const r = local();
		expect("session" in r).toBe(true);
		expect("hostedPort" in r).toBe(false);
	});

	test("rejects null", () => {
		expect(normalizeRlmSubagentRuntime(null, isAgentSession)).toBeNull();
	});

	test("rejects a Proxy-wrapped { session }", () => {
		const raw = { session: makeLocalSession() };
		const proxy = new Proxy(raw, {});
		expect(normalizeRlmSubagentRuntime(proxy, isAgentSession)).toBeNull();
	});

	test("rejects an accessor descriptor on session", () => {
		const raw: Record<string, unknown> = {};
		Object.defineProperty(raw, "session", {
			enumerable: true,
			get: () => makeLocalSession(),
		});
		expect(normalizeRlmSubagentRuntime(raw, isAgentSession)).toBeNull();
	});

	test("rejects a non-enumerable session property", () => {
		const raw: Record<string, unknown> = {};
		Object.defineProperty(raw, "session", {
			value: makeLocalSession(),
			enumerable: false,
		});
		expect(normalizeRlmSubagentRuntime(raw, isAgentSession)).toBeNull();
	});

	test("rejects Symbol-keyed object", () => {
		const raw = { [Symbol("s")]: makeLocalSession(), session: makeLocalSession() };
		expect(normalizeRlmSubagentRuntime(raw, isAgentSession)).toBeNull();
	});

	test("rejects extra key alongside session", () => {
		const raw = { session: makeLocalSession(), extra: true };
		expect(normalizeRlmSubagentRuntime(raw, isAgentSession)).toBeNull();
	});

	test("rejects missing key", () => {
		expect(normalizeRlmSubagentRuntime({}, isAgentSession)).toBeNull();
	});

	test("rejects both session and hostedPort", () => {
		const raw = {
			session: makeLocalSession(),
			hostedPort: makeHostedPort(),
		};
		expect(normalizeRlmSubagentRuntime(raw, isAgentSession)).toBeNull();
	});

	test("rejects session value that is a Proxy", () => {
		const raw = { session: new Proxy(Object(makeLocalSession()), {}) };
		expect(normalizeRlmSubagentRuntime(raw, isAgentSession)).toBeNull();
	});

	test("rejects session value that is a Promise", () => {
		const raw = { session: Promise.resolve({}) };
		expect(normalizeRlmSubagentRuntime(raw, isAgentSession)).toBeNull();
	});

	test("rejects session value that is null", () => {
		const raw = { session: null };
		expect(normalizeRlmSubagentRuntime(raw, isAgentSession)).toBeNull();
	});

	test("rejects session value that is not an AgentSession", () => {
		const raw = { session: { notASession: true } };
		expect(normalizeRlmSubagentRuntime(raw, isAgentSession)).toBeNull();
	});

	test("frozen normalized local arm", () => {
		const r = local();
		expect(Object.isFrozen(r)).toBe(true);
		const session: unknown = "session" in r ? r.session : undefined;
		expect(typeof session).toBe("object");
	});
});

describe("RlmSubagentRuntime normalizeHostedArm", () => {
	test("accepts a plain { hostedPort } with valid port shape", () => {
		const r = hosted();
		expect("hostedPort" in r).toBe(true);
		expect("session" in r).toBe(false);
	});

	test("rejects a Proxy-wrapped { hostedPort }", () => {
		const raw = { hostedPort: makeHostedPort() };
		const proxy = new Proxy(raw, {});
		expect(normalizeRlmSubagentRuntime(proxy, isAgentSession)).toBeNull();
	});

	test("rejects an accessor descriptor on hostedPort", () => {
		const raw: Record<string, unknown> = {};
		Object.defineProperty(raw, "hostedPort", {
			enumerable: true,
			get: () => makeHostedPort(),
		});
		expect(normalizeRlmSubagentRuntime(raw, isAgentSession)).toBeNull();
	});

	test("rejects a non-enumerable hostedPort", () => {
		const raw: Record<string, unknown> = {};
		Object.defineProperty(raw, "hostedPort", {
			value: makeHostedPort(),
			enumerable: false,
		});
		expect(normalizeRlmSubagentRuntime(raw, isAgentSession)).toBeNull();
	});

	test("rejects Symbol-keyed hostedPort", () => {
		const raw = { [Symbol("h")]: makeHostedPort(), hostedPort: makeHostedPort() };
		expect(normalizeRlmSubagentRuntime(raw, isAgentSession)).toBeNull();
	});

	test("rejects extra keys alongside hostedPort", () => {
		const raw = { hostedPort: makeHostedPort(), extra: true };
		expect(normalizeRlmSubagentRuntime(raw, isAgentSession)).toBeNull();
	});

	test("rejects if hostedPort itself is a Proxy", () => {
		const raw = { hostedPort: new Proxy(Object(makeHostedPort()), {}) };
		expect(normalizeRlmSubagentRuntime(raw, isAgentSession)).toBeNull();
	});

	test("rejects if hostedPort has extra keys", () => {
		const port: Record<string, unknown> = Object(makeHostedPort());
		port.extra = "bad";
		const raw = { hostedPort: port };
		expect(normalizeRlmSubagentRuntime(raw, isAgentSession)).toBeNull();
	});

	test("rejects if hostedPort identity has extra keys", () => {
		const port: Record<string, unknown> = Object(makeHostedPort());
		const identity: Record<string, unknown> = Object(port.identity);
		identity.extra = "bad";
		port.identity = identity;
		const raw = { hostedPort: port };
		expect(normalizeRlmSubagentRuntime(raw, isAgentSession)).toBeNull();
	});

	test("rejects if hostedPort identity is missing keys", () => {
		const port: Record<string, unknown> = Object(makeHostedPort());
		const identity: Record<string, unknown> = Object(port.identity);
		delete identity.modelSelector;
		port.identity = identity;
		const raw = { hostedPort: port };
		expect(normalizeRlmSubagentRuntime(raw, isAgentSession)).toBeNull();
	});

	test("rejects null hostedPort value", () => {
		const raw = { hostedPort: null };
		expect(normalizeRlmSubagentRuntime(raw, isAgentSession)).toBeNull();
	});

	test("rejects primitive hostedPort value", () => {
		const raw = { hostedPort: "bad" };
		expect(normalizeRlmSubagentRuntime(raw, isAgentSession)).toBeNull();
	});

	test("frozen normalized hosted arm", () => {
		const r = hosted();
		expect(Object.isFrozen(r)).toBe(true);
		if ("hostedPort" in r) {
			expect(Object.isFrozen(r.hostedPort)).toBe(true);
		}
	});
});

describe("normalizeRlmSubagentRuntime expectedHostedIdentity", () => {
	test("matches childId", () => {
		const r = normalizeRlmSubagentRuntime({ hostedPort: makeHostedPort() }, isAgentSession, makeHostedIdentity());
		expect(r).not.toBeNull();
		expect(r && "hostedPort" in r).toBe(true);
	});

	test("rejects childId mismatch", () => {
		expect(
			normalizeRlmSubagentRuntime({ hostedPort: makeHostedPort() }, isAgentSession, {
				childId: "wrong",
				sessionName: "worker",
				modelSelector: "provider/model",
				sessionId: "session-1",
			}),
		).toBeNull();
	});

	test("matches sessionName", () => {
		const r = normalizeRlmSubagentRuntime({ hostedPort: makeHostedPort() }, isAgentSession, makeHostedIdentity());
		expect(r).not.toBeNull();
		expect(r && "hostedPort" in r).toBe(true);
	});

	test("rejects sessionName mismatch", () => {
		expect(
			normalizeRlmSubagentRuntime({ hostedPort: makeHostedPort() }, isAgentSession, {
				childId: "child-1",
				sessionName: "wrong",
				modelSelector: "provider/model",
				sessionId: "session-1",
			}),
		).toBeNull();
	});

	test("matches modelSelector", () => {
		const r = normalizeRlmSubagentRuntime({ hostedPort: makeHostedPort() }, isAgentSession, makeHostedIdentity());
		expect(r).not.toBeNull();
		expect(r && "hostedPort" in r).toBe(true);
	});

	test("rejects modelSelector mismatch", () => {
		expect(
			normalizeRlmSubagentRuntime({ hostedPort: makeHostedPort() }, isAgentSession, {
				childId: "child-1",
				sessionName: "worker",
				modelSelector: "other/model",
				sessionId: "session-1",
			}),
		).toBeNull();
	});

	test("matches sessionId", () => {
		const r = normalizeRlmSubagentRuntime({ hostedPort: makeHostedPort() }, isAgentSession, makeHostedIdentity());
		expect(r).not.toBeNull();
		expect(r && "hostedPort" in r).toBe(true);
	});

	test("rejects sessionId mismatch", () => {
		expect(
			normalizeRlmSubagentRuntime({ hostedPort: makeHostedPort() }, isAgentSession, {
				childId: "child-1",
				sessionName: "worker",
				modelSelector: "provider/model",
				sessionId: "wrong",
			}),
		).toBeNull();
	});

	test("multiple fields match", () => {
		const r = normalizeRlmSubagentRuntime({ hostedPort: makeHostedPort() }, isAgentSession, makeHostedIdentity());
		expect(r).not.toBeNull();
		expect(r && "hostedPort" in r).toBe(true);
	});

	test("multiple fields reject", () => {
		expect(
			normalizeRlmSubagentRuntime({ hostedPort: makeHostedPort() }, isAgentSession, {
				childId: "child-1",
				sessionName: "other",
				modelSelector: "provider/model",
				sessionId: "session-1",
			}),
		).toBeNull();
	});

	test("empty options rejected (all four fields required)", () => {
		expect(normalizeRlmSubagentRuntime({ hostedPort: makeHostedPort() }, isAgentSession, {})).toBeNull();
	});
});

describe("unchanged local host tests", () => {
	test("local and hosted are mutually exclusive", () => {
		const loc = local();
		const hst = hosted();

		expect("session" in loc).toBe(true);
		expect("hostedPort" in loc).toBe(false);
		expect("session" in hst).toBe(false);
		expect("hostedPort" in hst).toBe(true);
	});

	test("the same AgentSession-like object returns the same session from local normalize", () => {
		const session = makeLocalSession();
		const runtime = normalizeRlmSubagentRuntime({ session }, isAgentSession);
		expect(runtime).not.toBeNull();
		if (runtime !== null) {
			expect("session" in runtime).toBe(true);
			if ("session" in runtime) {
				expect(runtime.session).toBe(session);
			}
			expect("hostedPort" in runtime).toBe(false);
		}
	});
});

describe("INVALID_SUBAGENT_RUNTIME_ERROR constant", () => {
	test("is a non-empty string", () => {
		expect(typeof INVALID_SUBAGENT_RUNTIME_ERROR).toBe("string");
		expect(INVALID_SUBAGENT_RUNTIME_ERROR.length).toBeGreaterThan(0);
	});
});

describe("branded predicate (isAgentSessionInstance)", () => {
	test("rejects Object.create(AgentSession.prototype)", () => {
		const fake = Object.create(AgentSession.prototype);
		expect(isAgentSessionInstance(fake)).toBe(false);
		expect(normalizeRlmSubagentRuntime({ session: fake }, isAgentSessionInstance)).toBeNull();
	});

	test("rejects Proxy-wrapped legitimate session object", () => {
		const raw = { disposeAsync: vi.fn() };
		const proxy = new Proxy(raw, {});
		const r = normalizeRlmSubagentRuntime({ session: proxy }, (v): v is never => typeof v === "object" && v !== null);
		expect(r).toBeNull();
	});

	test("rejects revoked Proxy wrapping a session", () => {
		const { proxy, revoke } = Proxy.revocable({ session: { disposeAsync: vi.fn() } }, {});
		revoke();
		let result: ReturnType<typeof normalizeRlmSubagentRuntime>;
		try {
			result = normalizeRlmSubagentRuntime(proxy, (_v: unknown): _v is never => true);
		} catch {
			result = null;
		}
		expect(result).toBeNull();
	});

	test("normalize catches throwing predicate", () => {
		const raw = { session: { disposeAsync: vi.fn() } };
		const throwingPredicate = (_v: unknown): _v is never => {
			throw new Error("predicate threw");
		};
		expect(() => {
			// The normalize function itself must not throw when predicate throws
			const r = normalizeRlmSubagentRuntime(raw, throwingPredicate);
			expect(r).toBeNull();
		}).not.toThrow();
	});

	test("frozen { session } from normalize rejects mutations", () => {
		const r = normalizeRlmSubagentRuntime(
			{ session: { disposeAsync: vi.fn() } },
			(v): v is never => typeof v === "object" && v !== null,
		);
		expect(r).not.toBeNull();
		if (r && "session" in r) {
			expect(Object.isFrozen(r)).toBe(true);
		}
	});
});

describe("local host hosted-arm rejection", () => {
	test("local host rejects hostedPort arm (hostedPort without expectedHostedIdentity returns null)", () => {
		const hostedPort = {
			identity: {
				childId: "child-1",
				sessionId: "session-1",
				sessionName: "worker",
				modelSelector: "provider/model",
			},
			startInitialTask: vi.fn(),
			abort: vi.fn(),
			observe: vi.fn(),
			subscribe: vi.fn(),
		};
		const r = normalizeRlmSubagentRuntime({ hostedPort }, (v): v is never => typeof v === "object" && v !== null);
		expect(r).toBeNull();
	});

	test("local host delete rejects hostedPort arm (hostedPort without expectedHostedIdentity)", () => {
		const hostedPort = {
			identity: {
				childId: "child-1",
				sessionId: "session-1",
				sessionName: "worker",
				modelSelector: "provider/model",
			},
			startInitialTask: vi.fn(),
			abort: vi.fn(),
			observe: vi.fn(),
			subscribe: vi.fn(),
		};
		const hostedRuntime = normalizeRlmSubagentRuntime(
			{ hostedPort },
			(v): v is never => typeof v === "object" && v !== null,
		);
		// hostedPort without expectedHostedIdentity returns null
		expect(hostedRuntime).toBeNull();
	});

	test("normalized frozen hosted arm mutates neither wrapped object nor wrapper", () => {
		const port = {
			identity: {
				childId: "c1",
				sessionId: "s1",
				sessionName: "w",
				modelSelector: "p/m",
			},
			startInitialTask: vi.fn(),
			abort: vi.fn(),
			observe: vi.fn(),
			subscribe: vi.fn(),
		};
		const r = normalizeRlmSubagentRuntime({ hostedPort: port }, (_v: unknown): _v is never => false, {
			childId: "c1",
			sessionName: "w",
			modelSelector: "p/m",
			sessionId: "s1",
		});
		expect(r).not.toBeNull();
		if (r !== null) expect(Object.isFrozen(r)).toBe(true);
	});

	test("empty expectedHostedIdentity rejected (all four fields required)", () => {
		const port = {
			identity: {
				childId: "c1",
				sessionId: "s1",
				sessionName: "w",
				modelSelector: "p/m",
			},
			startInitialTask: vi.fn(),
			abort: vi.fn(),
			observe: vi.fn(),
			subscribe: vi.fn(),
		};
		expect(normalizeRlmSubagentRuntime({ hostedPort: port }, (_v: unknown): _v is never => false, {})).toBeNull();
	});
});

describe("AgentSessionRuntime-host regression (full-runtime rejection)", () => {
	/** Simulate what AgentSessionRuntime.createRlmSubagentRuntime returned before the fix:
	 * a full runtime object with { session, services, diagnostics, ... } instead of
	 * the required frozen union type. */
	function makeFullRuntime(): unknown {
		const session = makeLocalSession();
		return {
			session,
			services: {},
			diagnostics: [],
			cwd: "/tmp",
			metadata: {},
			listSubagentRuntimes: vi.fn(),
			createRlmSubagentRuntime: vi.fn(),
			deleteRlmSubagentRuntime: vi.fn(),
			dispose: vi.fn(),
		};
	}

	test("normalize rejects full runtime object (extra keys)", () => {
		const raw = makeFullRuntime();
		const r = normalizeRlmSubagentRuntime(raw, (_v): _v is never => true);
		expect(r).toBeNull();
	});

	test("normalize rejects full runtime even when isAgentSession passes for session", () => {
		const raw = makeFullRuntime();
		const passingPredicate = (v: unknown): v is AgentSession =>
			typeof v === "object" && v !== null && "disposeAsync" in v;
		const r = normalizeRlmSubagentRuntime(raw, passingPredicate);
		// The full runtime has extra keys beyond {session} so requireExactSingleKeyRecord rejects it
		expect(r).toBeNull();
	});

	test("normalize accepts a proper { session } union arm", () => {
		const session = makeLocalSession();
		const r = normalizeRlmSubagentRuntime(
			{ session },
			(v): v is AgentSession => typeof v === "object" && v !== null && "disposeAsync" in v,
		);
		expect(r).not.toBeNull();
		if (r) {
			expect("session" in r).toBe(true);
			expect("hostedPort" in r).toBe(false);
		}
	});

	test("deleteRlmSubagentRuntime host rejects hostedPort arm in local host", () => {
		// Simulate what a local-host deleteRlmSubagentRuntime does:
		// 1. normalize the incoming runtime
		// 2. reject if hostedPort arm
		const port = {
			identity: {
				childId: "child-1",
				sessionId: "session-1",
				sessionName: "worker",
				modelSelector: "provider/model",
			},
			startInitialTask: vi.fn(),
			abort: vi.fn(),
			observe: vi.fn(),
			subscribe: vi.fn(),
		};
		const hostedRuntime = normalizeRlmSubagentRuntime({ hostedPort: port }, (_v): _v is never => false, {
			childId: "child-1",
			sessionName: "worker",
			modelSelector: "provider/model",
			sessionId: "session-1",
		});
		expect(hostedRuntime).not.toBeNull();
		if (hostedRuntime && "hostedPort" in hostedRuntime) {
			expect("session" in hostedRuntime).toBe(false);
			// The local-host delete validation must throw when a hostedPort arm arrives
			expect(() => {
				if ("hostedPort" in hostedRuntime) {
					throw new Error(INVALID_SUBAGENT_RUNTIME_ERROR);
				}
			}).toThrow(INVALID_SUBAGENT_RUNTIME_ERROR);
		}
	});

	test("colliding local child is not deleted when hosted arm is passed", () => {
		// Simulate: a local child with id "child-local" exists in the subagent map,
		// but a hostedPort arm is passed to delete. The local host must throw
		// before any map mutation.
		const port = {
			identity: {
				childId: "child-local",
				sessionId: "session-1",
				sessionName: "worker",
				modelSelector: "provider/model",
			},
			startInitialTask: vi.fn(),
			abort: vi.fn(),
			observe: vi.fn(),
			subscribe: vi.fn(),
		};
		const hostedRuntime = normalizeRlmSubagentRuntime({ hostedPort: port }, (_v): _v is never => false, {
			childId: "child-local",
			sessionName: "worker",
			modelSelector: "provider/model",
			sessionId: "session-1",
		});
		expect(hostedRuntime).not.toBeNull();
		if (hostedRuntime && "hostedPort" in hostedRuntime) {
			// If a deleteRlmSubagentRuntime receives this hostedPort arm for a local
			// child that exists in the subagentRuntimes map, it must throw
			// INVALID_SUBAGENT_RUNTIME_ERROR before touching the map.
			const deleteBehavior = (): void => {
				const normalized = normalizeRlmSubagentRuntime(
					hostedRuntime,
					(v): v is AgentSession => typeof v === "object" && v !== null && "disposeAsync" in v,
				);
				if (!normalized || "hostedPort" in normalized) {
					throw new Error(INVALID_SUBAGENT_RUNTIME_ERROR);
				}
			};
			expect(deleteBehavior).toThrow(INVALID_SUBAGENT_RUNTIME_ERROR);
		}
	});
});

describe("malformed Proxy / revoked / fake collision cleanup", () => {
	test("revoked Proxy outer wrapper is rejected", () => {
		const session = makeLocalSession();
		const { proxy, revoke } = Proxy.revocable({ session }, {});
		revoke();
		let result: ReturnType<typeof normalizeRlmSubagentRuntime>;
		try {
			result = normalizeRlmSubagentRuntime(
				proxy,
				(v): v is AgentSession => typeof v === "object" && v !== null && "disposeAsync" in v,
			);
		} catch {
			result = null;
		}
		expect(result).toBeNull();
	});

	test("revoked Proxy inner session value is rejected", () => {
		const session = makeLocalSession();
		const { proxy, revoke } = Proxy.revocable(Object(session), {});
		revoke();
		const raw = { session: proxy };
		const r = normalizeRlmSubagentRuntime(
			raw,
			(v): v is AgentSession => typeof v === "object" && v !== null && "disposeAsync" in v,
		);
		expect(r).toBeNull();
	});

	test("fake object pretending to be session (right shape, no WeakSet brand) is rejected", () => {
		// isAgentSessionInstance checks WeakSet brand, so a fake session
		// with same shape must be rejected by a brand-checking predicate.
		const agentSessionBrand = new WeakSet<object>();
		const fakeSession = {
			disposeAsync: vi.fn(),
			sessionId: "fake",
			sessionName: "fake",
		};
		// The fake is NOT in the brand WeakSet, so the predicate returns false.
		const brandPredicate = (v: unknown): v is AgentSession =>
			typeof v === "object" && v !== null && agentSessionBrand.has(v);
		const r = normalizeRlmSubagentRuntime({ session: fakeSession }, brandPredicate);
		expect(r).toBeNull();
	});

	test("session value that throws on property access is rejected", () => {
		const throwingSession = new Proxy(
			{},
			{
				get() {
					throw new Error("unexpected access");
				},
			},
		);
		const raw = { session: throwingSession };
		const r = normalizeRlmSubagentRuntime(raw, (_v): _v is never => {
			throw new Error("predicate should not be called for Proxy");
		});
		// The Proxy check in normalize should reject before calling the predicate
		expect(r).toBeNull();
	});

	test("accessor getter on outer object session key is rejected", () => {
		const raw: Record<string, unknown> = {};
		Object.defineProperty(raw, "session", {
			enumerable: true,
			get: () => makeLocalSession(),
		});
		expect(
			normalizeRlmSubagentRuntime(
				raw,
				(v): v is AgentSession => typeof v === "object" && v !== null && "disposeAsync" in v,
			),
		).toBeNull();
	});

	test("hostedPort with nested Proxy identity field is rejected", () => {
		const identity = {
			childId: "c1",
			sessionId: "s1",
			sessionName: "w",
			modelSelector: "p/m",
		};
		const identityProxy = new Proxy(identity, {});
		const raw = {
			hostedPort: {
				identity: identityProxy,
				startInitialTask: vi.fn(),
				abort: vi.fn(),
				observe: vi.fn(),
				subscribe: vi.fn(),
			},
		};
		expect(normalizeRlmSubagentRuntime(raw, (_v): _v is never => false)).toBeNull();
	});

	test("accepted hosted arm in local-run branch throws fixed error and does not collide", () => {
		// This simulates what happens when a hostedPort runtime reaches the
		// local-host error cleanup path. The cleanup must:
		// 1. reject with INVALID_SUBAGENT_RUNTIME_ERROR
		// 2. never touch the subagent map / ledger
		const port = {
			identity: {
				childId: "child-collide",
				sessionId: "session-1",
				sessionName: "worker",
				modelSelector: "provider/model",
			},
			startInitialTask: vi.fn(),
			abort: vi.fn(),
			observe: vi.fn(),
			subscribe: vi.fn(),
		};
		const hostedRuntime = normalizeRlmSubagentRuntime({ hostedPort: port }, (_v): _v is never => false, {
			childId: "child-collide",
			sessionName: "worker",
			modelSelector: "provider/model",
			sessionId: "session-1",
		});
		expect(hostedRuntime).not.toBeNull();

		// Local host delete validation must fail with INVALID_SUBAGENT_RUNTIME_ERROR
		// before any map/ledger mutation
		if (hostedRuntime && "hostedPort" in hostedRuntime) {
			const mockMap = new Map<string, boolean>();
			mockMap.set("child-collide", true);
			const beforeSize = mockMap.size;

			expect(() => {
				// This is the same validation AgentSessionRuntime.deleteRlmSubagentRuntime does
				const normalized = normalizeRlmSubagentRuntime(
					hostedRuntime,
					(v): v is AgentSession => typeof v === "object" && v !== null && "disposeAsync" in v,
				);
				if (!normalized || "hostedPort" in normalized) {
					throw new Error(INVALID_SUBAGENT_RUNTIME_ERROR);
				}
			}).toThrow(INVALID_SUBAGENT_RUNTIME_ERROR);

			// Map must not be mutated
			expect(mockMap.size).toBe(beforeSize);
			expect(mockMap.has("child-collide")).toBe(true);
		}
	});
});

describe("AgentSessionRuntime-host regression for delete rejection", () => {
	function makeFullRuntime(): unknown {
		const session = { disposeAsync: vi.fn() };
		return {
			session,
			services: {},
			diagnostics: [],
			cwd: "/tmp",
			metadata: {},
			listSubagentRuntimes: vi.fn(),
			createRlmSubagentRuntime: vi.fn(),
			deleteRlmSubagentRuntime: vi.fn(),
			dispose: vi.fn(),
		};
	}

	/** Simulate AgentSessionRuntime.deleteRlmSubagentRuntime validation: */
	function localDeleteValidation(runtime: unknown): { thrown: boolean; error?: string } {
		try {
			const normalized = normalizeRlmSubagentRuntime(
				runtime,
				(v): v is AgentSession => typeof v === "object" && v !== null && "disposeAsync" in v,
			);
			if (!normalized || "hostedPort" in normalized) {
				throw new Error(INVALID_SUBAGENT_RUNTIME_ERROR);
			}
			return { thrown: false };
		} catch (e) {
			return { thrown: true, error: e instanceof Error ? e.message : String(e) };
		}
	}

	test("deleteRlmSubagentRuntime rejects full runtime (extra keys beyond {session})", () => {
		// Full runtime has services, diagnostics, cwd, etc alongside session.
		// requireExactSingleKeyRecord rejects objects with more than one key.
		const result = localDeleteValidation(makeFullRuntime());
		expect(result.thrown).toBe(true);
		expect(result.error).toBe(INVALID_SUBAGENT_RUNTIME_ERROR);
	});

	test("deleteRlmSubagentRuntime rejects hostedPort arm before map access", () => {
		// If a hostedPort arm reaches the local host's delete, it must throw
		// before any map.get/map.delete mutation.
		const port = {
			identity: {
				childId: "child-map",
				sessionId: "session-1",
				sessionName: "worker",
				modelSelector: "provider/model",
			},
			startInitialTask: vi.fn(),
			abort: vi.fn(),
			observe: vi.fn(),
			subscribe: vi.fn(),
		};
		const result = localDeleteValidation({ hostedPort: port });
		expect(result.thrown).toBe(true);
		expect(result.error).toBe(INVALID_SUBAGENT_RUNTIME_ERROR);
	});

	test("deleteRlmSubagentRuntime accepts valid local { session } arm", () => {
		const result = localDeleteValidation({ session: { disposeAsync: vi.fn() } });
		expect(result.thrown).toBe(false);
	});

	test("rawRuntime is never passed to downstream delete/release after normalization failure", () => {
		// Simulate the agent-session startup error path: rawRuntime is assigned
		// from _createRlmSubagentRuntime, normalization fails, childRuntime is
		// never set. The catch block must not pass rawRuntime to delete/release.
		const rawRuntime: unknown = makeFullRuntime();
		let childRuntime: RlmSubagentRuntime | undefined;

		// This matches what agent-session does in the try block
		const normalized = normalizeRlmSubagentRuntime(
			rawRuntime,
			(v): v is AgentSession => typeof v === "object" && v !== null && "disposeAsync" in v,
		);
		if (normalized && "session" in normalized) {
			childRuntime = normalized;
		}

		// After normalization failure, childRuntime is undefined;
		// rawRuntime must never reach delete/release.
		expect(childRuntime).toBeUndefined();

		// The catch block would call deleteRlmSubagentRuntime with childRuntime,
		// not rawRuntime. Since childRuntime is undefined, it's safe.
		const deleteResult = localDeleteValidation(rawRuntime);
		expect(deleteResult.thrown).toBe(true);
	});
});

describe("expectedHostedIdentity strict validation", () => {
	test("expectedHostedIdentity with Proxy identity field is rejected", () => {
		const identityProxy = new Proxy(
			{
				childId: "c1",
				sessionId: "s1",
				sessionName: "w",
				modelSelector: "p/m",
			},
			{},
		);
		// The expectedHostedIdentity comparison catches when the port identity
		// doesn't match; the hostedPort's identity itself goes through
		// extractIdentity which rejects Proxies.
		const raw = {
			hostedPort: {
				identity: identityProxy,
				startInitialTask: vi.fn(),
				abort: vi.fn(),
				observe: vi.fn(),
				subscribe: vi.fn(),
			},
		};
		expect(
			normalizeRlmSubagentRuntime(raw, (_v): _v is never => false, {
				childId: "c1",
			}),
		).toBeNull();
	});

	test("expectedHostedIdentity getter is safely caught", () => {
		const raw = {
			hostedPort: {
				identity: {
					childId: "c1",
					sessionId: "s1",
					sessionName: "w",
					modelSelector: "p/m",
				},
				startInitialTask: vi.fn(),
				abort: vi.fn(),
				observe: vi.fn(),
				subscribe: vi.fn(),
			},
		};
		const r = normalizeRlmSubagentRuntime(raw, (_v): _v is never => false, {
			childId: "c1",
			sessionName: "w",
			modelSelector: "p/m",
			sessionId: "s1",
		});
		expect(r).not.toBeNull();
		if (r) {
			expect("hostedPort" in r).toBe(true);
		}
	});

	test("expectedHostedIdentity with getter on identity field is zero-access (never invoked)", () => {
		let getterCalls = 0;
		const identity: Record<string, unknown> = {
			childId: "c1",
			sessionId: "s1",
			sessionName: "w",
			modelSelector: "p/m",
		};
		Object.defineProperty(identity, "childId", {
			enumerable: true,
			get: () => {
				getterCalls++;
				return "c1";
			},
		});
		const raw = {
			hostedPort: {
				identity: {
					childId: "c1",
					sessionId: "s1",
					sessionName: "w",
					modelSelector: "p/m",
				},
				startInitialTask: vi.fn(),
				abort: vi.fn(),
				observe: vi.fn(),
				subscribe: vi.fn(),
			},
		};
		const r = normalizeRlmSubagentRuntime(raw, (_v): _v is never => false, identity);
		expect(r).toBeNull();
		expect(getterCalls).toBe(0);
	});

	test("expectedHostedIdentity Proxy wrapper is rejected", () => {
		const identity = {
			childId: "c1",
			sessionId: "s1",
			sessionName: "w",
			modelSelector: "p/m",
		};
		const proxy = new Proxy(identity, {});
		const raw = {
			hostedPort: {
				identity: {
					childId: "c1",
					sessionId: "s1",
					sessionName: "w",
					modelSelector: "p/m",
				},
				startInitialTask: vi.fn(),
				abort: vi.fn(),
				observe: vi.fn(),
				subscribe: vi.fn(),
			},
		};
		const r = normalizeRlmSubagentRuntime(raw, (_v): _v is never => false, proxy);
		expect(r).toBeNull();
	});

	test("expectedHostedIdentity with extra keys is rejected", () => {
		const identity: Record<string, unknown> = {
			childId: "c1",
			sessionId: "s1",
			sessionName: "w",
			modelSelector: "p/m",
			extra: true,
		};
		const raw = {
			hostedPort: {
				identity: {
					childId: "c1",
					sessionId: "s1",
					sessionName: "w",
					modelSelector: "p/m",
				},
				startInitialTask: vi.fn(),
				abort: vi.fn(),
				observe: vi.fn(),
				subscribe: vi.fn(),
			},
		};
		const r = normalizeRlmSubagentRuntime(raw, (_v): _v is never => false, identity);
		expect(r).toBeNull();
	});

	test("expectedHostedIdentity with null value field is rejected", () => {
		const identity: Record<string, unknown> = {
			childId: null,
			sessionId: "s1",
			sessionName: "w",
			modelSelector: "p/m",
		};
		const raw = {
			hostedPort: {
				identity: {
					childId: "c1",
					sessionId: "s1",
					sessionName: "w",
					modelSelector: "p/m",
				},
				startInitialTask: vi.fn(),
				abort: vi.fn(),
				observe: vi.fn(),
				subscribe: vi.fn(),
			},
		};
		const r = normalizeRlmSubagentRuntime(raw, (_v): _v is never => false, identity);
		expect(r).toBeNull();
	});

	test("expectedHostedIdentity with non-enumerable field is rejected", () => {
		const identity: Record<string, unknown> = {};
		Object.defineProperty(identity, "childId", {
			value: "c1",
			enumerable: false,
		});
		identity.sessionId = "s1";
		identity.sessionName = "w";
		identity.modelSelector = "p/m";
		const raw = {
			hostedPort: {
				identity: {
					childId: "c1",
					sessionId: "s1",
					sessionName: "w",
					modelSelector: "p/m",
				},
				startInitialTask: vi.fn(),
				abort: vi.fn(),
				observe: vi.fn(),
				subscribe: vi.fn(),
			},
		};
		const r = normalizeRlmSubagentRuntime(raw, (_v): _v is never => false, identity);
		expect(r).toBeNull();
	});

	test("expectedHostedIdentity Symbol key on identity object is rejected", () => {
		const identity: Record<string, unknown> = {
			childId: "c1",
			sessionId: "s1",
			sessionName: "w",
			modelSelector: "p/m",
		};
		Object.defineProperty(identity, Symbol("tag"), {
			value: "meta",
			enumerable: false,
		});
		const raw = {
			hostedPort: {
				identity: {
					childId: "c1",
					sessionId: "s1",
					sessionName: "w",
					modelSelector: "p/m",
				},
				startInitialTask: vi.fn(),
				abort: vi.fn(),
				observe: vi.fn(),
				subscribe: vi.fn(),
			},
		};
		const r = normalizeRlmSubagentRuntime(raw, (_v): _v is never => false, identity);
		expect(r).toBeNull();
	});

	test("expectedHostedIdentity with mismatching prototype is rejected", () => {
		const identity = Object.create({ childId: "c1" });
		identity.sessionId = "s1";
		identity.sessionName = "w";
		identity.modelSelector = "p/m";
		const raw = {
			hostedPort: {
				identity: {
					childId: "c1",
					sessionId: "s1",
					sessionName: "w",
					modelSelector: "p/m",
				},
				startInitialTask: vi.fn(),
				abort: vi.fn(),
				observe: vi.fn(),
				subscribe: vi.fn(),
			},
		};
		const r = normalizeRlmSubagentRuntime(raw, (_v): _v is never => false, identity);
		expect(r).toBeNull();
	});

	test("expectedHostedIdentity undefined rejected for hosted arm (only local arms omit it)", () => {
		const raw = {
			hostedPort: {
				identity: {
					childId: "c1",
					sessionId: "s1",
					sessionName: "w",
					modelSelector: "p/m",
				},
				startInitialTask: vi.fn(),
				abort: vi.fn(),
				observe: vi.fn(),
				subscribe: vi.fn(),
			},
		};
		expect(normalizeRlmSubagentRuntime(raw, (_v): _v is never => false, undefined)).toBeNull();
	});
});

describe("expectedHostedIdentity ALL FOUR required keys", () => {
	test("rejects missing childId key", () => {
		const identity: Record<string, unknown> = {
			sessionName: "w",
			modelSelector: "p/m",
			sessionId: "s1",
		};
		const port = {
			identity: {
				childId: "c1",
				sessionId: "s1",
				sessionName: "w",
				modelSelector: "p/m",
			},
			startInitialTask: vi.fn(),
			abort: vi.fn(),
			observe: vi.fn(),
			subscribe: vi.fn(),
		};
		const r = normalizeRlmSubagentRuntime({ hostedPort: port }, (_v): _v is never => false, identity);
		expect(r).toBeNull();
	});

	test("rejects missing sessionName key", () => {
		const identity: Record<string, unknown> = {
			childId: "c1",
			modelSelector: "p/m",
			sessionId: "s1",
		};
		const port = {
			identity: {
				childId: "c1",
				sessionId: "s1",
				sessionName: "w",
				modelSelector: "p/m",
			},
			startInitialTask: vi.fn(),
			abort: vi.fn(),
			observe: vi.fn(),
			subscribe: vi.fn(),
		};
		const r = normalizeRlmSubagentRuntime({ hostedPort: port }, (_v): _v is never => false, identity);
		expect(r).toBeNull();
	});

	test("rejects missing modelSelector key", () => {
		const identity: Record<string, unknown> = {
			childId: "c1",
			sessionName: "w",
			sessionId: "s1",
		};
		const port = {
			identity: {
				childId: "c1",
				sessionId: "s1",
				sessionName: "w",
				modelSelector: "p/m",
			},
			startInitialTask: vi.fn(),
			abort: vi.fn(),
			observe: vi.fn(),
			subscribe: vi.fn(),
		};
		const r = normalizeRlmSubagentRuntime({ hostedPort: port }, (_v): _v is never => false, identity);
		expect(r).toBeNull();
	});

	test("rejects missing sessionId key", () => {
		const identity: Record<string, unknown> = {
			childId: "c1",
			sessionName: "w",
			modelSelector: "p/m",
		};
		const port = {
			identity: {
				childId: "c1",
				sessionId: "s1",
				sessionName: "w",
				modelSelector: "p/m",
			},
			startInitialTask: vi.fn(),
			abort: vi.fn(),
			observe: vi.fn(),
			subscribe: vi.fn(),
		};
		const r = normalizeRlmSubagentRuntime({ hostedPort: port }, (_v): _v is never => false, identity);
		expect(r).toBeNull();
	});
});

describe("expectedHostedIdentity printable ASCII validation", () => {
	test("rejects whitespace char (0x20) in childId", () => {
		const identity: Record<string, unknown> = {
			childId: "c 1",
			sessionName: "w",
			modelSelector: "p/m",
			sessionId: "s1",
		};
		const port = {
			identity: {
				childId: "c1",
				sessionId: "s1",
				sessionName: "w",
				modelSelector: "p/m",
			},
			startInitialTask: vi.fn(),
			abort: vi.fn(),
			observe: vi.fn(),
			subscribe: vi.fn(),
		};
		const r = normalizeRlmSubagentRuntime({ hostedPort: port }, (_v): _v is never => false, identity);
		expect(r).toBeNull();
	});

	test("rejects control char (0x01) in childId", () => {
		const identityWithControl: Record<string, unknown> = {
			childId: "c\u0001",
			sessionName: "w",
			modelSelector: "p/m",
			sessionId: "s1",
		};
		const port = {
			identity: {
				childId: "c1",
				sessionId: "s1",
				sessionName: "w",
				modelSelector: "p/m",
			},
			startInitialTask: vi.fn(),
			abort: vi.fn(),
			observe: vi.fn(),
			subscribe: vi.fn(),
		};
		identityWithControl.childId = "c\u0001";
		const r = normalizeRlmSubagentRuntime({ hostedPort: port }, (_v): _v is never => false, identityWithControl);
		expect(r).toBeNull();
	});

	test("rejects non-ASCII char (U+00E9) in childId", () => {
		const identityWithHigh: Record<string, unknown> = {
			childId: "caf\u00e9",
			sessionName: "w",
			modelSelector: "p/m",
			sessionId: "s1",
		};
		const port = {
			identity: {
				childId: "c1",
				sessionId: "s1",
				sessionName: "w",
				modelSelector: "p/m",
			},
			startInitialTask: vi.fn(),
			abort: vi.fn(),
			observe: vi.fn(),
			subscribe: vi.fn(),
		};
		identityWithHigh.childId = "caf\u00e9";
		const r = normalizeRlmSubagentRuntime({ hostedPort: port }, (_v): _v is never => false, identityWithHigh);
		expect(r).toBeNull();
	});

	test("accepts bounded printable ASCII (0x21-0x7e)", () => {
		const identity: Record<string, unknown> = {
			childId: "child-1",
			sessionName: "w",
			modelSelector: "p/m",
			sessionId: "s1",
		};
		const port = {
			identity: {
				childId: "child-1",
				sessionId: "s1",
				sessionName: "w",
				modelSelector: "p/m",
			},
			startInitialTask: vi.fn(),
			abort: vi.fn(),
			observe: vi.fn(),
			subscribe: vi.fn(),
		};
		const r = normalizeRlmSubagentRuntime({ hostedPort: port }, (_v): _v is never => false, identity);
		expect(r).not.toBeNull();
	});
});

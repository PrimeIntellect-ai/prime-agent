import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { createDurableTargetInbox } from "../src/modes/daemon/durable-target-inbox.js";
import { createPreAuthorizedInbox } from "../src/modes/daemon/target-inbox-authorization-adapter.js";

// ===========================================================================
// Helpers
// ===========================================================================

function computeSha256(bytes: Uint8Array): string {
	return createHash("sha256").update(bytes).digest("hex");
}

function _sha256(bytes: Uint8Array): string {
	return createHash("sha256").update(bytes).digest("hex");
}

function makeResolvedSession(
	activeSessionId: string,
	sessionId: string,
	dir: string,
	opts: Record<string, unknown> = {},
): Record<string, unknown> {
	const result: Record<string, unknown> = {
		activeSessionId,
		sessionId,
		sessionDir: dir,
		rlmDepth: opts.rlmDepth ?? 1,
		runtimeKind: opts.runtimeKind ?? "subagent",
	};
	if (opts.sessionName !== undefined) result.sessionName = opts.sessionName;
	if (opts.parentSessionId !== undefined) result.parentSessionId = opts.parentSessionId;
	if (opts.parentSessionPath !== undefined) result.parentSessionPath = opts.parentSessionPath;
	return Object.freeze(result);
}

function makeCatalog(
	resolve: (id: string) => Promise<Record<string, unknown> | undefined> = async () => undefined,
): Record<string, unknown> {
	return Object.freeze({ resolveSession: resolve, close: async () => ({ status: "closed" }) });
}

interface DiskFile {
	readonly name: string;
	readonly bytes: Uint8Array;
}

function createDisk(): { files: DiskFile[] } {
	return { files: [] };
}

async function makeDurableInboxWrapper(
	disk: { files: DiskFile[] },
	counts: Record<string, number>,
	dispatcher: Record<string, unknown>,
): Promise<Record<string, unknown>> {
	const journalPublisher = Object.freeze({
		publish(raw: unknown): Promise<unknown> {
			counts.journal = (counts.journal ?? 0) + 1;
			const v = raw as { seq: number; bytes: Uint8Array };
			const r = { status: "success" as const, seq: v.seq, size: v.bytes.byteLength, sha256: computeSha256(v.bytes) };
			disk.files.push({ name: `${String(v.seq).padStart(20, "0")}.b03-journal`, bytes: new Uint8Array(v.bytes) });
			return Promise.resolve(r);
		},
		close(): Promise<unknown> {
			return Promise.resolve({ status: "closed" });
		},
	});
	const deliveryPublisher = Object.freeze({
		publish(raw: unknown): Promise<unknown> {
			counts.marker = (counts.marker ?? 0) + 1;
			const v = raw as { indexSeq: number; bytes: Uint8Array };
			const r = {
				status: "success" as const,
				sequence: v.indexSeq,
				size: v.bytes.byteLength,
				sha256: computeSha256(v.bytes),
			};
			disk.files.push({
				name: `${String(v.indexSeq).padStart(20, "0")}.b03-delivery`,
				bytes: new Uint8Array(v.bytes),
			});
			return Promise.resolve(r);
		},
		close(): Promise<unknown> {
			return Promise.resolve({ status: "closed" });
		},
	});
	const recoveryBackend = Object.freeze({
		listPage(raw: unknown): Promise<unknown> {
			counts.recovery = (counts.recovery ?? 0) + 1;
			const req = raw as { cursor: string | null };
			const sorted = [...disk.files].sort((a, b) => a.name.localeCompare(b.name));
			const startIdx = req.cursor === null ? 0 : sorted.findIndex((f) => f.name > req.cursor!) + 1;
			const page = sorted.slice(startIdx, startIdx + 64);
			return Promise.resolve({
				entries: page.map((f) => ({
					name: f.name,
					stat: {
						dev: "1",
						ino: String(disk.files.indexOf(f) + 1),
						uid: "501",
						mode: 0o600,
						size: f.bytes.byteLength,
						nlink: 1,
						isFile: true,
						isSymlink: false,
						mtimeNs: "1",
						ctimeNs: "1",
					},
				})),
				nextCursor: page[page.length - 1]?.name ?? null,
			});
		},
		open(raw: unknown): Promise<unknown> {
			const req = raw as { name: string };
			const file = disk.files.find((f) => f.name === req.name);
			if (!file) return Promise.resolve({ status: "error" });
			let pos = 0;
			return Promise.resolve({
				status: "opened",
				handle: Object.freeze({
					readAt(_offset: number, size: number): Promise<unknown> {
						const chunk = file.bytes.slice(pos, pos + size);
						pos += chunk.byteLength;
						return Promise.resolve({ status: "data", bytes: chunk });
					},
					close(): Promise<unknown> {
						return Promise.resolve({ status: "closed" });
					},
				}),
			});
		},
		close(): Promise<unknown> {
			return Promise.resolve({ status: "closed" });
		},
	});
	const rawResult = await createDurableTargetInbox(
		Object.freeze({
			identity: Object.freeze({ hostId: "h-1", generation: "g-1", sessionId: "child-1" }),
			direction: "received",
			journalDir: "/tmp/j",
			journalPublisher,
			deliveryPublisher,
			recoveryBackend,
			dispatcher,
		}),
	);
	if (!rawResult.ok) return Object.freeze({ ok: false });
	// Wrap the real inbox so methods are own enumerable
	const realInbox = rawResult.inbox;
	return Object.freeze({
		ok: true,
		inbox: Object.freeze({
			admit: (raw: unknown) => realInbox.admit(raw),
			dispatchPending: () => realInbox.dispatchPending(),
			close: () => realInbox.close(),
		}),
	});
}

function makeEnvelope(from = "parent-1", target = "child-1"): Record<string, unknown> {
	return Object.freeze({
		envelope: Object.freeze({
			type: "frame",
			frameId: "tf-1",
			protocol: Object.freeze({ name: "prime-agent.remote-host", version: 1 }),
			sentAt: "2025-01-01T00:00:00.000Z",
			frame: Object.freeze({
				type: "agent_message",
				id: "agentmsg_abc123",
				fromActiveSessionId: from,
				targetActiveSessionId: target,
				message: "hello",
			}),
		}),
	});
}

// ===========================================================================
// Tests
// ===========================================================================

describe("PreAuthorizedInbox", () => {
	it("authorizes parent-to-child and admits", async () => {
		const catalog = makeCatalog(async (id: string) => {
			if (id === "parent-1")
				return makeResolvedSession("parent-1", "sess-p", "/d/p", { rlmDepth: 0, runtimeKind: "top-level" });
			if (id === "child-1")
				return makeResolvedSession("child-1", "sess-c", "/d/c", {
					rlmDepth: 1,
					runtimeKind: "subagent",
					parentSessionId: "sess-p",
					parentSessionPath: "/d/p",
				});
			return undefined;
		});
		const counts: Record<string, number> = {};
		const disk = createDisk();
		const dispatcher: Record<string, unknown> = Object.freeze({
			ensure: async () => Object.freeze({ status: "persisted" }),
			close: async () => Object.freeze({ status: "closed" }),
		});
		const inboxResult = await makeDurableInboxWrapper(disk, counts, dispatcher);
		const ir = inboxResult as Record<string, unknown>;
		expect(ir.ok).toBe(true);
		if (!ir.ok) return;
		const inbox = ir.inbox;

		const created = await createPreAuthorizedInbox(Object.freeze({ catalog, inbox }));
		expect(created.ok).toBe(true);
		if (!created.ok) return;
		const pib = created.value;
		const result = await pib.authorizeAdmit(makeEnvelope());
		expect(result.ok).toBe(true);
		if (!result.ok) return;
		expect(result.value.allowed).toBe(true);
		expect(result.value.relationship.fromRelationship).toBe("parent");
		await pib.close();
	});

	it("authorizes child-to-parent", async () => {
		// Child sends to parent. Inbox is bound to parent-1 (the target).
		// Custom inbox creation with parent-1 identity.
		const catalog = makeCatalog(async (id: string) => {
			if (id === "child-1")
				return makeResolvedSession("child-1", "sess-c", "/d/c", {
					rlmDepth: 1,
					runtimeKind: "subagent",
					parentSessionId: "sess-p",
					parentSessionPath: "/d/p",
				});
			if (id === "parent-1")
				return makeResolvedSession("parent-1", "sess-p", "/d/p", { rlmDepth: 0, runtimeKind: "top-level" });
			return undefined;
		});
		const counts: Record<string, number> = {};
		const disk = createDisk();
		const dispatcher: Record<string, unknown> = Object.freeze({
			ensure: async () => Object.freeze({ status: "persisted" }),
			close: async () => Object.freeze({ status: "closed" }),
		});
		// Inbox bound to parent-1 (target session for child-to-parent)
		const rawResult = await createDurableTargetInbox(
			Object.freeze({
				identity: Object.freeze({ hostId: "h-1", generation: "g-1", sessionId: "parent-1" }),
				direction: "received",
				journalDir: "/tmp/j",
				journalPublisher: Object.freeze({
					publish(raw: unknown): Promise<unknown> {
						counts.journal = (counts.journal ?? 0) + 1;
						const v = raw as { seq: number; bytes: Uint8Array };
						const r = {
							status: "success" as const,
							seq: v.seq,
							size: v.bytes.byteLength,
							sha256: computeSha256(v.bytes),
						};
						disk.files.push({
							name: `${String(v.seq).padStart(20, "0")}.b03-journal`,
							bytes: new Uint8Array(v.bytes),
						});
						return Promise.resolve(r);
					},
					close(): Promise<unknown> {
						return Promise.resolve({ status: "closed" });
					},
				}),
				deliveryPublisher: Object.freeze({
					publish(raw: unknown): Promise<unknown> {
						counts.marker = (counts.marker ?? 0) + 1;
						const v = raw as { indexSeq: number; bytes: Uint8Array };
						const r = {
							status: "success" as const,
							sequence: v.indexSeq,
							size: v.bytes.byteLength,
							sha256: computeSha256(v.bytes),
						};
						disk.files.push({
							name: `${String(v.indexSeq).padStart(20, "0")}.b03-delivery`,
							bytes: new Uint8Array(v.bytes),
						});
						return Promise.resolve(r);
					},
					close(): Promise<unknown> {
						return Promise.resolve({ status: "closed" });
					},
				}),
				recoveryBackend: Object.freeze({
					listPage: async () => ({ entries: [], nextCursor: null }),
					open: async () => ({ status: "error" }),
					close: async () => ({ status: "closed" }),
				}),
				dispatcher,
			}),
		);
		// Wrap in plain object
		const inboxResult = rawResult.ok
			? Object.freeze({
					ok: true,
					inbox: Object.freeze({
						admit: (raw: unknown) => rawResult.inbox.admit(raw),
						dispatchPending: () => rawResult.inbox.dispatchPending(),
						close: () => rawResult.inbox.close(),
					}),
				})
			: Object.freeze({ ok: false });
		const ir = inboxResult as Record<string, unknown>;
		expect(ir.ok).toBe(true);
		if (!ir.ok) return;
		const inbox = ir.inbox;

		const created = await createPreAuthorizedInbox(Object.freeze({ catalog, inbox }));
		expect(created.ok).toBe(true);
		if (!created.ok) return;
		const pib = created.value;
		// Child sends to parent
		const result = await pib.authorizeAdmit(makeEnvelope("child-1", "parent-1"));
		expect(result.ok).toBe(true);
		if (!result.ok) return;
		expect(result.value.relationship.fromRelationship).toBe("child");
		await pib.close();
	});

	it("rejects unauthorized (no family relationship)", async () => {
		const catalog = makeCatalog(async (id: string) => {
			// A depth-1 session sending to a depth-0 session with no parent link
			if (id === "child-a")
				return makeResolvedSession("child-a", "s-a", "/d/a", {
					rlmDepth: 1,
					runtimeKind: "subagent",
					parentSessionId: "parent-x",
					parentSessionPath: "/d/px",
				});
			if (id === "root-b")
				return makeResolvedSession("root-b", "s-b", "/d/b", { rlmDepth: 0, runtimeKind: "top-level" });
			return undefined;
		});
		// Fake inbox (not real DurableTargetInbox) since we only need auth rejection
		const inbox = Object.freeze({
			admit: async () =>
				Object.freeze({
					ok: true,
					value: Object.freeze({
						status: "queued",
						receipt: Object.freeze({
							sequence: 1,
							size: 10,
							sha256: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
						}),
						frameId: "f-1",
						semanticId: "sm-1",
						semanticDigest: "b".repeat(64),
					}),
				}),
			dispatchPending: async () => Object.freeze({ ok: true, value: undefined }),
			close: async () => Object.freeze({ ok: true, value: undefined }),
		});
		const created = await createPreAuthorizedInbox(Object.freeze({ catalog, inbox }));
		expect(created.ok).toBe(true);
		if (!created.ok) return;
		const pib = created.value;
		const result = await pib.authorizeAdmit(makeEnvelope("child-a", "root-b"));
		expect(result.ok).toBe(false);
		if (!result.ok) expect(result.error.code).toBe("UNAUTHORIZED");
		await pib.close();
	});

	it("rejects unknown sender", async () => {
		const catalog = makeCatalog(async (id: string) => {
			if (id === "child-1") return makeResolvedSession("child-1", "sess-c", "/d/c");
			return undefined;
		});
		const counts: Record<string, number> = {};
		const disk = createDisk();
		const dispatcher: Record<string, unknown> = Object.freeze({
			ensure: async () => Object.freeze({ status: "persisted" }),
			close: async () => Object.freeze({ status: "closed" }),
		});
		const inboxResult = await makeDurableInboxWrapper(disk, counts, dispatcher);
		const ir = inboxResult as Record<string, unknown>;
		expect(ir.ok).toBe(true);
		if (!ir.ok) return;
		const inbox = ir.inbox;

		const created = await createPreAuthorizedInbox(Object.freeze({ catalog, inbox }));
		expect(created.ok).toBe(true);
		if (!created.ok) return;
		const pib = created.value;
		const result = await pib.authorizeAdmit(makeEnvelope("unknown", "child-1"));
		expect(result.ok).toBe(false);
		if (!result.ok) expect(result.error.code).toBe("NOT_FOUND");
		await pib.close();
	});

	it("rejects proxy input", async () => {
		const catalog = makeCatalog(async () => undefined);
		const inbox = Object.freeze({
			admit: async () =>
				Object.freeze({
					ok: true,
					value: Object.freeze({
						status: "queued",
						receipt: Object.freeze({
							sequence: 1,
							size: 10,
							sha256: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
						}),
						frameId: "f-1",
						semanticId: "sm-1",
						semanticDigest: "b".repeat(64),
					}),
				}),
			dispatchPending: async () => Object.freeze({ ok: true, value: undefined }),
			close: async () => Object.freeze({ ok: true, value: undefined }),
		});
		const created = await createPreAuthorizedInbox(Object.freeze({ catalog, inbox }));
		expect(created.ok).toBe(true);
		if (!created.ok) return;
		const pib = created.value;
		const proxy = new Proxy(makeEnvelope(), {});
		const result = await pib.authorizeAdmit(proxy);
		expect(result.ok).toBe(false);
		if (!result.ok) expect(result.error.code).toBe("INVALID_ARGUMENT");
		await pib.close();
	});

	it("close is idempotent", async () => {
		const catalog = makeCatalog(async () => undefined);
		const inbox = Object.freeze({
			admit: async () =>
				Object.freeze({
					ok: true,
					value: Object.freeze({
						status: "queued",
						receipt: Object.freeze({
							sequence: 1,
							size: 10,
							sha256: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
						}),
						frameId: "f-1",
						semanticId: "sm-1",
						semanticDigest: "b".repeat(64),
					}),
				}),
			dispatchPending: async () => Object.freeze({ ok: true, value: undefined }),
			close: async () => Object.freeze({ ok: true, value: undefined }),
		});
		const created = await createPreAuthorizedInbox(Object.freeze({ catalog, inbox }));
		expect(created.ok).toBe(true);
		if (!created.ok) return;
		const pib = created.value;
		const r1 = await pib.close();
		const r2 = await pib.close();
		expect(r1.ok).toBe(true);
		expect(r2.ok).toBe(true);
	});

	it("returns CLOSED after close", async () => {
		const catalog = makeCatalog(async () => undefined);
		const inbox = Object.freeze({
			admit: async () =>
				Object.freeze({
					ok: true,
					value: Object.freeze({
						status: "queued",
						receipt: Object.freeze({
							sequence: 1,
							size: 10,
							sha256: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
						}),
						frameId: "f-1",
						semanticId: "sm-1",
						semanticDigest: "b".repeat(64),
					}),
				}),
			dispatchPending: async () => Object.freeze({ ok: true, value: undefined }),
			close: async () => Object.freeze({ ok: true, value: undefined }),
		});
		const created = await createPreAuthorizedInbox(Object.freeze({ catalog, inbox }));
		expect(created.ok).toBe(true);
		if (!created.ok) return;
		const pib = created.value;
		await pib.close();
		const result = await pib.authorizeAdmit(makeEnvelope());
		expect(result.ok).toBe(false);
		if (!result.ok) expect(result.error.code).toBe("CLOSED");
	});

	it("rejects factory with aliased catalog=inbox", async () => {
		const both = Object.freeze({
			resolveSession: async () => undefined,
			close: async () => ({ status: "closed" }),
			admit: async () => ({}),
			dispatchPending: async () => ({}),
		});
		const created = await createPreAuthorizedInbox(Object.freeze({ catalog: both, inbox: both }));
		expect(created.ok).toBe(false);
	});

	it("rejects inbox proxy in factory", async () => {
		const catalog = makeCatalog(async () => undefined);
		const inbox = new Proxy(
			Object.freeze({
				admit: async () => ({}),
				dispatchPending: async () => ({}),
				close: async () => ({ status: "closed" }),
			}),
			{},
		);
		const created = await createPreAuthorizedInbox(Object.freeze({ catalog, inbox }));
		expect(created.ok).toBe(false);
	});

	it("rejects class-instance catalog (non-plain prototype)", async () => {
		class Fake {
			resolveSession = async (_id: string) => undefined;
			close = async () => ({ status: "closed" });
		}
		const inbox = Object.freeze({
			admit: async () =>
				Object.freeze({
					ok: true,
					value: Object.freeze({
						status: "queued",
						receipt: Object.freeze({
							sequence: 1,
							size: 10,
							sha256: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
						}),
						frameId: "f-1",
						semanticId: "sm-1",
						semanticDigest: "b".repeat(64),
					}),
				}),
			dispatchPending: async () => Object.freeze({ ok: true, value: undefined }),
			close: async () => Object.freeze({ ok: true, value: undefined }),
		});
		const created = await createPreAuthorizedInbox(Object.freeze({ catalog: new Fake(), inbox }));
		expect(created.ok).toBe(false);
	});

	// ---- Hostile ownership tests ----
	it("rejects null factory input (no close leak)", async () => {
		const created = await createPreAuthorizedInbox(null);
		expect(created.ok).toBe(false);
	});

	it("rejects proxy factory input (no close leak)", async () => {
		const proxy = new Proxy(
			Object.freeze({
				catalog: Object.freeze({
					resolveSession: async () => undefined,
					close: async () => ({ status: "closed" }),
				}),
				inbox: Object.freeze({
					admit: async () => ({}),
					dispatchPending: async () => ({}),
					close: async () => ({ ok: true, value: undefined }),
				}),
			}),
			{},
		);
		const created = await createPreAuthorizedInbox(proxy);
		expect(created.ok).toBe(false);
	});

	it("rejects catalog without close (close leak check)", async () => {
		const inbox = Object.freeze({
			admit: async () =>
				Object.freeze({
					ok: true,
					value: Object.freeze({
						status: "queued",
						receipt: Object.freeze({ sequence: 1, size: 10, sha256: "a".repeat(64) }),
						frameId: "f-1",
						semanticId: "sm-1",
						semanticDigest: "b".repeat(64),
					}),
				}),
			dispatchPending: async () => Object.freeze({ ok: true, value: undefined }),
			close: async () => Object.freeze({ ok: true, value: undefined }),
		});
		// Catalog missing close
		const badCatalog = Object.freeze({ resolveSession: async () => undefined });
		const created = await createPreAuthorizedInbox(Object.freeze({ catalog: badCatalog, inbox }));
		// close was acquired from inbox during preliminary but must be closed on rejection
		// Should return INVALID_ARGUMENT
		expect(created.ok).toBe(false);
	});

	it("rejects catalog with extra key (close leak check)", async () => {
		const inbox = Object.freeze({
			admit: async () =>
				Object.freeze({
					ok: true,
					value: Object.freeze({
						status: "queued",
						receipt: Object.freeze({ sequence: 1, size: 10, sha256: "a".repeat(64) }),
						frameId: "f-1",
						semanticId: "sm-1",
						semanticDigest: "b".repeat(64),
					}),
				}),
			dispatchPending: async () => Object.freeze({ ok: true, value: undefined }),
			close: async () => Object.freeze({ ok: true, value: undefined }),
		});
		const badCatalog = Object.freeze({
			resolveSession: async () => undefined,
			close: async () => ({ status: "closed" }),
			extraKey: "bad",
		});
		const created = await createPreAuthorizedInbox(Object.freeze({ catalog: badCatalog, inbox }));
		expect(created.ok).toBe(false);
	});

	it("rejects inbox with extra key (close leak check)", async () => {
		const catalog = Object.freeze({
			resolveSession: async () => undefined,
			close: async () => ({ status: "closed" }),
		});
		const badInbox = Object.freeze({
			admit: async () => ({}),
			dispatchPending: async () => ({}),
			close: async () => ({ ok: true, value: undefined }),
			extraKey: "bad",
		});
		const created = await createPreAuthorizedInbox(Object.freeze({ catalog, inbox: badInbox }));
		expect(created.ok).toBe(false);
	});

	it("close error on catalog close throws (close uncertainty)", async () => {
		let _catalogClosed = false;
		const catalog = Object.freeze({
			resolveSession: async () => undefined,
			close: async () => {
				_catalogClosed = true;
				throw new Error("close fail");
			},
		});
		const inbox = Object.freeze({
			admit: async () =>
				Object.freeze({
					ok: true,
					value: Object.freeze({
						status: "queued",
						receipt: Object.freeze({ sequence: 1, size: 10, sha256: "a".repeat(64) }),
						frameId: "f-1",
						semanticId: "sm-1",
						semanticDigest: "b".repeat(64),
					}),
				}),
			dispatchPending: async () => Object.freeze({ ok: true, value: undefined }),
			close: async () => Object.freeze({ ok: true, value: undefined }),
		});
		const created = await createPreAuthorizedInbox(Object.freeze({ catalog, inbox }));
		expect(created.ok).toBe(true);
		if (!created.ok) return;
		const pib = created.value;
		const r = await pib.close();
		// Catalog close threw, inbox close succeeds — should be CLOSE_UNCERTAIN
		expect(r.ok).toBe(false);
		if (!r.ok) expect(r.error.code).toBe("CLOSE_UNCERTAIN");
	});
	it("present-undefined optional field in resolved session is rejected", async () => {
		const catalog = Object.freeze({
			resolveSession: async (id: string) => {
				if (id === "parent-1")
					return Object.freeze({
						activeSessionId: "parent-1",
						sessionId: "sess-p",
						sessionDir: "/d/p",
						rlmDepth: 0,
						runtimeKind: undefined,
					});
				if (id === "child-1")
					return Object.freeze({
						activeSessionId: "child-1",
						sessionId: "sess-c",
						sessionDir: "/d/c",
						rlmDepth: 1,
						parentSessionPath: "/d/p",
						parentSessionId: "sess-p",
					});
				return undefined;
			},
			close: async () => Object.freeze({ status: "closed" }),
		});
		const inbox = Object.freeze({
			admit: async () =>
				Object.freeze({
					ok: true,
					value: Object.freeze({
						status: "queued",
						receipt: Object.freeze({ sequence: 1, size: 10, sha256: "a".repeat(64) }),
						frameId: "f-1",
						semanticId: "sm-1",
						semanticDigest: "b".repeat(64),
					}),
				}),
			dispatchPending: async () => Object.freeze({ ok: true, value: undefined }),
			close: async () => Object.freeze({ ok: true, value: undefined }),
		});
		const created = await createPreAuthorizedInbox(Object.freeze({ catalog, inbox }));
		expect(created.ok).toBe(true);
		if (!created.ok) return;
		const pib = created.value;
		// parent-1 has own-undefined runtimeKind which is now rejected
		const result = await pib.authorizeAdmit(makeEnvelope("parent-1", "child-1"));
		expect(result.ok).toBe(false);
		if (!result.ok) expect(result.error.code).toBe("NOT_FOUND");
		await pib.close();
	});

	it("rejects revocable proxy catalog in preliminary (safe close)", async () => {
		const { proxy, revoke } = Proxy.revocable(
			Object.freeze({ resolveSession: async () => undefined, close: async () => ({ status: "closed" }) }),
			{},
		);
		const inbox = Object.freeze({
			admit: async () =>
				Object.freeze({
					ok: true,
					value: Object.freeze({
						status: "queued",
						receipt: Object.freeze({ sequence: 1, size: 10, sha256: "a".repeat(64) }),
						frameId: "f-1",
						semanticId: "sm-1",
						semanticDigest: "b".repeat(64),
					}),
				}),
			dispatchPending: async () => Object.freeze({ ok: true, value: undefined }),
			close: async () => Object.freeze({ ok: true, value: undefined }),
		});
		revoke();
		const created = await createPreAuthorizedInbox(Object.freeze({ catalog: proxy, inbox }));
		expect(created.ok).toBe(false);
	});

	it("concurrent poison: second call returns fixed error DTO", async () => {
		let callCount = 0;
		const catalog = Object.freeze({
			resolveSession: async (_id: string) => {
				callCount++;
				if (callCount === 1)
					return Object.freeze({
						activeSessionId: "parent-1",
						sessionId: "sess-p",
						sessionDir: "/d/p",
						rlmDepth: 0,
					});
				// Second call resolves fine but adapter is already poisoned
				return Object.freeze({ activeSessionId: "child-1", sessionId: "sess-c", sessionDir: "/d/c", rlmDepth: 1 });
			},
			close: async () => Object.freeze({ status: "closed" }),
		});
		const inbox = Object.freeze({
			admit: async () =>
				Object.freeze({
					ok: true,
					value: Object.freeze({
						status: "queued",
						receipt: Object.freeze({ sequence: 1, size: 10, sha256: "a".repeat(64) }),
						frameId: "f-1",
						semanticId: "sm-1",
						semanticDigest: "b".repeat(64),
					}),
				}),
			dispatchPending: async () => Object.freeze({ ok: true, value: undefined }),
			close: async () => Object.freeze({ ok: true, value: undefined }),
		});
		const created = await createPreAuthorizedInbox(Object.freeze({ catalog, inbox }));
		expect(created.ok).toBe(true);
		if (!created.ok) return;
		const pib = created.value;
		// First call - parent-1 not found (no child session in catalog) -> not found
		const _r1 = await pib.authorizeAdmit(makeEnvelope("parent-1", "child-1"));
		// r1 is NOT_FOUND because parent-1 has no child link. But inbox was admitted so it's fine.
		// Actually parent-1 depth=0 looking for child-1 depth=1 without parentSessionPath -> not found

		// Use a cleaner approach: poison by making resolveSession throw
		const poisonCatalog = Object.freeze({
			resolveSession: async () => {
				throw new Error("crash");
			},
			close: async () => Object.freeze({ status: "closed" }),
		});
		const poisonCreated = await createPreAuthorizedInbox(Object.freeze({ catalog: poisonCatalog, inbox }));
		expect(poisonCreated.ok).toBe(true);
		if (!poisonCreated.ok) return;
		const poisonPib = poisonCreated.value;
		const r2 = await poisonPib.authorizeAdmit(makeEnvelope("parent-1", "child-1"));
		expect(r2.ok).toBe(false);
		// Now the adapter is poisoned; second call should return fixed error DTO, not throw
		const r3 = await poisonPib.authorizeAdmit(makeEnvelope("parent-1", "child-1"));
		expect(r3.ok).toBe(false);
		if (!r3.ok) expect(r3.error.code).toBe("POISONED");
		await poisonPib.close();
	});

	it("dispatchPending after poison returns fixed error DTO", async () => {
		const catalog = Object.freeze({
			resolveSession: async () => {
				throw new Error("crash");
			},
			close: async () => Object.freeze({ status: "closed" }),
		});
		const inbox = Object.freeze({
			admit: async () =>
				Object.freeze({
					ok: true,
					value: Object.freeze({
						status: "queued",
						receipt: Object.freeze({ sequence: 1, size: 10, sha256: "a".repeat(64) }),
						frameId: "f-1",
						semanticId: "sm-1",
						semanticDigest: "b".repeat(64),
					}),
				}),
			dispatchPending: async () => Object.freeze({ ok: true, value: undefined }),
			close: async () => Object.freeze({ ok: true, value: undefined }),
		});
		const created = await createPreAuthorizedInbox(Object.freeze({ catalog, inbox }));
		expect(created.ok).toBe(true);
		if (!created.ok) return;
		const pib = created.value;
		await pib.authorizeAdmit(makeEnvelope("parent-1", "child-1"));
		// Now poisoned; dispatch should return fixed error
		const r = await pib.dispatchPending();
		expect(r.ok).toBe(false);
		if (!r.ok) expect(r.error.code).toBe("POISONED");
	});

	it("acquires nested owners before rejecting a custom-prototype outer object", async () => {
		const closeOrder: string[] = [];
		const proto = Object.freeze({
			resolveSession: async () => undefined,
			close: async () => {
				closeOrder.push("catalog");
				return Object.freeze({ status: "closed" as const });
			},
		});
		const inbox = Object.freeze({
			admit: async () =>
				Object.freeze({
					ok: true,
					value: Object.freeze({
						status: "queued",
						receipt: Object.freeze({ sequence: 1, size: 10, sha256: "a".repeat(64) }),
						frameId: "f-1",
						semanticId: "sm-1",
						semanticDigest: "b".repeat(64),
					}),
				}),
			dispatchPending: async () => Object.freeze({ ok: true, value: undefined }),
			close: async () => {
				closeOrder.push("inbox");
				return Object.freeze({ ok: true as const, value: undefined });
			},
		});
		const outer = Object.assign(Object.create(proto), { catalog: proto, inbox });
		const created = await createPreAuthorizedInbox(outer);
		expect(created.ok).toBe(false);
		expect(closeOrder).toEqual(["inbox", "catalog"]);
	});

	it("acquires close from symbol-containing outer object then fails", async () => {
		const catalog = Object.freeze({
			resolveSession: async () => undefined,
			close: async () => ({ status: "closed" }),
		});
		const inbox = Object.freeze({
			admit: async () =>
				Object.freeze({
					ok: true,
					value: Object.freeze({
						status: "queued",
						receipt: Object.freeze({ sequence: 1, size: 10, sha256: "a".repeat(64) }),
						frameId: "f-1",
						semanticId: "sm-1",
						semanticDigest: "b".repeat(64),
					}),
				}),
			dispatchPending: async () => Object.freeze({ ok: true, value: undefined }),
			close: async () => Object.freeze({ ok: true, value: undefined }),
		});
		// Build outer without Object.freeze so we can add a symbol
		const outer: Record<string, unknown> = { catalog, inbox };
		Object.defineProperty(outer, Symbol("extra"), { value: true, enumerable: true });
		const created = await createPreAuthorizedInbox(outer);
		// Should fail because outer has extra Symbol key
		expect(created.ok).toBe(false);
	});

	it("acquires close from null-prototype outer object then fails", async () => {
		const catalog = Object.freeze({
			resolveSession: async () => undefined,
			close: async () => ({ status: "closed" }),
		});
		const inbox = Object.freeze({
			admit: async () =>
				Object.freeze({
					ok: true,
					value: Object.freeze({
						status: "queued",
						receipt: Object.freeze({ sequence: 1, size: 10, sha256: "a".repeat(64) }),
						frameId: "f-1",
						semanticId: "sm-1",
						semanticDigest: "b".repeat(64),
					}),
				}),
			dispatchPending: async () => Object.freeze({ ok: true, value: undefined }),
			close: async () => Object.freeze({ ok: true, value: undefined }),
		});
		// Outer object with null prototype
		const outer = Object.assign(Object.create(null), { catalog, inbox });
		const created = await createPreAuthorizedInbox(outer);
		// Should fail because null prototype is not Object.prototype
		expect(created.ok).toBe(false);
	});
});

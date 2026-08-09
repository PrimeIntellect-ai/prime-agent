import { setKeybindings } from "@earendil-works/pi-tui";
import stripAnsi from "strip-ansi";
import { beforeAll, describe, expect, it, vi } from "vitest";
import { KeybindingsManager } from "../src/core/keybindings.js";
import {
	AgentsViewMode,
	createReplyComposerAutocompleteProvider,
	getReplyComposerCommandRejection,
	parseAgentsViewCommand,
} from "../src/modes/agents-view/agents-view-mode.js";
import type { SessionSummary } from "../src/modes/daemon/daemon-session-list.js";

function summary(overrides: Partial<SessionSummary>): SessionSummary {
	return {
		id: "saved-1",
		lifecycle: "archived",
		activity: "idle",
		sessionId: "saved-1",
		cwd: process.cwd(),
		isStreaming: false,
		isCompacting: false,
		attachedClients: 0,
		messageCount: 3,
		sessionActions: { queuedCount: 0, steering: [], followUps: [] },
		...overrides,
		isSessionActive: overrides.isSessionActive ?? false,
	};
}

function invoke(method: string, self: object, ...args: unknown[]): unknown {
	const member = Reflect.get(AgentsViewMode.prototype, method) as ((...a: unknown[]) => unknown) | undefined;
	if (typeof member !== "function") {
		throw new Error(`AgentsViewMode.${method} no longer exists; update this test harness`);
	}
	return member.call(self, ...args);
}

function editorWithText(initial: string) {
	let text = initial;
	return {
		getText: () => text,
		setText: vi.fn((next: string) => {
			text = next;
		}),
	};
}

describe("agents view reply on inactive sessions", () => {
	beforeAll(() => {
		setKeybindings(new KeybindingsManager());
	});

	const savedSummary = summary({
		sessionFile: "/tmp/sessions/saved-1.jsonl",
		cwd: process.cwd(),
		summary: "Persisted recap text",
		firstMessage: "opener",
	});

	it("arms the composer on a saved-only row using the persisted recap", async () => {
		const setReplyTarget = vi.fn();
		const requestRender = vi.fn();
		const self: Record<string, unknown> = {
			rows: [
				{ kind: "agent", selectable: true, identity: "file:/tmp/sessions/saved-1.jsonl", summary: savedSummary },
			],
			selectedIndex: 0,
			pendingDeleteAgent: undefined,
			replyTarget: undefined,
			setReplyTarget,
			ui: { requestRender },
			requireClient: () => {
				throw new Error("saved rows must not hit the daemon for a preview");
			},
		};

		await invoke("toggleReplyTarget", self);

		expect(setReplyTarget).toHaveBeenCalledWith({ key: "saved-1", summary: savedSummary });
		expect(self.replyLastAssistantText).toBe("Persisted recap text");
	});

	it("ignores rows with neither a runtime nor a session file", async () => {
		const setReplyTarget = vi.fn();
		const self = {
			rows: [{ kind: "agent", selectable: true, identity: "session:saved-1", summary: summary({}) }],
			selectedIndex: 0,
			setReplyTarget,
		};

		await invoke("toggleReplyTarget", self);

		expect(setReplyTarget).not.toHaveBeenCalled();
	});

	it("resumes a saved session before delivering the reply", async () => {
		const request = vi.fn(async (command: { type: string }) => {
			if (command.type === "create") {
				return {
					success: true,
					data: { ...savedSummary, lifecycle: "live", activeSessionId: "active-9", isStreaming: true },
				};
			}
			return { success: true, data: {} };
		});
		const target = { key: "saved-1", summary: savedSummary };
		const self: Record<string, unknown> = {
			options: { config: { cwd: process.cwd() } },
			requireClient: () => ({ request }),
			replyTarget: target,
			// Stale pre-resume rows do not know the resumed session; scheduling must
			// come from the resume response instead.
			findSummaryByActiveSessionId: () => undefined,
			inactiveAgentIdentities: new Set(["file:/tmp/sessions/saved-1.jsonl"]),
			setStatusMessage: vi.fn(),
			setReplyTarget: vi.fn(),
			refreshSessions: vi.fn(async () => true),
			selectSummary: vi.fn(),
			sendPrompt: vi.fn(async () => {}),
		};

		await invoke("sendReply", self, target, "wake up");

		expect(request).toHaveBeenCalledWith(
			expect.objectContaining({ type: "create", sessionPath: savedSummary.sessionFile }),
		);
		expect(self.sendPrompt).toHaveBeenCalledWith(
			"active-9",
			"wake up",
			"steer",
			expect.objectContaining({ activeSessionId: "active-9" }),
			// The delivery connection revives with the config the resume just
			// created with, not one recomputed from the live summary.
			expect.any(Object),
		);
		expect(self.selectSummary).toHaveBeenCalledWith(expect.objectContaining({ activeSessionId: "active-9" }));
		expect(self.inactiveAgentIdentities).not.toContain("file:/tmp/sessions/saved-1.jsonl");
		expect(self.setReplyTarget).not.toHaveBeenCalled();
	});

	it("does not select a resumed session after its reply target is cancelled", async () => {
		let finishResume: ((result: { success: true; data: SessionSummary }) => void) | undefined;
		const request = vi.fn(
			() =>
				new Promise<{ success: true; data: SessionSummary }>((resolve) => {
					finishResume = resolve;
				}),
		);
		const target = { key: "saved-1", summary: savedSummary };
		const selection = { activeSessionId: "active-2" };
		const selectSummary = vi.fn((next: SessionSummary) => {
			selection.activeSessionId = next.activeSessionId ?? next.id;
		});
		const sendPrompt = vi.fn(async () => {});
		const self: Record<string, unknown> = {
			options: { config: { cwd: process.cwd() } },
			requireClient: () => ({ request }),
			findSummaryByActiveSessionId: () => undefined,
			inactiveAgentIdentities: new Set(["file:/tmp/sessions/saved-1.jsonl"]),
			replyTarget: target,
			setStatusMessage: vi.fn(),
			selectSummary,
			sendPrompt,
		};

		const reply = invoke("sendReply", self, target, "wake up") as Promise<boolean>;
		await vi.waitFor(() => expect(request).toHaveBeenCalledOnce());
		self.replyTarget = undefined;
		finishResume?.({
			success: true,
			data: { ...savedSummary, lifecycle: "live", activeSessionId: "active-9" },
		});

		await expect(reply).resolves.toBe(true);
		expect(selectSummary).not.toHaveBeenCalled();
		expect(selection.activeSessionId).toBe("active-2");
		expect(sendPrompt).toHaveBeenCalledWith(
			"active-9",
			"wake up",
			undefined,
			expect.objectContaining({ activeSessionId: "active-9" }),
			expect.any(Object),
		);
		expect(self.inactiveAgentIdentities).not.toContain("file:/tmp/sessions/saved-1.jsonl");
	});

	it("preserves a replacement composer when an older reply succeeds", async () => {
		const editor = editorWithText("old reply");
		const oldTarget = { key: "saved-1", summary: savedSummary };
		const newTarget = {
			key: "active-2",
			summary: summary({ id: "active-2", activeSessionId: "active-2", lifecycle: "live" }),
		};
		const self: Record<string, unknown> = {
			replyTarget: oldTarget,
			options: {},
			editor,
			setReplyTarget: vi.fn(),
			refreshSessions: vi.fn(async () => true),
			sendReply: vi.fn(async () => {
				self.replyTarget = newTarget;
				editor.setText("new reply");
				return true;
			}),
		};

		await invoke("submit", self, "old reply");

		expect(self.replyTarget).toBe(newTarget);
		expect(editor.getText()).toBe("new reply");
		expect(self.setReplyTarget).not.toHaveBeenCalled();
		expect(self.refreshSessions).toHaveBeenCalledWith({ preserveStatusOnError: true });
	});

	it("preserves new text entered while the same reply succeeds", async () => {
		const editor = editorWithText("first reply");
		const target = { key: "saved-1", summary: savedSummary };
		const self: Record<string, unknown> = {
			replyTarget: target,
			options: {},
			editor,
			setReplyTarget: vi.fn(),
			refreshSessions: vi.fn(async () => true),
			sendReply: vi.fn(async () => {
				editor.setText("next reply");
				return true;
			}),
		};

		await invoke("submit", self, "first reply");

		expect(self.replyTarget).toBe(target);
		expect(editor.getText()).toBe("next reply");
		expect(self.setReplyTarget).not.toHaveBeenCalled();
	});

	it.each([
		{ name: "resume failure", failure: "resume", remainsInactive: true },
		{ name: "send failure", failure: "send", remainsInactive: false },
		{
			name: "replacement text entered during send failure",
			failure: "send",
			replacement: "replacement",
			remainsInactive: false,
		},
	] as const)("handles $name", async ({ failure, replacement, remainsInactive }) => {
		const editor = editorWithText("wake up");
		const target = { key: "saved-1", summary: savedSummary };
		const inactiveAgentIdentities = new Set(["file:/tmp/sessions/saved-1.jsonl"]);
		const request = vi.fn(async () => {
			if (failure === "resume") throw new Error("resume failed");
			return {
				success: true,
				data: { ...savedSummary, lifecycle: "live", activeSessionId: "active-9" },
			};
		});
		const sendPrompt = vi.fn(async () => {
			if (replacement) editor.setText(replacement);
			throw new Error("send failed");
		});
		const self: Record<string, unknown> = {
			options: { config: { cwd: process.cwd() } },
			requireClient: () => ({ request }),
			findSummaryByActiveSessionId: () => undefined,
			inactiveAgentIdentities,
			replyTarget: target,
			editor,
			setStatusMessage: vi.fn(),
			setReplyTarget: vi.fn(),
			refreshSessions: vi.fn(async () => true),
			selectSummary: vi.fn(),
			sendPrompt,
			sendReply: (replyTarget: unknown, text: string) => invoke("sendReply", self, replyTarget, text),
		};

		await invoke("submit", self, "wake up");

		expect(editor.setText).toHaveBeenNthCalledWith(1, "");
		expect(editor.getText()).toBe(replacement ?? "wake up");
		expect(inactiveAgentIdentities.has("file:/tmp/sessions/saved-1.jsonl")).toBe(remainsInactive);
		expect(self.refreshSessions).toHaveBeenCalledTimes(remainsInactive ? 0 : 1);
		if (!remainsInactive) {
			expect(self.refreshSessions).toHaveBeenCalledWith({ preserveStatusOnError: true });
		}
	});

	it("keeps the cwd-fallback notice visible after the reply is sent", async () => {
		const missingCwd = "/definitely/not/a/real/dir/for/this/test";
		const savedWithMissingCwd = { ...savedSummary, cwd: missingCwd };
		const request = vi.fn(async () => ({
			success: true,
			data: { ...savedWithMissingCwd, lifecycle: "live", activeSessionId: "active-9" },
		}));
		const statuses: Array<[string, { sticky?: boolean } | undefined]> = [];
		const self: Record<string, unknown> = {
			options: { config: { cwd: process.cwd() } },
			requireClient: () => ({ request }),
			findSummaryByActiveSessionId: () => undefined,
			inactiveAgentIdentities: new Set(["file:/tmp/sessions/saved-1.jsonl"]),
			setStatusMessage: vi.fn((message: string, options?: { sticky?: boolean }) => {
				statuses.push([message, options]);
			}),
			setReplyTarget: vi.fn(),
			refreshSessions: vi.fn(async () => true),
			selectSummary: vi.fn(),
			sendPrompt: vi.fn(async () => {}),
		};

		await invoke("sendReply", self, { key: "saved-1", summary: savedWithMissingCwd }, "wake up");

		const last = statuses.at(-1);
		expect(last?.[0]).toContain("Original directory is missing");
		expect(last?.[1]).toEqual({ sticky: true });
	});

	it("resumes the current saved row when an armed live target becomes inactive", async () => {
		const capturedLive = summary({
			activeSessionId: "active-dead",
			lifecycle: "live",
			sessionFile: savedSummary.sessionFile,
		});
		const currentSaved = { ...savedSummary, activeSessionId: undefined };
		const request = vi.fn(async () => ({
			success: true,
			data: { ...currentSaved, lifecycle: "live", activeSessionId: "active-new" },
		}));
		const self: Record<string, unknown> = {
			options: { config: { cwd: process.cwd() } },
			requireClient: () => ({ request }),
			unifiedRecords: [
				{
					daemon: currentSaved,
					identity: "file:/tmp/sessions/saved-1.jsonl",
					identityAliases: ["file:/tmp/sessions/saved-1.jsonl"],
					section: "inactive",
					searchableText: "",
				},
			],
			findSummaryByActiveSessionId: () => undefined,
			inactiveAgentIdentities: new Set<string>(),
			replyTarget: undefined,
			setStatusMessage: vi.fn(),
			selectSummary: vi.fn(),
			sendPrompt: vi.fn(async () => {}),
		};

		await invoke("sendReply", self, { key: "active-dead", summary: capturedLive }, "wake up");

		expect(request).toHaveBeenCalledWith(
			expect.objectContaining({ type: "create", sessionPath: savedSummary.sessionFile }),
		);
		expect(self.sendPrompt).toHaveBeenCalledWith(
			"active-new",
			"wake up",
			undefined,
			expect.objectContaining({ activeSessionId: "active-new" }),
			expect.any(Object),
		);
		expect(self.sendPrompt).not.toHaveBeenCalledWith("active-dead", expect.anything(), expect.anything());
	});

	it("replies to live sessions without resuming, steering or queueing per delivery", async () => {
		let liveSummary = summary({ activeSessionId: "active-1", lifecycle: "live" });
		const request = vi.fn();
		const self: Record<string, unknown> = {
			options: { config: {} },
			requireClient: () => ({ request }),
			findSummaryByActiveSessionId: () => liveSummary,
			setStatusMessage: vi.fn(),
			selectSummary: vi.fn(),
			sendPrompt: vi.fn(async () => {}),
		};
		const target = () => ({ key: "active-1", summary: liveSummary });

		await invoke("sendReply", self, target(), "hello");
		expect(self.sendPrompt).toHaveBeenCalledWith(
			"active-1",
			"hello",
			undefined,
			expect.objectContaining({ activeSessionId: "active-1" }),
			undefined,
		);

		liveSummary = summary({ activeSessionId: "active-1", lifecycle: "live", isStreaming: true });
		await invoke("sendReply", self, target(), "change course");
		expect(self.sendPrompt).toHaveBeenCalledWith(
			"active-1",
			"change course",
			"steer",
			expect.objectContaining({ activeSessionId: "active-1" }),
			undefined,
		);

		await invoke("sendReply", self, target(), "later please", "followUp");
		expect(self.sendPrompt).toHaveBeenCalledWith(
			"active-1",
			"later please",
			"followUp",
			expect.objectContaining({ activeSessionId: "active-1" }),
			undefined,
		);

		expect(request).not.toHaveBeenCalled();
		expect(self.selectSummary).not.toHaveBeenCalled();
	});

	it("alt+enter submits expanded text as followUp, only with an armed target and text", () => {
		const submit = vi.fn(async () => {});
		invoke("handleReplyFollowUp", { replyTarget: undefined, editor: { getExpandedText: () => "text" }, submit });
		invoke("handleReplyFollowUp", {
			replyTarget: { key: "a", summary: summary({}) },
			editor: { getExpandedText: () => "   " },
			submit,
		});
		expect(submit).not.toHaveBeenCalled();

		invoke("handleReplyFollowUp", {
			replyTarget: { key: "active-1", summary: summary({ activeSessionId: "active-1" }) },
			editor: { getExpandedText: () => "expanded paste body" },
			submit,
		});
		expect(submit).toHaveBeenCalledWith("expanded paste body", "followUp");
	});

	it("ctrl+c disarms the composer instead of starting the exit flow", () => {
		const setReplyTarget = vi.fn();
		const handleCtrlC = vi.fn();
		const self: Record<string, unknown> = {
			clearStickyStatusMessage: vi.fn(),
			renameTarget: undefined,
			keybindings: { matches: (_d: string, action: string) => action === "app.clear" },
			replyTarget: { key: "active-1", summary: summary({ activeSessionId: "active-1" }) },
			setReplyTarget,
			handleCtrlC,
		};

		invoke("handleInput", self, "\x03");

		expect(setReplyTarget).toHaveBeenCalledWith(undefined);
		expect(handleCtrlC).not.toHaveBeenCalled();
	});

	it("creates a new daemon session over a dedicated connection and opens it", async () => {
		const created = summary({ id: "active-new", activeSessionId: "active-new", lifecycle: "live" });
		const request = vi.fn(async () => ({ success: true, data: created }));
		const close = vi.fn();
		const finish = vi.fn();
		const self: Record<string, unknown> = {
			creatingNewSession: false,
			options: { config: { cwd: process.cwd() } },
			connectDedicatedClient: vi.fn(async () => ({ request, close })),
			setStatusMessage: vi.fn(),
			selectSummary: vi.fn(),
			finish,
		};

		await invoke("createNewSession", self);

		expect(request).toHaveBeenCalledWith(expect.objectContaining({ type: "create" }));
		expect(self.selectSummary).toHaveBeenCalledWith(created);
		expect(finish).toHaveBeenCalledWith({ type: "open", summary: created });
		expect(close).toHaveBeenCalled();
	});

	it("kills a session created after the view already finished", async () => {
		const created = summary({ id: "active-new", activeSessionId: "active-new", lifecycle: "live" });
		const requests: { type: string }[] = [];
		const self: Record<string, unknown> = {
			creatingNewSession: false,
			stopped: false,
			options: { config: {} },
			connectDedicatedClient: vi.fn(async () => ({
				close: vi.fn(),
				request: vi.fn(async (command: { type: string }) => {
					requests.push(command);
					// The view finishes while create is in flight.
					self.stopped = true;
					return { success: true, data: created };
				}),
			})),
			setStatusMessage: vi.fn(),
			selectSummary: vi.fn(),
			finish: vi.fn(),
		};

		await invoke("createNewSession", self);

		expect(requests.map((r) => r.type)).toEqual(["create", "kill"]);
		expect(self.finish).not.toHaveBeenCalled();
		expect(self.selectSummary).not.toHaveBeenCalled();
	});

	it("reports create failures and resets the guard", async () => {
		// Failure after connecting.
		const finish = vi.fn();
		const setStatusMessage = vi.fn();
		const self: Record<string, unknown> = {
			creatingNewSession: false,
			options: { config: {} },
			connectDedicatedClient: vi.fn(async () => ({
				request: vi.fn(async () => {
					throw new Error("daemon busy");
				}),
				close: vi.fn(),
			})),
			setStatusMessage,
			selectSummary: vi.fn(),
			finish,
		};
		await expect(invoke("createNewSession", self)).resolves.toBe(false);
		expect(finish).not.toHaveBeenCalled();
		expect(setStatusMessage).toHaveBeenCalledWith(expect.stringContaining("Failed to create session"));
		expect(self.creatingNewSession).toBe(false);

		// Failure to connect at all must also reset the guard.
		self.creatingNewSession = false;
		self.connectDedicatedClient = vi.fn(async () => {
			throw new Error("Agents view daemon socket is not configured");
		});
		await expect(invoke("createNewSession", self)).resolves.toBe(false);
		expect(self.creatingNewSession).toBe(false);
	});

	it("shows composer-mode hints that track target state and typed text", () => {
		const live = summary({ activeSessionId: "active-1", lifecycle: "live", isStreaming: true });
		const self: Record<string, unknown> = {
			replyTarget: { key: "active-1", summary: live },
			unifiedRecords: [],
			findSummaryByActiveSessionId: () => live,
			editor: editorWithText(""),
		};

		const idleHints = stripAnsi(invoke("renderReplyComposerHints", self) as string);
		expect(idleHints).toContain("steer");
		expect(idleHints).toContain("cancel");
		expect(idleHints).not.toContain("queue");

		self.editor = editorWithText("some reply");
		const typedHints = stripAnsi(invoke("renderReplyComposerHints", self) as string);
		expect(typedHints).toContain("queue");

		const saved = summary({ sessionFile: "/tmp/sessions/saved-1.jsonl" });
		self.replyTarget = { key: "saved-1", summary: saved };
		self.findSummaryByActiveSessionId = () => undefined;
		const savedHints = stripAnsi(invoke("renderReplyComposerHints", self) as string);
		expect(savedHints).toContain("resume & send");
	});
});

describe("reply composer slash commands", () => {
	it("classifies composer input: session commands pass, other built-ins reject, plain text flows", () => {
		expect(getReplyComposerCommandRejection("/compact focus on the API work")).toBeUndefined();
		expect(getReplyComposerCommandRejection("/goal ship it")).toBeUndefined();
		expect(getReplyComposerCommandRejection("/model gpt-5")).toContain("/model is not available here");
		expect(getReplyComposerCommandRejection("/settings")).toContain("not available here");
		expect(getReplyComposerCommandRejection("/usr/local/bin looks wrong")).toBeUndefined();
		expect(getReplyComposerCommandRejection("plain reply")).toBeUndefined();
	});

	it("restores rejected-command drafts without overwriting newer typing", async () => {
		// submitValue empties the editor before onSubmit runs.
		const editor = editorWithText("");
		const setStatusMessage = vi.fn();
		const sendReply = vi.fn();
		const self: Record<string, unknown> = {
			replyTarget: { key: "active-1", summary: summary({ activeSessionId: "active-1" }) },
			options: {},
			editor,
			setStatusMessage,
			sendReply,
		};

		await invoke("submit", self, "/model gpt-5");
		expect(sendReply).not.toHaveBeenCalled();
		expect(setStatusMessage).toHaveBeenCalledWith(expect.stringContaining("not available here"), {
			tone: "warning",
		});
		expect(editor.getText()).toBe("/model gpt-5");

		editor.setText("newer draft");
		await invoke("submit", self, "/settings");
		expect(editor.getText()).toBe("newer draft");
	});

	it("binds reply autocomplete to the armed target's cwd", () => {
		const self: Record<string, unknown> = {
			replyTarget: undefined,
			replyAutocomplete: undefined,
			actionModeSearchQuery: undefined,
			persistentState: {},
			editor: Object.assign(editorWithText(""), { setPlaceholder: vi.fn() }),
			replyLastAssistantText: undefined,
			replyLastAssistantTextLoading: false,
			replyHeaderTime: "",
			rebuildRows: vi.fn(),
			ui: { requestRender: vi.fn() },
		};
		const target = { key: "active-1", summary: summary({ activeSessionId: "active-1", cwd: "/tmp/elsewhere" }) };
		invoke("setReplyTarget", self, target);
		expect(self.replyAutocomplete).toBeDefined();
		invoke("setReplyTarget", self, undefined);
		expect(self.replyAutocomplete).toBeUndefined();
	});
});

describe("agents view slash commands", () => {
	it("parses whitelisted view commands, which the composer never rejects", () => {
		expect(parseAgentsViewCommand("/name My Agent")).toEqual({ name: "name", args: "My Agent" });
		expect(parseAgentsViewCommand("/rename My Agent")).toEqual({ name: "name", args: "My Agent" });
		expect(parseAgentsViewCommand("/kill")).toEqual({ name: "kill", args: "" });
		expect(parseAgentsViewCommand("/compact")).toBeUndefined();
		expect(parseAgentsViewCommand("plain search text")).toBeUndefined();
		expect(getReplyComposerCommandRejection("/kill")).toBeUndefined();
		// /new and /fork are builtins but not composer commands; rejected with guidance.
		expect(getReplyComposerCommandRejection("/new")).toContain("not available here");
		expect(getReplyComposerCommandRejection("/fork")).toContain("not available here");
	});

	it("suggests session and view commands in the armed composer", async () => {
		const composer = createReplyComposerAutocompleteProvider(process.cwd());
		const signal = new AbortController().signal;
		const composerNames =
			(await composer.getSuggestions(["/"], 0, 1, { signal }))?.items.map((item) => item.value) ?? [];
		expect(composerNames).toEqual(
			expect.arrayContaining(["compact", "refine", "goal", "autonomous", "name", "kill"]),
		);
		expect(composerNames).not.toContain("new");
		expect(composerNames).not.toContain("model");
		expect(composerNames).not.toContain("settings");
	});

	it("search submit always opens the selection, even for slash-prefixed text", async () => {
		const openSelected = vi.fn();
		const self: Record<string, unknown> = {
			replyTarget: undefined,
			renameTarget: undefined,
			openSelected,
		};

		await invoke("submit", self, "release planner");
		await invoke("submit", self, "/kill");

		expect(openSelected).toHaveBeenCalledTimes(2);
	});

	it("renames a live target via the rename RPC and refreshes both catalogs", async () => {
		const live = summary({ activeSessionId: "active-1", lifecycle: "live" });
		const request = vi.fn(async () => ({ success: true, data: {} }));
		const editor = editorWithText("/name Fresh Name");
		const self: Record<string, unknown> = {
			options: {},
			requireClient: () => ({ request }),
			editor,
			setStatusMessage: vi.fn(),
			refreshSessions: vi.fn(async () => true),
			refreshSavedSessions: vi.fn(async () => true),
			renameSession(s: unknown, n: string) {
				return invoke("renameSession", self, s, n);
			},
			refreshBothCatalogs() {
				return invoke("refreshBothCatalogs", self);
			},
		};

		await expect(invoke("runAgentsViewCommand", self, { name: "name", args: "Fresh Name" }, live)).resolves.toBe(
			true,
		);

		expect(request).toHaveBeenCalledWith({ type: "rename", activeSessionId: "active-1", name: "Fresh Name" });
		expect(self.refreshSessions).toHaveBeenCalledWith({ preserveStatusOnError: true });
		expect(self.refreshSavedSessions).toHaveBeenCalledWith({ preserveStatusOnError: true });
	});

	it("kills a live target and disarms the composer", async () => {
		const live = summary({ activeSessionId: "active-1", lifecycle: "live" });
		const request = vi.fn(async () => ({ success: true, data: {} }));
		const setReplyTarget = vi.fn();
		const self: Record<string, unknown> = {
			requireClient: () => ({ request }),
			editor: editorWithText("/kill"),
			setStatusMessage: vi.fn(),
			setReplyTarget,
			replyTarget: { key: "active-1", summary: live },
			refreshBothCatalogs: vi.fn(async () => true),
		};

		await invoke("runAgentsViewCommand", self, { name: "kill", args: "" }, live);

		expect(request).toHaveBeenCalledWith({ type: "kill", activeSessionId: "active-1" });
		expect(setReplyTarget).toHaveBeenCalledWith(undefined);
		expect(self.refreshBothCatalogs).toHaveBeenCalled();

		// An agent that finished before the RPC still counts as stopped.
		self.request = undefined;
		self.requireClient = () => ({
			request: vi.fn(async () => ({ success: false, error: "Unknown active session: active-1" })),
		});
		await expect(invoke("runAgentsViewCommand", self, { name: "kill", args: "" }, live)).resolves.toBe(true);
	});

	it("does not disarm a composer that was re-armed during the command", async () => {
		const live = summary({ activeSessionId: "active-1", lifecycle: "live" });
		const originalTarget = { key: "active-1", summary: live };
		const newTarget = { key: "active-2", summary: summary({ activeSessionId: "active-2" }) };
		const setReplyTarget = vi.fn();
		const self: Record<string, unknown> = {
			requireClient: () => ({
				request: vi.fn(async () => {
					// The user re-arms against a different agent mid-RPC.
					self.replyTarget = newTarget;
					return { success: true, data: {} };
				}),
			}),
			editor: editorWithText(""),
			setStatusMessage: vi.fn(),
			setReplyTarget,
			replyTarget: originalTarget,
			refreshBothCatalogs: vi.fn(async () => true),
		};

		await invoke("runAgentsViewCommand", self, { name: "kill", args: "" }, live);

		expect(setReplyTarget).not.toHaveBeenCalled();
	});

	it("restores the command draft when the armed command fails", async () => {
		const live = summary({ activeSessionId: "active-1", lifecycle: "live" });
		const target = { key: "active-1", summary: live };
		const editor = editorWithText("");
		const self: Record<string, unknown> = {
			replyTarget: target,
			options: {},
			unifiedRecords: [],
			findSummaryByActiveSessionId: () => live,
			editor,
			setStatusMessage: vi.fn(),
			runAgentsViewCommand: vi.fn(async () => false),
		};

		await invoke("submit", self, "/name");

		expect(editor.getText()).toBe("/name");
	});

	it("re-resolves the armed target before dispatching a view command", async () => {
		const stale = summary({ sessionFile: "/tmp/sessions/saved-1.jsonl" });
		const liveNow = summary({
			sessionFile: "/tmp/sessions/saved-1.jsonl",
			activeSessionId: "active-9",
			lifecycle: "live",
		});
		const runAgentsViewCommand = vi.fn(async () => true);
		const self: Record<string, unknown> = {
			replyTarget: { key: "saved-1", summary: stale },
			options: {},
			unifiedRecords: [
				{
					daemon: liveNow,
					identity: "file:/tmp/sessions/saved-1.jsonl",
					identityAliases: ["file:/tmp/sessions/saved-1.jsonl"],
					section: "idle",
					searchableText: "",
				},
			],
			findSummaryByActiveSessionId: () => undefined,
			editor: editorWithText(""),
			runAgentsViewCommand,
		};

		await invoke("submit", self, "/kill");

		expect(runAgentsViewCommand).toHaveBeenCalledWith(
			{ name: "kill", args: "" },
			expect.objectContaining({ activeSessionId: "active-9" }),
		);
	});

	it("refuses /kill on an inactive row", async () => {
		const saved = summary({ sessionFile: "/tmp/sessions/saved-1.jsonl" });
		const request = vi.fn();
		const setStatusMessage = vi.fn();
		const self: Record<string, unknown> = {
			requireClient: () => ({ request }),
			editor: editorWithText("/kill"),
			setStatusMessage,
		};

		await invoke("runAgentsViewCommand", self, { name: "kill", args: "" }, saved);

		expect(request).not.toHaveBeenCalled();
		expect(setStatusMessage).toHaveBeenCalledWith(expect.stringContaining("inactive"), { tone: "warning" });
	});
});

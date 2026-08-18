import { setKeybindings } from "@earendil-works/pi-tui";
import stripAnsi from "strip-ansi";
import { beforeAll, describe, expect, it, vi } from "vitest";
import { KeybindingsManager } from "../src/core/keybindings.js";
import type { AgentConnectionRlmChildAgentSnapshot } from "../src/modes/agent-connection/types.js";
import {
	countDirectSubagentStatuses,
	SubagentSummaryLine,
} from "../src/modes/interactive/components/subagent-summary-line.js";
import { InteractiveMode } from "../src/modes/interactive/interactive-mode.js";
import { initTheme } from "../src/modes/interactive/theme/theme.js";

function child(
	id: string,
	status: AgentConnectionRlmChildAgentSnapshot["status"],
	overrides: Partial<AgentConnectionRlmChildAgentSnapshot> = {},
): AgentConnectionRlmChildAgentSnapshot {
	return { id, label: id, status, sessionDir: `/tmp/${id}`, ...overrides };
}

describe("SubagentSummaryLine", () => {
	beforeAll(() => {
		initTheme("dark");
		setKeybindings(new KeybindingsManager());
	});

	it("renders no subagent line without children and uses singular and plural labels", () => {
		const line = new SubagentSummaryLine();
		expect(line.render(120)).toEqual([]);

		line.setSubagentCounts({ total: 1, running: 1, idle: 0, inactive: 0 });
		let rendered = line.render(120).map(stripAnsi);
		expect(rendered).toHaveLength(1);
		expect(rendered[0]).toContain("1 subagent: 1 running · 0 idle · 0 inactive");

		line.setSubagentCounts({ total: 2, running: 1, idle: 1, inactive: 0 });
		rendered = line.render(120).map(stripAnsi);
		expect(rendered[0]).toContain("2 subagents: 1 running · 1 idle · 0 inactive");
	});

	it("counts only direct children using running, idle, and inactive status projections", () => {
		const children = [
			child("running", "running"),
			child("queued", "queued"),
			child("active", "done", { activity: { kind: "writing" } }),
			child("heartbeat", "done", { activeSessionId: "heartbeat-session" }),
			child("idle-done", "done", { activeSessionId: "idle-done-session" }),
			child("idle-error", "error", { activeSessionId: "idle-error-session" }),
			child("inactive-done", "done"),
			child("inactive-error", "error"),
			child("cancelled", "cancelled"),
			child("grandchild", "running", { parentId: "running" }),
		];

		expect(countDirectSubagentStatuses(children, undefined, new Set(["heartbeat-session"]))).toEqual({
			total: 8,
			running: 4,
			idle: 2,
			inactive: 2,
		});
	});

	it("opens on Enter or Right only when the daemon-backed line is selectable", () => {
		const line = new SubagentSummaryLine();
		const onOpen = vi.fn();
		line.onOpen = onOpen;
		line.setSubagentCounts({ total: 2, running: 0, idle: 2, inactive: 0 });
		line.setOpenable(true);

		line.handleInput("\r");
		line.handleInput("\x1b[C");

		expect(onOpen).toHaveBeenCalledTimes(2);
	});

	it("stays visible but non-selectable for an in-process connection", () => {
		const line = new SubagentSummaryLine();
		const onOpen = vi.fn();
		line.onOpen = onOpen;
		line.setSubagentCounts({ total: 1, running: 0, idle: 0, inactive: 1 });
		line.setOpenable(false);

		expect(stripAnsi(line.render(100).join("\n"))).toContain("1 subagent: 0 running · 0 idle · 1 inactive");
		expect(line.isSelectable()).toBe(false);
		line.handleInput("\r");
		expect(onOpen).not.toHaveBeenCalled();
	});

	it("updates the rendered counts from consecutive child-status events", () => {
		const line = new SubagentSummaryLine();
		line.setOpenable(true);
		const mode = Object.create(InteractiveMode.prototype) as InteractiveMode & Record<string, unknown>;
		Object.assign(mode, {
			subagentSnapshots: new Map<string, AgentConnectionRlmChildAgentSnapshot>(),
			rlmNodeId: undefined,
			heartbeatCatalog: [],
			subagentSummaryLine: line,
			updateScopedHeartbeats: vi.fn(),
			updateWorkingPulse: vi.fn(),
			syncWorkingLoader: vi.fn(),
			updateWorkingLoaderMessage: vi.fn(),
			ui: { requestRender: vi.fn() },
		});
		const update = Reflect.get(InteractiveMode.prototype, "updateSubagentSummary") as (
			this: typeof mode,
			value: AgentConnectionRlmChildAgentSnapshot,
		) => void;

		update.call(mode, child("worker", "running"));
		expect(stripAnsi(line.render(100).join("\n"))).toContain("1 running · 0 idle · 0 inactive");

		update.call(mode, child("worker", "done", { activeSessionId: "active-worker" }));
		expect(stripAnsi(line.render(100).join("\n"))).toContain("0 running · 1 idle · 0 inactive");
	});

	it("counts a retained completed child as running while a follow-up turn is active", () => {
		const line = new SubagentSummaryLine();
		const mode = Object.create(InteractiveMode.prototype) as InteractiveMode & Record<string, unknown>;
		Object.assign(mode, {
			subagentSnapshots: new Map<string, AgentConnectionRlmChildAgentSnapshot>(),
			rlmNodeId: undefined,
			heartbeatCatalog: [],
			subagentSummaryLine: line,
			updateScopedHeartbeats: vi.fn(),
			updateWorkingPulse: vi.fn(),
			syncWorkingLoader: vi.fn(),
			updateWorkingLoaderMessage: vi.fn(),
			ui: { requestRender: vi.fn() },
		});
		const update = Reflect.get(InteractiveMode.prototype, "updateSubagentSummary") as (
			this: typeof mode,
			value: AgentConnectionRlmChildAgentSnapshot,
		) => void;

		update.call(mode, child("worker", "done", { activeSessionId: "resident-worker" }));
		expect(stripAnsi(line.render(100).join("\n"))).toContain("0 running · 1 idle · 0 inactive");

		update.call(mode, child("worker", "done", { activeSessionId: "resident-worker", activity: { kind: "waiting" } }));
		expect(stripAnsi(line.render(100).join("\n"))).toContain("1 running · 0 idle · 0 inactive");

		update.call(mode, child("worker", "done", { activeSessionId: "resident-worker" }));
		expect(stripAnsi(line.render(100).join("\n"))).toContain("0 running · 1 idle · 0 inactive");
	});

	it("refreshes counts when startup seeding follows an early live child update", () => {
		const line = new SubagentSummaryLine();
		const mode = Object.create(InteractiveMode.prototype) as InteractiveMode & Record<string, unknown>;
		Object.assign(mode, {
			subagentSnapshots: new Map<string, AgentConnectionRlmChildAgentSnapshot>(),
			rlmNodeId: undefined,
			heartbeatCatalog: [],
			subagentSummaryLine: line,
			updateScopedHeartbeats: vi.fn(),
			updateWorkingPulse: vi.fn(),
			syncWorkingLoader: vi.fn(),
			updateWorkingLoaderMessage: vi.fn(),
			ui: { requestRender: vi.fn() },
		});
		const worker = child("worker", "done", { parentId: "me" });
		const update = Reflect.get(InteractiveMode.prototype, "updateSubagentSummary") as (
			this: typeof mode,
			value: AgentConnectionRlmChildAgentSnapshot,
		) => void;
		const seed = Reflect.get(InteractiveMode.prototype, "seedSubagentSummary") as (
			this: typeof mode,
			children: readonly AgentConnectionRlmChildAgentSnapshot[],
		) => void;

		update.call(mode, worker);
		expect(line.render(100)).toEqual([]);
		Reflect.set(mode, "rlmNodeId", "me");
		seed.call(mode, [worker]);

		expect(stripAnsi(line.render(100).join("\n"))).toContain("1 subagent:");
	});

	it("clears a resident session id when a terminal update reports an evicted child", () => {
		const line = new SubagentSummaryLine();
		const mode = Object.create(InteractiveMode.prototype) as InteractiveMode & Record<string, unknown>;
		Object.assign(mode, {
			subagentSnapshots: new Map<string, AgentConnectionRlmChildAgentSnapshot>(),
			rlmNodeId: undefined,
			heartbeatCatalog: [],
			subagentSummaryLine: line,
			updateScopedHeartbeats: vi.fn(),
			updateWorkingPulse: vi.fn(),
			syncWorkingLoader: vi.fn(),
			updateWorkingLoaderMessage: vi.fn(),
			ui: { requestRender: vi.fn() },
		});
		const update = Reflect.get(InteractiveMode.prototype, "updateSubagentSummary") as (
			this: typeof mode,
			value: AgentConnectionRlmChildAgentSnapshot,
		) => void;

		update.call(mode, child("worker", "running", { activeSessionId: "resident-worker" }));
		// Active partial updates retain the last known resident id.
		update.call(mode, child("worker", "running"));
		update.call(mode, child("worker", "done"));

		expect(stripAnsi(line.render(100).join("\n"))).toContain("0 running · 0 idle · 1 inactive");
	});

	it("turns a selection into the scoped agents-view run result", async () => {
		const returnToAgentsView = vi.fn(async () => undefined);
		const mode = Object.create(InteractiveMode.prototype) as InteractiveMode & Record<string, unknown>;
		Object.assign(mode, {
			editor: { getText: () => "" },
			options: { returnToAgentsView: true },
			returnToAgentsView,
		});
		const open = Reflect.get(InteractiveMode.prototype, "openScopedAgentsView") as (
			this: typeof mode,
		) => Promise<void>;
		const line = new SubagentSummaryLine();
		line.setSubagentCounts({ total: 1, running: 1, idle: 0, inactive: 0 });
		line.setOpenable(true);
		line.onOpen = () => void open.call(mode);

		line.handleInput("\r");
		await vi.waitFor(() => expect(returnToAgentsView).toHaveBeenCalledWith("scoped_agents_view"));
	});
});

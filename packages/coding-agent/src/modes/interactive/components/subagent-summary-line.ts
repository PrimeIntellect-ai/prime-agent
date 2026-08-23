import { type Component, type Focusable, getKeybindings, truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";
import type { AgentConnectionRlmChildAgentSnapshot } from "../../agent-connection/index.js";
import { theme } from "../theme/theme.js";
import { keyText } from "./keybinding-hints.js";

export interface SubagentSummaryCounts {
	total: number;
	running: number;
	idle: number;
	inactive: number;
}

export function countDirectSubagentStatuses(
	children: Iterable<AgentConnectionRlmChildAgentSnapshot>,
	parentId: string | undefined,
	activeHeartbeatSessionIds: ReadonlySet<string>,
): SubagentSummaryCounts {
	let total = 0;
	let running = 0;
	let idle = 0;
	for (const child of children) {
		if (child.parentId !== parentId || child.status === "cancelled") continue;
		total += 1;
		const isRunning =
			child.status === "running" ||
			child.status === "queued" ||
			child.activity !== undefined ||
			(child.activeSessionId !== undefined && activeHeartbeatSessionIds.has(child.activeSessionId));
		if (isRunning) {
			running += 1;
		} else if ((child.status === "done" || child.status === "error") && child.activeSessionId !== undefined) {
			idle += 1;
		}
	}
	return { total, running, idle, inactive: total - running - idle };
}

/** One-line entry into the current session's scoped agents view. */
export class SubagentSummaryLine implements Component, Focusable {
	focused = false;
	private counts: SubagentSummaryCounts = { total: 0, running: 0, idle: 0, inactive: 0 };
	private openable = false;

	onOpen?: () => void;
	onCancel?: () => void;
	onChatAction?: (data: string) => void;

	constructor(
		private readonly getLocationLabel: () => string | undefined = () => undefined,
		private readonly getContextLabel: () => string | undefined = () => undefined,
		private readonly getOverrideLabel: () => string | undefined = () => undefined,
	) {}

	setSubagentCounts(counts: SubagentSummaryCounts): void {
		this.counts = counts;
	}

	setOpenable(openable: boolean): void {
		this.openable = openable;
	}

	isSelectable(): boolean {
		return this.counts.total > 0 && this.openable;
	}

	handleInput(data: string): void {
		const keybindings = getKeybindings();
		if (keybindings.matches(data, "tui.select.confirm") || keybindings.matches(data, "app.agents.open")) {
			if (this.isSelectable()) this.onOpen?.();
			return;
		}
		if (
			keybindings.matches(data, "tui.select.up") ||
			keybindings.matches(data, "tui.select.cancel") ||
			keybindings.matches(data, "app.agents.back")
		) {
			this.onCancel?.();
			return;
		}
		this.onChatAction?.(data);
	}

	render(width: number): string[] {
		const lines = this.renderInfoLine(width);
		if (this.counts.total === 0) return lines;
		if (width < 2) return lines;
		const safeWidth = width;
		const inner = safeWidth - 2;
		const label = theme.fg("accent", "[1magents[22m");
		const top = truncateToWidth(
			`${theme.fg("border", "╭─ ")}${label}${theme.fg("border", ` ${"─".repeat(Math.max(0, inner - 9))}╮`)}`,
			safeWidth,
			"…",
		);
		const counts =
			theme.fg("success", `● ${this.counts.running} running`) +
			"   " +
			theme.fg("warning", `◐ ${this.counts.idle} idle`) +
			"   " +
			theme.fg("dim", `○ ${this.counts.inactive} inactive`);
		const openHint = this.openable
			? this.focused
				? `${keyText("tui.select.confirm")}/${keyText("app.agents.open")} open`
				: `${keyText("tui.editor.cursorDown", { primaryOnly: true })} select`
			: "";
		const gap = Math.max(1, inner - 2 - visibleWidth(counts) - visibleWidth(openHint));
		const body = truncateToWidth(` ${counts}${" ".repeat(gap)}${theme.fg("dim", openHint)} `, inner, "…");
		const pad = " ".repeat(Math.max(0, inner - visibleWidth(body)));
		// Truncation may inject full ANSI resets; wrap each segment so the
		// selection background survives past them (custom-editor precedent).
		const content = this.focused
			? `${body}${pad}`
					.split("\x1b[0m")
					.map((segment) => theme.bg("selectedBg", segment))
					.join("\x1b[0m")
			: `${body}${pad}`;
		lines.push(
			top,
			`${theme.fg("border", "│")}${content}${theme.fg("border", "│")}`,
			theme.fg("border", `╰${"─".repeat(inner)}╯`),
		);
		return lines;
	}

	private renderInfoLine(width: number): string[] {
		const overrideLabel = this.getOverrideLabel()?.trim();
		const locationLabel = this.getLocationLabel()?.trim();
		const contextLabel = this.getContextLabel()?.trim();
		const left = overrideLabel || locationLabel || "";
		if (!left && !contextLabel) return [];
		const safeWidth = Math.max(1, width);
		const right = contextLabel ?? "";
		const gap = left && right ? 2 : 0;
		const rightWidth = Math.min(visibleWidth(right), Math.max(0, safeWidth - gap));
		const leftWidth = Math.max(0, safeWidth - rightWidth - gap);
		const renderedLeft = truncateToWidth(left, leftWidth, "…");
		const renderedRight = truncateToWidth(right, rightWidth, "…");
		const padding = Math.max(0, safeWidth - visibleWidth(renderedLeft) - visibleWidth(renderedRight));
		return [theme.fg("muted", `${renderedLeft}${" ".repeat(padding)}${renderedRight}`)];
	}

	invalidate(): void {
		// Render output is derived from counts and focus state.
	}
}

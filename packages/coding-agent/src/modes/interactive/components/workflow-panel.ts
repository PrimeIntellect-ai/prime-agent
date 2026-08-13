import { getKeybindings, type TUI, truncateToWidth, visibleWidth, wrapTextWithAnsi } from "@earendil-works/pi-tui";
import type {
	ExtensionWorkflowPanelAgent,
	ExtensionWorkflowPanelData,
	ExtensionWorkflowPanelPhase,
} from "../../../core/extensions/types.js";
import type { Theme } from "../theme/theme.js";

export interface WorkflowPanelResult {
	action: string;
}

type PanelFocus = "phases" | "agents" | "actions";
type PanelView = "overview" | "agent";

export class WorkflowPanelComponent {
	private _focused = true;
	private focus: PanelFocus = "phases";
	private view: PanelView = "overview";
	private phaseIndex = 0;
	private agentIndex = 0;
	private actionIndex = 0;
	private detailScroll = 0;
	private refreshTimer: ReturnType<typeof setInterval> | undefined;

	constructor(
		private readonly tui: TUI,
		private readonly theme: Theme,
		private data: ExtensionWorkflowPanelData,
		private readonly done: (result: WorkflowPanelResult | undefined) => void,
		refresh?: () => ExtensionWorkflowPanelData | undefined,
	) {
		if (refresh) {
			let lastClockRender = Date.now();
			this.refreshTimer = setInterval(() => {
				try {
					const updated = refresh();
					if (updated) {
						this.updateData(updated);
						lastClockRender = Date.now();
					} else if (hasRunningWork(this.data) && Date.now() - lastClockRender >= 1000) {
						lastClockRender = Date.now();
						this.invalidate();
					}
				} catch {
					// A transient persistence read must not escape the UI timer.
				}
			}, 250);
			this.refreshTimer.unref?.();
		}
	}

	get focused(): boolean {
		return this._focused;
	}

	set focused(value: boolean) {
		this._focused = value;
	}

	dispose(): void {
		if (!this.refreshTimer) return;
		clearInterval(this.refreshTimer);
		this.refreshTimer = undefined;
	}

	get selectedPhase(): ExtensionWorkflowPanelPhase | undefined {
		return this.data.phases[this.phaseIndex];
	}

	get selectedAgent(): ExtensionWorkflowPanelAgent | undefined {
		return this.selectedPhase?.agents[this.agentIndex];
	}

	handleInput(data: string): void {
		const keybindings = getKeybindings();
		if (keybindings.matches(data, "tui.select.cancel")) {
			if (this.view === "agent") {
				this.view = "overview";
				this.invalidate();
			} else {
				this.done(undefined);
			}
			return;
		}
		if (this.view === "agent") {
			if (keybindings.matches(data, "tui.select.up")) this.detailScroll = Math.max(0, this.detailScroll - 1);
			else if (keybindings.matches(data, "tui.select.down")) this.detailScroll++;
			else return;
			this.invalidate();
			return;
		}
		if (keybindings.matches(data, "tui.input.tab")) {
			this.focus = this.focus === "phases" ? "agents" : this.focus === "agents" ? "actions" : "phases";
			this.invalidate();
			return;
		}
		if (keybindings.matches(data, "tui.select.up")) {
			this.move(-1);
			return;
		}
		if (keybindings.matches(data, "tui.select.down")) {
			this.move(1);
			return;
		}
		if (!keybindings.matches(data, "tui.select.confirm")) return;
		if (this.focus === "phases") {
			this.focus = this.selectedPhase ? "agents" : "actions";
			this.agentIndex = 0;
			this.invalidate();
			return;
		}
		if (this.focus === "agents") {
			if (this.selectedAgent) {
				this.view = "agent";
				this.detailScroll = 0;
			} else this.focus = "actions";
			this.invalidate();
			return;
		}
		const action = this.data.actions[this.actionIndex];
		if (action) this.done({ action });
	}

	render(width: number): string[] {
		const safeWidth = Math.max(32, width);
		return this.view === "agent" ? this.renderAgent(safeWidth) : this.renderOverview(safeWidth);
	}

	invalidate(): void {
		this.tui.requestRender();
	}

	private updateData(updated: ExtensionWorkflowPanelData): void {
		const selectedPhaseTitle = this.selectedPhase?.title;
		const selectedAgentId = this.selectedAgent?.id;
		const selectedAction = this.data.actions[this.actionIndex];
		this.data = updated;
		const phaseIndex = selectedPhaseTitle
			? updated.phases.findIndex((phase) => phase.title === selectedPhaseTitle)
			: -1;
		this.phaseIndex = phaseIndex >= 0 ? phaseIndex : boundedIndex(this.phaseIndex, updated.phases.length);
		const agents = this.selectedPhase?.agents ?? [];
		const agentIndex = selectedAgentId === undefined ? -1 : agents.findIndex((agent) => agent.id === selectedAgentId);
		this.agentIndex = agentIndex >= 0 ? agentIndex : boundedIndex(this.agentIndex, agents.length);
		const actionIndex = selectedAction ? updated.actions.indexOf(selectedAction) : -1;
		const safeActionIndex = updated.actions.indexOf("Back");
		this.actionIndex = actionIndex >= 0 ? actionIndex : Math.max(0, safeActionIndex);
		this.invalidate();
	}

	private move(delta: number): void {
		if (this.focus === "phases") {
			this.phaseIndex = boundedIndex(this.phaseIndex + delta, this.data.phases.length);
			this.agentIndex = 0;
		} else if (this.focus === "agents") {
			this.agentIndex = boundedIndex(this.agentIndex + delta, this.selectedPhase?.agents.length ?? 0);
		} else {
			this.actionIndex = boundedIndex(this.actionIndex + delta, this.data.actions.length);
		}
		this.invalidate();
	}

	private renderOverview(width: number): string[] {
		const lines = this.renderHeader(width);
		if (width < 72) return this.renderStackedOverview(lines, width);
		const phaseWidth = Math.max(18, Math.min(30, Math.floor(width * 0.28)));
		const agentWidth = width - phaseWidth - 3;
		const allPhaseRows = this.data.phases.map((phase, index) => {
			const completed = phase.agents.filter(isFinished).length;
			const selected = index === this.phaseIndex;
			return `${this.focus === "phases" && selected ? "❯" : " "} ${phaseStatus(phase)} ${phase.title} ${completed}/${phase.agents.length}`;
		});
		const allAgentRows = (this.selectedPhase?.agents ?? []).map((agent, index) => {
			const selected = index === this.agentIndex;
			const model = agent.model ? ` ${agent.model}` : "";
			const tokens = agent.totalTokens === undefined ? "" : ` · ${formatTokens(agent.totalTokens)} tok`;
			return `${this.focus === "agents" && selected ? "❯" : " "}${agentStatus(agent.status)} ${agent.label}${model}${tokens}  ${formatAgentDuration(agent)}`;
		});
		const viewportRows = Math.max(4, getTerminalRows(this.tui) - 9);
		const bodyRows = Math.max(4, Math.min(24, viewportRows, Math.max(allPhaseRows.length, allAgentRows.length) + 2));
		const phaseRows = visibleRows(allPhaseRows, this.phaseIndex, bodyRows);
		const agentRows = visibleRows(allAgentRows, this.agentIndex, bodyRows);
		lines.push(
			...twoPane(
				"Phases",
				phaseRows,
				phaseWidth,
				this.selectedPhase?.title ?? "Agents",
				agentRows,
				agentWidth,
				bodyRows,
				this.theme,
			),
		);
		lines.push("");
		lines.push(this.renderActions(width));
		lines.push(this.theme.fg("dim", " ↑↓ select · tab pane · enter open · esc close"));
		return lines;
	}

	private renderStackedOverview(lines: string[], width: number): string[] {
		lines.push(this.theme.fg("accent", " Phases"));
		const phaseRows = this.data.phases.map((phase, index) => {
			const completed = phase.agents.filter(isFinished).length;
			return `${this.focus === "phases" && index === this.phaseIndex ? "❯" : " "} ${phaseStatus(phase)} ${phase.title} ${completed}/${phase.agents.length}`;
		});
		lines.push(...visibleRows(phaseRows, this.phaseIndex, 6).map((line) => truncateToWidth(line, width)));
		lines.push("", this.theme.fg("accent", ` ${this.selectedPhase?.title ?? "Agents"}`));
		const agentRows = (this.selectedPhase?.agents ?? []).map((agent, index) => {
			const tokens = agent.totalTokens === undefined ? "" : ` · ${formatTokens(agent.totalTokens)} tok`;
			return `${this.focus === "agents" && index === this.agentIndex ? "❯" : " "}${agentStatus(agent.status)} ${agent.label}${tokens}`;
		});
		lines.push(...visibleRows(agentRows, this.agentIndex, 8).map((line) => truncateToWidth(line, width)));
		if (agentRows.length === 0) lines.push(this.theme.fg("muted", " No agents started"));
		lines.push("", this.renderActions(width));
		lines.push(this.theme.fg("dim", " ↑↓ select · tab pane · enter open · esc close"));
		return lines;
	}

	private renderAgent(width: number): string[] {
		const agent = this.selectedAgent;
		const lines = this.renderHeader(width);
		if (!agent) {
			lines.push(this.theme.fg("muted", " No agent selected"));
			return lines;
		}
		const detail = [this.theme.fg("accent", ` ${agent.label}`)];
		detail.push(
			` ${agentStatus(agent.status)} ${titleCase(agent.status)}${agent.model ? ` · ${agent.model}` : ""}${agent.effort ? ` · ${agent.effort}` : ""}`,
		);
		detail.push(
			this.theme.fg(
				"dim",
				` ${agent.totalTokens === undefined ? "tokens unavailable" : `${formatTokens(agent.totalTokens)} tok`}${agent.cost === undefined ? "" : ` · $${agent.cost.toFixed(4)}`} · ${formatAgentDuration(agent)}`,
			),
		);
		appendSection(detail, "Prompt", agent.prompt, width, this.theme);
		appendSection(detail, "Outcome", agent.resultPreview, width, this.theme);
		appendSection(detail, "Error", agent.error, width, this.theme);
		const detailRows = Math.max(6, Math.min(26, getTerminalRows(this.tui) - 6));
		const maxScroll = Math.max(0, detail.length - detailRows);
		this.detailScroll = Math.min(this.detailScroll, maxScroll);
		lines.push(...detail.slice(this.detailScroll, this.detailScroll + detailRows));
		lines.push("", this.theme.fg("dim", " ↑↓ scroll · esc back"));
		return lines;
	}

	private renderHeader(width: number): string[] {
		const durationMs =
			this.data.durationMs ??
			(this.data.startedAt ? Math.max(0, Date.now() - Date.parse(this.data.startedAt)) : undefined);
		const summary = `${this.data.agentCount} agent${this.data.agentCount === 1 ? "" : "s"} · ${formatDuration(durationMs)} · ${this.data.status}`;
		return [
			this.theme.fg("accent", "─".repeat(width)),
			this.theme.bold(` ${this.data.workflowName}`),
			truncateToWidth(` ${this.data.description ?? this.data.runId}  ${summary}`, width),
			"",
		];
	}

	private renderActions(width: number): string {
		const budget = Math.max(1, width - visibleWidth(" Actions  "));
		const indexes = actionWindow(this.data.actions, this.actionIndex, budget);
		const actions = indexes.map((index) => {
			const action = this.data.actions[index]!;
			const selected = this.focus === "actions" && index === this.actionIndex;
			return selected ? this.theme.fg("accent", `[${action}]`) : this.theme.fg("dim", action);
		});
		return truncateToWidth(` Actions  ${actions.join(" · ")}`, width);
	}
}

function hasRunningWork(data: ExtensionWorkflowPanelData): boolean {
	return (
		data.status === "pending" ||
		data.status === "running" ||
		data.phases.some((phase) => phase.agents.some((agent) => agent.status === "running"))
	);
}

function getTerminalRows(tui: TUI): number {
	const rows = (tui as unknown as { terminal?: { rows?: number } }).terminal?.rows;
	return typeof rows === "number" && Number.isFinite(rows) ? rows : 40;
}

function actionWindow(actions: string[], selectedIndex: number, budget: number): number[] {
	if (actions.length === 0) return [];
	let start = boundedIndex(selectedIndex, actions.length);
	let end = start + 1;
	let width = visibleWidth(`[${actions[start]}]`);
	while (true) {
		const previous = start - 1;
		const next = end;
		const previousWidth = previous >= 0 ? visibleWidth(actions[previous]!) + 3 : Number.POSITIVE_INFINITY;
		const nextWidth = next < actions.length ? visibleWidth(actions[next]!) + 3 : Number.POSITIVE_INFINITY;
		if (width + Math.min(previousWidth, nextWidth) > budget) break;
		if (nextWidth <= previousWidth) {
			end++;
			width += nextWidth;
		} else {
			start--;
			width += previousWidth;
		}
	}
	return Array.from({ length: end - start }, (_, offset) => start + offset);
}

function visibleRows(rows: string[], selectedIndex: number, height: number): string[] {
	if (rows.length <= height) return rows;
	const start = Math.max(0, Math.min(rows.length - height, selectedIndex - Math.floor(height / 2)));
	return rows.slice(start, start + height);
}

function boundedIndex(index: number, length: number): number {
	if (length <= 0) return 0;
	return Math.max(0, Math.min(length - 1, index));
}

function isFinished(agent: ExtensionWorkflowPanelAgent): boolean {
	return agent.status === "completed" || agent.status === "replayed";
}

function phaseStatus(phase: ExtensionWorkflowPanelPhase): string {
	if (phase.agents.some((agent) => agent.status === "failed")) return "✗";
	if (phase.agents.some((agent) => agent.status === "running")) return "●";
	if (phase.agents.some((agent) => agent.status === "stopped")) return "■";
	return phase.agents.length > 0 && phase.agents.every(isFinished) ? "✔" : "○";
}

function agentStatus(status: ExtensionWorkflowPanelAgent["status"]): string {
	if (status === "completed" || status === "replayed") return "✔";
	if (status === "failed") return "✗";
	if (status === "stopped") return "■";
	return "●";
}

function titleCase(value: string): string {
	return value.charAt(0).toUpperCase() + value.slice(1);
}

function formatTokens(tokens: number): string {
	return tokens >= 1000 ? `${(tokens / 1000).toFixed(tokens >= 10_000 ? 1 : 2)}k` : String(tokens);
}

function formatDuration(durationMs: number | undefined): string {
	if (durationMs === undefined) return "live";
	const seconds = Math.max(0, Math.round(durationMs / 1000));
	return seconds < 60 ? `${seconds}s` : `${Math.floor(seconds / 60)}m ${seconds % 60}s`;
}

function formatAgentDuration(agent: ExtensionWorkflowPanelAgent): string {
	if (!agent.startedAt) return "unknown";
	const started = Date.parse(agent.startedAt);
	const completed = agent.completedAt ? Date.parse(agent.completedAt) : Date.now();
	return Number.isFinite(started) && Number.isFinite(completed)
		? formatDuration(Math.max(0, completed - started))
		: "unknown";
}

function appendSection(lines: string[], title: string, value: string | undefined, width: number, theme: Theme): void {
	if (!value) return;
	lines.push("", theme.fg("accent", ` ${title}`));
	for (const line of wrapTextWithAnsi(value, Math.max(1, width - 4))) lines.push(`   ${line}`);
}

function twoPane(
	leftTitle: string,
	leftRows: string[],
	leftWidth: number,
	rightTitle: string,
	rightRows: string[],
	rightWidth: number,
	bodyRows: number,
	theme: Theme,
): string[] {
	const top = ` ╭─ ${leftTitle} ${"─".repeat(Math.max(0, leftWidth - visibleWidth(leftTitle) - 4))}┬─ ${rightTitle} ${"─".repeat(Math.max(0, rightWidth - visibleWidth(rightTitle) - 4))}╮`;
	const totalWidth = leftWidth + rightWidth + 3;
	const output = [theme.fg("dim", padVisible(truncateToWidth(top, totalWidth), totalWidth))];
	for (let index = 0; index < bodyRows; index++) {
		const left = padVisible(truncateToWidth(leftRows[index] ?? "", leftWidth - 2), leftWidth - 2);
		const right = padVisible(truncateToWidth(rightRows[index] ?? "", rightWidth - 1), rightWidth - 1);
		output.push(` │ ${left}│ ${right}│`);
	}
	output.push(theme.fg("dim", ` ╰${"─".repeat(leftWidth - 1)}┴${"─".repeat(rightWidth)}╯`));
	return output;
}

function padVisible(value: string, width: number): string {
	return value + " ".repeat(Math.max(0, width - visibleWidth(value)));
}

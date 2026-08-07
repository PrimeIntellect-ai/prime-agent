import type { AssistantMessage, Usage } from "@earendil-works/pi-ai";
import { type Component, Text, truncateToWidth, VersionedRenderCache, visibleWidth } from "@earendil-works/pi-tui";
import type { ActCancellationCapability } from "../../../core/act-cancellation.js";
import type { ActEventModel, ActProjectionEvent } from "../../../core/act-events.js";
import { theme } from "../theme/theme.js";
import { AssistantMessageComponent } from "./assistant-message.js";
import { IPythonCellComponent } from "./ipython-cell.js";

export const ACT_COMPONENT_MAX_ACTS_PER_TOOL = 32;

interface ActCell {
	id: string;
	code: string;
	status: "running" | "ok" | "error" | "cancelled";
	durationMs?: number;
	stdout?: string;
	stderr?: string;
	result?: string;
	error?: string;
}

type ActEntry = { kind: "assistant"; stream: "thinking" | "text"; text: string } | { kind: "cell"; cellId: string };

export interface ActExecutionState {
	actId: string;
	outerToolCallId: string;
	sequence: number;
	prompt: string;
	model?: ActEventModel;
	thinkingLevel?: string;
	directingModel?: ActEventModel;
	directingThinkingLevel?: string;
	cancellationCapability?: ActCancellationCapability;
	status: "running" | "done" | "error" | "cancelled";
	entries: ActEntry[];
	cells: ActCell[];
	usage?: Usage;
	error?: string;
}

export function createActExecutionState(event: ActProjectionEvent): ActExecutionState {
	return reduceActExecutionState(
		{
			actId: event.actId,
			outerToolCallId: event.outerToolCallId,
			sequence: 0,
			prompt: "",
			status: "running",
			entries: [],
			cells: [],
		},
		event,
	);
}

export function reduceActExecutionState(state: ActExecutionState, event: ActProjectionEvent): ActExecutionState {
	if (
		state.status !== "running" ||
		event.actId !== state.actId ||
		event.outerToolCallId !== state.outerToolCallId ||
		event.sequence <= state.sequence
	) {
		return state;
	}
	const next = { ...state, sequence: event.sequence };
	switch (event.event) {
		case "start":
			return {
				...next,
				prompt: event.prompt,
				model: event.model,
				thinkingLevel: event.thinkingLevel,
				directingModel: event.directingModel,
				directingThinkingLevel: event.directingThinkingLevel,
				cancellationCapability: event.cancellationCapability,
			};
		case "assistant_delta": {
			const entries = [...next.entries];
			const last = entries.at(-1);
			if (last?.kind === "assistant" && last.stream === event.stream) {
				entries[entries.length - 1] = { ...last, text: last.text + event.text };
			} else {
				entries.push({ kind: "assistant", stream: event.stream, text: event.text });
			}
			return { ...next, entries };
		}
		case "cell_start":
			return {
				...next,
				entries: [...next.entries, { kind: "cell", cellId: event.cellId }],
				cells: [...next.cells, { id: event.cellId, code: event.code, status: "running" }],
			};
		case "cell_terminal":
			return {
				...next,
				cells: next.cells.map((cell) =>
					cell.id === event.cellId
						? {
								...cell,
								status: event.status,
								durationMs: event.durationMs,
								stdout: event.stdout,
								stderr: event.stderr,
								result: event.result,
								error: event.error,
							}
						: cell,
				),
			};
		case "terminal":
			return {
				...next,
				prompt: event.prompt,
				model: event.model,
				thinkingLevel: event.thinkingLevel,
				directingModel: event.directingModel,
				directingThinkingLevel: event.directingThinkingLevel,
				cancellationCapability: event.cancellationCapability,
				status: event.status,
				usage: event.usage,
				error: event.error,
			};
	}
}

function assistantMessage(stream: "thinking" | "text", text: string): AssistantMessage {
	return {
		role: "assistant",
		content: [stream === "thinking" ? { type: "thinking", thinking: text } : { type: "text", text }],
		api: "openai-responses",
		provider: "prime-act",
		model: "act",
		usage: {
			input: 0,
			output: 0,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 0,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		},
		stopReason: "stop",
		timestamp: Date.now(),
	};
}

function displayModel(model: ActEventModel | undefined): string {
	return model?.name?.trim() || model?.id || "resolving model";
}

function actorLabel(model: ActEventModel | undefined, thinkingLevel: string | undefined): string {
	return [displayModel(model), thinkingLevel && thinkingLevel !== "off" ? thinkingLevel : undefined]
		.filter(Boolean)
		.join(" • ");
}

function separator(label: string, width: number, color: "accent" | "muted" | "warning" | "error"): string {
	const prefix = "───── ";
	const available = Math.max(0, width - visibleWidth(prefix) - visibleWidth(label) - 1);
	return truncateToWidth(theme.fg(color, `${prefix}${label} ${"─".repeat(available)}`), width, "");
}

function usageLabel(usage: Usage | undefined): string {
	if (!usage) return "";
	const parts: string[] = [];
	if (typeof usage.totalTokens === "number") parts.push(`${usage.totalTokens.toLocaleString()} tokens`);
	if (typeof usage.cost?.total === "number") parts.push(`$${usage.cost.total.toFixed(4)}`);
	return parts.length ? ` · Act ${parts.join(" · ")}` : "";
}

/** ActExecutionComponent frames Act activity while delegating every event row to parent transcript components. */
export class ActExecutionComponent implements Component {
	private readonly renderCache = new VersionedRenderCache();
	private state: ActExecutionState;
	private stateVersion = 0;
	private expanded = false;

	constructor(event: ActProjectionEvent) {
		this.state = createActExecutionState(event);
	}

	get actId(): string {
		return this.state.actId;
	}
	get outerToolCallId(): string {
		return this.state.outerToolCallId;
	}
	get snapshot(): Readonly<ActExecutionState> {
		return this.state;
	}

	update(event: ActProjectionEvent): void {
		const next = reduceActExecutionState(this.state, event);
		if (next === this.state) return;
		this.state = next;
		this.stateVersion += 1;
		this.renderCache.invalidate();
	}

	setExpanded(expanded: boolean): void {
		this.expanded = expanded;
		this.stateVersion += 1;
		this.renderCache.invalidate();
	}

	invalidate(): void {
		this.renderCache.invalidate();
	}

	render(width: number): string[] {
		const safeWidth = Math.max(1, width);
		const cached = this.renderCache.get(safeWidth, this.stateVersion);
		if (cached) return cached;
		const lines = [
			"",
			separator(`act  ${actorLabel(this.state.model, this.state.thinkingLevel)}`, safeWidth, "accent"),
			"",
		];
		if (this.state.prompt)
			lines.push(
				...new Text(
					theme.fg(
						"text",
						`Task
${this.state.prompt}`,
					),
					1,
					0,
				).render(safeWidth),
			);
		for (const entry of this.state.entries) {
			if (entry.kind === "assistant") {
				lines.push(
					...new AssistantMessageComponent(
						assistantMessage(entry.stream, entry.text),
						false,
						undefined,
						undefined,
						{ expanded: this.expanded },
					).render(safeWidth),
				);
				continue;
			}
			const cell = this.state.cells.find((candidate) => candidate.id === entry.cellId);
			if (!cell) continue;
			lines.push(
				...new IPythonCellComponent({
					code: cell.code,
					details: {
						status: cell.status === "ok" ? "ok" : cell.status === "cancelled" ? "aborted" : cell.status,
						durationMs: cell.durationMs,
						stdout: cell.stdout,
						stderr: cell.stderr,
						result: cell.result,
						errorEname: cell.error,
					},
					isPartial: cell.status === "running",
					isError: cell.status === "error",
					expanded: this.expanded,
					executionStarted: true,
					argsComplete: true,
					showExpandHint: false,
				}).render(safeWidth),
			);
		}
		if (this.state.error)
			lines.push(
				...new Text(theme.fg(this.state.status === "error" ? "error" : "warning", this.state.error), 1, 0).render(
					safeWidth,
				),
			);
		if (this.state.status !== "running") {
			const actor = actorLabel(this.state.directingModel, this.state.directingThinkingLevel);
			const label =
				this.state.status === "done"
					? `return  ${actor}${usageLabel(this.state.usage)}`
					: this.state.status === "cancelled"
						? `Act cancelled · return  ${actor}`
						: this.state.status === "error"
							? `Act failed · return  ${actor}`
							: `return  ${actor}`;
			const color =
				this.state.status === "error" ? "error" : this.state.status === "cancelled" ? "warning" : "muted";
			lines.push("", separator(label, safeWidth, color), "");
		}
		return this.renderCache.set(safeWidth, this.stateVersion, lines);
	}
}

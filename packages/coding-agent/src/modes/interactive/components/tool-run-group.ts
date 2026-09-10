import { type Component, type TableCellSelectionRegion, truncateToWidth } from "@earendil-works/pi-tui";
import { theme } from "../theme/theme.js";
import type { ToolExecutionComponent } from "./tool-execution.js";

/** Chat-column leading space shared with the other conversation rows. */
const GROUP_INDENT = " ";

/** Visible width of the nested-row gutter (` ╰─` plus the row's own leading space). */
const NESTED_PREFIX_WIDTH = 4;

/** Continuation indent under the `╰─` gutter, matching agent message body rows. */
const NESTED_CONTINUATION = " ".repeat(NESTED_PREFIX_WIDTH);

export type ToolRunGroupKind = "bash" | "ipython";

export interface ToolRunGroupCounts {
	bash: number;
	ipython: number;
}

function formatCount(count: number, noun: string): string {
	return `${count} ${noun}${count === 1 ? "" : "s"}`;
}

/** `Running 2 shell commands · 1 Python cell` label for the group header. */
export function formatToolRunGroupHeader(counts: ToolRunGroupCounts, complete: boolean): string {
	const parts: string[] = [];
	if (counts.bash > 0) {
		parts.push(formatCount(counts.bash, "shell command"));
	}
	if (counts.ipython > 0) {
		parts.push(formatCount(counts.ipython, "Python cell"));
	}
	return `${complete ? "Ran" : "Running"} ${parts.join(" · ")}`;
}

/**
 * One "Running N ..." block: a muted header line followed by the grouped tool
 * calls' dim summary rows nested under a `╰─` gutter. Collapsed rows render the
 * per-tool one-line summaries; the existing expand machinery forwards through
 * `setExpanded` and renders each child's full rendering under the same gutter.
 */
export class ToolRunGroupComponent implements Component {
	private readonly tools: ToolExecutionComponent[] = [];
	private counts: ToolRunGroupCounts = { bash: 0, ipython: 0 };
	private selectionRegions: TableCellSelectionRegion[] = [];

	addTool(component: ToolExecutionComponent, kind: ToolRunGroupKind): void {
		this.tools.push(component);
		this.counts[kind] += 1;
	}

	getToolComponents(): readonly ToolExecutionComponent[] {
		return this.tools;
	}

	setExpanded(expanded: boolean): void {
		for (const tool of this.tools) {
			tool.setExpanded(expanded);
		}
	}

	setAgentMessagesExpanded(expanded: boolean): void {
		for (const tool of this.tools) {
			tool.setAgentMessagesExpanded(expanded);
		}
	}

	setEditDiffsExpanded(expanded: boolean): void {
		for (const tool of this.tools) {
			tool.setEditDiffsExpanded(expanded);
		}
	}

	setShowImages(show: boolean): void {
		for (const tool of this.tools) {
			tool.setShowImages(show);
		}
	}

	setIncludeImageDimensions(include: boolean): void {
		for (const tool of this.tools) {
			tool.setIncludeImageDimensions(include);
		}
	}

	invalidate(): void {
		for (const tool of this.tools) {
			tool.invalidate();
		}
	}

	render(width: number): string[] {
		const safeWidth = Math.max(1, width);
		// The header reads "Running N ..." until every nested call has finished,
		// then settles on "Ran N ...".
		const complete = this.tools.length > 0 && this.tools.every((tool) => tool.isRunComplete());
		const lines = [
			truncateToWidth(
				`${GROUP_INDENT}${theme.fg("accent", "◆")} ${theme.fg("muted", formatToolRunGroupHeader(this.counts, complete))}`,
				safeWidth,
				"",
			),
		];
		const childWidth = Math.max(1, safeWidth - NESTED_PREFIX_WIDTH);
		const regions: TableCellSelectionRegion[] = [];
		for (const tool of this.tools) {
			const childLines = tool.isExpanded()
				? tool.render(childWidth)
				: (tool.renderRunGroupSummary(childWidth) ?? tool.render(childWidth));
			if (childLines.length === 0) {
				continue;
			}
			const lineOffset = lines.length;
			lines.push(truncateToWidth(`${GROUP_INDENT}${theme.fg("dim", "╰─")}${childLines[0]}`, safeWidth, ""));
			for (const line of childLines.slice(1)) {
				lines.push(truncateToWidth(`${NESTED_CONTINUATION}${line}`, safeWidth, ""));
			}
			for (const region of tool.getSelectionRegions?.() ?? []) {
				regions.push({
					...region,
					line: region.line + lineOffset,
					tableTop: region.tableTop + lineOffset,
					tableBottom: region.tableBottom + lineOffset,
				});
			}
		}
		this.selectionRegions = regions;
		return lines;
	}

	getSelectionRegions(): ReadonlyArray<TableCellSelectionRegion> {
		return this.selectionRegions;
	}
}

/** Where the grouper places components it derives. */
export type ToolRunGroupMount = (component: Component) => void;

/**
 * Derives "Running N ..." groups from the conversation's message sequence.
 * Both the streaming path and the reload path feed the same block-ordered
 * events — tool call mounts, other conversation rows, and segment boundaries —
 * so live and reloaded transcripts group identically. Assistant text and
 * thinking blocks never break a run; only a turn-ending reply does.
 */
export class ToolRunGrouper {
	private openGroup: ToolRunGroupComponent | undefined;

	constructor(private readonly mount: ToolRunGroupMount) {}

	/** A non-tool conversation row arrived: the open run segment ends. */
	noteConversationRow(): void {
		this.openGroup = undefined;
	}

	/** Turn or abort boundary, or a turn-ending reply: the run segment ends. */
	close(): void {
		this.openGroup = undefined;
	}

	/** Nest the tool call into the open run segment or open a new group. */
	mountToolExecution(component: ToolExecutionComponent): void {
		const kind = component.getRunGroupKind();
		if (!kind) {
			this.noteConversationRow();
			this.mount(component);
			return;
		}
		let group = this.openGroup;
		if (!group) {
			group = new ToolRunGroupComponent();
			this.openGroup = group;
			this.mount(group);
		}
		group.addTool(component, kind);
	}
}

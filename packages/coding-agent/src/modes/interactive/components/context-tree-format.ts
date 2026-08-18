import type { Usage } from "@earendil-works/pi-ai";
import { truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";
import type { ContextTreeNode } from "../../../core/context-tree.js";
import type { ContextUsage } from "../../../core/extensions/index.js";
import { addAssistantUsage, emptyUsage } from "../../../core/usage.js";
import { formatTokenCount } from "../agent-activity.js";
import { theme } from "../theme/theme.js";

const CONTEXT_BAR_WIDTH = 10;
const MIN_LABEL_WIDTH = 16;

interface ContextTreeRow {
	node: ContextTreeNode;
	/** Tree-drawing prefix, e.g. "│  └─ ". */
	prefix: string;
}

function statusIcon(status: ContextTreeNode["status"]): string {
	switch (status) {
		case "active":
			return theme.fg("accent", "●");
		case "queued":
			return theme.fg("dim", "◇");
		case "running":
			return theme.fg("accent", "◆");
		case "done":
			return theme.fg("success", "✓");
		case "error":
		case "cancelled":
			return theme.fg("error", "✗");
		default: {
			const _exhaustive: never = status;
			return _exhaustive;
		}
	}
}

function flattenContextTree(root: ContextTreeNode): ContextTreeRow[] {
	const rows: ContextTreeRow[] = [{ node: root, prefix: "" }];
	const walk = (children: readonly ContextTreeNode[], ancestors: string): void => {
		for (const [index, child] of children.entries()) {
			const isLast = index === children.length - 1;
			rows.push({ node: child, prefix: `${ancestors}${isLast ? "└─ " : "├─ "}` });
			walk(child.children, `${ancestors}${isLast ? "   " : "│  "}`);
		}
	};
	walk(root.children, "");
	return rows;
}

/** Spend-relevant token count, matching the "Total" line of /usage. */
function spentTokens(usage: Usage): number {
	return usage.input + usage.output + usage.cacheRead + usage.cacheWrite;
}

function formatCost(cost: number): string {
	return `$${cost.toFixed(2)}`;
}

function formatContextColumn(contextUsage: ContextUsage | undefined, withBar: boolean): string {
	if (!contextUsage) {
		return theme.fg("dim", "-");
	}
	if (contextUsage.tokens === null || contextUsage.percent === null) {
		return theme.fg("dim", "unknown after compaction");
	}
	const percent = Math.round(contextUsage.percent);
	const detail = `${formatTokenCount(contextUsage.tokens)}/${formatTokenCount(contextUsage.contextWindow)}`;
	const text = `${percent}% ${theme.fg("dim", `(${detail})`)}`;
	if (!withBar) {
		return text;
	}
	const filled = Math.max(
		0,
		Math.min(CONTEXT_BAR_WIDTH, Math.round((contextUsage.percent / 100) * CONTEXT_BAR_WIDTH)),
	);
	const barColor = contextUsage.percent >= 80 ? "warning" : "accent";
	const bar = theme.fg(barColor, "▓".repeat(filled)) + theme.fg("dim", "░".repeat(CONTEXT_BAR_WIDTH - filled));
	return `${bar} ${text}`;
}

function padEndAnsi(text: string, width: number): string {
	return text + " ".repeat(Math.max(0, width - visibleWidth(text)));
}

function padStartAnsi(text: string, width: number): string {
	return " ".repeat(Math.max(0, width - visibleWidth(text))) + text;
}

function countNodes(root: ContextTreeNode): number {
	return 1 + root.children.reduce((sum, child) => sum + countNodes(child), 0);
}

/** Own usage summed over the whole tree: exact even while children are mid-run. */
function sumOwnUsage(root: ContextTreeNode): Usage {
	const total = emptyUsage();
	const walk = (node: ContextTreeNode): void => {
		addAssistantUsage(total, node.ownUsage);
		for (const child of node.children) {
			walk(child);
		}
	};
	walk(root);
	return total;
}

/**
 * Render the /context overview: a tree with one row per agent showing its own
 * tokens and cost (descendants excluded, so columns add up) plus per-agent
 * context-window utilization, followed by grand totals.
 */
export function formatContextTree(root: ContextTreeNode, width: number): string {
	const rows = flattenContextTree(root);

	const tokenCells = rows.map((row) => formatTokenCount(spentTokens(row.node.ownUsage)));
	const costCells = rows.map((row) => formatCost(row.node.ownUsage.cost.total));
	const tokenHeader = "tokens";
	const costHeader = "cost";
	const contextHeader = "context";
	const tokenWidth = Math.max(tokenHeader.length, ...tokenCells.map((cell) => cell.length));
	const costWidth = Math.max(costHeader.length, ...costCells.map((cell) => cell.length));
	const labelWidth = Math.max(
		MIN_LABEL_WIDTH,
		Math.min(
			Math.max(...rows.map((row) => row.prefix.length + 2 + visibleWidth(row.node.label))),
			width - tokenWidth - costWidth - 28,
		),
	);

	const lines: string[] = [];
	lines.push(theme.bold("Context"));
	lines.push("");
	if (root.model) {
		lines.push(`${theme.fg("dim", "Model:")} ${root.model.provider}/${root.model.id}`);
		lines.push("");
	}

	lines.push(
		theme.fg(
			"dim",
			`${" ".repeat(2)}${padEndAnsi("agent", labelWidth)}  ${padStartAnsi(tokenHeader, tokenWidth)}  ${padStartAnsi(costHeader, costWidth)}  ${contextHeader}`,
		),
	);

	for (const [index, row] of rows.entries()) {
		const labelSpace = Math.max(1, labelWidth - row.prefix.length - 2);
		const label = truncateToWidth(row.node.label, labelSpace, "...");
		const labelCell = padEndAnsi(
			`${theme.fg("dim", row.prefix)}${statusIcon(row.node.status)} ${label}`,
			labelWidth + 2,
		);
		const tokenCell = padStartAnsi(tokenCells[index], tokenWidth);
		const costCell = padStartAnsi(theme.fg("dim", costCells[index]), costWidth);
		const contextCell = formatContextColumn(row.node.contextUsage, row.node.id === "root");
		lines.push(`${labelCell}  ${tokenCell}  ${costCell}  ${contextCell}`);
	}

	const totals = sumOwnUsage(root);
	const agentCount = countNodes(root);
	lines.push("");
	lines.push(
		`${theme.fg("dim", "Total:")} ${formatTokenCount(spentTokens(totals))} tokens ${theme.fg("dim", "·")} ${formatCost(
			totals.cost.total,
		)}${agentCount > 1 ? theme.fg("dim", ` across ${agentCount} agents`) : ""}`,
	);

	lines.push("");
	lines.push(theme.bold("Tokens"));
	lines.push(`${theme.fg("dim", "Input:")} ${totals.input.toLocaleString()}`);
	lines.push(`${theme.fg("dim", "Output:")} ${totals.output.toLocaleString()}`);
	if (totals.cacheRead > 0) {
		lines.push(`${theme.fg("dim", "Cache Read:")} ${totals.cacheRead.toLocaleString()}`);
	}
	if (totals.cacheWrite > 0) {
		lines.push(`${theme.fg("dim", "Cache Write:")} ${totals.cacheWrite.toLocaleString()}`);
	}
	lines.push(`${theme.fg("dim", "Total:")} ${spentTokens(totals).toLocaleString()}`);

	if (totals.cost.total > 0) {
		lines.push("");
		lines.push(theme.bold("Cost"));
		lines.push(`${theme.fg("dim", "Total:")} $${totals.cost.total.toFixed(4)}`);
	}

	const rootContext = root.contextUsage;
	if (rootContext) {
		lines.push("");
		lines.push(theme.bold("Context"));
		if (rootContext.tokens === null || rootContext.percent === null) {
			lines.push(`${theme.fg("dim", "Current:")} unknown after compaction`);
		} else {
			const percent = `${Math.round(rootContext.percent * 10) / 10}%`;
			lines.push(
				`${theme.fg("dim", "Current:")} ${rootContext.tokens.toLocaleString()} / ${rootContext.contextWindow.toLocaleString()} (${percent})`,
			);
		}
	}

	return lines.join("\n");
}

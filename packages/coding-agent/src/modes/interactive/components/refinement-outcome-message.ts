import { type Component, Spacer, Text, truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";
import type { RefinementOutcomeMessage } from "../../../core/messages.js";
import type { AppliedRefinementEdit, HarnessEntry } from "../../../core/refinement/refinement.js";
import { generateDiffString } from "../../../core/tools/edit-diff.js";
import { theme } from "../theme/theme.js";
import { renderDiff } from "./diff.js";
import { customMessageLabel, ExpandableCustomMessageBox } from "./expandable-custom-message.js";
import { expandCollapseHint } from "./keybinding-hints.js";

function editableEntry(entry: HarnessEntry): Record<string, unknown> {
	return {
		title: entry.title,
		content: entry.content,
		path: entry.path,
		reference: entry.reference,
		arguments: entry.arguments,
		metadata: entry.metadata,
	};
}

function proposedEntry(edit: AppliedRefinementEdit): Record<string, unknown> {
	return {
		...(edit.title === undefined ? {} : { title: edit.title }),
		...(edit.content === undefined ? {} : { content: edit.content }),
		...(edit.path === undefined ? {} : { path: edit.path }),
		...(edit.reference === undefined ? {} : { reference: edit.reference }),
		...(edit.arguments === undefined ? {} : { arguments: edit.arguments }),
		...(edit.metadata === undefined ? {} : { metadata: edit.metadata }),
	};
}

function entryText(entry: Record<string, unknown> | undefined): string {
	return entry === undefined ? "" : `${JSON.stringify(entry, null, 2)}\n`;
}

function editDiff(edit: AppliedRefinementEdit): string {
	const before = edit.before ? editableEntry(edit.before) : undefined;
	const after = edit.after ? editableEntry(edit.after) : edit.action === "delete" ? undefined : proposedEntry(edit);
	return generateDiffString(entryText(before), entryText(after), 4).diff;
}

function editScope(edit: AppliedRefinementEdit, fallback: "local" | "global"): "local" | "global" {
	return edit.after?.scope ?? edit.before?.scope ?? fallback;
}

function editLabel(edit: AppliedRefinementEdit, fallbackScope: "local" | "global"): string {
	const scope = editScope(edit, fallbackScope);
	if (!edit.applied) {
		const error = edit.error ? `: ${edit.error}` : "";
		return theme.fg("error", `Failed to ${edit.action} ${scope} ${edit.kind} \`${edit.id}\`${error}`);
	}
	const verb = edit.action === "create" ? "Created" : edit.action === "update" ? "Updated" : "Deleted";
	return `${theme.fg("success", verb)} ${scope} ${edit.kind} \`${edit.id}\``;
}

function editCount(edits: AppliedRefinementEdit[]): string {
	const applied = edits.filter((edit) => edit.applied).length;
	return edits.length === applied
		? `${applied} edit${applied === 1 ? "" : "s"} applied`
		: `${applied}/${edits.length} edits applied`;
}

/** Width-aware collapsed line: truncates the summary so the line never wraps. */
class CollapsedOutcomeLine implements Component {
	constructor(
		private readonly summary: string,
		private readonly suffix: string,
	) {}

	render(width: number): string[] {
		const room = Math.max(20, width - visibleWidth(this.suffix) - 1);
		const line = `${theme.fg("customMessageText", truncateToWidth(this.summary, room, "…"))} ${this.suffix}`;
		return [truncateToWidth(line, Math.max(1, width), "")];
	}

	invalidate(): void {}
}

/** Durable refinement outcome card: per-edit rows with before/after diffs when expanded. */
export class RefinementOutcomeMessageComponent extends ExpandableCustomMessageBox {
	constructor(private readonly message: RefinementOutcomeMessage) {
		super();
		this.updateDisplay();
	}

	protected updateDisplay(): void {
		this.clear();

		const { summary, edits, scope } = this.message.details;
		this.addChild(new Text(customMessageLabel("refinement"), 0, 0));
		this.addChild(new Spacer(1));
		if (!this.expanded) {
			const suffix = `${theme.fg("customMessageText", `· ${editCount(edits)}`)} ${expandCollapseHint("app.tools.expand", false)}`;
			this.addChild(new CollapsedOutcomeLine(summary, suffix));
			return;
		}

		this.addChild(new Text(theme.fg("customMessageText", `${summary} · ${editCount(edits)}`), 0, 0));
		for (const edit of edits) {
			this.addChild(new Text(`${theme.fg("dim", "  ╰─ ")}${editLabel(edit, scope)}`, 0, 0));
			const diff = editDiff(edit);
			if (diff) this.addChild(new Text(renderDiff(diff), 4, 0));
		}
	}
}

export class MalformedRefinementOutcomeMessageComponent extends ExpandableCustomMessageBox {
	constructor() {
		super();
		this.updateDisplay();
	}

	protected updateDisplay(): void {
		this.clear();
		this.addChild(new Text(theme.fg("error", "[Malformed refinement outcome message]"), 0, 0));
	}
}

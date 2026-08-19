import { Box, Spacer, Text } from "@earendil-works/pi-tui";
import type { RefinementOutcomeMessage } from "../../../core/messages.js";
import type { AppliedRefinementEdit, HarnessEntry } from "../../../core/refinement/refinement.js";
import { generateDiffString } from "../../../core/tools/edit-diff.js";
import { theme } from "../theme/theme.js";
import { renderDiff } from "./diff.js";
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

/**
 * Renders a durable refinement outcome with collapsed/expanded state.
 * Mirrors the compaction-summary and skill-invocation components: a
 * custom-message box with a bold [refinement] label, collapsed to a single
 * line and expanded via the shared tool-output expansion toggle.
 */
export class RefinementOutcomeMessageComponent extends Box {
	private expanded = false;

	constructor(private readonly message: RefinementOutcomeMessage) {
		super(1, 1, (t) => theme.bg("customMessageBg", t));
		this.updateDisplay();
	}

	setExpanded(expanded: boolean): void {
		if (this.expanded === expanded) return;
		this.expanded = expanded;
		this.updateDisplay();
	}

	override invalidate(): void {
		super.invalidate();
		this.updateDisplay();
	}

	private updateDisplay(): void {
		this.clear();

		const { summary, edits, scope } = this.message.details;
		const label = theme.fg("customMessageLabel", `\x1b[1m[refinement]\x1b[22m`);
		if (!this.expanded) {
			const line =
				`${label} ` +
				theme.fg("customMessageText", `${summary} · ${editCount(edits)}`) +
				` ${expandCollapseHint("app.tools.expand", false)}`;
			this.addChild(new Text(line, 0, 0));
			return;
		}

		this.addChild(new Text(label, 0, 0));
		this.addChild(new Spacer(1));
		this.addChild(new Text(theme.fg("customMessageText", `${summary} · ${editCount(edits)}`), 0, 0));
		for (const edit of edits) {
			this.addChild(new Text(`${theme.fg("dim", "  ╰─ ")}${editLabel(edit, scope)}`, 0, 0));
			const diff = editDiff(edit);
			if (diff) this.addChild(new Text(renderDiff(diff), 4, 0));
		}
	}
}

export class MalformedRefinementOutcomeMessageComponent extends Box {
	constructor() {
		super(1, 1, (t) => theme.bg("customMessageBg", t));
		this.addChild(new Text(theme.fg("error", "[Malformed refinement outcome message]"), 0, 0));
	}

	setExpanded(_expanded: boolean): void {}
}

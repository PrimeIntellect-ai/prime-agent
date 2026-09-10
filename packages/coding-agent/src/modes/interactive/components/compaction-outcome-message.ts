import { Container, Spacer, Text } from "@earendil-works/pi-tui";
import type { CompactionOutcomeMessage } from "../../../core/messages.js";
import { theme } from "../theme/theme.js";

/** Renders a durable unsuccessful automatic-compaction outcome. */
export class CompactionOutcomeMessageComponent extends Container {
	constructor(message: CompactionOutcomeMessage) {
		super();
		const color = message.details.outcome === "skipped" ? "warning" : "error";
		this.addChild(new Spacer(1));
		this.addChild(new Text(theme.fg(color, message.content), 1, 0));
	}

	setExpanded(_expanded: boolean): void {}
}

export class MalformedCompactionOutcomeMessageComponent extends Container {
	constructor() {
		super();
		this.addChild(new Spacer(1));
		this.addChild(new Text(theme.fg("error", "[Malformed compaction outcome message]"), 1, 0));
	}

	setExpanded(_expanded: boolean): void {}
}

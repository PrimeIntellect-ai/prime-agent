import { Box, type Component, Markdown, Text, visibleWidth } from "@earendil-works/pi-tui";
import type { AgentConnectionSideQuestionEvent } from "../../agent-connection/types.js";
import { getMarkdownTheme, theme } from "../theme/theme.js";

interface SideQuestionTurnState {
	kind: "turn";
	event: AgentConnectionSideQuestionEvent;
	/** Follow-up questions render as a standard user-message bubble; the first turn keeps the /btw header. */
	questionBubble: Box | undefined;
	answer: Markdown;
}

/** A ! / !! run inside the pane, rendered by the same component the main thread uses. */
interface SideQuestionBashState {
	kind: "bash";
	component: Component;
	running: boolean;
}

export class SideQuestionComponent implements Component {
	private readonly paddingX: number;
	private readonly entries: (SideQuestionTurnState | SideQuestionBashState)[] = [];

	constructor(event: AgentConnectionSideQuestionEvent, paddingX = 2) {
		this.paddingX = Math.max(2, paddingX);
		this.addTurn(event);
	}

	addTurn(event: AgentConnectionSideQuestionEvent): void {
		let questionBubble: Box | undefined;
		if (this.entries.length > 0) {
			questionBubble = new Box(this.paddingX, 1, (content: string) =>
				theme.getUserMessageBackgroundColor()(content),
			);
			questionBubble.addChild(
				new Markdown(event.question, 0, 0, getMarkdownTheme(), {
					color: (content: string) => theme.fg("userMessageText", content),
				}),
			);
		}
		const answer = new Markdown("", this.paddingX, 0, getMarkdownTheme(), {
			color: (content: string) => theme.fg("userMessageText", content),
		});
		answer.setText(event.answer);
		this.entries.push({ kind: "turn", event, questionBubble, answer });
	}

	addBash(component: Component): void {
		this.entries.push({ kind: "bash", component, running: true });
	}

	finishBash(): void {
		for (const entry of this.entries) {
			if (entry.kind === "bash") {
				entry.running = false;
			}
		}
	}

	update(event: AgentConnectionSideQuestionEvent): void {
		const turn = this.entries.find(
			(candidate): candidate is SideQuestionTurnState =>
				candidate.kind === "turn" && candidate.event.id === event.id,
		);
		if (!turn) {
			return;
		}
		turn.event = event;
		turn.answer.setText(event.answer);
	}

	invalidate(): void {
		for (const entry of this.entries) {
			if (entry.kind === "bash") {
				entry.component.invalidate();
			} else {
				entry.questionBubble?.invalidate();
				entry.answer.invalidate();
			}
		}
	}

	render(width: number): string[] {
		const blank = " ".repeat(Math.max(1, width));
		const lines: string[] = [];
		const pushSurfaced = (raw: string[]) => {
			for (const line of raw) {
				lines.push(this.applySurface(line, width));
			}
		};

		pushSurfaced([blank]);
		for (const entry of this.entries) {
			if (entry.kind === "bash") {
				pushSurfaced([...entry.component.render(width), blank]);
				continue;
			}
			if (entry.questionBubble) {
				// Bubble lines are already fully painted with the user-message background.
				lines.push(...entry.questionBubble.render(width));
			} else {
				const question = new Text(
					`${theme.fg("accent", "/btw")}  ${theme.bold(theme.fg("userMessageText", entry.event.question))}`,
					this.paddingX,
					0,
				).render(width);
				pushSurfaced(question);
			}
			pushSurfaced([blank, ...this.renderAnswer(entry, width), blank]);
		}
		pushSurfaced([...this.renderHint(width), blank]);
		return lines;
	}

	private renderAnswer(turn: SideQuestionTurnState, width: number): string[] {
		const lines: string[] = [];
		if (turn.event.answer) {
			lines.push(...turn.answer.render(width));
		}
		if (turn.event.errorMessage) {
			// A turn can fail after streaming partial output; show both.
			lines.push(...new Text(theme.fg("error", turn.event.errorMessage), this.paddingX, 0).render(width));
		}
		if (lines.length > 0) {
			return lines;
		}
		if (turn.event.status === "cancelled") {
			return new Text(theme.fg("userMessageText", "Cancelled"), this.paddingX, 0).render(width);
		}
		const message = turn.event.status === "complete" ? "No response" : "Thinking…";
		return new Text(theme.fg("userMessageText", message), this.paddingX, 0).render(width);
	}

	private renderHint(width: number): string[] {
		// Any running turn blocks follow-ups (a completed notice can be the last
		// turn while an earlier question still streams), so check them all.
		const running = this.entries.some((entry) =>
			entry.kind === "bash" ? entry.running : entry.event.status === "running",
		);
		const hint = running ? "esc to cancel and return to session" : "reply to follow up · esc to return to session";
		return new Text(theme.fg("dim", hint), this.paddingX, 0).render(width);
	}

	private applySurface(line: string, width: number): string {
		const padded = line + " ".repeat(Math.max(0, width - visibleWidth(line)));
		const background = theme.getPopupBackgroundColor();
		return padded
			.split("\x1b[0m")
			.map((segment) => background(segment))
			.join("\x1b[0m");
	}
}

import { type Component, truncateToWidth, visibleWidth } from "@prime-intellect/prime-agent-tui";
import { theme } from "../theme/theme.js";

const LABEL = "Hint:";
const SHIMMER_RADIUS = 1;
const SHIMMER_PAUSE_FRAMES = 14;

export const FEATURE_HINT_ANIMATION_INTERVAL_MS = 160;

function renderLabelShimmer(characters: string[], frame: number): string {
	if (characters.length === 0) return "";

	const travelFrames = characters.length + SHIMMER_RADIUS * 2;
	const phase = frame % (travelFrames + SHIMMER_PAUSE_FRAMES);
	const center = phase - SHIMMER_RADIUS;
	return characters
		.map((character, index) =>
			theme.fg(Math.abs(index - center) <= SHIMMER_RADIUS ? "muted" : "thinkingText", character),
		)
		.join("");
}

export class FeatureHintComponent implements Component {
	private frame = 0;

	constructor(private readonly text: string) {}

	advance(): void {
		this.frame++;
	}

	invalidate(): void {}

	render(width: number): string[] {
		const paddingX = width > 2 ? 1 : 0;
		const availableWidth = Math.max(1, width - paddingX * 2);
		const displayText = truncateToWidth(`${LABEL} ${this.text}`, availableWidth);
		const characters = Array.from(displayText);
		const labelLength = Math.min(LABEL.length, characters.length);
		const label = renderLabelShimmer(characters.slice(0, labelLength), this.frame);
		const hint = theme.fg("muted", characters.slice(labelLength).join(""));
		const line = `${" ".repeat(paddingX)}${label}${hint}`;

		return [line + " ".repeat(Math.max(0, width - visibleWidth(line))), " ".repeat(width)];
	}
}

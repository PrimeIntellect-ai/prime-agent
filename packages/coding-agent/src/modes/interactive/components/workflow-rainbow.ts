const WORKFLOW_UI_KEYWORD = /\b(?:workflows?|ultracode)\b/gi;
const ANSI_SEQUENCE = /\x1b(?:\[[0-?]*[ -/]*[@-~]|\][^\x07\x1b]*(?:\x07|\x1b\\))/g;

const RAINBOW_COLORS: ReadonlyArray<readonly [number, number, number]> = [
	[233, 137, 115],
	[228, 186, 103],
	[141, 192, 122],
	[102, 194, 179],
	[121, 157, 207],
	[157, 134, 195],
	[206, 130, 172],
];

function foregroundColor([red, green, blue]: readonly [number, number, number], brightness: number): string {
	const brighten = (channel: number) => Math.round(channel + (255 - channel) * brightness);
	const brightRed = brighten(red);
	const brightGreen = brighten(green);
	const brightBlue = brighten(blue);
	if (!supportsTrueColor()) {
		const index =
			16 +
			36 * Math.round((brightRed / 255) * 5) +
			6 * Math.round((brightGreen / 255) * 5) +
			Math.round((brightBlue / 255) * 5);
		return `\x1b[38;5;${index}m`;
	}
	return `\x1b[38;2;${brightRed};${brightGreen};${brightBlue}m`;
}

function supportsTrueColor(): boolean {
	if (process.env.COLORTERM === "truecolor" || process.env.COLORTERM === "24bit" || process.env.WT_SESSION)
		return true;
	const term = process.env.TERM ?? "";
	if (term === "" || term === "dumb" || term === "linux" || process.env.TERM_PROGRAM === "Apple_Terminal")
		return false;
	const inTmux = process.env.TMUX !== undefined || term.startsWith("tmux");
	return inTmux || (term !== "screen" && !term.startsWith("screen-") && !term.startsWith("screen."));
}

function foregroundFromSgr(sequence: string): string | undefined {
	const match = /^\x1b\[([0-9;]*)m$/.exec(sequence);
	if (!match) return undefined;
	const parameters = (match[1] ? match[1].split(";").map(Number) : [0]).filter(Number.isFinite);
	let foreground: string | undefined;
	for (let index = 0; index < parameters.length; index++) {
		const parameter = parameters[index]!;
		if (parameter === 0 || parameter === 39) foreground = "\x1b[39m";
		else if ((parameter >= 30 && parameter <= 37) || (parameter >= 90 && parameter <= 97)) {
			foreground = `\x1b[${parameter}m`;
		} else if (parameter === 38 && parameters[index + 1] === 5 && parameters[index + 2] !== undefined) {
			foreground = `\x1b[38;5;${parameters[index + 2]}m`;
			index += 2;
		} else if (
			parameter === 38 &&
			parameters[index + 1] === 2 &&
			parameters[index + 2] !== undefined &&
			parameters[index + 3] !== undefined &&
			parameters[index + 4] !== undefined
		) {
			foreground = `\x1b[38;2;${parameters[index + 2]};${parameters[index + 3]};${parameters[index + 4]}m`;
			index += 4;
		}
	}
	return foreground;
}

function stylePlainText(text: string, frame: number, restoreForeground: string): string {
	return text.replace(WORKFLOW_UI_KEYWORD, (keyword) => {
		const characters = [...keyword];
		const cycle = frame < 0 ? -1 : frame % (characters.length + 10);
		return `${characters
			.map((character, index) => {
				const distance = cycle < 0 ? Number.POSITIVE_INFINITY : Math.abs(index - cycle);
				const brightness = distance === 0 ? 0.7 : distance === 1 ? 0.35 : 0;
				return `${foregroundColor(RAINBOW_COLORS[index % RAINBOW_COLORS.length]!, brightness)}${character}`;
			})
			.join("")}${restoreForeground}`;
	});
}

export function containsWorkflowUiKeyword(text: string): boolean {
	return /\b(?:workflows?|ultracode)\b/i.test(text.replace(ANSI_SEQUENCE, ""));
}

export function styleWorkflowUiKeywords(text: string, frame = -1): string {
	let result = "";
	let offset = 0;
	let foreground = "\x1b[39m";
	ANSI_SEQUENCE.lastIndex = 0;
	for (const match of text.matchAll(ANSI_SEQUENCE)) {
		result += stylePlainText(text.slice(offset, match.index), frame, foreground);
		const sequence = match[0];
		result += sequence;
		if (sequence.startsWith("\x1b[")) foreground = foregroundFromSgr(sequence) ?? foreground;
		offset = match.index + sequence.length;
	}
	return result + stylePlainText(text.slice(offset), frame, foreground);
}

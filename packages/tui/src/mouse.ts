export interface MouseEvent {
	/** Base SGR button code with modifier and motion bits removed; wheel up/down are 64/65. */
	button: number;
	/** One-based terminal column. */
	x: number;
	/** One-based terminal row. */
	y: number;
	/** True for SGR `M` reports (press, wheel, or drag), false for release `m`. */
	press: boolean;
	/** Whether the SGR motion bit is set. */
	motion: boolean;
	/** Modifier bits carried by the SGR report. */
	shift: boolean;
	alt: boolean;
	ctrl: boolean;
}

export const MOUSE_WHEEL_UP = 64;
export const MOUSE_WHEEL_DOWN = 65;
export const MOUSE_BUTTON_LEFT = 0;

const SGR_MOUSE_PATTERN = /^\x1b\[<(\d+);(\d+);(\d+)([Mm])$/;
const MODIFIER_SHIFT = 4;
const MODIFIER_ALT = 8;
const MODIFIER_CTRL = 16;
const MOTION_BIT = 32;

export function isMouseSequence(sequence: string): boolean {
	return sequence.startsWith("\x1b[<") || sequence.startsWith("\x1b[M");
}

export function parseSgrMouseEvent(sequence: string): MouseEvent | null {
	const match = sequence.match(SGR_MOUSE_PATTERN);
	if (!match) return null;
	const raw = Number(match[1]);
	return {
		button: raw & ~(MODIFIER_SHIFT | MODIFIER_ALT | MODIFIER_CTRL | MOTION_BIT),
		x: Number(match[2]),
		y: Number(match[3]),
		press: match[4] === "M",
		motion: (raw & MOTION_BIT) !== 0,
		shift: (raw & MODIFIER_SHIFT) !== 0,
		alt: (raw & MODIFIER_ALT) !== 0,
		ctrl: (raw & MODIFIER_CTRL) !== 0,
	};
}

export function isWheelUp(event: MouseEvent): boolean {
	return event.press && event.button === MOUSE_WHEEL_UP;
}

export function isWheelDown(event: MouseEvent): boolean {
	return event.press && event.button === MOUSE_WHEEL_DOWN;
}

import * as fs from "node:fs";
import { createRequire } from "node:module";
import * as path from "node:path";
import { setKittyProtocolActive } from "./keys.js";
import { StdinBuffer } from "./stdin-buffer.js";
import {
	parseOscColorResponse,
	QUERY_DEFAULT_BACKGROUND,
	QUERY_DEFAULT_FOREGROUND,
	type Rgb,
	setDefaultTerminalColors,
} from "./terminal-colors.js";

const cjsRequire = createRequire(import.meta.url);

interface WindowsKernel32 {
	symbols: {
		GetStdHandle(handle: number): unknown;
		GetConsoleMode(handle: unknown, mode: unknown): boolean;
		SetConsoleMode(handle: unknown, mode: number): boolean;
	};
	close(): void;
}

interface BunFfi {
	dlopen(library: string, symbols: Record<string, { args: string[]; returns: string }>): WindowsKernel32;
	ptr(buffer: Uint32Array): unknown;
}

function enableWindowsVirtualTerminalInput(): void {
	if (process.platform !== "win32") return;
	try {
		const STD_INPUT_HANDLE = -10;
		const ENABLE_VIRTUAL_TERMINAL_INPUT = 0x0200;

		const bunRuntime = Reflect.get(globalThis, "Bun") as { FFI?: BunFfi } | undefined;
		const bunFfi = bunRuntime?.FFI;
		if (bunFfi) {
			const kernel32 = bunFfi.dlopen("kernel32.dll", {
				GetStdHandle: { args: ["i32"], returns: "ptr" },
				GetConsoleMode: { args: ["ptr", "ptr"], returns: "bool" },
				SetConsoleMode: { args: ["ptr", "u32"], returns: "bool" },
			});
			try {
				const handle = kernel32.symbols.GetStdHandle(STD_INPUT_HANDLE);
				const mode = new Uint32Array(1);
				if (handle && kernel32.symbols.GetConsoleMode(handle, bunFfi.ptr(mode))) {
					kernel32.symbols.SetConsoleMode(handle, mode[0]! | ENABLE_VIRTUAL_TERMINAL_INPUT);
				}
			} finally {
				kernel32.close();
			}
			return;
		}

		const koffi = cjsRequire("koffi");
		const kernel32 = koffi.load("kernel32.dll");
		const GetStdHandle = kernel32.func("void* __stdcall GetStdHandle(int)");
		const GetConsoleMode = kernel32.func("bool __stdcall GetConsoleMode(void*, _Out_ uint32_t*)");
		const SetConsoleMode = kernel32.func("bool __stdcall SetConsoleMode(void*, uint32_t)");
		const handle = GetStdHandle(STD_INPUT_HANDLE);
		const mode = new Uint32Array(1);
		if (handle && GetConsoleMode(handle, mode)) {
			SetConsoleMode(handle, mode[0]! | ENABLE_VIRTUAL_TERMINAL_INPUT);
		}
	} catch {
		// The terminal remains usable, but modified key events may be unavailable.
	}
}

const TERMINAL_PROGRESS_KEEPALIVE_MS = 1000;
const TERMINAL_PROGRESS_ACTIVE_SEQUENCE = "\x1b]9;4;3\x07";
const TERMINAL_PROGRESS_CLEAR_SEQUENCE = "\x1b]9;4;0;\x07";

// A preserved alternate screen is adopted by the next ProcessTerminal during in-process handoff.
let pendingAltScreenHandoff: symbol | undefined;

interface PendingInputHandoff {
	token: symbol;
	wasRaw: boolean;
	discardHandler: (data: string) => void;
}

// Keep stdin raw and drain input while a preserved fullscreen frame waits for
// the next in-process TUI. Worker-backed session attach can make this handoff
// noticeably longer; restoring cooked mode during the gap makes arrow escape
// sequences echo into the preserved frame.
let pendingInputHandoff: PendingInputHandoff | undefined;

function consumeAltScreenHandoff(): boolean {
	if (!pendingAltScreenHandoff) {
		return false;
	}
	pendingAltScreenHandoff = undefined;
	return true;
}

function beginInputHandoff(token: symbol, wasRaw: boolean): void {
	const inheritedWasRaw = pendingInputHandoff?.wasRaw ?? wasRaw;
	if (pendingInputHandoff) {
		process.stdin.removeListener("data", pendingInputHandoff.discardHandler);
	}
	const discardHandler = (_data: string) => {};
	pendingInputHandoff = { token, wasRaw: inheritedWasRaw, discardHandler };
	process.stdin.on("data", discardHandler);
	process.stdin.resume();
}

function consumeInputHandoff(): boolean | undefined {
	const handoff = pendingInputHandoff;
	if (!handoff) {
		return undefined;
	}
	process.stdin.removeListener("data", handoff.discardHandler);
	pendingInputHandoff = undefined;
	return handoff.wasRaw;
}

function cancelInputHandoff(token: symbol): void {
	const handoff = pendingInputHandoff;
	if (!handoff || handoff.token !== token) {
		return;
	}
	process.stdin.removeListener("data", handoff.discardHandler);
	pendingInputHandoff = undefined;
	process.stdin.pause();
	if (process.stdin.setRawMode) {
		process.stdin.setRawMode(handoff.wasRaw);
	}
}

/**
 * Minimal terminal interface for TUI
 */
export interface Terminal {
	// Start the terminal with input and resize handlers
	start(onInput: (data: string) => void, onResize: () => void): void;

	// Stop the terminal and restore state
	stop(options?: TerminalStopOptions): void;

	/**
	 * Drain stdin before exiting to prevent Kitty key release events from
	 * leaking to the parent shell over slow SSH connections.
	 * @param maxMs - Maximum time to drain (default: 1000ms)
	 * @param idleMs - Exit early if no input arrives within this time (default: 50ms)
	 */
	drainInput(maxMs?: number, idleMs?: number): Promise<void>;

	// Write output to terminal
	write(data: string): void;

	// Get terminal dimensions
	get columns(): number;
	get rows(): number;

	// Whether Kitty keyboard protocol is active
	get kittyProtocolActive(): boolean;

	// Cursor positioning (relative to current position)
	moveBy(lines: number): void; // Move cursor up (negative) or down (positive) by N lines

	// Cursor visibility
	hideCursor(): void; // Hide the cursor
	showCursor(): void; // Show the cursor

	// Clear operations
	clearLine(): void; // Clear current line
	clearFromCursor(): void; // Clear from cursor to end of screen
	clearScreen(): void; // Clear entire screen and move cursor to (0,0)

	// Alternate screen buffer. The primary screen (and its scrollback) is left
	// untouched while the alt screen is active, so a full-screen view can be
	// shown and dismissed without disturbing the transcript history.
	enterAltScreen(): void;
	leaveAltScreen(): void;
	get altScreenActive(): boolean;

	// SGR mouse tracking (?1000 + ?1006); motion tracking is deliberately never
	// enabled so native drag-selection keeps working.
	setMouseTracking(enabled: boolean): void;
	get mouseTrackingActive(): boolean;

	// Title operations
	setTitle(title: string): void; // Set terminal window title

	// Progress indicator (OSC 9;4)
	setProgress(active: boolean): void;
}

export interface TerminalStopOptions {
	preserveAltScreen?: boolean;
}

/**
 * Real terminal using process.stdin/stdout
 */
export class ProcessTerminal implements Terminal {
	private wasRaw = false;
	private started = false;
	private inputHandler?: (data: string) => void;
	private resizeHandler?: () => void;
	private _kittyProtocolActive = false;
	private _modifyOtherKeysActive = false;
	private readonly altScreenHandoffToken = Symbol("altScreenHandoff");
	private _altScreenActive = consumeAltScreenHandoff();
	private _mouseTrackingActive = false;
	private stdinBuffer?: StdinBuffer;
	private stdinDataHandler?: (data: string) => void;
	private keyboardProtocolFallbackTimer?: ReturnType<typeof setTimeout>;
	private progressInterval?: ReturnType<typeof setInterval>;
	private defaultColorProbe?: {
		foreground?: Rgb;
		background?: Rgb;
		timeout: ReturnType<typeof setTimeout>;
	};
	private writeLogPath = (() => {
		const env = process.env.PI_TUI_WRITE_LOG || "";
		if (!env) return "";
		try {
			if (fs.statSync(env).isDirectory()) {
				const now = new Date();
				const ts = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}-${String(now.getDate()).padStart(2, "0")}_${String(now.getHours()).padStart(2, "0")}-${String(now.getMinutes()).padStart(2, "0")}-${String(now.getSeconds()).padStart(2, "0")}`;
				return path.join(env, `tui-${ts}-${process.pid}.log`);
			}
		} catch {
			// Not an existing directory - use as-is (file path)
		}
		return env;
	})();

	get kittyProtocolActive(): boolean {
		return this._kittyProtocolActive;
	}

	start(onInput: (data: string) => void, onResize: () => void): void {
		this.started = true;
		this.inputHandler = onInput;
		this.resizeHandler = onResize;

		// Save previous state and enable raw mode
		this.wasRaw = consumeInputHandoff() ?? process.stdin.isRaw ?? false;
		if (process.stdin.setRawMode) {
			process.stdin.setRawMode(true);
		}
		process.stdin.setEncoding("utf8");
		process.stdin.resume();

		// Enable bracketed paste mode - terminal will wrap pastes in \x1b[200~ ... \x1b[201~
		process.stdout.write("\x1b[?2004h");

		// Set up resize handler immediately
		process.stdout.on("resize", this.resizeHandler);

		// Refresh terminal dimensions - they may be stale after suspend/resume
		// (SIGWINCH is lost while process is stopped). Unix only.
		if (process.platform !== "win32") {
			process.kill(process.pid, "SIGWINCH");
		}

		// On Windows, enable ENABLE_VIRTUAL_TERMINAL_INPUT so the console sends
		// VT escape sequences (e.g. \x1b[Z for Shift+Tab) instead of raw console
		// events that lose modifier information. Must run AFTER setRawMode(true)
		// since that resets console mode flags.
		this.enableWindowsVTInput();

		// Query and enable Kitty keyboard protocol
		// The query handler intercepts input temporarily, then installs the user's handler
		// See: https://sw.kovidgoyal.net/kitty/keyboard-protocol/
		this.queryAndEnableKittyProtocol();
	}

	/**
	 * Set up StdinBuffer to split batched input into individual sequences.
	 * This ensures components receive single events, making matchesKey/isKeyRelease work correctly.
	 *
	 * Also watches for Kitty protocol response and enables it when detected.
	 * This is done here (after stdinBuffer parsing) rather than on raw stdin
	 * to handle the case where the response arrives split across multiple events.
	 */
	private setupStdinBuffer(): void {
		this.stdinBuffer = new StdinBuffer({ timeout: 10 });

		// Kitty protocol response pattern: \x1b[?<flags>u
		const kittyResponsePattern = /^\x1b\[\?(\d+)u$/;

		// Forward individual sequences to the input handler
		this.stdinBuffer.on("data", (sequence) => {
			if (this.handleDefaultColorProbeResponse(sequence)) {
				return;
			}

			// Check for Kitty protocol response (only if not already enabled)
			if (!this._kittyProtocolActive) {
				const match = sequence.match(kittyResponsePattern);
				if (match) {
					this.clearKeyboardProtocolFallbackTimer();
					this._kittyProtocolActive = true;
					setKittyProtocolActive(true);

					// Enable Kitty keyboard protocol (push flags)
					// Flag 1 = disambiguate escape codes
					// Flag 2 = report event types (press/repeat/release)
					// Flag 4 = report alternate keys (shifted key, base layout key)
					// Base layout key enables shortcuts to work with non-Latin keyboard layouts
					process.stdout.write("\x1b[>7u");
					return; // Don't forward protocol response to TUI
				}
			}

			if (this.inputHandler) {
				this.inputHandler(sequence);
			}
		});

		// Re-wrap paste content with bracketed paste markers for existing editor handling
		this.stdinBuffer.on("paste", (content) => {
			if (this.inputHandler) {
				this.inputHandler(`\x1b[200~${content}\x1b[201~`);
			}
		});

		// Handler that pipes stdin data through the buffer
		this.stdinDataHandler = (data: string) => {
			this.stdinBuffer!.process(data);
		};
	}

	/**
	 * Query terminal for Kitty keyboard protocol support and enable if available.
	 *
	 * Sends CSI ? u to query current flags. If terminal responds with CSI ? <flags> u,
	 * it supports the protocol and we enable it with CSI > 1 u.
	 *
	 * If no Kitty response arrives shortly after startup, fall back to enabling
	 * xterm modifyOtherKeys mode 2. This is needed for tmux, which can forward
	 * modified enter keys as CSI-u when extended-keys is enabled, but may not
	 * answer the Kitty protocol query.
	 *
	 * The response is detected in setupStdinBuffer's data handler, which properly
	 * handles the case where the response arrives split across multiple stdin events.
	 */
	private queryAndEnableKittyProtocol(): void {
		this.setupStdinBuffer();
		process.stdin.on("data", this.stdinDataHandler!);
		this.queryDefaultTerminalColors();
		process.stdout.write("\x1b[?u");
		this.clearKeyboardProtocolFallbackTimer();
		this.keyboardProtocolFallbackTimer = setTimeout(() => {
			this.keyboardProtocolFallbackTimer = undefined;
			if (!this._kittyProtocolActive && !this._modifyOtherKeysActive) {
				process.stdout.write("\x1b[>4;2m");
				this._modifyOtherKeysActive = true;
			}
		}, 150);
	}

	private clearKeyboardProtocolFallbackTimer(): void {
		if (!this.keyboardProtocolFallbackTimer) {
			return;
		}
		clearTimeout(this.keyboardProtocolFallbackTimer);
		this.keyboardProtocolFallbackTimer = undefined;
	}

	private queryDefaultTerminalColors(): void {
		if (process.stdin.isTTY !== true || process.stdout.isTTY !== true) {
			return;
		}
		this.finishDefaultColorProbe();
		this.defaultColorProbe = {
			timeout: setTimeout(() => this.finishDefaultColorProbe(), 100),
		};
		process.stdout.write(QUERY_DEFAULT_FOREGROUND);
		process.stdout.write(QUERY_DEFAULT_BACKGROUND);
	}

	private handleDefaultColorProbeResponse(sequence: string): boolean {
		const response = parseOscColorResponse(sequence);
		if (!response) {
			return false;
		}
		if (!this.defaultColorProbe) {
			return true;
		}

		this.defaultColorProbe[response.kind] = response.rgb;
		if (this.defaultColorProbe.foreground && this.defaultColorProbe.background) {
			this.finishDefaultColorProbe();
		}
		return true;
	}

	private finishDefaultColorProbe(): void {
		if (!this.defaultColorProbe) {
			return;
		}

		const { foreground, background, timeout } = this.defaultColorProbe;
		clearTimeout(timeout);
		this.defaultColorProbe = undefined;
		if (foreground && background) {
			setDefaultTerminalColors({ foreground, background });
			this.resizeHandler?.();
		}
	}

	/**
	 * On Windows, add ENABLE_VIRTUAL_TERMINAL_INPUT (0x0200) to the stdin
	 * console handle so the terminal sends VT sequences for modified keys
	 * (e.g. \x1b[Z for Shift+Tab). Without this, libuv's ReadConsoleInputW
	 * discards modifier state and Shift+Tab arrives as plain \t.
	 */

	private enableWindowsVTInput(): void {
		enableWindowsVirtualTerminalInput();
	}

	async drainInput(maxMs = 1000, idleMs = 50): Promise<void> {
		if (this._kittyProtocolActive) {
			// Disable Kitty keyboard protocol first so any late key releases
			// do not generate new Kitty escape sequences.
			process.stdout.write("\x1b[<u");
			this._kittyProtocolActive = false;
			setKittyProtocolActive(false);
		}
		if (this._modifyOtherKeysActive) {
			process.stdout.write("\x1b[>4;0m");
			this._modifyOtherKeysActive = false;
		}

		const previousHandler = this.inputHandler;
		this.inputHandler = undefined;

		let lastDataTime = Date.now();
		const onData = () => {
			lastDataTime = Date.now();
		};

		process.stdin.on("data", onData);
		const endTime = Date.now() + maxMs;

		try {
			while (true) {
				const now = Date.now();
				const timeLeft = endTime - now;
				if (timeLeft <= 0) break;
				if (now - lastDataTime >= idleMs) break;
				await new Promise((resolve) => setTimeout(resolve, Math.min(idleMs, timeLeft)));
			}
		} finally {
			process.stdin.removeListener("data", onData);
			this.inputHandler = previousHandler;
		}
	}

	stop(options: TerminalStopOptions = {}): void {
		const wasStarted = this.started;
		this.started = false;
		this.finishDefaultColorProbe();
		this.clearKeyboardProtocolFallbackTimer();

		if (this.clearProgressInterval()) {
			process.stdout.write(TERMINAL_PROGRESS_CLEAR_SEQUENCE);
		}

		if (this._mouseTrackingActive) {
			process.stdout.write("\x1b[?1006l\x1b[?1002l");
			this._mouseTrackingActive = false;
		}
		if (this._altScreenActive) {
			if (options.preserveAltScreen) {
				pendingAltScreenHandoff = this.altScreenHandoffToken;
				this._altScreenActive = false;
			} else {
				this.releaseAltScreen();
			}
		} else if (!options.preserveAltScreen) {
			this.releaseAltScreen();
		}

		// Disable bracketed paste mode
		process.stdout.write("\x1b[?2004l");

		// Disable Kitty keyboard protocol if not already done by drainInput()
		if (this._kittyProtocolActive) {
			process.stdout.write("\x1b[<u");
			this._kittyProtocolActive = false;
			setKittyProtocolActive(false);
		}
		if (this._modifyOtherKeysActive) {
			process.stdout.write("\x1b[>4;0m");
			this._modifyOtherKeysActive = false;
		}

		// Clean up StdinBuffer
		if (this.stdinBuffer) {
			this.stdinBuffer.destroy();
			this.stdinBuffer = undefined;
		}

		// Remove event handlers
		if (this.stdinDataHandler) {
			process.stdin.removeListener("data", this.stdinDataHandler);
			this.stdinDataHandler = undefined;
		}
		this.inputHandler = undefined;
		if (this.resizeHandler) {
			process.stdout.removeListener("resize", this.resizeHandler);
			this.resizeHandler = undefined;
		}

		if (options.preserveAltScreen && wasStarted) {
			beginInputHandoff(this.altScreenHandoffToken, this.wasRaw);
		} else {
			// Pause stdin to prevent any buffered input (e.g., Ctrl+D) from being
			// re-interpreted after raw mode is disabled. This fixes a race condition
			// where Ctrl+D could close the parent shell over SSH.
			process.stdin.pause();

			// Restore raw mode state
			if (process.stdin.setRawMode) {
				process.stdin.setRawMode(this.wasRaw);
			}
		}
	}

	write(data: string): void {
		process.stdout.write(data);
		if (this.writeLogPath) {
			try {
				fs.appendFileSync(this.writeLogPath, data, { encoding: "utf8" });
			} catch {
				// Ignore logging errors
			}
		}
	}

	get columns(): number {
		return process.stdout.columns || Number(process.env.COLUMNS) || 80;
	}

	get rows(): number {
		return process.stdout.rows || Number(process.env.LINES) || 24;
	}

	moveBy(lines: number): void {
		if (lines > 0) {
			// Move down
			process.stdout.write(`\x1b[${lines}B`);
		} else if (lines < 0) {
			// Move up
			process.stdout.write(`\x1b[${-lines}A`);
		}
		// lines === 0: no movement
	}

	hideCursor(): void {
		process.stdout.write("\x1b[?25l");
	}

	showCursor(): void {
		process.stdout.write("\x1b[?25h");
	}

	clearLine(): void {
		process.stdout.write("\x1b[K");
	}

	clearFromCursor(): void {
		process.stdout.write("\x1b[J");
	}

	clearScreen(): void {
		process.stdout.write("\x1b[2J\x1b[H"); // Clear screen and move to home (1,1)
	}

	enterAltScreen(): void {
		if (this._altScreenActive) return;
		if (this.ownsPendingAltScreenHandoff()) {
			pendingAltScreenHandoff = undefined;
			this._altScreenActive = true;
			return;
		}
		this._altScreenActive = true;
		this.write("\x1b[?1049h");
	}

	leaveAltScreen(): void {
		this.releaseAltScreen();
	}

	private releaseAltScreen(): void {
		const ownsPendingHandoff = this.ownsPendingAltScreenHandoff();
		if (!this._altScreenActive && !ownsPendingHandoff) return;
		this._altScreenActive = false;
		if (ownsPendingHandoff) {
			pendingAltScreenHandoff = undefined;
			cancelInputHandoff(this.altScreenHandoffToken);
		}
		this.write("\x1b[?1049l");
	}

	get altScreenActive(): boolean {
		return this._altScreenActive;
	}

	private ownsPendingAltScreenHandoff(): boolean {
		return pendingAltScreenHandoff === this.altScreenHandoffToken;
	}

	setMouseTracking(enabled: boolean): void {
		if (enabled === this._mouseTrackingActive) return;
		this._mouseTrackingActive = enabled;
		// ?1002 (button-event tracking) reports drag motion for in-app selection
		// but not hover, keeping passive mouse movement unreported.
		this.write(enabled ? "\x1b[?1002h\x1b[?1006h" : "\x1b[?1006l\x1b[?1002l");
	}

	get mouseTrackingActive(): boolean {
		return this._mouseTrackingActive;
	}

	setTitle(title: string): void {
		// OSC 0;title BEL - set terminal window title
		process.stdout.write(`\x1b]0;${title}\x07`);
	}

	setProgress(active: boolean): void {
		if (active) {
			// OSC 9;4;3 - indeterminate progress
			process.stdout.write(TERMINAL_PROGRESS_ACTIVE_SEQUENCE);
			if (!this.progressInterval) {
				this.progressInterval = setInterval(() => {
					process.stdout.write(TERMINAL_PROGRESS_ACTIVE_SEQUENCE);
				}, TERMINAL_PROGRESS_KEEPALIVE_MS);
			}
		} else {
			this.clearProgressInterval();
			// OSC 9;4;0 - clear progress
			process.stdout.write(TERMINAL_PROGRESS_CLEAR_SEQUENCE);
		}
	}

	private clearProgressInterval(): boolean {
		if (!this.progressInterval) return false;
		clearInterval(this.progressInterval);
		this.progressInterval = undefined;
		return true;
	}
}

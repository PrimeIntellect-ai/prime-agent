import { spawn, spawnSync } from "child_process";
import { platform } from "os";
import { isWaylandSession } from "./clipboard-image.js";
import { clipboard } from "./clipboard-native.js";

type NativeClipboardExecOptions = {
	input: string;
	timeout: number;
	stdio: ["pipe", "ignore", "ignore"];
};

function runClipboardCommand(command: string, args: string[], options: NativeClipboardExecOptions): boolean {
	const result = spawnSync(command, args, { ...options, shell: false });
	return result.error === undefined && result.signal === null && result.status === 0;
}

function copyToX11Clipboard(options: NativeClipboardExecOptions): boolean {
	return (
		runClipboardCommand("xclip", ["-selection", "clipboard"], options) ||
		runClipboardCommand("xsel", ["--clipboard", "--input"], options)
	);
}

function copyToWaylandClipboard(text: string, timeoutMs = 5000): Promise<boolean> {
	return new Promise((resolve) => {
		const proc = spawn("wl-copy", [], { shell: false, stdio: ["pipe", "ignore", "ignore"] });
		let settled = false;
		const finish = (success: boolean) => {
			if (settled) return;
			settled = true;
			clearTimeout(timer);
			resolve(success);
		};
		const onError = () => {
			if (settled) return;
			proc.stdin.destroy();
			finish(false);
		};
		const onStdinError = () => {
			if (settled) return;
			proc.kill("SIGKILL");
			finish(false);
		};
		const onSpawn = () => {
			if (!settled) proc.stdin.end(text);
		};
		const onClose = (code: number | null, signal: NodeJS.Signals | null) => finish(code === 0 && signal === null);
		const timer = setTimeout(() => {
			proc.kill("SIGKILL");
			proc.stdin.destroy();
			finish(false);
		}, timeoutMs);

		proc.unref();
		proc.once("error", onError);
		proc.stdin.once("error", onStdinError);
		proc.once("spawn", onSpawn);
		proc.once("close", onClose);
	});
}

const MAX_OSC52_ENCODED_LENGTH = 100_000;

function isRemoteSession(env: NodeJS.ProcessEnv = process.env): boolean {
	return Boolean(env.SSH_CONNECTION || env.SSH_CLIENT || env.MOSH_CONNECTION);
}

function emitOsc52(text: string): boolean {
	const encoded = Buffer.from(text).toString("base64");
	if (encoded.length > MAX_OSC52_ENCODED_LENGTH) {
		return false;
	}
	process.stdout.write(`\x1b]52;c;${encoded}\x07`);
	return true;
}

export async function copyToClipboard(text: string): Promise<void> {
	let copied = false;

	const p = platform();

	// Prefer direct clipboard writes. Emitting OSC 52 first can make terminals
	// write the same native clipboard concurrently with the addon, and very large
	// OSC 52 payloads can desynchronize terminal rendering.
	//
	// On Linux, skip the native addon. The underlying `clipboard-rs` crate is
	// X11-only and does not retain selection ownership after `set_text`
	// resolves, so on Wayland-only compositors (Hyprland, Niri, ...) and even
	// some X11 sessions the call resolves successfully without populating the
	// clipboard. The platform tools below (wl-copy, xclip, xsel) properly
	// daemonize and keep ownership.
	try {
		if (clipboard && p !== "linux") {
			await clipboard.setText(text);
			copied = true;
		}
	} catch {
		// Fall through to platform-specific clipboard tools.
	}

	const remote = isRemoteSession();
	if (copied && !remote) {
		return;
	}

	const options: NativeClipboardExecOptions = { input: text, timeout: 5000, stdio: ["pipe", "ignore", "ignore"] };

	if (!copied) {
		try {
			if (p === "darwin") {
				copied = runClipboardCommand("pbcopy", [], options);
			} else if (p === "win32") {
				copied = runClipboardCommand("clip", [], options);
			} else {
				// Linux. Try Termux, Wayland, or X11 clipboard tools.
				if (process.env.TERMUX_VERSION) {
					copied = runClipboardCommand("termux-clipboard-set", [], options);
				}

				if (!copied) {
					const hasWaylandDisplay = Boolean(process.env.WAYLAND_DISPLAY);
					const hasX11Display = Boolean(process.env.DISPLAY);
					const isWayland = isWaylandSession();
					if (isWayland && hasWaylandDisplay) {
						copied = await copyToWaylandClipboard(text);
						if (!copied && hasX11Display) {
							copied = copyToX11Clipboard(options);
						}
					} else if (hasX11Display) {
						copied = copyToX11Clipboard(options);
					}
				}
			}
		} catch {
			// Fall through to OSC 52 fallback.
		}
	}

	if (remote || !copied) {
		const osc52Copied = emitOsc52(text);
		copied = copied || osc52Copied;
	}

	if (!copied) {
		throw new Error("Failed to copy to clipboard");
	}
}

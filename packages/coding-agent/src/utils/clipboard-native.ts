import { createRequire } from "module";
import { type ClipboardModule, loadBundledClipboard } from "./clipboard-binary-binding.js";

const require = createRequire(import.meta.url);
let clipboard: ClipboardModule | null = null;

const hasDisplay = process.platform !== "linux" || Boolean(process.env.DISPLAY || process.env.WAYLAND_DISPLAY);

if (!process.env.TERMUX_VERSION && hasDisplay) {
	try {
		clipboard = loadBundledClipboard() ?? (require("@mariozechner/clipboard") as ClipboardModule);
	} catch {
		clipboard = null;
	}
}

export { clipboard };

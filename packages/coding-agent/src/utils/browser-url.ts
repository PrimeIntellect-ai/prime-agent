import { win32 } from "node:path";
import { execFileHidden } from "./child-process.js";

const MAX_BROWSER_URL_LENGTH = 8192;
const CONTROL_CHARACTERS = /[\u0000-\u001f\u007f-\u009f]/;

/**
 * Returns the URL unchanged when it is safe to hand to the OS opener: an absolute
 * http(s) URL without embedded credentials or control characters, at most 8 KiB.
 * Anything else (`file:`, `javascript:`, escape-sequence payloads) yields undefined.
 */
export function validateBrowserUrl(value: string): string | undefined {
	if (value.length > MAX_BROWSER_URL_LENGTH || CONTROL_CHARACTERS.test(value)) return undefined;
	let url: URL;
	try {
		url = new URL(value);
	} catch {
		return undefined;
	}
	if (url.protocol !== "http:" && url.protocol !== "https:") return undefined;
	if (url.username || url.password || !url.hostname) return undefined;
	return value;
}

/** Text-safe rendering of a string that failed validateBrowserUrl: control characters removed, length capped. */
export function sanitizeUrlForDisplay(value: string): string {
	const stripped = value.replace(/[\u0000-\u001f\u007f-\u009f]/g, "");
	return stripped.length > 512 ? `${stripped.slice(0, 512)}…` : stripped;
}

/** Open a URL with the platform browser opener. Returns false without launching anything when the URL is rejected. */
export function openUrlInBrowser(value: string): boolean {
	const url = validateBrowserUrl(value);
	if (!url) return false;
	const [command, ...args] =
		process.platform === "darwin"
			? ["open", url]
			: process.platform === "win32"
				? [
						win32.join(process.env.SystemRoot ?? "C:\\Windows", "System32", "rundll32.exe"),
						"url.dll,FileProtocolHandler",
						url,
					]
				: ["xdg-open", url];
	execFileHidden(command, args, {}, () => {});
	return true;
}

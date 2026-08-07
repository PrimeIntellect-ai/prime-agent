export type ActCancellationCapability = "cooperative-only" | "posix-managed";

/** Cancellation guarantee implemented by the current host platform. */
export function actCancellationCapability(platform: NodeJS.Platform = process.platform): ActCancellationCapability {
	return platform === "win32" ? "cooperative-only" : "posix-managed";
}

/** Directing-model boundary for the current host platform. */
export function actCancellationPromptBoundary(platform: NodeJS.Platform = process.platform): string {
	if (actCancellationCapability(platform) === "cooperative-only") {
		return "Act cancellation stops provider work and cooperative awaited Python. On native Windows, synchronous Python and blocking shell work have no prompt-stop guarantee; do not claim they stopped until they return.";
	}
	return "Act cancellation stops provider work and cooperative awaited Python. On POSIX, a still-active synchronous inner cell receives one correlated interrupt, and managed `%%bash` process groups are terminated. Detached, daemonized, remote, and completed effects remain outside that guarantee.";
}

/** Context-tree label visible through in-process and daemon clients. */
export function actContextLabel(platform: NodeJS.Platform = process.platform): string {
	return actCancellationCapability(platform) === "cooperative-only"
		? "Act lane (cooperative cancellation only)"
		: "Act lane";
}

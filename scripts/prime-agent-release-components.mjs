// The release is intentionally a fixed multi-package set. Keep this order stable: it is
// part of the manifest and verification contract.
export const releaseComponents = Object.freeze([
	{ component: "agent", packageDir: "agent", packageName: "prime-agent-core", artifactName: "prime-agent-core" },
	{ component: "ai", packageDir: "ai", packageName: "prime-agent-ai", artifactName: "prime-agent-ai" },
	{ component: "tui", packageDir: "tui", packageName: "prime-agent-tui", artifactName: "prime-agent-tui" },
	{ component: "coding-agent", packageDir: "coding-agent", packageName: "prime-agent", artifactName: "prime-agent" },
]);

export const publicPackageName = "prime-agent";

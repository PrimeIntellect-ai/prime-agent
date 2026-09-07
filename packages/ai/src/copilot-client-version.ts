/**
 * Client identity impersonated on GitHub Copilot requests. The generated
 * catalog bakes these into every Copilot row's headers, and the OAuth flow
 * sends them directly; keep both in sync by editing only this file.
 */
export const COPILOT_CLIENT_USER_AGENT = "GitHubCopilotChat/0.48.1";

export const COPILOT_CLIENT_HEADERS = {
	"User-Agent": COPILOT_CLIENT_USER_AGENT,
	"Editor-Version": "vscode/1.136.1",
	"Editor-Plugin-Version": "copilot-chat/0.48.1",
	"Copilot-Integration-Id": "vscode-chat",
} as const;

import { writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fauxAssistantMessage, fauxToolCall, getApiProvider, registerFauxProvider } from "@earendil-works/pi-ai";
import { DefaultResourceLoader, type ExtensionAPI, getAgentDir, initTheme } from "@earendil-works/pi-coding-agent";

export default function artifactExtension(pi: ExtensionAPI): void {
	const faux = registerFauxProvider({
		provider: "artifact-faux",
		models: [{ id: "artifact", reasoning: false, input: ["text", "image"] }],
		tokenSize: { min: 131072, max: 131072 },
	});
	const provider = getApiProvider(faux.api);
	if (!provider) throw new Error("Faux provider was not bundled");
	pi.registerProvider("artifact-faux", {
		api: faux.api,
		apiKey: "offline-test",
		baseUrl: faux.getModel().baseUrl,
		streamSimple: provider.streamSimple,
		models: faux.models,
	});
	if (process.env.PRIME_AGENT_ARTIFACT_CASE === "python") {
		faux.setResponses([
			fauxAssistantMessage(
				fauxToolCall("ipython", {
					code: "import os, rlm\nartifact_value = 21\nprint('artifact-python-start')\nprint(os.getpid())\nprint(rlm.__file__)",
				}),
				{ stopReason: "toolUse" },
			),
			fauxAssistantMessage(
				fauxToolCall("ipython", {
					code: "print('artifact-python-result', artifact_value * 2)\nprint((await bash('printf artifact-shell-ok')).output)",
				}),
				{ stopReason: "toolUse" },
			),
			(context) => {
				const results = context.messages.filter((message) => message.role === "toolResult");
				if (results.length !== 2 || results.some((result) => result.isError)) {
					throw new Error(`Python execution failed: ${JSON.stringify(results)}`);
				}
				return fauxAssistantMessage(JSON.stringify(results));
			},
		]);
	} else {
		faux.setResponses([
			(context) => {
				if (process.env.PRIME_AGENT_ARTIFACT_CASE === "image") {
					if (!JSON.stringify(context.messages).includes("original 3000x1, displayed at 2000x1")) {
						throw new Error("Photon did not resize the attached image");
					}
				}
				return fauxAssistantMessage(`artifact-ok:${"x".repeat(131072)}:complete`);
			},
		]);
	}
	pi.on("session_start", async () => {
		initTheme("prime");
		const resources = new DefaultResourceLoader({
			cwd: process.cwd(),
			agentDir: getAgentDir(),
			noExtensions: true,
			noContextFiles: true,
		});
		await resources.reload();
		const skills = resources.getSkills().skills;
		if (
			!skills.length ||
			skills.some((skill) => !skill.filePath.startsWith(join(dirname(process.execPath), "skills")))
		) {
			throw new Error("Bundled skills did not resolve from the extracted archive");
		}
		writeFileSync(
			join(process.cwd(), "loaded-assets.json"),
			JSON.stringify({ skills: skills.map((skill) => skill.name) }),
		);
	});
}

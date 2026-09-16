import { spawn, spawnSync } from "node:child_process";
import { statSync } from "node:fs";
import { constants } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const credentialVariables = new Set([
	"ANTHROPIC_API_KEY",
	"ANTHROPIC_OAUTH_TOKEN",
	"OPENAI_API_KEY",
	"PRIME_API_KEY",
	"GEMINI_API_KEY",
	"GROQ_API_KEY",
	"CEREBRAS_API_KEY",
	"XAI_API_KEY",
	"OPENROUTER_API_KEY",
	"ZAI_API_KEY",
	"MISTRAL_API_KEY",
	"MINIMAX_API_KEY",
	"MINIMAX_CN_API_KEY",
	"AI_GATEWAY_API_KEY",
	"OPENCODE_API_KEY",
	"COPILOT_GITHUB_TOKEN",
	"GH_TOKEN",
	"GITHUB_TOKEN",
	"HF_TOKEN",
	"GOOGLE_APPLICATION_CREDENTIALS",
	"GOOGLE_CLOUD_PROJECT",
	"GCLOUD_PROJECT",
	"GOOGLE_CLOUD_LOCATION",
	"AWS_PROFILE",
	"AWS_ACCESS_KEY_ID",
	"AWS_SECRET_ACCESS_KEY",
	"AWS_SESSION_TOKEN",
	"AWS_REGION",
	"AWS_DEFAULT_REGION",
	"AWS_BEARER_TOKEN_BEDROCK",
	"AWS_CONTAINER_CREDENTIALS_RELATIVE_URI",
	"AWS_CONTAINER_CREDENTIALS_FULL_URI",
	"AWS_WEB_IDENTITY_TOKEN_FILE",
	"AZURE_OPENAI_API_KEY",
	"AZURE_OPENAI_BASE_URL",
	"AZURE_OPENAI_RESOURCE_NAME",
]);

function isFile(path) {
	try {
		return statSync(path).isFile();
	} catch {
		return false;
	}
}

function main() {
	const [major, minor] = process.versions.node.split(".").map(Number);
	if (major < 22 || (major === 22 && minor < 8)) {
		console.error(`Prime Agent requires Node.js 22.8 or newer (found ${process.versions.node}).`);
		process.exitCode = 1;
		return;
	}

	let noEnv = false;
	let useDist = false;
	let endOfOptions = false;
	const args = [];
	for (const arg of process.argv.slice(2)) {
		if (!endOfOptions && arg === "--no-env") {
			noEnv = true;
		} else if (!endOfOptions && arg === "--dist") {
			useDist = true;
		} else {
			args.push(arg);
			if (arg === "--") endOfOptions = true;
		}
	}

	const env = { ...process.env };
	if (noEnv) {
		for (const name of Object.keys(env)) {
			// Windows environment variable names are case-insensitive.
			if (credentialVariables.has(process.platform === "win32" ? name.toUpperCase() : name)) delete env[name];
		}
		console.log("Running Prime Agent without API keys...");
	}
	env.PRIME_AGENT_LAUNCHER_PATH = join(root, process.platform === "win32" ? "prime-agent.cmd" : "prime-agent.sh");
	const buildId = spawnSync("git", ["-C", root, "describe", "--tags", "--always", "--dirty"], {
		encoding: "utf8",
		stdio: ["ignore", "pipe", "ignore"],
		shell: false,
		timeout: 5000,
		windowsHide: true,
	});
	if (buildId.status === 0 && buildId.stdout.trim()) env.PRIME_AGENT_BUILD_ID = buildId.stdout.trim();

	const entrypoint = join(root, "packages", "coding-agent", useDist ? "dist/bundle/cli.js" : "src/cli.ts");
	const nodeArgs = [];
	if (useDist) {
		if (!isFile(entrypoint)) {
			console.error(`Bundle not found at ${entrypoint}. Run npm run build:windows from the repo root first.`);
			process.exitCode = 1;
			return;
		}
	} else {
		const tsx = join(root, "node_modules", "tsx", "dist", "cli.mjs");
		if (!isFile(tsx)) {
			console.error(`tsx not found at ${tsx}. Run npm ci from the repo root first.`);
			process.exitCode = 1;
			return;
		}
		if (!isFile(entrypoint)) {
			console.error(`Source CLI not found at ${entrypoint}. Run this launcher from a complete repository checkout.`);
			process.exitCode = 1;
			return;
		}
		// Keep the caller's working directory, but resolve workspace aliases from this checkout.
		env.TSX_TSCONFIG_PATH ??= join(root, "tsconfig.json");
		nodeArgs.push(tsx);
	}
	nodeArgs.push(entrypoint, ...args);
	const child = spawn(process.execPath, nodeArgs, { env, stdio: "inherit", shell: false });
	const handlers = new Map();
	for (const signal of ["SIGINT", "SIGTERM", "SIGHUP"]) {
		const handler = () => child.kill(signal);
		handlers.set(signal, handler);
		process.on(signal, handler);
	}
	function cleanup() {
		for (const [signal, handler] of handlers) process.removeListener(signal, handler);
	}
	child.on("error", (error) => {
		cleanup();
		console.error(`Cannot start Prime Agent: ${error.message}`);
		process.exitCode = 1;
	});
	child.on("exit", (code, signal) => {
		cleanup();
		if (signal) {
			process.exitCode = 128 + (constants.signals[signal] ?? 1);
			if (process.platform !== "win32") process.kill(process.pid, signal);
		} else {
			process.exitCode = code ?? 1;
		}
	});
}

main();

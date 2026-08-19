import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { type AssistantMessage, fauxAssistantMessage, registerFauxProvider } from "@earendil-works/pi-ai";
import type { SessionActionRecoverySnapshot } from "../../src/core/agent-session.js";
import { AuthStorage } from "../../src/core/auth-storage.js";
import { ModelRegistry } from "../../src/core/model-registry.js";
import { createAgentSession } from "../../src/core/sdk.js";
import { SessionManager } from "../../src/core/session-manager.js";

const mode = process.argv[2];
const rootDir = process.argv[3];
if (
	(mode !== "seed" && mode !== "recover" && mode !== "lease-seed" && mode !== "lease-recover") ||
	rootDir === undefined
) {
	throw new Error("Usage: resource-exhaustion-process.ts <seed|recover|lease-seed|lease-recover> <root>");
}

mkdirSync(rootDir, { recursive: true });

function resourceExhaustedMessage(resetAt: number): AssistantMessage {
	return {
		...fauxAssistantMessage("The provider quota is exhausted", {
			stopReason: "error",
			errorMessage: "Provider resource limit reached (usage_limit_reached, 429)",
		}),
		diagnostics: [
			{
				type: "provider_stream_failure",
				timestamp: Date.now(),
				details: {
					kind: "resource_exhausted",
					providerErrorType: "usage_limit_reached",
					status: 429,
					limitClass: "premium",
					resetAt,
					resetInSeconds: 3_600,
					creditsUnavailable: true,
				},
			},
		],
	};
}

function writeResult(value: Record<string, unknown>): void {
	writeFileSync(join(rootDir!, "result.json"), `${JSON.stringify(value)}\n`, "utf8");
}

async function createProcessSession(sessionManager: SessionManager) {
	const faux = registerFauxProvider();
	const model = faux.getModel();
	const authStorage = AuthStorage.inMemory();
	authStorage.setRuntimeApiKey(model.provider, "faux-key");
	const modelRegistry = ModelRegistry.inMemory(authStorage);
	modelRegistry.registerProvider(model.provider, {
		baseUrl: model.baseUrl,
		apiKey: "faux-key",
		api: faux.api,
		models: faux.models.map((registeredModel) => ({
			id: registeredModel.id,
			name: registeredModel.name,
			api: registeredModel.api,
			reasoning: registeredModel.reasoning,
			input: registeredModel.input,
			cost: registeredModel.cost,
			contextWindow: registeredModel.contextWindow,
			maxTokens: registeredModel.maxTokens,
			baseUrl: registeredModel.baseUrl,
		})),
	});
	const result = await createAgentSession({
		cwd: rootDir,
		agentDir: rootDir,
		authStorage,
		modelRegistry,
		sessionManager,
		model,
		noTools: "all",
	});
	return { faux, session: result.session };
}

async function seed(): Promise<void> {
	const sessionManager = SessionManager.create(rootDir!, join(rootDir!, "sessions"));
	const { faux, session } = await createProcessSession(sessionManager);
	const resetAt = Math.floor(Date.now() / 1_000) + 3_600;
	faux.setResponses([resourceExhaustedMessage(resetAt)]);
	await session.prompt("hit the limit");
	await session.followUp("accepted work preserved across restart");
	await session.waitForSessionInputIdle();
	const sessionFile = sessionManager.getSessionFile();
	if (sessionFile === undefined) throw new Error("seed session did not materialize a file");
	writeResult({
		mode,
		sessionFile,
		sessionDir: sessionManager.getSessionDir(),
		resetAt,
		snapshot: session.getSessionActionRecoverySnapshot(),
		callCount: faux.state.callCount,
	});
	setInterval(() => {}, 1_000);
}

async function leaseSeed(): Promise<void> {
	const sessionManager = SessionManager.create(rootDir!, join(rootDir!, "sessions"));
	const { faux, session } = await createProcessSession(sessionManager);
	const resetAt = Math.floor(Date.now() / 1_000) - 1;
	faux.setResponses([resourceExhaustedMessage(resetAt)]);
	await session.prompt("hit the limit");
	let pause: { release(): void } | undefined;
	sessionManager.onPersist(() => {
		const entry = sessionManager.getLatestResourceExhaustedBlockerEntry();
		if (entry?.state !== "probe_leased" || pause !== undefined) return;
		// The pause is acquired from the persistence callback, after the lease is
		// durable but before the scheduler can select the probe action.
		pause = session.acquireQueuedWorkPause();
		const sessionFile = sessionManager.getSessionFile();
		if (sessionFile === undefined) throw new Error("lease seed session did not materialize a file");
		writeResult({
			mode,
			sessionFile,
			sessionDir: sessionManager.getSessionDir(),
			resetAt,
			snapshot: session.getSessionActionRecoverySnapshot(),
			callCount: faux.state.callCount,
		});
	});
	await session.followUp("accepted work preserved after leased-process crash");
	setInterval(() => {}, 1_000);
}

async function recover(): Promise<void> {
	const metadata = JSON.parse(readFileSync(join(rootDir!, "result.json"), "utf8")) as {
		sessionFile: string;
		sessionDir: string;
		snapshot: SessionActionRecoverySnapshot;
	};
	const sessionManager = SessionManager.open(metadata.sessionFile, metadata.sessionDir);
	const { faux, session } = await createProcessSession(sessionManager);
	await session.restoreSessionActions(metadata.snapshot);
	await new Promise<void>((resolve) => setTimeout(resolve, 100));
	writeResult({
		mode,
		callCount: faux.state.callCount,
		blocker: session.getResourceExhaustedBlocker(),
		followUps: session.getSessionActionSnapshot().followUps,
	});
	session.dispose();
	faux.unregister();
}

async function leaseRecover(): Promise<void> {
	const metadata = JSON.parse(readFileSync(join(rootDir!, "result.json"), "utf8")) as {
		sessionFile: string;
		sessionDir: string;
		snapshot: SessionActionRecoverySnapshot;
	};
	const sessionManager = SessionManager.open(metadata.sessionFile, metadata.sessionDir);
	const { faux, session } = await createProcessSession(sessionManager);
	faux.setResponses([fauxAssistantMessage("recovered probe")]);
	await session.restoreSessionActions(metadata.snapshot);
	await session.waitForIdle();
	writeResult({
		mode,
		callCount: faux.state.callCount,
		blocker: session.getResourceExhaustedBlocker(),
		followUps: session.getSessionActionSnapshot().followUps,
	});
	session.dispose();
	faux.unregister();
}

if (mode === "seed") {
	await seed();
} else if (mode === "lease-seed") {
	await leaseSeed();
} else if (mode === "lease-recover") {
	await leaseRecover();
} else {
	await recover();
}

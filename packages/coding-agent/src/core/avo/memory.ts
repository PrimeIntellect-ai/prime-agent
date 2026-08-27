import { type ChildProcessWithoutNullStreams, spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { createInterface, type Interface as ReadlineInterface } from "node:readline";
import type { AvoMemory, AvoMemoryScope } from "./types.js";

export const AVO_NOOA_VERSION = "0.0.9";

export interface AvoNooaBackendConfig {
	owner: string;
	ownerRole: string;
	paths: Partial<Record<AvoMemoryScope, string>>;
}

export interface AvoNooaRecallResult {
	ok: boolean;
	memoryIds: string[];
	backend: "nooa-memory" | "host-fallback";
	reason?: string;
	retrieval?: string;
}

export interface AvoNooaReconciliationCluster {
	scope: AvoMemoryScope;
	memoryIds: string[];
}

type AvoNooaCommandResult = Record<string, unknown> & { ok?: boolean; reason?: string };

export type AvoNooaRunner = (
	command: string,
	databasePath: string,
	payload: Record<string, unknown>,
) => Promise<AvoNooaCommandResult>;

function embeddingConfiguration(): Record<string, unknown> {
	const backend = process.env.PRIME_AGENT_AVO_MEMORY_EMBEDDING === "litellm" ? "litellm" : "hashing";
	if (backend === "hashing") return { backend };
	return {
		backend,
		model: process.env.PRIME_AGENT_AVO_MEMORY_EMBEDDING_MODEL,
		endpoint: process.env.PRIME_AGENT_AVO_MEMORY_EMBEDDING_ENDPOINT,
		api_key: process.env.PRIME_AGENT_AVO_MEMORY_EMBEDDING_API_KEY,
		dimensions: process.env.PRIME_AGENT_AVO_MEMORY_EMBEDDING_DIMENSIONS,
	};
}

function usesLiteLlmEmbedding(): boolean {
	return process.env.PRIME_AGENT_AVO_MEMORY_EMBEDDING === "litellm";
}

class AvoNooaProcessRunner {
	private child?: ChildProcessWithoutNullStreams;
	private lines?: ReadlineInterface;
	private stderr = "";
	private tail: Promise<AvoNooaCommandResult> = Promise.resolve({ ok: true });

	constructor(private readonly sidecarPath: string) {}

	private start(databasePath: string): ChildProcessWithoutNullStreams | undefined {
		if (this.child && this.child.exitCode === null && !this.child.killed) return this.child;
		if (!existsSync(this.sidecarPath)) return undefined;
		this.stderr = "";
		this.child = spawn(
			"uv",
			[
				"run",
				"--quiet",
				"--no-project",
				"--python",
				"3.13",
				"--with",
				`nooa-memory==${AVO_NOOA_VERSION}`,
				...(usesLiteLlmEmbedding() ? ["--with", "litellm"] : []),
				"python",
				this.sidecarPath,
				"serve",
				databasePath,
			],
			{ stdio: ["pipe", "pipe", "pipe"] },
		);
		this.child.stderr.setEncoding("utf8");
		this.child.stderr.on("data", (chunk: string) => {
			if (this.stderr.length < 100_000) this.stderr += chunk;
		});
		this.lines = createInterface({ input: this.child.stdout, crlfDelay: Number.POSITIVE_INFINITY });
		return this.child;
	}

	private execute(
		command: string,
		databasePath: string,
		payload: Record<string, unknown>,
	): Promise<AvoNooaCommandResult> {
		return new Promise((resolve) => {
			const child = this.start(databasePath);
			if (!child || !this.lines) {
				resolve({ ok: false, reason: `NOOA sidecar is missing at ${this.sidecarPath}` });
				return;
			}
			let settled = false;
			const finish = (result: AvoNooaCommandResult) => {
				if (settled) return;
				settled = true;
				clearTimeout(timer);
				this.lines?.off("line", onLine);
				child.off("error", onError);
				child.off("close", onClose);
				resolve(result);
			};
			const onLine = (line: string) => {
				try {
					const parsed = JSON.parse(line) as unknown;
					finish(
						typeof parsed === "object" && parsed !== null && !Array.isArray(parsed)
							? (parsed as AvoNooaCommandResult)
							: { ok: false, reason: "NOOA sidecar returned a non-object result" },
					);
				} catch (error) {
					finish({ ok: false, reason: `NOOA sidecar returned invalid JSON: ${String(error)}` });
				}
			};
			const onError = (error: Error) => finish({ ok: false, reason: error.message });
			const onClose = (code: number | null) =>
				finish({ ok: false, reason: (this.stderr || `sidecar exited ${code}`).trim().slice(-2_000) });
			const timer = setTimeout(() => {
				child.kill("SIGTERM");
				finish({ ok: false, reason: "NOOA sidecar timed out after 120 seconds" });
			}, 120_000);
			this.lines.once("line", onLine);
			child.once("error", onError);
			child.once("close", onClose);
			child.stdin.write(`${JSON.stringify({ command, path: databasePath, payload })}\n`);
		});
	}

	run: AvoNooaRunner = (command, databasePath, payload) => {
		const operation = this.tail.then(() => this.execute(command, databasePath, payload));
		this.tail = operation.catch((error) => ({ ok: false, reason: String(error) }));
		return operation;
	};

	close(): void {
		this.lines?.close();
		this.lines = undefined;
		if (this.child && this.child.exitCode === null) {
			this.child.stdin.end();
			this.child.kill("SIGTERM");
		}
		this.child = undefined;
	}
}

export class AvoNooaMemoryBridge {
	private readonly run: AvoNooaRunner;
	private readonly processRunner?: AvoNooaProcessRunner;

	constructor(
		private readonly config: AvoNooaBackendConfig,
		sidecarPath: string,
		runner?: AvoNooaRunner,
	) {
		if (runner) {
			this.run = runner;
		} else {
			this.processRunner = new AvoNooaProcessRunner(sidecarPath);
			this.run = this.processRunner.run;
		}
	}

	private stores(memories: readonly AvoMemory[]): Array<Record<string, unknown>> {
		return (["task", "project", "global"] as const).flatMap((scope) => {
			const path = this.config.paths[scope];
			if (!path) return [];
			return [
				{
					path,
					scope,
					owner: this.config.owner,
					owner_role: this.config.ownerRole,
					embedding: embeddingConfiguration(),
					memories: memories.filter((memory) => memory.scope === scope),
				},
			];
		});
	}

	async spontaneousRecall(
		memories: readonly AvoMemory[],
		query: string,
		limit = 5,
		maxChars = 2_000,
	): Promise<AvoNooaRecallResult> {
		const stores = this.stores(memories);
		if (stores.length === 0 || memories.length === 0) {
			return { ok: false, memoryIds: [], backend: "host-fallback", reason: "no persistent NOOA store" };
		}
		const databasePath = String(stores[0]!.path);
		const result = await this.run("sync_spontaneous", databasePath, {
			stores,
			query,
			limit,
			max_chars: maxChars,
		});
		if (result.ok !== true || !Array.isArray(result.memory_ids)) {
			return {
				ok: false,
				memoryIds: [],
				backend: "host-fallback",
				reason: typeof result.reason === "string" ? result.reason : "NOOA recall failed",
			};
		}
		return {
			ok: true,
			memoryIds: result.memory_ids.filter((memoryId): memoryId is string => typeof memoryId === "string"),
			backend: "nooa-memory",
			retrieval: typeof result.retrieval === "string" ? result.retrieval : undefined,
		};
	}

	async reflect(memories: readonly AvoMemory[], trigger: string): Promise<AvoNooaCommandResult> {
		const stores = this.stores(memories);
		if (stores.length === 0 || memories.length < 2) {
			return { ok: false, reason: "fewer than two memories are available for consolidation" };
		}
		return this.run("sync_reflect", String(stores[0]!.path), { stores, trigger });
	}

	async reconciliationCandidates(memories: readonly AvoMemory[]): Promise<AvoNooaReconciliationCluster[]> {
		const stores = this.stores(memories);
		if (stores.length === 0 || memories.length < 2) return [];
		const result = await this.run("sync_reconciliation_candidates", String(stores[0]!.path), { stores });
		if (result.ok !== true || !Array.isArray(result.clusters)) return [];
		return result.clusters.flatMap((cluster) => {
			if (typeof cluster !== "object" || cluster === null || Array.isArray(cluster)) return [];
			const value = cluster as Record<string, unknown>;
			if (
				(value.scope !== "task" && value.scope !== "project" && value.scope !== "global") ||
				!Array.isArray(value.memory_ids)
			)
				return [];
			const memoryIds = value.memory_ids.filter((memoryId): memoryId is string => typeof memoryId === "string");
			return memoryIds.length >= 2 ? [{ scope: value.scope, memoryIds }] : [];
		});
	}

	close(): void {
		this.processRunner?.close();
	}
}

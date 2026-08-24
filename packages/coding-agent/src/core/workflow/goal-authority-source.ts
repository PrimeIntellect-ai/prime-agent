import { spawn } from "node:child_process";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { parseCanonicalJsonBytes, sha256Hex } from "./contracts.js";
import type {
	WorkflowGoalAuthoritySourceMaterial,
	WorkflowGoalAuthoritySourceResolver,
} from "./session-host-factory.js";
import type { WorkflowGoalAuthoritySource } from "./shell.js";

const DEFAULT_GOAL_SOURCE_DEADLINE_MILLISECONDS = 30_000;
const SESSION_GOAL_SOURCE_URI = /^session-artifact:\/\/workflow-goal-sources\/(sha256=([a-f0-9]{64})\.json)$/u;

export interface GcloudWorkflowGoalAuthoritySourceResolverOptions {
	readonly executablePath?: string;
	readonly deadlineMilliseconds?: number;
}

function validatedGcsUrl(source: WorkflowGoalAuthoritySource): string {
	if (!source.uri.startsWith("gs://") || source.uri.includes("#"))
		throw new Error("workflow_goal_source_gcloud_uri_invalid");
	return source.uri;
}

async function readExactGeneration(
	source: WorkflowGoalAuthoritySource,
	executablePath: string,
	deadlineMilliseconds: number,
): Promise<Uint8Array> {
	return new Promise<Uint8Array>((resolve, reject) => {
		const child = spawn(
			executablePath,
			["storage", "cp", validatedGcsUrl(source), "-", `--if-generation-match=${source.objectGeneration}`, "--quiet"],
			{
				stdio: ["ignore", "pipe", "ignore"],
			},
		);
		const chunks: Buffer[] = [];
		let sizeBytes = 0;
		let settled = false;
		const finish = (error: Error | null, bytes?: Uint8Array): void => {
			if (settled) return;
			settled = true;
			clearTimeout(deadline);
			if (error === null && bytes !== undefined) resolve(bytes);
			else reject(error ?? new Error("workflow_goal_source_rehydration_unavailable"));
		};
		const deadline = setTimeout(() => {
			child.kill("SIGTERM");
			finish(new Error("workflow_goal_source_rehydration_deadline_exceeded"));
		}, deadlineMilliseconds);
		child.once("error", () => finish(new Error("workflow_goal_source_rehydration_unavailable")));
		child.stdout.on("data", (chunk: Buffer) => {
			sizeBytes += chunk.byteLength;
			if (sizeBytes > source.objectSizeBytes) {
				child.kill("SIGTERM");
				finish(new Error("workflow_goal_source_rehydration_size_exceeded"));
				return;
			}
			chunks.push(chunk);
		});
		child.once("close", (code) => {
			if (code !== 0) {
				finish(new Error("workflow_goal_source_rehydration_unavailable"));
				return;
			}
			finish(null, new Uint8Array(Buffer.concat(chunks, sizeBytes)));
		});
	});
}

/** Resolve one generation-addressed GCS goal object without permitting a latest-object read. */
export function createGcloudWorkflowGoalAuthoritySourceResolver(
	options: GcloudWorkflowGoalAuthoritySourceResolverOptions = {},
): WorkflowGoalAuthoritySourceResolver {
	const executablePath = options.executablePath ?? "gcloud";
	const deadlineMilliseconds = options.deadlineMilliseconds ?? DEFAULT_GOAL_SOURCE_DEADLINE_MILLISECONDS;
	if (!Number.isSafeInteger(deadlineMilliseconds) || deadlineMilliseconds < 1)
		throw new Error("workflow_goal_source_rehydration_deadline_invalid");
	return Object.freeze({
		resolve: async (source: WorkflowGoalAuthoritySource): Promise<WorkflowGoalAuthoritySourceMaterial> => ({
			objectGeneration: source.objectGeneration,
			bytes: await readExactGeneration(source, executablePath, deadlineMilliseconds),
			parsedObjective: source.parsedObjective,
			boundaryIds: [...source.boundaryIds],
			gateIds: [...source.gateIds],
		}),
	});
}

/** Resolve host-sealed goal sources under one session artifact root, delegating all other schemes. */
export function createSessionWorkflowGoalAuthoritySourceResolver(input: {
	readonly artifactRoot: string;
	readonly fallback: WorkflowGoalAuthoritySourceResolver;
}): WorkflowGoalAuthoritySourceResolver {
	return Object.freeze({
		resolve: async (source: WorkflowGoalAuthoritySource): Promise<WorkflowGoalAuthoritySourceMaterial> => {
			const match = SESSION_GOAL_SOURCE_URI.exec(source.uri);
			if (match === null) {
				const cachedPath = join(
					input.artifactRoot,
					"workflow-goal-sources",
					`sha256=${source.objectDigest}.source`,
				);
				let cachedBytes: Uint8Array;
				try {
					cachedBytes = new Uint8Array(await readFile(cachedPath));
				} catch (error) {
					if ((error as NodeJS.ErrnoException).code === "ENOENT") return input.fallback.resolve(source);
					throw error;
				}
				if (cachedBytes.byteLength !== source.objectSizeBytes || sha256Hex(cachedBytes) !== source.objectDigest)
					throw new Error("workflow_goal_source_cached_digest_mismatch");
				return {
					objectGeneration: source.objectGeneration,
					bytes: cachedBytes,
					parsedObjective: source.parsedObjective,
					boundaryIds: [...source.boundaryIds],
					gateIds: [...source.gateIds],
				};
			}
			if (source.objectGeneration !== "1" || source.objectDigest !== match[2])
				throw new Error("workflow_goal_source_session_binding_invalid");
			const bytes = new Uint8Array(await readFile(join(input.artifactRoot, "workflow-goal-sources", match[1]!)));
			if (bytes.byteLength !== source.objectSizeBytes || sha256Hex(bytes) !== source.objectDigest)
				throw new Error("workflow_goal_source_session_digest_mismatch");
			const parsed = parseCanonicalJsonBytes(bytes);
			if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed))
				throw new Error("workflow_goal_source_session_document_invalid");
			const record = parsed as Record<string, unknown>;
			if (
				record.schemaVersion !== 1 ||
				record.objective !== source.parsedObjective ||
				JSON.stringify(record.boundaryIds) !== JSON.stringify(source.boundaryIds) ||
				JSON.stringify(record.gateIds) !== JSON.stringify(source.gateIds)
			)
				throw new Error("workflow_goal_source_session_projection_mismatch");
			return {
				objectGeneration: "1",
				bytes,
				parsedObjective: source.parsedObjective,
				boundaryIds: [...source.boundaryIds],
				gateIds: [...source.gateIds],
			};
		},
	});
}

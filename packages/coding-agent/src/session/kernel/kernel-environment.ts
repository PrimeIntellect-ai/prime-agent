import { mkdirSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AuthStorage } from "../../core/auth-storage.js";
import { getGlobalHarnessStateDir, getLocalHarnessStateDir } from "../../core/refinement/index.js";
import { resolveConfigValue } from "../../core/resolve-config-value.js";
import type { ResourceLoader } from "../../core/resource-loader.js";
import { SERPER_CREDENTIAL_ID, SERPER_ENV_VAR, WEBSEARCH_SKILL_NAME } from "../../core/websearch-credential.js";

export interface KernelEnvironmentHost {
	agentDir?: string;
	authStorage: Pick<AuthStorage, "get">;
	resourceLoader: Pick<ResourceLoader, "getSkills">;
	getDepth(): number;
	getMaxDepth(): number;
	getArtifactDir(): string | undefined;
	getLocalHarnessStateDir(): string | undefined;
}

export class KernelEnvironment {
	constructor(
		private readonly host: KernelEnvironmentHost,
		private _rlmSessionDir?: string,
	) {}
	get sessionDir(): string | undefined {
		return this._rlmSessionDir;
	}
	buildEnv(): Record<string, string> {
		// Kernel env is provisioning-time only: RLM_MAX_DEPTH may be stale in an already-running kernel;
		// the TypeScript-side spawn check remains authoritative.
		const env: Record<string, string> = {
			RLM_DEPTH: String(this.host.getDepth()),
			RLM_MAX_DEPTH: String(this.host.getMaxDepth()),
			RLM_GLOBAL_HARNESS_STATE_DIR: getGlobalHarnessStateDir(),
		};
		const rlmSessionDir = this.ensureSessionDir();
		if (rlmSessionDir) {
			env.RLM_SESSION_DIR = rlmSessionDir;
			// Keep kernel writes and host reads (system prompt, review, /refine) on
			// the same local harness path. Subagents prefer their own artifact dir;
			// ephemeral sessions fall back to the RLM session dir once it exists.
			env.RLM_HARNESS_STATE_DIR = this.host.getLocalHarnessStateDir() ?? getLocalHarnessStateDir(rlmSessionDir)!;
		}
		this._addWebsearchKeyEnv(env);
		return env;
	}

	private _addWebsearchKeyEnv(env: Record<string, string>): void {
		if (this.host.agentDir) {
			env.PRIME_AGENT_CODING_AGENT_DIR = this.host.agentDir;
		}

		if (process.env[SERPER_ENV_VAR]?.trim()) {
			return;
		}
		// Inject only when a websearch skill (bundled or custom) is actually loaded,
		// so the key isn't exposed to kernels that can't use it.
		if (!this.host.resourceLoader.getSkills().skills.some((skill) => skill.name === WEBSEARCH_SKILL_NAME)) {
			return;
		}
		const cred = this.host.authStorage.get(SERPER_CREDENTIAL_ID);
		if (cred?.type !== "api_key") {
			return;
		}
		const resolved = resolveConfigValue(cred.key)?.trim();
		if (resolved) {
			env[SERPER_ENV_VAR] = resolved;
		}
	}

	ensureSessionDir(): string | undefined {
		if (this._rlmSessionDir) {
			mkdirSync(this._rlmSessionDir, { recursive: true });
			return this._rlmSessionDir;
		}

		const sessionArtifactDir = this.host.getArtifactDir();
		if (sessionArtifactDir) {
			mkdirSync(sessionArtifactDir, { recursive: true });
			this._rlmSessionDir = sessionArtifactDir;
			return sessionArtifactDir;
		}

		return undefined;
	}

	createEphemeralSessionDir(): string {
		this._rlmSessionDir = mkdtempSync(join(tmpdir(), "prime-agent-rlm-"));
		return this._rlmSessionDir;
	}
}

import { type Settings, SettingsManager } from "../settings-manager.js";
import type { McpDeclarationDocument } from "./mcp-declarations.js";
import {
	admitProjectMcpDeclarations,
	type ProjectMcpDeclarationAdmission,
	releaseProjectMcpDeclarationAdmission,
	requireProjectMcpDeclarationAdmission,
	validateProjectMcpDeclarationAdmission,
} from "./mcp-project-trust.js";
import { ProjectSettingsOpenat } from "./project-settings-openat.js";
import { createMcpProjectTrustAuthority } from "./project-trust-authority.js";

/** Compose an opaque project admission from a global-only policy snapshot. */
export function admitGlobalMcpProjectDeclarations(
	globalSettings: Pick<Settings, "mcpProjectTrustPolicy"> | undefined,
	cwd: string,
): ProjectMcpDeclarationAdmission | undefined {
	const policy = globalSettings?.mcpProjectTrustPolicy;
	if (!policy) return undefined;
	const authority = createMcpProjectTrustAuthority({
		revision: typeof policy.revision === "string" ? policy.revision : "",
		allowedProjectDirectories:
			Array.isArray(policy.allowedProjectDirectories) &&
			policy.allowedProjectDirectories.every((path) => typeof path === "string")
				? policy.allowedProjectDirectories
				: [],
	});
	return admitProjectMcpDeclarations(cwd, authority);
}

export interface McpProjectDeclarationReaderComposition {
	projectMcpAdmission?: ProjectMcpDeclarationAdmission;
	projectReader?: McpProjectDeclarationReader;
	/** Present only for an admission made by this composition, never an injection. */
	releaseProjectMcpAdmission?: () => void;
}

/**
 * Builds the sole descriptor-relative declaration seam before ordinary project
 * settings may be observed. Kernel discovery begins only after admission.
 */
export async function composeMcpProjectDeclarationReader(options: {
	cwd: string;
	agentDir: string;
	settingsManager?: SettingsManager;
	projectMcpAdmission?: ProjectMcpDeclarationAdmission;
}): Promise<McpProjectDeclarationReaderComposition> {
	const globalSettings = options.settingsManager
		? undefined
		: SettingsManager.loadGlobalSettings(options.cwd, options.agentDir);
	const internallyAdmitted = options.projectMcpAdmission === undefined;
	const projectMcpAdmission =
		options.projectMcpAdmission ?? admitGlobalMcpProjectDeclarations(globalSettings, options.cwd);
	if (!projectMcpAdmission) return {};
	try {
		return {
			projectMcpAdmission,
			projectReader: await McpProjectDeclarationReader.create(projectMcpAdmission),
			...(internallyAdmitted
				? { releaseProjectMcpAdmission: () => releaseProjectMcpDeclarationAdmission(projectMcpAdmission) }
				: {}),
		};
	} catch (error) {
		const stillGranted = validateProjectMcpDeclarationAdmission(projectMcpAdmission).kind === "granted";
		if (internallyAdmitted) releaseProjectMcpDeclarationAdmission(projectMcpAdmission);
		if (stillGranted) throw error;
		return {};
	}
}

/** The project-MCP-only storage seam. Ordinary SettingsManager behavior remains unchanged. */
export class McpProjectDeclarationReader {
	private constructor(
		private readonly admission: ProjectMcpDeclarationAdmission,
		private readonly settings: ProjectSettingsOpenat,
	) {}

	static async create(admission: ProjectMcpDeclarationAdmission): Promise<McpProjectDeclarationReader> {
		requireProjectMcpDeclarationAdmission(admission);
		return new McpProjectDeclarationReader(admission, await ProjectSettingsOpenat.create(admission));
	}

	private assertAvailable(): void {
		requireProjectMcpDeclarationAdmission(this.admission);
	}

	getDocument(): McpDeclarationDocument {
		this.assertAvailable();
		return this.settings.getDocument();
	}

	setDocument(document: McpDeclarationDocument): void {
		this.assertAvailable();
		this.settings.setDocument(document);
	}

	/** Adapter limited to executeMcpDeclarationCommand's three methods. */
	asCommandSettings(): {
		getMcpDeclarationDocument(scope: "user" | "project"): McpDeclarationDocument;
		setMcpDeclarationDocument(scope: "user" | "project", document: McpDeclarationDocument): void;
		flush(): Promise<void>;
	} {
		return {
			getMcpDeclarationDocument: (scope) => {
				if (scope !== "project") throw new Error("Project MCP declarations are unavailable.");
				return this.getDocument();
			},
			setMcpDeclarationDocument: (scope, document) => {
				if (scope !== "project") throw new Error("Project MCP declarations are unavailable.");
				this.setDocument(document);
			},
			flush: async () => {
				this.assertAvailable();
			},
		};
	}
}

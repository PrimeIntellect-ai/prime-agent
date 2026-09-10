import type { AgentMessage } from "@earendil-works/pi-agent-core";
import {
	type CustomMessage,
	createHarnessDigestMessage,
	HARNESS_DIGEST_CUSTOM_TYPE,
	type HarnessDigestDetails,
} from "../core/messages.js";
import { formatHarnessStateForPrompt, type HarnessState, REFINE_SKILL_NAME } from "../core/refinement/index.js";
import type { SessionContext, SessionManager } from "../core/session-manager.js";
import type { Skill } from "../core/skills.js";
export interface HarnessContextHost {
	sessionManager: Pick<SessionManager, "appendCustomMessageEntryWithRollback" | "buildSessionContext">;
	getMessages(): AgentMessage[];
	getActiveToolNames(): string[];
	getVisibleSkills(): Pick<Skill, "name" | "disableModelInvocation">[];
	loadHarnessState(): HarnessState;
	applyLateSentMessages(message: AgentMessage): void;
}
export class SessionHarnessContext {
	private _harnessDigestPending = false;
	/** Disclosures retained when their session append failed. */
	private readonly _unpersistedOutcomes: CustomMessage[] = [];
	constructor(private readonly host: HarnessContextHost) {}
	get digestPending(): boolean {
		return this._harnessDigestPending;
	}
	consumePendingDigest(): boolean {
		const pending = this._harnessDigestPending;
		this._harnessDigestPending = false;
		return pending;
	}

	rearmDigest(): void {
		this._harnessDigestPending = true;
	}
	retainOutcome(message: CustomMessage): void {
		this._unpersistedOutcomes.push(message);
	}
	harnessDigest(): string {
		const tools = this.host.getActiveToolNames();
		const hasIpython = tools.includes("ipython");
		const visibleSkills = this.host.getVisibleSkills().filter((skill) => !skill.disableModelInvocation);
		const hasRefineSkill = visibleSkills.some((skill) => skill.name === REFINE_SKILL_NAME);
		return formatHarnessStateForPrompt(this.host.loadHarnessState(), {
			includeIpythonExamples: hasIpython,
			includeShellExamples: tools.includes("bash"),
			includeRefineExamples: hasIpython && hasRefineSkill,
		});
	}

	ensureHarnessDigestContext(): void {
		if (this.host.getMessages().length === 0) {
			this._harnessDigestPending = true;
			return;
		}
		this._harnessDigestPending = false;
		this.appendHarnessDigestIfStale();
	}

	private appendHarnessDigestIfStale(): void {
		const digest = this.harnessDigest();
		if (this.latestContextHarnessDigest() === digest) return;
		const message = createHarnessDigestMessage(digest);
		try {
			this.host.sessionManager.appendCustomMessageEntryWithRollback(
				message.customType,
				message.content,
				message.display,
				message.details,
			);
		} catch {
			// Unpersisted session: context-only injection.
		}
		this.host.getMessages().push(message);
	}

	latestContextHarnessDigest(): string | undefined {
		// Retained pre-compaction messages follow the compaction head, so recency is by timestamp, not position.
		let latest: { timestamp: number; digest: string } | undefined;
		for (const message of this.host.getMessages()) {
			let digest: string | undefined;
			if (message.role === "custom" && message.customType === HARNESS_DIGEST_CUSTOM_TYPE) {
				digest = (message.details as HarnessDigestDetails | undefined)?.digest;
			} else if (message.role === "compactionSummary") {
				digest = message.harnessDigest;
			} else {
				continue;
			}
			if (digest !== undefined && (!latest || message.timestamp >= latest.timestamp)) {
				latest = { timestamp: message.timestamp, digest };
			}
		}
		return latest?.digest;
	}

	buildSessionContext(): SessionContext {
		const context = this.host.sessionManager.buildSessionContext();
		for (const message of context.messages) {
			this.host.applyLateSentMessages(message);
		}
		this.mergeUnpersistedOutcomes(context.messages);
		return context;
	}

	mergeUnpersistedOutcomes(messages: AgentMessage[]): void {
		for (const outcome of this._unpersistedOutcomes) {
			let insertAt = messages.length;
			while (insertAt > 0 && messages[insertAt - 1]!.timestamp > outcome.timestamp) {
				insertAt -= 1;
			}
			messages.splice(insertAt, 0, outcome);
		}
	}
}

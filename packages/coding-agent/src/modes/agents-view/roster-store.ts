import type { AgentRosterEntry } from "../daemon/agent-roster.js";
import { sessionSummaryFromRosterEntry } from "../daemon/agent-roster.js";
import type { DaemonClient } from "../daemon/daemon-client.js";
import type { DaemonOutbound } from "../daemon/daemon-protocol.js";
import type { SessionSummary } from "../daemon/daemon-session-list.js";

// Client-side roster mirror: one subscribe seeds it, pushes keep it current, and it outlives view instances.
export class AgentsViewRosterStore {
	private readonly entries = new Map<string, AgentRosterEntry>();
	private readonly listeners = new Set<() => void>();
	private client: DaemonClient | undefined;
	private unsubscribeMessage: (() => void) | undefined;
	private emitScheduled = false;
	private subscribed = false;

	/** Subscribes once per client connection; re-entry with a live subscription is a no-op. */
	async attach(client: DaemonClient, options: { force?: boolean } = {}): Promise<boolean> {
		// connect() resolves at socket connect; the capability verdict needs the parsed daemon_hello.
		if (client.isConnected && client.hello === undefined) await client.waitForHello();
		if (!client.supportsServerCapability("agent_roster")) {
			this.detachFromClient();
			return false;
		}
		if (!options.force && this.subscribed && this.client === client && client.isConnected) return true;
		this.detachFromClient();
		this.client = client;
		// Updates racing the subscribe reply buffer until the snapshot lands, so the resync cannot erase them.
		let pendingUpdates: Extract<DaemonOutbound, { type: "roster_update" }>[] | undefined = [];
		this.unsubscribeMessage = client.onMessage((message) => {
			if (message.type !== "roster_update") return;
			if (pendingUpdates) pendingUpdates.push(message);
			else this.applyUpdate(message.changed, message.removed, message.resync);
		});
		const response = await client.request({ type: "roster_subscribe" });
		if (!response.success || typeof response.data !== "object" || response.data === null) {
			this.detachFromClient();
			return false;
		}
		const roster = (response.data as { roster?: AgentRosterEntry[] }).roster ?? [];
		this.applyUpdate(roster, undefined, true);
		for (const update of pendingUpdates ?? []) {
			this.applyUpdate(update.changed, update.removed, update.resync);
		}
		pendingUpdates = undefined;
		this.subscribed = true;
		return true;
	}

	private applyUpdate(changed: AgentRosterEntry[], removed?: string[], resync?: true): void {
		if (resync) this.entries.clear();
		for (const entry of changed) {
			this.entries.set(entry.agentId, entry);
		}
		for (const agentId of removed ?? []) {
			this.entries.delete(agentId);
		}
		this.scheduleEmit();
	}

	summaries(): SessionSummary[] {
		return [...this.entries.values()].map((entry) => sessionSummaryFromRosterEntry(entry));
	}

	onUpdate(listener: () => void): () => void {
		this.listeners.add(listener);
		return () => this.listeners.delete(listener);
	}

	/** One listener emission per pushed batch, even when several arrive in one tick. */
	private scheduleEmit(): void {
		if (this.emitScheduled) return;
		this.emitScheduled = true;
		queueMicrotask(() => {
			this.emitScheduled = false;
			for (const listener of this.listeners) {
				listener();
			}
		});
	}

	private detachFromClient(): void {
		this.unsubscribeMessage?.();
		this.unsubscribeMessage = undefined;
		this.subscribed = false;
		this.client = undefined;
	}

	async dispose(): Promise<void> {
		const client = this.client;
		this.detachFromClient();
		this.listeners.clear();
		if (client?.isConnected) {
			await client.request({ type: "roster_unsubscribe" }).catch(() => undefined);
		}
	}
}

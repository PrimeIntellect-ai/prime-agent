import { workerRosterEntryFromSummary } from "../../src/modes/daemon/agent-roster.js";
import type { SessionSummary } from "../../src/modes/daemon/daemon-session-list.js";

interface RosterWorkerFixture {
	descriptor: { workerId: string };
	summaries: Map<string, SessionSummary>;
}

/** Seed a supervisor fixture's roster from worker fixtures' summaries (matchWorkers and eviction read it). */
export function seedSupervisorRoster(supervisor: object, ...workers: RosterWorkerFixture[]): void {
	const internals = supervisor as {
		writeRosterEntry(entry: ReturnType<typeof workerRosterEntryFromSummary>, worker?: RosterWorkerFixture): unknown;
	};
	for (const worker of workers) {
		for (const summary of worker.summaries.values()) {
			internals.writeRosterEntry(workerRosterEntryFromSummary(summary), worker);
		}
	}
}

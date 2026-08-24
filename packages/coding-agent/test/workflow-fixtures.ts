import type { WorkflowEpochRef } from "../src/core/workflow/contracts.js";

export interface PersistedEpochFixture {
	genesis: WorkflowEpochRef;
	acquired: WorkflowEpochRef;
}

const persistedEpochBytes = new TextEncoder().encode('{"coordinatorEpoch":1,"storeEpoch":1}');

export function loadPersistedEpochFixture(): PersistedEpochFixture {
	const parsed: unknown = JSON.parse(new TextDecoder().decode(persistedEpochBytes));
	if (
		typeof parsed !== "object" ||
		parsed === null ||
		!("storeEpoch" in parsed) ||
		!("coordinatorEpoch" in parsed) ||
		typeof parsed.storeEpoch !== "number" ||
		typeof parsed.coordinatorEpoch !== "number"
	) {
		throw new Error("Persisted epoch fixture is invalid.");
	}
	const epoch = { storeEpoch: parsed.storeEpoch, coordinatorEpoch: parsed.coordinatorEpoch };
	return { genesis: { ...epoch }, acquired: { ...epoch } };
}

/**
 * hosted-child-ledger-mutation-worker.ts — Mutation detection fixture.
 *
 * Imports the production ledger, attempts mutation via Reflect.set,
 * and exits 1 only when the production immutability guard is healthy.
 * If production becomes mutable or API fails unexpectedly, exit 0.
 *
 * No casts, `any`, non-null assertion, `instanceof`, `throw`, spread,
 * `as const`, `Object.setPrototypeOf`, or `ts-expect-error` appear in this file.
 */

import {
	appendGenesis,
	decodeRecord,
	encodeGenesisBytes,
	reveal,
} from "../../src/modes/daemon/sandbox/hosted-child-ledger.js";

const DEFAULT_BOUNDS: Record<string, number> = Object.freeze({
	maxRecords: 100,
	maxBytes: 1048576,
	maxRecordBytes: 65536,
	maxGroups: 50,
});

const C64: string = "0000000000000000000000000000000000000000000000000000000000000000";

function makeGenesisInput(): Record<string, unknown> {
	const base: Record<string, unknown> = {};
	base.sessionId = "sess-mut";
	base.activeSessionId = "active-mut";
	base.childId = "child-mut";
	base.name = "mut-name";
	base.modelSelector = "mut-model";
	base.durableParentSessionId = "mut-parent";
	base.rlmParentNodeId = "mut-rlm";
	base.spawnedByRequestId = null;
	base.thinkingLevel = "medium";
	base.serviceTier = "auto";
	base.spawnContextDigest = C64;
	base.depth = 0;
	return Object.freeze(base);
}

// Attempt mutation via Reflect.set.
// If the target is frozen (as production should be), Reflect.set returns false.
// If it succeeds unexpectedly, exit 0 (test infrastructure may need investigation).
function tryMutate(target: object, key: string, value: unknown): number {
	const before: PropertyDescriptor | undefined = Object.getOwnPropertyDescriptor(target, key);
	const result: boolean = Reflect.set(target, key, value);
	const after: PropertyDescriptor | undefined = Object.getOwnPropertyDescriptor(target, key);
	if (result === true) {
		console.error(`MUTATION UNEXPECTEDLY SUCCEEDED: ${key}`);
		return 1;
	}
	if (!Object.isFrozen(target)) {
		console.error(`MUTATION TARGET IS NOT FROZEN: ${key}`);
		return 1;
	}
	if (before === undefined) {
		if (after !== undefined) {
			console.error(`MUTATION CREATED PROPERTY: ${key}`);
			return 1;
		}
		return 0;
	}
	if (after === undefined || !Object.is(before.value, after.value)) {
		console.error(`MUTATION CHANGED PROPERTY: ${key}`);
		return 1;
	}
	return 0;
}

function run(): void {
	// 1. Create a genesis record
	const result = appendGenesis([], makeGenesisInput(), DEFAULT_BOUNDS);
	if (result.code !== "OK") {
		// Production API failed unexpectedly — exit 0 (no assertion failure to prove)
		console.error(`appendGenesis returned: ${result.code}`);
		process.exit(0);
	}

	// Use descriptor-based access to extract record without casts
	const resultKeys: string[] = Object.getOwnPropertyNames(result);
	let recordKey: string | undefined;
	let bytesKey: string | undefined;
	for (const k of resultKeys) {
		if (k === "record") recordKey = k;
		if (k === "bytes") bytesKey = k;
	}
	if (recordKey === undefined || bytesKey === undefined) {
		process.exit(0);
	}

	const recordDesc: PropertyDescriptor | undefined = Object.getOwnPropertyDescriptor(result, recordKey);
	const bytesDesc: PropertyDescriptor | undefined = Object.getOwnPropertyDescriptor(result, bytesKey);
	if (recordDesc === undefined || bytesDesc === undefined) {
		process.exit(0);
	}
	const record: object = recordDesc.value;
	const wrapper: object = bytesDesc.value;

	// 2. Try mutating the record (should be frozen)
	let failCount: number = 0;
	failCount += tryMutate(record, "rev", 999);
	failCount += tryMutate(record, "status", "deleted");

	// 3. Try mutating the identity inside record
	const recordOwnNames: string[] = Object.getOwnPropertyNames(record);
	let identityField: string | undefined;
	for (const n of recordOwnNames) {
		if (n === "identity") {
			identityField = n;
			break;
		}
	}
	if (identityField !== undefined) {
		const idDesc: PropertyDescriptor | undefined = Object.getOwnPropertyDescriptor(record, identityField);
		if (idDesc !== undefined) {
			const identity: object = idDesc.value;
			failCount += tryMutate(identity, "sessionId", "hacked");
		}
	}

	// 4. Try mutating the wrapper (should be frozen)
	failCount += tryMutate(wrapper, "anything", 42);

	// 5. Decode record and try mutating decoded result
	const decodeResult = decodeRecord(wrapper);
	if (decodeResult.code === "OK") {
		const drKeys: string[] = Object.getOwnPropertyNames(decodeResult);
		let drRecordKey: string | undefined;
		for (const k of drKeys) {
			if (k === "record") drRecordKey = k;
		}
		if (drRecordKey !== undefined) {
			const drDesc: PropertyDescriptor | undefined = Object.getOwnPropertyDescriptor(decodeResult, drRecordKey);
			if (drDesc !== undefined) {
				const decodedRecord: object = drDesc.value;
				failCount += tryMutate(decodedRecord, "rev", -1);
				failCount += tryMutate(decodedRecord, "status", "allocating");
			}
		}
	}

	// 6. Try mutating the result envelope itself
	failCount += tryMutate(result, "code", "FAIL");

	// 7. Verify reveal returns mutable fresh copy
	const encodeResult = encodeGenesisBytes(makeGenesisInput(), DEFAULT_BOUNDS);
	if (encodeResult.code === "OK") {
		const erKeys: string[] = Object.getOwnPropertyNames(encodeResult);
		let erBytesKey: string | undefined;
		for (const k of erKeys) {
			if (k === "bytes") erBytesKey = k;
		}
		if (erBytesKey !== undefined) {
			const erDesc: PropertyDescriptor | undefined = Object.getOwnPropertyDescriptor(encodeResult, erBytesKey);
			if (erDesc !== undefined) {
				const encWrapper: object = erDesc.value;
				const revealResult = reveal(encWrapper);
				if (revealResult.code === "OK") {
					const rvKeys: string[] = Object.getOwnPropertyNames(revealResult);
					let dataKey: string | undefined;
					for (const k of rvKeys) {
						if (k === "data") dataKey = k;
					}
					if (dataKey !== undefined) {
						const dataDesc: PropertyDescriptor | undefined = Object.getOwnPropertyDescriptor(
							revealResult,
							dataKey,
						);
						if (dataDesc !== undefined) {
							const data: Uint8Array = dataDesc.value;
							// Uint8Array should be mutable (fresh copy)
							const origByte: number = data[0];
							data[0] = 0xff;
							const mutated: boolean = data[0] === 0xff;
							data[0] = origByte;
							if (!mutated) {
								// Reveal should return mutable data
								console.error("REVEAL DATA NOT MUTABLE");
								failCount += 1;
							}
						}
					}
				}
			}
		}
	}

	// Exit 1 if immutability guard is healthy (expected production behavior)
	// Exit 0 if any mutation succeeded (production would need investigation)
	if (failCount > 0) {
		console.error(`MUTATION TEST: ${failCount} unexpected mutation(s) detected`);
		process.exit(0);
	}

	// All Reflect.set attempts returned false (immutability guard healthy)
	process.exit(1);
}

run();

import type { WorkflowEpochRef, WorkflowLeaseRef, WorkflowRuntimeStoreDurableContext } from "../workflow/contracts.js";
import { sameWorkflowLeaseIdentity } from "../workflow/contracts.js";
import type { KnowledgeEvent } from "./records.js";

interface RuntimeAuthority {
	readonly runtimeStore: object;
	readonly context: WorkflowRuntimeStoreDurableContext;
	readonly writeAuxiliary: (name: string, bytes: Readonly<Uint8Array>) => Promise<void>;
	readonly durableStores: Set<object>;
}

interface DurableAuthority {
	readonly runtimeStore: object;
	readonly workflowId: string;
	readonly replayCanonical: () => Promise<readonly KnowledgeEvent[]>;
	readonly sealedEvents: WeakSet<object>;
	readonly authorizedPayloads: WeakSet<object>;
}

/**
 * A closure-backed authority returned only to the knowledge adapter.  None of
 * its state is represented on the durable store object, so structural object
 * inspection cannot recover a commit, replay, or auxiliary writer capability.
 */
export interface KnowledgeAuthorityHandle {
	readonly workflowId: string;
	readonly epochRef: WorkflowEpochRef;
	readonly generationId: string;
	currentLeaseRef(): WorkflowLeaseRef;
	sealEvent(event: KnowledgeEvent): KnowledgeEvent;
	isSealed(event: KnowledgeEvent): boolean;
	authorizePayload(payload: object): void;
	replayCanonical(): Promise<readonly KnowledgeEvent[]>;
	writeAuxiliary(name: string, bytes: Readonly<Uint8Array>): Promise<void>;
}

type KnowledgeStoreAuthorityHandle = Pick<
	KnowledgeAuthorityHandle,
	"workflowId" | "epochRef" | "generationId" | "currentLeaseRef" | "sealEvent" | "isSealed" | "replayCanonical"
>;

const runtimeAuthorities = new WeakMap<object, RuntimeAuthority>();
const runtimeAuthoritiesByContext = new WeakMap<object, RuntimeAuthority>();
const durableAuthorities = new WeakMap<object, DurableAuthority>();

/**
 * Register the private writer owned by one workflow bridge.  Registration is
 * one-time and tied to the bridge object; a replacement callback can never
 * take over an existing workflow authority.
 */
export function registerWorkflowKnowledgeRuntimeAuthority(
	runtimeStore: object,
	context: WorkflowRuntimeStoreDurableContext,
	writeAuxiliary: (name: string, bytes: Readonly<Uint8Array>) => Promise<void>,
): void {
	if (runtimeAuthorities.has(runtimeStore)) throw new Error("The workflow runtime already has a knowledge authority.");
	const authority = { runtimeStore, context, writeAuxiliary, durableStores: new Set<object>() };
	runtimeAuthorities.set(runtimeStore, authority);
	runtimeAuthoritiesByContext.set(context, authority);
}

/**
 * Register a host-created public context as an alias of an existing private
 * workflow authority. The alias never becomes a writer authority itself.
 */
export function registerWorkflowKnowledgeRuntimeContextAlias(
	runtimeStore: object,
	context: WorkflowRuntimeStoreDurableContext,
): void {
	const authority = runtimeAuthorities.get(runtimeStore);
	if (authority === undefined) throw new Error("The workflow runtime has no knowledge authority to alias.");
	if (runtimeAuthoritiesByContext.has(context))
		throw new Error("The workflow knowledge context is already registered.");
	if (
		authority.context.generationId !== context.generationId ||
		authority.context.epochRef.storeEpoch !== context.epochRef.storeEpoch ||
		authority.context.epochRef.coordinatorEpoch !== context.epochRef.coordinatorEpoch ||
		!sameWorkflowLeaseIdentity(authority.context.currentLeaseRef(), context.currentLeaseRef())
	)
		throw new Error("The workflow knowledge context alias is not bound to the authenticated runtime.");
	runtimeAuthoritiesByContext.set(context, authority);
}

/**
 * Bind a knowledge projection to the already-registered workflow authority.
 * The durable-store object is registered once and cannot be replaced by a
 * structurally similar object from another workflow or process.
 */
export function bindKnowledgeDurableAuthority(input: {
	durableStore: object;
	runtimeStore: object;
	context?: WorkflowRuntimeStoreDurableContext;
	workflowId: string;
	epochRef: WorkflowEpochRef;
	generationId: string;
	replayCanonical: () => Promise<readonly KnowledgeEvent[]>;
}): KnowledgeAuthorityHandle {
	if (durableAuthorities.has(input.durableStore)) throw new Error("The knowledge durable authority is already bound.");
	const runtime =
		runtimeAuthorities.get(input.runtimeStore) ??
		(input.context === undefined ? undefined : runtimeAuthoritiesByContext.get(input.context));
	if (runtime === undefined) throw new Error("Knowledge requires the exact authenticated workflow authority.");
	if (
		runtime.context.epochRef.storeEpoch !== input.epochRef.storeEpoch ||
		runtime.context.epochRef.coordinatorEpoch !== input.epochRef.coordinatorEpoch
	)
		throw new Error("Knowledge authority epoch is not bound to the workflow host.");
	const authority: DurableAuthority = {
		runtimeStore: runtime.runtimeStore,
		workflowId: input.workflowId,
		replayCanonical: input.replayCanonical,
		sealedEvents: new WeakSet<object>(),
		authorizedPayloads: new WeakSet<object>(),
	};
	runtime.durableStores.add(input.durableStore);
	durableAuthorities.set(input.durableStore, authority);
	return {
		workflowId: input.workflowId,
		epochRef: Object.freeze({ ...input.epochRef }),
		generationId: input.generationId,
		currentLeaseRef: () => runtime.context.currentLeaseRef(),
		sealEvent: (event) => {
			if (authority.sealedEvents.has(event)) return event;
			const sealed = Object.freeze({ ...event }) as KnowledgeEvent;
			authority.sealedEvents.add(sealed);
			return sealed;
		},
		isSealed: (event) => authority.sealedEvents.has(event),
		authorizePayload: (payload) => {
			authority.authorizedPayloads.add(payload);
		},
		replayCanonical: input.replayCanonical,
		writeAuxiliary: runtime.writeAuxiliary,
	};
}

/**
 * Retrieve the closure-backed authority for a store created by the adapter.
 * A missing binding is treated as a forged or detached durable store.
 */
export function getKnowledgeDurableAuthority(durableStore: object): KnowledgeStoreAuthorityHandle {
	const authority = durableAuthorities.get(durableStore);
	if (authority === undefined) throw new Error("Knowledge durable store is not bound to its workflow authority.");
	const runtime = runtimeAuthorities.get(authority.runtimeStore);
	if (runtime === undefined) throw new Error("Knowledge workflow authority is unavailable.");
	return {
		workflowId: authority.workflowId,
		epochRef: Object.freeze({ ...runtime.context.epochRef }),
		generationId: runtime.context.generationId,
		currentLeaseRef: () => runtime.context.currentLeaseRef(),
		sealEvent: (event) => {
			if (authority.sealedEvents.has(event)) return event;
			const sealed = Object.freeze({ ...event }) as KnowledgeEvent;
			authority.sealedEvents.add(sealed);
			return sealed;
		},
		isSealed: (event) => authority.sealedEvents.has(event),
		replayCanonical: authority.replayCanonical,
	};
}

/**
 * Consume a one-use payload admission at the workflow bridge boundary.
 * Generic runtime callers cannot append knowledge events because they cannot
 * manufacture an entry in this private WeakSet.
 */
export function consumeWorkflowKnowledgePayload(runtimeStore: object, payload: object): boolean {
	const runtime = runtimeAuthorities.get(runtimeStore);
	if (runtime === undefined) return false;
	for (const durableStore of runtime.durableStores) {
		const authority = durableAuthorities.get(durableStore);
		if (authority?.authorizedPayloads.has(payload)) {
			authority.authorizedPayloads.delete(payload);
			return true;
		}
	}
	return false;
}

type PreTurnCompactionTiming = "beforeModelSelection" | "afterModelSelection" | "skip";
type RefineBarrierPolicy = "always" | "ifInFlight" | "skip";

export interface CommitPreparationPolicy {
	initialRefineBarrier: RefineBarrierPolicy;
	flushPendingBashBeforeValidation: boolean;
	validateModelAndAuth: boolean;
	awaitPendingModelSelection: boolean;
	preTurnCompaction: PreTurnCompactionTiming;
	finalRefineBarrier: RefineBarrierPolicy;
}

export interface CommitPreparationSteps<TPrepared, TCommitted> {
	afterValidation?: () => void;
	prepare: () => Promise<TPrepared>;
	shouldCommit?: (prepared: TPrepared) => boolean;
	beforeFinalRefineBarrier?: (prepared: TPrepared) => void;
	commit: (prepared: TPrepared, passedFinalRefineBarrier: boolean) => TCommitted;
}

export interface TurnExecutionPolicy {
	preparation: CommitPreparationPolicy;
	runBeforeAgentStart: boolean;
	nextTurnContextTiming: "preparation" | "commit" | "skip";
	preserveEmptyExtensionPrompt: boolean;
	completionIncludesRetryChain: boolean;
}

export function turnExecutionPoliciesEqual(left: TurnExecutionPolicy, right: TurnExecutionPolicy): boolean {
	return (
		left.preparation.initialRefineBarrier === right.preparation.initialRefineBarrier &&
		left.preparation.flushPendingBashBeforeValidation === right.preparation.flushPendingBashBeforeValidation &&
		left.preparation.validateModelAndAuth === right.preparation.validateModelAndAuth &&
		left.preparation.awaitPendingModelSelection === right.preparation.awaitPendingModelSelection &&
		left.preparation.preTurnCompaction === right.preparation.preTurnCompaction &&
		left.preparation.finalRefineBarrier === right.preparation.finalRefineBarrier &&
		left.runBeforeAgentStart === right.runBeforeAgentStart &&
		left.nextTurnContextTiming === right.nextTurnContextTiming &&
		left.preserveEmptyExtensionPrompt === right.preserveEmptyExtensionPrompt &&
		left.completionIncludesRetryChain === right.completionIncludesRetryChain
	);
}

export function createTurnExecutionPolicy(
	kind: "queued" | "directPrompt" | "injected" | "customTrigger",
	options: {
		returnAfterAccepted?: boolean;
		skipPrePromptWork?: boolean;
	} = {},
): TurnExecutionPolicy {
	if (kind === "queued") {
		return {
			preparation: {
				initialRefineBarrier: "skip",
				flushPendingBashBeforeValidation: false,
				validateModelAndAuth: true,
				awaitPendingModelSelection: true,
				preTurnCompaction: "beforeModelSelection",
				finalRefineBarrier: "always",
			},
			runBeforeAgentStart: true,
			nextTurnContextTiming: "commit",
			preserveEmptyExtensionPrompt: true,
			completionIncludesRetryChain: true,
		};
	}
	if (kind === "directPrompt") {
		return {
			preparation: {
				initialRefineBarrier: options.returnAfterAccepted ? "skip" : "always",
				flushPendingBashBeforeValidation: true,
				validateModelAndAuth: true,
				awaitPendingModelSelection: true,
				preTurnCompaction: options.skipPrePromptWork ? "skip" : "afterModelSelection",
				finalRefineBarrier: "ifInFlight",
			},
			runBeforeAgentStart: !options.skipPrePromptWork,
			nextTurnContextTiming: "preparation",
			preserveEmptyExtensionPrompt: false,
			completionIncludesRetryChain: true,
		};
	}
	if (kind === "injected") {
		return {
			preparation: {
				initialRefineBarrier: "always",
				flushPendingBashBeforeValidation: true,
				validateModelAndAuth: true,
				awaitPendingModelSelection: true,
				preTurnCompaction: "beforeModelSelection",
				finalRefineBarrier: "ifInFlight",
			},
			runBeforeAgentStart: true,
			nextTurnContextTiming: "preparation",
			preserveEmptyExtensionPrompt: true,
			completionIncludesRetryChain: true,
		};
	}
	return {
		preparation: {
			initialRefineBarrier: "always",
			flushPendingBashBeforeValidation: false,
			validateModelAndAuth: false,
			awaitPendingModelSelection: false,
			preTurnCompaction: "skip",
			finalRefineBarrier: "skip",
		},
		runBeforeAgentStart: false,
		nextTurnContextTiming: "skip",
		preserveEmptyExtensionPrompt: false,
		completionIncludesRetryChain: false,
	};
}

export interface TurnPreparationHost {
	hasRefinement(): boolean;
	waitForRefinement(): Promise<void>;
	flushPendingBash(): void;
	validate(): Promise<void>;
	compact(): Promise<void>;
	pendingModelSelection(): Promise<void> | undefined;
}

export class TurnPreparer {
	constructor(private readonly _host: TurnPreparationHost) {}

	async prepare<TPrepared, TCommitted>(
		policy: CommitPreparationPolicy,
		steps: CommitPreparationSteps<TPrepared, TCommitted>,
	): Promise<TCommitted | undefined> {
		if (
			policy.initialRefineBarrier === "always" ||
			(policy.initialRefineBarrier === "ifInFlight" && this._host.hasRefinement())
		) {
			await this._host.waitForRefinement();
		}
		if (policy.flushPendingBashBeforeValidation) this._host.flushPendingBash();
		if (policy.validateModelAndAuth) await this._host.validate();
		steps.afterValidation?.();
		if (!policy.flushPendingBashBeforeValidation) this._host.flushPendingBash();

		if (policy.preTurnCompaction === "beforeModelSelection") await this._host.compact();
		if (policy.awaitPendingModelSelection) {
			const pendingModelSelectEmit = this._host.pendingModelSelection();
			if (pendingModelSelectEmit) await pendingModelSelectEmit;
		}
		if (policy.preTurnCompaction === "afterModelSelection") await this._host.compact();

		const prepared = await steps.prepare();
		if (steps.shouldCommit && !steps.shouldCommit(prepared)) return undefined;
		steps.beforeFinalRefineBarrier?.(prepared);
		let passedFinalRefineBarrier = false;
		if (
			policy.finalRefineBarrier === "always" ||
			(policy.finalRefineBarrier === "ifInFlight" && this._host.hasRefinement())
		) {
			await this._host.waitForRefinement();
			passedFinalRefineBarrier = true;
		}
		return steps.commit(prepared, passedFinalRefineBarrier);
	}
}

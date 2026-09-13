// Compatibility exports; implementation lives with its feature owner.
export {
	type BatchShimInvocation,
	buildBatchShimInvocation,
	DEFAULT_RLM_EXTRA_IMPORT_LABELS,
	DEFAULT_RLM_EXTRA_IMPORT_NAMES,
	DEFAULT_RLM_EXTRA_UV_ARGS,
	type EnsureKernelPythonOptions,
	ensureKernelPython,
	getKernelVenvDir,
	type KernelBootstrapProgressHandler,
	type KernelPythonSkill,
	kernelVenvPython,
	resolveRuntimeIdentity,
	windowsExecutableCandidates,
} from "../../kernel/bootstrap.js";

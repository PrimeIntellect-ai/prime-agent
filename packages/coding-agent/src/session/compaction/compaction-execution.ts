// Compatibility exports; implementation lives with its session owner.
export {
	type CompactionExecutionHost,
	type CompactionExecutionOptions,
	CompactionSkippedError,
	performSessionCompaction,
} from "./execution.js";

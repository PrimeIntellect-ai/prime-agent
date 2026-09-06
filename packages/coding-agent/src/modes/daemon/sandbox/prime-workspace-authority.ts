/**
 * Verifies that a generated workspace root can be opened and locked by the
 * packaged POSIX helper. The helper and every process in its group are gone
 * before this function returns.
 *
 * Thin public wrapper around the process-core implementation.
 */

import type { WorkspaceVerificationResult } from "./prime-workspace-authority-types.js";
import { verifyWorkspaceRootLifecycleInternal } from "./prime-workspace-helper-core.js";

export function verifyWorkspaceRootLifecycle(rootPathRaw: unknown): Promise<WorkspaceVerificationResult> {
	return verifyWorkspaceRootLifecycleInternal(rootPathRaw);
}
